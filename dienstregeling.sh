#!/bin/bash
# Bussie — de dienstregeling verversen.
#
#   sudo bash ~/hodc/bussie/dienstregeling.sh
#
# Draait wekelijks vanzelf via bussie-dienstregeling.timer, en kan er ook
# los naast gedraaid worden als de dienstregeling tussendoor wisselt.
#
# Waarom dit moet: route_ids en trip_ids lopen mee met de dienstregeling.
# Staat er een bundel van een maand oud, dan vindt een derde van de bussen
# zijn lijn niet meer en zweven ze in rechte lijn over de kaart — precies
# wat er in september en in oktober gebeurde. De data zelf is altijd goed,
# ze was alleen oud.
#
# Drie stappen: verse GTFS ophalen, de lijnroutes opnieuw bouwen, en de
# backend herstarten zodat die zijn rit- en routetabellen opnieuw inleest.

set -euo pipefail

MAP=/home/pieter/hodc/bussie
GEBRUIKER=pieter
POORT=8900
GTFS_URL=https://gtfs.ovapi.nl/nl/gtfs-nl.zip
ZIP="$MAP/data/gtfs-nl.zip"
BUNDEL="$MAP/data/lijnen.json"

if [ "$EUID" -ne 0 ]; then
    echo "Dit script heeft root nodig (het herstart de service). Start het zo:"
    echo "    sudo bash $MAP/dienstregeling.sh"
    exit 1
fi

# Het zware werk onder het eigen account, anders komt de data op naam van
# root te staan en kan de volgende handmatige run er niet meer overheen.
als_gebruiker() { runuser -u "$GEBRUIKER" -- "$@"; }

echo "1/4  Verse GTFS ophalen"
# --time-cond haalt alleen op als de bron nieuwer is dan wat we hebben.
# Eerst naar een tijdelijk bestand: een half gedownloade zip van 250 MB
# maakt de generator stuk, en die draait hierna meteen.
tmp="$ZIP.nieuw"
rm -f "$tmp"
code=$(als_gebruiker curl -sS --fail --max-time 1800 \
       --time-cond "$ZIP" -o "$tmp" -w '%{http_code}' "$GTFS_URL" || echo "fout")

if [ "$code" = "fout" ]; then
    echo "     downloaden mislukt — de oude bundel blijft staan"
    rm -f "$tmp"
    exit 1
elif [ -s "$tmp" ]; then
    als_gebruiker python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).namelist()" "$tmp"
    mv "$tmp" "$ZIP"
    echo "     nieuwe zip binnen ($(du -h "$ZIP" | cut -f1))"
else
    rm -f "$tmp"
    echo "     bron niet nieuwer (HTTP $code), we houden wat we hebben"
fi

echo "2/4  Lijnroutes bouwen"
if [ -f "$BUNDEL" ] && [ "$BUNDEL" -nt "$ZIP" ]; then
    echo "     bundel is al jonger dan de GTFS, overgeslagen"
else
    # Dit leest de hele stop_times van 1,4 GB en duurt een minuut of tien.
    # lijn_routes.py schrijft via een tijdelijk bestand, dus de draaiende
    # kaart houdt ondertussen de oude bundel.
    als_gebruiker python3 "$MAP/backend/lijn_routes.py" 2>&1 | sed 's/^/     /'
fi

echo "3/4  Backend herstarten"
# Pas hierna kent hij de nieuwe route-, rit- en haltetabellen; zonder
# herstart blijft hij de dienstregeling van de vorige start gebruiken.
systemctl restart bussie
for i in $(seq 1 180); do
    if curl -sf --max-time 5 -o /dev/null "http://localhost:$POORT/api/voertuigen/db"; then
        echo "     weer in de lucht na ${i}s"
        break
    fi
    if ! systemctl is-active --quiet bussie; then
        echo "     de service is gestopt — laatste regels uit het logboek:"
        journalctl -u bussie -n 15 --no-pager
        exit 1
    fi
    sleep 1
done

echo "4/4  Controle: vinden de bussen hun lijn?"
als_gebruiker python3 - "$MAP" "$POORT" <<'PY'
import json, sys, urllib.request

map_pad, poort = sys.argv[1], sys.argv[2]

with open(f"{map_pad}/data/lijnen.json", encoding="utf-8") as f:
    lijnen = json.load(f)["lijnen"]

op_route = {f"{rid}|{r['richting']}" for r in lijnen for rid in r.get("rids", [])}
op_rit = {r["sid"] for r in lijnen if r.get("sid")}

with urllib.request.urlopen(f"http://localhost:{poort}/api/voertuigen/db", timeout=30) as resp:
    voertuigen = json.load(resp)["voertuigen"]

if not voertuigen:
    print("     geen voertuigen in de feed — later nog eens kijken")
    sys.exit(0)

rit = sum(1 for v in voertuigen if v.get("sid") in op_rit)
lijn = sum(1 for v in voertuigen if f"{v['rid']}|{v['richting']}" in op_route)
gevonden = sum(1 for v in voertuigen
               if v.get("sid") in op_rit or f"{v['rid']}|{v['richting']}" in op_route)
n = len(voertuigen)

print(f"     {n} voertuigen: {rit} op hun eigen rit, {lijn} op hun lijn, "
      f"{gevonden} met een route ({gevonden / n * 100:.1f}%)")
if gevonden / n < 0.95:
    print("     LET OP: dat hoort boven de 95% te liggen.")
    sys.exit(1)
PY

echo
echo "Klaar. Volgende keer vanzelf:"
systemctl list-timers bussie-dienstregeling --no-pager 2>/dev/null | sed -n '2p' || true
