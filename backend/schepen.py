#!/usr/bin/env python3
"""
Bussie Scheepvaart
Luistert naar de AIS-stroom van aisstream.io en houdt van elk schip in en
rond Nederland de laatste positie bij.

De sleutel blijft aan deze kant: hij staat in ~/.config/bussie/aisstream.key
(of in AISSTREAM_KEY) en gaat nooit naar de browser.

Los te draaien om te kijken of het werkt:
    python3 backend/schepen.py
"""

import asyncio
import json
import logging
import os
import threading
import time

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("schepen")

SLEUTELPAD = os.path.expanduser("~/.config/bussie/aisstream.key")
STROOM = "wss://stream.aisstream.io/v0/stream"

# Nederland plus de kustwateren, de Waddenzee en een stuk Noordzee
BBOX = [[[50.5, 2.5], [54.2, 7.5]]]

# Berichten die we willen; de rest van de AIS-soorten is voor ons ruis
SOORTEN = [
    "PositionReport",                 # klasse A: beroepsvaart
    "StandardClassBPositionReport",   # klasse B: kleinere schepen
    "ShipStaticData",                 # naam, afmetingen, bestemming
]

# Een schip dat een kwartier niets van zich laat horen valt van de kaart
VERVALTIJD = 900

# AIS-scheepstypes samengevat tot iets tekenbaars
def scheepssoort(code):
    if code is None:
        return "overig"
    if code == 30:
        return "visser"
    if code in (31, 32, 52):
        return "sleepboot"
    if code == 36:
        return "zeilboot"
    if code == 37:
        return "plezier"
    if 40 <= code <= 49:
        return "sneldienst"
    if 60 <= code <= 69:
        return "passagier"
    if 70 <= code <= 79:
        return "vracht"
    if 80 <= code <= 89:
        return "tanker"
    return "overig"


class Scheepvaart:
    """Houdt de laatst bekende positie per schip bij."""

    def __init__(self, sleutel=None):
        self.sleutel = sleutel or self._lees_sleutel()
        self.schepen = {}            # mmsi → dict
        self.slot = threading.Lock()
        self.verbonden = False
        self.laatste_bericht = 0
        self.tellingen = {"berichten": 0, "posities": 0, "herverbindingen": 0}

    @staticmethod
    def _lees_sleutel():
        sleutel = os.environ.get("AISSTREAM_KEY", "").strip()
        if sleutel:
            return sleutel
        if os.path.exists(SLEUTELPAD):
            with open(SLEUTELPAD) as f:
                return f.read().strip()
        return ""

    # -- verwerken ---------------------------------------------------------

    def _verwerk(self, bericht):
        soort = bericht.get("MessageType")
        meta = bericht.get("MetaData") or {}
        mmsi = meta.get("MMSI")
        if not mmsi:
            return
        inhoud = (bericht.get("Message") or {}).get(soort) or {}
        nu = time.time()

        with self.slot:
            schip = self.schepen.get(mmsi)
            if schip is None:
                schip = self.schepen[mmsi] = {"mmsi": mmsi, "soort": "overig"}

            naam = (meta.get("ShipName") or "").strip()
            if naam:
                schip["naam"] = naam

            if soort == "ShipStaticData":
                schip["soort"] = scheepssoort(inhoud.get("Type"))
                afm = inhoud.get("Dimension") or {}
                lengte = (afm.get("A") or 0) + (afm.get("B") or 0)
                if lengte:
                    schip["lengte"] = lengte
                bestemming = (inhoud.get("Destination") or "").strip()
                if bestemming:
                    schip["bestemming"] = bestemming
                return

            lat = inhoud.get("Latitude", meta.get("latitude"))
            lon = inhoud.get("Longitude", meta.get("longitude"))
            if lat is None or lon is None:
                return

            koers = inhoud.get("Cog")
            if koers is None or koers >= 360:      # 360 = niet beschikbaar
                koers = None
            snelheid = inhoud.get("Sog")
            if snelheid is not None and snelheid > 102:   # 102,3 = onbekend
                snelheid = None

            schip.update({
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "koers": round(koers, 1) if koers is not None else None,
                "snelheid": round(snelheid, 1) if snelheid is not None else None,
                "t": int(nu),
            })
            self.tellingen["posities"] += 1

    def _ruim_op(self):
        grens = time.time() - VERVALTIJD
        with self.slot:
            weg = [m for m, s in self.schepen.items() if s.get("t", 0) < grens]
            for m in weg:
                del self.schepen[m]
        return len(weg)

    # -- naar buiten -------------------------------------------------------

    def momentopname(self):
        """Alle schepen met een bekende positie, klaar om te serveren."""
        with self.slot:
            return [s for s in self.schepen.values() if "lat" in s]

    def status(self):
        with self.slot:
            aantal = sum(1 for s in self.schepen.values() if "lat" in s)
        return {
            "verbonden": self.verbonden,
            "schepen": aantal,
            "laatste_bericht": int(self.laatste_bericht),
            **self.tellingen,
        }

    # -- verbinding --------------------------------------------------------

    async def _luister(self):
        import websockets

        abonnement = json.dumps({
            "APIKey": self.sleutel,
            "BoundingBoxes": BBOX,
            "FilterMessageTypes": SOORTEN,
        })

        wacht = 2
        while True:
            try:
                async with websockets.connect(STROOM, ping_interval=20) as ws:
                    await ws.send(abonnement)
                    self.verbonden = True
                    wacht = 2
                    log.info("Verbonden met de AIS-stroom")
                    async for rauw in ws:
                        self.tellingen["berichten"] += 1
                        self.laatste_bericht = time.time()
                        try:
                            self._verwerk(json.loads(rauw))
                        except Exception as e:
                            log.debug("Bericht overgeslagen: %s", e)
            except Exception as e:
                self.verbonden = False
                self.tellingen["herverbindingen"] += 1
                # Alleen de soort fout loggen, nooit de sleutel
                log.warning("AIS-verbinding weg (%s); opnieuw over %ds", type(e).__name__, wacht)
                await asyncio.sleep(wacht)
                wacht = min(wacht * 2, 120)

    async def _opruimlus(self):
        while True:
            await asyncio.sleep(120)
            weg = self._ruim_op()
            if weg:
                log.debug("%d schepen vervallen", weg)

    def _draai(self):
        lus = asyncio.new_event_loop()
        asyncio.set_event_loop(lus)
        lus.create_task(self._opruimlus())
        lus.run_until_complete(self._luister())

    def start(self):
        """Begin op de achtergrond te luisteren."""
        if not self.sleutel:
            log.warning("Geen AIS-sleutel gevonden (%s of AISSTREAM_KEY) — "
                        "schepen blijven uit", SLEUTELPAD)
            return False
        draad = threading.Thread(target=self._draai, daemon=True, name="ais")
        draad.start()
        log.info("Scheepvaart gestart")
        return True


if __name__ == "__main__":
    vaart = Scheepvaart()
    if not vaart.start():
        raise SystemExit(1)
    for ronde in range(6):
        time.sleep(10)
        s = vaart.status()
        soorten = {}
        for schip in vaart.momentopname():
            soorten[schip["soort"]] = soorten.get(schip["soort"], 0) + 1
        log.info("na %2ds: %d schepen | %s", (ronde + 1) * 10, s["schepen"],
                 ", ".join(f"{k}={v}" for k, v in sorted(soorten.items(), key=lambda kv: -kv[1])))
    met_naam = sum(1 for s in vaart.momentopname() if s.get("naam"))
    log.info("met naam: %d | status: %s", met_naam, vaart.status())
