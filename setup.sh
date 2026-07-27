#!/bin/bash
# Setup script voor bussie.hodc.nl
# Run met sudo: bash ~/hodc/bussie/setup.sh

set -e

# 1. Symlink naar /var/www
if [ ! -d /var/www/bussie.hodc.nl ]; then
    ln -s /home/pieter/hodc/bussie /var/www/bussie.hodc.nl
    echo "Symlink: /var/www/bussie.hodc.nl → /home/pieter/hodc/bussie"
fi

# 2. Apache VirtualHost
cp /home/pieter/hodc/bussie/bussie.apache.conf /etc/apache2/sites-available/bussie.conf
a2ensite bussie
systemctl reload apache2
echo "Apache VirtualHost geactiveerd"

# 3. Systemd service
cp /home/pieter/hodc/bussie/bussie.service /etc/systemd/system/bussie.service
systemctl daemon-reload
systemctl enable --now bussie
echo "Bussie backend service gestart op poort 8900"

# 4. Cloudflare DNS (al gedaan via cloudflared, ter controle)
echo ""
echo "Cloudflare DNS: bussie.hodc.nl → tunnel a4e5e0a8 (al aangemaakt)"
echo "Tunnel ingress: *.hodc.nl → localhost:80 (bestaande wildcard)"

echo ""
echo "=== Klaar ==="
echo "Lokaal:  http://localhost:8900"
echo "Via Apache: http://bussie.hodc.nl"
echo ""
echo "Test: curl http://localhost:8900/api/voertuigen?stad=groningen"