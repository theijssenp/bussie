#!/usr/bin/env python3
"""
Bussie Tegelgenerator
Knipt kaartdata op in een tegelpiramide zodat de frontend alleen laadt wat
in beeld is. Zonder dit past Nederland niet in één bestand: de bbox van
Groningen is 89 km², het land is 41.500 km².

Uitvoer: data/tegels/<niveau>/<x>/<y>.btg + data/tegels/index.json

Tegelformaat (little-endian, zie ook frontend/js/tegels.js):

    magic    4 bytes  'BTG1'
    niveau   uint8
    tx, ty   int32
    grootte  float32   tegelgrootte in meters
    schaal   float32   meters per eenheid (grootte / 32768)
    lagen    uint8
    per laag:
      soort   uint8    0=water 1=groen 2=straat 3=gebouw
      aantal  uint32
      per element:
        punten  uint16
        waarde  uint16   straat: breedte in dm, gebouw: hoogte in dm
        punten × (int16 x, int16 y)   relatief aan de tegelhoek, in eenheden

Coördinaten zijn gekwantiseerd op grootte/32768 meter: op het fijnste
niveau 6 cm, op het grofste 1 meter. Daarmee past elke coördinaat in een
int16 en is een punt 4 bytes in plaats van ~16 tekens JSON.
"""

import argparse
import json
import logging
import math
import os
import struct
import time
import sys
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("tegels")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
TEGEL_DIR = os.path.join(DATA_DIR, "tegels")

# Landelijk nulpunt. Alle wereldcoördinaten (kaart, lijnen, voertuigen)
# rekenen vanaf hetzelfde punt, anders sluiten de tegels niet op elkaar aan.
CENTER_NL = {"lon": 5.4, "lat": 52.15}

# Tegelgrootte per niveau, in meters. Niveau 0 is het verst uitgezoomd.
NIVEAUS = [32768, 16384, 8192, 4096, 2048]
EENHEDEN = 32768  # int16-bereik dat één tegel beslaat

SOORTEN = {"water": 0, "green": 1, "streets": 2, "buildings": 3}

# Wat komt er op welk niveau in, en hoe grof mag het?
#
# `omvang` en `weg` zijn drempels in meters: kleiner dan dat laten we weg.
# `eps` is de vereenvoudigingstolerantie, afgestemd op wat er op dat niveau
# zichtbaar is (ruwweg een halve beeldpunt) en niet op de kwantisering —
# geometrie op 1,5 meter bewaren terwijl één beeldpunt 6 meter beslaat, kost
# alleen maar bytes. Nederland is één grote lappendeken van weilanden en
# sloten, dus juist op de grove niveaus moeten die drempels hoog liggen.
# `bebouwing` vat panden samen tot blokken: op de grove niveaus zijn tien
# miljoen losse gebouwen ondoenlijk, maar een stad hoort wel een stad te
# blijven. Per cel van `cel` meter komt er één blok als minstens `dekking`
# van die cel bebouwd is.
DETAIL = [
    {"omvang": 2500, "weg": 14, "gebouwen": False, "eps": 4.0,
     "bebouwing": {"cel": 512, "dekking": 0.06}},
    {"omvang": 1200, "weg": 12, "gebouwen": False, "eps": 2.0,
     "bebouwing": {"cel": 256, "dekking": 0.06}},
    {"omvang": 400,  "weg": 8,  "gebouwen": True,  "gebouw_omvang": 25, "eps": 1.0},
    {"omvang": 100,  "weg": 5,  "gebouwen": True,  "gebouw_omvang": 20, "eps": 0.5},
    {"omvang": 0,    "weg": 0,  "gebouwen": True,  "gebouw_omvang": 0,  "eps": 0.25},
]

# ---------------------------------------------------------------------------
# Projectie
# ---------------------------------------------------------------------------

def latlon_naar_meters(lat, lon, center=CENTER_NL):
    R = 6378137
    n = math.pi / 180
    cos_lat = math.cos(center["lat"] * n)
    return [(lon - center["lon"]) * n * R * cos_lat, -(lat - center["lat"]) * n * R]


def verplaats(pts, dx, dy):
    """Coördinaten van een stadsbestand naar het landelijke nulpunt schuiven."""
    return [[p[0] + dx, p[1] + dy] for p in pts]


# ---------------------------------------------------------------------------
# Geometrie
# ---------------------------------------------------------------------------

def bounds(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def vereenvoudig(pts, eps):
    """Douglas-Peucker, iteratief."""
    if eps <= 0 or len(pts) < 3:
        return pts
    houden = [False] * len(pts)
    houden[0] = houden[-1] = True
    stapel = [(0, len(pts) - 1)]
    while stapel:
        eerste, laatste = stapel.pop()
        if laatste <= eerste + 1:
            continue
        ax, ay = pts[eerste]
        bx, by = pts[laatste]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        beste_d, beste_i = 0.0, -1
        for i in range(eerste + 1, laatste):
            px, py = pts[i]
            d = (math.hypot(px - ax, py - ay) if norm == 0
                 else abs(dy * px - dx * py + bx * ay - by * ax) / norm)
            if d > beste_d:
                beste_d, beste_i = d, i
        if beste_d > eps and beste_i > 0:
            houden[beste_i] = True
            stapel.append((eerste, beste_i))
            stapel.append((beste_i, laatste))
    return [p for p, k in zip(pts, houden) if k]


def knip_lijn(pts, minx, miny, maxx, maxy):
    """Knip een polylijn op het tegelvenster; geeft losse stukken terug."""
    stukken = []
    huidig = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        seg = _knip_segment(a, b, minx, miny, maxx, maxy)
        if seg is None:
            if len(huidig) >= 2:
                stukken.append(huidig)
            huidig = []
            continue
        p, q = seg
        if not huidig:
            huidig = [p, q]
        elif huidig[-1] == p:
            huidig.append(q)
        else:
            if len(huidig) >= 2:
                stukken.append(huidig)
            huidig = [p, q]
    if len(huidig) >= 2:
        stukken.append(huidig)
    return stukken


def _knip_segment(a, b, minx, miny, maxx, maxy):
    """Liang-Barsky."""
    x1, y1 = a
    x2, y2 = b
    dx, dy = x2 - x1, y2 - y1
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x1 - minx), (dx, maxx - x1), (-dy, y1 - miny), (dy, maxy - y1)):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            if t > t1:
                return None
            t0 = max(t0, t)
        else:
            if t < t0:
                return None
            t1 = min(t1, t)
    return ([x1 + t0 * dx, y1 + t0 * dy], [x1 + t1 * dx, y1 + t1 * dy])


def knip_vlak(pts, minx, miny, maxx, maxy):
    """Sutherland-Hodgman tegen het (rechthoekige) tegelvenster."""
    uit = pts
    for rand in range(4):
        if not uit:
            return []
        invoer = uit
        uit = []
        for i in range(len(invoer)):
            huidig = invoer[i]
            vorig = invoer[i - 1]
            binnen_h = _binnen(huidig, rand, minx, miny, maxx, maxy)
            binnen_v = _binnen(vorig, rand, minx, miny, maxx, maxy)
            if binnen_h:
                if not binnen_v:
                    uit.append(_snij(vorig, huidig, rand, minx, miny, maxx, maxy))
                uit.append(huidig)
            elif binnen_v:
                uit.append(_snij(vorig, huidig, rand, minx, miny, maxx, maxy))
    return uit


def _binnen(p, rand, minx, miny, maxx, maxy):
    if rand == 0:
        return p[0] >= minx
    if rand == 1:
        return p[0] <= maxx
    if rand == 2:
        return p[1] >= miny
    return p[1] <= maxy


def _snij(a, b, rand, minx, miny, maxx, maxy):
    ax, ay = a
    bx, by = b
    if rand in (0, 1):
        x = minx if rand == 0 else maxx
        t = (x - ax) / (bx - ax) if bx != ax else 0
        return [x, ay + t * (by - ay)]
    y = miny if rand == 2 else maxy
    t = (y - ay) / (by - ay) if by != ay else 0
    return [ax + t * (bx - ax), y]


# ---------------------------------------------------------------------------
# Tegels vullen
# ---------------------------------------------------------------------------

class Tegelbouwer:
    def __init__(self):
        # (niveau, tx, ty) → {soort: [elementen]}
        self.tegels = defaultdict(lambda: defaultdict(list))

    def voeg_toe(self, niveau, soort, pts, waarde=0, vlak=False):
        grootte = NIVEAUS[niveau]
        minx, miny, maxx, maxy = bounds(pts)
        tx0, ty0 = int(math.floor(minx / grootte)), int(math.floor(miny / grootte))
        tx1, ty1 = int(math.floor(maxx / grootte)), int(math.floor(maxy / grootte))

        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                vx, vy = tx * grootte, ty * grootte
                if tx0 == tx1 and ty0 == ty1:
                    deel = [pts]  # past helemaal in deze tegel
                elif vlak:
                    geknipt = knip_vlak(pts, vx, vy, vx + grootte, vy + grootte)
                    deel = [geknipt] if len(geknipt) >= 3 else []
                else:
                    deel = knip_lijn(pts, vx, vy, vx + grootte, vy + grootte)

                for stuk in deel:
                    if len(stuk) < (3 if vlak else 2):
                        continue
                    self.tegels[(niveau, tx, ty)][soort].append((stuk, waarde))

    def schrijf(self, uitvoer_dir):
        os.makedirs(uitvoer_dir, exist_ok=True)
        index = {
            "v": 1,
            "center": CENTER_NL,
            "niveaus": [{"niveau": i, "grootte": g, "schaal": g / EENHEDEN}
                        for i, g in enumerate(NIVEAUS)],
            "tegels": defaultdict(list),
        }
        totaal_bytes = 0

        for (niveau, tx, ty), lagen in sorted(self.tegels.items()):
            data = codeer_tegel(niveau, tx, ty, lagen)
            pad = os.path.join(uitvoer_dir, str(niveau), str(tx))
            os.makedirs(pad, exist_ok=True)
            with open(os.path.join(pad, f"{ty}.btg"), "wb") as f:
                f.write(data)
            totaal_bytes += len(data)
            index["tegels"][str(niveau)].append([tx, ty])

        # Waar staat de kaart als je hem opent: het midden van wat we hebben
        fijnste = max(int(n) for n in index["tegels"]) if index["tegels"] else 0
        vakken = index["tegels"][str(fijnste)]
        g = NIVEAUS[fijnste]
        index["bereik"] = {
            "minX": min(v[0] for v in vakken) * g,
            "minY": min(v[1] for v in vakken) * g,
            "maxX": (max(v[0] for v in vakken) + 1) * g,
            "maxY": (max(v[1] for v in vakken) + 1) * g,
        }
        index["start"] = {
            "x": round((min(v[0] for v in vakken) + max(v[0] for v in vakken) + 1) / 2 * g, 1),
            "y": round((min(v[1] for v in vakken) + max(v[1] for v in vakken) + 1) / 2 * g, 1),
        }
        # Bouwstempel: de frontend hangt die aan elke tegel-URL, zodat een
        # nieuwe bouw de browsercache vanzelf ongeldig maakt.
        index["bouw"] = int(time.time())
        index["tegels"] = dict(index["tegels"])
        with open(os.path.join(uitvoer_dir, "index.json"), "w") as f:
            json.dump(index, f, separators=(",", ":"))

        return len(self.tegels), totaal_bytes

def bebouwingsblokken(cellen, cel, dekking):
    """Zet opgetelde bebouwing per rastercel om in blokjes.

    Elke cel die genoeg bebouwd is levert één vierkant met de gemiddelde
    hoogte van de panden erin. Het vierkant is iets kleiner dan de cel,
    zodat je bij het uitzoomen blokken ziet en geen dichtgesmeerd vlak.
    """
    drempel = cel * cel * dekking
    blokken = []
    inzet = cel * 0.08
    for (cx, cy), (oppervlak, hoogte_som, aantal) in cellen.items():
        if oppervlak < drempel:
            continue
        x0, y0 = cx * cel + inzet, cy * cel + inzet
        x1, y1 = (cx + 1) * cel - inzet, (cy + 1) * cel - inzet
        # Hoe voller de cel, hoe hoger het blok mag ogen
        gemiddeld = hoogte_som / max(aantal, 1)
        vulling = min(1.0, oppervlak / (cel * cel))
        hoogte = max(6.0, min(45.0, gemiddeld * (0.7 + vulling)))
        blokken.append(([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], int(hoogte * 10)))
    return blokken


def tel_bebouwing(cellen, pts, hoogte_m, cel):
    """Tel een pand mee in de rastercel waar zijn middelpunt ligt."""
    minx, miny, maxx, maxy = bounds(pts)
    oppervlak = max(0.0, (maxx - minx)) * max(0.0, (maxy - miny))
    if oppervlak <= 0:
        return
    cx = int((minx + maxx) / 2 // cel)
    cy = int((miny + maxy) / 2 // cel)
    vak = cellen.get((cx, cy))
    if vak is None:
        cellen[(cx, cy)] = [oppervlak, hoogte_m, 1]
    else:
        vak[0] += oppervlak
        vak[1] += hoogte_m
        vak[2] += 1


def codeer_tegel(niveau, tx, ty, lagen):
    """Zet de lagen van één tegel om naar het binaire tegelformaat."""
    grootte = NIVEAUS[niveau]
    schaal = grootte / EENHEDEN
    vx, vy = tx * grootte, ty * grootte

    uit = bytearray()
    uit += b"BTG1"
    uit += struct.pack("<BiiffB", niveau, tx, ty, float(grootte), float(schaal), len(lagen))

    for soort_naam, elementen in sorted(lagen.items(), key=lambda kv: SOORTEN[kv[0]]):
        uit += struct.pack("<BI", SOORTEN[soort_naam], len(elementen))
        for pts, waarde in elementen:
            uit += struct.pack("<HH", len(pts), int(waarde))
            for x, y in pts:
                qx = int(round((x - vx) / schaal))
                qy = int(round((y - vy) / schaal))
                uit += struct.pack("<hh", max(-32768, min(32767, qx)),
                                   max(-32768, min(32767, qy)))
    return bytes(uit)


def lees_tegel(pad):
    """Een .btg-tegel terugleien naar {soort: [(pts, waarde)]}."""
    with open(pad, "rb") as f:
        b = f.read()
    if b[:4] != b"BTG1":
        raise ValueError(f"Geen geldige tegel: {pad}")
    niveau, tx, ty, grootte, schaal, lagen = struct.unpack_from("<BiiffB", b, 4)
    vx, vy = tx * grootte, ty * grootte
    o = 22
    omgekeerd = {n: s for s, n in SOORTEN.items()}
    uit = {}
    for _ in range(lagen):
        soort_nr, aantal = struct.unpack_from("<BI", b, o)
        o += 5
        elementen = []
        for _ in range(aantal):
            punten, waarde = struct.unpack_from("<HH", b, o)
            o += 4
            coords = struct.unpack_from(f"<{2 * punten}h", b, o)
            o += 4 * punten
            pts = [[vx + coords[i * 2] * schaal, vy + coords[i * 2 + 1] * schaal]
                   for i in range(punten)]
            elementen.append((pts, waarde))
        uit[omgekeerd[soort_nr]] = elementen
    return uit


# ---------------------------------------------------------------------------
# Bron: bestaande stadsbestanden
# ---------------------------------------------------------------------------

def lees_stad(pad):
    """Laad een kaart-JSON en zet de coördinaten om naar het landelijke nulpunt."""
    with open(pad, "r", encoding="utf-8") as f:
        d = json.load(f)
    centrum = d["center"]
    # Waar ligt het stadscentrum in landelijke coördinaten?
    dx, dy = latlon_naar_meters(centrum["lat"], centrum["lon"])
    log.info("  %s: nulpunt verschuift met (%.0f, %.0f) m", os.path.basename(pad), dx, dy)
    return d, dx, dy


def bouw(bronnen, uitvoer_dir):
    bouwer = Tegelbouwer()
    tellingen = defaultdict(int)

    for pad in bronnen:
        d, dx, dy = lees_stad(pad)

        for niveau, detail in enumerate(DETAIL):
            eps = detail["eps"]

            for soort in ("water", "green", "streets", "buildings"):
                if soort == "buildings" and not detail["gebouwen"]:
                    continue
                for el in d.get(soort, []):
                    pts = el.get("pts")
                    if not pts or len(pts) < 2:
                        continue

                    if soort == "streets":
                        breedte = el.get("w", 5)
                        if breedte < detail["weg"]:
                            continue
                        waarde = int(breedte * 10)
                        vlak = False
                    elif soort == "buildings":
                        pts_b = bounds(pts)
                        omvang = max(pts_b[2] - pts_b[0], pts_b[3] - pts_b[1])
                        if omvang < detail.get("gebouw_omvang", 0):
                            continue
                        waarde = int(max(0, min(6000, (el.get("h") or 0) * 10)))
                        vlak = True
                    else:
                        pts_b = bounds(pts)
                        omvang = max(pts_b[2] - pts_b[0], pts_b[3] - pts_b[1])
                        if omvang < detail["omvang"]:
                            continue
                        waarde = 0
                        vlak = True

                    verschoven = verplaats(pts, dx, dy)
                    vereenvoudigd = vereenvoudig(verschoven, eps)
                    if len(vereenvoudigd) < (3 if vlak else 2):
                        continue

                    bouwer.voeg_toe(niveau, soort, vereenvoudigd, waarde, vlak)
                    tellingen[(niveau, soort)] += 1

    aantal, bytes_totaal = bouwer.schrijf(uitvoer_dir)

    log.info("Elementen per niveau:")
    for niveau in range(len(NIVEAUS)):
        regel = ", ".join(f"{s}={tellingen[(niveau, s)]}"
                          for s in ("water", "green", "streets", "buildings")
                          if tellingen[(niveau, s)])
        log.info("  niveau %d (%d m): %s", niveau, NIVEAUS[niveau], regel or "leeg")
    log.info("%d tegels, %.1f MB totaal", aantal, bytes_totaal / 1e6)


def main():
    p = argparse.ArgumentParser(description="Knip kaartdata in tegels")
    p.add_argument("bronnen", nargs="*", default=[os.path.join(DATA_DIR, "groningen.json")],
                   help="kaart-JSON bestanden (standaard: data/groningen.json)")
    p.add_argument("--uit", default=TEGEL_DIR, help="uitvoermap")
    args = p.parse_args()

    bronnen = args.bronnen or [os.path.join(DATA_DIR, "groningen.json")]
    for pad in bronnen:
        if not os.path.exists(pad):
            log.error("Bron ontbreekt: %s", pad)
            sys.exit(1)

    log.info("Tegels bouwen uit %d bron(nen)", len(bronnen))
    bouw(bronnen, args.uit)


if __name__ == "__main__":
    main()
