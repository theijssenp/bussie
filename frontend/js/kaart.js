// ============================================================
// Bussie — Isometrische Canvas Renderer
// Volledig vanaf scratch gebouwd, geen externe kaartbibliotheken.
// ============================================================

import { TreinVolger, SPRONG as TREIN_SPRONG } from './treinvolger.js?v=1';

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

// Rastercel (meters) van de spoorindex waarmee treinen op het spoor worden
// getrokken, en hoe ver een trein maximaal van een spoor mag liggen om er
// nog aan vastgeklikt te worden. Ruimer dan dit is meestal geen meetfout
// meer maar een spoor dat we niet in de tegels hebben (of buitenland).
// Vanaf deze ouderdom (s) begint een treinmelding te vervagen, en bij de
// tweede waarde is hij zo flauw als hij wordt. Zo blijft een trein staan
// waar hij het laatst gezien is, zonder te doen alsof het live is.
const TREIN_VERS = 60;
const TREIN_OUD = 420;
const TREIN_MIN_ALPHA = 0.35;

const SPOOR_CEL = 400;
const SPOOR_SNAP = 150;
// De routevorm uit de dienstregeling ligt tot een paar meter naast het
// OSM-spoor in de tegels; op de diepste zoom is dat tientallen beeldpunten.
// Binnen deze afstand (m) schuiven we een trein het laatste stukje op het
// spoor dat onder hem ligt.
const SPOOR_BIJSCHUIF = 12;

// Treinen rijden langs de route van hun eigen rit, net als bussen langs hun
// lijn (zie treinvolger.js voor het hoe en waarom). Alleen een trein zonder
// bekende route valt terug op het spoor onder zijn peiling: elke peiling
// wordt dan een anker óp het spoor en de trein glijdt van zijn huidige
// beeldpositie naar dat anker. Zonder spoor in de tegels rekent zo'n trein
// hooguit dit aantal seconden doodleijk door met koers en snelheid (s)
const TREIN_DOORREKENEN = 8;
// Boven deze onzekerheidsstraal (m) van de NS weten we niet meer waar een
// trein is; hij vervaagt dan, tot de tweede waarde helemaal flauw.
const TREIN_ONZEKER = 1500;
const TREIN_ONZEKER_MAX = 6000;
// Verschuiving onder dit verschil (m) tegenover het vorige anker is ruis
// van een stilstaand treinstel; hij blijft dan staan in plaats van een
// paar meter heen en weer te huppelen
const TREIN_GLIJD = 15;

// Een bus hoort op zijn lijn te staan. Binnen ROUTE_SNAP meter koppelen we
// hem eraan vast; eenmaal vastgeklikt laten we pas los boven ROUTE_LOS, want
// anders knippert een bus die rond de grens zweeft tussen weg en route.
const ROUTE_SNAP = 120;
const ROUTE_LOS = 260;
// Zoveel meter langs de route verzetten we zonder te glijden: een bus die
// aan een nieuwe rit begint staat ineens aan de andere kant van de lijn, en
// daar wil je hem niet met honderd kilometer per uur naartoe zien schuiven.
const ROUTE_SPRONG = 1500;
// Een stuk route dat tegen de rijrichting in loopt telt bij het zoeken van
// de plek op de route als zoveel meter verder weg. Waar een route op
// zichzelf terugkeert (een trein die kopmaakt in Arnhem of Utrecht) liggen
// de heen- en teruggaande poot op dezelfde sporen; de koers kiest dan de
// goede.
const RICHTING_STRAF = 80;
// Twee opeenvolgende peilingen die meer dan zoveel meter terug langs de
// route liggen: dan rijdt een trein tegen zijn route in en hoort hij op de
// andere richting van zijn lijn. De gemelde koers alleen is daar te
// onbetrouwbaar voor: die staat geregeld een poll of drie verkeerd.
const TREIN_STAP = 30;
// Past geen van beide richtingen, dan laten we de route zo lang (s) met
// rust en volgt de trein het spoor onder zijn peiling.
const TREIN_ROUTE_RUST = 120;
// Zo ver rekenen we een bus vooruit voorbij zijn laatste peiling. De bron
// publiceert maar eens per minuut, dus zonder dit staat een bus altijd te
// zien waar hij een minuut geleden was. Doorrekenen gebeurt lángs de lijn,
// dus de rijrichting komt nog steeds uit de route en niet uit een gok; het
// enige waar we naast kunnen zitten is hoe ver hij ondertussen is gekomen.
const VOORUIT_MAX = 30;
// Sneller dan dit rijdt geen stadsbus (108 km/u). Eén rare peiling zou een
// bus anders kilometers verderop neerzetten.
const VOORUIT_MAX_SNELHEID = 30;
// Komt de schatting lager uit dan wat we net nog toonden, dan blijft de bus
// liever even staan dan dat hij achteruit schuift — tot dit verschil. Groter
// dan dit is geen correctie meer maar een echte verplaatsing (nieuwe rit), en
// dan hoort hij wél te verspringen.
const VOORUIT_DEMPING = 400;

// Vanaf deze snelheid (km/u) krijgt een voertuig een sliert achter zich
const SLIERT_VANAF = 45;

// Eén enkel event mag nooit meer dan dit doen; sommige muizen en
// kinetisch doorrollende trackpads sturen ineens honderden pixels.
const ZOOM_STAP_MAX = 120;

// Lijnen zonder eigen kleur in de GTFS krijgen deze; hun bussen houden
// de standaard okerkleur, want een grijs busje leest niet als een bus.
const LIJN_STANDAARDKLEUR = '#8aa0b2';

// Kleur per scheepssoort: voor de stip ver uitgezoomd en in de popup.
// Elke soort een eigen, verzadigde tint, zodat je ook als stip ziet wat
// er vaart. Veerboten springen eruit — dat is wat je wilt zien.
export const SCHIP_KLEUREN = {
  passagier: '#1f7ae0',
  sneldienst: '#12b5c8',
  vracht: '#4f5fd0',
  tanker: '#c0442f',
  sleepboot: '#f07a1a',
  visser: '#2f9e5b',
  zeilboot: '#d9489a',
  plezier: '#e8b020',
  overig: '#8a99a8',
};

// Kleurkeuzes per scheepssoort. Welke combinatie een schip krijgt hangt
// vast aan zijn MMSI, dus hetzelfde schip houdt altijd dezelfde kleuren
// terwijl een vloot van tien vrachtschepen toch tien verschillende wordt.
const SCHIP_ROMPEN = {
  passagier: ['#ffffff'],
  sneldienst: ['#ffffff', '#f4f6f8'],
  vracht: ['#1f3a68', '#2b2f36', '#7a1f24', '#1d5e4a', '#0f4c81', '#5b2a6e'],
  tanker: ['#9b2d22', '#3a3f47', '#2b4a6b', '#7a2e3a', '#4a5a2a'],
  sleepboot: ['#e8641a', '#d32f2f', '#1e5aa8', '#f2b705', '#1f7a4a'],
  visser: ['#2e7d4f', '#1f5fa8', '#b3362c', '#2d3e50', '#e0a020'],
  zeilboot: ['#ffffff', '#ffffff', '#1d3557', '#f1ece0'],
  plezier: ['#ffffff', '#ffffff', '#f1ece0', '#1d3557'],
  overig: ['#6f8394', '#55708a', '#8a7a64'],
};
const SCHIP_ACCENTEN = ['#1f7ae0', '#d6322f', '#0a9a8a', '#f2a81d', '#7b4fd0', '#e0457b', '#2f9e5b'];
const CONTAINERKLEUREN = ['#d6322f', '#1f7ae0', '#f2a81d', '#2f9e5b', '#e8641a',
                          '#8a96a3', '#7b4fd0', '#0a9a8a', '#c9c2b4', '#a8322a'];
const ZEILKLEUREN = ['#ffffff', '#e94b3c', '#f2c12e', '#2f8fd0', '#7b4fd0', '#ff8a3d', '#1fae8c'];
// Lengte (px bij schaal 1) als AIS geen afmetingen meldt, en breedte als
// fractie van de lengte — een sleepboot is gedrongen, een sneldienst slank.
const SCHIP_STANDAARDLENGTE = {
  passagier: 28, sneldienst: 24, vracht: 30, tanker: 30, sleepboot: 18,
  visser: 20, zeilboot: 18, plezier: 16, overig: 20,
};
const SCHIP_BREEDTE = {
  passagier: 0.34, sneldienst: 0.3, vracht: 0.3, tanker: 0.3, sleepboot: 0.46,
  visser: 0.38, zeilboot: 0.34, plezier: 0.4, overig: 0.36,
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
    // Verschil tussen de klok van de server en die van deze browser. Nodig
    // om te weten hoe oud een peiling nú is; een browserklok die er een paar
    // minuten naast zit zou het doorrekenen anders alle kanten op sturen.
    this.klokVerschil = 0;
    this.lijnIndex = new Map(); // route_id|richting → lijnroute
    this.shapeIndex = new Map(); // shape_id → de vorm van één rit
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
    this._spoorIndex = null;   // rastercel → platte lijst spoorsegmenten
    this._spoorSig = '';       // welke tegels er in de index zitten
    this.stations = [];

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
        asfalt: '#565d69',         // wegdek onder de buslijnen
        asfaltRand: '#3f4650',
        spoor: '#9aa3ad',          // spoorbed
        spoorBiels: '#f2f5f8',     // dwarsstreepjes erover
        station: '#1a4a86',        // treinstation: rand en naam
        stationVul: '#ffffff',
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
        asfalt: '#2f3641',         // wegdek onder de buslijnen
        asfaltRand: '#1c222b',
        spoor: '#4a5464',          // spoorbed
        spoorBiels: '#161b24',     // dwarsstreepjes erover
        station: '#7fb4d6',        // treinstation: rand en naam
        stationVul: '#10151d',
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
    this.shapeIndex.clear();

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
      // Op shape_id vinden we de vorm van één specifieke rit; op route_id de
      // hoofdvorm van de lijn. Varianten dragen geen route_id en komen dus
      // alleen in de eerste index.
      // Twee lijnen kunnen dezelfde vorm delen; dan houden we de vorm die
      // een route_id draagt, zodat de bus bij zijn eigen lijn hoort.
      if (r.sid && (!this.shapeIndex.has(r.sid) || (r.rids || []).length)) {
        this.shapeIndex.set(r.sid, r);
      }
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
   * De lijnroute waar dit voertuig op rijdt. Het shape_id van zijn rit is de
   * beste bron: dat is precies de vorm die deze bus vandaag rijdt, inclusief
   * de spitsvariant of de korte rit. Kennen we die niet, dan de hoofdvorm van
   * de lijn. Alleen op route_id matchen en nooit op lijnnummer: op lijnnummer
   * zou lijn 1 uit Amsterdam aan lijn 1 uit Groningen worden gekoppeld, en dan
   * glijdt een bus honderd kilometer verderop.
   */
  routeVoor(v) {
    return (
      (v.sid && this.shapeIndex.get(v.sid)) ||
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
  setVehicles(vehicles, historie, serverTijd) {
    this.vehicles = vehicles || [];
    const center = this.center;
    if (!center) return;

    if (serverTijd) this.klokVerschil = serverTijd - Date.now() / 1000;

    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
    const naarWereld = (lat, lon) => [
      (lon - center.lon) * n * R * cosLat,
      -(lat - center.lat) * n * R,
    ];
    const nu = Date.now() / 1000;
    // De klok van de server, want de peilingstijdstempels horen daarbij
    const nuEcht = nu + this.klokVerschil;

    for (const v of this.vehicles) {
      if (v.lat === undefined || v.lon === undefined) continue;
      const [wx, wy] = naarWereld(v.lat, v.lon);
      v._wx = wx;
      v._wy = wy;
      v._route = this.routeVoor(v);

      const oud = this._buffer.get(v.id);
      const t = v.t || nu;

      // Positie langs de route (of gewoon x/y als we geen route kennen).
      // Zat deze bus al op zijn lijn vastgeklikt, dan mag de peiling verder
      // afwijken voordat we hem loslaten: één slechte meting hoort hem niet
      // van de weg te schoppen.
      const vast = oud && oud.d !== null && oud.d !== undefined;
      const d = v._route
        ? this.afstandLangs(v._route, wx, wy, oud?.d, vast ? ROUTE_LOS : ROUTE_SNAP)
        : null;

      let vorige = null;
      if (historie && historie[v.id] && !oud) {
        // Bij de eerste lading, of voor een bus die in een nieuw kaartgebied
        // opduikt: de voorlaatste peiling uit de database, zodat hij meteen
        // rijdt in plaats van een minuut stil te staan. Een bus die we al
        // volgen houdt zijn eigen vorige punt, anders begint hij opnieuw.
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
      if (oud && Math.abs(oud.x - wx) < 8 && Math.abs(oud.y - wy) < 8) {
        oud.stil = true;
        continue;
      }

      const entry = {
        x: wx, y: wy, t, d,
        vorige,
        start: nu,
        route: v._route,
        stil: false,
        vooruit: 0,
        // Wat er op het scherm stond blijft gelden over de peiling heen; zonder
        // dat zou elke nieuwe peiling de demping hieronder opnieuw beginnen.
        getoond: oud ? oud.getoond : undefined,
      };

      // Snelheid en richting langs de route
      if (vorige && vorige.t && t > vorige.t) {
        const dt = Math.max(t - vorige.t, 1);
        const afstand = (d !== null && vorige.d !== null && d >= vorige.d)
          ? d - vorige.d
          : Math.hypot(wx - vorige.x, wy - vorige.y);
        entry.snelheid = afstand / dt;
        entry.reistijd = dt;

        // Hoe ver is hij sinds deze peiling alweer gekomen? De bron publiceert
        // eens per minuut en de peiling is bij aankomst al tientallen seconden
        // oud; zonder deze voorsprong rijdt elke bus die vertraging nog eens
        // helemaal over. Het blijft een schatting, dus ruim begrensd, en alleen
        // vóóruit langs de eigen lijn — de rijrichting komt van de route.
        if (d !== null && vorige.d !== null && d >= vorige.d) {
          const ouderdom = Math.max(0, nuEcht - t);
          entry.vooruit = Math.min(entry.snelheid, VOORUIT_MAX_SNELHEID)
                        * Math.min(ouderdom, VOORUIT_MAX);
        }
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
    const schaal = Math.max(0.8, Math.min(2.4, 0.6 + z * 0.75));

    const stippen = z < STIP_ZOOM;
    const perKleur = new Map();

    for (const schip of this.schepen) {
      const pos = this.positieVanSchip(schip);
      const p = this.worldToScreen(pos.x, pos.y);
      if (p.x < -60 || p.x > this.vw + 60 || p.y < -60 || p.y > this.vh + 60) {
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
      const l = this.tekenSchip(ctx, p.x, p.y, schaal,
                                this.schermHoek(koersNaarWereld(schip.koers)), schip);
      if (this.hoveredSchip === schip) {
        ctx.strokeStyle = this.colors.text;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, l * 0.62, 0, TAU);
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

  /**
   * De vaste kleuren van één schip. Romp, accent, containers en zeil komen
   * uit een lijstje per soort; de MMSI bepaalt welke, zodat een schip zijn
   * kleuren houdt van peiling tot peiling.
   */
  schipStijl(schip) {
    if (schip._stijl && schip._stijl.bron === schip.soort) return schip._stijl;
    const soort = SCHIP_ROMPEN[schip.soort] ? schip.soort : 'overig';
    const seed = (Number(schip.mmsi) || Math.round(Math.abs(schip._wx || 0) * 7)) % 2000000000;
    const kies = (lijst, zout) =>
      lijst[Math.floor(hashPositie(seed, zout * 7919) * lijst.length) % lijst.length];

    const romp = kies(SCHIP_ROMPEN[soort], 1);
    const rompRgb = hexNaarRgb(romp);
    const helder = rompRgb[0] * 0.299 + rompRgb[1] * 0.587 + rompRgb[2] * 0.114;
    const accent = kies(SCHIP_ACCENTEN, 2);
    let accent2 = kies(SCHIP_ACCENTEN, 3);
    if (accent2 === accent) accent2 = SCHIP_ACCENTEN[(SCHIP_ACCENTEN.indexOf(accent) + 3) % SCHIP_ACCENTEN.length];

    const containers = [];
    for (let i = 0; i < 24; i++) containers.push(kies(CONTAINERKLEUREN, 10 + i));

    schip._stijl = {
      bron: schip.soort,
      soort,
      romp,
      // Een witte romp krijgt een rand in zijn accentkleur, een gekleurde
      // romp gewoon een donkerdere versie van zichzelf.
      rand: helder > 200
        ? rgbNaarString(schaalKleur(hexNaarRgb(accent), 0.75))
        : rgbNaarString(schaalKleur(rompRgb, 0.6)),
      dek: rgbNaarString(helder > 200
        ? [236, 240, 244]
        : mengKleur(schaalKleur(rompRgb, 0.78), [70, 76, 86], 0.35)),
      accent,
      accent2,
      containers,
      zeil: kies(ZEILKLEUREN, 4),
      fok: kies(ZEILKLEUREN, 5),
      tankDek: kies(['#5f7353', '#8a3b2e', '#6a7380', '#3f6b5a'], 6),
      zeilKant: hashPositie(seed, 99) < 0.5 ? -1 : 1,
    };
    return schip._stijl;
  }

  /**
   * Een schip van bovenaf, gedraaid in de vaarrichting. Elke soort heeft
   * een eigen silhouet en opbouw: containers op een vrachtschip, tankkoepels
   * op een tanker, een stuurhut met fenders op een sleepboot, een zeil op
   * een zeilboot. Vaart hij, dan trekt hij een kielzog achter zich aan.
   * Geeft de getekende lengte terug, voor de selectiering.
   */
  tekenSchip(ctx, x, y, schaal, hoek, schip) {
    const st = this.schipStijl(schip);
    const soort = st.soort;
    const lengte = schip.lengte;
    const basis = lengte
      ? (lengte > 150 ? 38 : lengte > 80 ? 32 : lengte > 40 ? 26 : lengte > 15 ? 21 : 18)
      : SCHIP_STANDAARDLENGTE[soort];
    const l = basis * schaal;
    const b = l * SCHIP_BREEDTE[soort];
    const h = l / 2, k = b / 2;
    const s = schaal;
    const donker = this.theme === 'dark';
    // 's Nachts branden de lichten achter de ramen
    const ruit = donker ? '#ffd27a' : '#1e3550';
    const wit = donker ? '#dfe5ec' : '#ffffff';

    ctx.save();
    ctx.translate(x, y);

    // Schaduw recht onder het schip, niet mee gedraaid met de koers
    ctx.fillStyle = this.colors.schaduw;
    ctx.beginPath();
    ctx.ellipse(0, 2 * s, h * 1.02, k * 1.15, hoek, 0, TAU);
    ctx.fill();

    ctx.rotate(hoek);

    // Kielzog: twee uitwaaierende golflijnen plus schuim achter de spiegel
    const kn = schip.snelheid || 0;
    if (kn > 0.8) {
      const lang = l * Math.min(0.9, 0.25 + kn / 25);
      const schuim = donker ? 'rgba(190,220,245,0.30)' : 'rgba(255,255,255,0.80)';
      ctx.strokeStyle = schuim;
      ctx.lineWidth = Math.max(0.8, 1.1 * s);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const z of [-1, 1]) {
        ctx.moveTo(h * 0.55, z * k * 0.7);
        ctx.quadraticCurveTo(-h * 0.2, z * k * 1.15, -h - lang, z * (k * 1.1 + lang * 0.2));
      }
      ctx.stroke();
      ctx.fillStyle = donker ? 'rgba(190,220,245,0.18)' : 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.ellipse(-h - lang * 0.3, 0, lang * 0.42, k * 0.7, 0, 0, TAU);
      ctx.fill();
      // Boeggolf
      ctx.fillStyle = schuim;
      ctx.beginPath();
      ctx.ellipse(h * 0.98, 0, 1.6 * s, k * 0.55, 0, 0, TAU);
      ctx.fill();
    }

    // Romp
    const vorm = soort === 'sleepboot' ? 'rond'
      : (soort === 'vracht' || soort === 'tanker') ? 'blok' : 'spits';
    rompPad(ctx, l, b, vorm);
    ctx.fillStyle = st.romp;
    ctx.fill();
    ctx.lineWidth = soort === 'sleepboot' ? Math.max(1.4, 1.9 * s) : Math.max(0.8, 0.8 * s);
    ctx.strokeStyle = soort === 'sleepboot' ? '#1b1d21' : st.rand;
    ctx.stroke();

    // Dek: een iets kleinere romp erbinnen
    const dek = (kleur, fx, fy) => {
      ctx.save();
      ctx.scale(fx, fy);
      rompPad(ctx, l, b, vorm);
      ctx.fillStyle = kleur;
      ctx.fill();
      ctx.restore();
    };
    // Stuurhut/brug met een rij ramen aan de voorkant
    const brug = (x0, x1, breedte, kleur = wit) => {
      ctx.fillStyle = kleur;
      afgerondeRechthoek(ctx, x0, -breedte / 2, x1 - x0, breedte, 1.2 * s);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = Math.max(0.5, 0.5 * s);
      ctx.stroke();
      ctx.fillStyle = ruit;
      afgerondeRechthoek(ctx, x1 - Math.max(1.1, 1.3 * s), -breedte * 0.42,
                         Math.max(0.9, 1 * s), breedte * 0.84, 0.5 * s);
      ctx.fill();
    };
    const schoorsteen = (cx, r) => {
      ctx.fillStyle = st.accent;
      ctx.beginPath();
      ctx.ellipse(cx, 0, r * 1.25, r, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#1b1d21';
      ctx.beginPath();
      ctx.ellipse(cx, 0, r * 0.55, r * 0.45, 0, 0, TAU);
      ctx.fill();
    };

    switch (soort) {
      case 'vracht': {
        dek('#4a4f57', 0.9, 0.78);
        // Containers in twee rijen, elk vak een eigen kleur
        const x0 = -h * 0.5, x1 = h * 0.7;
        const n = Math.max(3, Math.min(12, Math.round((x1 - x0) / (3.6 * s))));
        const vak = (x1 - x0) / n;
        const gat = Math.max(0.4, 0.45 * s);
        for (let i = 0; i < n; i++) {
          for (let r = 0; r < 2; r++) {
            ctx.fillStyle = st.containers[(i * 2 + r) % st.containers.length];
            const cy = r === 0 ? -k * 0.66 : gat / 2;
            ctx.fillRect(x0 + i * vak + gat / 2, cy, vak - gat, k * 0.66 - gat / 2);
          }
        }
        // Een lichte ribbel over elke rij containers geeft ze reliëf
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        for (let i = 0; i < n; i++) {
          ctx.fillRect(x0 + i * vak + gat / 2, -k * 0.66, vak - gat, Math.max(0.5, 0.45 * s));
        }
        brug(-h * 0.86, -h * 0.58, b * 0.86);
        schoorsteen(-h * 0.74, k * 0.22);
        break;
      }
      case 'tanker': {
        dek(st.tankDek, 0.9, 0.78);
        // Pijpleiding over het midden met een verdeelstuk halverwege
        ctx.strokeStyle = '#d8dde3';
        ctx.lineWidth = Math.max(0.7, 0.8 * s);
        ctx.beginPath();
        ctx.moveTo(-h * 0.5, 0);
        ctx.lineTo(h * 0.75, 0);
        ctx.moveTo(h * 0.1, -k * 0.6);
        ctx.lineTo(h * 0.1, k * 0.6);
        ctx.stroke();
        // Tankkoepels
        ctx.fillStyle = '#e6e9ed';
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = Math.max(0.5, 0.5 * s);
        for (const fx of [-0.32, -0.05, 0.3, 0.56]) {
          ctx.beginPath();
          ctx.arc(h * fx, 0, k * 0.32, 0, TAU);
          ctx.fill();
          ctx.stroke();
        }
        brug(-h * 0.86, -h * 0.58, b * 0.86);
        schoorsteen(-h * 0.74, k * 0.22);
        break;
      }
      case 'passagier': {
        // Gekleurde band langs de hele romp
        ctx.save();
        ctx.scale(0.92, 0.82);
        rompPad(ctx, l, b, vorm);
        ctx.strokeStyle = st.accent;
        ctx.lineWidth = Math.max(1, 1.5 * s);
        ctx.stroke();
        ctx.restore();
        // Opbouw met twee rijen ramen
        ctx.fillStyle = wit;
        afgerondeRechthoek(ctx, -h * 0.66, -k * 0.6, h * 1.2, k * 1.2, 2 * s);
        ctx.fill();
        ctx.fillStyle = ruit;
        const n = Math.max(4, Math.round(h * 1.1 / (2.4 * s)));
        const stap = h * 1.1 / n;
        for (let i = 0; i < n; i++) {
          const rx = -h * 0.6 + i * stap + stap * 0.2;
          ctx.fillRect(rx, -k * 0.5, stap * 0.6, k * 0.16);
          ctx.fillRect(rx, k * 0.34, stap * 0.6, k * 0.16);
        }
        // Bovendek in de tweede kleur, brug met ramen voorop
        ctx.fillStyle = st.accent2;
        afgerondeRechthoek(ctx, -h * 0.4, -k * 0.22, h * 0.6, k * 0.44, 1 * s);
        ctx.fill();
        ctx.fillStyle = ruit;
        afgerondeRechthoek(ctx, h * 0.42, -k * 0.5, Math.max(1.2, 1.5 * s), k, 0.6 * s);
        ctx.fill();
        schoorsteen(-h * 0.52, k * 0.2);
        break;
      }
      case 'sneldienst': {
        // Slanke romp met een schuine accentstreep
        ctx.fillStyle = st.accent;
        ctx.beginPath();
        ctx.moveTo(-h * 0.95, -k * 0.9);
        ctx.lineTo(-h * 0.6, -k * 0.9);
        ctx.lineTo(-h * 0.3, k * 0.9);
        ctx.lineTo(-h * 0.65, k * 0.9);
        ctx.closePath();
        ctx.fill();
        // Lange cabine met getint glas en een glimlicht
        ctx.fillStyle = donker ? '#5a4a2a' : '#22384f';
        afgerondeRechthoek(ctx, -h * 0.5, -k * 0.62, h * 1.05, k * 1.24, k * 0.5);
        ctx.fill();
        ctx.fillStyle = donker ? 'rgba(255,210,122,0.55)' : 'rgba(170,215,245,0.6)';
        afgerondeRechthoek(ctx, -h * 0.4, -k * 0.42, h * 0.85, k * 0.3, k * 0.15);
        ctx.fill();
        ctx.fillStyle = st.accent2;
        ctx.fillRect(-h * 0.15, -k * 0.12, h * 0.4, k * 0.24);
        break;
      }
      case 'sleepboot': {
        dek(st.dek, 0.84, 0.74);
        // Stuurhut voorop, met ramen rondom en een gele zwaailamp
        ctx.fillStyle = wit;
        afgerondeRechthoek(ctx, -h * 0.05, -k * 0.55, h * 0.55, k * 1.1, 1.6 * s);
        ctx.fill();
        ctx.strokeStyle = ruit;
        ctx.lineWidth = Math.max(0.8, 1 * s);
        afgerondeRechthoek(ctx, h * 0.03, -k * 0.42, h * 0.39, k * 0.84, 1 * s);
        ctx.stroke();
        ctx.fillStyle = '#ffcc33';
        ctx.beginPath();
        ctx.arc(h * 0.22, 0, Math.max(0.8, 1 * s), 0, TAU);
        ctx.fill();
        // Sleephaak en bolder achterop
        ctx.fillStyle = '#1b1d21';
        ctx.beginPath();
        ctx.arc(-h * 0.55, 0, Math.max(0.9, 1.1 * s), 0, TAU);
        ctx.fill();
        break;
      }
      case 'visser': {
        dek('#b98a56', 0.86, 0.74);
        // Gieken met netten aan weerszijden
        ctx.strokeStyle = donker ? '#9aa5b2' : '#3a3f47';
        ctx.lineWidth = Math.max(0.6, 0.7 * s);
        ctx.beginPath();
        ctx.moveTo(-h * 0.05, -k * 0.6);
        ctx.lineTo(-h * 0.35, -k * 2.1);
        ctx.moveTo(-h * 0.05, k * 0.6);
        ctx.lineTo(-h * 0.35, k * 2.1);
        ctx.stroke();
        ctx.fillStyle = st.accent2;
        for (const z of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(-h * 0.35, z * k * 2.1, Math.max(0.8, 1 * s), 0, TAU);
          ctx.fill();
        }
        brug(h * 0.12, h * 0.48, b * 0.66);
        // Oranje boeien en een viskist achterop
        ctx.fillStyle = '#ff7a1a';
        for (const [fx, fy] of [[-0.62, -0.3], [-0.72, 0.25], [-0.5, 0.35]]) {
          ctx.beginPath();
          ctx.arc(h * fx, k * fy, Math.max(0.7, 0.85 * s), 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = '#3b8fd0';
        ctx.fillRect(-h * 0.35, -k * 0.3, h * 0.22, k * 0.6);
        break;
      }
      case 'zeilboot': {
        dek('#c89a62', 0.84, 0.72);
        // Kuip achterin
        ctx.fillStyle = donker ? '#3a2e22' : '#8a6a44';
        afgerondeRechthoek(ctx, -h * 0.72, -k * 0.4, h * 0.42, k * 0.8, 1 * s);
        ctx.fill();
        // Grootzeil: van de mast naar het eind van de giek, bol in de wind
        const mx = h * 0.18;
        const gx = -h * 0.7, gy = st.zeilKant * k * 1.25;
        ctx.fillStyle = st.zeil;
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = Math.max(0.5, 0.5 * s);
        ctx.beginPath();
        ctx.moveTo(mx, 0);
        ctx.quadraticCurveTo((mx + gx) / 2 + 0, gy * 1.4, gx, gy);
        ctx.lineTo(mx, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Fok voor de mast
        ctx.fillStyle = st.fok === st.zeil ? wit : st.fok;
        ctx.beginPath();
        ctx.moveTo(h * 0.95, 0);
        ctx.quadraticCurveTo(h * 0.6, st.zeilKant * k * 1.1, mx - h * 0.05, st.zeilKant * k * 0.75);
        ctx.lineTo(mx, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Giek en mast
        ctx.strokeStyle = '#2b3038';
        ctx.lineWidth = Math.max(0.6, 0.7 * s);
        ctx.beginPath();
        ctx.moveTo(mx, 0);
        ctx.lineTo(gx, gy);
        ctx.stroke();
        ctx.fillStyle = '#2b3038';
        ctx.beginPath();
        ctx.arc(mx, 0, Math.max(0.8, 0.9 * s), 0, TAU);
        ctx.fill();
        break;
      }
      case 'plezier': {
        // Accentstreep langs de romp
        ctx.save();
        ctx.scale(0.9, 0.8);
        rompPad(ctx, l, b, vorm);
        ctx.strokeStyle = st.accent;
        ctx.lineWidth = Math.max(0.9, 1.2 * s);
        ctx.stroke();
        ctx.restore();
        dek(donker ? '#c9c2b4' : '#f1ece0', 0.78, 0.64);
        // Voorruit in een boog, kussens in de kuip, buitenboordmotor
        ctx.strokeStyle = ruit;
        ctx.lineWidth = Math.max(1, 1.3 * s);
        ctx.beginPath();
        ctx.ellipse(h * 0.15, 0, h * 0.22, k * 0.62, 0, -Math.PI * 0.42, Math.PI * 0.42);
        ctx.stroke();
        ctx.fillStyle = st.accent2;
        afgerondeRechthoek(ctx, -h * 0.6, -k * 0.45, h * 0.5, k * 0.9, 1 * s);
        ctx.fill();
        ctx.fillStyle = '#1b1d21';
        afgerondeRechthoek(ctx, -h - 1.6 * s, -k * 0.22, 2 * s, k * 0.44, 0.6 * s);
        ctx.fill();
        break;
      }
      default: {
        dek(st.dek, 0.86, 0.74);
        // Gele band over de boeg en een witte kajuit met ramen
        ctx.fillStyle = '#f2c12e';
        ctx.fillRect(h * 0.45, -k * 0.55, Math.max(1, 1.2 * s), k * 1.1);
        brug(-h * 0.55, h * 0.1, b * 0.6);
        ctx.fillStyle = ruit;
        ctx.fillRect(-h * 0.45, -b * 0.3 + 0.6 * s, h * 0.45, Math.max(0.6, 0.6 * s));
        ctx.fillRect(-h * 0.45, b * 0.3 - 1.2 * s, h * 0.45, Math.max(0.6, 0.6 * s));
      }
    }

    // Navigatielichten: rood aan bakboord, groen aan stuurboord
    if (l > 16) {
      const r = Math.max(0.7, 0.75 * s);
      ctx.fillStyle = '#e53935';
      ctx.beginPath();
      ctx.arc(h * 0.55, -k * 0.92, r, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2ecc71';
      ctx.beginPath();
      ctx.arc(h * 0.55, k * 0.92, r, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
    return l;
  }

  /**
   * Treinposities uit de NS Virtual Train API. Kent de backend de rit van
   * een trein (route, richting en vorm uit de dienstregeling), dan rijdt
   * hij langs die route: zijn positie wordt een afstand langs de lijn, en
   * een TreinVolger laat hem daar met zijn gemelde snelheid overheen rijden
   * terwijl de grillige peilingen hem alleen bijsturen. Zonder route valt
   * hij terug op het spoor onder zijn peiling (_treinOpSpoor).
   */
  setTreinen(treinen, pollTijd) {
    const center = this.center;
    if (!center) return;
    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
    if (!this._treinBuffer) this._treinBuffer = new Map();
    // Eén klok voor alles: de backend stempelt zijn poll met
    // laatste_ophaal en geeft die mee als pollTijd. De latentie tussen
    // poll en aankomst meten we zelf. Daarmee rekent de frontend
    // peilingstijdstempels om naar de browserklok, en glijt de trein
    // soepel door in plaats van te springen.
    if (pollTijd) {
      const latentie = (this._treinPollLatentie ||
        (this._treinPollLatentie = Math.max(0, Date.now() / 1000 - pollTijd)));
      this._treinKlokVerschil = pollTijd + latentie - Date.now() / 1000;
    }
    const nu = Date.now() / 1000 + (this._treinKlokVerschil || 0);
    this._zorgSpoorIndex();

    this.treinen = (treinen || []).map(t => {
      const key = String(t.nummer);
      const oud = this._treinBuffer.get(key);
      // Hetzelfde object houden over peilingen heen: de popup en de
      // markering hangen eraan, en de volger erin onthoudt waar hij was.
      const trein = oud ? Object.assign(oud, t) : { ...t };
      trein._wx = (t.lon - center.lon) * n * R * cosLat;
      trein._wy = -(t.lat - center.lat) * n * R;
      this._treinBuffer.set(key, trein);

      // Een nieuwe peiling, of dezelfde als vorige poll?
      const nieuw = trein.t !== trein._peilT;
      trein._peilT = trein.t;

      let route = this._treinRoute(trein, nu);
      if (route) {
        let volger = trein._volger;
        let opRoute = !!volger && volger.route === route;
        // Rijdt hij, dan helpt zijn koers kiezen tussen de heen- en de
        // teruggaande poot waar de route kopmaakt; stilstaand zegt de
        // koers weinig.
        const koersW = trein.koers != null && trein.snelheid > 5
          ? koersNaarWereld(trein.koers) : null;
        // Zit hij al op deze route, dan zoeken we in de buurt van zijn
        // vorige plek en mag de peiling verder afwijken voor we loslaten.
        let d = this.afstandLangs(route, trein._wx, trein._wy,
                                  opRoute ? volger.peiling.d : null,
                                  opRoute ? ROUTE_LOS : SPOOR_SNAP, koersW);

        // Rijdt hij wel de kant op die de route zegt? Het bewijs is de
        // verplaatsing van peiling tot peiling lángs de route: vooruit telt
        // op, achteruit telt af. Bij zijn eerste peiling op een route is
        // de gemelde koers de beste gok.
        const rijdt = trein.snelheid > 5;
        if (d !== null && nieuw && rijdt && opRoute &&
            trein._vorigeRoute === route && trein._vorigeD != null) {
          const stap = d - trein._vorigeD;
          if (stap < -TREIN_STAP) trein._bewijs = Math.max(-3, (trein._bewijs || 0) - 1);
          else if (stap > TREIN_STAP) trein._bewijs = Math.min(3, (trein._bewijs || 0) + 1);
        }
        if (d !== null && !opRoute && koersW !== null && trein.snelheid > 20 &&
            Math.cos(this.puntOpRoute(route, d).hoek - koersW) <= -0.5) {
          trein._bewijs = -2;
        }
        if (d !== null && (trein._bewijs || 0) <= -2) {
          // Tegen de route in: de andere richting van zijn lijn, als die er
          // is en hij erop ligt. Anders even geen route.
          trein._bewijs = 0;
          const ander = this._andereRichting(trein, route);
          const dA = ander ? this.afstandLangs(ander, trein._wx, trein._wy, null, SPOOR_SNAP, koersW) : null;
          if (dA !== null) {
            trein._andersom = !trein._andersom;
            route = ander;
            d = dA;
            volger = null;
            opRoute = false;
          } else {
            trein._geenRouteTot = nu + TREIN_ROUTE_RUST;
            d = null;
          }
        }

        if (d !== null) {
          if (nieuw || trein._vorigeRoute !== route) {
            trein._vorigeD = d;
            trein._vorigeRoute = route;
          }
          const v = (t.snelheid || 0) / 3.6;
          const tPeil = t.t || nu;
          // De onzekerheidsstraal telt alleen voor echte GPS-peilingen
          // (OBIS); een KV6-positie komt uit de dienstregeling en draagt
          // altijd dezelfde, grote waarde.
          const nauw = t.bron === 'KV6' ? null : (t.nauw ?? null);
          if (opRoute) {
            volger.peil(d, tPeil, v, nauw);
          } else {
            const nieuweVolger = new TreinVolger(d, tPeil, v, this._halteAfstanden(route), nauw);
            nieuweVolger.route = route;
            // Stond hij al ergens op het scherm (zonder route, of op een
            // andere vorm)? Dan vandaar verder glijden in plaats van
            // springen, mits dat niet te ver van de peiling is.
            if (trein.beeld) {
              const dBeeld = this.afstandLangs(route, trein.beeld.x, trein.beeld.y, d, SPOOR_SNAP, koersW);
              if (dBeeld !== null && Math.abs(dBeeld - d) < TREIN_SPRONG) {
                nieuweVolger.beeld = { d: dBeeld, t: nu };
              }
            }
            trein._volger = nieuweVolger;
          }
          trein.anker = null;
          trein.glijd = null;
          return trein;
        }
      }

      // Geen route (of te ver ervan af): het spoor onder de peiling
      trein._volger = null;
      trein._vorigeRoute = null;
      trein._vorigeD = null;
      this._treinOpSpoor(trein, nu, nieuw);
      return trein;
    });

    // Buffers van verdwenen treinen opruimen
    if (this._treinBuffer.size > this.treinen.length * 2) {
      const levend = new Set(this.treinen.map(x => String(x.nummer)));
      for (const k of this._treinBuffer.keys()) {
        if (!levend.has(k)) this._treinBuffer.delete(k);
      }
    }
  }

  /** De routevorm van deze trein: die van zijn eigen rit, anders de
   *  hoofdvorm van zijn lijn en richting. Zonder lijnenbundel: niets.
   *  Bleek hij tegen zijn route in te rijden, dan de andere richting; en
   *  paste die ook niet, dan even geen route. */
  _treinRoute(trein, nu) {
    if (!trein.sid && !trein.rid) return null;
    if (trein._geenRouteTot && nu < trein._geenRouteTot) return null;
    const route = this.routeVoor(trein);
    if (route && trein._andersom) {
      const ander = this._andereRichting(trein, route);
      if (ander) return ander;
    }
    return route;
  }

  /** De hoofdvorm van de andere richting van zijn lijn — of, zit hij daar
   *  al op, de vorm van zijn eigen rit terug. */
  _andereRichting(trein, route) {
    const primair = this.routeVoor(trein);
    const ander = trein.rid
      ? this.lijnIndex.get(`${trein.rid}|${1 - (trein.richting || 0)}`) : null;
    const kandidaat = route === primair ? ander : primair;
    return kandidaat && kandidaat !== route ? kandidaat : null;
  }

  /** Haltes van een route als oplopende afstanden; één keer berekend. */
  _halteAfstanden(route) {
    if (!route._halteD) {
      route._halteD = (route.haltes || []).map(h => h.d).sort((a, b) => a - b);
    }
    return route._halteD;
  }

  /**
   * Een trein zonder bekende route: elke peiling wordt een anker óp het
   * spoor — gekozen op afstand én rijrichting, met hoofdsporen boven
   * perronstroken — en de trein glijdt van zijn huidige beeldpositie naar
   * dat anker. GPS-geruis (een anker enkele meters van het vorige) levert
   * geen beweging op.
   */
  _treinOpSpoor(trein, nu, nieuw) {
    const wx = trein._wx, wy = trein._wy;
    const koersRad = koersNaarWereld(trein.koers);
    const op = this.spoorPunt(wx, wy, SPOOR_SNAP,
                              trein.koers != null ? koersRad : null);
    if (!op) {
      // Geen spoor binnen bereik (buiten de tegels, of buitenland):
      // rauw punt houden; de weergave rekent daar doodleijk mee door.
      if (nieuw) trein._gezien = nu;
      trein.anker = null;
      trein.glijd = null;
      return;
    }

    const anker = { x: op.x, y: op.y, t: trein.t || nu };
    const vorig = trein.anker;
    // GPS-geruis van een stilstaand treinstel dempen: paar meter heen
    // en weer op hetzelfde spoor is ruis; hij blijft dan op zijn anker
    // staan in plaats van te huppelen.
    if (vorig && !(trein.snelheid > 5) &&
        Math.hypot(anker.x - vorig.x, anker.y - vorig.y) < TREIN_GLIJD) {
      anker.x = vorig.x;
      anker.y = vorig.y;
    }
    // Geen nieuwere peiling dan we al hadden: het lopende traject intact
    // laten, anders herbegint de trein bij elke poll vanaf zijn oude plek.
    if (vorig && vorig.t >= anker.t) return;

    // Glij-traject: vanaf de laatst getoonde plek naar het nieuwe anker,
    // met de gemelde snelheid als tempo. Duurt het langer dan een halve
    // minuut, dan knipt de clamp het af; is de sprong groter dan een trein
    // ooit in één keer doet (nieuwe rit, hiaat in de feed), dan zetten we
    // hem meteen over.
    const van = trein.beeld ? { x: trein.beeld.x, y: trein.beeld.y }
                            : { x: anker.x, y: anker.y };
    const gap = Math.hypot(anker.x - van.x, anker.y - van.y);
    let duur;
    if (gap > 2500) {
      van.x = anker.x;
      van.y = anker.y;
      duur = 1;
    } else {
      const tempo = Math.max(2, (trein.snelheid || 0) / 3.6);   // ≥ 7,2 km/u
      duur = Math.max(1, Math.min(30, gap / tempo));
    }
    trein._wx = anker.x;
    trein._wy = anker.y;
    trein.anker = anker;
    trein.glijd = { van, start: nu, duur };
    trein._gezien = nu;
  }

  /**
   * Rasterindex van alle spoorsegmenten die nu in beeld zijn, zodat we per
   * trein niet door alle rails hoeven te lopen. Wordt alleen herbouwd als
   * er andere tegels in beeld staan.
   */
  _zorgSpoorIndex() {
    const tegels = this._zichtbareTegels;
    if (!tegels || !tegels.length) {
      this._spoorIndex = null;
      this._spoorSig = '';
      return;
    }
    let sig = '';
    for (const t of tegels) sig += t.niveau + '/' + t.tx + ',' + t.ty + ';';
    if (sig === this._spoorSig) return;
    this._spoorSig = sig;

    const raster = new Map();
    let elId = 0;
    for (const t of tegels) {
      for (const el of t.rails || []) {
        const p = el.pts;
        elId++;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const x1 = p[i], y1 = p[i + 1], x2 = p[i + 2], y2 = p[i + 3];
          // In elke cel zetten die het segment raakt, anders mist een
          // lang segment de cel waar de trein toevallig in zit. De vijfde
          // waarde is de bijspoor-vlag (0 = hoofdspoor, 1 = perron/wissel),
          // de zesde welk spoorstuk het is — zodat een trein op dubbelspoor
          // op zijn eigen spoor kan blijven.
          const bijspoor = el.waarde ? 1 : 0;
          const cx0 = Math.floor(Math.min(x1, x2) / SPOOR_CEL);
          const cx1 = Math.floor(Math.max(x1, x2) / SPOOR_CEL);
          const cy0 = Math.floor(Math.min(y1, y2) / SPOOR_CEL);
          const cy1 = Math.floor(Math.max(y1, y2) / SPOOR_CEL);
          for (let cx = cx0; cx <= cx1; cx++) {
            for (let cy = cy0; cy <= cy1; cy++) {
              const sleutel = cx + ',' + cy;
              let lijst = raster.get(sleutel);
              if (!lijst) raster.set(sleutel, lijst = []);
              lijst.push(x1, y1, x2, y2, bijspoor, elId);
            }
          }
        }
      }
    }
    this._spoorIndex = raster;
  }

  /**
   * Het dichtstbijzijnde punt op een spoor, of null als er geen in de
   * buurt ligt. Met een voorkeurshoek (wereld-radians) wegen we sporen
   * mee in de rijrichting zwaarder dan dwarsliggers, en blijft bij een
   * gelijke afstand het hoofdspoor winnen van een perronstrook. Met een
   * voorkeursspoor (het stuk waar de trein al op zat) wint dat tot een
   * ander spoor duidelijk dichterbij ligt — dubbelspoor ligt vierenhalve
   * meter uit elkaar, en daar wil je niet elke seconde tussen wippen.
   */
  spoorPunt(x, y, maxAfstand, voorkeur = null, voorkeurEl = -1) {
    const raster = this._spoorIndex;
    if (!raster) return null;
    const cx = Math.floor(x / SPOOR_CEL), cy = Math.floor(y / SPOOR_CEL);
    const grens = maxAfstand * maxAfstand;
    let besteS = Infinity;
    let bx = 0, by = 0, bhoek = 0, bel = -1, gevonden = false;

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const lijst = raster.get((cx + ox) + ',' + (cy + oy));
        if (!lijst) continue;
        for (let i = 0; i < lijst.length; i += 6) {
          const x1 = lijst[i], y1 = lijst[i + 1];
          const dx = lijst[i + 2] - x1, dy = lijst[i + 3] - y1;
          const len2 = dx * dx + dy * dy;
          if (!len2) continue;
          let t = ((x - x1) * dx + (y - y1) * dy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = x1 + t * dx, py = y1 + t * dy;
          const d = (x - px) * (x - px) + (y - py) * (y - py);
          if (d > grens) continue;
          // Score: afstand, maar een spoor in (tegen) rijrichting weegt
          // lichter, een bijspoor bij gelijke nabijheid zwaarder, en het
          // spoor waar hij al op zat een stuk lichter.
          let score = d;
          if (voorkeur !== null && voorkeur !== undefined) {
            const cosD = Math.abs(Math.cos(Math.atan2(dy, dx) - voorkeur));
            score *= 1.15 - 0.35 * cosD;
          }
          if (lijst[i + 4]) score *= 1.3;
          if (lijst[i + 5] === voorkeurEl) score *= 0.2;
          if (score < besteS) {
            besteS = score;
            bx = px; by = py;
            bhoek = Math.atan2(dy, dx);
            bel = lijst[i + 5];
            gevonden = true;
          }
        }
      }
    }
    return gevonden ? { x: bx, y: by, hoek: bhoek, el: bel } : null;
  }

  /**
   * Waar rijdt deze trein nu? Met een route: waar de volger hem op dit
   * moment langs de lijn zet, het laatste stukje bijgeschoven op het spoor
   * in de tegels. Zonder route: op het spoor tussen zijn vorige
   * beeldpositie en het nieuwe anker, met de klok mee van de peilingen
   * zelf. Is het anker ouder dan de doorrekengrens, dan staat hij stil.
   */
  positieVanTrein(trein) {
    // Zelfde klok als waarop de peilingen zijn gestempeld (zie setTreinen).
    const nu = Date.now() / 1000 + (this._treinKlokVerschil || 0);

    const volger = trein._volger;
    if (volger) {
      const p = this.puntOpRoute(volger.route, volger.positie(nu));
      return this._opHetSpoor(trein, p.x, p.y, p.hoek, nu);
    }

    const anker = trein.anker, glijd = trein.glijd;

    if (anker && glijd) {
      // Lineair van de oude beeldpositie naar het nieuwe anker, binnen
      // de trajectduur. Voorbij de duur: stil op het anker — geen
      // doodleijke uitbreiding die daarna weer terugveert.
      const t = Math.max(0, Math.min(1, (nu - glijd.start) / glijd.duur));
      const x = glijd.van.x + (anker.x - glijd.van.x) * t;
      const y = glijd.van.y + (anker.y - glijd.van.y) * t;
      const afstand = Math.hypot(anker.x - glijd.van.x, anker.y - glijd.van.y);
      let hoek;
      if (afstand >= 1) {
        // Richting van het pad; die volgt al de rails, want beide
        // uiteinden liggen op het spoor. Wijkt de gemelde koers haaks of
        // tegengesteld af (wissel of sprong tussen sporen), dan wint die.
        hoek = Math.atan2(anker.y - glijd.van.y, anker.x - glijd.van.x);
        const gemeld = koersNaarWereld(trein.koers);
        if (gemeld !== null && gemeld !== undefined &&
            Math.abs(Math.sin(hoek - gemeld)) > 0.87) hoek = gemeld;
      } else {
        // Stilstaand: richting van het spoor onder de trein, geen knik
        // uit rekengeruis.
        const op = this.spoorPunt(anker.x, anker.y, SPOOR_SNAP,
                                  trein.koers != null ? koersNaarWereld(trein.koers) : null);
        hoek = op ? op.hoek : koersNaarWereld(trein.koers);
      }
      return { x, y, hoek };
    }

    if (anker) {
      // Eerste peiling: staan op het anker, met de richting van het spoor
      // onder de trein.
      const op = this.spoorPunt(anker.x, anker.y, SPOOR_SNAP,
                                trein.koers != null ? koersNaarWereld(trein.koers) : null);
      return { x: anker.x, y: anker.y, hoek: op ? op.hoek : koersNaarWereld(trein.koers) };
    }

    // Geen spoor gevonden voor deze melding: doodleijk doorrekenen vanaf
    // het rauwe punt, hooguit enkele seconden.
    let x = trein._wx, y = trein._wy;
    const hoek = koersNaarWereld(trein.koers);
    if (trein.snelheid && hoek !== null && hoek !== undefined) {
      const verstreken = Math.min(TREIN_DOORREKENEN, nu - (trein._gezien || nu));
      const afstand = (trein.snelheid / 3.6) * verstreken;
      x += Math.sin(trein.koers * Math.PI / 180) * afstand;
      y -= Math.cos(trein.koers * Math.PI / 180) * afstand;
    }
    return { x, y, hoek };
  }

  /**
   * Het laatste stukje: van de routevorm naar het spoor dat eronder ligt in
   * de tegels, als dat binnen een paar meter is. De verschuiving glijdt
   * zacht naar zijn nieuwe waarde, zodat een trein die van spoor wisselt in
   * een halve seconde overschuift in plaats van te wippen; het spoor waar
   * hij al op zat heeft de voorkeur. De richting komt van de rails zelf,
   * gedraaid naar de rijrichting van de route — een OSM-spoorstuk loopt
   * willekeurig heen of terug.
   */
  _opHetSpoor(trein, x, y, hoek, nu) {
    // Ver uitgezoomd is twaalf meter minder dan een beeldpunt
    if (this.cam.zoom < STIP_ZOOM) return { x, y, hoek };
    const sig = this._spoorSig;
    const vorigEl = trein._spoor && trein._spoor.sig === sig ? trein._spoor.el : -1;
    const op = this.spoorPunt(x, y, SPOOR_BIJSCHUIF, hoek, vorigEl);
    let dx = 0, dy = 0, h = hoek;
    if (op) {
      dx = op.x - x;
      dy = op.y - y;
      trein._spoor = { el: op.el, sig };
      h = op.hoek;
      if (Math.cos(h - hoek) < 0) h += Math.PI;
    } else {
      trein._spoor = null;
    }
    const s = trein._schuif || (trein._schuif = { dx, dy, t: nu });
    const dt = Math.min(2, Math.max(0, nu - s.t));
    const k = 1 - Math.exp(-dt / 0.4);
    s.dx += (dx - s.dx) * k;
    s.dy += (dy - s.dy) * k;
    s.t = nu;
    return { x: x + s.dx, y: y + s.dy, hoek: h };
  }

  tekenTreinen(ctx) {
    if (!this.treinen?.length) return;
    const z = this.cam.zoom;
    // Net als bij de bussen: zodra de tegels echte gebouwen tonen blijft het
    // een volwaardig treinstel. Treinen mogen daarbij wat royaler uitvallen
    // dan een busje — ze zijn in het echt ook een stuk groter, en er rijden
    // er veel minder, dus ze mogen opvallen.
    const metGebouwen = this.tegelStand?.niveau >= 3;
    const schaal = metGebouwen
      ? Math.max(1.6, Math.min(2.3, 0.6 + z * 0.6))
      : Math.max(1.0, Math.min(2.3, 0.6 + z * 0.6));

    const stippen = z < STIP_ZOOM && !metGebouwen;
    const perKleur = new Map();
    // De klok van de peilingen, want daar vergelijken we hun leeftijd mee
    const nu = Date.now() / 1000 + (this._treinKlokVerschil || 0);
    this._zorgSpoorIndex();

    for (const trein of this.treinen) {
      const pos = this.positieVanTrein(trein);
      // De getoonde plek is het startpunt van het volgende tráject: zo
      // glijdt de trein naar zijn volgende anker in plaats van te springen.
      trein.beeld = { x: pos.x, y: pos.y, hoek: pos.hoek };
      const p = this.worldToScreen(pos.x, pos.y);
      if (p.x < -60 || p.x > this.vw + 60 || p.y < -60 || p.y > this.vh + 60) {
        trein._sx = undefined;
        continue;
      }
      trein._sx = p.x;
      trein._sy = p.y;
      const kleur = TREIN_KLEUREN[trein.soort] || TREIN_KLEUREN.trein;
      const hoek = this.schermHoek(pos.hoek);

      if (stippen) {
        const lijst = perKleur.get(kleur);
        if (lijst) lijst.push({ p, hoek });
        else perKleur.set(kleur, [{ p, hoek }]);
        continue;
      }
      // Een intercity is langer dan een sprinter
      const bakken = trein.soort === 'intercity' ? 3 : 2;
      // Hoe ouder de melding, hoe flauwer: een trein blijft staan waar hij
      // het laatst gezien is, maar doet niet alsof dat nog live is. Net zo
      // als de NS zelf niet meer weet waar hij is (onzekerheidsstraal).
      const alpha = this.treinAlpha(trein, nu);
      const vaag = alpha < 1;
      if (vaag) {
        ctx.save();
        ctx.globalAlpha = alpha;
      }
      // De veeg hoort bij de snelheid waarmee hij op het scherm rijdt: een
      // trein die staat te wachten op een nieuwe peiling krijgt er geen.
      const kmu = trein._volger ? trein._volger.snelheid * 3.6 : trein.snelheid;
      if (!vaag) this.tekenSliert(ctx, p.x, p.y, hoek, kmu, schaal, kleur);
      this.tekenTrein(ctx, p.x, p.y, schaal, hoek,
                      this.hoveredTrein === trein, kleur, bakken, trein);
      if (vaag) ctx.restore();
    }

    // Ver uitgezoomd: een streepje in de rijrichting in plaats van een stip.
    // Dat leest als een trein op een spoor, en is van ver een stuk beter te
    // zien dan een rond puntje van twee beeldpunten.
    if (perKleur.size) {
      const nabij = Math.min(1, z / STIP_ZOOM + 0.45);
      const lengte = Math.max(6, 11 * nabij);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2.4, 3.6 * nabij);
      for (const [kleur, items] of perKleur) {
        ctx.strokeStyle = kleur;
        ctx.beginPath();
        for (const { p, hoek } of items) {
          const dx = Math.cos(hoek) * lengte * 0.5;
          const dy = Math.sin(hoek) * lengte * 0.5;
          ctx.moveTo(p.x - dx, p.y - dy);
          ctx.lineTo(p.x + dx, p.y + dy);
        }
        ctx.stroke();
      }
    }
  }

  /**
   * Hoe helder een trein getekend wordt: vol zolang hij vers in de feed
   * zit en de NS hem scherp heeft; flauwer naarmate de laatste melding
   * ouder is of de onzekerheidsstraal groter. Nooit helemaal weg — je wilt
   * blijven zien waar hij het laatst was.
   */
  treinAlpha(trein, nu) {
    let alpha = 1;
    const leeftijd = nu - (trein.gezien ?? trein.t);
    if (leeftijd > TREIN_VERS) {
      const deel = Math.min(1, (leeftijd - TREIN_VERS) / (TREIN_OUD - TREIN_VERS));
      alpha = 1 - deel * (1 - TREIN_MIN_ALPHA);
    }
    if (trein.bron !== 'KV6' && trein.nauw > TREIN_ONZEKER) {
      const deel = Math.min(1, (trein.nauw - TREIN_ONZEKER) / (TREIN_ONZEKER_MAX - TREIN_ONZEKER));
      alpha = Math.min(alpha, 1 - deel * (1 - TREIN_MIN_ALPHA));
    }
    return alpha;
  }

  /**
   * Een sliert achter een voertuig dat hard gaat. Een trein van 140 km/u
   * ziet er op een stilstaand plaatje net zo uit als eentje die op het
   * perron wacht; deze veeg maakt het verschil meteen zichtbaar. Hij
   * groeit met de snelheid en vervaagt naar achteren.
   */
  tekenSliert(ctx, x, y, hoek, kmu, schaal, kleur) {
    if (!kmu || kmu < SLIERT_VANAF) return;
    const kracht = Math.min(1, (kmu - SLIERT_VANAF) / 100);
    const lengte = (14 + 46 * kracht) * schaal;
    const dx = Math.cos(hoek), dy = Math.sin(hoek);

    const veeg = ctx.createLinearGradient(x, y, x - dx * lengte, y - dy * lengte);
    veeg.addColorStop(0, kleurMetAlpha(kleur, Math.round((0.42 * kracht + 0.16) * 50) / 50));
    veeg.addColorStop(1, kleurMetAlpha(kleur, 0));

    ctx.save();
    ctx.strokeStyle = veeg;
    ctx.lineCap = 'round';
    ctx.lineWidth = 5.5 * schaal;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - dx * lengte, y - dy * lengte);
    ctx.stroke();
    ctx.restore();
  }

  setLineFilter(lines) {
    this.filteredLines = new Set(lines);
    this._bgVies = true;
  }

  zichtbaar(lijn) {
    return this.filteredLines.size === 0 || this.filteredLines.has(lijn);
  }

  // === Route-wiskunde ===

  /**
   * Afstand langs de route van het punt dat het dichtst bij (x,y) ligt.
   * `maxAfstand` is hoe ver de peiling van de route mag liggen voordat we
   * hem niet meer bij deze lijn vinden horen. Met een `koers` (wereldhoek)
   * wint een stuk route in de rijrichting van een even dichtbij liggend
   * stuk dat de andere kant op loopt.
   */
  afstandLangs(route, x, y, hint, maxAfstand = ROUTE_SNAP, koers = null) {
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

    const metKoers = koers !== null && koers !== undefined;
    let besteD = 0, besteAfstand = Infinity, besteScore = Infinity;
    for (let i = van; i < tot; i++) {
      const ax = pts[i][0], ay = pts[i][1];
      const dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const px = ax + t * dx, py = ay + t * dy;
      const afstand = Math.hypot(x - px, y - py);
      let score = afstand;
      if (metKoers && len2 > 0) {
        score += RICHTING_STRAF * (1 - Math.cos(Math.atan2(dy, dx) - koers)) / 2;
      }
      if (score < besteScore) {
        besteScore = score;
        besteAfstand = afstand;
        besteD = cum[i] + t * Math.sqrt(len2);
      }
    }

    // Te ver van de route af (omleiding, verkeerde shape): dan liever
    // in rechte lijn bewegen dan een bus 500 meter verkeerd neerzetten.
    if (besteAfstand > maxAfstand) {
      if (hint !== null && hint !== undefined) {
        return this.afstandLangs(route, x, y, null, maxAfstand, koers);
      }
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
    if (!buf) {
      if (v._route) {
        const d = this.afstandLangs(v._route, v._wx, v._wy, null);
        if (d !== null) {
          const p = this.puntOpRoute(v._route, d);
          return { x: p.x, y: p.y, hoek: p.hoek, d, voortgang: 1 };
        }
      }
      return { x: v._wx, y: v._wy, hoek: null, voortgang: 1 };
    }

    // De klok van de peilingen, niet die van de browser: een peiling is al
    // tientallen seconden oud als hij binnenkomt, en als we de animatie pas
    // bij ontvangst laten beginnen rijdt elke bus die vertraging nog eens
    // helemaal over.
    const verstreken = Date.now() / 1000 - buf.start;
    const reistijd = buf.reistijd || 20;
    const t = buf.vorige ? Math.max(0, Math.min(1, verstreken / reistijd)) : 1;

    // Weten we waar deze bus op zijn lijn zit, dan zetten we hem dáár neer en
    // nergens anders: ook bij zijn eerste peiling, en ook als de meting
    // terugloopt. Tussen twee rauwe punten door slingeren haalt hem van de weg.
    if (buf.route && buf.d !== null && buf.d !== undefined) {
      // Begin- en eindpunt dragen allebei hun eigen voorsprong, zodat het
      // tráject opschuift en de bus onderweg blijft in plaats van bij het
      // eindpunt stil te vallen.
      let d = buf.d + (buf.vooruit || 0);
      const van = buf.vorige ? buf.vorige.d : null;
      const vanaf = van !== null && van !== undefined ? van + (buf.vorige.vooruit || 0) : null;
      if (vanaf !== null && Math.abs(d - vanaf) <= ROUTE_SPRONG) {
        if (d >= vanaf) {
          d = vanaf + (d - vanaf) * t;        // glijden lángs de lijn
        } else if (vanaf - d < 25) {
          d = vanaf;                          // GPS-geruis bij een halte
        }
        // Loopt hij verder terug, dan is het geen ruis maar een echte
        // verplaatsing: meteen naar de nieuwe plek, nog altijd op de route.
      }
      d = this.nietAchteruit(buf, d);
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

  /**
   * Hou de bus op zijn plek in plaats van hem terug te laten schuiven.
   *
   * Vooruitrekenen is een schatting, en een schatting wordt bijgesteld: komt
   * de volgende peiling binnen terwijl we te ver vooruit zaten, dan zou de bus
   * een stukje terugspringen. Een bus die even wacht leest als een bus die
   * voor een stoplicht staat; een bus die achteruit schuift leest als een bug.
   */
  nietAchteruit(buf, d) {
    const vorig = buf.getoond;
    if (vorig !== undefined && d < vorig && vorig - d < VOORUIT_DEMPING) d = vorig;
    buf.getoond = d;
    return d;
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
      this.tekenStations(bgCtx);

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
      // Spoor: eerst het baanbed, en zodra je dicht genoeg bent dwarsliggers
      // eroverheen. Dat leest meteen als spoorlijn in plaats van als zomaar
      // een grijze weg — en de treinen rijden er nu zichtbaar overheen.
      if (t.rails.length) {
        const spoorBreed = Math.max(1, Math.min(5, 1.5 * z));
        // waarde 1 = bijspoor (perron, wissel): smaller dan de doorgaande
        // baan, anders wordt een station één brede grijze vlek.
        const breedteVan = (el) => el.waarde ? spoorBreed * 0.62 : spoorBreed;
        ctx.lineCap = 'butt';
        for (const el of t.rails) {
          if (this.buitenBeeld(el, bounds)) continue;
          this.tekenLijn(ctx, el.pts, c.spoor, breedteVan(el));
        }
        // Dwarsliggers pas als je dichtbij genoeg bent om ze te
        // onderscheiden; eerder wordt het een kralensnoer.
        if (z > 1) {
          ctx.setLineDash([spoorBreed * 0.7, spoorBreed * 1.5]);
          for (const el of t.rails) {
            if (this.buitenBeeld(el, bounds)) continue;
            this.tekenLijn(ctx, el.pts, c.spoorBiels, breedteVan(el));
          }
          ctx.setLineDash([]);
        }
        ctx.lineCap = 'round';
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

  /** De treinstations, met hun positie alvast naar wereldmeters gerekend. */
  setStations(stations) {
    const center = this.center;
    if (!center) return;
    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
    // Grootste eerst: bij ruimtegebrek wint een knooppunt van een halte
    this.stations = [...(stations || [])]
      .sort((a, b) => b.maat - a.maat)
      .map(s => ({
        ...s,
        _wx: (s.lon - center.lon) * n * R * cosLat,
        _wy: -(s.lat - center.lat) * n * R,
      }));
    this._bgVies = true;
  }

  /**
   * Treinstations: een roundel op het spoor, groter naarmate het station
   * belangrijker is. De naam komt erbij zodra er ruimte voor is — grote
   * knooppunten eerder dan een stoptreinhalte in de polder.
   */
  tekenStations(ctx) {
    if (!this.stations?.length) return;
    const z = this.cam.zoom;
    if (z < 0.12) return;
    const c = this.colors;

    // Vanaf welke zoom een station van deze maat mee mag doen
    const vanaf = { 3: 0.12, 2: 0.45, 1: 0.9 };
    const naamVanaf = { 3: 0.5, 2: 1.1, 1: 1.9 };
    const bezet = [];

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    for (const s of this.stations) {
      if (z < vanaf[s.maat]) continue;
      const p = this.worldToScreen(s._wx, s._wy);
      if (p.x < -20 || p.x > this.vw + 20 || p.y < -20 || p.y > this.vh + 20) continue;

      const r = Math.max(2.2, Math.min(7, (s.maat * 0.9 + 1.2) * Math.sqrt(z)));
      ctx.fillStyle = c.stationVul;
      ctx.strokeStyle = c.station;
      ctx.lineWidth = Math.max(1.2, r * 0.45);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      ctx.stroke();

      if (z < naamVanaf[s.maat] || !s.naam) continue;
      const grootte = Math.max(10, Math.min(15, 8 + z * 1.3));
      ctx.font = `600 ${grootte}px ${this.labelFont || 'system-ui, sans-serif'}`;
      const breedte = ctx.measureText(s.naam).width;
      const halfB = breedte / 2 + 5, halfH = grootte * 0.75;
      const ly = p.y - r - halfH - 1;
      let vrij = true;
      for (const b of bezet) {
        if (Math.abs(p.x - b.x) < halfB + b.hb && Math.abs(ly - b.y) < halfH + b.hh) {
          vrij = false;
          break;
        }
      }
      if (!vrij) continue;
      bezet.push({ x: p.x, y: ly, hb: halfB, hh: halfH });

      ctx.lineWidth = 3;
      ctx.strokeStyle = c.bg;
      ctx.strokeText(s.naam, p.x, ly);
      ctx.fillStyle = c.station;
      ctx.fillText(s.naam, p.x, ly);
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

  /** Wereldmeters → lat/lon; het omgekeerde van wat setVehicles doet. */
  wereldNaarLatLon(x, y) {
    const R = 6378137, n = Math.PI / 180, c = this.center;
    return {
      lat: c.lat - y / (n * R),
      lon: c.lon + x / (n * R * Math.cos(c.lat * n)),
    };
  }

  /** Lat/lon → wereldmeters, op dezelfde manier als setVehicles. */
  latLonNaarWereld(lat, lon) {
    const R = 6378137, n = Math.PI / 180, c = this.center;
    return [
      (lon - c.lon) * n * R * Math.cos(c.lat * n),
      -(lat - c.lat) * n * R,
    ];
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
    const c = this.colors;
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
    // De asfaltbaan is ver uitgezoomd niet te onderscheiden van de streep
    const metAsfalt = z >= 0.25;
    // De donkere rand eromheen pas als je er iets van ziet
    const metRand = z >= 0.6;
    // Breedte van een straat, niet van een snelweg: waar tien lijnen
    // dezelfde weg delen liep het anders uit op één donkere vlek.
    const baan = Math.max(3, Math.min(16, 5.5 * z));

    // Loopt langs elk zichtbaar stuk route; de tekenkant vult zelf in wat
    // er met een segment moet gebeuren.
    const overSegmenten = (doe) => {
      for (const r of this.lijnen) {
        if (!r._segmenten) continue;
        if (minLengte && (r.lengte || 0) < minLengte) continue;
        const actief = this.zichtbaar(r.lijn);
        for (const seg of r._segmenten) {
          const b = seg.b;
          if (b.maxX < bounds.minX || b.minX > bounds.maxX ||
              b.maxY < bounds.minY || b.minY > bounds.maxY) continue;
          doe(seg, r, actief);
        }
      }
    };

    // Eerst het wegdek voor álle routes, in één dekkende kleur. Doordat het
    // dekkend is stapelt het niet op waar tien lijnen dezelfde straat
    // delen: je krijgt één asfaltbaan in plaats van een steeds donkerder
    // wordende vlek. De lijnkleuren komen er daarna als strepen overheen.
    if (metAsfalt) {
      if (metRand) {
        overSegmenten((seg) => this.drawPolyline(ctx, seg.pts, c.asfaltRand, baan + 2, stap));
      }
      overSegmenten((seg) => this.drawPolyline(ctx, seg.pts, c.asfalt, baan, stap));
    }

    // Dan de lijnkleuren: eerst de gedempte, daarna de uitgelichte erop
    for (const laag of [0, 1]) {
      overSegmenten((seg, r, actief) => {
        if ((laag === 0) === actief) return;
        const kleur = r.kleur || this.colors.route;
        const dim = gefilterd && !actief;
        const kern = dim ? 0.22 : (gefilterd ? 0.95 : 0.8);
        this.drawPolyline(ctx, seg.pts, kleurMetAlpha(kleur, kern),
                          Math.max(1.2, 2.4 * z), stap);
      });
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
      const ms = this.snelheidVan(v);
      if (ms !== null) {
        this.tekenSliert(ctx, p.x, p.y, this.schermHoek(hoek), ms * 3.6, schaal, kleur);
      }
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
      // een gekleurd blokje. 's Nachts branden de lampen: dan worden het
      // warme geeltinten, wat een donkere kaart meteen leven geeft.
      ruit: this.theme === 'dark'
        ? rgbNaarString(mengKleur(basis, [255, 226, 150], 0.88))
        : rgbNaarString(licht > 190
          ? mengKleur(basis, [40, 45, 54], 0.62)
          : mengKleur(basis, [242, 248, 252], 0.85)),
      wiel: licht < 55 ? 'rgba(240,244,250,0.45)' : c.busWiel,
      rand: rgbNaarString(schaalKleur(basis, 0.62)),
      // Donkere onderrand (sokkel) en wielkasten
      rok: rgbNaarString(schaalKleur(basis, 0.68)),
      // Twee sierstrepen: een lichte en een in de tegenkleur van de lijn,
      // zodat elke bus twee- of driekleurig wordt in plaats van één vlak.
      streep: rgbNaarString(licht > 175
        ? schaalKleur(basis, 0.55)
        : mengKleur(basis, [255, 255, 255], 0.75)),
      accent: rgbNaarString(tegenKleur(basis)),
      // Glasband en deuren: getint glas, 's nachts verlicht
      glas: this.theme === 'dark'
        ? 'rgb(255,214,130)'
        : rgbNaarString(mengKleur(basis, [30, 44, 62], 0.82)),
      glans: this.theme === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.38)',
      airco: this.theme === 'dark' ? '#596475' : '#d9dee4',
    };
    this._busKleuren.set(sleutel, set);
    return set;
  }

  /**
   * Een stadsbus in zijaanzicht, gedraaid in de rijrichting. Carrosserie in
   * de lijnkleur met een donkere sokkel, twee sierstrepen (licht en in de
   * tegenkleur), een doorlopende glasband met stijlen, twee deuren, een
   * airco-unit op het dak, een oranje lijnfilmbord, koplamp en achterlicht,
   * en wielen met naven in hun wielkasten.
   */
  tekenBus(ctx, x, y, schaal, hoek, geselecteerd, kleur) {
    const c = this.colors;
    const bus = this.busKleuren(kleur);
    const s = schaal;
    const w = 30 * s;
    const h = 12 * s;
    const r = 3 * s;
    const donker = this.theme === 'dark';

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
    ctx.ellipse(0, h * 0.16, w * 0.5, h * 0.34, 0, 0, TAU);
    ctx.fill();

    ctx.translate(-w / 2, -h);

    // 's Nachts schijnen de koplampen vooruit — een zacht schijnsel voor
    // de neus maakt van een donkere kaart meteen een avondkaart.
    if (donker) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#ffdf9a';
      ctx.beginPath();
      ctx.ellipse(w + h * 0.45, h * 0.72, h * 1.05, h * 0.36, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Airco-unit op het dak
    ctx.fillStyle = bus.airco;
    afgerondeRechthoek(ctx, w * 0.3, -h * 0.13, w * 0.32, h * 0.2, 1 * s);
    ctx.fill();

    // Carrosserie: achterkant licht afgerond, de neus wat ronder
    const carrosserie = () => {
      ctx.beginPath();
      ctx.moveTo(r * 0.8, 0);
      ctx.lineTo(w - r * 1.4, 0);
      ctx.quadraticCurveTo(w, 0, w, r * 1.4);
      ctx.lineTo(w, h - r * 0.6);
      ctx.quadraticCurveTo(w, h, w - r * 0.6, h);
      ctx.lineTo(r * 0.6, h);
      ctx.quadraticCurveTo(0, h, 0, h - r * 0.6);
      ctx.lineTo(0, r * 0.8);
      ctx.quadraticCurveTo(0, 0, r * 0.8, 0);
      ctx.closePath();
    };
    carrosserie();
    ctx.fillStyle = bus.body;
    ctx.fill();

    // Alles wat hierna komt blijft binnen de carrosserie
    ctx.save();
    carrosserie();
    ctx.clip();

    // Lichte daklijn voor volume
    ctx.fillStyle = bus.dak;
    ctx.fillRect(0, 0, w, h * 0.16);

    // Sokkel en sierstrepen
    ctx.fillStyle = bus.rok;
    ctx.fillRect(0, h * 0.8, w, h * 0.2);
    ctx.fillStyle = bus.streep;
    ctx.fillRect(0, h * 0.66, w, h * 0.07);
    ctx.fillStyle = bus.accent;
    ctx.fillRect(0, h * 0.73, w, h * 0.07);
    // Schuine accentvlag achterop, zoals op veel streekbussen
    ctx.beginPath();
    ctx.moveTo(0, h * 0.6);
    ctx.lineTo(w * 0.16, h * 0.66);
    ctx.lineTo(w * 0.12, h * 0.8);
    ctx.lineTo(0, h * 0.8);
    ctx.closePath();
    ctx.fill();

    // Doorlopende glasband met raamstijlen in de lijnkleur
    const gy = h * 0.22, gh = h * 0.36;
    const g0 = w * 0.05, g1 = w * 0.84;
    ctx.fillStyle = bus.glas;
    afgerondeRechthoek(ctx, g0, gy, g1 - g0, gh, 1.2 * s);
    ctx.fill();
    ctx.fillStyle = bus.body;
    const stijl = Math.max(0.6, 0.75 * s);
    for (const f of [0.2, 0.34, 0.56, 0.68]) {
      ctx.fillRect(w * f - stijl / 2, gy, stijl, gh);
    }

    // Twee deuren (midden en voor), glas tot bijna op de sokkel
    const deur = (dx) => {
      const dw = w * 0.085;
      ctx.fillStyle = bus.rand;
      ctx.fillRect(dx - 0.5 * s, gy - 0.4 * s, dw + 1 * s, h * 0.62 + 0.4 * s);
      ctx.fillStyle = bus.glas;
      ctx.fillRect(dx, gy, dw / 2 - 0.25 * s, h * 0.58);
      ctx.fillRect(dx + dw / 2 + 0.25 * s, gy, dw / 2 - 0.25 * s, h * 0.58);
    };
    deur(w * 0.43);
    deur(w * 0.735);

    // Voorruit, iets hoger dan de zijramen
    ctx.fillStyle = bus.glas;
    ctx.beginPath();
    ctx.moveTo(w * 0.86, h * 0.16);
    ctx.lineTo(w - 0.6 * s, h * 0.16);
    ctx.quadraticCurveTo(w, h * 0.3, w - 0.4 * s, h * 0.62);
    ctx.lineTo(w * 0.86, h * 0.62);
    ctx.closePath();
    ctx.fill();

    // Glimlicht schuin over het glas
    ctx.fillStyle = bus.glans;
    for (const gx of [0.1, 0.38, 0.62, 0.88]) {
      ctx.beginPath();
      ctx.moveTo(w * gx, gy + gh);
      ctx.lineTo(w * gx + 1.6 * s, gy);
      ctx.lineTo(w * gx + 2.8 * s, gy);
      ctx.lineTo(w * gx + 1.2 * s, gy + gh);
      ctx.closePath();
      ctx.fill();
    }

    // Lijnfilmbord boven de voorruit
    ctx.fillStyle = '#1b1d21';
    ctx.fillRect(w * 0.84, h * 0.03, w * 0.15, h * 0.11);
    ctx.fillStyle = donker ? '#ffb43a' : '#f59e1b';
    ctx.fillRect(w * 0.855, h * 0.055, w * 0.12, h * 0.06);

    // Koplamp voorop, achterlicht achterop
    ctx.fillStyle = donker ? '#fff4c8' : '#fff7d6';
    afgerondeRechthoek(ctx, w - 1.9 * s, h * 0.66, 1.9 * s, h * 0.12, 0.6 * s);
    ctx.fill();
    ctx.fillStyle = '#e53935';
    ctx.fillRect(0, h * 0.42, 1.3 * s, h * 0.2);

    // Wielkasten: donkere halve cirkels in de sokkel
    const wielR = 2.3 * s;
    const wielen = [w * 0.2, w * 0.79];
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    for (const wx of wielen) {
      ctx.moveTo(wx + wielR * 1.3, h);
      ctx.arc(wx, h, wielR * 1.3, Math.PI, TAU);
    }
    ctx.fill();

    ctx.restore(); // einde clip

    // Randje voor definitie
    ctx.strokeStyle = bus.rand;
    ctx.lineWidth = Math.max(0.6, 0.5 * s);
    carrosserie();
    ctx.stroke();

    // Spiegel voorop
    ctx.strokeStyle = bus.rand;
    ctx.lineWidth = Math.max(0.6, 0.6 * s);
    ctx.beginPath();
    ctx.moveTo(w - 0.5 * s, h * 0.18);
    ctx.lineTo(w + 1.3 * s, h * 0.12);
    ctx.lineTo(w + 1.3 * s, h * 0.36);
    ctx.stroke();

    // Wielen met een lichte naaf
    ctx.fillStyle = bus.wiel;
    ctx.beginPath();
    for (const wx of wielen) {
      ctx.moveTo(wx + wielR, h);
      ctx.arc(wx, h, wielR, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = donker ? '#8a94a3' : '#c3c9d1';
    ctx.beginPath();
    for (const wx of wielen) {
      ctx.moveTo(wx + wielR * 0.45, h);
      ctx.arc(wx, h, wielR * 0.45, 0, TAU);
    }
    ctx.fill();

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
   * Het uiterlijk van één trein. Intercity's en sprinters krijgen het
   * NS-geel met blauw, maar in een paar materieeltypes (dubbeldekker,
   * koploper, nieuwe intercity; verschillende sprinters), elk met een
   * eigen kop en indeling. Overige treinen krijgen een regionaal
   * kleurenschema. Welk type het wordt hangt vast aan het treinnummer.
   */
  treinStijl(trein, kleur) {
    const soort = trein?.soort || 'trein';
    const sleutel = soort + ':' + this.theme + ':' + kleur;
    if (trein?._tstijl && trein._tstijl.sleutel === sleutel) return trein._tstijl;
    const seed = (Number(trein?.nummer) || 7) % 2000000000;
    const kies = (lijst, zout) =>
      lijst[Math.floor(hashPositie(seed, zout * 7919) * lijst.length) % lijst.length];
    const donker = this.theme === 'dark';
    const GEEL = '#ffc917', BLAUW = '#003082';

    let st;
    if (soort === 'intercity') {
      const type = kies(['dubbeldekker', 'dubbeldekker', 'nieuw', 'koploper'], 1);
      st = {
        type, body: GEEL, onder: BLAUW, streep: '#ffffff',
        onderHoogte: type === 'dubbeldekker' ? 0.2 : 0.28,
        kop: type === 'nieuw' ? '#23272e' : BLAUW,
        deur: '#f2b705', dubbel: type === 'dubbeldekker',
        neus: type === 'koploper' ? 'hoog' : 'schuin', bakken: 3,
      };
    } else if (soort === 'sprinter') {
      const type = kies(['sng', 'slt', 'flirt'], 1);
      st = {
        type, body: GEEL, onder: BLAUW,
        streep: type === 'slt' ? '#ffffff' : '#9fb3d1',
        onderHoogte: type === 'flirt' ? 0.24 : 0.16,
        kop: type === 'sng' ? '#3a3f47' : type === 'flirt' ? BLAUW : '#23272e',
        deur: type === 'flirt' ? '#2c5fa8' : '#5a6472',
        dubbel: false, neus: type === 'flirt' ? 'rond' : 'schuin', bakken: 2,
      };
    } else {
      const schema = kies([
        { body: '#f4f6f8', onder: '#00a3a6', streep: '#e8641a', kop: '#00a3a6', deur: '#007f82' },
        { body: '#e8edf2', onder: '#d6322f', streep: '#23272e', kop: '#d6322f', deur: '#a8262a' },
        { body: '#2b5fa8', onder: '#1b2f55', streep: '#7fd0f0', kop: '#1b2f55', deur: '#7fd0f0' },
        { body: '#f2f2f2', onder: '#2f9e5b', streep: '#f2c12e', kop: '#2f9e5b', deur: '#2f9e5b' },
      ], 2);
      st = { type: 'regio', ...schema, onderHoogte: 0.26, dubbel: false, neus: 'rond', bakken: 2 };
    }

    const bodyRgb = hexNaarRgb(st.body);
    st.sleutel = sleutel;
    st.rand = rgbNaarString(schaalKleur(bodyRgb, 0.6));
    // 's Nachts is de bak gedempt, zodat de verlichte ramen eruit springen
    // in plaats van op te gaan in het geel.
    if (donker) {
      st.body = rgbNaarString(schaalKleur(bodyRgb, 0.72));
      st.deur = rgbNaarString(schaalKleur(hexNaarRgb(st.deur), 0.72));
    }
    st.kader = rgbNaarString(schaalKleur(bodyRgb, 0.45));
    st.dak = donker ? '#5a6270' : '#c9ced6';
    st.dakApparatuur = donker ? '#454c58' : '#9aa2ad';
    st.glas = donker ? '#ffd68a' : '#1f2a38';
    st.glans = donker ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.32)';
    st.wiel = donker ? '#4a5260' : '#2b3038';
    if (trein) trein._tstijl = st;
    return st;
  }

  /**
   * Een treinstel in zijaanzicht: gekoppelde bakken met aan beide einden
   * een cabine. Gele bak met blauwe onderkant, witte sierstreep, ramen
   * (bij een dubbeldekker twee rijen), deuren, draaistellen met wielen,
   * balgen tussen de bakken, apparatuur en een pantograaf op het dak, en
   * koplampen voor en rode sluitlichten achter.
   */
  tekenTrein(ctx, x, y, schaal, hoek, geselecteerd, kleur, bakken = 2, treinData = null) {
    const c = this.colors;
    const st = this.treinStijl(treinData, kleur);
    const s = schaal;
    bakken = st.bakken || bakken;
    const bakL = 24 * s;               // lengte van één rijtuig
    const kier = 2.4 * s;              // balg ertussen
    const w = bakken * bakL + (bakken - 1) * kier;
    const h = (st.dubbel ? 15 : 12.5) * s;
    const neus = bakL * 0.24;
    const r = 2.4 * s;
    const donker = this.theme === 'dark';

    ctx.save();
    ctx.translate(x, y);

    // Anders dan een bus knijpen we de hoek hier niet af. Een bus rijdt op
    // een weg die je nauwelijks ziet, dus daar wint "niet op zijn neus
    // staan". Een trein ligt op een spoor dat eronder zichtbaar is, en dan
    // valt elke graad verschil op: de trein reed dan diagonaal over de
    // baan. Na het spiegelen ligt de hoek sowieso binnen een kwartslag.
    const spiegel = Math.cos(hoek) < 0;
    const draai = spiegel ? (hoek > 0 ? hoek - Math.PI : hoek + Math.PI) : hoek;
    ctx.rotate(draai);
    if (spiegel) ctx.scale(-1, 1);

    // Schaduw over de hele lengte
    ctx.fillStyle = c.schaduw;
    ctx.beginPath();
    ctx.ellipse(0, h * 0.14, w * 0.51, h * 0.24, 0, 0, TAU);
    ctx.fill();

    ctx.translate(-w / 2, -h);

    // 's Nachts schijnen de koplampen vooruit
    if (donker) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#ffdf9a';
      ctx.beginPath();
      ctx.ellipse(w + h * 0.5, h * 0.8, h * 1.1, h * 0.3, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // De omtrek van één bak. Een kopbak krijgt een cabine: 'schuin' is een
    // hellende voorruit, 'hoog' de opgetilde cabine van een koploper en
    // 'rond' een gestroomlijnde neus. Achteraan gespiegeld.
    const bakPad = (x0, voor, achter) => {
      const kant = (punt, richting) => {
        // punt: x van het uiteinde; richting +1 = voorkant, -1 = achterkant
        const ox = (dx) => punt - richting * dx;
        if (st.neus === 'hoog') {
          ctx.lineTo(ox(neus), 0);
          ctx.quadraticCurveTo(ox(neus * 0.2), h * 0.05, ox(neus * 0.12), h * 0.4);
          ctx.lineTo(ox(0), h * 0.56);
          ctx.lineTo(ox(0), h - r * 0.5);
        } else if (st.neus === 'rond') {
          ctx.lineTo(ox(neus), 0);
          ctx.bezierCurveTo(ox(neus * 0.2), 0, ox(0), h * 0.3, ox(0), h * 0.62);
          ctx.lineTo(ox(0), h - r * 0.5);
        } else {
          ctx.lineTo(ox(neus * 0.9), 0);
          ctx.quadraticCurveTo(ox(neus * 0.35), h * 0.02, ox(neus * 0.08), h * 0.5);
          ctx.lineTo(ox(0), h * 0.66);
          ctx.lineTo(ox(0), h - r * 0.5);
        }
      };
      const x1 = x0 + bakL;
      ctx.beginPath();
      // Bovenkant van achter naar voor, dan de voorkant omlaag
      ctx.moveTo(achter ? x0 + neus : x0 + r, 0);
      if (voor) kant(x1, 1);
      else { ctx.lineTo(x1 - r, 0); ctx.arcTo(x1, 0, x1, r, r); ctx.lineTo(x1, h - r * 0.5); }
      ctx.lineTo(x1, h);
      ctx.lineTo(x0, h);
      // Achterkant omhoog
      if (achter) {
        ctx.lineTo(x0, h - r * 0.5);
        // dezelfde vorm gespiegeld, nu van onder naar boven
        if (st.neus === 'hoog') {
          ctx.lineTo(x0, h * 0.56);
          ctx.lineTo(x0 + neus * 0.12, h * 0.4);
          ctx.quadraticCurveTo(x0 + neus * 0.2, h * 0.05, x0 + neus, 0);
        } else if (st.neus === 'rond') {
          ctx.lineTo(x0, h * 0.62);
          ctx.bezierCurveTo(x0, h * 0.3, x0 + neus * 0.2, 0, x0 + neus, 0);
        } else {
          ctx.lineTo(x0, h * 0.66);
          ctx.lineTo(x0 + neus * 0.08, h * 0.5);
          ctx.quadraticCurveTo(x0 + neus * 0.35, h * 0.02, x0 + neus * 0.9, 0);
        }
      } else {
        ctx.lineTo(x0, r);
        ctx.arcTo(x0, 0, x0 + r, 0, r);
      }
      ctx.closePath();
    };

    const x0Van = (i) => i * (bakL + kier);

    // Balgen tussen de bakken: donker harmonicastuk met een paar plooien
    for (let i = 0; i < bakken - 1; i++) {
      const bx = x0Van(i) + bakL;
      ctx.fillStyle = '#2b3038';
      ctx.fillRect(bx - 0.3 * s, h * 0.14, kier + 0.6 * s, h * 0.76);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(bx + kier * 0.3, h * 0.14, Math.max(0.4, 0.35 * s), h * 0.76);
      ctx.fillRect(bx + kier * 0.65, h * 0.14, Math.max(0.4, 0.35 * s), h * 0.76);
    }

    const wielR = 1.35 * s;
    for (let i = 0; i < bakken; i++) {
      const x0 = x0Van(i);
      const voor = i === bakken - 1;
      const achter = i === 0;

      // Draaistellen: een donker frame met twee wielen
      for (const f of [0.2, 0.8]) {
        const bx = x0 + bakL * f;
        ctx.fillStyle = st.wiel;
        ctx.fillRect(bx - bakL * 0.1, h - 0.6 * s, bakL * 0.2, 1.4 * s);
        ctx.beginPath();
        ctx.arc(bx - bakL * 0.05, h + 0.5 * s, wielR, 0, TAU);
        ctx.arc(bx + bakL * 0.05, h + 0.5 * s, wielR, 0, TAU);
        ctx.fill();
        ctx.fillStyle = donker ? '#7a8494' : '#b5bcc6';
        ctx.beginPath();
        ctx.arc(bx - bakL * 0.05, h + 0.5 * s, wielR * 0.4, 0, TAU);
        ctx.arc(bx + bakL * 0.05, h + 0.5 * s, wielR * 0.4, 0, TAU);
        ctx.fill();
      }

      // Carrosserie
      bakPad(x0, voor, achter);
      ctx.fillStyle = st.body;
      ctx.fill();

      ctx.save();
      bakPad(x0, voor, achter);
      ctx.clip();

      // Dak, onderkant en sierstreep
      ctx.fillStyle = st.dak;
      ctx.fillRect(x0, 0, bakL, h * 0.1);
      ctx.fillStyle = st.onder;
      ctx.fillRect(x0, h * (1 - st.onderHoogte), bakL, h * st.onderHoogte);
      ctx.fillStyle = st.streep;
      ctx.fillRect(x0, h * (1 - st.onderHoogte) - h * 0.06, bakL, h * 0.05);

      // Ramen: één doorlopende band, of twee bij een dubbeldekker. Waar de
      // cabines zitten blijft de band vrij.
      const r0 = x0 + (achter ? neus * 1.25 : bakL * 0.05);
      const r1 = x0 + bakL - (voor ? neus * 1.25 : bakL * 0.05);
      const banden = st.dubbel
        ? [[h * 0.17, h * 0.2], [h * 0.47, h * 0.2]]
        : [[h * 0.24, h * 0.3]];
      for (const [by, bh] of banden) {
        ctx.fillStyle = st.glas;
        afgerondeRechthoek(ctx, r0, by, r1 - r0, bh, 0.8 * s);
        ctx.fill();
        ctx.strokeStyle = st.kader;
        ctx.lineWidth = Math.max(0.5, 0.5 * s);
        ctx.stroke();
        // Raamstijlen
        ctx.fillStyle = st.body;
        const n = Math.max(2, Math.round((r1 - r0) / (4.2 * s)));
        const stap = (r1 - r0) / n;
        for (let j = 1; j < n; j++) {
          ctx.fillRect(r0 + j * stap - 0.35 * s, by, Math.max(0.5, 0.7 * s), bh);
        }
        // Glimlicht
        ctx.fillStyle = st.glans;
        for (let j = 0; j < n; j += 2) {
          const gx = r0 + j * stap + stap * 0.25;
          ctx.beginPath();
          ctx.moveTo(gx, by + bh);
          ctx.lineTo(gx + 1.2 * s, by);
          ctx.lineTo(gx + 2.1 * s, by);
          ctx.lineTo(gx + 0.9 * s, by + bh);
          ctx.closePath();
          ctx.fill();
        }
      }

      // Deuren: twee per bak, met eigen kleur en een raampje per deurblad
      const deurW = bakL * 0.1;
      const deurPos = [];
      if (!achter) deurPos.push(x0 + bakL * 0.18);
      else deurPos.push(x0 + neus * 1.35);
      if (!voor) deurPos.push(x0 + bakL * 0.72);
      else deurPos.push(x0 + bakL - neus * 1.35 - deurW);
      for (const dx of deurPos) {
        const dy = st.dubbel ? h * 0.42 : h * 0.18;
        ctx.fillStyle = st.deur;
        ctx.fillRect(dx, dy, deurW, h * 0.92 - dy);
        ctx.fillStyle = st.glas;
        const gh = (h * 0.92 - dy) * 0.42;
        ctx.fillRect(dx + 0.5 * s, dy + 0.8 * s, deurW / 2 - 0.75 * s, gh);
        ctx.fillRect(dx + deurW / 2 + 0.25 * s, dy + 0.8 * s, deurW / 2 - 0.75 * s, gh);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(dx + deurW / 2 - 0.2 * s, dy, Math.max(0.4, 0.4 * s), h * 0.92 - dy);
      }

      // Cabines: neus in de kopkleur met een voorruit erin
      const cabine = (punt, richting) => {
        const binnen = punt - richting * neus * 1.15;
        ctx.fillStyle = st.kop;
        ctx.fillRect(Math.min(punt, binnen), 0, neus * 1.15, h * (1 - st.onderHoogte) - h * 0.06);
        ctx.fillStyle = st.glas;
        ctx.beginPath();
        const ruitOnder = st.neus === 'hoog' ? h * 0.36 : h * 0.48;
        ctx.moveTo(punt - richting * neus * 0.95, h * 0.12);
        ctx.lineTo(punt - richting * neus * 0.4, h * 0.12);
        ctx.lineTo(punt - richting * neus * 0.06, ruitOnder);
        ctx.lineTo(punt - richting * neus * 0.95, ruitOnder);
        ctx.closePath();
        ctx.fill();
      };
      if (voor) cabine(x0 + bakL, 1);
      if (achter) cabine(x0, -1);

      ctx.restore(); // einde clip

      // Randje voor definitie
      ctx.strokeStyle = st.rand;
      ctx.lineWidth = Math.max(0.6, 0.45 * s);
      bakPad(x0, voor, achter);
      ctx.stroke();

      // Dakapparatuur: koelunits op elke bak
      ctx.fillStyle = st.dakApparatuur;
      afgerondeRechthoek(ctx, x0 + bakL * (achter ? 0.4 : 0.28), -h * 0.08, bakL * 0.22, h * 0.1, 0.6 * s);
      ctx.fill();
    }

    // Koplampen voor, sluitlichten achter
    const lampY = h * (1 - st.onderHoogte) + h * 0.04;
    ctx.fillStyle = '#fff6cf';
    ctx.beginPath();
    ctx.arc(w - 0.9 * s, lampY, Math.max(0.7, 0.9 * s), 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#e53935';
    ctx.beginPath();
    ctx.arc(0.9 * s, lampY, Math.max(0.7, 0.9 * s), 0, TAU);
    ctx.fill();

    // Pantograaf op het dak van de middelste (of voorste) bak: voetstuk,
    // een ruitvormige schaar en de sleepstuk bovenop
    const pb = Math.floor(bakken / 2);
    const px = x0Van(pb) + bakL * 0.62;
    const ph = h * 0.32;
    ctx.fillStyle = st.dakApparatuur;
    ctx.fillRect(px - bakL * 0.08, -h * 0.06, bakL * 0.16, h * 0.08);
    ctx.strokeStyle = donker ? '#aab3c0' : '#4a5260';
    ctx.lineWidth = Math.max(0.5, 0.45 * s);
    ctx.beginPath();
    ctx.moveTo(px - bakL * 0.07, -h * 0.05);
    ctx.lineTo(px + bakL * 0.03, -ph * 0.55);
    ctx.lineTo(px - bakL * 0.04, -ph);
    ctx.moveTo(px - bakL * 0.1, -ph);
    ctx.lineTo(px + bakL * 0.04, -ph);
    ctx.stroke();

    ctx.restore();

    if (geselecteerd) {
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y - h * 0.4, w * 0.54, 0, TAU);
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

/**
 * Een levendige tegenkleur bij een lijnkleur: de tint ruim een derde slag
 * verder op de kleurencirkel, flink verzadigd. Een grijze lijnkleur heeft
 * geen tint om van uit te gaan; die krijgt een vast warm oranje.
 */
function tegenKleur(rgb) {
  const [r, g, b] = rgb.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.08) return [242, 140, 40];
  let tint;
  if (max === r) tint = ((g - b) / d) % 6;
  else if (max === g) tint = (b - r) / d + 2;
  else tint = (r - g) / d + 4;
  tint = ((tint * 60 + 150) % 360 + 360) % 360;
  // HSL terug naar RGB met S = 0.75 en L = 0.52
  const S = 0.75, Lh = 0.52;
  const C = (1 - Math.abs(2 * Lh - 1)) * S;
  const X = C * (1 - Math.abs((tint / 60) % 2 - 1));
  const m = Lh - C / 2;
  const [r1, g1, b1] = tint < 60 ? [C, X, 0] : tint < 120 ? [X, C, 0] : tint < 180 ? [0, C, X]
    : tint < 240 ? [0, X, C] : tint < 300 ? [X, 0, C] : [C, 0, X];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
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

/**
 * Een scheepsromp van bovenaf, boeg naar +x. 'spits' voor jachten en
 * veerboten, 'blok' voor vracht en tankers (lang recht middenschip),
 * 'rond' voor de stompe sleepboot.
 */
function rompPad(ctx, l, b, vorm) {
  const h = l / 2, k = b / 2;
  ctx.beginPath();
  ctx.moveTo(h, 0);
  if (vorm === 'rond') {
    ctx.bezierCurveTo(h, -k * 0.9, h * 0.6, -k, h * 0.2, -k);
    ctx.lineTo(-h * 0.8, -k);
    ctx.quadraticCurveTo(-h, -k, -h, -k * 0.6);
    ctx.lineTo(-h, k * 0.6);
    ctx.quadraticCurveTo(-h, k, -h * 0.8, k);
    ctx.lineTo(h * 0.2, k);
    ctx.bezierCurveTo(h * 0.6, k, h, k * 0.9, h, 0);
  } else if (vorm === 'blok') {
    ctx.bezierCurveTo(h * 0.96, -k * 0.7, h * 0.78, -k, h * 0.55, -k);
    ctx.lineTo(-h * 0.92, -k);
    ctx.quadraticCurveTo(-h, -k, -h, -k * 0.8);
    ctx.lineTo(-h, k * 0.8);
    ctx.quadraticCurveTo(-h, k, -h * 0.92, k);
    ctx.lineTo(h * 0.55, k);
    ctx.bezierCurveTo(h * 0.78, k, h * 0.96, k * 0.7, h, 0);
  } else {
    ctx.bezierCurveTo(h * 0.75, -k * 0.95, h * 0.2, -k, -h * 0.1, -k);
    ctx.lineTo(-h * 0.9, -k * 0.92);
    ctx.quadraticCurveTo(-h, -k * 0.9, -h, -k * 0.6);
    ctx.lineTo(-h, k * 0.6);
    ctx.quadraticCurveTo(-h, k * 0.9, -h * 0.9, k * 0.92);
    ctx.lineTo(-h * 0.1, k);
    ctx.bezierCurveTo(h * 0.2, k, h * 0.75, k * 0.95, h, 0);
  }
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
