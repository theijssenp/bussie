#!/bin/bash
# Update script voor bussie.hodc.nl — na code wijzigingen
# Run met sudo: bash ~/hodc/bussie/update.sh

set -e

# 1. Systemd service update (code is gewijzigd)
cp /home/pieter/hodc/bussie/bussie.service /etc/systemd/system/bussie.service
systemctl daemon-reload
systemctl enable bussie
systemctl restart bussie
echo "Bussie service herstart"

# 2. Apache herladen
systemctl reload apache2
echo "Apache herladen"

echo ""
echo "=== Klaar ==="
echo "Backend draait nu als systemd service op poort 8900"
echo "Test: curl http://localhost:8900/api/voertuigen?stad=groningen"
echo "Site: https://bussie.hodc.nl"
echo ""
echo "Status: $(systemctl is-active bussie)"