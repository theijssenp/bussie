// ============================================================
// Bussie — Een trein volgen langs zijn route
//
// De NS-positiefeed is grillig. Een paar minuten meekijken leert:
//  - een positie wordt onregelmatig ververst: een stap van tien seconden
//    rijden, dan eentje van één seconde, dan twee rondes niets;
//  - soms komt een oudere peiling nog eens langs, zodat de trein een paar
//    honderd meter terugspringt en daarna weer vooruit;
//  - een positie kan minutenlang bevriezen terwijl de snelheid 120 zegt,
//    met een onzekerheidsstraal die elke ronde meegroeit;
//  - na een hiaat staat de trein ineens kilometers verder.
// Een beeld dat elke peiling letterlijk neemt springt dus. Hier laten we
// de trein daarom gewoon rijden — met zijn gemelde snelheid, langs zijn
// route — en gebruiken we de peilingen alleen om hem zachtjes bij te
// sturen. Alles is eendimensionaal: afstand langs de route (m) en tijd
// (s, op de klok van de server).
//
// Los van de kaart gehouden, zodat het zonder browser te testen is.
// ============================================================

// Verder dan dit (m) van waar we hem verwachtten: een nieuwe rit of een
// hiaat in de feed, dan zetten we hem over in plaats van te glijden.
export const SPRONG = 1500;
// Een peiling die verder dan dit (m) achter de vorige ligt is meestal een
// oude peiling die de feed nog eens serveert; pas na TERUG_ECHT keer op
// rij geloven we dat hij echt achteruit rijdt.
export const TERUG = 40;
export const TERUG_ECHT = 3;
// Staat de trein stil, dan wiebelt zijn GPS tot ruim honderd meter; binnen
// deze afstand (m) blijft hij dan staan waar hij stond.
export const RUIS = 150;
// Boven deze onzekerheidsstraal (m) zegt een positie niets meer: we
// rekenen door op de vorige peiling.
export const ONZEKER = 1500;
// Zo lang (s) rijden we door op een peiling zonder opvolger; daarna staat
// hij stil tot er weer iets binnenkomt.
export const DOORREKENEN = 120;
// Bijsturing: het verschil tussen beeld en peiling is na zoveel seconden
// grotendeels weggewerkt. Korter volgt strakker maar pulseert mee met de
// onregelmatige peilingen; langer loopt verder achter bij een echte
// snelheidswissel.
export const VOLGTIJD = 12;
// Een positie is al een paar seconden oud als we hem voor het eerst zien.
// Uit de afgelegde afstand sinds de vorige peiling rekenen we terug wanneer
// hij echt was, hooguit zoveel seconden vóór het moment van zien.
export const MAX_VOORSPRONG = 15;
// Zoveel keer harder dan gemeld mag het beeld rijden om een achterstand in
// te halen, en nooit achteruit.
export const HARDER = 1.5;
// Een trein rijdt zijn volgende halte niet voorbij zolang we geen peiling
// hebben die dat zegt: tot zoveel meter erna rekenen we door.
export const HALTE_MARGE = 30;
// De onzekerheidsstraal van een verse peiling groeit mee met de snelheid:
// ongeveer zoveel keer de afstand die de trein sinds de peiling aflegde.
// Daaruit schatten we bij de eerste peiling hoe oud hij al is, zodat de
// trein niet eerst twintig seconden hoeft in te halen.
export const NAUW_PER_METER = 1.2;

export class TreinVolger {
  /**
   * @param d       afstand langs de route (m) van de eerste peiling
   * @param t       wanneer die peiling gezien is (s)
   * @param v       gemelde snelheid (m/s)
   * @param haltes  afstanden (m) van de haltes op de route, oplopend
   * @param nauw    onzekerheidsstraal (m) van die peiling, of null
   */
  constructor(d, t, v, haltes = null, nauw = null) {
    this.haltes = haltes;
    this.terug = 0;
    let tPeil = t;
    if (nauw !== null && nauw !== undefined && nauw <= ONZEKER && v > 5) {
      tPeil = t - Math.min(MAX_VOORSPRONG, nauw / (NAUW_PER_METER * v));
    }
    this._overzetten(d, tPeil, v);
    // De peiling zelf is op `t` gezien; dat is de maat voor "al gehad"
    this.peiling.gezien = t;
  }

  _overzetten(d, t, v) {
    v = Math.max(0, v || 0);
    this.peiling = { d, t, gezien: t, v, grens: this._grens(d) };
    this.beeld = { d, t };
    this.snelheid = v;
    this.terug = 0;
  }

  /** Tot waar hij mag doorrijden zonder nieuwe peiling: net voorbij de
   *  eerstvolgende halte. Zonder haltes: geen grens. */
  _grens(d) {
    const h = this.haltes;
    if (!h || !h.length) return Infinity;
    for (let i = 0; i < h.length; i++) {
      // Zijn eigen halte (hij staat er net) telt niet als volgende
      if (h[i] > d + HALTE_MARGE) return h[i] + HALTE_MARGE;
    }
    return Infinity;
  }

  /** Waar de laatste peiling hem op tijdstip t zet, doorgerekend met zijn
   *  snelheid maar niet eindeloos en niet voorbij de volgende halte. */
  _doel(t) {
    const p = this.peiling;
    const verstreken = Math.min(Math.max(0, t - p.t), DOORREKENEN);
    return Math.min(p.d + p.v * verstreken, Math.max(p.d, p.grens));
  }

  /**
   * Nieuwe peiling verwerken.
   * @param d     afstand langs de route (m)
   * @param t     wanneer deze positie voor het eerst gezien is (s)
   * @param v     gemelde snelheid (m/s)
   * @param nauw  onzekerheidsstraal (m), of null als onbekend
   * @returns wat ermee gebeurd is: 'zelfde', 'onzeker', 'ruis', 'terug',
   *          'sprong' of 'ok'
   */
  peil(d, t, v, nauw = null) {
    const p = this.peiling;
    v = Math.max(0, v || 0);

    // Dezelfde (of een oudere) peiling dan we al hadden
    if (t <= p.gezien) return 'zelfde';

    // De NS weet zelf niet meer waar hij is: positie negeren, doorrekenen
    if (nauw !== null && nauw !== undefined && nauw > ONZEKER) {
      p.gezien = t;
      return 'onzeker';
    }

    // Stilstaand treinstel dat een paar meter heen en weer meet
    if (v < 1 && p.v < 1 && Math.abs(d - p.d) < RUIS) {
      p.gezien = t;
      return 'ruis';
    }

    // Een rijdende trein die op precies dezelfde plek "opnieuw" gezien
    // wordt: dat is een oude peiling die nog eens langskomt, geen trein
    // die een halve minuut stilstond.
    if (v > 2 && p.v > 2 && Math.abs(d - p.d) < 5) {
      p.gezien = t;
      return 'zelfde';
    }

    // Ver van waar we hem verwachtten: nieuwe rit, of een hiaat in de feed
    const verwacht = this._doel(t);
    if (Math.abs(d - verwacht) > SPRONG) {
      this._overzetten(d, t, v);
      return 'sprong';
    }

    // Een stap terug: eerst niet geloven. Een kleine stap terug is
    // meetruis van een rijdende trein en levert geen beweging op; een
    // grote is meestal een oude peiling, tot het drie keer op rij gebeurt.
    if (d < p.d) {
      p.gezien = t;
      if (d >= p.d - TERUG) return 'terug';
      if (++this.terug < TERUG_ECHT) return 'terug';
      this._overzetten(d, t, v);
      return 'sprong';
    }
    this.terug = 0;

    // Wanneer was deze peiling echt? De afstand sinds de vorige, gedeeld
    // door de snelheid, zegt dat preciezer dan het moment van zien: een
    // stap van tien seconden rijden die binnen vijf seconden na de vorige
    // binnenkomt, was gewoon al vijf seconden oud.
    let tPeil = t;
    const vGem = (p.v + v) / 2;
    if (vGem > 2 && d > p.d) {
      const impliciet = p.t + (d - p.d) / vGem;
      tPeil = Math.max(t - MAX_VOORSPRONG, Math.min(t, impliciet));
    }
    this.peiling = { d, t: tPeil, gezien: t, v, grens: this._grens(d) };
    return 'ok';
  }

  /**
   * Waar staat hij nu? Schuift het beeld door tot tijdstip `nu` en geeft
   * de afstand langs de route terug. Elke aanroep bouwt voort op de
   * vorige, dus één keer per frame aanroepen.
   */
  positie(nu) {
    const p = this.peiling, b = this.beeld;
    const dt = nu - b.t;
    if (dt <= 0) return b.d;
    const doel = this._doel(nu);

    // Lang niet getekend (tabblad op de achtergrond): meteen naar waar hij
    // nu hoort, in plaats van die hele afstand in te halen.
    if (dt > 5) {
      b.d = Math.max(b.d, doel);
      b.t = nu;
      this.snelheid = p.v;
      return b.d;
    }

    // Rijden met de gemelde snelheid, plus een bijsturing naar het doel:
    // loopt het beeld achter, dan iets harder; loopt het voor, dan
    // langzamer, desnoods stil — maar nooit achteruit.
    const fout = doel - b.d;
    let v = p.v + fout / VOLGTIJD;
    v = Math.max(0, Math.min(v, p.v * HARDER + 4));
    b.d += v * dt;
    b.t = nu;
    this.snelheid = v;
    return b.d;
  }
}
