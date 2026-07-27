// ============================================================
// Bussie — App logic
// Koppelt de renderer aan de backend API.
// ============================================================

import { IsoRenderer } from './kaart.js';

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
// Map data laden
// ---------------------------------------------------------------------------

bootProgress(10, 'Kaartdata laden…');

let mapData = null;
let vehicles = [];
let activeLines = new Map(); // lijn → {bestemming, count}

async function loadMap() {
  try {
    const resp = await fetch('/data/groningen.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    mapData = await resp.json();
    renderer.setMapData(mapData);
    bootProgress(40, 'Route traces laden…');

    // Laad GPS traces voor snapping (niet voor route-weergave)
    // De kaart toont altijd de officiële GTFS routes
    try {
      const traceResp = await fetch('/api/traces');
      if (traceResp.ok) {
        const traces = await traceResp.json();
        if (Object.keys(traces).length > 0) {
          renderer.routeTraces = traces;
          console.log(`${Object.keys(traces).length} lijnen met GPS traces geladen voor snapping`);
        }
      }
    } catch (e) {
      console.warn('Route traces laden mislukt:', e);
    }

    bootProgress(50, 'Voertuigen laden…');
  } catch (err) {
    bootMsg.textContent = 'Kaartdata niet beschikbaar';
    console.error('Kaartdata laden mislukt:', err);
  }
}

// ---------------------------------------------------------------------------
// Realtime polling
// ---------------------------------------------------------------------------

// Laatst bekende data_ts om buffer-resets te voorkomen
let lastDataTs = 0;

async function pollVehicles(initial) {
  try {
    const url = initial ? '/api/voertuigen/db?history=2' : '/api/voertuigen/db';
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();

    // Check of data écht veranderd is — voorkomt buffer-reset bij identieke data
    if (!initial && data.data_ts && data.data_ts === lastDataTs) {
      // Data niet veranderd — update alleen de klok, niet de buffer
      document.getElementById('laden').textContent =
        `${vehicles.length} bussen live · bijgewerkt ${new Date().toLocaleTimeString('nl-NL')}`;
      return;
    }
    lastDataTs = data.data_ts || 0;
    vehicles = data.voertuigen || [];

    // Bij initiële load: historische posities gebruiken voor directe buffer
    const pollTime = Date.now() / 1000;
    for (const v of vehicles) {
      v._pollT = pollTime;
      // Koppel de 1-na-laatste positie voor directe buffer
      if (initial && data.historie && data.historie[v.id]) {
        const h = data.historie[v.id];
        // Zet prev via _prevWx/_prevWy (worden later door updateBuffer gebruikt)
        v._historyLat = h.lat;
        v._historyLon = h.lon;
        v._historyT = h.t;
      }
    }

    // Eerst posities berekenen (zet _wx/_wy op vehicles)
    renderer.vehicles = vehicles;
    renderer.updateVehiclePositions();

    // Bij initiële load: buffer direct vullen met prev uit historie
    if (initial) {
      for (const v of vehicles) {
        if (v._historyLat !== undefined && v._historyLon !== undefined && v._wx !== undefined) {
          const center = renderer.mapData?.center;
          if (center) {
            const R = 6378137, n = Math.PI / 180, cosLat = Math.cos(center.lat * n);
            const hx = (v._historyLon - center.lon) * n * R * cosLat;
            const hy = -(v._historyLat - center.lat) * n * R;
            // Zet direct een buffer entry met prev én cur
            const buf = renderer._vehicleBuffer;
            if (buf) {
              buf.set(v.id, {
                prev: { x: hx, y: hy, t: v._historyT },
                cur: { x: v._wx, y: v._wy, t: pollTime },
                interpStart: pollTime,
              });
            }
          }
        }
      }
    }

    // Daarna buffer updaten met de berekende posities
    renderer.updateBuffer();

    // Update lijnfilter
    activeLines.clear();
    for (const v of vehicles) {
      const lijn = v.lijn || '?';
      if (!activeLines.has(lijn)) {
        activeLines.set(lijn, { bestemming: v.bestemming || '', count: 0 });
      }
      activeLines.get(lijn).count++;
    }
    updateLijnFilter();
    updateBusoverzicht();

    // Status
    document.getElementById('laden').textContent =
      `${vehicles.length} bussen live · bijgewerkt ${new Date().toLocaleTimeString('nl-NL')}`;
  } catch (err) {
    console.error('Pollen mislukt:', err);
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function renderLoop() {
  renderer.render();
  requestAnimationFrame(renderLoop);
}

// ---------------------------------------------------------------------------
// Klok
// ---------------------------------------------------------------------------

function updateKlok() {
  const now = new Date();
  const t = now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('klok').textContent = t;
}

// ---------------------------------------------------------------------------
// Lijnfilter
// ---------------------------------------------------------------------------

const lijnFilterDiv = document.getElementById('lijn-filter');
const lijnenKnop = document.getElementById('lijnen-knop');
let lijnFilterOpen = false;

function updateLijnFilter() {
  const lijnen = [...activeLines.entries()].sort((a, b) => {
    // Sorteer numeriek waar mogelijk
    const an = parseInt(a[0]);
    const bn = parseInt(b[0]);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return a[0].localeCompare(b[0]);
  });

  lijnFilterDiv.innerHTML = lijnen.map(([lijn, info]) => {
    const verborgen = renderer.filteredLines.size > 0 && !renderer.filteredLines.has(lijn);
    return `<div class="lijn-item ${verborgen ? 'verborgen' : ''}" data-lijn="${lijn}">
      <span class="lijn-badge">${lijn}</span>
      <span class="lijn-naam">${info.bestemming} (${info.count})</span>
    </div>`;
  }).join('');

  // Click handlers
  lijnFilterDiv.querySelectorAll('.lijn-item').forEach(item => {
    item.addEventListener('click', () => {
      const lijn = item.dataset.lijn;
      if (renderer.filteredLines.has(lijn)) {
        renderer.filteredLines.delete(lijn);
      } else {
        renderer.filteredLines.add(lijn);
      }
      // Als alles uit staat → reset (toon alles)
      if (renderer.filteredLines.size === activeLines.size) {
        renderer.filteredLines.clear();
      }
      updateLijnFilter();
    });
  });
}

lijnenKnop.addEventListener('click', () => {
  lijnFilterOpen = !lijnFilterOpen;
  lijnFilterDiv.style.display = lijnFilterOpen ? 'block' : 'none';
  lijnenKnop.classList.toggle('actief', lijnFilterOpen);
  // Sluit busoverzicht als we lijnfilter openen
  if (lijnFilterOpen) {
    overzichtOpen = false;
    busoverzichtDiv.style.display = 'none';
    overzichtKnop.classList.remove('actief');
  }
});

// ---------------------------------------------------------------------------
// Busoverzicht zijbalk
// ---------------------------------------------------------------------------

const busoverzichtDiv = document.getElementById('busoverzicht');
const overzichtKnop = document.getElementById('overzicht-knop');
let overzichtOpen = false;
let ingeklapteLijnen = new Set(); // welke lijn-groepen zijn ingeklapt

function statusTekst(v) {
  if (v.st === 1) return { tekst: 'bij halte', cls: 'halte' };
  if (v.st === 0) return { tekst: 'aankomend', cls: 'aankomend' };
  return { tekst: 'rijdt', cls: 'rijdt' };
}

function snelheidTekst(v) {
  const speedMs = v._calcSpeed !== undefined ? v._calcSpeed : v.snelheid;
  if (speedMs !== null && speedMs !== undefined) {
    return `${Math.round(speedMs * 3.6)} km/u`;
  }
  return '—';
}

function updateBusoverzicht() {
  if (!vehicles || vehicles.length === 0) {
    busoverzichtDiv.innerHTML = '<div class="header">Geen bussen</div>';
    return;
  }

  // Groepeer bussen per lijn
  const perLijn = new Map();
  for (const v of vehicles) {
    const lijn = v.lijn || '?';
    if (!perLijn.has(lijn)) {
      perLijn.set(lijn, { bestemming: v.bestemming || '', bussen: [] });
    }
    perLijn.get(lijn).bussen.push(v);
  }

  // Sorteer lijnen numeriek
  const lijnen = [...perLijn.entries()].sort((a, b) => {
    const an = parseInt(a[0]);
    const bn = parseInt(b[0]);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return a[0].localeCompare(b[0]);
  });

  // Bouw HTML
  let html = `<div class="header">Busoverzicht <span class="aantal">${vehicles.length} bussen · ${lijnen.length} lijnen</span></div>`;

  for (const [lijn, info] of lijnen) {
    const ingeklapt = ingeklapteLijnen.has(lijn);
    const maxH = info.bussen.length * 60;

    html += `<div class="lijn-groep${ingeklapt ? ' ingeklapt' : ''}" data-lijn="${lijn}">`;
    html += `<div class="lijn-header" data-lijn="${lijn}">`;
    html += `<span class="lijn-badge">${lijn}</span>`;
    html += `<span class="bestemming">${info.bestemming}</span>`;
    html += `<span class="count">${info.bussen.length}x</span>`;
    html += `<span class="chevron">▼</span>`;
    html += `</div>`;
    html += `<div class="bus-lijst" style="max-height:${maxH}px">`;

    for (const v of info.bussen) {
      const st = statusTekst(v);
      const sel = renderer.hoveredVehicle && renderer.hoveredVehicle.id === v.id ? ' geselecteerd' : '';
      html += `<div class="bus-item${sel}" data-vid="${v.id}">`;
      html += `<div class="rij"><span><span class="status-dot ${st.cls}"></span><strong>${st.tekst}</strong></span><span>${snelheidTekst(v)}</span></div>`;
      html += `<div class="rij"><span>Voertuig ${v.lbl || '—'}</span><span>${v.bestemming || '—'}</span></div>`;
      html += `<div class="rij"><span>Bijgewerkt ${new Date(v.t * 1000).toLocaleTimeString('nl-NL')}</span></div>`;
      html += `</div>`;
    }

    html += `</div></div>`;
  }

  busoverzichtDiv.innerHTML = html;

  // Click handlers voor lijn headers (uitklappen/inklappen)
  busoverzichtDiv.querySelectorAll('.lijn-header').forEach(h => {
    h.addEventListener('click', () => {
      const lijn = h.dataset.lijn;
      if (ingeklapteLijnen.has(lijn)) {
        ingeklapteLijnen.delete(lijn);
      } else {
        ingeklapteLijnen.add(lijn);
      }
      updateBusoverzicht();
    });
  });

  // Click handlers voor bus items (centreer kaart op bus)
  busoverzichtDiv.querySelectorAll('.bus-item').forEach(item => {
    item.addEventListener('click', () => {
      const vid = item.dataset.vid;
      const v = vehicles.find(v => v.id === vid);
      if (v && v._wx !== undefined) {
        renderer.setCenter(v._wx, v._wy, Math.max(renderer.cam.zoom, 2.5));
        renderer.hoveredVehicle = v;
        renderer.onHoverChange?.(v);
      }
    });
  });
}

overzichtKnop.addEventListener('click', () => {
  overzichtOpen = !overzichtOpen;
  busoverzichtDiv.style.display = overzichtOpen ? 'block' : 'none';
  overzichtKnop.classList.toggle('actief', overzichtOpen);
  // Sluit lijnfilter als we overzicht openen
  if (overzichtOpen) {
    lijnFilterOpen = false;
    lijnFilterDiv.style.display = 'none';
    lijnenKnop.classList.remove('actief');
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

  const speedMs = v._calcSpeed !== undefined ? v._calcSpeed : v.snelheid;
  const snelheidTekst = speedMs !== null && speedMs !== undefined
    ? `${Math.round(speedMs * 3.6)} km/u`
    : '—';
  const bearingVal = v._calcBearing !== undefined ? v._calcBearing : v.bearing;
  const richtingTekst = bearingVal !== null && bearingVal !== undefined
    ? `${bearingVal}°`
    : '—';
  // Status via buffer (0=stilstaand, 2=onderweg, zoals buffer berekent)
  const statusTekst = speedMs > 1 ? 'onderweg' : 'bij halte';

  busInfoDiv.innerHTML = `
    <div class="lijn-badge">Lijn ${v.lijn || '?'}</div>
    <div class="veld"><strong>${v.bestemming || 'Onbekend'}</strong></div>
    <div class="veld">Status: ${statusTekst}</div>
    <div class="veld">Snelheid: ${snelheidTekst}</div>
    <div class="veld">Richting: ${richtingTekst}</div>
    <div class="veld">Voertuig: ${v.lbl || v.id}</div>
    <div class="veld">Bijgewerkt: ${new Date(v.t * 1000).toLocaleTimeString('nl-NL')}</div>
  `;

  // Positie popup op basis van getoonde buspositie (_dispWx = interpolatie + snapping)
  if (v._dispWx !== undefined && v._dispWy !== undefined) {
    const p = renderer.worldToScreen(v._dispWx, v._dispWy);
    busInfoDiv.style.left = Math.min(p.x + 15, window.innerWidth - 220) + 'px';
    busInfoDiv.style.top = Math.max(p.y - 60, 16) + 'px';
    busInfoDiv.style.display = 'block';
  }
};

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

document.getElementById('thema-knop').addEventListener('click', () => {
  const newTheme = renderer.theme === 'light' ? 'dark' : 'light';
  renderer.setTheme(newTheme);
  document.getElementById('thema-knop').textContent = newTheme === 'light' ? '☀' : '☾';
});

// ---------------------------------------------------------------------------
// Geolocatie
// ---------------------------------------------------------------------------

document.getElementById('locatie-knop').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    if (!mapData) return;

    // Converteer naar world meters
    const center = mapData.center;
    const latM = 111320.0;
    const lonM = 111320.0 * Math.cos(center.lat * Math.PI / 180);
    const wx = (lon - center.lon) * lonM;
    const wy = -(lat - center.lat) * latM;

    renderer.setCenter(wx, wy, Math.max(renderer.cam.zoom, 1.5));
  }, (err) => {
    console.warning('Geolocatie niet beschikbaar:', err);
  });
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Expose for debugging
window.__renderer = renderer;

async function start() {
  updateKlok();
  setInterval(updateKlok, 1000);

  await loadMap();
  bootProgress(55, 'Realtime data ophalen…');

  await pollVehicles(true);
  bootProgress(90, 'Klaar…');

  // Start render loop
  renderLoop();

  // Start polling (elke 20 seconden — eigen datalaag, geen externe API load)
  setInterval(() => pollVehicles(), 20000);

  hideBoot();
}

start();