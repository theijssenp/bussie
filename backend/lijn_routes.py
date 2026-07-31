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
import sys
import zipfile
from collections import defaultdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("lijn-routes")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
GTFS_ZIP_PATH = os.path.join(DATA_DIR, "gtfs-nl.zip")
OUT_PATH = os.path.join(DATA_DIR, "lijnen.json")

# Moet gelijk zijn aan kaart_generator.py
CENTER = {"lon": 6.563, "lat": 53.2265}
BBOX = [53.18, 6.50, 53.28, 6.62]  # min_lat, min_lon, max_lat, max_lon
AGENCIES = {"QBUZZ"}

# Standaardkleur voor lijnen zonder eigen route_color
DEFAULT_KLEUR = "#8aa0b2"

# Vereenvoudiging van de polyline (meter). Onder ~2m ziet niemand het verschil,
# maar het scheelt de helft van de bestandsgrootte.
SIMPLIFY_EPS = 2.0


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
            if row.get("agency_id", "") not in AGENCIES:
                continue
            kleur = (row.get("route_color") or "").strip()
            routes[row["route_id"]] = {
                "lijn": row.get("route_short_name", "").strip(),
                "naam": row.get("route_long_name", "").strip(),
                "kleur": f"#{kleur}" if len(kleur) == 6 else DEFAULT_KLEUR,
            }
    log.info("  %d routes van %s", len(routes), "/".join(sorted(AGENCIES)))
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

        # Kies per lijn+richting de shape met de meeste ritten die door
        # ons gebied loopt. Meerdere route_ids kunnen hetzelfde lijnnummer
        # dragen (concessiewissels), die voegen we samen.
        kandidaten = {}  # (lijn, richting) → dict
        for (route_id, richting, shape_id), aantal in tellingen.items():
            if shape_id not in shapes:
                continue
            r = routes[route_id]
            if not r["lijn"]:
                continue
            sleutel = (r["lijn"], richting)
            huidig = kandidaten.get(sleutel)
            if huidig is None:
                huidig = kandidaten[sleutel] = {
                    "lijn": r["lijn"],
                    "richting": int(richting) if richting.isdigit() else 0,
                    "naam": r["naam"],
                    "kleur": r["kleur"],
                    "bestemming": voorbeeld[shape_id][1],
                    "rids": set(),
                    "shape_id": shape_id,
                    "aantal": aantal,
                }
            huidig["rids"].add(route_id)
            if aantal > huidig["aantal"]:
                huidig["aantal"] = aantal
                huidig["shape_id"] = shape_id
                huidig["bestemming"] = voorbeeld[shape_id][1]

        log.info("  %d lijn/richting-combinaties", len(kandidaten))

        gekozen_trips = {voorbeeld[k["shape_id"]][0] for k in kandidaten.values()}
        log.info("Haltevolgorde lezen (1,4 GB, dit duurt het langst)...")
        halte_rijen = lees_stop_times(zf, gekozen_trips)

        stop_ids = {s for rijen in halte_rijen.values() for _, s, _ in rijen}
        log.info("Halte-informatie lezen...")
        stops = lees_stops(zf, stop_ids)

    lijnen = []
    for info in kandidaten.values():
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
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(uitvoer, f, separators=(",", ":"), ensure_ascii=False)

    mb = os.path.getsize(OUT_PATH) / 1024 / 1024
    log.info("Opgeslagen: %s (%.1f MB)", OUT_PATH, mb)
    log.info("  %d lijnroutes, %d punten, %d haltes",
             len(lijnen),
             sum(len(r["pts"]) for r in lijnen),
             sum(len(r["haltes"]) for r in lijnen))


def nummer_sleutel(lijn):
    """Sorteer '3' voor '11' voor 'Q1'."""
    cijfers = "".join(c for c in lijn if c.isdigit())
    return (int(cijfers) if cijfers else 9999, lijn)


if __name__ == "__main__":
    genereer()
