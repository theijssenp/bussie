#!/usr/bin/env python3
"""
Bussie — GPS Trace Database
Slaat realtime voertuigposities op in SQLite voor historische analyse
en route-reconstructie per lijn.

Database: data/traces.db
Tabellen:
  - vehicle_positions: ruwe GPS updates
  - route_traces: gegroepeerde/vereenvoudigde routes per lijn
"""

import sqlite3
import os
import time
import json
import math
import logging
import threading
from collections import defaultdict

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
DB_PATH = os.path.join(DATA_DIR, "traces.db")

# Module-level singleton db instance
_trace_db = None
_db_lock = threading.Lock()

log = logging.getLogger("traces")


def get_db():
    """Verkrijg database connectie met automatische tabel-aanmaak.
    Slaat ook op als module-level singleton voor HTTP handlers."""
    global _trace_db
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    init_db(conn)
    _trace_db = conn
    return conn


def db_execute(func, *args, **kwargs):
    """Voer een DB operatie uit met een lock (thread-safe)."""
    with _db_lock:
        if _trace_db is None:
            return None
        return func(_trace_db, *args, **kwargs)


def init_db(conn):
    """Maak tabellen aan als ze nog niet bestaan."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS vehicle_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id TEXT NOT NULL,
            trip_id TEXT,
            route_id TEXT,
            lijn TEXT,
            richting INTEGER,
            bestemming TEXT,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            status INTEGER,
            timestamp INTEGER NOT NULL,
            stored_at INTEGER NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_lijn ON vehicle_positions(lijn);
        CREATE INDEX IF NOT EXISTS idx_lijn_richting ON vehicle_positions(lijn, richting);
        CREATE INDEX IF NOT EXISTS idx_vehicle ON vehicle_positions(vehicle_id);
        CREATE INDEX IF NOT EXISTS idx_ts ON vehicle_positions(timestamp);
        CREATE INDEX IF NOT EXISTS idx_stored_at ON vehicle_positions(stored_at);
        
        -- Laatste bekende positie per voertuig (eigen datalaag)
        CREATE TABLE IF NOT EXISTS latest_vehicles (
            vehicle_id TEXT PRIMARY KEY,
            trip_id TEXT,
            route_id TEXT,
            lijn TEXT,
            richting INTEGER,
            bestemming TEXT,
            lat REAL,
            lon REAL,
            status INTEGER,
            bearing REAL,
            speed REAL,
            lbl TEXT,
            timestamp INTEGER NOT NULL,
            stored_at INTEGER NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS route_traces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lijn TEXT NOT NULL,
            richting INTEGER,
            pts_json TEXT NOT NULL,
            point_count INTEGER,
            generated_at INTEGER NOT NULL,
            UNIQUE(lijn, richting)
        );
    """)
    conn.commit()


def ruim_op(conn, dagen=3):
    """Gooi posities weg die ouder zijn dan `dagen`.

    Landelijk komt er ongeveer een half GB per dag bij. Drie dagen is ruim
    genoeg voor waar de historie voor dient: routes reconstrueren en bij het
    laden de vorige positie kennen.
    """
    grens = int(time.time()) - dagen * 86400
    cur = conn.execute("DELETE FROM vehicle_positions WHERE stored_at < ?", (grens,))
    conn.commit()
    weg = cur.rowcount
    if weg > 0:
        log.info("Opgeruimd: %d posities ouder dan %d dagen", weg, dagen)
    return weg


def store_positions(conn, vehicles):
    """Sla een batch voertuigposities op, inclusief latest_vehicles."""
    now = int(time.time())
    rows = []
    latest = []
    for v in vehicles:
        if v.get("lat") is None or v.get("lon") is None:
            continue
        vid = v.get("id", "")
        if not vid:
            continue
        rows.append((
            vid,
            v.get("tid", ""),
            v.get("rid", ""),
            v.get("lijn", ""),
            v.get("richting"),
            v.get("bestemming", ""),
            v["lat"],
            v["lon"],
            v.get("st", 0),
            v.get("t", now),
            now,
        ))
        latest.append((
            vid,
            v.get("tid", ""),
            v.get("rid", ""),
            v.get("lijn", ""),
            v.get("richting"),
            v.get("bestemming", ""),
            v["lat"],
            v["lon"],
            v.get("st", 0),
            v.get("bearing"),
            v.get("snelheid"),
            v.get("lbl", ""),
            v.get("t", now),
            now,
        ))
    
    if not rows:
        return 0
    
    with _db_lock:
        conn.executemany("""
            INSERT INTO vehicle_positions 
            (vehicle_id, trip_id, route_id, lijn, richting, bestemming, lat, lon, status, timestamp, stored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, rows)
        # UPSERT: voeg toe of update de latest_vehicles tabel
        conn.executemany("""
            INSERT INTO latest_vehicles 
            (vehicle_id, trip_id, route_id, lijn, richting, bestemming, lat, lon, status, bearing, speed, lbl, timestamp, stored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(vehicle_id) DO UPDATE SET
                trip_id=excluded.trip_id,
                route_id=excluded.route_id,
                lijn=excluded.lijn,
                richting=excluded.richting,
                bestemming=excluded.bestemming,
                lat=excluded.lat,
                lon=excluded.lon,
                status=excluded.status,
                bearing=excluded.bearing,
                speed=excluded.speed,
                lbl=excluded.lbl,
                timestamp=excluded.timestamp,
                stored_at=excluded.stored_at
        """, latest)
        conn.commit()
    return len(rows)


def douglas_peucker(points, epsilon):
    """Vereenvoudig een polyline met Douglas-Peucker algoritme."""
    if len(points) < 3:
        return points
    
    def point_line_dist(p, a, b):
        if a == b:
            return math.dist(p, a)
        dx = b[0] - a[0]
        dy = b[1] - a[1]
        t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
        t = max(0, min(1, t))
        proj = [a[0] + t * dx, a[1] + t * dy]
        return math.dist(p, proj)
    
    def dp(pts, start, end, epsilon, out):
        if end - start < 2:
            out.extend(pts[start:end])
            return
        max_dist = 0
        max_idx = start
        a = pts[start]
        b = pts[end]
        for i in range(start + 1, end):
            d = point_line_dist(pts[i], a, b)
            if d > max_dist:
                max_dist = d
                max_idx = i
        if max_dist > epsilon:
            dp(pts, start, max_idx, epsilon, out)
            out.append(pts[max_idx])
            dp(pts, max_idx, end, epsilon, out)
        else:
            out.append(pts[start])
    
    result = []
    dp(points, 0, len(points) - 1, epsilon, result)
    result.append(points[-1])
    return result


def latlon_to_meters(lat, lon, center_lat, center_lon):
    """Converteer lat/lon naar lokale meters."""
    lat_m = 111320.0
    lon_m = 111320.0 * math.cos(math.radians(center_lat))
    x = (lon - center_lon) * lon_m
    y = -(lat - center_lat) * lat_m
    return [round(x, 1), round(y, 1)]


def generate_route_traces(conn, center_lat=53.2265, center_lon=6.563, min_points=5):
    """
    Genereer route polylines per lijn + richting uit de verzamelde GPS data.
    
    Strategie:
    1. Haal per voertuig alle GPS punten op (een voertuigtrace = één rit)
    2. Vereenvoudig elke individuele trace met Douglas-Peucker
    3. Voeg traces samen door ruimtelijke overlap te vinden
    4. Het resultaat is een samengevoegde route polyline per lijn/richting
    """
    # Haal alle unieke lijn/richting combinaties op met genoeg data
    cursor = conn.execute("""
        SELECT lijn, richting, COUNT(*) as cnt
        FROM vehicle_positions 
        WHERE lijn IS NOT NULL AND lijn != ''
        GROUP BY lijn, richting
        HAVING cnt >= ?
        ORDER BY lijn
    """, (min_points,))
    
    combinations = cursor.fetchall()
    log.info("Route traces genereren voor %d lijn/richting combinaties", len(combinations))
    
    generated = 0
    for lijn, richting, cnt in combinations:
        # Haal alle GPS punten voor deze lijn/richting, gesorteerd op tijd
        cursor2 = conn.execute("""
            SELECT lat, lon, timestamp, vehicle_id
            FROM vehicle_positions
            WHERE lijn = ? AND (richting = ? OR (? IS NULL AND richting IS NULL))
            ORDER BY timestamp ASC
        """, (lijn, richting, richting))
        
        # Groepeer per voertuig (elke trace is een afzonderlijke rit)
        vehicle_traces = defaultdict(list)
        for lat, lon, ts, vid in cursor2:
            vehicle_traces[vid].append((lat, lon, ts))
        
        if not vehicle_traces:
            continue
        
        # Converteer elke trace naar meters en vereenvoudig
        simplified_traces = []
        for vid, trace in sorted(vehicle_traces.items(), key=lambda x: -len(x[1])):
            if len(trace) < 2:
                continue
            # Converteer naar meters
            meters = [latlon_to_meters(lat, lon, center_lat, center_lon) for lat, lon, _ in trace]
            # Vereenvoudig met Douglas-Peucker (epsilon = 20m)
            simplified = douglas_peucker(meters, 20.0)
            if len(simplified) >= 2:
                simplified_traces.append(simplified)
        
        if not simplified_traces:
            continue
        
        # Voeg traces samen: gebruik de langste trace als basis,
        # en voeg punten uit andere traces toe die verder dan 30m van
        # de bestaande route liggen
        merged = merge_traces(simplified_traces)
        
        if len(merged) < 2:
            continue
        
        # Sla op in database
        pts_json = json.dumps(merged)
        conn.execute("""
            INSERT OR REPLACE INTO route_traces (lijn, richting, pts_json, point_count, generated_at)
            VALUES (?, ?, ?, ?, ?)
        """, (lijn, richting, pts_json, len(merged), int(time.time())))
        
        generated += 1
        log.info("  Lijn %s richting %s: %d traces → %d punten (samengevoegd)", 
                 lijn, richting, len(simplified_traces), len(merged))
    
    conn.commit()
    log.info("Totaal %d route traces gegenereerd", generated)
    return generated


def merge_traces(traces):
    """
    Voeg meerdere voertuigtraces samen tot één route polyline.
    
    Strategie: 
    1. Start met de langste trace
    2. Voor elke andere trace: vind het punt op de bestaande route dat 
       het dichtst bij het begin van de nieuwe trace ligt
    3. Voeg punten uit de nieuwe trace toe die verder dan min_dist van 
       de bestaande route liggen
    
    Dit produceert een route die alle door bussen gereden paden volgt.
    """
    if not traces:
        return []
    if len(traces) == 1:
        return traces[0]
    
    # Sorteer op lengte (langste eerst)
    traces = sorted(traces, key=lambda t: -len(t))
    merged = list(traces[0])
    
    for trace in traces[1:]:
        if len(trace) < 2:
            continue
        
        # Voor elk punt in de trace: check of het ver van de merged route ligt
        far_points = []
        for pt in trace:
            min_dist = min(
                math.hypot(pt[0] - m[0], pt[1] - m[1])
                for m in merged
            ) if merged else float('inf')
            if min_dist > 30:  # verder dan 30m van bestaande route
                far_points.append(pt)
        
        if not far_points:
            continue
        
        # Voeg ver-locatie punten toe op de juiste positie in de merged route
        # Vind het beste invoegpunt: het merged punt dat het dichtst bij 
        # het eerste far point ligt
        if far_points:
            best_idx = 0
            best_dist = float('inf')
            first_far = far_points[0]
            for i, m in enumerate(merged):
                d = math.hypot(first_far[0] - m[0], first_far[1] - m[1])
                if d < best_dist:
                    best_dist = d
                    best_idx = i
            
            # Voeg far points in na best_idx
            merged[best_idx + 1:best_idx + 1] = far_points
    
    # Vereenvoudig het resultaat nog een keer
    if len(merged) > 3:
        merged = douglas_peucker(merged, 15.0)
    
    return merged


def get_all_traces(conn):
    """Haal alle gegenereerde route traces op als dict: lijn → [{richting, pts}]"""
    with _db_lock:
        cursor = conn.execute("""
            SELECT lijn, richting, pts_json, point_count
            FROM route_traces
            ORDER BY lijn
        """)
        rows = cursor.fetchall()
    
    traces = defaultdict(list)
    for lijn, richting, pts_json, count in rows:
        pts = json.loads(pts_json)
        traces[lijn].append({
            "richting": richting,
            "pts": pts,
            "count": count,
        })
    
    return dict(traces)


def get_trace_stats(conn):
    """Statistieken over de database."""
    with _db_lock:
        stats = {}
        stats["total_positions"] = conn.execute("SELECT COUNT(*) FROM vehicle_positions").fetchone()[0]
        stats["unique_vehicles"] = conn.execute("SELECT COUNT(DISTINCT vehicle_id) FROM vehicle_positions").fetchone()[0]
        stats["unique_lines"] = conn.execute("SELECT COUNT(DISTINCT lijn) FROM vehicle_positions WHERE lijn != ''").fetchone()[0]
        stats["traces_generated"] = conn.execute("SELECT COUNT(*) FROM route_traces").fetchone()[0]
        
        row = conn.execute("SELECT MIN(timestamp), MAX(timestamp) FROM vehicle_positions").fetchone()
        stats["oldest_ts"] = row[0]
        stats["newest_ts"] = row[1]
    
    return stats


def point_to_segment_dist(px, py, ax, ay, bx, by):
    """Afstand van punt (px,py) tot lijnsegment (a→b), plus projectie punt."""
    dx = bx - ax
    dy = by - ay
    if dx == 0 and dy == 0:
        return math.dist((px, py), (ax, ay)), ax, ay
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0, min(1, t))
    proj_x = ax + t * dx
    proj_y = ay + t * dy
    return math.dist((px, py), (proj_x, proj_y)), proj_x, proj_y


def snap_to_route(wx, wy, route_pts, max_dist=80):
    """
    Projecteer een punt op de dichtstbijzijnde route polyline.
    Returns: (snapped_x, snapped_y, progress 0-1) of None als te ver weg.
    """
    if not route_pts or len(route_pts) < 2:
        return None
    
    best_dist = float('inf')
    best_x = wx
    best_y = wy
    best_seg = 0
    
    for i in range(len(route_pts) - 1):
        ax, ay = route_pts[i]
        bx, by = route_pts[i + 1]
        d, px, py = point_to_segment_dist(wx, wy, ax, ay, bx, by)
        if d < best_dist:
            best_dist = d
            best_x = px
            best_y = py
            best_seg = i
    
    if best_dist > max_dist:
        return None
    
    # Bereken progress langs de route (0 = begin, 1 = eind)
    total_len = 0
    for i in range(len(route_pts) - 1):
        total_len += math.dist(route_pts[i], route_pts[i + 1])
    
    if total_len == 0:
        return best_x, best_y, 0
    
    seg_len = 0
    for i in range(best_seg):
        seg_len += math.dist(route_pts[i], route_pts[i + 1])
    seg_len += math.dist(route_pts[best_seg], [best_x, best_y])
    
    return best_x, best_y, seg_len / total_len