"""
Lijnen die dezelfde weg delen naast elkaar leggen, als op een metrokaart.

Voor elk punt van elke route rekenen we uit hoeveel lijnen daar dezelfde
weg volgen en op welke plek in die bundel deze lijn hoort. De browser
schuift de lijn bij het tekenen zoveel lijndiktes opzij; zo zie je in een
drukke straat tien gekleurde strepen naast elkaar in plaats van één.

Werkwijze, alles in numpy:

1. Elke route wordt bemonsterd, elke STAP meter een punt met zijn
   rijrichting.
2. Elk monster valt in een rastervak van CEL meter, en binnen dat vak in
   een richtingsvak: de rijrichting zonder voor- of achteruit, in SECTOREN
   stukken. Daardoor tellen lijnen op een kruisende weg niet mee. Een monster
   meldt zich ook aan in het dichtstbijzijnde buursector, zodat twee lijnen
   die minder dan een halve sector van elkaar afwijken elkaar altijd zien.
3. Per vak liggen de lijnen in een vaste volgorde (op kleur, dan op
   lijnnummer). Plek in de bundel = rang in die volgorde, rond het midden.
4. Welke kant "links" is bepaalt de laagste lijn in het vak met zijn eigen
   rijrichting. Een lijn die de andere kant op rijdt krijgt een omgekeerd
   teken, zodat heen en terug van dezelfde lijn op één strook liggen.
5. Het resultaat wordt langs de route uitgesmeerd, zodat een lijn die een
   bundel in- of uitgaat er geleidelijk naartoe schuift in plaats van te
   springen.

Een "lijn" is hier lijnnummer plus kleur: heen, terug en varianten van één
lijn delen dus één strook.
"""

import math

import numpy as np

STAP = 12.5        # m tussen twee monsters
CEL = 25.0         # m, rastervak
SECTOREN = 6       # richtingsvakken over een halve slag (30° elk)
UITSMEER = 6       # monsters aan weerszijden voor het uitsmeren (~75 m)
EENHEID = 4        # verschuiving opgeslagen in kwarten van een strook


def _nummer_sleutel(lijn):
    cijfers = "".join(c for c in lijn if c.isdigit())
    return (int(cijfers) if cijfers else 9999, lijn)


def bereken(lijnen):
    """
    Geeft per route een lijst met per punt de verschuiving in kwarten van
    een strook (int, -127..127). Positief = links van de rijrichting.
    """
    if not lijnen:
        return []

    sleutels = sorted({(r["lijn"], r["kleur"]) for r in lijnen},
                      key=lambda s: (s[1], _nummer_sleutel(s[0])))
    sleutel_id = {s: i for i, s in enumerate(sleutels)}
    K = len(sleutels)

    # 1. Bemonsteren. Elk routepunt is zelf ook een monster, zodat we het
    #    resultaat straks direct per punt kunnen teruglezen.
    xs, ys, dxs, dys, routes, sleutel_per = [], [], [], [], [], []
    punt_index = []          # per route: index van elk routepunt in de monsters
    teller = 0
    for ri, r in enumerate(lijnen):
        p = np.asarray(r["pts"], dtype=np.float64)
        if len(p) < 2:
            punt_index.append(np.zeros(len(p), dtype=np.int64) + teller)
            # één los punt: als monster zonder richting
            xs.append(p[:, 0]); ys.append(p[:, 1])
            dxs.append(np.ones(len(p))); dys.append(np.zeros(len(p)))
            routes.append(np.full(len(p), ri)); sleutel_per.append(sleutel_id[(r["lijn"], r["kleur"])])
            teller += len(p)
            continue
        d = np.diff(p, axis=0)
        lengte = np.hypot(d[:, 0], d[:, 1])
        n = np.maximum(1, np.ceil(lengte / STAP).astype(np.int64))
        # richting per stuk; stukken van nul lengte nemen de vorige over
        ux = np.divide(d[:, 0], lengte, out=np.zeros_like(lengte), where=lengte > 0)
        uy = np.divide(d[:, 1], lengte, out=np.zeros_like(lengte), where=lengte > 0)
        for i in range(1, len(ux)):
            if lengte[i] == 0:
                ux[i], uy[i] = ux[i - 1], uy[i - 1]

        stuk = np.repeat(np.arange(len(n)), n)
        begin = np.concatenate(([0], np.cumsum(n)[:-1]))
        binnen = np.arange(len(stuk)) - begin[stuk]
        t = binnen / n[stuk]
        mx = p[stuk, 0] + d[stuk, 0] * t
        my = p[stuk, 1] + d[stuk, 1] * t
        # laatste punt erbij
        mx = np.append(mx, p[-1, 0])
        my = np.append(my, p[-1, 1])
        mdx = np.append(ux[stuk], ux[-1])
        mdy = np.append(uy[stuk], uy[-1])

        xs.append(mx); ys.append(my); dxs.append(mdx); dys.append(mdy)
        routes.append(np.full(len(mx), ri))
        sleutel_per.append(sleutel_id[(r["lijn"], r["kleur"])])
        punt_index.append(np.append(begin, len(stuk)) + teller)
        teller += len(mx)

    x = np.concatenate(xs); y = np.concatenate(ys)
    dx = np.concatenate(dxs); dy = np.concatenate(dys)
    route = np.concatenate(routes)
    sleutel = np.asarray(sleutel_per, dtype=np.int64)[route]
    richting = np.asarray([r.get("richting", 0) for r in lijnen], dtype=np.int64)[route]

    # 2. Rastervak en richtingsvak
    cx = np.floor(x / CEL).astype(np.int64)
    cy = np.floor(y / CEL).astype(np.int64)
    cx -= cx.min(); cy -= cy.min()
    cel = cx * (int(cy.max()) + 1) + cy
    hoek = np.mod(np.arctan2(dy, dx), math.pi)            # zonder voor/achter
    pos = hoek / (math.pi / SECTOREN)
    eigen = np.floor(pos).astype(np.int64) % SECTOREN
    buur = np.where(pos - np.floor(pos) < 0.5, eigen - 1, eigen + 1) % SECTOREN

    groep = cel * SECTOREN + eigen
    groep_buur = cel * SECTOREN + buur

    # 3. Welke lijnen zitten in elk vak, en op welke plek staat elke lijn
    paren = np.unique(np.concatenate((groep * K + sleutel, groep_buur * K + sleutel)))
    paar_groep = paren // K
    links = np.searchsorted(paar_groep, groep, side="left")
    rechts = np.searchsorted(paar_groep, groep, side="right")
    aantal = rechts - links
    rang = np.searchsorted(paren, groep * K + sleutel) - links

    # 4. Oriëntatie per vak: de rijrichting van de laagste lijn erin
    volgorde = np.lexsort((richting, sleutel, groep))
    g_sorted = groep[volgorde]
    eerste = volgorde[np.concatenate(([True], g_sorted[1:] != g_sorted[:-1]))]
    ref_groep = groep[eerste]
    idx = np.searchsorted(ref_groep, groep)
    ref = eerste[idx]
    teken = np.where(dx * dx[ref] + dy * dy[ref] >= 0, 1.0, -1.0)

    plek = np.where(aantal > 1, teken * (rang - (aantal - 1) / 2.0), 0.0)

    # 5. Uitsmeren langs de route en teruglezen per routepunt
    uit = []
    venster = np.ones(2 * UITSMEER + 1)
    for ri in range(len(lijnen)):
        pi = punt_index[ri]
        if len(pi) == 0:
            uit.append([])
            continue
        a, b = pi[0], pi[-1] + 1
        reeks = plek[a:b]
        if len(reeks) > 1:
            pad = np.pad(reeks, UITSMEER, mode="edge")
            reeks = np.convolve(pad, venster, mode="valid") / venster.sum()
        waarden = np.clip(np.round(reeks[pi - a] * EENHEID), -127, 127).astype(int)
        uit.append(waarden.tolist())
    return uit


if __name__ == "__main__":
    import json
    import os
    import sys
    import time
    pad = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), "..", "data", "lijnen.json")
    with open(pad, encoding="utf-8") as f:
        lijnen = json.load(f)["lijnen"]
    t = time.time()
    res = bereken(lijnen)
    alle = np.concatenate([np.asarray(r) for r in res if r])
    print(f"{len(lijnen)} routes in {time.time() - t:.1f}s; "
          f"{(alle != 0).mean() * 100:.0f}% van de punten verschoven, "
          f"max {np.abs(alle).max() / EENHEID:.1f} stroken")
