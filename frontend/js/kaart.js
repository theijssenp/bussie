// ============================================================
// Bussie — Isometrische Canvas Renderer
// Volledig vanaf scratch gebouwd, geen externe kaartbibliotheken.
// ============================================================

const TAU = Math.PI * 2;

// Zover mag een busje maximaal meekantelen met de weg (30°)
const MAX_BUSKANTELING = Math.PI / 6;

// Lijnen zonder eigen kleur in de GTFS krijgen deze; hun bussen houden
// de standaard okerkleur, want een grijs busje leest niet als een bus.
const LIJN_STANDAARDKLEUR = '#8aa0b2';

export class IsoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    // Camera state
    this.cam = { x: 0, y: 0, zoom: 1, rotation: 0 };
    this.targetCam = { x: 0, y: 0, zoom: 1, rotation: 0 };

    // Map data
    this.mapData = null;
    this.lijnen = [];           // lijnroutes uit lijnen.json
    this.lijnIndex = new Map(); // route_id|richting → lijnroute
    this.haltes = [];           // unieke haltes van alle lijnen
    this.vehicles = [];
    this.filteredLines = new Set(); // leeg = alle lijnen

    // Interaction
    this.dragging = false;
    this.lastMouse = { x: 0, y: 0 };
    this.mouseWorld = null;
    this.hoveredVehicle = null;

    // Theme colors
    this.themes = {
      light: {
        bg: '#dee9f0',
        street: '#d4cfc7',
        streetMajor: '#e0dbd3',
        building: '#c8c8c8',
        buildingRoof: '#dcdcd8',
        buildingSide: '#b4b4b0',
        buildingLijn: 'rgba(43,48,56,0.06)',
        water: '#a8d4ea',
        green: '#cbe7c4',
        route: '#8aa0b2',
        halte: '#ffffff',
        halteRing: '#8aa0b2',
        bus: '#f0a830',
        busDak: '#f7c46a',
        busRuit: '#e8f2f8',
        busWiel: '#2b3038',
        busRand: 'rgba(43,48,56,0.18)',
        schaduw: 'rgba(20,28,40,0.16)',
        text: '#2b3038',
        labelBg: 'rgba(255,255,255,0.92)',
      },
      dark: {
        bg: '#10151d',
        street: '#242b39',
        streetMajor: '#2c3546',
        building: '#252b38',
        buildingRoof: '#2e3648',
        buildingSide: '#1c212c',
        buildingLijn: 'rgba(0,0,0,0.25)',
        water: '#17334f',
        green: '#1a3328',
        route: '#7f96ab',
        halte: '#10151d',
        halteRing: '#8aa0b2',
        bus: '#f0a830',
        busDak: '#f7c46a',
        busRuit: '#cfe0ec',
        busWiel: '#141922',
        busRand: 'rgba(0,0,0,0.35)',
        schaduw: 'rgba(0,0,0,0.35)',
        text: '#e7ecf2',
        labelBg: 'rgba(22,28,38,0.92)',
      },
    };
    this.theme = 'light';
    this.colors = this.themes.light;

    // Iso projectie: 45° gedraaid, daarna verticaal ingedrukt.
    // De kanteling bepaalt hoe schuin we kijken: 1 = recht van boven,
    // 0,5 = het klassieke 2:1 dimetrische beeld. Lager = platter kijken.
    this.isoAngle = Math.PI / 4;
    this.cosA = Math.cos(this.isoAngle);
    this.sinA = Math.sin(this.isoAngle);
    this.tilt = 0.3;
    const bewaardeTilt = parseFloat(localStorage.getItem('bussie-tilt2'));
    if (bewaardeTilt >= 0.3 && bewaardeTilt <= 1) this.tilt = bewaardeTilt;

    // Gebouwextrusie (pixels per meter hoogte). Hoe schuiner we kijken,
    // hoe meer gevel er te zien is, dus dit mag wat royaler.
    this.heightScale = 0.6;

    // Kleurvariatie van de gevels — per thema, want overdag mag de stad
    // veel bonter zijn dan 's nachts.
    this.gevelVariatie = { light: 3, dark: 0.6 };
    const bewaard = localStorage.getItem('bussie-gevelvariatie2');
    if (bewaard) {
      try {
        const waarde = JSON.parse(bewaard);
        if (typeof waarde === 'number') {
          this.gevelVariatie = { light: klemVariatie(waarde), dark: klemVariatie(waarde) };
        } else if (waarde && typeof waarde === 'object') {
          this.gevelVariatie = {
            light: klemVariatie(waarde.light ?? this.gevelVariatie.light),
            dark: klemVariatie(waarde.dark ?? this.gevelVariatie.dark),
          };
        }
      } catch (e) {
        console.warn('Bewaarde gevelvariatie onleesbaar:', e);
      }
    }
    this._gevelPalet = null;
    this.bouwGevelPalet();

    // Afgeleide buskleuren per lijnkleur (dak, ruiten, wielen, randje)
    this._busKleuren = new Map();

    // Bewegingsbuffer per voertuig: waar was de bus, waar is-ie nu
    this._buffer = new Map();

    this.resize();
    this.setupEvents();
  }

  setTheme(theme) {
    this.theme = theme;
    this.colors = this.themes[theme] || this.themes.light;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bussie-theme', theme);
    this.bouwGevelPalet();
    this._busKleuren?.clear();
    this.render();
  }

  /**
   * Palet voor de gevels. Elk gebouw krijgt een vaste tint uit dit palet,
   * bepaald door zijn eigen coördinaten — dat geeft de stad kleurvariatie
   * zonder dat er per gebouw kleurdata mee hoeft te komen. Dak en zijkant
   * delen dezelfde tint met een vast lichtheidsverschil, zodat het volume
   * blijft kloppen.
   */
  bouwGevelPalet() {
    const c = this.colors;
    const donker = this.theme === 'dark';
    const variatie = this.gevelVariatie[this.theme] ?? 1;
    const meng = Math.min(1, (donker ? 0.60 : 0.50) * variatie);
    const zijFactor = donker ? 0.72 : 0.80;
    const basisKleur = hexNaarRgb(c.buildingRoof);

    const dak = [];
    const zij = [];
    for (let formaat = 0; formaat < 3; formaat++) {
      // Kleine panden een tikje lichter, grote blokken wat gedempter
      const licht = formaat === 0 ? 1.04 : formaat === 1 ? 1.0 : 0.94;
      for (const tint of GEVEL_TINTEN) {
        // In het licht mengen we gewoon naar de pasteltint. In het donker zou
        // dat de gebouwen doen oplichten, dus daar verschuiven we alleen het
        // kleuraandeel van de tint en laten we de helderheid staan.
        const doel = donker ? verschuifKleur(basisKleur, hexNaarRgb(tint)) : hexNaarRgb(tint);
        const basis = schaalKleur(mengKleur(basisKleur, doel, meng), licht);
        dak.push(rgbNaarString(basis));
        zij.push(rgbNaarString(schaalKleur(basis, zijFactor)));
      }
    }
    this._gevelPalet = { dak, zij };
  }

  /**
   * Hoeveel kleurverschil de gebouwen krijgen (0 = allemaal gelijk).
   * Geldt voor het huidige thema, tenzij je er een thema bij noemt.
   */
  setGevelVariatie(factor, thema = this.theme) {
    this.gevelVariatie[thema] = klemVariatie(factor);
    localStorage.setItem('bussie-gevelvariatie2', JSON.stringify(this.gevelVariatie));
    if (thema === this.theme) {
      this.bouwGevelPalet();
      this.render();
    }
    return this.gevelVariatie;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.vw = w;
    this.vh = h;
    this.render();
  }

  // === Coördinaat transformaties ===

  worldToScreen(wx, wy) {
    const dx = wx - this.cam.x;
    const dy = wy - this.cam.y;
    const z = this.cam.zoom;
    return {
      x: (dx - dy) * this.cosA * z + this.vw / 2,
      y: (dx + dy) * this.sinA * this.tilt * z + this.vh / 2,
    };
  }

  screenToWorld(sx, sy) {
    const z = this.cam.zoom;
    const px = (sx - this.vw / 2) / z;
    const py = (sy - this.vh / 2) / (z * this.tilt);
    return {
      x: (px / this.cosA + py / this.sinA) / 2 + this.cam.x,
      y: (py / this.sinA - px / this.cosA) / 2 + this.cam.y,
    };
  }

  /** Kantelstand aanpassen (0,3 = heel schuin, 1 = recht van boven). */
  setTilt(tilt) {
    this.tilt = Math.max(0.3, Math.min(1, tilt));
    // Tijdens het slepen niet bij elke stap naar localStorage schrijven
    clearTimeout(this._tiltTimer);
    this._tiltTimer = setTimeout(() => {
      localStorage.setItem('bussie-tilt2', String(this.tilt));
    }, 400);
  }

  // === Camera ===

  setCenter(wx, wy, zoom) {
    this.targetCam.x = wx;
    this.targetCam.y = wy;
    if (zoom !== undefined) this.targetCam.zoom = zoom;
  }

  pan(dx, dy) {
    const z = this.cam.zoom;
    const dyt = dy / this.tilt;
    const wdx = (dx / this.cosA + dyt / this.sinA) / (2 * z);
    const wdy = (dyt / this.sinA - dx / this.cosA) / (2 * z);
    this.cam.x -= wdx;
    this.cam.y -= wdy;
    this.targetCam.x = this.cam.x;
    this.targetCam.y = this.cam.y;
  }

  zoomAt(sx, sy, factor) {
    const worldBefore = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.max(0.35, Math.min(6, this.cam.zoom * factor));
    this.targetCam.zoom = this.cam.zoom;
    const worldAfter = this.screenToWorld(sx, sy);
    this.cam.x += worldBefore.x - worldAfter.x;
    this.cam.y += worldBefore.y - worldAfter.y;
    this.targetCam.x = this.cam.x;
    this.targetCam.y = this.cam.y;
  }

  // === Data ===

  setMapData(data) {
    this.mapData = data;
    if (!data) return;

    // Eén keer een bounding box per element: het schelen van punt-voor-punt
    // controleren per frame is het verschil tussen 20 en 60 fps.
    for (const laag of ['streets', 'buildings', 'water', 'green']) {
      for (const el of data[laag] || []) {
        el._b = boundsVan(el.pts);
      }
    }

    // Gebouwen van achter naar voren zetten. Nu we schuiner kijken steken
    // gevels boven hun buren uit, en dan moet het achterste er eerst staan.
    // Meteen ook de tint vastleggen: die volgt uit de eigen coördinaten,
    // dus hij ligt vast en flikkert niet tijdens het pannen.
    if (data.buildings) {
      const tinten = GEVEL_TINTEN.length;
      for (const el of data.buildings) {
        el._diep = el._b ? el._b.maxX + el._b.maxY : 0;
        const b = el._b;
        const grootte = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY) : 0;
        const formaat = grootte < 14 ? 0 : grootte < 34 ? 1 : 2;
        const ruis = b ? hashPositie(b.minX, b.minY) : 0;
        el._tint = formaat * tinten + Math.min(tinten - 1, (ruis * tinten) | 0);
      }
      data.buildings.sort((a, b) => a._diep - b._diep);
    }

    if (data.center) {
      this.cam.x = this.cam.y = 0;
      this.targetCam.x = this.targetCam.y = 0;
      // Schuiner kijken betekent meer in beeld, dus starten we iets dichterbij
      this.cam.zoom = this.targetCam.zoom = 1.1;
    }
  }

  /** Lijnroutes met kleur, cumulatieve afstand en haltes. */
  setLijnen(lijnen) {
    this.lijnen = lijnen || [];
    this.lijnIndex.clear();

    for (const r of this.lijnen) {
      // Zichtbaar deel: alleen wat binnen de kaartrand valt, opgeknipt in
      // losse stukken zodat een lijn niet dwars door leeg gebied doorloopt.
      r._segmenten = this.knipOpKaart(r.pts);
      for (const rid of r.rids || []) {
        this.lijnIndex.set(`${rid}|${r.richting}`, r);
        if (!this.lijnIndex.has(rid)) this.lijnIndex.set(rid, r);
      }
      this.lijnIndex.set(`lijn:${r.lijn}|${r.richting}`, r);
    }

    // Haltes ontdubbelen; onthoud welke lijnen er stoppen
    const perHalte = new Map();
    for (const r of this.lijnen) {
      for (const h of r.haltes || []) {
        let entry = perHalte.get(h.id);
        if (!entry) {
          entry = { id: h.id, naam: h.naam, x: h.x, y: h.y, lijnen: new Set() };
          perHalte.set(h.id, entry);
        }
        entry.lijnen.add(r.lijn);
      }
    }
    this.haltes = [...perHalte.values()];
  }

  /** Knip een polyline op de kaartrand (bbox van de OSM-data). */
  knipOpKaart(pts) {
    const bbox = this.mapData?.bbox;
    if (!bbox) return [pts];
    // bbox = [min_lat, min_lon, max_lat, max_lon] → in wereldmeters
    const c = this.mapData.center;
    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(c.lat * n);
    const marge = 400;
    const minX = (bbox[1] - c.lon) * n * R * cosLat - marge;
    const maxX = (bbox[3] - c.lon) * n * R * cosLat + marge;
    const minY = -(bbox[2] - c.lat) * n * R - marge;
    const maxY = -(bbox[0] - c.lat) * n * R + marge;

    const segmenten = [];
    let huidig = null;
    for (const p of pts) {
      const binnen = p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY;
      if (binnen) {
        if (!huidig) { huidig = []; segmenten.push(huidig); }
        huidig.push(p);
      } else if (huidig) {
        huidig.push(p); // één punt erbuiten meenemen zodat de lijn netjes uitloopt
        huidig = null;
      }
    }
    return segmenten
      .filter(s => s.length >= 2)
      .map(s => ({ pts: s, b: boundsVan(s) }));
  }

  /** De lijnroute waar dit voertuig op rijdt (of null). */
  routeVoor(v) {
    return (
      this.lijnIndex.get(`${v.rid}|${v.richting}`) ||
      this.lijnIndex.get(`lijn:${v.lijn}|${v.richting}`) ||
      this.lijnIndex.get(v.rid) ||
      null
    );
  }

  /**
   * Nieuwe peiling verwerken: reken lat/lon om naar wereldmeters en zet de
   * bewegingsbuffer klaar. Als het voertuig een bekende lijnroute heeft
   * bewegen we langs die route (afstand langs de lijn), anders in rechte lijn.
   */
  setVehicles(vehicles, historie) {
    this.vehicles = vehicles || [];
    const center = this.mapData?.center;
    if (!center) return;

    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
    const naarWereld = (lat, lon) => [
      (lon - center.lon) * n * R * cosLat,
      -(lat - center.lat) * n * R,
    ];
    const nu = Date.now() / 1000;

    for (const v of this.vehicles) {
      if (v.lat === undefined || v.lon === undefined) continue;
      const [wx, wy] = naarWereld(v.lat, v.lon);
      v._wx = wx;
      v._wy = wy;
      v._route = this.routeVoor(v);

      const oud = this._buffer.get(v.id);
      const t = v.t || nu;

      // Positie langs de route (of gewoon x/y als we geen route kennen)
      const d = v._route ? this.afstandLangs(v._route, wx, wy, oud?.d) : null;

      let vorige = null;
      if (historie && historie[v.id]) {
        // Bij de eerste lading: gebruik de voorlaatste peiling uit de database
        // zodat de bussen meteen bewegen in plaats van 20 seconden stil te staan.
        const h = historie[v.id];
        const [hx, hy] = naarWereld(h.lat, h.lon);
        vorige = {
          x: hx, y: hy, t: h.t,
          d: v._route ? this.afstandLangs(v._route, hx, hy, d) : null,
        };
      } else if (oud) {
        vorige = { x: oud.x, y: oud.y, t: oud.t, d: oud.d };
      }

      // Niets veranderd? Buffer laten staan, anders begint de bus opnieuw.
      if (oud && !historie && Math.abs(oud.x - wx) < 8 && Math.abs(oud.y - wy) < 8) {
        oud.stil = true;
        continue;
      }

      const entry = {
        x: wx, y: wy, t, d,
        vorige,
        start: nu,
        route: v._route,
        stil: false,
      };

      // Snelheid en richting langs de route
      if (vorige && vorige.t && t > vorige.t) {
        const dt = Math.max(t - vorige.t, 1);
        const afstand = (d !== null && vorige.d !== null && d >= vorige.d)
          ? d - vorige.d
          : Math.hypot(wx - vorige.x, wy - vorige.y);
        entry.snelheid = afstand / dt;
        entry.reistijd = dt;
      }

      this._buffer.set(v.id, entry);
    }

    // Buffers van verdwenen voertuigen opruimen
    if (this._buffer.size > this.vehicles.length * 2) {
      const levend = new Set(this.vehicles.map(v => v.id));
      for (const id of this._buffer.keys()) {
        if (!levend.has(id)) this._buffer.delete(id);
      }
    }
  }

  setLineFilter(lines) {
    this.filteredLines = new Set(lines);
  }

  zichtbaar(lijn) {
    return this.filteredLines.size === 0 || this.filteredLines.has(lijn);
  }

  // === Route-wiskunde ===

  /** Afstand langs de route van het punt dat het dichtst bij (x,y) ligt. */
  afstandLangs(route, x, y, hint) {
    const pts = route.pts;
    const cum = route.cum;
    let van = 0, tot = pts.length - 1;

    // Met een hint (vorige positie) zoeken we alleen in de buurt — dat is
    // sneller én voorkomt dat een bus naar een ander stuk van dezelfde
    // lijn springt waar de route zichzelf kruist.
    if (hint !== null && hint !== undefined) {
      van = this.indexBijAfstand(cum, hint - 1200);
      tot = Math.min(pts.length - 1, this.indexBijAfstand(cum, hint + 1200) + 1);
    }

    let besteD = 0, besteAfstand = Infinity;
    for (let i = van; i < tot; i++) {
      const ax = pts[i][0], ay = pts[i][1];
      const dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const px = ax + t * dx, py = ay + t * dy;
      const afstand = Math.hypot(x - px, y - py);
      if (afstand < besteAfstand) {
        besteAfstand = afstand;
        besteD = cum[i] + t * Math.sqrt(len2);
      }
    }

    // Te ver van de route af (omleiding, verkeerde shape): dan liever
    // in rechte lijn bewegen dan een bus 500 meter verkeerd neerzetten.
    if (besteAfstand > 120) {
      if (hint !== null && hint !== undefined) return this.afstandLangs(route, x, y, null);
      return null;
    }
    return besteD;
  }

  indexBijAfstand(cum, d) {
    let laag = 0, hoog = cum.length - 1;
    while (laag < hoog) {
      const mid = (laag + hoog) >> 1;
      if (cum[mid] < d) laag = mid + 1;
      else hoog = mid;
    }
    return Math.max(0, laag - 1);
  }

  /** Punt + richting op afstand d langs de route. */
  puntOpRoute(route, d) {
    const pts = route.pts, cum = route.cum;
    const i = Math.min(this.indexBijAfstand(cum, d), pts.length - 2);
    const seg = cum[i + 1] - cum[i];
    const t = seg > 0 ? Math.max(0, Math.min(1, (d - cum[i]) / seg)) : 0;
    const ax = pts[i][0], ay = pts[i][1];
    const dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
    return { x: ax + t * dx, y: ay + t * dy, hoek: Math.atan2(dy, dx) };
  }

  /** Eerstvolgende halte na afstand d. */
  volgendeHalte(route, d) {
    const haltes = route.haltes;
    if (!haltes || !haltes.length) return null;
    for (let i = 0; i < haltes.length; i++) {
      if (haltes[i].d >= d - 25) {
        return { halte: haltes[i], afstand: Math.max(0, haltes[i].d - d) };
      }
    }
    return { halte: haltes[haltes.length - 1], afstand: 0 };
  }

  /** Waar staat dit voertuig nú (met interpolatie tussen twee peilingen). */
  positieVan(v) {
    const buf = this._buffer.get(v.id);
    if (!buf) return { x: v._wx, y: v._wy, hoek: null, voortgang: 1 };

    const verstreken = Date.now() / 1000 - buf.start;
    const reistijd = buf.reistijd || 20;
    const t = buf.vorige ? Math.max(0, Math.min(1, verstreken / reistijd)) : 1;

    if (buf.route && buf.d !== null && buf.vorige && buf.vorige.d !== null && buf.d >= buf.vorige.d) {
      // Glijden lángs de lijn — de bus volgt netjes de weg
      const d = buf.vorige.d + (buf.d - buf.vorige.d) * t;
      const p = this.puntOpRoute(buf.route, d);
      return { x: p.x, y: p.y, hoek: p.hoek, d, voortgang: t };
    }

    if (buf.vorige) {
      const x = buf.vorige.x + (buf.x - buf.vorige.x) * t;
      const y = buf.vorige.y + (buf.y - buf.vorige.y) * t;
      const dx = buf.x - buf.vorige.x, dy = buf.y - buf.vorige.y;
      const hoek = Math.hypot(dx, dy) > 3 ? Math.atan2(dy, dx) : null;
      return { x, y, hoek, d: buf.d, voortgang: t };
    }

    return { x: buf.x, y: buf.y, hoek: null, d: buf.d, voortgang: 1 };
  }

  /** Snelheid in m/s zoals afgeleid uit de eigen metingen. */
  snelheidVan(v) {
    const buf = this._buffer.get(v.id);
    if (!buf || buf.snelheid === undefined) return null;
    if (buf.stil) return 0;
    return buf.snelheid;
  }

  // === Rendering ===

  render() {
    if (!this.mapData) return;

    const ctx = this.ctx;
    const c = this.colors;
    const z = this.cam.zoom;

    // Camera-interpolatie (soepel toebewegen)
    this.cam.x += (this.targetCam.x - this.cam.x) * 0.12;
    this.cam.y += (this.targetCam.y - this.cam.y) * 0.12;
    this.cam.zoom += (this.targetCam.zoom - this.cam.zoom) * 0.12;

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, this.vw, this.vh);

    const b = this.viewportBounds();

    // Detailniveau: ver uitgezoomd laten we de kleinste dingen weg. Ze zijn
    // dan toch een paar pixels groot en ze kosten het meeste tekenwerk.
    // Hoe platter de kanteling, hoe meer stad er in beeld past, dus dan
    // schuift die grens mee.
    const detail = z * Math.sqrt(this.tilt / 0.55);
    const minFormaat = detail < 0.85 ? 26 : detail < 1.3 ? 12 : 0;

    // 1. Water en groen
    this.drawLayer(ctx, this.mapData.water, b, (ctx, el) => this.drawPolygon(ctx, el.pts, c.water));
    this.drawLayer(ctx, this.mapData.green, b, (ctx, el) => this.drawPolygon(ctx, el.pts, c.green), minFormaat);

    // 2. Straten
    const minWegBreedte = detail < 0.85 ? 5 : 0;
    this.drawLayer(ctx, this.mapData.streets, b, (ctx, el) => {
      if ((el.w || 5) < minWegBreedte) return;
      this.drawPolyline(ctx, el.pts, (el.w || 5) >= 10 ? c.streetMajor : c.street,
                        Math.max(1.2, (el.w || 5) * z * 0.9));
    });

    // 3. Gebouwen met 3D-extrusie
    this.drawLayer(ctx, this.mapData.buildings, b, (ctx, el) => this.drawBuilding(ctx, el), minFormaat);

    // 4. Lijnen, haltes, bussen
    this.tekenLijnen(ctx, b);
    this.tekenHaltes(ctx);
    this.tekenVoertuigen(ctx);
  }

  viewportBounds() {
    const hoeken = [
      this.screenToWorld(0, 0),
      this.screenToWorld(this.vw, 0),
      this.screenToWorld(0, this.vh),
      this.screenToWorld(this.vw, this.vh),
    ];
    return {
      minX: Math.min(...hoeken.map(p => p.x)) - 200,
      maxX: Math.max(...hoeken.map(p => p.x)) + 200,
      minY: Math.min(...hoeken.map(p => p.y)) - 200,
      maxY: Math.max(...hoeken.map(p => p.y)) + 200,
    };
  }

  drawLayer(ctx, elements, bounds, drawFn, minFormaat = 0) {
    if (!elements) return;
    for (const el of elements) {
      const eb = el._b || (el._b = boundsVan(el.pts));
      if (!eb) continue;
      if (eb.maxX < bounds.minX || eb.minX > bounds.maxX ||
          eb.maxY < bounds.minY || eb.minY > bounds.maxY) continue;
      if (minFormaat && Math.max(eb.maxX - eb.minX, eb.maxY - eb.minY) < minFormaat) continue;
      drawFn(ctx, el);
    }
  }

  inBounds(pts, bounds) {
    const eb = boundsVan(pts);
    if (!eb) return false;
    return !(eb.maxX < bounds.minX || eb.minX > bounds.maxX ||
             eb.maxY < bounds.minY || eb.minY > bounds.maxY);
  }

  drawPolygon(ctx, pts, fill) {
    if (pts.length < 3) return;
    ctx.beginPath();
    const p0 = this.worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = this.worldToScreen(pts[i][0], pts[i][1]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  drawPolyline(ctx, pts, color, width) {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = this.worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = this.worldToScreen(pts[i][0], pts[i][1]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  drawBuilding(ctx, el) {
    const c = this.colors;
    const pts = el.pts;
    if (pts.length < 3) return;

    const heightM = Math.max(6, el.h || 9);
    const hoogte = heightM * this.heightScale * this.cam.zoom;

    const grond = pts.map(p => this.worldToScreen(p[0], p[1]));

    // Windingsrichting op het scherm bepalen — daarmee weten we welke
    // zijvlakken naar de kijker toe wijzen (en welke we dus mogen skippen).
    let oppervlak = 0;
    for (let i = 0; i < grond.length - 1; i++) {
      oppervlak += grond[i].x * grond[i + 1].y - grond[i + 1].x * grond[i].y;
    }
    const teken = oppervlak > 0 ? 1 : -1;

    const palet = this._gevelPalet;
    const tint = el._tint || 0;

    if (hoogte > 1) {
      ctx.fillStyle = palet ? palet.zij[tint] : c.buildingSide;
      ctx.beginPath();
      for (let i = 0; i < grond.length - 1; i++) {
        const a = grond[i], b = grond[i + 1];
        // Buitennormaal op het scherm: wijst-ie naar beneden, dan zien we het vlak
        if (-(b.x - a.x) * teken <= 0) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(b.x, b.y - hoogte);
        ctx.lineTo(a.x, a.y - hoogte);
        ctx.closePath();
      }
      ctx.fill();
    }

    // Dak
    ctx.beginPath();
    ctx.moveTo(grond[0].x, grond[0].y - hoogte);
    for (let i = 1; i < grond.length; i++) {
      ctx.lineTo(grond[i].x, grond[i].y - hoogte);
    }
    ctx.closePath();
    ctx.fillStyle = palet ? palet.dak[tint] : c.buildingRoof;
    ctx.fill();
    if (this.cam.zoom > 0.8) {
      ctx.strokeStyle = c.buildingLijn;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }

  tekenLijnen(ctx, bounds) {
    if (!this.lijnen.length) return;
    const z = this.cam.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const gefilterd = this.filteredLines.size > 0;

    // Eerst alle gedempte lijnen, dan de uitgelichte er bovenop
    for (const laag of [0, 1]) {
      for (const r of this.lijnen) {
        const actief = this.zichtbaar(r.lijn);
        if ((laag === 0) === actief) continue;
        if (!r._segmenten) continue;

        const kleur = r.kleur || this.colors.route;
        const dim = gefilterd && !actief;
        const casing = dim ? 0.05 : 0.16;
        const kern = dim ? 0.10 : (gefilterd ? 0.85 : 0.45);

        for (const seg of r._segmenten) {
          const b = seg.b;
          if (b.maxX < bounds.minX || b.minX > bounds.maxX ||
              b.maxY < bounds.minY || b.minY > bounds.maxY) continue;
          this.drawPolyline(ctx, seg.pts, kleurMetAlpha(kleur, casing), Math.max(4, 9 * z));
          this.drawPolyline(ctx, seg.pts, kleurMetAlpha(kleur, kern), Math.max(1.2, 2.4 * z));
        }
      }
    }
  }

  tekenHaltes(ctx) {
    const z = this.cam.zoom;
    if (z < 0.85 || !this.haltes.length) return;
    const c = this.colors;
    const r = Math.max(2, Math.min(4.5, 1.4 * z));
    const gefilterd = this.filteredLines.size > 0;

    ctx.lineWidth = Math.max(1, r * 0.55);
    ctx.strokeStyle = c.halteRing;
    ctx.fillStyle = c.halte;

    for (const h of this.haltes) {
      if (gefilterd) {
        let zichtbaar = false;
        for (const lijn of h.lijnen) {
          if (this.filteredLines.has(lijn)) { zichtbaar = true; break; }
        }
        if (!zichtbaar) continue;
      }
      const p = this.worldToScreen(h.x, h.y);
      if (p.x < -10 || p.x > this.vw + 10 || p.y < -10 || p.y > this.vh + 10) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }
  }

  tekenVoertuigen(ctx) {
    const z = this.cam.zoom;
    const schaal = Math.max(0.75, Math.min(1.9, 0.55 + z * 0.55));
    this._busSchaal = schaal;

    // Van achter naar voren tekenen zodat bussen elkaar netjes overlappen
    const zichtbaar = [];
    for (const v of this.vehicles) {
      if (!this.zichtbaar(v.lijn)) continue;
      const pos = this.positieVan(v);
      if (pos.x === undefined) continue;
      const p = this.worldToScreen(pos.x, pos.y);
      if (p.x < -60 || p.x > this.vw + 60 || p.y < -60 || p.y > this.vh + 60) {
        v._sx = undefined; // buiten beeld: niet meer aanwijsbaar
        continue;
      }
      v._sx = p.x;
      v._sy = p.y;
      v._dispWx = pos.x;
      v._dispWy = pos.y;
      v._d = pos.d;
      zichtbaar.push({ v, p, hoek: pos.hoek });
    }
    zichtbaar.sort((a, b) => a.p.y - b.p.y);

    for (const { v, p, hoek } of zichtbaar) {
      const route = v._route;
      const kleur = route?.kleur || this.colors.route;
      const geselecteerd = this.hoveredVehicle && this.hoveredVehicle.id === v.id;
      this.tekenBus(ctx, p.x, p.y, schaal, this.schermHoek(hoek), geselecteerd, kleur);
      if (z > 0.6) this.tekenLijnLabel(ctx, p.x, p.y, schaal, v.lijn, kleur);
    }
  }

  /**
   * De rijrichting omgerekend naar een hoek op het scherm. De iso-projectie
   * en de kanteling drukken die hoek in — daardoor kantelt een bus precies
   * mee met de weg waar hij op rijdt.
   */
  schermHoek(wereldHoek) {
    if (wereldHoek === null || wereldHoek === undefined) return 0;
    const dx = (Math.cos(wereldHoek) - Math.sin(wereldHoek)) * this.cosA;
    const dy = (Math.cos(wereldHoek) + Math.sin(wereldHoek)) * this.sinA * this.tilt;
    return Math.atan2(dy, dx);
  }

  /**
   * De kleuren van één busje, afgeleid van de kleur van zijn lijn. Ramen en
   * randje passen zich aan de helderheid aan, zodat een gele bus donkere
   * ruiten krijgt en een donkerblauwe juist lichte.
   */
  busKleuren(lijnKleur) {
    const sleutel = lijnKleur || 'standaard';
    let set = this._busKleuren.get(sleutel);
    if (set) return set;

    const c = this.colors;
    const eigenKleur = lijnKleur && lijnKleur !== LIJN_STANDAARDKLEUR;
    const basis = hexNaarRgb(eigenKleur ? lijnKleur : c.bus);
    const licht = basis[0] * 0.299 + basis[1] * 0.587 + basis[2] * 0.114;

    set = {
      body: rgbNaarString(basis),
      // Daklijn: lichte bussen krijgen een tikje schaduw, donkere een highlight
      dak: rgbNaarString(licht > 175
        ? schaalKleur(basis, 0.93)
        : mengKleur(basis, [255, 255, 255], 0.24)),
      // Alleen echt bleke bussen (geel) krijgen donkere ruiten; de rest
      // houdt de lichte ruitjes, dat leest als een busje in plaats van als
      // een gekleurd blokje.
      ruit: rgbNaarString(licht > 190
        ? mengKleur(basis, [40, 45, 54], 0.62)
        : mengKleur(basis, [242, 248, 252], 0.85)),
      wiel: licht < 55 ? 'rgba(240,244,250,0.45)' : c.busWiel,
      rand: rgbNaarString(schaalKleur(basis, 0.62)),
    };
    this._busKleuren.set(sleutel, set);
    return set;
  }

  /** Een klein busje in zijaanzicht, gedraaid in de rijrichting. */
  tekenBus(ctx, x, y, schaal, hoek, geselecteerd, kleur) {
    const c = this.colors;
    const bus = this.busKleuren(kleur);
    const w = 28 * schaal;
    const h = 11 * schaal;
    const r = 3 * schaal;

    ctx.save();
    ctx.translate(x, y);

    // Naar links rijden zou het busje op zijn kop zetten; dan draaien we een
    // halve slag terug en spiegelen we, zodat de wielen onder blijven.
    const spiegel = Math.cos(hoek) < 0;
    let draai = spiegel ? (hoek > 0 ? hoek - Math.PI : hoek + Math.PI) : hoek;
    // Richtingen die op het scherm bijna recht naar beneden wijzen zouden het
    // busje op zijn neus zetten. Daar knijpen we de hoek af: liever een bus
    // die een helling op lijkt te rijden dan eentje die een salto maakt.
    draai = Math.max(-MAX_BUSKANTELING, Math.min(MAX_BUSKANTELING, draai));
    ctx.rotate(draai);
    if (spiegel) ctx.scale(-1, 1);

    // Schaduw op de grond, mee gedraaid met de bus
    ctx.fillStyle = c.schaduw;
    ctx.beginPath();
    ctx.ellipse(0, h * 0.16, w * 0.48, h * 0.34, 0, 0, TAU);
    ctx.fill();

    ctx.translate(-w / 2, -h);

    // Wielen
    ctx.fillStyle = bus.wiel;
    const wielR = 2.1 * schaal;
    ctx.beginPath();
    ctx.arc(w * 0.20, h, wielR, 0, TAU);
    ctx.arc(w * 0.80, h, wielR, 0, TAU);
    ctx.fill();

    // Carrosserie in de kleur van de lijn
    ctx.fillStyle = bus.body;
    afgerondeRechthoek(ctx, 0, 0, w, h, r);
    ctx.fill();

    // Lichte daklijn geeft het busje een beetje volume
    ctx.fillStyle = bus.dak;
    afgerondeRechthoek(ctx, 0, 0, w, h * 0.34, r);
    ctx.fill();

    // Ramen: vier zijruiten plus een grotere voorruit
    ctx.fillStyle = bus.ruit;
    const ry = h * 0.30, rh = h * 0.34;
    const rw = w * 0.115;
    for (let i = 0; i < 4; i++) {
      afgerondeRechthoek(ctx, w * 0.075 + i * (rw + w * 0.045), ry, rw, rh, 1.2 * schaal);
      ctx.fill();
    }
    afgerondeRechthoek(ctx, w * 0.73, ry, w * 0.16, rh * 1.1, 1.4 * schaal);
    ctx.fill();

    // Randje voor definitie
    ctx.strokeStyle = bus.rand;
    ctx.lineWidth = Math.max(0.6, 0.5 * schaal);
    afgerondeRechthoek(ctx, 0, 0, w, h, r);
    ctx.stroke();

    ctx.restore();

    if (geselecteerd) {
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - h * 0.4, w * 0.58, 0, TAU);
      ctx.stroke();
    }
  }

  /** Lijnnummer als klein bordje boven de bus, in de kleur van de lijn. */
  tekenLijnLabel(ctx, x, y, schaal, lijn, kleur) {
    if (!lijn) return;
    const fontSize = Math.round(9 * Math.max(1, schaal * 0.9));
    ctx.font = `700 ${fontSize}px ${this.monoFont || '"JetBrains Mono Variable", ui-monospace, monospace'}`;
    const tekst = String(lijn);
    const breedte = ctx.measureText(tekst).width + fontSize * 0.9;
    const hoogte = fontSize * 1.5;
    const bx = x - breedte / 2;
    const by = y - 13 * schaal - hoogte;

    ctx.fillStyle = kleur;
    afgerondeRechthoek(ctx, bx, by, breedte, hoogte, hoogte * 0.32);
    ctx.fill();

    ctx.fillStyle = leesbareTekstkleur(kleur);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tekst, x, by + hoogte / 2 + 0.5);
  }

  // === Interaction ===

  setupEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this._gesleept = false;
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.lastMouse.x;
        const dy = e.clientY - this.lastMouse.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this._gesleept = true;
        this.pan(dx, dy);
        this.lastMouse = { x: e.clientX, y: e.clientY };
        this.render();
        return;
      }
      this.mouseWorld = this.screenToWorld(e.clientX, e.clientY);
      this.checkHover(e.clientX, e.clientY);
    });

    canvas.addEventListener('mouseup', () => { this.dragging = false; });
    canvas.addEventListener('mouseleave', () => {
      this.dragging = false;
      if (this.hoveredVehicle) {
        this.hoveredVehicle = null;
        this.onHoverChange?.(null);
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });

    // Touch
    let touchDist = 0;
    let touchCenter = { x: 0, y: 0 };

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        this.dragging = true;
        this._gesleept = false;
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        this.dragging = false;
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        touchDist = Math.hypot(dx, dy);
        touchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && this.dragging) {
        const dx = e.touches[0].clientX - this.lastMouse.x;
        const dy = e.touches[0].clientY - this.lastMouse.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this._gesleept = true;
        this.pan(dx, dy);
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.render();
      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.hypot(dx, dy);
        if (touchDist > 0) this.zoomAt(touchCenter.x, touchCenter.y, dist / touchDist);
        touchDist = dist;
        touchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      // Tik zonder slepen = bus aantippen (mobiel heeft geen hover)
      if (this.dragging && !this._gesleept && e.changedTouches.length === 1) {
        this.checkHover(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      }
      this.dragging = false;
    });
  }

  /** Zoek de bus onder de cursor — op de posities zoals ze getekend zijn. */
  checkHover(sx, sy) {
    // Meebewegen met hoe groot de busjes op dit zoomniveau getekend worden
    const raakAfstand = Math.max(18, 13 * (this._busSchaal || 1) + 6);
    let beste = null, besteAfstand = Infinity;
    for (const v of this.vehicles) {
      if (v._sx === undefined) continue;
      if (!this.zichtbaar(v.lijn)) continue;
      const d = Math.hypot(sx - v._sx, sy - (v._sy - 6));
      if (d < raakAfstand && d < besteAfstand) {
        besteAfstand = d;
        beste = v;
      }
    }
    if (beste !== this.hoveredVehicle) {
      this.hoveredVehicle = beste;
      this.onHoverChange?.(beste);
    }
  }
}

// === Hulpjes ===

// Zes pasteltinten waar de gevelkleur naartoe geschoven wordt. Ze zijn
// verdeeld over de kleurcirkel zodat buren duidelijk van elkaar verschillen,
// maar blijven licht en zacht — geen primaire kleuren.
const GEVEL_TINTEN = [
  '#f3c4c9', // oudroze
  '#f7d3ac', // perzik
  '#f2e5ac', // boterbloem
  '#bfe4cb', // mint
  '#b9d8ef', // hemelblauw
  '#d5c8ee', // lila
];

function klemVariatie(factor) {
  const f = parseFloat(factor);
  return isNaN(f) ? 1 : Math.max(0, Math.min(3, f));
}

/** Vaste ruiswaarde 0..1 uit een coördinaat — zelfde plek, zelfde kleur. */
function hashPositie(x, y) {
  let h = Math.imul(Math.round(x) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y) | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function mengKleur(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function schaalKleur(rgb, factor) {
  return [rgb[0] * factor, rgb[1] * factor, rgb[2] * factor];
}

/**
 * Het kleuraandeel van `tint` op `basis` leggen zonder de helderheid te
 * veranderen: alleen het verschil met het eigen grijswaarde-gemiddelde
 * schuift mee. Zo krijgt een donkere gevel wel de kleur van de pastel,
 * maar licht hij niet op.
 */
function verschuifKleur(basis, tint) {
  const grijs = (tint[0] + tint[1] + tint[2]) / 3;
  return [
    basis[0] + (tint[0] - grijs),
    basis[1] + (tint[1] - grijs),
    basis[2] + (tint[2] - grijs),
  ];
}

function rgbNaarString(rgb) {
  const k = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${k(rgb[0])},${k(rgb[1])},${k(rgb[2])})`;
}

function boundsVan(pts) {
  if (!pts || pts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

function afgerondeRechthoek(ctx, x, y, w, h, r) {
  const straal = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + straal, y);
  ctx.arcTo(x + w, y, x + w, y + h, straal);
  ctx.arcTo(x + w, y + h, x, y + h, straal);
  ctx.arcTo(x, y + h, x, y, straal);
  ctx.arcTo(x, y, x + w, y, straal);
  ctx.closePath();
}

const _rgbCache = new Map();

function kleurMetAlpha(hex, alpha) {
  const sleutel = hex + alpha;
  let uit = _rgbCache.get(sleutel);
  if (uit) return uit;
  const [r, g, b] = hexNaarRgb(hex);
  uit = `rgba(${r},${g},${b},${alpha})`;
  _rgbCache.set(sleutel, uit);
  return uit;
}

function hexNaarRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Zwarte of witte tekst, afhankelijk van hoe licht de achtergrond is. */
function leesbareTekstkleur(hex) {
  const [r, g, b] = hexNaarRgb(hex);
  return (r * 0.299 + g * 0.587 + b * 0.114) > 150 ? '#2b3038' : '#ffffff';
}
