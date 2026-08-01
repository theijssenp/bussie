# Nog te doen

## Schepen via aisstream.io

Bootjes op de kaart, te beginnen met de veerboot Den Helder – Texel.

Nodig voordat dit gebouwd kan worden:

- **API-sleutel**: staat klaar in `~/.config/bussie/aisstream.key` (rechten 600,
  buiten de repo dus buiten git).
- **`websockets`** installeren (`pip install --break-system-packages websockets`)
  — aisstream is een WebSocket-stroom, geen REST.

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

## Adressen tonen

De OSM-data bevat 9.852.370 adrespunten (straat, huisnummer, postcode) plus
81.781 adressen op gebouwpolygonen — landsdekkend, ooit uit de BAG
geïmporteerd. Technisch kan het, maar:

- Het tegelformaat kent geen tekst; adressen erin betekent een extra laag met
  een tekstblok, of een eigen bestand naast de tegel zoals de straatnamen
  (`.lbl`) nu doen.
- Alleen op het diepste niveau, en waarschijnlijk in een eigen niveau eronder
  (1 km): duizend adressen per tegel van 2 km maakt die tegels fors zwaarder.
- Alles tegelijk tonen wordt een zwarte soep. Huisnummers pas bij hoge zoom,
  en labels die voor elkaar wijken.

Goedkoop alternatief dat misschien al genoeg is: het adres opzoeken van het
gebouw waar de muis overheen zweeft, in plaats van een hele laag tekenen.

---

# Open punten

## Gebouwhoogtes uit 3D BAG

Alle hoogtes komen nu uit OSM, en dat is in Nederland voor een paar procent
van de panden ingevuld (gemeten in de Groningse bbox: 223 met `height`, 3.704
met `building:levels`, op 91.640 gebouwen). De rest valt terug op 9 meter,
dus de skyline is vlak. 3D BAG heeft een echte hoogte voor élk Nederlands
pand.

## Treinen en veerboten live

Ze staan **als lijn** op de kaart — de lijnenlaag bevat 344 trein-, 104 tram-,
48 veerboot- en 20 metrorichtingen naast 4.541 buslijnen — maar er rijdt niets
overheen. Ze zitten niet in `gtfs.ovapi.nl/nl/vehiclePositions.pb`: geen NS,
geen TESO. Wat wel kan:

- Treinen via de NS Reisinformatie-API (gratis sleutel).
- Of geschatte posities uit de dienstregeling, voor alles waarvan we wel de
  route en de tijden kennen.

## Bussen op een omleiding

Van de ~2.400 rijdende bussen liggen er zo'n 115 verder dan 120 meter van de
route die we voor hun lijn bewaren — een ritvariant, een omleiding of een
korte rit. Die bewegen in rechte lijn tussen twee peilingen. Op te lossen door
meerdere shapes per lijn te bewaren en er per bus de dichtstbijzijnde bij te
zoeken.

## Service onder systemd

Draait nu als los proces en komt dus niet terug na een herstart van de
machine. Eén keer draaien lost het op:

    sudo bash ~/hodc/bussie/update.sh
