// ============================================================
// Bussie — Lijnroutes uitpakken
// De lijnen komen binnen in het binaire BLN1-formaat (zie
// backend/lijn_routes.py). Als JSON was dit 20 MB tekst om te ontleden;
// binair is het 5 MB die we hier in één keer doorlopen.
// ============================================================

const MAGIC = 0x324e4c42; // 'BLN2' little-endian gelezen als uint32
const SPRONG = -32768;    // dx == dy == dit: er volgt een absolute positie

/**
 * Zet de binaire lijnroutes om naar de vorm die de renderer verwacht:
 * punten als [x, y]-paren in meters, haltes met naam en afstand langs
 * de route. De haltetabel staat één keer in het bestand; de routes
 * verwijzen er met een index naar.
 */
export function decodeerLijnen(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Geen geldige lijnenbundel');

  const tekstlezer = new TextDecoder('utf-8');
  const bytes = new Uint8Array(buffer);
  let o = 4;

  function tekst() {
    const n = dv.getUint8(o);
    o += 1;
    const s = tekstlezer.decode(bytes.subarray(o, o + n));
    o += n;
    return s;
  }

  const halteAantal = dv.getUint32(o, true);
  o += 4;
  const haltetabel = new Array(halteAantal);
  for (let i = 0; i < halteAantal; i++) {
    const id = tekst();
    const naam = tekst();
    const x = dv.getInt32(o, true) / 10;
    const y = dv.getInt32(o + 4, true) / 10;
    o += 8;
    haltetabel[i] = { id, naam, x, y };
  }

  const lijnAantal = dv.getUint32(o, true);
  o += 4;
  const lijnen = new Array(lijnAantal);

  for (let l = 0; l < lijnAantal; l++) {
    const lijn = tekst();
    const richting = dv.getUint8(o);
    o += 1;
    const naam = tekst();
    const bestemming = tekst();
    const kleur = '#' + [bytes[o], bytes[o + 1], bytes[o + 2]]
      .map(c => c.toString(16).padStart(2, '0')).join('');
    o += 3;

    // Het shape_id van deze vorm: hiermee koppelt de kaart een bus aan de
    // route van zijn eigen rit in plaats van aan de hoofdvorm van de lijn.
    const sid = tekst();

    const ridAantal = dv.getUint8(o);
    o += 1;
    const rids = new Array(ridAantal);
    for (let i = 0; i < ridAantal; i++) rids[i] = tekst();

    // Punten staan als verschil met hun voorganger, in decimeters
    const puntAantal = dv.getUint32(o, true);
    o += 4;
    const pts = new Array(puntAantal);
    let qx = 0, qy = 0;
    for (let i = 0; i < puntAantal; i++) {
      if (i === 0) {
        qx = dv.getInt32(o, true);
        qy = dv.getInt32(o + 4, true);
        o += 8;
      } else {
        const dx = dv.getInt16(o, true);
        const dy = dv.getInt16(o + 2, true);
        o += 4;
        if (dx === SPRONG && dy === SPRONG) {
          qx = dv.getInt32(o, true);
          qy = dv.getInt32(o + 4, true);
          o += 8;
        } else {
          qx += dx;
          qy += dy;
        }
      }
      pts[i] = [qx / 10, qy / 10];
    }

    const eigenAantal = dv.getUint16(o, true);
    o += 2;
    const haltes = new Array(eigenAantal);
    for (let i = 0; i < eigenAantal; i++) {
      const h = haltetabel[dv.getUint32(o, true)];
      haltes[i] = { id: h.id, naam: h.naam, x: h.x, y: h.y, d: dv.getUint32(o + 4, true) / 10 };
      o += 8;
    }

    lijnen[l] = { lijn, richting, naam, bestemming, kleur, sid, rids, pts, haltes };
  }

  return lijnen;
}
