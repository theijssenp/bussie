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

Grotendeels opgelost: de bundel bewaart nu per lijn en richting ook de
ritvarianten die minstens een kwart van de ritten rijden, en een bus wordt via
het shape_id van zijn eigen rit aan de juiste vorm gekoppeld. Van de ~1.650
rijdende bussen liggen er nog 80 verder dan 120 meter van hun vorm.

Daarvan zitten er 45 al op de vorm van hun eigen rit en wijken ze daar echt
van af: een omleiding van vandaag, een onbetrouwbare peiling, of een bus die
iets anders rijdt dan zijn rit zegt. Voor de andere 28 bestaat de juiste vorm
wel in de GTFS, maar die rijdt te weinig ritten om de drempel te halen.
`VARIANT_DREMPEL` in `lijn_routes.py` op 0,05 zetten vangt ze bijna allemaal,
maar laat de bundel groeien van 5,9 naar zo'n 10 MB — dat is de afweging.

## Wekelijkse verversing inschakelen

`dienstregeling.sh`, `bussie-dienstregeling.service` en `.timer` staan klaar
maar zijn nog niet geïnstalleerd. Eén keer draaien lost het op:

    sudo bash ~/hodc/bussie/update.sh

Zonder die timer loopt de lijnenbundel weer achter zodra de dienstregeling
wisselt, en dat is precies wat er in september en in oktober gebeurde: een
derde van de bussen vond zijn lijn niet meer.

De backend moet daar ook voor herstarten — hij houdt de route-, rit- en
haltetabellen vast vanaf het moment dat hij startte, en met een tabel van
vijf dagen oud mist twee derde van de bussen zijn bestemming.
