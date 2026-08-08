// ============================================================
// Bussie — App logic
// Koppelt de renderer aan de backend API.
// ============================================================

// De versie-query hier moet gelijk lopen met index.html's <script>-tags:
// Cloudflare cachet /js/*.js hardnekkig op URL, en zonder query blijft deze
// import — anders dan de <script>-tag zelf — op een oude cache hangen.
import { IsoRenderer } from './kaart.js?v=28';
import { TegelBron } from './tegels.js?v=28';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const bootBar = document.getElementById('boot-bar');
const bootMsg = document.getElementById('boot-msg');
const boot = document.getElementById('boot');

function bootProgress(pct, msg) {
  bootBar.style.width = pct + '%';
  if (msg) bootMsg.textContent = msg;
}

function hideBoot() {
  boot.style.opacity = '0';
  setTimeout(() => boot.style.display = 'none', 400);
}

// ---------------------------------------------------------------------------
// Renderer setup
// ---------------------------------------------------------------------------

const canvas = document.getElementById('kaart');
const renderer = new IsoRenderer(canvas);

// Theme restore
const savedTheme = localStorage.getItem('bussie-theme') || 'light';
renderer.setTheme(savedTheme);
document.getElementById('thema-knop').textContent = savedTheme === 'light' ? '☀' : '☾';

// ---------------------------------------------------------------------------
// Kaart- en lijndata laden
// ---------------------------------------------------------------------------

bootProgress(10, 'Kaartdata laden…');

let tegelBron = null;
let vehicles = [];
let activeLines = new Map();   // lijn → {bestemming, count, kleur}
let lijnKleuren = new Map();   // lijn → kleur uit de GTFS
let lijnenGeladen = null;      // belofte: de lijnenlaag is binnen

async function loadMap() {
  try {
    // De kaartondergrond komt in tegels binnen; hier halen we alleen de
    // index op met welke tegels er zijn. De rest laadt vanzelf tijdens
    // het tekenen, afhankelijk van waar je kijkt.
    tegelBron = new TegelBron('/data/tegels');
    await tegelBron.laadIndex();
    renderer.setTegelBron(tegelBron);
    tegelBron.opGeladen = () => { renderer.markeerAchtergrondVies(); renderer.render(); };
    bootProgress(35, 'Buslijnen laden…');
  } catch (err) {
    bootMsg.textContent = 'Kaartdata niet beschikbaar';
    console.error('Tegelindex laden mislukt:', err);
    return;
  }

  // Lijnroutes: geometrie, kleuren en haltes per lijn en richting.
  // Landelijk is dit 12 MB, dus we wachten er niet op: de kaart komt eerst
  // in beeld en de lijnen schuiven er even later onder.
  lijnenGeladen = (async () => {
    try {
      const resp = await fetch('/data/lijnen.json');
      if (!resp.ok) return;
      const data = await resp.json();
      renderer.setLijnen(data.lijnen || []);
      for (const r of data.lijnen || []) {
        if (!lijnKleuren.has(r.lijn)) lijnKleuren.set(r.lijn, r.kleur);
      }
      console.log(`${(data.lijnen || []).length} lijnroutes geladen`);
      // Voertuigen die al binnen waren alsnog aan hun route koppelen
      if (vehicles.length) renderer.setVehicles(vehicles, null);
      updateLijnFilter();
    } catch (err) {
      console.warn('Lijnroutes laden mislukt:', err);
    }
  })();

  bootProgress(55, 'Voertuigen laden…');
}

function kleurVan(lijn) {
  return lijnKleuren.get(lijn) || '#8aa0b2';
}

/** Staat dit voertuig binnen het momenteel zichtbare stuk kaart? */
function binnenBeeld(v) {
  if (v._wx === undefined) return false;
  const b = renderer.viewportBounds();
  return v._wx >= b.minX && v._wx <= b.maxX && v._wy >= b.minY && v._wy <= b.maxY;
}

// ---------------------------------------------------------------------------
// Realtime polling
// ---------------------------------------------------------------------------

let lastDataTs = 0;

async function pollVehicles(initial) {
  try {
    const url = initial ? '/api/voertuigen/db?history=2' : '/api/voertuigen/db';
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();

    // Niets veranderd? Dan de bewegingsbuffer met rust laten.
    if (!initial && data.data_ts && data.data_ts === lastDataTs) {
      updateStatusregel();
      return;
    }
    lastDataTs = data.data_ts || 0;
    vehicles = data.voertuigen || [];

    renderer.setVehicles(vehicles, initial ? data.historie : null);

    activeLines.clear();
    for (const v of vehicles) {
      if (!binnenBeeld(v)) continue;
      const lijn = v.lijn || '?';
      if (!activeLines.has(lijn)) {
        activeLines.set(lijn, { bestemming: v.bestemming || '', count: 0, kleur: kleurVan(lijn) });
      }
      activeLines.get(lijn).count++;
    }
    updateLijnFilter();
    updateBusoverzicht();
    updateStatusregel();
  } catch (err) {
    console.error('Pollen mislukt:', err);
  }
}

// ---------------------------------------------------------------------------
// Scheepvaart
// ---------------------------------------------------------------------------

let schepen = [];

async function pollSchepen() {
  try {
    const resp = await fetch('/api/schepen');
    if (!resp.ok) return;
    const data = await resp.json();
    schepen = data.schepen || [];
    renderer.setSchepen(schepen);
  } catch (err) {
    console.warn('Schepen ophalen mislukt:', err);
  }
}

// ---------------------------------------------------------------------------
// Treinen
// ---------------------------------------------------------------------------

let treinen = [];

async function pollTreinen() {
  try {
    const resp = await fetch('/api/treinen');
    if (!resp.ok) return;
    const data = await resp.json();
    treinen = data.treinen || [];
    renderer.setTreinen(treinen);
  } catch (err) {
    console.warn('Treinen ophalen mislukt:', err);
  }
}

async function laadStations() {
  try {
    const resp = await fetch('/api/stations');
    if (!resp.ok) return;
    const data = await resp.json();
    renderer.setStations(data.stations || []);
  } catch (err) {
    console.warn('Stations laden mislukt:', err);
  }
}

function updateStatusregel() {
  const delen = [`${vehicles.length} bussen`];
  if (treinen.length) delen.push(`${treinen.length} treinen`);
  if (schepen.length) delen.push(`${schepen.length} schepen`);
  document.getElementById('laden').textContent =
    `${delen.join(' · ')} live · bijgewerkt ${new Date().toLocaleTimeString('nl-NL')}`;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function renderLoop() {
  renderer.render();
  if (renderer.hoveredVehicle) volgPopup(renderer.hoveredVehicle);
  else if (renderer.hoveredSchip) volgPopup(renderer.hoveredSchip);
  else if (renderer.hoveredTrein) volgPopup(renderer.hoveredTrein);
  requestAnimationFrame(renderLoop);
}

// ---------------------------------------------------------------------------
// Klok
// ---------------------------------------------------------------------------

function updateKlok() {
  const now = new Date();
  document.getElementById('klok').textContent =
    now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Lijnfilter
// ---------------------------------------------------------------------------

const lijnFilterDiv = document.getElementById('lijn-filter');
const lijnenKnop = document.getElementById('lijnen-knop');
let lijnFilterOpen = false;

function gesorteerdeLijnen(entries) {
  return [...entries].sort((a, b) => {
    const an = parseInt(a[0]), bn = parseInt(b[0]);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return a[0].localeCompare(b[0]);
  });
}

function updateLijnFilter() {
  const lijnen = gesorteerdeLijnen(activeLines.entries());
  const gefilterd = renderer.filteredLines.size > 0;

  let html = `<div class="filter-kop">
      <span>Lijnen</span>
      <button class="filter-reset" ${gefilterd ? '' : 'disabled'}>alles tonen</button>
    </div>`;

  html += lijnen.map(([lijn, info]) => {
    const uit = gefilterd && !renderer.filteredLines.has(lijn);
    return `<div class="lijn-item${uit ? ' verborgen' : ''}" data-lijn="${lijn}">
      <span class="lijn-badge" style="background:${info.kleur};color:${tekstKleur(info.kleur)}">${lijn}</span>
      <span class="lijn-naam">${info.bestemming}</span>
      <span class="lijn-aantal">${info.count}</span>
    </div>`;
  }).join('');

  lijnFilterDiv.innerHTML = html;

  lijnFilterDiv.querySelector('.filter-reset')?.addEventListener('click', () => {
    renderer.filteredLines.clear();
    renderer.markeerAchtergrondVies();
    updateLijnFilter();
  });

  lijnFilterDiv.querySelectorAll('.lijn-item').forEach(item => {
    item.addEventListener('click', () => {
      const lijn = item.dataset.lijn;
      if (renderer.filteredLines.has(lijn)) renderer.filteredLines.delete(lijn);
      else renderer.filteredLines.add(lijn);
      if (renderer.filteredLines.size === activeLines.size) renderer.filteredLines.clear();
      renderer.markeerAchtergrondVies();
      updateLijnFilter();
      updateBusoverzicht();
    });
  });
}

lijnenKnop.addEventListener('click', () => {
  lijnFilterOpen = !lijnFilterOpen;
  lijnFilterDiv.style.display = lijnFilterOpen ? 'block' : 'none';
  lijnenKnop.classList.toggle('actief', lijnFilterOpen);
  if (lijnFilterOpen) {
    sluitOverzicht();
    sluitSteden();
  }
});

// ---------------------------------------------------------------------------
// Opening — boven Groningen beginnen en rustig inzakken op het busstation
// ---------------------------------------------------------------------------

const OPENING = {
  duur: 9000,       // milliseconden
  beginZoom: 0.75,
  eindZoom: 3.2,
};
let vluchtBezig = false;

/** Zacht op gang, zacht uitlopend. */
function soepel(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Naar een plek toe vliegen: onderweg uitzoomen en aan het eind weer
 * inzakken. Zonder die dip veeg je bij een verre stad op volle zoom over
 * het land en zie je alleen een waas voorbijkomen.
 *
 * Zoomen gaat in logaritmische ruimte — halverwege tussen 1 en 4 hoort 2 te
 * zijn, niet 2,5 — met daar bovenop een parabool die op de helft van de
 * reis zijn diepste punt heeft.
 */
// Verder dan dit overvliegen we niet meer; dan gaan we er boven hangen
const VLIEGGRENS = 15000;   // meter

function vliegNaar(doel, eindZoom, duur) {
  const van = { x: renderer.cam.x, y: renderer.cam.y, zoom: renderer.cam.zoom };
  const afstand = Math.hypot(doel.x - van.x, doel.y - van.y);

  let dip = 0;
  let tijd = duur;

  if (afstand > VLIEGGRENS) {
    // Te ver om zinnig over te vliegen: bij 20 km heb je zoomstand 0,08
    // nodig om het traject in beeld te krijgen, en dat staat de kaart niet
    // toe. In plaats daarvan meteen boven de bestemming gaan hangen en
    // daarop inzakken — dat leest als aankomen in plaats van als een waas.
    van.x = doel.x;
    van.y = doel.y;
    van.zoom = Math.min(van.zoom, 0.85);
    renderer.cam.x = renderer.targetCam.x = van.x;
    renderer.cam.y = renderer.targetCam.y = van.y;
    renderer.cam.zoom = renderer.targetCam.zoom = van.zoom;
    tijd = tijd ?? 2400;
  } else {
    // Dichtbij: echt overvliegen, met een uitzoomdip die meegroeit met de
    // afstand. Ver genoeg om overzicht te geven, niet zo ver dat een
    // buurtsprongetje het hele land laat zien.
    const uitfactor = Math.max(1, Math.min(4, 1 + afstand / 5000));
    const laagste = Math.max(0.4, Math.min(van.zoom, eindZoom) / uitfactor);
    dip = Math.log(laagste) - (Math.log(van.zoom) + Math.log(eindZoom)) / 2;
    tijd = tijd ?? Math.max(1100, Math.min(2600, 900 + afstand / 12));
  }

  const logVan = Math.log(van.zoom);
  const logNaar = Math.log(eindZoom);

  vluchtBezig = true;
  const begin = performance.now();

  function stap(nu) {
    if (!vluchtBezig) return;
    const t = Math.min(1, (nu - begin) / tijd);
    const e = soepel(t);

    // Zoomen in logaritmische ruimte: halverwege tussen 1 en 4 hoort 2 te
    // zijn, niet 2,5. De parabool erbovenop is de dip onderweg.
    const logZoom = logVan + (logNaar - logVan) * e + 4 * dip * t * (1 - t);
    renderer.cam.x = renderer.targetCam.x = van.x + (doel.x - van.x) * e;
    renderer.cam.y = renderer.targetCam.y = van.y + (doel.y - van.y) * e;
    renderer.cam.zoom = renderer.targetCam.zoom = Math.exp(logZoom);

    if (t < 1) requestAnimationFrame(stap);
    else vluchtBezig = false;
  }
  requestAnimationFrame(stap);
}

/** Het busstation zoeken tussen de haltes; anders het stadscentrum. */
function openingsDoel() {
  const perrons = renderer.haltes.filter(h => h.naam.includes('Groningen, Hoofdstation'));
  if (perrons.length) {
    return {
      x: perrons.reduce((n, h) => n + h.x, 0) / perrons.length,
      y: perrons.reduce((n, h) => n + h.y, 0) / perrons.length,
    };
  }
  return plaatsen.find(p => p.naam === 'Groningen') || null;
}

function startOpening() {
  const stad = plaatsen.find(p => p.naam === 'Groningen');
  const doel = openingsDoel();
  if (!stad || !doel) return;

  // Meteen boven Groningen staan, daarna pas bewegen. De afstand is klein,
  // dus de dip valt vanzelf weg: dit is een pure inzoombeweging.
  renderer.cam.x = renderer.targetCam.x = stad.x;
  renderer.cam.y = renderer.targetCam.y = stad.y;
  renderer.cam.zoom = renderer.targetCam.zoom = OPENING.beginZoom;

  vliegNaar(doel, OPENING.eindZoom, OPENING.duur);
}

/** Zodra iemand zelf de kaart aanraakt is de opening voorbij. */
function stopOpening() {
  if (!vluchtBezig) return;
  vluchtBezig = false;
  renderer.targetCam.x = renderer.cam.x;
  renderer.targetCam.y = renderer.cam.y;
  renderer.targetCam.zoom = renderer.cam.zoom;
}

for (const gebeurtenis of ['mousedown', 'wheel', 'touchstart']) {
  canvas.addEventListener(gebeurtenis, stopOpening, { passive: true });
}
window.addEventListener('keydown', stopOpening);

// ---------------------------------------------------------------------------
// Plaatsen — springen naar een stad of dorp
// ---------------------------------------------------------------------------

const stedenPaneel = document.getElementById('steden');
const stedenKnop = document.getElementById('steden-knop');
const stedenZoek = document.getElementById('steden-zoek');
const stedenLijst = document.getElementById('steden-lijst');
let plaatsen = [];
let stedenOpen = false;
let gemarkeerd = 0;

async function laadPlaatsen() {
  try {
    const resp = await fetch('/data/steden.json');
    if (!resp.ok) return;
    plaatsen = (await resp.json()).plaatsen || [];
    renderer.setPlaatsen(plaatsen);
    console.log(`${plaatsen.length} plaatsen geladen`);
  } catch (err) {
    console.warn('Plaatsen laden mislukt:', err);
  }
}

/** Diakrieten weg, zodat "Den Bosch" ook 's-Hertogenbosch vindt via "bosch". */
function vereenvoudigd(tekst) {
  return tekst.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function gefilterdePlaatsen() {
  const term = vereenvoudigd(stedenZoek.value.trim());
  if (!term) {
    // Zonder zoekterm: de grootste plaatsen bovenaan
    return [...plaatsen].sort((a, b) => b.inwoners - a.inwoners).slice(0, 40);
  }
  return plaatsen
    .filter(p => vereenvoudigd(p.naam).includes(term))
    .sort((a, b) => {
      // Wie met de zoekterm begint, staat voorop
      const aStart = vereenvoudigd(a.naam).startsWith(term);
      const bStart = vereenvoudigd(b.naam).startsWith(term);
      if (aStart !== bStart) return aStart ? -1 : 1;
      return b.inwoners - a.inwoners;
    })
    .slice(0, 40);
}

function toonPlaatsen() {
  const lijst = gefilterdePlaatsen();
  gemarkeerd = 0;

  if (!lijst.length) {
    stedenLijst.innerHTML = '<div class="leeg">Niets gevonden</div>';
    return;
  }

  stedenLijst.innerHTML = lijst.map((p, i) => `
    <div class="plaats${i === 0 ? ' actief' : ''}" data-i="${i}">
      <span class="naam">${p.naam}</span>
      <span class="inwoners">${p.inwoners ? p.inwoners.toLocaleString('nl-NL') : ''}</span>
    </div>`).join('');

  stedenLijst.querySelectorAll('.plaats').forEach(el => {
    el.addEventListener('click', () => gaNaar(lijst[+el.dataset.i]));
  });
}

// Hoe ver rond een plaats we naar bussen zoeken, per soort
const ZOEKSTRAAL = { city: 8000, town: 5000, village: 3000 };
const DRUKTE_CEL = 600;   // meter; het raster waarin we bussen tellen

/**
 * De drukste plek binnen een plaats: het rastervak met de meeste bussen,
 * plus zijn buren, en daarvan het zwaartepunt.
 *
 * Een cluster ver van het centrum weegt lichter dan eentje er middenin —
 * anders kiest een stad als Delft een groepje bussen dat eigenlijk bij de
 * buurstad hoort. Is er maar één bus dichtbij, dan is dat nog altijd een
 * betere plek om te landen dan het geometrische middelpunt.
 */
function druksteplek(plaats) {
  const straal = ZOEKSTRAAL[plaats.soort] || 5000;
  const dichtbij = [];
  for (const v of vehicles) {
    const x = v._dispWx !== undefined ? v._dispWx : v._wx;
    const y = v._dispWy !== undefined ? v._dispWy : v._wy;
    if (x === undefined) continue;
    // Ronde straal, geen vierkant: in een hoek zit je anders anderhalf keer
    // zo ver weg als bedoeld.
    const afstand = Math.hypot(x - plaats.x, y - plaats.y);
    if (afstand > straal) continue;
    dichtbij.push({ x, y, afstand });
  }
  if (!dichtbij.length) return null;

  const vakken = new Map();
  for (const p of dichtbij) {
    const sleutel = `${Math.floor(p.x / DRUKTE_CEL)},${Math.floor(p.y / DRUKTE_CEL)}`;
    const vak = vakken.get(sleutel);
    if (vak) vak.push(p);
    else vakken.set(sleutel, [p]);
  }

  let beste = null, besteScore = 0;
  for (const sleutel of vakken.keys()) {
    const [cx, cy] = sleutel.split(',').map(Number);
    // Buren meetellen, anders wint een toevallige celgrens
    let aantal = 0, sx = 0, sy = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of vakken.get(`${cx + dx},${cy + dy}`) || []) {
          aantal++;
          sx += p.x;
          sy += p.y;
        }
      }
    }
    const x = sx / aantal, y = sy / aantal;
    // Hoe verder van het centrum, hoe meer bussen er nodig zijn om te winnen
    const afstand = Math.hypot(x - plaats.x, y - plaats.y);
    const score = aantal * Math.exp(-afstand / (straal * 0.45));
    if (score > besteScore) {
      besteScore = score;
      beste = { x, y, aantal, afstand };
    }
  }

  // Een enkele bus in de verte zegt niets; dichtbij is het wel het kijken waard
  if (!beste || (beste.aantal < 2 && beste.afstand > straal * 0.4)) return null;
  return beste;
}

function gaNaar(plaats) {
  if (!plaats) return;
  stopOpening();

  const druk = druksteplek(plaats);
  if (druk) {
    vliegNaar(druk, Math.max(plaats.zoom || 2, 3.0));
    console.log(`${plaats.naam}: ${druk.aantal} bussen op de drukste plek`);
  } else {
    vliegNaar(plaats, plaats.zoom || 2);
  }
  sluitSteden();
}

function sluitSteden() {
  stedenOpen = false;
  stedenPaneel.style.display = 'none';
  stedenKnop.classList.remove('actief');
}

stedenKnop.addEventListener('click', () => {
  stedenOpen = !stedenOpen;
  stedenPaneel.style.display = stedenOpen ? 'block' : 'none';
  stedenKnop.classList.toggle('actief', stedenOpen);
  if (stedenOpen) {
    sluitOverzicht();
    lijnFilterOpen = false;
    lijnFilterDiv.style.display = 'none';
    lijnenKnop.classList.remove('actief');
    stedenZoek.value = '';
    toonPlaatsen();
    stedenZoek.focus();
  }
});

stedenZoek.addEventListener('input', toonPlaatsen);

// Met de pijltjes door de lijst, enter springt erheen
stedenZoek.addEventListener('keydown', (e) => {
  const items = [...stedenLijst.querySelectorAll('.plaats')];
  if (e.key === 'Escape') return sluitSteden();
  if (!items.length) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    items[gemarkeerd]?.classList.remove('actief');
    gemarkeerd = (gemarkeerd + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[gemarkeerd].classList.add('actief');
    items[gemarkeerd].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    items[gemarkeerd]?.click();
  }
});

// ---------------------------------------------------------------------------
// Busoverzicht zijbalk
// ---------------------------------------------------------------------------

const busoverzichtDiv = document.getElementById('busoverzicht');
const overzichtKnop = document.getElementById('overzicht-knop');
let overzichtOpen = false;
let ingeklapteLijnen = new Set();

function statusVan(v) {
  const snelheid = renderer.snelheidVan(v);
  if (snelheid !== null && snelheid < 0.6) return { tekst: 'stilstaand', cls: 'halte' };
  if (v.st === 1) return { tekst: 'bij halte', cls: 'halte' };
  if (v.st === 0) return { tekst: 'aankomend', cls: 'aankomend' };
  return { tekst: 'rijdt', cls: 'rijdt' };
}

function snelheidTekst(v) {
  const snelheid = renderer.snelheidVan(v);
  const ms = snelheid !== null ? snelheid : v.snelheid;
  if (ms === null || ms === undefined) return '—';
  return `${Math.round(ms * 3.6)} km/u`;
}

function volgendeHalteVan(v) {
  const route = v._route;
  if (!route || v._d === null || v._d === undefined) return null;
  return renderer.volgendeHalte(route, v._d);
}

function halteTekst(v) {
  const volgende = volgendeHalteVan(v);
  if (!volgende) return null;
  const meter = volgende.afstand;
  const afstand = meter > 950 ? `${(meter / 1000).toFixed(1)} km` : `${Math.round(meter / 10) * 10} m`;
  return { naam: volgende.halte.naam.replace(/^Groningen, /, ''), afstand };
}

function sluitOverzicht() {
  overzichtOpen = false;
  busoverzichtDiv.style.display = 'none';
  overzichtKnop.classList.remove('actief');
}

function updateBusoverzicht() {
  if (!vehicles.length) {
    busoverzichtDiv.innerHTML = '<div class="header">Geen bussen</div>';
    return;
  }

  const perLijn = new Map();
  for (const v of vehicles) {
    if (!renderer.zichtbaar(v.lijn)) continue;
    if (!binnenBeeld(v)) continue;
    const lijn = v.lijn || '?';
    if (!perLijn.has(lijn)) perLijn.set(lijn, { bestemming: v.bestemming || '', bussen: [] });
    perLijn.get(lijn).bussen.push(v);
  }

  const lijnen = gesorteerdeLijnen(perLijn.entries());
  const totaal = lijnen.reduce((n, [, info]) => n + info.bussen.length, 0);

  if (totaal === 0) {
    busoverzichtDiv.innerHTML = '<div class="header">Geen bussen in beeld</div>';
    return;
  }

  let html = `<div class="header">Bussen <span class="aantal">${totaal} · ${lijnen.length} lijnen</span></div>`;

  for (const [lijn, info] of lijnen) {
    const kleur = kleurVan(lijn);
    const ingeklapt = ingeklapteLijnen.has(lijn);

    html += `<div class="lijn-groep${ingeklapt ? ' ingeklapt' : ''}" data-lijn="${lijn}">`;
    html += `<div class="lijn-header" data-lijn="${lijn}">`;
    html += `<span class="lijn-badge" style="background:${kleur};color:${tekstKleur(kleur)}">${lijn}</span>`;
    html += `<span class="bestemming">${info.bestemming}</span>`;
    html += `<span class="count">${info.bussen.length}×</span>`;
    html += `<span class="chevron">▼</span>`;
    html += `</div>`;
    html += `<div class="bus-lijst" style="max-height:${info.bussen.length * 62}px">`;

    for (const v of info.bussen) {
      const st = statusVan(v);
      const halte = halteTekst(v);
      const sel = renderer.hoveredVehicle?.id === v.id ? ' geselecteerd' : '';
      html += `<div class="bus-item${sel}" data-vid="${v.id}">`;
      html += `<div class="rij"><span><span class="status-dot ${st.cls}"></span><strong>${st.tekst}</strong></span><span>${snelheidTekst(v)}</span></div>`;
      html += halte
        ? `<div class="rij"><span>→ ${halte.naam}</span><span>${halte.afstand}</span></div>`
        : `<div class="rij"><span>${v.bestemming || '—'}</span></div>`;
      html += `<div class="rij zacht"><span>Bus ${v.lbl || '—'}</span><span>${new Date(v.t * 1000).toLocaleTimeString('nl-NL')}</span></div>`;
      html += `</div>`;
    }

    html += `</div></div>`;
  }

  busoverzichtDiv.innerHTML = html;

  busoverzichtDiv.querySelectorAll('.lijn-header').forEach(h => {
    h.addEventListener('click', () => {
      const lijn = h.dataset.lijn;
      if (ingeklapteLijnen.has(lijn)) ingeklapteLijnen.delete(lijn);
      else ingeklapteLijnen.add(lijn);
      updateBusoverzicht();
    });
  });

  busoverzichtDiv.querySelectorAll('.bus-item').forEach(item => {
    item.addEventListener('click', () => {
      const v = vehicles.find(v => v.id === item.dataset.vid);
      if (!v) return;
      const x = v._dispWx !== undefined ? v._dispWx : v._wx;
      const y = v._dispWy !== undefined ? v._dispWy : v._wy;
      if (x === undefined) return;
      renderer.setCenter(x, y, Math.max(renderer.cam.zoom, 2.5));
      renderer.hoveredVehicle = v;
      renderer.onHoverChange?.(v);
    });
  });
}

overzichtKnop.addEventListener('click', () => {
  overzichtOpen = !overzichtOpen;
  busoverzichtDiv.style.display = overzichtOpen ? 'block' : 'none';
  overzichtKnop.classList.toggle('actief', overzichtOpen);
  if (overzichtOpen) {
    lijnFilterOpen = false;
    lijnFilterDiv.style.display = 'none';
    lijnenKnop.classList.remove('actief');
    sluitSteden();
    updateBusoverzicht();
  }
});

// ---------------------------------------------------------------------------
// Bus info popup
// ---------------------------------------------------------------------------

const busInfoDiv = document.getElementById('bus-info');

renderer.onHoverChange = (v) => {
  if (!v) {
    busInfoDiv.style.display = 'none';
    return;
  }

  const kleur = kleurVan(v.lijn);
  const st = statusVan(v);
  const halte = halteTekst(v);
  const bestemming = (v.bestemming || 'Onbekend').replace(/^Groningen, /, '');

  busInfoDiv.innerHTML = `
    <div class="kop">
      <span class="lijn-badge" style="background:${kleur};color:${tekstKleur(kleur)}">${v.lijn || '?'}</span>
      <span class="bestemming">${bestemming}</span>
    </div>
    ${halte ? `<div class="veld volgende">Volgende halte<strong>${halte.naam}</strong><span>${halte.afstand}</span></div>` : ''}
    <div class="veld"><span>Status</span><strong>${st.tekst}</strong></div>
    <div class="veld"><span>Snelheid</span><strong>${snelheidTekst(v)}</strong></div>
    <div class="veld"><span>Voertuig</span><strong>${v.lbl || '—'}</strong></div>
    <div class="veld zacht"><span>Bijgewerkt</span><span>${new Date(v.t * 1000).toLocaleTimeString('nl-NL')}</span></div>
  `;
  busInfoDiv.style.display = 'block';
  volgPopup(v);
};

// Scheepssoorten netjes benoemd voor in de popup
const SCHIP_NAMEN = {
  passagier: 'Passagiersschip',
  sneldienst: 'Sneldienst',
  vracht: 'Vrachtschip',
  tanker: 'Tanker',
  sleepboot: 'Sleepboot',
  visser: 'Vissersschip',
  zeilboot: 'Zeilschip',
  plezier: 'Plezierjacht',
  overig: 'Onbekend type',
};
const SCHIP_KLEUREN = {
  passagier: '#2f8fd0', sneldienst: '#2f8fd0', vracht: '#7d8a99',
  tanker: '#9a6b5a', sleepboot: '#e08a3c', visser: '#5aa06e',
  zeilboot: '#8fb0c4', plezier: '#8fb0c4', overig: '#93a3b0',
};

/** Kompasrichting in woorden: 20° wordt NNO. */
function kompas(graden) {
  if (graden === null || graden === undefined) return null;
  const punten = ['N', 'NNO', 'NO', 'ONO', 'O', 'OZO', 'ZO', 'ZZO',
                  'Z', 'ZZW', 'ZW', 'WZW', 'W', 'WNW', 'NW', 'NNW'];
  return punten[Math.round(graden / 22.5) % 16];
}

renderer.onSchipHover = (schip) => {
  if (!schip) {
    if (!renderer.hoveredVehicle && !renderer.hoveredTrein) busInfoDiv.style.display = 'none';
    return;
  }

  const kleur = SCHIP_KLEUREN[schip.soort] || SCHIP_KLEUREN.overig;
  const naam = schip.naam || `MMSI ${schip.mmsi}`;
  const knopen = schip.snelheid;
  const snelheid = knopen === null || knopen === undefined
    ? '—'
    : `${knopen.toFixed(1)} kn · ${Math.round(knopen * 1.852)} km/u`;
  const richting = schip.koers === null || schip.koers === undefined
    ? '—'
    : `${kompas(schip.koers)} · ${Math.round(schip.koers)}°`;
  const ouderdom = Math.max(0, Math.round(Date.now() / 1000 - schip.t));
  const gemeld = ouderdom < 60 ? `${ouderdom} s geleden` : `${Math.round(ouderdom / 60)} min geleden`;

  busInfoDiv.innerHTML = `
    <div class="kop">
      <span class="lijn-badge" style="background:${kleur};color:${tekstKleur(kleur)}">⚓</span>
      <span class="bestemming">${naam}</span>
    </div>
    ${schip.bestemming ? `<div class="veld volgende">Op weg naar<strong>${schip.bestemming}</strong></div>` : ''}
    <div class="veld"><span>Soort</span><strong>${SCHIP_NAMEN[schip.soort] || SCHIP_NAMEN.overig}</strong></div>
    <div class="veld"><span>Snelheid</span><strong>${snelheid}</strong></div>
    <div class="veld"><span>Koers</span><strong>${richting}</strong></div>
    ${schip.lengte ? `<div class="veld"><span>Lengte</span><strong>${schip.lengte} m</strong></div>` : ''}
    <div class="veld zacht"><span>MMSI ${schip.mmsi}</span><span>${gemeld}</span></div>
  `;
  busInfoDiv.style.display = 'block';
  volgPopup(schip);
};

// Treinsoorten netjes benoemd voor in de popup
const TREIN_NAMEN = {
  intercity: 'Intercity',
  sprinter: 'Sprinter',
  trein: 'Trein',
};
const TREIN_KLEUREN = {
  intercity: '#003082',
  sprinter: '#ffc917',
  trein: '#5a6472',
};

// Herkomst en bestemming zitten niet in de positiefeed, dus die halen we
// pas op als je een trein aanwijst. Wat binnen is bewaren we hier, zodat
// hetzelfde treinnummer geen tweede navraag oplevert.
const ritten = new Map();

function ritOphalen(nummer) {
  if (ritten.has(nummer)) return;
  ritten.set(nummer, null);   // bezet, zodat er niet twee tegelijk gaan
  fetch(`/api/treinen/rit?nummer=${encodeURIComponent(nummer)}`)
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      ritten.set(nummer, d && !d.onbekend && !d.uit ? d : false);
      // Nog steeds dezelfde trein onder de muis? Dan de popup bijwerken.
      if (renderer.hoveredTrein?.nummer === nummer) toonTrein(renderer.hoveredTrein);
    })
    .catch(() => ritten.set(nummer, false));
}

function toonTrein(trein) {
  const kleur = TREIN_KLEUREN[trein.soort] || TREIN_KLEUREN.trein;
  const kmu = trein.snelheid;
  const snelheid = kmu === null || kmu === undefined ? '—' : `${Math.round(kmu)} km/u`;
  const richting = trein.koers === null || trein.koers === undefined
    ? '—'
    : `${kompas(trein.koers)} · ${Math.round(trein.koers)}°`;
  const ouderdom = Math.max(0, Math.round(Date.now() / 1000 - trein.t));
  const gemeld = ouderdom < 60 ? `${ouderdom} s geleden` : `${Math.round(ouderdom / 60)} min geleden`;

  const rit = ritten.get(trein.nummer);
  const soortNaam = (rit && rit.soort) || TREIN_NAMEN[trein.soort] || TREIN_NAMEN.trein;
  let heen = '';
  if (rit === undefined || rit === null) {
    heen = `<div class="veld volgende">Naar<strong>…</strong></div>`;
  } else if (rit && rit.bestemming) {
    heen = `<div class="veld volgende">Naar<strong>${rit.bestemming}</strong></div>`;
  }

  busInfoDiv.innerHTML = `
    <div class="kop">
      <span class="lijn-badge" style="background:${kleur};color:${tekstKleur(kleur)}">${trein.nummer}</span>
      <span class="bestemming">${soortNaam}</span>
    </div>
    ${heen}
    ${rit && rit.herkomst ? `<div class="veld"><span>Vanaf</span><strong>${rit.herkomst}</strong></div>` : ''}
    <div class="veld"><span>Snelheid</span><strong>${snelheid}</strong></div>
    <div class="veld"><span>Koers</span><strong>${richting}</strong></div>
    ${rit && rit.stops ? `<div class="veld"><span>Stops</span><strong>${rit.stops}</strong></div>` : ''}
    <div class="veld zacht"><span>Trein ${trein.nummer}</span><span>${gemeld}</span></div>
  `;
  busInfoDiv.style.display = 'block';
  volgPopup(trein);
}

renderer.onTreinHover = (trein) => {
  if (!trein) {
    if (!renderer.hoveredVehicle && !renderer.hoveredSchip) busInfoDiv.style.display = 'none';
    return;
  }
  ritOphalen(trein.nummer);
  toonTrein(trein);
};

/** De popup blijft aan de bus, het schip of de trein hangen terwijl die doorbeweegt. */
function volgPopup(v) {
  if (busInfoDiv.style.display === 'none') return;
  const x = v._sx, y = v._sy;
  if (x === undefined) return;
  const breedte = busInfoDiv.offsetWidth || 210;
  const hoogte = busInfoDiv.offsetHeight || 120;
  busInfoDiv.style.left = Math.max(8, Math.min(x + 18, window.innerWidth - breedte - 8)) + 'px';
  busInfoDiv.style.top = Math.max(8, Math.min(y - hoogte - 14, window.innerHeight - hoogte - 8)) + 'px';
}

// ---------------------------------------------------------------------------
// Kleurhulpje — donkere of lichte tekst op een gekleurd badge
// ---------------------------------------------------------------------------

function tekstKleur(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 0.299 + g * 0.587 + b * 0.114) > 150 ? '#2b3038' : '#ffffff';
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

document.getElementById('thema-knop').addEventListener('click', () => {
  const newTheme = renderer.theme === 'light' ? 'dark' : 'light';
  renderer.setTheme(newTheme);
  document.getElementById('thema-knop').textContent = newTheme === 'light' ? '☀' : '☾';
});

// ---------------------------------------------------------------------------
// Kantelregelaar
// ---------------------------------------------------------------------------

const kantelSlider = document.getElementById('kantel-slider');
const kantelHoek = document.getElementById('kantel-hoek');

/** De indrukfactor is de sinus van de kijkhoek — die tonen we in graden. */
function toonHoek(tilt) {
  kantelHoek.textContent = `${Math.round(Math.asin(tilt) * 180 / Math.PI)}°`;
}

kantelSlider.value = renderer.tiltVoorkeur;
toonHoek(renderer.tiltVoorkeur);

kantelSlider.addEventListener('input', () => {
  const tilt = parseFloat(kantelSlider.value);
  renderer.setTilt(tilt);
  toonHoek(renderer.tiltVoorkeur);
});

// ---------------------------------------------------------------------------
// Geolocatie
// ---------------------------------------------------------------------------

document.getElementById('locatie-knop').addEventListener('click', () => {
  if (!navigator.geolocation || !renderer.center) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    const center = renderer.center;
    const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
    const wx = (pos.coords.longitude - center.lon) * n * R * cosLat;
    const wy = -(pos.coords.latitude - center.lat) * n * R;
    renderer.setCenter(wx, wy, Math.max(renderer.cam.zoom, 2));
  }, (err) => {
    console.warn('Geolocatie niet beschikbaar:', err);
  });
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

window.__renderer = renderer;

async function start() {
  updateKlok();
  setInterval(updateKlok, 1000);

  await loadMap();
  await laadPlaatsen();
  // Stations verschuiven niet en hangen niet aan de buslijnen; meteen
  // ophalen, niet pas na de 12 MB lijnengeometrie.
  laadStations();
  bootProgress(70, 'Realtime data ophalen…');

  await pollVehicles(true);
  bootProgress(95, 'Klaar…');

  renderLoop();
  await lijnenGeladen;   // de opening mikt op het busstation, dus haltes nodig
  startOpening();
  setInterval(() => pollVehicles(), 20000);

  // Schepen: eigen tempo, want die stroom loopt los van de GTFS-feed
  pollSchepen();
  setInterval(pollSchepen, 15000);

  // Treinen: de backend ververst elke 5s bij de NS, dus even vaak navragen.
  pollTreinen();
  setInterval(pollTreinen, 5000);

  // De zijbalk toont afstanden tot de volgende halte — die lopen mee.
  setInterval(() => { if (overzichtOpen) updateBusoverzicht(); }, 5000);
  // Beide overzichten zijn gefilterd op het zichtbare kaartgebied, dat
  // verandert door pannen/zoomen zonder dat er nieuwe voertuigdata is.
  setInterval(() => { if (lijnFilterOpen) updateLijnFilter(); }, 5000);

  hideBoot();
}

start();
