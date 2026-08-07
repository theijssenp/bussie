#!/usr/bin/env python3
"""
Bussie Treinen
Haalt live treinposities op via de NS Virtual Train API en houdt de
laatste positie per trein bij.

De sleutel blijft aan deze kant: hij staat in ~/.config/bussie/ns.key
(of in NS_KEY) en gaat nooit naar de browser.

Los te draaien om te kijken of het werkt:
    python3 backend/ns_trein.py
"""

import json
import logging
import os
import threading
import time
import urllib.request

log = logging.getLogger("treinen")

SLEUTELPAD = os.path.expanduser("~/.config/bussie/ns.key")
ENDPOINT = "https://gateway.apiportal.ns.nl/virtual-train-api/api/vehicle"
INTERVAL = 30  # seconden tussen ophalingen — het is een gedeelde sleutel, niet gulzig zijn

# Een trein die drie ophaalrondes niets van zich laat horen valt van de kaart
VERVALTIJD = 3 * INTERVAL

TYPE_NAMEN = {
    "IC": "intercity",
    "SPR": "sprinter",
}


class Treinen:
    """Houdt de laatst bekende positie per trein bij."""

    def __init__(self, sleutel=None):
        self.sleutel = sleutel or self._lees_sleutel()
        self.treinen = {}            # treinNummer → dict
        self.slot = threading.Lock()
        self.verbonden = False
        self.laatste_ophaal = 0
        self.tellingen = {"ophalingen": 0, "fouten": 0}

    @staticmethod
    def _lees_sleutel():
        sleutel = os.environ.get("NS_KEY", "").strip()
        if sleutel:
            return sleutel
        if os.path.exists(SLEUTELPAD):
            with open(SLEUTELPAD) as f:
                return f.read().strip()
        return ""

    # -- ophalen -------------------------------------------------------

    def _ophalen(self):
        req = urllib.request.Request(ENDPOINT, headers={
            "Ocp-Apim-Subscription-Key": self.sleutel,
            "User-Agent": "bussie.hodc.nl/0.1",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())

        treinen = (data.get("payload") or {}).get("treinen") or []
        nu = time.time()

        with self.slot:
            for t in treinen:
                nummer = t.get("treinNummer")
                lat, lng = t.get("lat"), t.get("lng")
                if nummer is None or lat is None or lng is None:
                    continue

                koers = t.get("richting")
                if koers is not None and koers >= 360:  # niet beschikbaar
                    koers = None
                snelheid = t.get("snelheid")

                self.treinen[nummer] = {
                    "nummer": nummer,
                    "rit": t.get("ritId"),
                    "soort": TYPE_NAMEN.get(t.get("type"), (t.get("type") or "trein").lower()),
                    "lat": round(lat, 5),
                    "lon": round(lng, 5),
                    "koers": round(koers, 1) if koers is not None else None,
                    "snelheid": round(snelheid, 1) if snelheid is not None else None,
                    "t": int(nu),
                }

            grens = nu - VERVALTIJD
            weg = [n for n, tr in self.treinen.items() if tr["t"] < grens]
            for n in weg:
                del self.treinen[n]

        self.verbonden = True
        self.laatste_ophaal = nu
        self.tellingen["ophalingen"] += 1

    # -- naar buiten -----------------------------------------------------

    def momentopname(self):
        with self.slot:
            return list(self.treinen.values())

    def status(self):
        with self.slot:
            aantal = len(self.treinen)
        return {
            "verbonden": self.verbonden,
            "treinen": aantal,
            "laatste_ophaal": int(self.laatste_ophaal),
            **self.tellingen,
        }

    # -- lus ---------------------------------------------------------------

    def _lus(self):
        wacht = INTERVAL
        while True:
            try:
                self._ophalen()
                wacht = INTERVAL
            except Exception as e:
                self.verbonden = False
                self.tellingen["fouten"] += 1
                # Alleen de soort fout loggen, nooit de sleutel
                log.warning("Treinposities ophalen mislukt (%s); opnieuw over %ds",
                            type(e).__name__, wacht)
                wacht = min(wacht * 2, 300)
            time.sleep(wacht)

    def start(self):
        """Begin op de achtergrond te pollen."""
        if not self.sleutel:
            log.warning("Geen NS-sleutel gevonden (%s of NS_KEY) — treinen blijven uit",
                        SLEUTELPAD)
            return False
        draad = threading.Thread(target=self._lus, daemon=True, name="ns-treinen")
        draad.start()
        log.info("Treinen gestart")
        return True


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    vaart = Treinen()
    if not vaart.start():
        raise SystemExit(1)
    for ronde in range(4):
        time.sleep(10)
        s = vaart.status()
        soorten = {}
        for trein in vaart.momentopname():
            soorten[trein["soort"]] = soorten.get(trein["soort"], 0) + 1
        log.info("na %2ds: %s | %s", (ronde + 1) * 10, s,
                 ", ".join(f"{k}={v}" for k, v in sorted(soorten.items(), key=lambda kv: -kv[1])))
