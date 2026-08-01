#!/usr/bin/env python3
"""
Bussie Straatnamen
Haalt de namen van straten uit het OSM-extract en legt ze per tegel klaar,
zodat de kaart ze kan bijschrijven zonder dat het tegelformaat om hoeft.

Een straat krijgt om de zoveel meter een ankerpunt met de richting ter
plekke, zodat er bij het inzoomen altijd één in beeld valt. Met één label
per straat zie je van een lange straat meestal net het stuk zonder naam.

Uitvoer: data/tegels/<niveau>/<x>/<y>.lbl  (JSON; de webserver gzipt)
"""

import argparse
import json
import logging
import math
import os
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tegels import NIVEAUS, latlon_naar_meters  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("straatnamen")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# Op welke niveaus schrijven we namen, en vanaf welke straatlengte?
# Ver uitgezoomd alleen de doorgaande wegen, ingezoomd ook de zijstraatjes.
LABELNIVEAUS = {
    3: {"min_lengte": 400, "soorten": {"motorway", "trunk", "primary", "secondary", "tertiary"},
        "tussenruimte": 2500, "max_per_naam": 2},
    4: {"min_lengte": 80,  "soorten": None,    # None = alle straten met een naam
        "tussenruimte": 450, "max_per_naam": 4},
}
OVERSLAAN = {"footway", "cycleway", "path", "steps", "track", "pedestrian", "corridor",
             "platform", "construction", "proposed", "raceway", "bridleway"}


def ankers(pts, tussenruimte):
    """Ankerpunten langs de straat, elke `tussenruimte` meter één.

    Geeft telkens (x, y, hoek). De hoek is die van het segment waar het
    punt op ligt, zodat het label mooi langs de weg komt te liggen.
    """
    uit = []
    volgende = tussenruimte / 2      # eerste label niet meteen op de hoek
    afgelegd = 0.0
    for i in range(len(pts) - 1):
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        lengte = math.hypot(x2 - x1, y2 - y1)
        if lengte == 0:
            continue
        hoek = math.atan2(y2 - y1, x2 - x1)
        while afgelegd + lengte >= volgende:
            t = (volgende - afgelegd) / lengte
            uit.append((x1 + t * (x2 - x1), y1 + t * (y2 - y1), hoek))
            volgende += tussenruimte
        afgelegd += lengte
    if not uit and len(pts) >= 2:
        # Te kort voor een tussenruimte: dan het midden van het langste stuk
        beste, punt = 0.0, None
        for i in range(len(pts) - 1):
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            lengte = math.hypot(x2 - x1, y2 - y1)
            if lengte > beste:
                beste = lengte
                punt = ((x1 + x2) / 2, (y1 + y2) / 2, math.atan2(y2 - y1, x2 - x1))
        if punt:
            uit.append(punt)
    return uit


def lengte_van(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
               for i in range(len(pts) - 1))


def genereer(pbf_pad, tegel_map):
    import osmium

    # naam per tegel per niveau; de langste straat wint bij dezelfde naam
    per_tegel = {niveau: defaultdict(dict) for niveau in LABELNIVEAUS}
    gelezen = 0

    fp = osmium.FileProcessor(pbf_pad, osmium.osm.NODE | osmium.osm.WAY).with_locations("flex_mem")
    try:
        fp = fp.with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
    except Exception as e:
        log.warning("Geen entiteitsfilter (%s)", e)

    for w in fp:
        if w.type_str() != "w":
            continue
        tags = w.tags
        hw = tags.get("highway")
        if not hw or hw in OVERSLAAN:
            continue
        naam = tags.get("name")
        if not naam or len(naam) > 40:
            continue

        pts = [latlon_naar_meters(n.location.lat, n.location.lon)
               for n in w.nodes if n.location.valid()]
        if len(pts) < 2:
            continue

        totaal = lengte_van(pts)
        gelezen += 1

        for niveau, regels in LABELNIVEAUS.items():
            if totaal < regels["min_lengte"]:
                continue
            if regels["soorten"] and hw not in regels["soorten"]:
                continue
            grootte = NIVEAUS[niveau]
            for x, y, hoek in ankers(pts, regels["tussenruimte"]):
                sleutel = (int(x // grootte), int(y // grootte))
                plekken = per_tegel[niveau][sleutel].setdefault(naam, [])
                if len(plekken) >= regels["max_per_naam"]:
                    continue
                # Niet twee labels vlak bij elkaar van dezelfde straat
                if any(math.hypot(x - px, y - py) < regels["tussenruimte"] * 0.8
                       for px, py, _ in plekken):
                    continue
                plekken.append((round(x, 1), round(y, 1), round(hoek, 3)))

    totaal_bytes = 0
    aantallen = {}
    for niveau, tegels in per_tegel.items():
        geschreven = 0
        labels = 0
        for (tx, ty), namen in tegels.items():
            rijen = [[naam, x, y, hoek]
                     for naam, plekken in namen.items()
                     for (x, y, hoek) in plekken]
            rijen.sort(key=lambda r: r[0])
            map_pad = os.path.join(tegel_map, str(niveau), str(tx))
            os.makedirs(map_pad, exist_ok=True)
            pad = os.path.join(map_pad, f"{ty}.lbl")
            # Plat wegschrijven: de webserver comprimeert onderweg al, en
            # dubbel gzippen levert bytes op die de browser niet uitpakt.
            with open(pad, "w", encoding="utf-8") as f:
                json.dump({"n": rijen}, f, separators=(",", ":"), ensure_ascii=False)
            totaal_bytes += os.path.getsize(pad)
            geschreven += 1
            labels += len(rijen)
        aantallen[niveau] = (geschreven, labels)
        log.info("  niveau %d: %d tegels, %d namen", niveau, geschreven, labels)

    # Bouwstempel bijwerken: labels hangen aan dezelfde ?v= als de tegels,
    # dus zonder dit blijven browsers een week lang de oude namen tonen.
    index_pad = os.path.join(tegel_map, "index.json")
    if os.path.exists(index_pad):
        with open(index_pad, "r", encoding="utf-8") as f:
            index = json.load(f)
        index["bouw"] = int(time.time())
        with open(index_pad, "w", encoding="utf-8") as f:
            json.dump(index, f, separators=(",", ":"))
        log.info("Bouwstempel bijgewerkt naar %d", index["bouw"])

    log.info("%d straten met naam gelezen; %.1f MB aan labels", gelezen, totaal_bytes / 1e6)
    return aantallen


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Zet straatnamen per tegel klaar")
    p.add_argument("pbf", nargs="?", default=os.path.join(DATA_DIR, "netherlands-latest.osm.pbf"))
    p.add_argument("--tegels", default=os.path.join(DATA_DIR, "tegels"))
    args = p.parse_args()
    genereer(args.pbf, args.tegels)
