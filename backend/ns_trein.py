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
BASIS = "https://gateway.apiportal.ns.nl"
ENDPOINT = BASIS + "/virtual-train-api/api/vehicle"
STATIONS_ENDPOINT = BASIS + "/nsapp-stations/v3"
RIT_ENDPOINT = BASIS + "/reisinformatie-api/api/v2/journey?train="
INTERVAL = 30  # seconden tussen ophalingen — het is een gedeelde sleutel, niet gulzig zijn

# Een trein die drie ophaalrondes niets van zich laat horen valt van de kaart
VERVALTIJD = 3 * INTERVAL

# De stationslijst verandert hooguit een paar keer per jaar
STATIONS_VERVAL = 24 * 3600
# Een rit blijft een tijdje geldig; zo blijft het bij één navraag per trein
RIT_VERVAL = 600

TYPE_NAMEN = {
    "IC": "intercity",
    "SPR": "sprinter",
}

# De acht NS-stationstypes teruggebracht tot drie maten om te tekenen
STATION_MAAT = {
    "MEGA_STATION": 3,
    "INTERCITY_HUB_STATION": 3,
    "INTERCITY_STATION": 2,
    "EXPRESS_TRAIN_HUB_STATION": 2,
    "EXPRESS_TRAIN_STATION": 2,
    "LOCAL_TRAIN_HUB_STATION": 2,
    "LOCAL_TRAIN_STATION": 1,
    "OPTIONAL_STATION": 1,
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
        self.stations = []           # lijst met NL-stations
        self.stations_op = 0         # wanneer voor het laatst opgehaald
        self.ritten = {}             # ritnummer → (tijd, {herkomst, bestemming})
        self.rit_slot = threading.Lock()

    @staticmethod
    def _lees_sleutel():
        sleutel = os.environ.get("NS_KEY", "").strip()
        if sleutel:
            return sleutel
        if os.path.exists(SLEUTELPAD):
            with open(SLEUTELPAD) as f:
                return f.read().strip()
        return ""

    def _haal(self, url, timeout=15):
        """JSON ophalen bij de NS-gateway met de sleutel in de header."""
        req = urllib.request.Request(url, headers={
            "Ocp-Apim-Subscription-Key": self.sleutel,
            "User-Agent": "bussie.hodc.nl/0.1",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())

    # -- stations ----------------------------------------------------------

    def _stations_ophalen(self):
        """De stationslijst; alleen de Nederlandse, teruggebracht tot wat
        de kaart nodig heeft. Verandert nauwelijks, dus eens per dag."""
        data = self._haal(STATIONS_ENDPOINT, timeout=30)
        uit = []
        for s in data.get("payload") or []:
            if s.get("country") != "NL":
                continue
            loc = s.get("location") or {}
            lat, lng = loc.get("lat"), loc.get("lng")
            if lat is None or lng is None:
                continue
            namen = s.get("names") or {}
            uit.append({
                "code": (s.get("id") or {}).get("code", ""),
                "naam": namen.get("medium") or namen.get("long") or "",
                "lat": round(lat, 5),
                "lon": round(lng, 5),
                "maat": STATION_MAAT.get(s.get("stationType"), 1),
                "sporen": len(s.get("tracks") or []),
            })
        with self.slot:
            self.stations = uit
            self.stations_op = time.time()
        log.info("%d stations geladen", len(uit))

    def stationslijst(self):
        with self.slot:
            return self.stations

    # -- rit (herkomst en bestemming) --------------------------------------

    def rit(self, nummer):
        """Waar komt deze trein vandaan en waar gaat hij heen?

        De positiefeed geeft alleen een ritnummer, dus dit is een tweede
        navraag. Die doen we alleen als er echt naar gevraagd wordt (bij
        het aanwijzen van een trein) en bewaren we, anders staan er bij
        tweehonderd rijdende treinen tweehonderd verzoeken open.
        """
        nummer = str(nummer)
        nu = time.time()
        with self.rit_slot:
            bewaard = self.ritten.get(nummer)
            if bewaard and nu - bewaard[0] < RIT_VERVAL:
                return bewaard[1]

        try:
            data = self._haal(RIT_ENDPOINT + nummer, timeout=12)
            stops = (data.get("payload") or {}).get("stops") or []
            uit = None
            if stops:
                soort = ""
                for st in stops:
                    for vertrek in st.get("departures") or []:
                        naam = (vertrek.get("product") or {}).get("longCategoryName")
                        if naam:
                            soort = naam
                            break
                    if soort:
                        break
                uit = {
                    "herkomst": (stops[0].get("stop") or {}).get("name", ""),
                    "bestemming": (stops[-1].get("stop") or {}).get("name", ""),
                    "soort": soort,
                    "stops": len(stops),
                }
        except Exception as e:
            log.debug("Rit %s ophalen mislukt: %s", nummer, type(e).__name__)
            uit = None

        with self.rit_slot:
            # Ook een mislukte poging bewaren we even, anders blijft de
            # frontend het bij elk hoveren opnieuw proberen.
            self.ritten[nummer] = (nu, uit)
            if len(self.ritten) > 800:
                oud = sorted(self.ritten.items(), key=lambda kv: kv[1][0])[:400]
                for k, _ in oud:
                    del self.ritten[k]
        return uit

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
            # De stationslijst hoeft maar eens per dag; een fout daarin mag
            # de posities niet in de weg zitten, dus apart afgevangen.
            if time.time() - self.stations_op > STATIONS_VERVAL:
                try:
                    self._stations_ophalen()
                except Exception as e:
                    log.warning("Stations ophalen mislukt (%s)", type(e).__name__)
                    self.stations_op = time.time() - STATIONS_VERVAL + 300  # over 5 min opnieuw
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
