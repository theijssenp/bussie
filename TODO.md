# Nog te doen

## Schepen via aisstream.io

Bootjes op de kaart, te beginnen met de veerboot Den Helder – Texel.

Nodig voordat dit gebouwd kan worden:

- **API-sleutel** van aisstream.io (gratis account, zelf aanmaken). Niet in de
  repo; lezen uit een omgevingsvariabele of een bestand buiten git.
- **`websockets`** installeren (`pip install websockets`) — aisstream is een
  WebSocket-stroom, geen REST.

Opzet: de backend abonneert op een bbox rond Nederland en houdt per MMSI de
laatste positie bij; de frontend haalt dat op zoals `/api/voertuigen/db`. De
sleutel blijft aan de serverkant, anders ligt hij op straat in de browser.
AIS levert positie, koers, snelheid, scheepsnaam en scheepstype — genoeg voor
een bootje dat de goede kant op vaart.

## Vliegtuigen

Bron nog uit te zoeken. Kandidaat is de OpenSky Network REST API
(`/states/all` met bbox); anoniem is die sterk gelimiteerd, met een gratis
account ruimer. ADS-B Exchange is een alternatief maar betaald.

Aandachtspunt voor de weergave: alles op de kaart staat nu op de grond.
Vliegtuigen hebben hoogte, dus die vragen een eigen behandeling — schaduw op
de grond en het toestel erboven, vergelijkbaar met hoe gebouwen geëxtrudeerd
worden.

---

# Overige open punten

Dingen die tijdens het bouwen langskwamen en nog niet af zijn.

## Tegels landelijk maken

De tegelpijplijn (`backend/tegels.py`) werkt, maar de enige bron is nu
`data/groningen.json` — 170 tegels over 89 km². Voor heel Nederland:

- Brondata via het Geofabrik-extract `netherlands-latest.osm.pbf` (~1,5 GB),
  verwerkt met pyosmium (staat nog niet geïnstalleerd). Overpass gaat een
  landelijke uitvraag niet toestaan.
- Gebouwhoogtes uit **3D BAG**: OSM heeft er in dit gebied maar voor 4% een
  (223 met `height`, 3.704 met `building:levels` op 91.640 gebouwen), de rest
  valt terug op de standaard van 9 m.

## Lijnenlaag landelijk

`data/lijnen.json` is nu 93 lijnrichtingen (0,9 MB). Landelijk zijn het er
5.058 met een shape, geschat 49 MB — die moeten dus ook per gebied geladen
worden, of sterker vereenvoudigd naarmate je uitzoomt.

## Trams en metro's live meenemen

`filter_vehicles()` in `gtfs_processor.py` staat hard op QBUZZ. In de live
feed zitten acht vervoerders: gemeten 909 bussen, 188 trams, 59 metro's. Die
247 trams en metro's gooien we nu weg.

## Treinen en veerboten

Zitten **niet** in `gtfs.ovapi.nl/nl/vehiclePositions.pb` — geen NS, geen
TESO (gemeten om 00:07; overdag nog eens controleren). Wat wel kan:

- Als lijn tekenen uit de statische GTFS: 344 trein-, 104 tram-, 48 veerboot-
  en 20 metrorichtingen, mét kleur. Daarvoor moet `AGENCIES = {"QBUZZ"}` uit
  `lijn_routes.py`.
- Treinen live zou via de NS Reisinformatie-API kunnen (gratis sleutel), of
  als geschatte positie uit de dienstregeling.
