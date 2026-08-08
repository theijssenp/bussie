// ============================================================
// Bussie — Isometrische Canvas Renderer
// Volledig vanaf scratch gebouwd, geen externe kaartbibliotheken.
// ============================================================

const TAU = Math.PI * 2;

// Zo ver mag je uitzoomen; daaronder is het kaartbeeld niet meer te lezen
const MIN_ZOOM = 0.0033;

// Onder deze zoom draait de kaart naar het noorden en gaat de kanteling
// eruit: op landsbreedte wil je een kaart zien, geen scheef blok
const ATLAS_ZOOM = 0.035;

// Tot deze zoom staan er plaatsnamen op de kaart; daarboven nemen de
// straatnamen het over en zou het dubbelop worden
const PLAATS_TOT = 0.9;

// Onder deze zoom worden bussen stipjes: een busje van drie beeldpunten
// is toch niet te herkennen, en het scheelt duizenden tekenopdrachten
const STIP_ZOOM = 0.5;

// Zover mag een busje maximaal meekantelen met de weg (30°)
const MAX_BUSKANTELING = Math.PI / 6;

// Hoeveel zoom één beeldpunt scrollen oplevert. Een muiswieltje stuurt
// ongeveer 100 pixels per klik; daarmee komt één klik op ~12% zoom uit,
// net als voorheen. Een trackpad stuurt tientallen véél kleinere events
// per veeg, en die schalen nu evenredig mee in plaats van elk een volle
// stap te doen — vandaar dat twee vingers niet meer wegschieten.
const ZOOM_PER_PIXEL = 0.0011;

// Eén enkel event mag nooit meer dan dit doen; sommige muizen en
// kinetisch doorrollende trackpads sturen ineens honderden pixels.
const ZOOM_STAP_MAX = 120;

// Lijnen zonder eigen kleur in de GTFS krijgen deze; hun bussen houden
// de standaard okerkleur, want een grijs busje leest niet als een bus.
const LIJN_STANDAARDKLEUR = '#8aa0b2';

// Kleur per scheepssoort. Veerboten springen eruit — dat is wat je wilt zien
const SCHIP_KLEUREN = {
  passagier: '#2f8fd0',
  sneldienst: '#2f8fd0',
  vracht: '#7d8a99',
  tanker: '#9a6b5a',
  sleepboot: '#e08a3c',
  visser: '#5aa06e',
  zeilboot: '#8fb0c4',
  plezier: '#8fb0c4',
  overig: '#93a3b0',
};
const KNOOP = 0.5144;   // knoop → meter per seconde

// Kleur per treinsoort — de vertrouwde NS-tinten, meteen herkenbaar
const TREIN_KLEUREN = {
  intercity: '#003082',
  sprinter: '#ffc917',
  trein: '#5a6472',
};

export class IsoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    // De ondergrond (tegels, lijnen, straatnamen, plaatsen, haltes)
    // verandert alleen als de camera, thema of data verandert — niet elke
    // animatieframe. Die tekenen we daarom op een apart canvas en hergebruiken
    // we (drawImage) totdat er echt iets wijzigt; alleen de bewegende lagen
    // (bussen, treinen, schepen) komen er elk frame overheen.
    this.achtergrondCanvas = document.createElement('canvas');
    this.achtergrondCtx = this.achtergrondCanvas.getContext('2d', { alpha: false });
    this._bgVies = true;
    this._bgSnapshot = null;

    // Camera state
    this.cam = { x: 0, y: 0, zoom: 1, rotation: 0 };
    this.targetCam = { x: 0, y: 0, zoom: 1, rotation: 0 };

    // Map data
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
    this.hoveredSchip = null;
    this.schepen = [];
    this.hoveredTrein = null;
    this.treinen = [];

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
        bebouwing: '#d3cec4',      // platte stadsvlek ver uitgezoomd
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
        bebouwing: '#212734',      // platte stadsvlek ver uitgezoomd
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
    this.draai = this.isoAngle;     // huidige draaiing, wordt geanimeerd
    this.cosA = Math.cos(this.draai);
    this.sinA = Math.sin(this.draai);
    this.tilt = 0.3;
    const bewaardeTilt = parseFloat(localStorage.getItem('bussie-tilt2'));
    if (bewaardeTilt >= 0.3 && bewaardeTilt <= 1) this.tilt = bewaardeTilt;
    // Wat de schuifregelaar zegt. In de atlasstand wijkt de getekende
    // kanteling daarvan af, en bij het inzoomen komt hij hier weer op uit.
    this.tiltVoorkeur = this.tilt;

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
    this._bgVies = true;
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
    this.achtergrondCanvas.width = w * dpr;
    this.achtergrondCanvas.height = h * dpr;
    this.achtergrondCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.vw = w;
    this.vh = h;
    this._bgVies = true;
    this.render();
  }

  /** Forceer een verse tekenbeurt van de ondergrond (tegels/lijnen/haltes),
   * bijvoorbeeld nadat de lijnfilter is aangepast. */
  markeerAchtergrondVies() {
    this._bgVies = true;
  }

  // === Coördinaat transformaties ===

  worldToScreen(wx, wy) {
    const dx = wx - this.cam.x;
    const dy = wy - this.cam.y;
    const z = this.cam.zoom;
    return {
      x: (dx * this.cosA - dy * this.sinA) * z + this.vw / 2,
      y: (dx * this.sinA + dy * this.cosA) * this.tilt * z + this.vh / 2,
    };
  }

  screenToWorld(sx, sy) {
    const z = this.cam.zoom;
    const px = (sx - this.vw / 2) / z;
    const py = (sy - this.vh / 2) / (z * this.tilt);
    // Terugdraaien: de omgekeerde rotatie op het ingedrukte beeld
    return {
      x: px * this.cosA + py * this.sinA + this.cam.x,
      y: -px * this.sinA + py * this.cosA + this.cam.y,
    };
  }

  /** Kantelstand aanpassen (0,3 = heel schuin, 1 = recht van boven). */
  setTilt(tilt) {
    this.tiltVoorkeur = Math.max(0.3, Math.min(1, tilt));
    if (this.cam.zoom >= ATLAS_ZOOM) this.tilt = this.tiltVoorkeur;
    // Tijdens het slepen niet bij elke stap naar localStorage schrijven
    clearTimeout(this._tiltTimer);
    this._tiltTimer = setTimeout(() => {
      localStorage.setItem('bussie-tilt2', String(this.tiltVoorkeur));
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
    const px = dx / z, py = dy / (z * this.tilt);
    const wdx = px * this.cosA + py * this.sinA;
    const wdy = -px * this.sinA + py * this.cosA;
    this.cam.x -= wdx;
    this.cam.y -= wdy;
    this.targetCam.x = this.cam.x;
    this.targetCam.y = this.cam.y;
  }

  zoomAt(sx, sy, factor) {
    const worldBefore = this.screenToWorld(sx, sy);
    // Ondergrens: hier past heel Nederland in beeld. Verder uit heeft geen
    // zin — dan kijk je naar de Noordzee.
    this.cam.zoom = Math.max(MIN_ZOOM, Math.min(6, this.cam.zoom * factor));
    this.targetCam.zoom = this.cam.zoom;
    const worldAfter = this.screenToWorld(sx, sy);
    this.cam.x += worldBefore.x - worldAfter.x;
    this.cam.y += worldBefore.y - worldAfter.y;
    this.targetCam.x = this.cam.x;
    this.targetCam.y = this.cam.y;
  }

  // === Data ===

  /**
   * De tegelbron levert de kaartondergrond. De renderer vraagt per frame
   * welke tegels in beeld zijn; laden gebeurt op de achtergrond.
   */
  setTegelBron(bron) {
    this.tegelBron = bron;
    this.center = bron.center;
    const start = bron.index?.start;
    if (start) {
      this.cam.x = this.targetCam.x = start.x;
      this.cam.y = this.targetCam.y = start.y;
      this.cam.zoom = this.targetCam.zoom = 1.1;
    }
  }


  /** Lijnroutes met kleur, cumulatieve afstand en haltes. */
  setLijnen(lijnen) {
    this.lijnen = lijnen || [];
    this.lijnIndex.clear();

    for (const r of this.lijnen) {
      // Cumulatieve afstand langs de route. Die staat niet in het bestand —
      // hem hier uitrekenen kost een paar milliseconden en scheelt een derde
      // aan overdracht.
      if (!r.cum) {
        const cum = new Float64Array(r.pts.length);
        for (let i = 1; i < r.pts.length; i++) {
          cum[i] = cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0],
                                           r.pts[i][1] - r.pts[i - 1][1]);
        }
        r.cum = cum;
      }
      // Zichtbaar deel: alleen wat binnen de kaartrand valt, opgeknipt in
      // losse stukken zodat een lijn niet dwars door leeg gebied doorloopt.
      r._segmenten = this.knipOpKaart(r.pts);
      for (const rid of r.rids || []) {
        this.lijnIndex.set(`${rid}|${r.richting}`, r);
        if (!this.lijnIndex.has(rid)) this.lijnIndex.set(rid, r);
      }
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

  /** Knip een polyline op de rand van het gebied waar we tegels van hebben. */
  knipOpKaart(pts) {
    const bereik = this.tegelBron?.index?.bereik;
    if (!bereik) return [{ pts, b: boundsVan(pts) }];
    const marge = 600;
    const minX = bereik.minX - marge, maxX = bereik.maxX + marge;
    const minY = bereik.minY - marge, maxY = bereik.maxY + marge;

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
  /**
   * De lijnroute waar dit voertuig op rijdt. Alleen op route_id matchen:
   * op lijnnummer zou lijn 1 uit Amsterdam aan lijn 1 uit Groningen worden
   * gekoppeld, en dan glijdt een bus honderd kilometer verderop.
   */
  routeVoor(v) {
    return (
      this.lijnIndex.get(`${v.rid}|${v.richting}`) ||
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
    const center = this.center;
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

  /**
   * Scheepsposities uit de AIS-stroom. Schepen melden zich elke paar
   * seconden, maar wij peilen minder vaak; daarom rekenen we tussendoor
   * met koers en snelheid door (gegist bestek), net zolang tot er een
   * nieuwe melding is.
   */
  setSchepen(schepen) {
    const center = this.center;
    if (!center) return;
    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
    const nu = Date.now() / 1000;

    this.schepen = (schepen || []).map(s => ({
      ...s,
      _wx: (s.lon - center.lon) * n * R * cosLat,
      _wy: -(s.lat - center.lat) * n * R,
      _gezien: nu,
    }));
  }

  /** Waar vaart dit schip nu, doorgerekend vanaf de laatste melding. */
  positieVanSchip(schip) {
    const verstreken = Math.min(90, Date.now() / 1000 - schip._gezien);
    if (!schip.snelheid || schip.koers === null || schip.koers === undefined) {
      return { x: schip._wx, y: schip._wy };
    }
    const afstand = schip.snelheid * KNOOP * verstreken;
    const rad = schip.koers * Math.PI / 180;
    // Koers is een kompaspeiling: 0 = noord, met de klok mee
    return {
      x: schip._wx + Math.sin(rad) * afstand,
      y: schip._wy - Math.cos(rad) * afstand,
    };
  }

  tekenSchepen(ctx) {
    if (!this.schepen?.length) return;
    const z = this.cam.zoom;
    const schaal = Math.max(0.7, Math.min(2.2, 0.5 + z * 0.7));

    const stippen = z < STIP_ZOOM;
    const perKleur = new Map();

    for (const schip of this.schepen) {
      const pos = this.positieVanSchip(schip);
      const p = this.worldToScreen(pos.x, pos.y);
      if (p.x < -40 || p.x > this.vw + 40 || p.y < -40 || p.y > this.vh + 40) {
        schip._sx = undefined;
        continue;
      }
      schip._sx = p.x;
      schip._sy = p.y;
      const kleur = SCHIP_KLEUREN[schip.soort] || SCHIP_KLEUREN.overig;

      if (stippen) {
        const lijst = perKleur.get(kleur);
        if (lijst) lijst.push(p);
        else perKleur.set(kleur, [p]);
        continue;
      }
      this.tekenSchip(ctx, p.x, p.y, schaal, this.schermHoek(koersNaarWereld(schip.koers)),
                      kleur, schip.lengte);
      if (this.hoveredSchip === schip) {
        ctx.strokeStyle = this.colors.text;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 15 * schaal, 0, TAU);
        ctx.stroke();
      }
    }

    for (const [kleur, punten] of perKleur) {
      ctx.fillStyle = kleur;
      ctx.beginPath();
      for (const p of punten) {
        ctx.moveTo(p.x + 2, p.y);
        ctx.arc(p.x, p.y, 2, 0, TAU);
      }
      ctx.fill();
    }
  }

  /** Een romp met een punt aan de voorkant, gedraaid in de vaarrichting. */
  tekenSchip(ctx, x, y, schaal, hoek, kleur, lengte) {
    // Grote schepen mogen wat groter, maar het verschil blijft bescheiden
    const l = (lengte && lengte > 120 ? 26 : lengte && lengte > 40 ? 20 : 15) * schaal;
    const b = l * 0.34;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(hoek);

    ctx.fillStyle = this.colors.schaduw;
    ctx.beginPath();
    ctx.ellipse(0, b * 0.32, l * 0.5, b * 0.34, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = kleur;
    ctx.beginPath();
    ctx.moveTo(l * 0.5, 0);            // boeg
    ctx.lineTo(l * 0.12, -b / 2);
    ctx.lineTo(-l * 0.5, -b / 2);      // spiegel
    ctx.lineTo(-l * 0.5, b / 2);
    ctx.lineTo(l * 0.12, b / 2);
    ctx.closePath();
    ctx.fill();

    // Opbouw als klein blokje achterop
    ctx.fillStyle = this.colors.busRuit;
    ctx.fillRect(-l * 0.36, -b * 0.22, l * 0.22, b * 0.44);

    ctx.restore();
  }

  /**
   * Treinposities uit de NS Virtual Train API. Net als bij de schepen: de
   * backend pollt maar eens per 30s, dus tussendoor rekenen we met koers en
   * snelheid door (gegist bestek) zodat een trein niet 30 seconden stilstaat.
   */
  setTreinen(treinen) {
    const center = this.center;
    if (!center) return;
    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
    const nu = Date.now() / 1000;

    this.treinen = (treinen || []).map(t => ({
      ...t,
      _wx: (t.lon - center.lon) * n * R * cosLat,
      _wy: -(t.lat - center.lat) * n * R,
      _gezien: nu,
    }));
  }

  /** Waar rijdt deze trein nu, doorgerekend vanaf de laatste melding. */
  positieVanTrein(trein) {
    const verstreken = Math.min(45, Date.now() / 1000 - trein._gezien);
    if (!trein.snelheid || trein.koers === null || trein.koers === undefined) {
      return { x: trein._wx, y: trein._wy };
    }
    const afstand = (trein.snelheid / 3.6) * verstreken;   // km/u → m/s
    const rad = trein.koers * Math.PI / 180;
    // Koers is een kompaspeiling: 0 = noord, met de klok mee
    return {
      x: trein._wx + Math.sin(rad) * afstand,
      y: trein._wy - Math.cos(rad) * afstand,
    };
  }

  tekenTreinen(ctx) {
    if (!this.treinen?.length) return;
    const z = this.cam.zoom;
    const schaal = Math.max(0.85, Math.min(2.0, 0.55 + z * 0.55));

    const stippen = z < STIP_ZOOM;
    const perKleur = new Map();

    for (const trein of this.treinen) {
      const pos = this.positieVanTrein(trein);
      const p = this.worldToScreen(pos.x, pos.y);
      if (p.x < -50 || p.x > this.vw + 50 || p.y < -50 || p.y > this.vh + 50) {
        trein._sx = undefined;
        continue;
      }
      trein._sx = p.x;
      trein._sy = p.y;
      const kleur = TREIN_KLEUREN[trein.soort] || TREIN_KLEUREN.trein;

      if (stippen) {
        const lijst = perKleur.get(kleur);
        if (lijst) lijst.push(p);
        else perKleur.set(kleur, [p]);
        continue;
      }
      this.tekenTrein(ctx, p.x, p.y, schaal, this.schermHoek(koersNaarWereld(trein.koers)),
                       this.hoveredTrein === trein, kleur);
    }

    for (const [kleur, punten] of perKleur) {
      ctx.fillStyle = kleur;
      ctx.beginPath();
      for (const p of punten) {
        ctx.moveTo(p.x + 2.2, p.y);
        ctx.arc(p.x, p.y, 2.2, 0, TAU);
      }
      ctx.fill();
    }
  }

  setLineFilter(lines) {
    this.filteredLines = new Set(lines);
    this._bgVies = true;
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
    if (!this.tegelBron) return;

    const mainCtx = this.ctx;

    // Camera-interpolatie (soepel toebewegen)
    this.cam.x += (this.targetCam.x - this.cam.x) * 0.12;
    this.cam.y += (this.targetCam.y - this.cam.y) * 0.12;
    this.cam.zoom += (this.targetCam.zoom - this.cam.zoom) * 0.12;

    // Ná de interpolatie uitlezen, anders tekent de ondergrond op een andere
    // zoomstand dan de bussen en lopen ze tijdens het zoomen uit elkaar.
    const z = this.cam.zoom;

    // Naar de atlasstand toe draaien (noorden boven, plat) of er weer uit
    const atlas = z < ATLAS_ZOOM;
    const doelDraai = atlas ? 0 : this.isoAngle;
    const doelTilt = atlas ? 1 : this.tiltVoorkeur;
    if (Math.abs(this.draai - doelDraai) > 0.0005 || Math.abs(this.tilt - doelTilt) > 0.0005) {
      this.draai += (doelDraai - this.draai) * 0.09;
      this.tilt += (doelTilt - this.tilt) * 0.09;
      this.cosA = Math.cos(this.draai);
      this.sinA = Math.sin(this.draai);
    }

    // Projectie één keer per frame uitrekenen; de tekenlussen gebruiken
    // deze getallen rechtstreeks in plaats van worldToScreen per punt.
    this._proj = {
      cx: this.cam.x, cy: this.cam.y,
      cos: this.cosA, sin: this.sinA, z, tiltZ: this.tilt * z,
      ox: this.vw / 2, oy: this.vh / 2,
    };

    const b = this.viewportBounds();

    // De ondergrond (tegels, lijnen, straatnamen, plaatsen, haltes) is
    // duur om te tekenen maar verandert alleen als de camera, het thema
    // of de data echt anders is — niet elke animatieframe. Bij een
    // stilstaande kaart hergebruiken we daarom het vorige plaatje in
    // plaats van alles opnieuw te tekenen; alleen bussen/treinen/schepen
    // komen er (goedkoop) elk frame overheen.
    const snap = { x: this.cam.x, y: this.cam.y, z, tilt: this.tilt, draai: this.draai };
    const vorig = this._bgSnapshot;
    const veranderd = !vorig
      || Math.abs((snap.x - vorig.x) * z) > 0.2
      || Math.abs((snap.y - vorig.y) * z) > 0.2
      || Math.abs(snap.z - vorig.z) > 0.0008
      || Math.abs(snap.tilt - vorig.tilt) > 0.0008
      || Math.abs(snap.draai - vorig.draai) > 0.0008;

    if (this._bgVies || veranderd) {
      const bgCtx = this.achtergrondCtx;
      bgCtx.fillStyle = this.colors.bg;
      bgCtx.fillRect(0, 0, this.vw, this.vh);

      // Detailniveau bepaalt welk tegelniveau we ophalen. Hoe platter de
      // kanteling, hoe meer kaart er in beeld past, dus dat telt mee.
      const detail = z * Math.sqrt(this.tilt / 0.55);
      this.tekenTegels(bgCtx, b, detail);
      this.tekenLijnen(bgCtx, b);
      if (this._zichtbareTegels) this.tekenStraatnamen(bgCtx, this._zichtbareTegels);
      this.tekenPlaatsen(bgCtx);
      this.tekenHaltes(bgCtx);

      this._bgSnapshot = snap;
      this._bgVies = false;
    }

    mainCtx.drawImage(this.achtergrondCanvas, 0, 0, this.vw, this.vh);

    // Bewegende lagen: elk frame vers, maar samen ruim onder de 1ms
    this.tekenSchepen(mainCtx);
    this.tekenTreinen(mainCtx);
    this.tekenVoertuigen(mainCtx);
  }

  /**
   * De kaartondergrond uit de tegels. Tegels worden van achter naar voren
   * getekend: gevels steken omhoog en dus het beeld van de tegel áchter
   * zich in, en die staat er dan al.
   */
  tekenTegels(ctx, bounds, detail) {
    const bron = this.tegelBron;
    if (!bron) return;
    const c = this.colors;
    const z = this.cam.zoom;

    const niveau = bron.niveauVoor(detail);
    const tegels = bron.zichtbaar(niveau, bounds);
    this.tegelStand = { niveau, getekend: tegels.length, cache: bron.cache.size };
    this._zichtbareTegels = tegels;

    for (const t of tegels) {
      for (const el of t.water) {
        if (this.buitenBeeld(el, bounds)) continue;
        this.tekenVlak(ctx, el.pts, c.water);
      }
      for (const el of t.green) {
        if (this.buitenBeeld(el, bounds)) continue;
        this.tekenVlak(ctx, el.pts, c.green);
      }
      for (const el of t.streets) {
        if (this.buitenBeeld(el, bounds)) continue;
        const breedte = el.breedte || 5;
        this.tekenLijn(ctx, el.pts, breedte >= 10 ? c.streetMajor : c.street,
                       Math.max(1.2, breedte * z * 0.9));
      }
      // Op de grove niveaus staan er geen panden in de tegel maar
      // samengevatte blokken. Die als gebouw overeind zetten geeft een
      // schaakbord; plat meelopen met de ondergrond leest als een stadsvlek
      // tussen het water, het groen en de wegen.
      const plat = t.niveau <= 2;
      if (plat) ctx.fillStyle = c.bebouwing;
      for (const el of t.buildings) {
        if (this.buitenBeeld(el, bounds)) continue;
        if (plat) this.tekenVlak(ctx, el.pts, c.bebouwing);
        else this.tekenGebouw(ctx, el);
      }
    }
  }

  /**
   * Straatnamen langs hun straat. Ze draaien mee met de weg, wijken voor
   * elkaar zodat er niets overlapt, en krijgen een randje in de
   * achtergrondkleur zodat ze leesbaar blijven boven gevels.
   */
  tekenStraatnamen(ctx, tegels) {
    const z = this.cam.zoom;
    // Vanaf hier zijn er namen in de tegels (niveau 3); eerder heeft het
    // geen zin, en veel later dan dit mist iemand ze bij normaal inzoomen.
    if (z < 0.9) return;

    const c = this.colors;
    const grootte = Math.max(9, Math.min(13, 7 + z * 1.4));
    ctx.font = `500 ${grootte}px ${this.labelFont || 'system-ui, sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;

    // Vervaagd binnenkomen zodra je genoeg ingezoomd bent
    const alpha = Math.min(1, (z - 0.9) / 0.25);
    const bezet = [];
    let getekend = 0;

    for (const t of tegels) {
      if (!t.namen) continue;
      for (const label of t.namen) {
        if (getekend >= 150) break;
        const p = this.worldToScreen(label.x, label.y);
        if (p.x < 40 || p.x > this.vw - 40 || p.y < 20 || p.y > this.vh - 20) continue;

        const breedte = ctx.measureText(label.naam).width;
        const halfB = breedte / 2 + 6;
        const halfH = grootte * 0.7;
        // Botst dit label met een eerder geplaatst label?
        let vrij = true;
        for (const b of bezet) {
          if (Math.abs(p.x - b.x) < halfB + b.hb && Math.abs(p.y - b.y) < halfH + b.hh) {
            vrij = false;
            break;
          }
        }
        if (!vrij) continue;
        bezet.push({ x: p.x, y: p.y, hb: halfB, hh: halfH });
        getekend++;

        let hoek = this.schermHoek(label.hoek);
        if (Math.cos(hoek) < 0) hoek = hoek > 0 ? hoek - Math.PI : hoek + Math.PI;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(hoek);
        ctx.strokeStyle = c.bg;
        ctx.strokeText(label.naam, 0, 0);
        ctx.fillStyle = c.text;
        ctx.globalAlpha = alpha * 0.75;
        ctx.fillText(label.naam, 0, 0);
        ctx.restore();
      }
    }
  }

  /** De plaatsnamen die de kaart mag tonen. */
  setPlaatsen(plaatsen) {
    // Grootste eerst: die krijgen voorrang als er te weinig ruimte is
    this.plaatsen = [...(plaatsen || [])].sort((a, b) => b.inwoners - a.inwoners);
  }

  /**
   * Plaatsnamen op de kaart. Ze verschijnen waar je de contouren van het
   * land herkent en verdwijnen zodra de straatnamen het overnemen; hoe
   * verder je uitzoomt, hoe groter een plaats moet zijn om erbij te staan.
   */
  tekenPlaatsen(ctx) {
    const z = this.cam.zoom;
    if (!this.plaatsen?.length || z > PLAATS_TOT) return;

    // Ondergrens aan inwonertal, zodat het nooit een woordenbrij wordt
    const minInwoners = z < 0.008 ? 120000
      : z < 0.02 ? 50000
      : z < 0.05 ? 20000
      : z < 0.15 ? 8000 : 0;

    const c = this.colors;
    const alpha = Math.min(1, (PLAATS_TOT - z) / (PLAATS_TOT * 0.25));
    const bezet = [];
    let getekend = 0;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    for (const plaats of this.plaatsen) {
      if (getekend >= 60) break;
      if (plaats.inwoners < minInwoners) continue;

      const p = this.worldToScreen(plaats.x, plaats.y);
      if (p.x < 30 || p.x > this.vw - 30 || p.y < 16 || p.y > this.vh - 16) continue;

      // Grote steden groter, maar het verschil blijft bescheiden
      const grootte = plaats.inwoners > 150000 ? 14 : plaats.inwoners > 40000 ? 12 : 10.5;
      ctx.font = `600 ${grootte}px ${this.labelFont || 'system-ui, sans-serif'}`;
      const halfB = ctx.measureText(plaats.naam).width / 2 + 7;
      const halfH = grootte * 0.85;

      let vrij = true;
      for (const b of bezet) {
        if (Math.abs(p.x - b.x) < halfB + b.hb && Math.abs(p.y - b.y) < halfH + b.hh) {
          vrij = false;
          break;
        }
      }
      if (!vrij) continue;
      bezet.push({ x: p.x, y: p.y, hb: halfB, hh: halfH });
      getekend++;

      ctx.globalAlpha = alpha;
      // Stipje op de plek zelf, naam er iets boven
      ctx.fillStyle = c.text;
      ctx.beginPath();
      ctx.arc(p.x, p.y, grootte > 12 ? 2.6 : 2, 0, TAU);
      ctx.fill();

      ctx.lineWidth = 3.5;
      ctx.strokeStyle = c.bg;
      ctx.strokeText(plaats.naam, p.x, p.y - grootte);
      ctx.fillStyle = c.text;
      ctx.fillText(plaats.naam, p.x, p.y - grootte);
    }
    ctx.globalAlpha = 1;
  }

  buitenBeeld(el, bounds) {
    return el.maxX < bounds.minX || el.minX > bounds.maxX ||
           el.maxY < bounds.minY || el.minY > bounds.maxY;
  }

  /** Vlak uit een platte Float32Array [x0,y0,x1,y1,…]. */
  tekenVlak(ctx, pts, fill) {
    const n = pts.length;
    if (n < 6) return;
    const p = this._proj;
    ctx.beginPath();
    let dx = pts[0] - p.cx, dy = pts[1] - p.cy;
    ctx.moveTo((dx * p.cos - dy * p.sin) * p.z + p.ox, (dx * p.sin + dy * p.cos) * p.tiltZ + p.oy);
    for (let i = 2; i < n; i += 2) {
      dx = pts[i] - p.cx;
      dy = pts[i + 1] - p.cy;
      ctx.lineTo((dx * p.cos - dy * p.sin) * p.z + p.ox, (dx * p.sin + dy * p.cos) * p.tiltZ + p.oy);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  /** Polylijn uit een platte Float32Array. */
  tekenLijn(ctx, pts, kleur, breedte) {
    const n = pts.length;
    if (n < 4) return;
    const p = this._proj;
    ctx.strokeStyle = kleur;
    ctx.lineWidth = breedte;
    ctx.beginPath();
    let dx = pts[0] - p.cx, dy = pts[1] - p.cy;
    ctx.moveTo((dx * p.cos - dy * p.sin) * p.z + p.ox, (dx * p.sin + dy * p.cos) * p.tiltZ + p.oy);
    for (let i = 2; i < n; i += 2) {
      dx = pts[i] - p.cx;
      dy = pts[i + 1] - p.cy;
      ctx.lineTo((dx * p.cos - dy * p.sin) * p.z + p.ox, (dx * p.sin + dy * p.cos) * p.tiltZ + p.oy);
    }
    ctx.stroke();
  }

  /** Gebouw met 3D-extrusie uit een platte Float32Array. */
  tekenGebouw(ctx, el) {
    const pts = el.pts;
    const n = pts.length >> 1;
    if (n < 3) return;

    const hoogte = Math.max(6, el.hoogte || 9) * this.heightScale * this.cam.zoom;
    const p = this._proj;

    let sx = this._gevelX, sy = this._gevelY;
    if (!sx || sx.length < n) {
      sx = this._gevelX = new Float64Array(Math.max(n, 256));
      sy = this._gevelY = new Float64Array(Math.max(n, 256));
    }
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 2] - p.cx;
      const dy = pts[i * 2 + 1] - p.cy;
      sx[i] = (dx * p.cos - dy * p.sin) * p.z + p.ox;
      sy[i] = (dx * p.sin + dy * p.cos) * p.tiltZ + p.oy;
    }

    // Windingsrichting op het scherm: daarmee weten we welke zijvlakken
    // naar de kijker wijzen en welke we mogen overslaan.
    let oppervlak = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      oppervlak += sx[j] * sy[i] - sx[i] * sy[j];
    }
    const teken = oppervlak > 0 ? 1 : -1;

    const palet = this._gevelPalet;
    const tint = el.tint || 0;

    if (hoogte > 1) {
      ctx.fillStyle = palet ? palet.zij[tint] : this.colors.buildingSide;
      ctx.beginPath();
      for (let i = 0, j = n - 1; i < n; j = i++) {
        if (-(sx[i] - sx[j]) * teken <= 0) continue;
        ctx.moveTo(sx[j], sy[j]);
        ctx.lineTo(sx[i], sy[i]);
        ctx.lineTo(sx[i], sy[i] - hoogte);
        ctx.lineTo(sx[j], sy[j] - hoogte);
        ctx.closePath();
      }
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(sx[0], sy[0] - hoogte);
    for (let i = 1; i < n; i++) ctx.lineTo(sx[i], sy[i] - hoogte);
    ctx.closePath();
    ctx.fillStyle = palet ? palet.dak[tint] : this.colors.buildingRoof;
    ctx.fill();
    if (this.cam.zoom > 0.8) {
      ctx.strokeStyle = this.colors.buildingLijn;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
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

  drawPolyline(ctx, pts, color, width, stap = 1) {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = this.worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = stap; i < pts.length; i += stap) {
      const p = this.worldToScreen(pts[i][0], pts[i][1]);
      ctx.lineTo(p.x, p.y);
    }
    if ((pts.length - 1) % stap !== 0) {
      const laatste = this.worldToScreen(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx.lineTo(laatste.x, laatste.y);
    }
    ctx.stroke();
  }

  tekenLijnen(ctx, bounds) {
    if (!this.lijnen.length) return;
    const z = this.cam.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const gefilterd = this.filteredLines.size > 0;

    // Ver uitgezoomd staan alle routes van het land tegelijk in beeld.
    // Punten die op minder dan een beeldpunt van elkaar liggen hoeven we
    // niet te tekenen, en korte stadslijntjes zijn dan toch een veeg.
    const stap = Math.max(1, Math.floor(0.35 / z));
    // Hoe verder uit, hoe strenger: op landsbreedte wil je het regionale
    // net zien, niet elk stadslijntje van drie kilometer.
    const minLengte = z < 0.05 ? 40000 : z < 0.25 ? 15000 : 0;
    // De brede onderlaag is daar toch niet te onderscheiden van de kern
    const metCasing = z >= 0.25;

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

        if (minLengte && (r.lengte || 0) < minLengte) continue;

        for (const seg of r._segmenten) {
          const b = seg.b;
          if (b.maxX < bounds.minX || b.minX > bounds.maxX ||
              b.maxY < bounds.minY || b.minY > bounds.maxY) continue;
          if (metCasing) {
            this.drawPolyline(ctx, seg.pts, kleurMetAlpha(kleur, casing), Math.max(4, 9 * z), stap);
          }
          this.drawPolyline(ctx, seg.pts, kleurMetAlpha(kleur, kern), Math.max(1.2, 2.4 * z), stap);
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
    // Zodra de tegels echte gebouwen tonen (niveau 3+, zie DETAIL in
    // tegels.py) ogen kleine stipjes verloren tussen de bebouwing: dan
    // blijven het volwaardige bushokjes, met een hogere ondergrens.
    const metGebouwen = this.tegelStand?.niveau >= 3;
    const schaal = metGebouwen
      ? Math.max(1.4, Math.min(1.9, 0.55 + z * 0.55))
      : Math.max(0.75, Math.min(1.9, 0.55 + z * 0.55));
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

    if (z < STIP_ZOOM && !metGebouwen) {
      // Ver uitgezoomd: alleen nog een stip per bus, gegroepeerd per kleur
      // zodat we niet per voertuig de tekenstijl hoeven om te zetten.
      const perKleur = new Map();
      for (const { v, p } of zichtbaar) {
        const kleur = v._route?.kleur || this.colors.route;
        const lijst = perKleur.get(kleur);
        if (lijst) lijst.push(p);
        else perKleur.set(kleur, [p]);
      }
      const straal = Math.max(1.6, 2.6 * Math.min(1, z / STIP_ZOOM + 0.4));
      for (const [kleur, punten] of perKleur) {
        ctx.fillStyle = kleur;
        ctx.beginPath();
        for (const p of punten) {
          ctx.moveTo(p.x + straal, p.y);
          ctx.arc(p.x, p.y, straal, 0, TAU);
        }
        ctx.fill();
      }
      return;
    }

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
    const wx = Math.cos(wereldHoek), wy = Math.sin(wereldHoek);
    const dx = wx * this.cosA - wy * this.sinA;
    const dy = (wx * this.sinA + wy * this.cosA) * this.tilt;
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

  /**
   * Een trein: langer en lager dan een bus, met een spitse neus zodat de
   * rijrichting ook zonder kleur meteen leesbaar is — dezelfde truc als bij
   * de schepen. Verder hergebruikt dit de bus-kleurafleiding: eigen lijnkleur
   * blijft dus net zo goed werken.
   */
  tekenTrein(ctx, x, y, schaal, hoek, geselecteerd, kleur) {
    const c = this.colors;
    const trein = this.busKleuren(kleur);
    const w = 42 * schaal;
    const h = 9 * schaal;
    const neus = w * 0.16;
    const r = 2.4 * schaal;

    ctx.save();
    ctx.translate(x, y);

    const spiegel = Math.cos(hoek) < 0;
    let draai = spiegel ? (hoek > 0 ? hoek - Math.PI : hoek + Math.PI) : hoek;
    draai = Math.max(-MAX_BUSKANTELING, Math.min(MAX_BUSKANTELING, draai));
    ctx.rotate(draai);
    if (spiegel) ctx.scale(-1, 1);

    // Schaduw op de grond
    ctx.fillStyle = c.schaduw;
    ctx.beginPath();
    ctx.ellipse(0, h * 0.16, w * 0.5, h * 0.3, 0, 0, TAU);
    ctx.fill();

    ctx.translate(-w / 2, -h);

    // Bogies: bij een trein zitten de wielen vrijwel onder de bak verstopt,
    // dus twee subtiele donkere balkjes in plaats van ronde buswielen.
    ctx.fillStyle = trein.wiel;
    const bogieW = w * 0.14, bogieH = 1.6 * schaal;
    ctx.fillRect(w * 0.18, h - bogieH * 0.4, bogieW, bogieH);
    ctx.fillRect(w * 0.68, h - bogieH * 0.4, bogieW, bogieH);

    // Carrosserie: een rechthoekige bak met een spitse neus vooraan (rechts,
    // vóór het spiegelen) — leest als een treinstel in plaats van een blokje.
    ctx.fillStyle = trein.body;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - neus, 0);
    ctx.lineTo(w, h * 0.5);
    ctx.lineTo(w - neus, h);
    ctx.lineTo(r, h);
    ctx.arcTo(0, h, 0, h - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
    ctx.fill();

    // Daklijn
    ctx.fillStyle = trein.dak;
    afgerondeRechthoek(ctx, 0, 0, w - neus * 0.6, h * 0.3, r * 0.8);
    ctx.fill();

    // Pantograaf: een klein streepje op het dak, ietwat naar achteren —
    // klein detail maar meteen herkenbaar als trein.
    ctx.strokeStyle = trein.rand;
    ctx.lineWidth = Math.max(0.5, 0.45 * schaal);
    ctx.beginPath();
    ctx.moveTo(w * 0.38, 0);
    ctx.lineTo(w * 0.42, -h * 0.22);
    ctx.lineTo(w * 0.5, -h * 0.22);
    ctx.lineTo(w * 0.54, 0);
    ctx.stroke();

    // Ramenstrook: één doorlopende band i.p.v. losse busramen, licht
    // onderverdeeld zodat het als treinstel met meerdere bakken leest.
    ctx.fillStyle = trein.ruit;
    afgerondeRechthoek(ctx, w * 0.05, h * 0.32, w - neus - w * 0.1, h * 0.32, 1 * schaal);
    ctx.fill();
    ctx.strokeStyle = c.bg;
    ctx.lineWidth = Math.max(0.5, 0.4 * schaal);
    for (const frac of [0.36, 0.62]) {
      ctx.beginPath();
      ctx.moveTo(w * frac, h * 0.32);
      ctx.lineTo(w * frac, h * 0.64);
      ctx.stroke();
    }

    // Randje voor definitie
    ctx.strokeStyle = trein.rand;
    ctx.lineWidth = Math.max(0.6, 0.5 * schaal);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - neus, 0);
    ctx.lineTo(w, h * 0.5);
    ctx.lineTo(w - neus, h);
    ctx.lineTo(r, h);
    ctx.arcTo(0, h, 0, h - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
    ctx.stroke();

    ctx.restore();

    if (geselecteerd) {
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - h * 0.4, w * 0.56, 0, TAU);
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
      if (this.hoveredSchip) {
        this.hoveredSchip = null;
        this.onSchipHover?.(null);
      }
      if (this.hoveredTrein) {
        this.hoveredTrein = null;
        this.onTreinHover?.(null);
      }
    });

    canvas.addEventListener('dblclick', (e) => {
      // Waar je dubbelklikt wil je heen; de camera glijdt er zelf naartoe
      const doel = this.screenToWorld(e.clientX, e.clientY);
      const zoom = Math.min(6, this.cam.zoom * 2.4);
      this.setCenter(doel.x, doel.y, zoom);
      this.onDubbelklik?.(doel, zoom);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // deltaY komt in pixels, regels of pagina's binnen — eerst gelijktrekken
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 33;          // regels
      else if (e.deltaMode === 2) delta *= this.vh; // pagina's
      delta = Math.max(-ZOOM_STAP_MAX, Math.min(ZOOM_STAP_MAX, delta));
      // Exponentieel: even ver scrollen zoomt overal even veel, en twee
      // kleine stapjes doen samen precies zoveel als één grote.
      this.zoomAt(e.clientX, e.clientY, Math.exp(-delta * ZOOM_PER_PIXEL));
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
    let bus = null, schip = null, trein = null, besteAfstand = Infinity;

    for (const v of this.vehicles) {
      if (v._sx === undefined) continue;
      if (!this.zichtbaar(v.lijn)) continue;
      const d = Math.hypot(sx - v._sx, sy - (v._sy - 6));
      if (d < raakAfstand && d < besteAfstand) {
        besteAfstand = d;
        bus = v;
      }
    }

    // Ligt er een schip dichterbij, dan wint dat
    for (const s of this.schepen || []) {
      if (s._sx === undefined) continue;
      const d = Math.hypot(sx - s._sx, sy - s._sy);
      if (d < raakAfstand && d < besteAfstand) {
        besteAfstand = d;
        schip = s;
        bus = null;
      }
    }

    // En een trein wint weer van een schip
    for (const t of this.treinen || []) {
      if (t._sx === undefined) continue;
      const d = Math.hypot(sx - t._sx, sy - t._sy);
      if (d < raakAfstand && d < besteAfstand) {
        besteAfstand = d;
        trein = t;
        bus = null;
        schip = null;
      }
    }

    if (bus !== this.hoveredVehicle) {
      this.hoveredVehicle = bus;
      this.onHoverChange?.(bus);
    }
    if (schip !== this.hoveredSchip) {
      this.hoveredSchip = schip;
      this.onSchipHover?.(schip);
    }
    if (trein !== this.hoveredTrein) {
      this.hoveredTrein = trein;
      this.onTreinHover?.(trein);
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

/** Kompaspeiling (0 = noord, met de klok mee) naar een wereldhoek. */
function koersNaarWereld(koers) {
  if (koers === null || koers === undefined) return null;
  return (koers - 90) * Math.PI / 180;
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
