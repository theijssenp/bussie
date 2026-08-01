// ============================================================
// Bussie — Tegels laden en decoderen
// Kaartdata komt binnen als binaire tegels (zie backend/tegels.py).
// Alleen wat in beeld is wordt opgehaald en in het geheugen gehouden.
// ============================================================

const MAGIC = 0x31475442; // 'BTG1' little-endian gelezen als uint32
const SOORTEN = ['water', 'green', 'streets', 'buildings'];

/** Vaste ruiswaarde 0..1 uit een coördinaat — zelfde plek, zelfde kleur. */
function hashPositie(x, y) {
  let h = Math.imul(Math.round(x) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y) | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Zet één binaire tegel om naar tekenbare vormen. Coördinaten worden
 * meteen naar wereldmeters gerekend en in Float32Array's gezet: dat scheelt
 * geheugen en voorkomt dat er per frame objecten gemaakt worden.
 */
export function decodeerTegel(buffer, tintenAantal = 6) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Geen geldige tegel');

  const niveau = dv.getUint8(4);
  const tx = dv.getInt32(5, true);
  const ty = dv.getInt32(9, true);
  const grootte = dv.getFloat32(13, true);
  const schaal = dv.getFloat32(17, true);
  const lagenAantal = dv.getUint8(21);

  const vx = tx * grootte;
  const vy = ty * grootte;

  const tegel = {
    niveau, tx, ty, grootte, schaal,
    minX: vx, minY: vy, maxX: vx + grootte, maxY: vy + grootte,
    diep: vx + vy,
    water: [], green: [], streets: [], buildings: [],
    punten: 0,
  };

  let o = 22;
  for (let l = 0; l < lagenAantal; l++) {
    const soort = SOORTEN[dv.getUint8(o)];
    const aantal = dv.getUint32(o + 1, true);
    o += 5;
    const lijst = tegel[soort];

    for (let e = 0; e < aantal; e++) {
      const punten = dv.getUint16(o, true);
      const waarde = dv.getUint16(o + 2, true);
      o += 4;

      const pts = new Float32Array(punten * 2);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < punten; i++) {
        const x = vx + dv.getInt16(o, true) * schaal;
        const y = vy + dv.getInt16(o + 2, true) * schaal;
        o += 4;
        pts[i * 2] = x;
        pts[i * 2 + 1] = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      tegel.punten += punten;

      const el = { pts, waarde, minX, minY, maxX, maxY };
      if (soort === 'buildings') {
        // Hoogte in meters, plus een vaste tint uit de eigen positie
        el.hoogte = waarde / 10;
        el.diep = maxX + maxY;
        const omvang = Math.max(maxX - minX, maxY - minY);
        const formaat = omvang < 14 ? 0 : omvang < 34 ? 1 : 2;
        const ruis = hashPositie(minX, minY);
        el.tint = formaat * tintenAantal + Math.min(tintenAantal - 1, (ruis * tintenAantal) | 0);
      } else if (soort === 'streets') {
        el.breedte = waarde / 10;
      }
      lijst.push(el);
    }
  }

  // Gebouwen van achter naar voren, zodat gevels elkaar goed overlappen
  tegel.buildings.sort((a, b) => a.diep - b.diep);

  return tegel;
}

/**
 * Houdt bij welke tegels er zijn, welke geladen zijn en welke nog onderweg.
 * De renderer vraagt per frame welke tegels hij mag tekenen; wat ontbreekt
 * wordt op de achtergrond opgehaald.
 */
export class TegelBron {
  constructor(basisPad = '/data/tegels', opties = {}) {
    this.basisPad = basisPad;
    this.index = null;
    this.niveaus = [];
    this.aanwezig = [];           // per niveau een Set met "tx,ty"
    this.cache = new Map();       // "niveau/tx/ty" → tegel
    this.bezig = new Set();
    this.wachtrij = [];
    this.maxGelijktijdig = opties.maxGelijktijdig || 6;
    this.maxTegels = opties.maxTegels || 240;
    this.tintenAantal = opties.tintenAantal || 6;
    this.labelVanaf = opties.labelVanaf ?? 3;   // vanaf dit niveau zijn er straatnamen
    this.opGeladen = null;        // callback voor de renderer
    this.statistiek = { geladen: 0, bytes: 0, mislukt: 0 };
  }

  async laadIndex() {
    const resp = await fetch(`${this.basisPad}/index.json`);
    if (!resp.ok) throw new Error(`Tegelindex niet beschikbaar (HTTP ${resp.status})`);
    this.index = await resp.json();
    this.niveaus = this.index.niveaus || [];
    this.bouw = this.index.bouw ? `?v=${this.index.bouw}` : '';
    this.aanwezig = this.niveaus.map(n => new Set(
      (this.index.tegels?.[String(n.niveau)] || []).map(([x, y]) => `${x},${y}`)
    ));
    return this.index;
  }

  get center() {
    return this.index?.center || null;
  }

  /** Grofste niveau is 0; hoe verder ingezoomd, hoe hoger het niveau. */
  niveauVoor(detail) {
    const drempels = [0.18, 0.35, 0.7, 1.3];
    let niveau = 0;
    for (const d of drempels) {
      if (detail >= d) niveau++;
    }
    return Math.min(niveau, this.niveaus.length - 1);
  }

  /**
   * De tegels die dit beeld nodig heeft. Wat klaarstaat komt terug, wat
   * ontbreekt wordt in de wachtrij gezet. Ontbrekende tegels worden zo
   * mogelijk opgevuld met een grover niveau dat al in het geheugen zit.
   */
  zichtbaar(niveau, bounds) {
    const info = this.niveaus[niveau];
    if (!info) return [];
    const g = info.grootte;
    const tx0 = Math.floor(bounds.minX / g), tx1 = Math.floor(bounds.maxX / g);
    const ty0 = Math.floor(bounds.minY / g), ty1 = Math.floor(bounds.maxY / g);

    const klaar = [];
    const nu = performance.now();
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (!this.aanwezig[niveau]?.has(`${tx},${ty}`)) continue;
        const sleutel = `${niveau}/${tx}/${ty}`;
        const tegel = this.cache.get(sleutel);
        if (tegel) {
          tegel.gezien = nu;
          klaar.push(tegel);
          continue;
        }
        this._zetInWachtrij(niveau, tx, ty);
        const grover = this._grovereVersie(niveau, tx, ty, g);
        if (grover && !klaar.includes(grover)) {
          grover.gezien = nu;
          klaar.push(grover);
        }
      }
    }
    this._verwerkWachtrij();
    return klaar.sort((a, b) => a.diep - b.diep);
  }

  /** Zoek een al geladen tegel van een grover niveau die dit gebied dekt. */
  _grovereVersie(niveau, tx, ty, grootte) {
    const wx = tx * grootte, wy = ty * grootte;
    for (let n = niveau - 1; n >= 0; n--) {
      const g = this.niveaus[n]?.grootte;
      if (!g) continue;
      const sleutel = `${n}/${Math.floor(wx / g)}/${Math.floor(wy / g)}`;
      const tegel = this.cache.get(sleutel);
      if (tegel) return tegel;
    }
    return null;
  }

  _zetInWachtrij(niveau, tx, ty) {
    const sleutel = `${niveau}/${tx}/${ty}`;
    if (this.bezig.has(sleutel) || this.cache.has(sleutel)) return;
    if (this.wachtrij.some(t => t.sleutel === sleutel)) return;
    this.wachtrij.push({ sleutel, niveau, tx, ty });
  }

  _verwerkWachtrij() {
    while (this.bezig.size < this.maxGelijktijdig && this.wachtrij.length) {
      const taak = this.wachtrij.shift();
      this._laad(taak);
    }
  }

  async _laad({ sleutel, niveau, tx, ty }) {
    this.bezig.add(sleutel);
    try {
      const resp = await fetch(`${this.basisPad}/${niveau}/${tx}/${ty}.btg${this.bouw}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      const tegel = decodeerTegel(buffer, this.tintenAantal);
      tegel.gezien = performance.now();
      this.cache.set(sleutel, tegel);
      if (niveau >= this.labelVanaf) this._laadNamen(tegel, niveau, tx, ty);
      this.statistiek.geladen++;
      this.statistiek.bytes += buffer.byteLength;
      this._ruimOp();
      this.opGeladen?.(tegel);
    } catch (e) {
      this.statistiek.mislukt++;
      // Niet nog eens proberen zolang de index zegt dat hij zou moeten bestaan
      this.aanwezig[niveau]?.delete(`${tx},${ty}`);
      console.warn(`Tegel ${sleutel} laden mislukt:`, e.message);
    } finally {
      this.bezig.delete(sleutel);
      this._verwerkWachtrij();
    }
  }

  /**
   * Straatnamen horen bij een tegel maar zitten in een eigen bestand: zo
   * blijft het tegelformaat puur geometrie en laden namen alleen waar ze
   * getoond worden. Komt er niets, dan heeft die tegel simpelweg geen namen.
   */
  async _laadNamen(tegel, niveau, tx, ty) {
    try {
      const resp = await fetch(`${this.basisPad}/${niveau}/${tx}/${ty}.lbl${this.bouw}`);
      if (!resp.ok) return;
      const data = await resp.json();
      tegel.namen = (data.n || []).map(([naam, x, y, hoek]) => ({ naam, x, y, hoek }));
      this.opGeladen?.(tegel);
    } catch (e) {
      /* geen namen voor deze tegel */
    }
  }

  /** Oudste tegels weggooien als het er te veel worden. */
  _ruimOp() {
    if (this.cache.size <= this.maxTegels) return;
    const opLeeftijd = [...this.cache.entries()].sort((a, b) => (a[1].gezien || 0) - (b[1].gezien || 0));
    const weg = this.cache.size - this.maxTegels;
    for (let i = 0; i < weg; i++) this.cache.delete(opLeeftijd[i][0]);
  }
}
