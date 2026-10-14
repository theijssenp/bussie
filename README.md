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
  backend/lijn_routes.py                 ← Lijnroute generator (wekelijks)
    - Hoofdvorm per lijn én richting uit de statische GTFS, plus de
      ritvarianten die minstens een kwart van de ritten rijden
    - Kleur uit routes.txt, haltes met afstand langs de route
    - Output: data/lijnen.json + data/lijnen.bin (binair, wat de kaart ophaalt)
                                         ↓
  frontend/js/kaart.js                  ← Canvas renderer
    - Eigen isometrische projectie (2:1 dimetrisch)
    - 3D gebouwextrusie met detailniveau per zoomstand
    - Lijnen in eigen kleur, haltes, busjes in zijaanzicht
    - Bussen zitten vastgeklikt op hun lijn, glijden eroverheen tussen twee
      peilingen en worden daarna nog een halve minuut doorgerekend — de bron
      publiceert maar eens per minuut
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
- `GET /data/lijnen.bin` — dezelfde lijnroutes binair (BLN2); dit haalt de
  kaart op, want het is een derde van de bytes en er valt geen 20 MB tekst
  te ontleden. Wordt zo nodig uit `lijnen.json` gebouwd bij de eerste vraag.

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
   python3 backend/lijn_routes.py   # GTFS → data/lijnen.json + .bin (lijnroutes)
   ```
   Voor één stad kan het ook zonder PBF: `kaart_generator.py` haalt via
   Overpass een stadsgebied op, en `tegels.py` knipt dat in tegels.

   `lijn_routes.py` leest `data/gtfs-nl.zip`, dus dat moet opnieuw als de
   dienstregeling wisselt — en dat gebeurt vaker dan je denkt. Route_ids en
   trip_ids lopen mee met de dienstregeling, dus een bundel van een maand oud
   betekent dat een derde van de bussen zijn lijn niet meer vindt en in rechte
   lijn over de kaart zweeft. `dienstregeling.sh` doet het wekelijks vanzelf
   (zie stap 2); handmatig kan ook:

   ```bash
   sudo bash ~/hodc/bussie/dienstregeling.sh
   ```

   Met `--alleen-binair` pakt `lijn_routes.py` alleen `lijnen.json` opnieuw
   in, zonder de 1,4 GB `stop_times` door te lezen.
   `tegels_nl.py` en `straatnamen.py` werken het bouwstempel in
   `data/tegels/index.json` bij, waardoor browsers hun cache verversen.

2. Backend starten:
   ```bash
   sudo bash update.sh
   ```
   Dat zet de service neer, start hem, en schakelt meteen de wekelijkse
   verversing van de dienstregeling in (`bussie-dienstregeling.timer`,
   maandagnacht). Zonder die timer loopt de lijnenbundel stilletjes achter.

   Los draaien kan ook: `python3 backend/gtfs_processor.py`

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