#!/usr/bin/env python3
"""
Bussie GTFS-RT Processor
Haalt realtime voertuigposities op van gtfs.ovapi.nl,
filtert per stad/operator, en serveert compacte JSON.
"""

import urllib.request
import urllib.error
import json
import time
import threading
import logging
import os
import sys
from collections import defaultdict
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

from google.transit import gtfs_realtime_pb2
from trace_db import get_db, store_positions, generate_route_traces, get_all_traces, get_trace_stats

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
FEED_URL = "https://gtfs.ovapi.nl/nl/vehiclePositions.pb"
GTFS_ZIP_URL = "https://gtfs.ovapi.nl/nl/gtfs-nl.zip"
USER_AGENT = "bussie.hodc.nl/0.1 (herm@theijssen.nl)"

# Stad → operator + gebiedsfilter (bounding box lat/lon)
# Operators per stad gebaseerd op gtfs.ovapi.nl directory structuur
CITIES = {
    "groningen": {
        "operators": ["QBUZZ"],
        # Bounding box Groningen centrum + omgeving
        # MOET overeenkomen met kaart_generator.py CENTER
        "bbox": [53.18, 6.50, 53.28, 6.62],
        "center": [6.563, 53.2265],
    },
}

# Cache voor statische GTFS data: route_id → {short_name, long_name, type}
ROUTE_CACHE = {}  # route_id → {short_name, long_name, route_type}
STOP_CACHE = {}   # stop_id → {name, lat, lon}
TRIP_CACHE = {}    # trip_id → {route_id, trip_headsign, direction_id}

# Laatst opgehaalde realtime data per stad
REALTIME_CACHE = {}  # city → {v, ts, vehicles: [...]}
REALTIME_LOCK = threading.Lock()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("bussie")


# ---------------------------------------------------------------------------
# Statische GTFS laden
# ---------------------------------------------------------------------------

def load_static_gtfs():
    """Download en parse statische GTFS data (routes, stops, trips)."""
    import zipfile
    import csv
    import io

    zip_path = os.path.join(DATA_DIR, "gtfs-nl.zip")

    # Download als bestand nog niet bestaat of ouder is dan 24 uur
    need_download = True
    if os.path.exists(zip_path):
        age = time.time() - os.path.getmtime(zip_path)
        if age < 86400:
            need_download = False
            log.info("Statische GTFS al aanwezig (%.1f uur oud)", age / 3600)

    if need_download:
        log.info("Statische GTFS downloaden van %s", GTFS_ZIP_URL)
        req = urllib.request.Request(GTFS_ZIP_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as resp:
            with open(zip_path, "wb") as f:
                f.write(resp.read())
        log.info("Statische GTFS opgeslagen: %s (%d KB)", zip_path, os.path.getsize(zip_path) // 1024)

    # Parse ZIP
    log.info("Statische GTFS parsen...")
    with zipfile.ZipFile(zip_path, "r") as zf:
        # Routes
        if "routes.txt" in zf.namelist():
            with zf.open("routes.txt") as f:
                reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
                for row in reader:
                    route_id = row.get("route_id", "")
                    ROUTE_CACHE[route_id] = {
                        "short_name": row.get("route_short_name", ""),
                        "long_name": row.get("route_long_name", ""),
                        "route_type": row.get("route_type", ""),
                        "agency_id": row.get("agency_id", ""),
                    }
            log.info("  %d routes geladen", len(ROUTE_CACHE))

        # Stops
        if "stops.txt" in zf.namelist():
            with zf.open("stops.txt") as f:
                reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
                for row in reader:
                    stop_id = row.get("stop_id", "")
                    lat = row.get("stop_lat", "")
                    lon = row.get("stop_lon", "")
                    try:
                        lat = float(lat) if lat else None
                        lon = float(lon) if lon else None
                    except ValueError:
                        lat = lon = None
                    STOP_CACHE[stop_id] = {
                        "name": row.get("stop_name", ""),
                        "lat": lat,
                        "lon": lon,
                    }
            log.info("  %d stops geladen", len(STOP_CACHE))

        # Trips (alleen route_id mapping — headsign is nuttig)
        if "trips.txt" in zf.namelist():
            with zf.open("trips.txt") as f:
                reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
                for row in reader:
                    trip_id = row.get("trip_id", "")
                    TRIP_CACHE[trip_id] = {
                        "route_id": row.get("route_id", ""),
                        "trip_headsign": row.get("trip_headsign", ""),
                        "direction_id": row.get("direction_id", ""),
                    }
            log.info("  %d trips geladen", len(TRIP_CACHE))

    log.info("Statische GTFS klaar")


def build_gtfs_ids(city):
    """Bouw gtfs-ids mapping: lijnnummer → [route_ids] voor een stad."""
    city_cfg = CITIES.get(city)
    if not city_cfg:
        return {}

    # Groepeer route_ids per short_name (lijnnummer)
    lines = defaultdict(list)
    for route_id, info in ROUTE_CACHE.items():
        short_name = info.get("short_name", "")
        if not short_name:
            continue
        # Filter op operator via trip_id prefix in route_id
        # route_ids in deze feed zijn numeriek, we moeten via trips filteren
        lines[short_name].append(route_id)

    # Voor Groningen: filter op QBUZZ trips
    # QBUZZ trip_ids hebben format: QBUZZ:gXXX:YYYY in entity.id
    # We kunnen filteren door te kijken welke route_ids voorkomen in QBUZZ vehicles
    # Voor nu: return alles, frontend filtert
    return dict(lines)


# ---------------------------------------------------------------------------
# Realtime polling
# ---------------------------------------------------------------------------

def filter_vehicles(feed, city):
    """Filter feed entities voor een specifieke stad."""
    cfg = CITIES.get(city)
    if not cfg or not feed:
        return []

    operators = set(cfg["operators"])
    bbox = cfg["bbox"]  # [min_lat, min_lon, max_lat, max_lon]
    min_lat, min_lon, max_lat, max_lon = bbox

    vehicles = []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue

        v = entity.vehicle

        # Operator filter via entity.id format: "2026-07-26:QBUZZ:g510:7033"
        parts = entity.id.split(":")
        if len(parts) < 2:
            continue
        operator = parts[1]
        if operator not in operators:
            continue

        # Bounding box filter
        if not v.HasField("position"):
            continue
        lat = v.position.latitude
        lon = v.position.longitude
        if lat < min_lat or lat > max_lat or lon < min_lon or lon > max_lon:
            continue

        # Bouw compact vehicle object
        route_id = v.trip.route_id if v.HasField("trip") else ""
        trip_id = str(v.trip.trip_id) if v.HasField("trip") else ""

        # Lijnnummer via route cache
        route_info = ROUTE_CACHE.get(route_id, {})
        line_number = route_info.get("short_name", "")

        # Eindbestemming via trip cache
        trip_info = TRIP_CACHE.get(trip_id, {})
        headsign = trip_info.get("trip_headsign", "")

        # Status: 0=at stop, 1=in transit, 2=approaching
        # GTFS-RT: 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSITION_TO
        current_status = v.current_status if v.HasField("current_status") else 0

        # Bearing (richting in graden, 0=noord, 90=oost, etc.)
        bearing = None
        if v.HasField("position") and v.position.HasField("bearing"):
            bearing = round(v.position.bearing, 1)

        # Snelheid in m/s
        speed = None
        if v.HasField("position") and v.position.HasField("speed"):
            speed = round(v.position.speed, 1)

        vehicle = {
            "id": entity.id,
            "rid": route_id,
            "tid": trip_id,
            "lijn": line_number,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "t": v.timestamp if v.HasField("timestamp") else int(time.time()),
            "st": int(current_status),
            "stop": v.stop_id if v.HasField("stop_id") else None,
            "lbl": v.vehicle.label if v.HasField("vehicle") and v.vehicle.HasField("label") else "",
            "bestemming": headsign,
            "richting": v.trip.direction_id if v.HasField("trip") and v.trip.HasField("direction_id") else None,
            "bearing": bearing,
            "snelheid": speed,
        }
        vehicles.append(vehicle)

    return vehicles


_last_etag = None
_last_modified = None

def fetch_realtime():
    """Haal realtime vehiclePositions.pb op en parse. Met caching headers."""
    global _last_etag, _last_modified
    try:
        headers = {"User-Agent": USER_AGENT}
        # Stuur If-None-Match / If-Modified-Since mee om 304's te krijgen
        if _last_etag:
            headers["If-None-Match"] = _last_etag
        if _last_modified:
            headers["If-Modified-Since"] = _last_modified

        req = urllib.request.Request(FEED_URL, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            # Sla caching headers op
            _last_etag = resp.headers.get("ETag", _last_etag)
            _last_modified = resp.headers.get("Last-Modified", _last_modified)
            data = resp.read()
        log.debug("Realtime feed: %d bytes (etag=%s)", len(data), _last_etag)

        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(data)
        return feed
    except urllib.error.HTTPError as e:
        if e.code == 304:
            log.debug("Realtime feed niet gewijzigd (304)")
            return None  # Geen nieuwe data — behoud cache
        if e.code == 429:
            log.warning("Rate limit bereikt (429) — volgende poging over 60s")
            return None
        log.warning("Realtime fetch HTTP %d: %s", e.code, e.reason)
        return None
    except Exception as e:
        log.warning("Realtime fetch failed: %s", e)
        return None


# Trace database + feed timestamp voor data_ts
_trace_db = None
_last_feed_ts = 0

def poll_loop():
    """Continu realtime data ophalen, elke 30 seconden.
    Slaat posities op in SQLite voor route-reconstructie."""
    global _trace_db, _last_feed_ts
    log.info("Realtime poll loop gestart (interval: 30s)")
    _trace_db = get_db()
    while True:
        feed = fetch_realtime()
        if feed:
            _last_feed_ts = feed.header.timestamp
            with REALTIME_LOCK:
                all_vehicles = []
                for city in CITIES:
                    vehicles = filter_vehicles(feed, city)
                    REALTIME_CACHE[city] = {
                        "v": 1,
                        "ts": int(time.time()),
                        "voertuigen": vehicles,
                    }
                    all_vehicles.extend(vehicles)
                log.info("Realtime update: %s",
                         ", ".join(f"{c}={len(REALTIME_CACHE[c]['voertuigen'])}" for c in CITIES))
                
                # Sla posities op in trace database
                if _trace_db and all_vehicles:
                    stored = store_positions(_trace_db, all_vehicles)
                    if stored > 0:
                        log.debug("  %d posities opgeslagen in trace db", stored)

        # 20 seconden — eigen tempo, data wordt via SQLite geserveerd
        time.sleep(20)


# ---------------------------------------------------------------------------
# HTTP Server
# ---------------------------------------------------------------------------

class BussieHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Stiller dan default
        pass

    def _send_json(self, data, status=200, cache="public, max-age=30"):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type, cache="public, max-age=600"):
        if not os.path.exists(path):
            self.send_error(404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]

        # API endpoints
        if path == "/api/voertuigen":
            # Support /api/voertuigen?stad=groningen
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            city = qs.get("stad", ["groningen"])[0]
            with REALTIME_LOCK:
                data = REALTIME_CACHE.get(city, {"v": 1, "ts": 0, "voertuigen": []})
            self._send_json(data)
            return

        if path == "/api/steden":
            steden = []
            for city, cfg in CITIES.items():
                steden.append({
                    "id": city,
                    "naam": city.capitalize(),
                    "center": cfg["center"],
                })
            self._send_json({"steden": steden}, cache="public, max-age=3600")
            return

        if path.startswith("/api/gtfs-ids/"):
            city = path.split("/")[-1]
            ids = build_gtfs_ids(city)
            self._send_json(ids, cache="public, max-age=3600")
            return

        if path == "/api/lijnen":
            # Alle lijnnummers voor een stad met route info
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            city = qs.get("stad", ["groningen"])[0]
            with REALTIME_LOCK:
                data = REALTIME_CACHE.get(city, {})
            vehicles = data.get("voertuigen", [])
            lijnen = {}
            for v in vehicles:
                lijn = v.get("lijn", "")
                if lijn and lijn not in lijnen:
                    lijnen[lijn] = {
                        "lijn": lijn,
                        "bestemming": v.get("bestemming", ""),
                        "richting": v.get("richting"),
                    }
            self._send_json({"lijnen": list(lijnen.values())}, cache="public, max-age=30")
            return

        if path == "/api/traces":
            # Alle gegenereerde route traces
            import trace_db as tdb
            if tdb._trace_db:
                traces = get_all_traces(tdb._trace_db)
                self._send_json(traces, cache="public, max-age=60")
            else:
                self._send_json({}, cache="public, max-age=60")
            return

        if path == "/api/traces/stats":
            # Database statistieken
            import trace_db as tdb
            if tdb._trace_db:
                stats = get_trace_stats(tdb._trace_db)
                self._send_json(stats, cache="public, max-age=30")
            else:
                self._send_json({"error": "trace db niet actief"})
            return

        if path == "/api/traces/regenerate":
            # Handmatig route traces regenereren
            import trace_db as tdb
            if tdb._trace_db:
                count = generate_route_traces(tdb._trace_db)
                self._send_json({"generated": count})
            else:
                self._send_json({"error": "trace db niet actief"})
            return

        if path == "/api/voertuigen/db":
            # Eigen datalaag: serveer latest_vehicles uit SQLite
            # Onafhankelijk van de in-memory cache — blijft werken na restart
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            city = qs.get("stad", ["groningen"])[0]
            history = qs.get("history", ["0"])[0] == "2"
            import trace_db as tdb
            if tdb._trace_db:
                # data_ts = feed timestamp (verandert alleen als gtfs.ovapi nieuwe data stuurt)
                # Importeer _last_feed_ts uit de module globals
                import sys
                this_mod = sys.modules.get('__main__')
                data_ts = getattr(this_mod, '_last_feed_ts', 0)

                if history:
                    # Laad 2 laatste posities per voertuig voor vloeiende start
                    # Alleen voertuigen die in de laatste 5 minuten zijn bijgewerkt
                    cutoff = int(time.time()) - 300
                    cursor = tdb._trace_db.execute("""
                        SELECT vehicle_id, trip_id, route_id, lijn, richting, bestemming,
                               lat, lon, status, bearing, speed, lbl, timestamp
                        FROM latest_vehicles
                        WHERE lijn IS NOT NULL AND lijn != ''
                          AND timestamp >= ?
                        ORDER BY lijn
                    """, (cutoff,))
                    vehicles = []
                    for r in cursor.fetchall():
                        vehicles.append({
                            "id": r[0], "tid": r[1], "rid": r[2], "lijn": r[3],
                            "richting": r[4], "bestemming": r[5],
                            "lat": r[6], "lon": r[7], "st": r[8],
                            "bearing": r[9], "snelheid": r[10], "lbl": r[11], "t": r[12],
                        })
                    # Haal voor elk voertuig ook de 1-na-laatste positie op
                    prev = {}
                    cursor2 = tdb._trace_db.execute("""
                        SELECT vehicle_id, lat, lon, timestamp
                        FROM (
                            SELECT vehicle_id, lat, lon, timestamp,
                                   ROW_NUMBER() OVER (PARTITION BY vehicle_id ORDER BY stored_at DESC) as rn
                            FROM vehicle_positions
                        )
                        WHERE rn = 2
                    """)
                    for row in cursor2:
                        prev[row[0]] = {"lat": row[1], "lon": row[2], "t": row[3]}
                    self._send_json({
                        "v": 2,
                        "ts": int(time.time()),
                        "data_ts": data_ts,
                        "voertuigen": vehicles,
                        "historie": prev,
                    }, cache="public, max-age=30")
                else:
                    cutoff = int(time.time()) - 300
                    cursor = tdb._trace_db.execute("""
                        SELECT vehicle_id, trip_id, route_id, lijn, richting, bestemming,
                               lat, lon, status, bearing, speed, lbl, timestamp
                        FROM latest_vehicles
                        WHERE lijn IS NOT NULL AND lijn != ''
                          AND timestamp >= ?
                        ORDER BY lijn
                    """, (cutoff,))
                    vehicles = []
                    for r in cursor.fetchall():
                        vehicles.append({
                            "id": r[0], "tid": r[1], "rid": r[2], "lijn": r[3],
                            "richting": r[4], "bestemming": r[5],
                            "lat": r[6], "lon": r[7], "st": r[8],
                            "bearing": r[9], "snelheid": r[10], "lbl": r[11], "t": r[12],
                        })
                    self._send_json({
                        "v": 1,
                        "ts": int(time.time()),
                        "data_ts": data_ts,
                        "voertuigen": vehicles,
                    }, cache="public, max-age=30")
            else:
                self._send_json({"error": "trace db niet actief"})
            return

        # Statische bestanden
        if path == "/" or path == "/index.html":
            # Niet cachen: de pagina bevat de complete UI en stijlen, dus een
            # gecachete versie laat wijzigingen tot 10 minuten wegvallen.
            self._send_file(
                os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html"),
                "text/html; charset=utf-8",
                cache="no-cache, must-revalidate",
            )
            return

        if path == "/favicon.svg":
            self._send_file(
                os.path.join(os.path.dirname(__file__), "..", "frontend", "favicon.svg"),
                "image/svg+xml",
            )
            return

        if path == "/og-image.png":
            self._send_file(
                os.path.join(os.path.dirname(__file__), "..", "frontend", "og-image.png"),
                "image/png",
            )
            return

        if path.endswith(".js"):
            self._send_file(
                os.path.join(os.path.dirname(__file__), "..", "frontend", path.lstrip("/")),
                "application/javascript; charset=utf-8",
                cache="no-cache, must-revalidate",
            )
            return

        if path.endswith(".css"):
            self._send_file(
                os.path.join(os.path.dirname(__file__), "..", "frontend", path.lstrip("/")),
                "text/css; charset=utf-8",
                cache="no-cache, must-revalidate",
            )
            return

        if path == "/data/groningen.json":
            map_path = os.path.join(DATA_DIR, "groningen.json")
            if os.path.exists(map_path):
                self._send_file(map_path, "application/json")
            else:
                self.send_error(404, "Kaartdata nog niet gegenereerd")
            return

        if path == "/data/lijnen.json":
            lijn_path = os.path.join(DATA_DIR, "lijnen.json")
            if os.path.exists(lijn_path):
                self._send_file(lijn_path, "application/json")
            else:
                self.send_error(404, "Lijnroutes nog niet gegenereerd — draai backend/lijn_routes.py")
            return

        self.send_error(404)


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    port = int(os.environ.get("BUSSIE_PORT", "8900"))

    # Statische GTFS laden
    try:
        load_static_gtfs()
    except Exception as e:
        log.error("Statische GTFS laden mislukt: %s", e)
        log.info("Door zonder statische data — lijnnummers worden beperkt")

    # Eerste realtime fetch
    log.info("Eerste realtime data ophalen...")
    feed = fetch_realtime()
    if feed:
        for city in CITIES:
            vehicles = filter_vehicles(feed, city)
            with REALTIME_LOCK:
                REALTIME_CACHE[city] = {
                    "v": 1,
                    "ts": int(time.time()),
                    "voertuigen": vehicles,
                }
            log.info("Stad %s: %d voertuigen gevonden", city, len(vehicles))

    # Start poll loop in achtergrond
    poll_thread = threading.Thread(target=poll_loop, daemon=True)
    poll_thread.start()

    # Start HTTP server
    server = ThreadedHTTPServer(("0.0.0.0", port), BussieHandler)
    log.info("Bussie backend draait op http://localhost:%d", port)
    log.info("API: /api/voertuigen?stad=groningen")
    server.serve_forever()


if __name__ == "__main__":
    main()