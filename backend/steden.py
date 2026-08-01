#!/usr/bin/env python3
"""
Bussie Stedenlijst
Haalt plaatsnamen uit het OSM-extract zodat de kaart een selector kan
tonen. Coördinaten komen uit dezelfde bron en hetzelfde nulpunt als de
tegels, dus een sprong naar een stad komt precies goed uit.

Uitvoer: data/steden.json
"""

import argparse
import json
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tegels import CENTER_NL, latlon_naar_meters  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("steden")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# Welke plaatsen nemen we mee, en hoe ver zoomen we erop in?
SOORTEN = {
    "city": {"zoom": 1.6, "rang": 0},
    "town": {"zoom": 2.2, "rang": 1},
    "village": {"zoom": 2.8, "rang": 2},
}
MIN_INWONERS = {"city": 0, "town": 0, "village": 4000}


def getal(waarde):
    try:
        return int(str(waarde).replace(".", "").replace(" ", ""))
    except (ValueError, TypeError):
        return 0


def genereer(pbf_pad, uit_pad, maximaal=400):
    import osmium

    plaatsen = []
    fp = osmium.FileProcessor(pbf_pad, osmium.osm.NODE)
    try:
        fp = fp.with_filter(osmium.filter.KeyFilter("place"))
    except Exception as e:
        log.warning("Geen sleutelfilter beschikbaar (%s) — dit duurt langer", e)

    for n in fp:
        soort = n.tags.get("place")
        if soort not in SOORTEN:
            continue
        naam = n.tags.get("name")
        if not naam:
            continue
        inwoners = getal(n.tags.get("population"))
        if inwoners < MIN_INWONERS[soort]:
            continue

        x, y = latlon_naar_meters(n.location.lat, n.location.lon)
        plaatsen.append({
            "naam": naam,
            "soort": soort,
            "inwoners": inwoners,
            "x": round(x, 1),
            "y": round(y, 1),
            "zoom": SOORTEN[soort]["zoom"],
        })

    # Grootste eerst; bij gelijke stand steden voor dorpen
    plaatsen.sort(key=lambda p: (-p["inwoners"], SOORTEN[p["soort"]]["rang"], p["naam"]))
    plaatsen = plaatsen[:maximaal]
    plaatsen.sort(key=lambda p: p["naam"])

    with open(uit_pad, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "center": CENTER_NL, "plaatsen": plaatsen}, f,
                  separators=(",", ":"), ensure_ascii=False)

    log.info("%d plaatsen opgeslagen (%.0f KB)", len(plaatsen), os.path.getsize(uit_pad) / 1024)
    for p in sorted(plaatsen, key=lambda p: -p["inwoners"])[:8]:
        log.info("  %-22s %s inwoners", p["naam"], f"{p['inwoners']:,}".replace(",", "."))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Maak de stedenlijst uit een OSM-extract")
    p.add_argument("pbf", nargs="?", default=os.path.join(DATA_DIR, "netherlands-latest.osm.pbf"))
    p.add_argument("--uit", default=os.path.join(DATA_DIR, "steden.json"))
    p.add_argument("--maximaal", type=int, default=400)
    args = p.parse_args()
    genereer(args.pbf, args.uit, args.maximaal)
