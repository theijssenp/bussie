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
  frontend/js/kaart.js                  ← Canvas renderer
    - Eigen isometrische projectie (2:1 dimetrisch)
    - 3D gebouwextrusie
    - Pan/zoom/touch interaction
    - Vehicle rendering met hover info
                                         ↓
  frontend/js/app.js                    ← App logic
    - Polling /api/voertuigen elke 10s
    - Lijnfilter, theme toggle, geolocatie
    - Klok, status, UI panels
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

## Installatie

1. Kaartdata genereren (eenmalig):
   ```bash
   cd ~/hodc/bussie
   python3 backend/kaart_generator.py
   ```

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