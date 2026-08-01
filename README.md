# Bussie — Live buskaart voor Groningen

Een isometrische Canvas-renderer die realtime busposities van Groningen toont,
volledig vanaf scratch gebouwd. Geen Leaflet, geen MapLibre, geen externe kaartbibliotheken.

## Architectuur

```
gtfs.ovapi.nl/nl/vehiclePositions.pb    ← Nederlandse open data (GTFS-RT protobuf)
                                         ↓
  backend/gtfs_processor.py             ← Python service (poort 8900)
    - Downloadt protobuf elke 10s
    - Filtert op QBUZZ + bbox Groningen
    - Serveert /api/voertuigen?stad=groningen
    - Serveert statische kaartdata + frontend
                                         ↓
  backend/kaart_generator.py             ← Eenmalige kaartdata generator
    - OSM data via Overpass API → isometrische JSON
    - GTFS shapes → route polygons
    - GTFS stops → bushaltes
    - Output: data/groningen.json
                                         ↓
  backend/lijn_routes.py                 ← Eenmalige lijnroute generator
    - Eén route per lijn én richting uit de statische GTFS
    - Kleur uit routes.txt, haltes met afstand langs de route
    - Output: data/lijnen.json
                                         ↓
  frontend/js/kaart.js                  ← Canvas renderer
    - Eigen isometrische projectie (2:1 dimetrisch)
    - 3D gebouwextrusie met detailniveau per zoomstand
    - Lijnen in eigen kleur, haltes, busjes in zijaanzicht
    - Bussen glijden lángs hun lijn tussen twee peilingen
    - Pan/zoom/touch interaction
                                         ↓
  frontend/js/app.js                    ← App logic
    - Polling /api/voertuigen/db elke 20s
    - Lijnfilter, busoverzicht, volgende halte
    - Theme toggle, geolocatie, klok, status
```

## Data bronnen

- **Realtime voertuigposities**: gtfs.ovapi.nl/nl/vehiclePositions.pb
  (GTFS-RT protobuf, 270KB, ~2000 voertuigen landelijk)
- **Statische GTFS**: gtfs.ovapi.nl/nl/gtfs-nl.zip
  (routes, stops, trips, shapes)
- **Kaartdata**: OpenStreetMap via Overpass API
  (wegen, gebouwen, water, groen)

## API endpoints

- `GET /api/voertuigen?stad=groningen` — realtime voertuigposities
- `GET /api/steden` — lijst met beschikbare steden
- `GET /api/gtfs-ids/groningen` — route_id → lijnnummer mapping
- `GET /api/lijnen?stad=groningen` — actieve lijnen met bestemmingen
- `GET /data/groningen.json` — statische kaartdata
- `GET /data/lijnen.json` — lijnroutes met kleur, haltes en afstanden

## Installatie

1. Kaartdata genereren (eenmalig). Voor heel Nederland:
   ```bash
   cd ~/hodc/bussie
   # OSM-extract ophalen (~1,4 GB)
   curl -L -o data/netherlands-latest.osm.pbf \
        https://download.geofabrik.de/europe/netherlands-latest.osm.pbf

   python3 backend/tegels_nl.py     # PBF  → data/tegels/ (tegelpiramide)
   python3 backend/straatnamen.py   # PBF  → straatnamen per tegel (.lbl)
   python3 backend/steden.py        # PBF  → data/steden.json (plaatsenkiezer)
   python3 backend/lijn_routes.py   # GTFS → data/lijnen.json (lijnroutes)
   ```
   Voor één stad kan het ook zonder PBF: `kaart_generator.py` haalt via
   Overpass een stadsgebied op, en `tegels.py` knipt dat in tegels.

   `lijn_routes.py` leest `data/gtfs-nl.zip`, dus draai dat opnieuw als de
   dienstregeling wisselt (lijnen, kleuren of haltes veranderen dan).
   `tegels_nl.py` en `straatnamen.py` werken het bouwstempel in
   `data/tegels/index.json` bij, waardoor browsers hun cache verversen.

2. Backend starten:
   ```bash
   python3 backend/gtfs_processor.py
   # Of als systemd service:
   sudo cp bussie.service /etc/systemd/system/
   sudo systemctl enable --now bussie
   ```

3. Apache VirtualHost:
   ```bash
   sudo cp bussie.apache.conf /etc/apache2/sites-available/
   sudo a2ensite bussie
   sudo systemctl reload apache2
   ```

4. Cloudflare DNS: bussie.hodc.nl → tunnel → localhost:80

## Frontend

- `frontend/index.html` — hoofdpagina met UI panels
- `frontend/js/kaart.js` — isometrische Canvas renderer
- `frontend/js/app.js` — app logic, polling, UI events
- `frontend/css/` — stylesheets (inline in index.html voor nu)
- `frontend/favicon.svg` — bus icoon

## Techniek

- Backend: Python 3, stdlib http.server, gtfs-realtime-bindings
- Frontend: Vanilla JS (ES modules), Canvas 2D API
- Kaartdata: Overpass API → JSON, GTFS → JSON
- Geen npm dependencies in frontend, geen build step nodig
- Volledig Nederlandse interface