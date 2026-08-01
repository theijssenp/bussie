#!/bin/bash
# Bussie installeren of bijwerken als systemd-service.
#
#   sudo bash ~/hodc/bussie/update.sh
#
# Zet het service-bestand goed neer, ruimt een handmatig gestart proces op
# (dat houdt anders poort 8900 bezet waardoor systemd niet kan starten),
# herstart, en controleert daarna of het echt werkt. Na afloop komt de kaart
# ook vanzelf terug na een herstart van de machine of een crash.

set -euo pipefail

MAP=/home/pieter/hodc/bussie
POORT=8900

if [ "$EUID" -ne 0 ]; then
    echo "Dit script heeft root nodig. Start het zo:"
    echo "    sudo bash $MAP/update.sh"
    exit 1
fi

echo "1/5  Draaiende processen stoppen"
systemctl stop bussie 2>/dev/null || true
if pgrep -f "backend/gtfs_processor.py" > /dev/null; then
    pkill -f "backend/gtfs_processor.py" || true
    sleep 2
    pkill -9 -f "backend/gtfs_processor.py" 2>/dev/null || true
    echo "     handmatig gestart proces opgeruimd"
else
    echo "     niets te stoppen"
fi

echo "2/5  Service-bestand plaatsen"
install -m 644 "$MAP/bussie.service" /etc/systemd/system/bussie.service
systemctl daemon-reload

echo "3/5  Inschakelen en starten"
systemctl enable bussie > /dev/null
systemctl restart bussie

echo "4/5  Wachten tot poort $POORT open is (hij parseert eerst de GTFS)"
for i in $(seq 1 90); do
    if ss -ltn 2>/dev/null | grep -q ":$POORT "; then
        echo "     open na ${i}s"
        break
    fi
    if ! systemctl is-active --quiet bussie; then
        echo "     de service is gestopt — laatste regels uit het logboek:"
        journalctl -u bussie -n 15 --no-pager
        exit 1
    fi
    sleep 1
done

echo "5/5  Controle"
systemctl reload apache2 2>/dev/null || true

status=$(systemctl is-active bussie || true)
voertuigen=$(curl -s --max-time 10 "http://localhost:$POORT/api/voertuigen/db" \
             | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('voertuigen',[])))" 2>/dev/null || echo "?")
tegels=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://localhost:$POORT/data/tegels/index.json" || echo "?")
extern=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' https://bussie.hodc.nl/ || echo "?")

echo
echo "  service      : $status (start voortaan mee bij een reboot)"
echo "  voertuigen   : $voertuigen live"
echo "  tegelindex   : HTTP $tegels"
echo "  publieke site: HTTP $extern  → https://bussie.hodc.nl"
echo

if [ "$status" = "active" ] && [ "$tegels" = "200" ]; then
    echo "Klaar."
else
    echo "Er klopt iets niet. Logboek bekijken met:  journalctl -u bussie -n 50"
    exit 1
fi
