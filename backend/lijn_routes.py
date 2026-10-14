#!/usr/bin/env python3
"""
Bussie Lijnroute Generator
Bouwt per buslijn en per richting één geometrische route uit de statische GTFS:
de polyline, de cumulatieve afstand langs die polyline, en de haltes met hun
afstand langs de route.

Uitvoer: data/lijnen.json

De renderer gebruikt dit om bussen *langs hun eigen route* te laten glijden
in plaats van in rechte lijnen tussen twee peilingen te springen, en om te
weten welke halte een bus als volgende aandoet.
"""

import csv
import io
import json
import logging
import math
import os
import struct
import sys
import zipfile
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("lijn-routes")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
GTFS_ZIP_PATH = os.path.join(DATA_DIR, "gtfs-nl.zip")
OUT_PATH = os.path.join(DATA_DIR, "lijnen.json")
BIN_PATH = os.path.join(DATA_DIR, "lijnen.bin")

# Landelijk nulpunt — moet gelijk zijn aan tegels.py CENTER_NL, anders
# liggen de lijnen niet op de kaart.
CENTER = {"lon": 5.4, "lat": 52.15}
# Standaard heel Nederland; met --gebied groningen kan het ook klein blijven
BBOX = [50.70, 3.30, 53.60, 7.30]  # min_lat, min_lon, max_lat, max_lon
AGENCIES = None                    # None = alle vervoerders

# Standaardkleur voor lijnen zonder eigen route_color
DEFAULT_KLEUR = "#8aa0b2"

# Vereenvoudiging van de polyline (meter). Onder een paar meter ziet niemand
# het verschil, en landelijk scheelt het tientallen procenten.
SIMPLIFY_EPS = 4.0

# Een lijn rijdt niet altijd dezelfde vorm: er zijn ritvarianten, spitsritten
# die een lus overslaan en korte ritten die halverwege eindigen. We bewaren
# naast de hoofdvorm elke variant die minstens dit deel van de ritten van die
# lijn en richting rijdt; een bus krijgt via zijn shape_id de vorm van zijn
# eigen rit. Lager zetten vindt meer omleidingen, maar maakt de bundel zwaarder.
VARIANT_DREMPEL = 0.25


def latlon_to_meters(lat, lon):
    """Web Mercator naar lokale meters — identiek aan kaart_generator.py."""
    R = 6378137
    n = math.pi / 180
    cos_lat = math.cos(CENTER["lat"] * n)
    x = (lon - CENTER["lon"]) * n * R * cos_lat
    y = -(lat - CENTER["lat"]) * n * R
    return [round(x, 1), round(y, 1)]


def in_bbox(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def simplify(pts, eps):
    """Douglas-Peucker, iteratief zodat lange shapes de recursielimiet niet halen."""
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = pts[first]
        bx, by = pts[last]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        best_d = 0.0
        best_i = -1
        for i in range(first + 1, last):
            px, py = pts[i]
            if norm == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best_d:
                best_d = d
                best_i = i
        if best_d > eps and best_i > 0:
            keep[best_i] = True
            stack.append((first, best_i))
            stack.append((best_i, last))
    return [p for p, k in zip(pts, keep) if k]


def lees_routes(zf):
    """route_id → route-info, alleen voor de vervoerders die we tonen."""
    routes = {}
    with zf.open("routes.txt") as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            if AGENCIES and row.get("agency_id", "") not in AGENCIES:
                continue
            kleur = (row.get("route_color") or "").strip()
            routes[row["route_id"]] = {
                "lijn": row.get("route_short_name", "").strip(),
                "naam": row.get("route_long_name", "").strip(),
                "kleur": f"#{kleur}" if len(kleur) == 6 else DEFAULT_KLEUR,
            }
    log.info("  %d routes van %s", len(routes), "/".join(sorted(AGENCIES)) if AGENCIES else "alle vervoerders")
    return routes


def lees_trips(zf, routes):
    """Tel ritten per (route_id, richting, shape_id) en onthoud één voorbeeldrit."""
    tellingen = defaultdict(int)
    voorbeeld = {}  # shape_id → (trip_id, headsign)
    with zf.open("trips.txt") as f:
        reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8"))
        hdr = next(reader)
        i_route = hdr.index("route_id")
        i_trip = hdr.index("trip_id")
        i_head = hdr.index("trip_headsign")
        i_dir = hdr.index("direction_id")
        i_shape = hdr.index("shape_id")
        for row in reader:
            if row[i_route] not in routes:
                continue
            shape_id = row[i_shape]
            if not shape_id:
                continue
            tellingen[(row[i_route], row[i_dir], shape_id)] += 1
            if shape_id not in voorbeeld:
                voorbeeld[shape_id] = (row[i_trip], row[i_head])
    log.info("  %d shape-varianten in %d lijncombinaties", len(voorbeeld), len(tellingen))
    return tellingen, voorbeeld


def lees_shapes(zf, shape_ids):
    """Lees de gevraagde shapes en houd alleen die door ons gebied lopen.

    shapes.txt is 280 MB, dus we streamen en groeperen op opeenvolgende
    shape_id in plaats van alles in geheugen te houden.
    """
    shapes = {}
    huidig_id = None
    buffer = []
    raakt_bbox = False

    def flush():
        if huidig_id is not None and raakt_bbox and len(buffer) >= 2:
            buffer.sort()
            shapes[huidig_id] = [(lat, lon, dist) for _, lat, lon, dist in buffer]

    with zf.open("shapes.txt") as f:
        reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8"))
        hdr = next(reader)
        i_id, i_seq = hdr.index("shape_id"), hdr.index("shape_pt_sequence")
        i_lat, i_lon = hdr.index("shape_pt_lat"), hdr.index("shape_pt_lon")
        i_dist = hdr.index("shape_dist_traveled") if "shape_dist_traveled" in hdr else -1
        for row in reader:
            sid = row[i_id]
            if sid != huidig_id:
                flush()
                huidig_id = sid
                buffer = []
                raakt_bbox = False
            if sid not in shape_ids:
                continue
            try:
                lat = float(row[i_lat])
                lon = float(row[i_lon])
                seq = int(row[i_seq])
                dist = float(row[i_dist]) if i_dist >= 0 and row[i_dist] else None
            except ValueError:
                continue
            buffer.append((seq, lat, lon, dist))
            if not raakt_bbox and in_bbox(lat, lon):
                raakt_bbox = True
        flush()

    log.info("  %d shapes door het gebied", len(shapes))
    return shapes


def lees_stop_times(zf, trip_ids):
    """Haltevolgorde per rit. stop_times.txt is 1,4 GB — één streamende pass."""
    per_trip = defaultdict(list)
    with zf.open("stop_times.txt") as f:
        reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8"))
        hdr = next(reader)
        i_trip, i_seq, i_stop = hdr.index("trip_id"), hdr.index("stop_sequence"), hdr.index("stop_id")
        i_dist = hdr.index("shape_dist_traveled") if "shape_dist_traveled" in hdr else -1
        for row in reader:
            if row[i_trip] not in trip_ids:
                continue
            try:
                seq = int(row[i_seq])
                dist = float(row[i_dist]) if i_dist >= 0 and row[i_dist] else None
            except ValueError:
                continue
            per_trip[row[i_trip]].append((seq, row[i_stop], dist))
    for v in per_trip.values():
        v.sort()
    log.info("  haltevolgorde voor %d ritten", len(per_trip))
    return per_trip


def lees_stops(zf, stop_ids):
    stops = {}
    with zf.open("stops.txt") as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            sid = row.get("stop_id", "")
            if sid not in stop_ids:
                continue
            try:
                lat, lon = float(row["stop_lat"]), float(row["stop_lon"])
            except (ValueError, KeyError):
                continue
            stops[sid] = {"naam": row.get("stop_name", ""), "lat": lat, "lon": lon}
    log.info("  %d haltes opgezocht", len(stops))
    return stops


def bouw_route(info, shape_pts, halte_rijen, stops):
    """Zet één shape om naar een lijnroute met cumulatieve afstanden."""
    pts = [latlon_to_meters(lat, lon) for lat, lon, _ in shape_pts]
    # Dubbele punten eruit — die maken de cum-tabel alleen maar langer
    schoon = [pts[0]]
    for p in pts[1:]:
        if p != schoon[-1]:
            schoon.append(p)
    pts = simplify(schoon, SIMPLIFY_EPS)
    if len(pts) < 2:
        return None

    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    lengte = cum[-1]

    # GTFS-afstanden schalen naar onze eigen (vereenvoudigde) lengte.
    gtfs_totaal = shape_pts[-1][2]
    haltes = []
    for _, stop_id, gtfs_dist in halte_rijen:
        s = stops.get(stop_id)
        if not s:
            continue
        x, y = latlon_to_meters(s["lat"], s["lon"])
        if gtfs_dist is not None and gtfs_totaal:
            d = lengte * (gtfs_dist / gtfs_totaal)
        else:
            d = afstand_langs(pts, cum, x, y)
        haltes.append({
            "id": stop_id,
            "naam": s["naam"],
            "x": x,
            "y": y,
            "d": round(d, 1),
        })

    return {
        "lijn": info["lijn"],
        "richting": info["richting"],
        "naam": info["naam"],
        "bestemming": info["bestemming"],
        "kleur": info["kleur"],
        "rids": sorted(info["rids"]),
        "sid": info["shape_id"],
        "lengte": round(lengte, 1),
        "pts": pts,
        "cum": [round(c, 1) for c in cum],
        "haltes": haltes,
    }


def afstand_langs(pts, cum, x, y):
    """Projecteer een punt op de polyline en geef de afstand langs de route."""
    beste_d, beste_afstand = 0.0, float("inf")
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx, dy = bx - ax, by - ay
        lengte2 = dx * dx + dy * dy
        t = 0.0 if lengte2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / lengte2))
        px, py = ax + t * dx, ay + t * dy
        afstand = math.hypot(x - px, y - py)
        if afstand < beste_afstand:
            beste_afstand = afstand
            beste_d = cum[i] + t * math.hypot(dx, dy)
    return beste_d


# ---------------------------------------------------------------------------
# Binair lijnformaat (BLN1)
# ---------------------------------------------------------------------------
#
# Als JSON is dit bestand 20 MB, en dat is bij het eerste bezoek het enige
# dat de kaart nog tegenhoudt. Binair blijft er 5 MB over (3 MB over de
# lijn), en de browser hoeft geen 20 MB tekst te ontleden.
#
# Twee dingen doen het werk. De haltes staan één keer in een tabel in plaats
# van gemiddeld twee keer per lijn die er stopt, en de punten van een route
# staan als verschil met hun voorganger: twee bytes per stap in plaats van
# een reeks cijfers. Coördinaten gaan in decimeters — de bron rondt toch al
# op een decimeter af — en een sprong die niet in twee bytes past krijgt een
# ontsnappingswaarde met de volle positie erachter.

# BLN2 draagt per route ook het shape_id, zodat de kaart een bus aan de vorm
# van zijn eigen rit kan koppelen in plaats van aan de hoofdvorm van de lijn.
BIN_MAGIC = b"BLN2"
SPRONG = -32768          # dx == dy == dit: hierna volgt een absolute positie


def _tekst(b):
    """Lengte in één byte, dan de bytes zelf. Alles hier past ruim."""
    return struct.pack("<B", len(b)) + b


def codeer_lijnen(lijnen):
    """Zet de lijnroutes om naar het binaire formaat dat de browser leest."""
    haltes = {}   # halte-id → (index, halte)
    for r in lijnen:
        for h in r.get("haltes", []):
            if h["id"] not in haltes:
                haltes[h["id"]] = (len(haltes), h)

    uit = bytearray(BIN_MAGIC)

    uit += struct.pack("<I", len(haltes))
    for _, h in haltes.values():
        uit += _tekst(h["id"].encode("utf-8"))
        uit += _tekst(h["naam"].encode("utf-8"))
        uit += struct.pack("<ii", round(h["x"] * 10), round(h["y"] * 10))

    uit += struct.pack("<I", len(lijnen))
    for r in lijnen:
        uit += _tekst(r["lijn"].encode("utf-8"))
        uit += struct.pack("<B", r["richting"])
        uit += _tekst(r["naam"].encode("utf-8"))
        uit += _tekst(r["bestemming"].encode("utf-8"))
        uit += bytes.fromhex(r["kleur"].lstrip("#"))

        uit += _tekst(str(r.get("sid", "")).encode("utf-8"))

        rids = list(r.get("rids", []))
        uit += struct.pack("<B", len(rids))
        for rid in rids:
            uit += _tekst(str(rid).encode("utf-8"))

        punten = r["pts"]
        uit += struct.pack("<I", len(punten))
        vx = vy = 0
        for i, (x, y) in enumerate(punten):
            qx, qy = round(x * 10), round(y * 10)
            if i == 0:
                uit += struct.pack("<ii", qx, qy)
            else:
                dx, dy = qx - vx, qy - vy
                if -32767 <= dx <= 32767 and -32767 <= dy <= 32767:
                    uit += struct.pack("<hh", dx, dy)
                else:
                    uit += struct.pack("<hhii", SPRONG, SPRONG, qx, qy)
            vx, vy = qx, qy

        eigen = r.get("haltes", [])
        uit += struct.pack("<H", len(eigen))
        for h in eigen:
            uit += struct.pack("<II", haltes[h["id"]][0], round(h["d"] * 10))

    return bytes(uit)


def schrijf_binair(json_pad=OUT_PATH, bin_pad=BIN_PATH):
    """lijnen.json → lijnen.bin. Draait ook los van de zware generator."""
    with open(json_pad, encoding="utf-8") as f:
        lijnen = json.load(f).get("lijnen", [])
    blob = codeer_lijnen(lijnen)
    tijdelijk = bin_pad + ".tmp"
    with open(tijdelijk, "wb") as f:
        f.write(blob)
    os.replace(tijdelijk, bin_pad)
    return len(blob)


def genereer():
    if not os.path.exists(GTFS_ZIP_PATH):
        log.error("GTFS zip ontbreekt: %s", GTFS_ZIP_PATH)
        sys.exit(1)

    with zipfile.ZipFile(GTFS_ZIP_PATH, "r") as zf:
        log.info("Routes lezen...")
        routes = lees_routes(zf)

        log.info("Ritten lezen (84 MB)...")
        tellingen, voorbeeld = lees_trips(zf, routes)

        log.info("Shapes lezen (280 MB, dit duurt even)...")
        shapes = lees_shapes(zf, set(voorbeeld))

        # Kies per route+richting de shape met de meeste ritten. Sleutelen
        # op lijnnúmmer kan niet: lijn 1 bestaat in Groningen, Amsterdam,
        # Rotterdam en Den Haag, en die zouden dan samenvallen tot één vorm.
        # Alleen het route_id is landelijk uniek.
        vormen = defaultdict(dict)  # (route_id, richting) → {shape_id: ritten}
        for (route_id, richting, shape_id), aantal in tellingen.items():
            if shape_id not in shapes:
                continue
            if not routes[route_id]["lijn"]:
                continue
            vormen[(route_id, richting)][shape_id] = aantal

        # Per lijn en richting de hoofdvorm plus de noemenswaardige varianten.
        # De hoofdvorm draagt het route_id en is waar een bus op terugvalt als
        # we zijn rit niet kennen; een variant is alleen via zijn shape_id te
        # vinden, zodat lijn 4 niet ineens langs de spitsroute gaat liggen.
        kandidaten = []
        for (route_id, richting), per_shape in vormen.items():
            r = routes[route_id]
            totaal = sum(per_shape.values())
            hoofd = max(per_shape, key=lambda sid: (per_shape[sid], sid))
            for shape_id, aantal in sorted(per_shape.items(),
                                           key=lambda kv: (-kv[1], kv[0])):
                if shape_id != hoofd and aantal < totaal * VARIANT_DREMPEL:
                    continue
                kandidaten.append({
                    "lijn": r["lijn"],
                    "richting": int(richting) if richting.isdigit() else 0,
                    "naam": r["naam"],
                    "kleur": r["kleur"],
                    "bestemming": voorbeeld[shape_id][1],
                    "rids": {route_id} if shape_id == hoofd else set(),
                    "shape_id": shape_id,
                    "aantal": aantal,
                })

        varianten = sum(1 for k in kandidaten if not k["rids"])
        log.info("  %d lijn/richting-combinaties, %d vormen (%d varianten)",
                 len(vormen), len(kandidaten), varianten)

        gekozen_trips = {voorbeeld[k["shape_id"]][0] for k in kandidaten}
        log.info("Haltevolgorde lezen (1,4 GB, dit duurt het langst)...")
        halte_rijen = lees_stop_times(zf, gekozen_trips)

        stop_ids = {s for rijen in halte_rijen.values() for _, s, _ in rijen}
        log.info("Halte-informatie lezen...")
        stops = lees_stops(zf, stop_ids)

    lijnen = []
    for info in kandidaten:
        trip_id = voorbeeld[info["shape_id"]][0]
        route = bouw_route(info, shapes[info["shape_id"]], halte_rijen.get(trip_id, []), stops)
        if route:
            lijnen.append(route)

    lijnen.sort(key=lambda r: (nummer_sleutel(r["lijn"]), r["richting"]))

    uitvoer = {
        "regio": "groningen",
        "center": CENTER,
        "lijnen": lijnen,
    }
    # `cum` laten we weg: de frontend rekent die in een paar milliseconden
    # zelf uit de punten, en het scheelt een derde van het bestand.
    for r in lijnen:
        r.pop("cum", None)

    # Via een tijdelijk bestand: de draaiende backend bouwt lijnen.bin
    # opnieuw zodra lijnen.json nieuwer is, en die mag daarbij nooit een
    # half weggeschreven bestand aantreffen.
    tijdelijk = OUT_PATH + ".tmp"
    with open(tijdelijk, "w", encoding="utf-8") as f:
        json.dump(uitvoer, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tijdelijk, OUT_PATH)

    mb = os.path.getsize(OUT_PATH) / 1024 / 1024
    log.info("Opgeslagen: %s (%.1f MB)", OUT_PATH, mb)

    # De frontend haalt de binaire versie op; de JSON blijft als bron staan.
    bin_bytes = schrijf_binair()
    log.info("Opgeslagen: %s (%.1f MB)", BIN_PATH, bin_bytes / 1024 / 1024)

    log.info("  %d lijnroutes, %d punten, %d haltes",
             len(lijnen),
             sum(len(r["pts"]) for r in lijnen),
             sum(len(r["haltes"]) for r in lijnen))


def nummer_sleutel(lijn):
    """Sorteer '3' voor '11' voor 'Q1'."""
    cijfers = "".join(c for c in lijn if c.isdigit())
    return (int(cijfers) if cijfers else 9999, lijn)


if __name__ == "__main__":
    if "--alleen-binair" in sys.argv:
        # De zware kant (1,4 GB stop_times) overslaan en enkel lijnen.json
        # opnieuw inpakken.
        log.info("Opgeslagen: %s (%.1f MB)", BIN_PATH, schrijf_binair() / 1024 / 1024)
    else:
        genereer()
