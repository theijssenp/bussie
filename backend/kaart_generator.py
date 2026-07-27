#!/usr/bin/env python3
"""
Bussie Kaartdata Generator
Genereert een isometrische kaart-JSON voor Groningen uit OpenStreetMap data.
Uitvoer: data/groningen.json met streets, buildings, water, green, routes, stops.

Gebruikt de Overpass API om OSM data te downloaden en converteert dit naar
het formaat dat de frontend renderer verwacht.
"""

import urllib.request
import urllib.error
import json
import time
import math
import os
import sys
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("kaart-gen")

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
USER_AGENT = "bussie.hodc.nl/0.1 (herm@theijssen.nl)"

# Groningen centrum + directe omgeving (kleiner voor Overpass betrouwbaarheid)
CENTER = {"lon": 6.563, "lat": 53.2265}
BBOX = [53.18, 6.50, 53.28, 6.62]  # min_lat, min_lon, max_lat, max_lon

# Overpass API endpoint
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Statische GTFS voor stops (uit gtfs-nl.zip)
GTFS_ZIP_PATH = os.path.join(DATA_DIR, "gtfs-nl.zip")


def latlon_to_meters(lat, lon, center_lat, center_lon):
    """Converteer lat/lon naar lokale meters via Web Mercator.
    Web Mercator: R=6378137, (lon-c)*PI/180*R*cos(lat), (lat-c)*PI/180*R"""
    R = 6378137  # WGS84 equator radius
    n = math.pi / 180
    cos_lat = math.cos(center_lat * n)
    x = (lon - center_lon) * n * R * cos_lat
    y = -(lat - center_lat) * n * R  # Negatief zodat noorden +y is
    return [round(x, 1), round(y, 1)]


def download_overpass(query):
    """Voer Overpass query uit en return JSON."""
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(OVERPASS_URL, data=data, headers={"User-Agent": USER_AGENT})
    
    for attempt in range(3):
        try:
            log.info("Overpass query uitvoeren (poging %d)...", attempt + 1)
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            log.info("Overpass: %d elementen", len(result.get("elements", [])))
            return result
        except Exception as e:
            log.warning("Overpass poging %d faalde: %s", attempt + 1, e)
            time.sleep(5)
    
    return None


def build_overpass_query():
    """Bouw Overpass QL query voor Groningen."""
    min_lat, min_lon, max_lat, max_lon = BBOX
    bbox = f"{min_lat},{min_lon},{max_lat},{max_lon}"
    
    # Gesplitste query: eerst wegen+gebouwen, dan water+groen
    # Beperk aantal elementen door alleen de belangrijkste categorieën
    query = f"""
[out:json][timeout:180];
(
  // Roads — alleen berijdbare wegen
  way["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street|road"]({bbox});
  
  // Buildings — beperk tot echte gebouwen
  way["building"]({bbox});
  
  // Water
  way["natural"="water"]({bbox});
  way["waterway"~"river|stream|canal"]({bbox});
  
  // Parks / green
  way["leisure"~"park|garden"]({bbox});
  way["landuse"~"grass|meadow|cemetery"]({bbox});
);
out geom;
"""
    return query


def process_streets(elements, center):
    """Verwerk OSM wegen tot straat-polygons."""
    streets = []
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        if "highway" not in tags:
            continue
        highway = tags["highway"]
        if highway in ("footway", "cycleway", "path", "pedestrian", "steps", "track"):
            continue
        
        geom = el.get("geometry", [])
        if len(geom) < 2:
            continue
        
        pts = [latlon_to_meters(g["lat"], g["lon"], center["lat"], center["lon"]) for g in geom]
        
        # Wegbreedte op basis van highway type
        widths = {
            "motorway": 18, "trunk": 14, "primary": 12, "secondary": 10,
            "tertiary": 8, "residential": 6, "service": 4, "unclassified": 5,
            "road": 5, "living_street": 5, "motorway_link": 10, "trunk_link": 8,
            "primary_link": 7, "secondary_link": 6,
        }
        width = widths.get(highway, 5)
        
        streets.append({
            "cls": "street",
            "w": width,
            "pts": pts,
        })
    
    log.info("  %d straten", len(streets))
    return streets


def process_buildings(elements, center):
    """Verwerk OSM gebouwen tot polygons."""
    buildings = []
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        if "building" not in tags:
            continue
        
        geom = el.get("geometry", [])
        if len(geom) < 3:
            continue
        
        pts = [latlon_to_meters(g["lat"], g["lon"], center["lat"], center["lon"]) for g in geom]
        
        # Gesloten polygon (laatste = eerste)
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        
        # Gebouwhoogte (indien beschikbaar)
        height = 0
        h_str = tags.get("height", "")
        if h_str:
            try:
                height = float(h_str.split()[0])
            except ValueError:
                pass
        if not height and "building:levels" in tags:
            try:
                levels = int(tags["building:levels"])
                height = levels * 3.5
            except ValueError:
                pass
        
        buildings.append({
            "cls": "building",
            "h": round(height, 1),
            "pts": pts,
        })
    
    log.info("  %d gebouwen", len(buildings))
    return buildings


def process_water(elements, center):
    """Verwerk water polygons."""
    water = []
    seen = set()
    for el in elements:
        if el.get("type") == "relation":
            # Skip relations voor nu — complexere geometrie
            continue
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        is_water = tags.get("natural") == "water" or "waterway" in tags
        if not is_water:
            continue
        
        el_id = el.get("id")
        if el_id in seen:
            continue
        seen.add(el_id)
        
        geom = el.get("geometry", [])
        if len(geom) < 2:
            continue
        
        pts = [latlon_to_meters(g["lat"], g["lon"], center["lat"], center["lon"]) for g in geom]
        if pts[0] != pts[-1] and len(pts) >= 3:
            pts.append(pts[0])
        
        water.append({
            "cls": "water" if tags.get("natural") == "water" else "waterway",
            "pts": pts,
        })
    
    log.info("  %d water elementen", len(water))
    return water


def process_green(elements, center):
    """Verwerk parken en groen."""
    green = []
    seen = set()
    for el in elements:
        if el.get("type") == "relation":
            continue
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        is_green = (
            tags.get("leisure") in ("park", "garden", "playground")
            or tags.get("landuse") in ("grass", "meadow", "forest", "cemetery", "recreation_ground")
        )
        if not is_green:
            continue
        
        el_id = el.get("id")
        if el_id in seen:
            continue
        seen.add(el_id)
        
        geom = el.get("geometry", [])
        if len(geom) < 3:
            continue
        
        pts = [latlon_to_meters(g["lat"], g["lon"], center["lat"], center["lon"]) for g in geom]
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        
        green.append({
            "cls": "green",
            "pts": pts,
        })
    
    log.info("  %d groen elementen", len(green))
    return green


def load_gtfs_stops():
    """Laad bushaltes uit statische GTFS data voor Groningen."""
    import zipfile
    import csv
    import io
    
    stops = []
    
    if not os.path.exists(GTFS_ZIP_PATH):
        log.warning("GTFS zip niet gevonden — stops worden niet geladen")
        return stops
    
    min_lat, min_lon, max_lat, max_lon = BBOX
    
    with zipfile.ZipFile(GTFS_ZIP_PATH, "r") as zf:
        if "stops.txt" not in zf.namelist():
            log.warning("Geen stops.txt in GTFS")
            return stops
        
        with zf.open("stops.txt") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
            for row in reader:
                try:
                    lat = float(row.get("stop_lat", 0))
                    lon = float(row.get("stop_lon", 0))
                except (ValueError, TypeError):
                    continue
                
                if lat < min_lat or lat > max_lat or lon < min_lon or lon > max_lon:
                    continue
                
                stop_id = row.get("stop_id", "")
                name = row.get("stop_name", "")
                
                pts = latlon_to_meters(lat, lon, CENTER["lat"], CENTER["lon"])
                
                stops.append({
                    "id": stop_id,
                    "naam": name,
                    "pts": pts,
                })
    
    # Dedupliceren op stop_id (houden eerste)
    seen = set()
    unique = []
    for s in stops:
        if s["id"] not in seen:
            seen.add(s["id"])
            unique.append(s)
    
    log.info("  %d bushaltes in gebied", len(unique))
    return unique


def load_gtfs_routes():
    """Laad busroutes uit GTFS shapes.txt voor Groningen."""
    import zipfile
    import csv
    import io
    from collections import defaultdict
    
    if not os.path.exists(GTFS_ZIP_PATH):
        log.warning("GTFS zip niet gevonden — routes worden niet geladen")
        return []
    
    # Eerst: bepaal welke route_ids bij QBUZZ Groningen horen
    # via trips.txt filteren
    groningen_route_ids = set()
    with zipfile.ZipFile(GTFS_ZIP_PATH, "r") as zf:
        if "trips.txt" in zf.namelist():
            with zf.open("trips.txt") as f:
                reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
                for row in reader:
                    trip_id = row.get("trip_id", "")
                    # QBUZZ trips hebben trip_id formaat dat QBUZZ bevat in entity id
                    # Maar trip_id zelf is numeriek. We filteren via shapes.
                    route_id = row.get("route_id", "")
                    shape_id = row.get("shape_id", "")
                    # Filter op Groningen via trip_headsign of shape_id
                    # QBUZZ Groningen shapes beginnen vaak met QBUZZ
                    if shape_id and "QBUZZ" in shape_id.upper():
                        groningen_route_ids.add(route_id)
    
    # Nu shapes ophalen
    shapes = defaultdict(list)
    with zipfile.ZipFile(GTFS_ZIP_PATH, "r") as zf:
        if "shapes.txt" in zf.namelist():
            with zf.open("shapes.txt") as f:
                reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
                for row in reader:
                    shape_id = row.get("shape_id", "")
                    try:
                        lat = float(row.get("shape_pt_lat", 0))
                        lon = float(row.get("shape_pt_lon", 0))
                        seq = int(row.get("shape_pt_sequence", 0))
                    except (ValueError, TypeError):
                        continue
                    
                    # Filter op bounding box
                    if lat < BBOX[0] or lat > BBOX[2] or lon < BBOX[1] or lon > BBOX[3]:
                        continue
                    
                    shapes[shape_id].append((seq, lat, lon))
    
    # Converteer naar route polygons
    routes = []
    min_lat, min_lon, max_lat, max_lon = BBOX
    for shape_id, points in shapes.items():
        if not shape_id:
            continue
        # Sorteer op sequence
        points.sort()
        pts = [latlon_to_meters(lat, lon, CENTER["lat"], CENTER["lon"]) for _, lat, lon in points]
        if len(pts) >= 2:
            routes.append({
                "cls": "route",
                "id": shape_id,
                "pts": pts,
            })
    
    log.info("  %d route shapes", len(routes))
    return routes


def generate_groningen():
    """Genereer de volledige kaartdata voor Groningen."""
    log.info("=== Kaartdata genereren voor Groningen ===")
    
    # Download OSM data
    query = build_overpass_query()
    result = download_overpass(query)
    
    if not result or "elements" not in result:
        log.error("Overpass query faalde — geen data")
        sys.exit(1)
    
    elements = result["elements"]
    log.info("Totaal %d OSM elementen ontvangen", len(elements))
    
    # Verwerk per categorie
    log.info("Verwerken...")
    streets = process_streets(elements, CENTER)
    buildings = process_buildings(elements, CENTER)
    water = process_water(elements, CENTER)
    green = process_green(elements, CENTER)
    
    # GTFS stops
    log.info("GTFS stops laden...")
    stops = load_gtfs_stops()
    
    # GTFS routes (shapes)
    log.info("GTFS routes laden...")
    routes = load_gtfs_routes()
    
    # Bundel alles
    map_data = {
        "regio": "groningen",
        "center": CENTER,
        "bbox": BBOX,
        "streets": streets,
        "buildings": buildings,
        "water": water,
        "green": green,
        "routes": routes,
        "stops": stops,
    }
    
    # Opslaan
    out_path = os.path.join(DATA_DIR, "groningen.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(map_data, f, separators=(",", ":"))
    
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    log.info("Kaartdata opgeslagen: %s (%.1f MB)", out_path, size_mb)
    log.info("  %d straten, %d gebouwen, %d water, %d groen, %d routes, %d stops",
             len(streets), len(buildings), len(water), len(green), len(routes), len(stops))


if __name__ == "__main__":
    import urllib.parse
    generate_groningen()