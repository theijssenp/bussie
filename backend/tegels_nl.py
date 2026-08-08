#!/usr/bin/env python3
"""
Bussie Landelijke Tegelbouw
Leest het OSM-extract van Nederland en zet dat om in de tegelpiramide van
tegels.py. Het land past niet in het geheugen, dus het gaat in twee stappen:

  1. Streamen door de PBF; elk element belandt in een tijdelijk bestand per
     tegel van het fijnste niveau (2 km). Alleen open bestandshandvatten
     blijven in het geheugen, niet de geometrie.
  2. Per tegel die tijdelijke bestanden teruglezen en de .btg schrijven,
     voor elk detailniveau apart. Een grove tegel leest de bestanden van
     de fijne tegels die eronder liggen.

Gebruik:
    python3 backend/tegels_nl.py data/netherlands-latest.osm.pbf
"""

import argparse
import json
import logging
import math
import os
import shutil
import struct
import sys
import time
from collections import OrderedDict, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tegels import (  # noqa: E402
    CENTER_NL, NIVEAUS, EENHEDEN, SOORTEN, DETAIL,
    bounds, vereenvoudig, knip_lijn, knip_vlak, codeer_tegel, lees_tegel,
    bebouwingsblokken, tel_bebouwing,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("tegels-nl")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
FIJNSTE = len(NIVEAUS) - 1

# Wegtypes en hun breedte in meters (gelijk aan kaart_generator.py)
WEGBREEDTE = {
    "motorway": 18, "trunk": 14, "primary": 12, "secondary": 10,
    "tertiary": 8, "residential": 6, "service": 4, "unclassified": 5,
    "road": 5, "living_street": 5, "motorway_link": 10, "trunk_link": 8,
    "primary_link": 7, "secondary_link": 6, "tertiary_link": 5,
}
# Spoor waar echt treinverkeer overheen gaat. Trams en metro's laten we
# eruit: die lopen door de stad heen en maken het spoornet onleesbaar.
SPOOR = {"rail", "light_rail", "narrow_gauge"}
# Rangeerterreinen en fabrieksaansluitingen leveren een wirwar op zonder dat
# er een reizigerstrein overheen komt. Perronsporen (siding) en de wissels
# ertussen (crossover) horen er juist wél bij: daar staan de treinen die je
# op de kaart ziet.
SPOOR_DIENST_UIT = {"yard", "spur"}
# Deze liggen op stations en zijn ondergeschikt aan de doorgaande baan; ze
# worden dunner getekend zodat een station leesbaar blijft.
SPOOR_BIJSPOOR = {"siding", "crossover"}
GROEN_LEISURE = {"park", "garden", "playground"}
GROEN_LANDUSE = {"grass", "meadow", "forest", "cemetery", "recreation_ground", "orchard", "allotments"}
WATERWEGEN = {"river", "stream", "canal", "ditch"}


def latlon_naar_meters(lat, lon):
    R = 6378137
    n = math.pi / 180
    cos_lat = math.cos(CENTER_NL["lat"] * n)
    return ((lon - CENTER_NL["lon"]) * n * R * cos_lat, -(lat - CENTER_NL["lat"]) * n * R)


# ---------------------------------------------------------------------------
# Stap 1: PBF streamen naar tijdelijke bestanden per tegel
# ---------------------------------------------------------------------------

class TegelSchrijver:
    """Houdt een beperkt aantal bestanden open; de rest gaat dicht (LRU)."""

    def __init__(self, map_pad, max_open=384):
        self.map_pad = map_pad
        self.max_open = max_open
        self.open_bestanden = OrderedDict()
        self.geschreven = 0
        os.makedirs(map_pad, exist_ok=True)

    def _handvat(self, tx, ty):
        sleutel = (tx, ty)
        f = self.open_bestanden.get(sleutel)
        if f is not None:
            self.open_bestanden.move_to_end(sleutel)
            return f
        if len(self.open_bestanden) >= self.max_open:
            _, oud = self.open_bestanden.popitem(last=False)
            oud.close()
        pad = os.path.join(self.map_pad, f"{tx}_{ty}.rauw")
        f = open(pad, "ab", buffering=1 << 16)
        self.open_bestanden[sleutel] = f
        return f

    def schrijf(self, tx, ty, soort, waarde, pts, omvang):
        """`omvang` is de grootte van het hele element, ook als dit maar een
        afgeknipt stukje is. Daarop filteren de grove niveaus, anders
        verdwijnen de randen van een groot meer bij het uitzoomen."""
        if len(pts) > 65535:
            return
        f = self._handvat(tx, ty)
        # OSM bevat onmogelijke waarden (negatieve hoogtes, gebouwen van een
        # kilometer); klemmen in plaats van de hele bouw laten klappen.
        f.write(struct.pack("<BHHH", SOORTEN[soort],
                            max(0, min(65535, int(waarde))),
                            max(0, min(65535, int(omvang))), len(pts)))
        for x, y in pts:
            f.write(struct.pack("<ff", x, y))
        self.geschreven += 1

    def sluit(self):
        for f in self.open_bestanden.values():
            f.close()
        self.open_bestanden.clear()


def lees_rauw(pad):
    """Elementen uit een tijdelijk tegelbestand teruglezen."""
    if not os.path.exists(pad):
        return
    with open(pad, "rb") as f:
        data = f.read()
    o = 0
    n = len(data)
    while o < n:
        soort, waarde, omvang, aantal = struct.unpack_from("<BHHH", data, o)
        o += 7
        pts = []
        for _ in range(aantal):
            x, y = struct.unpack_from("<ff", data, o)
            o += 8
            pts.append([x, y])
        yield soort, waarde, omvang, pts


def hoogte_van(tags):
    h = tags.get("height", "")
    if h:
        try:
            return float(h.split()[0])
        except ValueError:
            pass
    n = tags.get("building:levels", "")
    if n:
        try:
            return float(n) * 3.5
        except ValueError:
            pass
    return 0.0


def classificeer(tags):
    """(soort, waarde, is_vlak) of None als we het niet tekenen.

    Werkt rechtstreeks op de TagList van osmium: er per weg een dict van
    maken kost bij miljoenen wegen meer tijd dan het opzoeken zelf.
    """
    if "building" in tags:
        return "buildings", max(0, min(6000, int(hoogte_van(tags) * 10))), True

    hw = tags.get("highway")
    if hw:
        breedte = WEGBREEDTE.get(hw)
        return ("streets", int(breedte * 10), False) if breedte else None

    rw = tags.get("railway")
    if rw in SPOOR:
        dienst = tags.get("service")
        if dienst in SPOOR_DIENST_UIT:
            return None
        # waarde 1 = bijspoor (perron, wissel), 0 = doorgaande baan
        return "rails", 1 if dienst in SPOOR_BIJSPOOR else 0, False

    if tags.get("natural") == "water" or tags.get("landuse") in ("basin", "reservoir"):
        return "water", 0, True
    if tags.get("waterway") in WATERWEGEN:
        return "water", 0, False

    if tags.get("leisure") in GROEN_LEISURE or tags.get("landuse") in GROEN_LANDUSE:
        return "green", 0, True

    return None


def stap1(pbf_pad, werk_map):
    import osmium

    schrijver = TegelSchrijver(werk_map)
    grootte = NIVEAUS[FIJNSTE]
    tellingen = defaultdict(int)
    verwerkt = 0
    begin = time.time()

    # Knooppunten moeten mee door de lezer, anders blijft de locatiecache
    # leeg en hebben de wegen geen coördinaten. Met een entiteitsfilter
    # blijven ze wel binnen de C++-kant: ~100 miljoen knooppunten stuk voor
    # stuk aan Python aanbieden kost meer tijd dan al het andere samen.
    fp = (osmium.FileProcessor(pbf_pad, osmium.osm.NODE | osmium.osm.WAY)
          .with_locations("flex_mem"))
    try:
        fp = fp.with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        log.info("  entiteitsfilter actief: alleen wegen komen in Python")
    except Exception as e:
        log.warning("  entiteitsfilter niet beschikbaar (%s), knooppunten worden overgeslagen in de lus", e)

    for obj in fp:
        if obj.type_str() != "w":
            continue
        tags = obj.tags
        soort_info = classificeer(tags)
        if not soort_info:
            continue
        soort, waarde, vlak = soort_info

        try:
            pts = [latlon_naar_meters(n.location.lat, n.location.lon)
                   for n in obj.nodes if n.location.valid()]
        except Exception:
            continue
        if len(pts) < (3 if vlak else 2):
            continue

        minx, miny, maxx, maxy = bounds(pts)
        omvang = max(maxx - minx, maxy - miny)
        tx0, ty0 = int(minx // grootte), int(miny // grootte)
        tx1, ty1 = int(maxx // grootte), int(maxy // grootte)

        if tx0 == tx1 and ty0 == ty1:
            schrijver.schrijf(tx0, ty0, soort, waarde, pts, omvang)
        else:
            # Loopt over tegelranden: nu al knippen, anders staat een polder
            # straks in honderden tegels.
            for tx in range(tx0, tx1 + 1):
                for ty in range(ty0, ty1 + 1):
                    vx, vy = tx * grootte, ty * grootte
                    if vlak:
                        deel = knip_vlak(pts, vx, vy, vx + grootte, vy + grootte)
                        stukken = [deel] if len(deel) >= 3 else []
                    else:
                        stukken = knip_lijn(pts, vx, vy, vx + grootte, vy + grootte)
                    for stuk in stukken:
                        schrijver.schrijf(tx, ty, soort, waarde, stuk, omvang)

        tellingen[soort] += 1
        verwerkt += 1
        if verwerkt % 250000 == 0:
            log.info("  %d elementen (%.0f/s), %d weggeschreven",
                     verwerkt, verwerkt / (time.time() - begin), schrijver.geschreven)

    schrijver.sluit()
    log.info("Stap 1 klaar: %d elementen in %.0f s → %d stukken",
             verwerkt, time.time() - begin, schrijver.geschreven)
    log.info("  %s", dict(tellingen))
    return tellingen


# ---------------------------------------------------------------------------
# Stap 2: tegels schrijven per niveau
# ---------------------------------------------------------------------------

def stap2(werk_map, uit_map, alleen=None):
    """Tegels schrijven per niveau, telkens uit de tijdelijke bestanden.

    Elk niveau leest de ruwe stukken opnieuw. Dat is meer leeswerk dan
    grove tegels uit fijne opbouwen, maar wel het enige dat klopt: de
    filters kijken naar de omvang van het hele element, en die is na het
    knippen niet meer af te leiden uit het stukje dat je in handen hebt.
    """
    os.makedirs(uit_map, exist_ok=True)
    index = {"v": 1, "center": CENTER_NL,
             "niveaus": [{"niveau": i, "grootte": g, "schaal": g / EENHEDEN}
                         for i, g in enumerate(NIVEAUS)],
             "tegels": defaultdict(list)}

    fijn = {}
    for naam in os.listdir(werk_map):
        if naam.endswith(".rauw"):
            tx, ty = naam[:-5].split("_")
            fijn[(int(tx), int(ty))] = os.path.join(werk_map, naam)
    log.info("Stap 2: %d tegels op het fijnste niveau", len(fijn))

    omgekeerd = {n: s for s, n in SOORTEN.items()}
    totaal_bytes = 0

    for niveau in range(len(NIVEAUS)):
        if alleen is not None and niveau not in alleen:
            continue
        grootte = NIVEAUS[niveau]
        detail = DETAIL[niveau]
        eps = detail["eps"]
        begin = time.time()

        groepen = defaultdict(list)
        for (fx, fy), pad in fijn.items():
            doel = ((fx * NIVEAUS[FIJNSTE]) // grootte, (fy * NIVEAUS[FIJNSTE]) // grootte)
            groepen[doel].append(pad)

        geschreven = 0
        bebouwing = detail.get("bebouwing")
        for (tx, ty), paden in sorted(groepen.items()):
            lagen = defaultdict(list)
            cellen = {}
            vx, vy = tx * grootte, ty * grootte

            for pad in paden:
                for soort_nr, waarde, omvang, pts in lees_rauw(pad):
                    soort = omgekeerd[soort_nr]

                    if soort == "buildings":
                        if bebouwing:
                            # Niet los tekenen maar optellen tot stadsblokken
                            tel_bebouwing(cellen, pts, (waarde / 10) or 9, bebouwing["cel"])
                            continue
                        if not detail["gebouwen"] or omvang < detail.get("gebouw_omvang", 0):
                            continue
                    elif soort == "streets":
                        if waarde / 10 < detail["weg"]:
                            continue
                    elif soort == "rails":
                        if omvang < detail.get("spoor", 0):
                            continue
                    elif omvang < detail["omvang"]:
                        continue

                    vlak = soort not in ("streets", "rails")
                    pts = vereenvoudig(pts, eps)
                    if len(pts) < (3 if vlak else 2):
                        continue

                    if grootte == NIVEAUS[FIJNSTE]:
                        stukken = [pts]   # al op deze tegel geknipt in stap 1
                    else:
                        b = bounds(pts)
                        if b[0] >= vx and b[1] >= vy and b[2] <= vx + grootte and b[3] <= vy + grootte:
                            stukken = [pts]
                        elif vlak:
                            deel = knip_vlak(pts, vx, vy, vx + grootte, vy + grootte)
                            stukken = [deel] if len(deel) >= 3 else []
                        else:
                            stukken = knip_lijn(pts, vx, vy, vx + grootte, vy + grootte)

                    for stuk in stukken:
                        lagen[soort].append((stuk, waarde))

            if bebouwing and cellen:
                for blok, hoogte in bebouwingsblokken(cellen, bebouwing["cel"], bebouwing["dekking"]):
                    lagen["buildings"].append((blok, hoogte))

            if not lagen:
                continue
            data = codeer_tegel(niveau, tx, ty, lagen)
            map_pad = os.path.join(uit_map, str(niveau), str(tx))
            os.makedirs(map_pad, exist_ok=True)
            with open(os.path.join(map_pad, f"{ty}.btg"), "wb") as f:
                f.write(data)
            totaal_bytes += len(data)
            index["tegels"][str(niveau)].append([tx, ty])
            geschreven += 1

        log.info("  niveau %d (%d m): %d tegels in %.0f s", niveau, grootte,
                 geschreven, time.time() - begin)

    if alleen is not None:
        # Deelherbouw: de index van de bestaande tegels aanvullen in plaats
        # van weggooien, anders verdwijnen de niveaus die we oversloegen.
        bestaand_pad = os.path.join(uit_map, "index.json")
        if os.path.exists(bestaand_pad):
            with open(bestaand_pad, "r", encoding="utf-8") as f:
                bestaand = json.load(f)
            for niveau, lijst in bestaand.get("tegels", {}).items():
                if int(niveau) not in alleen:
                    index["tegels"][niveau] = lijst

    vakken = index["tegels"][str(FIJNSTE)]
    g = NIVEAUS[FIJNSTE]
    index["bereik"] = {
        "minX": min(v[0] for v in vakken) * g, "minY": min(v[1] for v in vakken) * g,
        "maxX": (max(v[0] for v in vakken) + 1) * g, "maxY": (max(v[1] for v in vakken) + 1) * g,
    }
    index["start"] = {
        "x": round((min(v[0] for v in vakken) + max(v[0] for v in vakken) + 1) / 2 * g, 1),
        "y": round((min(v[1] for v in vakken) + max(v[1] for v in vakken) + 1) / 2 * g, 1),
    }
    # Bouwstempel: de frontend hangt die aan elke tegel-URL, zodat een
    # nieuwe bouw de browsercache vanzelf ongeldig maakt.
    index["bouw"] = int(time.time())
    index["tegels"] = dict(index["tegels"])
    with open(os.path.join(uit_map, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))

    log.info("Stap 2 klaar: %.0f MB tegels", totaal_bytes / 1e6)
    return index


def main():
    p = argparse.ArgumentParser(description="Bouw landelijke tegels uit een OSM-extract")
    p.add_argument("pbf", nargs="?", default=os.path.join(DATA_DIR, "netherlands-latest.osm.pbf"))
    p.add_argument("--werk", default=os.path.join(DATA_DIR, "tegelwerk"))
    p.add_argument("--uit", default=os.path.join(DATA_DIR, "tegels"))
    p.add_argument("--stap", choices=["1", "2", "beide"], default="beide")
    p.add_argument("--bewaar-werk", action="store_true", help="tijdelijke bestanden niet wissen")
    p.add_argument("--alleen", help="alleen deze niveaus herbouwen, bijv. 0,1")
    args = p.parse_args()

    if args.stap in ("1", "beide"):
        if not os.path.exists(args.pbf):
            log.error("PBF ontbreekt: %s", args.pbf)
            sys.exit(1)
        if os.path.exists(args.werk):
            shutil.rmtree(args.werk)
        log.info("Stap 1: %s streamen (%.1f GB)", args.pbf, os.path.getsize(args.pbf) / 1e9)
        stap1(args.pbf, args.werk)

    if args.stap in ("2", "beide"):
        alleen = {int(n) for n in args.alleen.split(",")} if args.alleen else None
        if os.path.exists(args.uit) and alleen is None:
            shutil.rmtree(args.uit)
        elif alleen:
            for niveau in alleen:
                shutil.rmtree(os.path.join(args.uit, str(niveau)), ignore_errors=True)
        stap2(args.werk, args.uit, alleen)
        if not args.bewaar_werk:
            shutil.rmtree(args.werk, ignore_errors=True)
            log.info("Tijdelijke bestanden opgeruimd")


if __name__ == "__main__":
    main()
