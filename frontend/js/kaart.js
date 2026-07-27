// ============================================================
// Bussie — Isometrische Canvas Renderer
// Volledig vanaf scratch gebouwd, geen externe kaartbibliotheken.
// ============================================================

export class IsoRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });

    // Camera state
    this.cam = { x: 0, y: 0, zoom: 1, rotation: 0 };
    this.targetCam = { x: 0, y: 0, zoom: 1, rotation: 0 };

    // Map data
    this.mapData = null;
    this.vehicles = [];
    this.filteredLines = new Set(); // leeg = alle lijnen

    // Interaction
    this.dragging = false;
    this.lastMouse = { x: 0, y: 0 };
    this.mouseWorld = null;
    this.hoveredVehicle = null;

    // Theme colors
    this.themes = {
      light: {
        bg: '#dee9f0',
        street: '#d4cfc7',
        streetLine: '#c0bab0',
        building: '#c8c8c8',
        buildingRoof: '#d0d0d0',
        buildingSide: '#a0a0a0',
        water: '#a8d4ea',
        waterStroke: '#88c0d8',
        green: '#c8e8c0',
        greenStroke: '#a8d0a0',
        route: '#d65a1a',
        routeSoft: 'rgba(214,90,26,0.25)',
        stop: '#888',
        stopActive: '#d65a1a',
        vehicle: '#2b3038',
        vehicleLabel: '#ffffff',
        text: '#2b3038',
        panelBorder: 'rgba(43,48,56,0.10)',
      },
      dark: {
        bg: '#10151d',
        street: '#2a3040',
        streetLine: '#1e2430',
        building: '#252b38',
        buildingRoof: '#2e3648',
        buildingSide: '#1a1e28',
        water: '#1a3a5a',
        waterStroke: '#2a5a7a',
        green: '#1a3328',
        greenStroke: '#2a4538',
        route: '#e87030',
        routeSoft: 'rgba(232,112,48,0.25)',
        stop: '#666',
        stopActive: '#e87030',
        vehicle: '#e7ecf2',
        vehicleLabel: '#10151d',
        text: '#e7ecf2',
        panelBorder: 'rgba(231,236,242,0.08)',
      },
    };
    this.theme = 'light';
    this.colors = this.themes.light;

    // Iso projection parameters
    // 45° isometrische projectie
    // Geeft het klassieke "diablo/simcity" uitzicht
    this.isoAngle = Math.PI / 4; // 45° — echte isometrie
    this.cosA = Math.cos(this.isoAngle); // 0.707
    this.sinA = Math.sin(this.isoAngle); // 0.707

    // Building extrusion scale (pixels per meter height)
    this.heightScale = 0.45;

    // 60-seconden vehicle buffer voor vloeiende interpolatie
    this._vehicleBuffer = new Map();

    this.resize();
    this.setupEvents();
  }

  setTheme(theme) {
    this.theme = theme;
    this.colors = this.themes[theme] || this.themes.light;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bussie-theme', theme);
    this.render();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.vw = w;
    this.vh = h;
    this.render();
  }

  // === Coördinaat transformaties ===

  // World (meters) → Screen (pixels)
  worldToScreen(wx, wy) {
    const dx = wx - this.cam.x;
    const dy = wy - this.cam.y;
    const z = this.cam.zoom;

    // Isometrische projectie
    const sx = (dx - dy) * this.cosA * z;
    const sy = (dx + dy) * this.sinA * z;

    return {
      x: sx + this.vw / 2,
      y: sy + this.vh / 2,
    };
  }

  // Screen (pixels) → World (meters)
  screenToWorld(sx, sy) {
    const z = this.cam.zoom;
    const px = (sx - this.vw / 2) / z;
    const py = (sy - this.vh / 2) / z;

    // Inverse iso projectie
    const wx = (px / this.cosA + py / this.sinA) / 2 + this.cam.x;
    const wy = (py / this.sinA - px / this.cosA) / 2 + this.cam.y;

    return { x: wx, y: wy };
  }

  // === Camera ===

  setCenter(wx, wy, zoom) {
    this.targetCam.x = wx;
    this.targetCam.y = wy;
    if (zoom !== undefined) this.targetCam.zoom = zoom;
  }

  pan(dx, dy) {
    // Screen delta → world delta (inverse van worldToScreen)
    const z = this.cam.zoom;
    const wdx = (dx / this.cosA + dy / this.sinA) / (2 * z);
    const wdy = (dy / this.sinA - dx / this.cosA) / (2 * z);
    // Camera beweegt tegengesteld aan muisverschuiving: 
    // slepen naar rechts (+dx) → camera kijkt naar links (−wdx) → kaart schuift mee
    this.cam.x -= wdx;
    this.cam.y -= wdy;
    this.targetCam.x = this.cam.x;
    this.targetCam.y = this.cam.y;
  }

  zoomAt(sx, sy, factor) {
    const worldBefore = this.screenToWorld(sx, sy);
    this.cam.zoom *= factor;
    this.cam.zoom = Math.max(0.5, Math.min(4, this.cam.zoom));
    this.targetCam.zoom = this.cam.zoom;
    const worldAfter = this.screenToWorld(sx, sy);
    this.cam.x += worldBefore.x - worldAfter.x;
    this.cam.y += worldBefore.y - worldAfter.y;
    this.targetCam.x = this.cam.x;
    this.targetCam.y = this.cam.y;
  }

  // === Data ===

  setMapData(data) {
    this.mapData = data;
    // Centreer op map center, start iets uitgezoomd voor overzicht
    if (data && data.center) {
      this.cam.x = 0;
      this.cam.y = 0;
      this.targetCam.x = 0;
      this.targetCam.y = 0;
      this.cam.zoom = 0.9;
      this.targetCam.zoom = 0.9;
    }
  }

  setVehicles(vehicles) {
    this.vehicles = vehicles || [];
  }

  // Update de buffer met nieuwste posities (na positieberekening)
  // Alleen updaten als de data écht veranderd is (voorkomt reset-bug)
  updateBuffer() {
    if (!this._vehicleBuffer || !this.vehicles) return;
    const buf = this._vehicleBuffer;
    const now = Date.now() / 1000;
    for (const v of this.vehicles) {
      if (v._wx === undefined) continue;
      const prev = buf.get(v.id);
      const entry = { x: v._wx, y: v._wy, t: v._pollT || now };

      if (prev) {
        // Check of de data echt veranderd is: minstens 10m verplaatst of 10s later
        const cur = prev.cur || prev;
        if (cur && Math.abs(cur.x - entry.x) < 15 && Math.abs(cur.y - entry.y) < 15) {
          continue; // Zelfde positie, skip buffer update
        }
        buf.set(v.id, { prev: cur, cur: entry, interpStart: now });
      } else {
        buf.set(v.id, { cur: entry, interpStart: now });
      }
    }
  }

  setLineFilter(lines) {
    this.filteredLines = new Set(lines);
  }

  // === Rendering ===

  render() {
    if (!this.mapData) return;

    const ctx = this.ctx;
    const c = this.colors;

    // Camera interpolation (smooth)
    this.cam.x += (this.targetCam.x - this.cam.x) * 0.12;
    this.cam.y += (this.targetCam.y - this.cam.y) * 0.12;
    this.cam.zoom += (this.targetCam.zoom - this.cam.zoom) * 0.12;

    // Achtergrond
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, this.vw, this.vh);

    // Bereken viewport bounds in world space
    const tl = this.screenToWorld(0, 0);
    const tr = this.screenToWorld(this.vw, 0);
    const bl = this.screenToWorld(0, this.vh);
    const br = this.screenToWorld(this.vw, this.vh);
    const wBounds = {
      minX: Math.min(tl.x, tr.x, bl.x, br.x) - 200,
      maxX: Math.max(tl.x, tr.x, bl.x, br.x) + 200,
      minY: Math.min(tl.y, tr.y, bl.y, br.y) - 200,
      maxY: Math.max(tl.y, tr.y, bl.y, br.y) + 200,
    };

    // 1. Water (onderste laag)
    this.drawLayer(ctx, this.mapData.water, wBounds, (ctx, el) => {
      this.drawPolygon(ctx, el.pts, c.water, null);
    });

    // 2. Groen
    this.drawLayer(ctx, this.mapData.green, wBounds, (ctx, el) => {
      this.drawPolygon(ctx, el.pts, c.green, null);
    });

    // 3. Straten
    ctx.lineWidth = 1;
    this.drawLayer(ctx, this.mapData.streets, wBounds, (ctx, el) => {
      this.drawStreet(ctx, el, wBounds);
    });

    // 4. Gebouwen (met 3D extrusie)
    this.drawLayer(ctx, this.mapData.buildings, wBounds, (ctx, el) => {
      this.drawBuilding(ctx, el, wBounds);
    });

    // 5. Busroutes — GPS traces met kleur per lijn, of GTFS shapes
    if (this.mapData.routes) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const route of this.mapData.routes) {
        if (!this.inBounds(route.pts, wBounds)) continue;
        // GPS traces (lijn-route) krijgen een dikkere, meer zichtbare stijl
        if (route.cls === 'lijn-route') {
          // Lijnfilter toepassen
          if (this.filteredLines.size > 0 && !this.filteredLines.has(route.lijn)) continue;
          this.drawPolyline(ctx, route.pts, c.routeSoft, 5 * this.cam.zoom);
        } else {
          this.drawPolyline(ctx, route.pts, c.routeSoft, 4 * this.cam.zoom);
        }
      }
    }

    // 6. Bushaltes
    if (this.mapData.stops) {
      for (const stop of this.mapData.stops) {
        const p = this.worldToScreen(stop.pts[0], stop.pts[1]);
        if (p.x < -20 || p.x > this.vw + 20 || p.y < -20 || p.y > this.vh + 20) continue;
        const r = Math.max(2, 3 * this.cam.zoom);
        ctx.fillStyle = c.stop;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 7. Voertuigen
    this.drawVehicles(ctx, wBounds);

    // Hover popup
    if (this.hoveredVehicle) {
      this.drawVehicleInfo(ctx, this.hoveredVehicle);
    }
  }

  drawLayer(ctx, elements, bounds, drawFn) {
    if (!elements) return;
    for (const el of elements) {
      if (!el.pts || el.pts.length === 0) continue;
      // Quick bounds check: check first point
      const p0 = el.pts[0];
      if (p0[0] < bounds.minX || p0[0] > bounds.maxX || p0[1] < bounds.minY || p0[1] > bounds.maxY) {
        // Still might partially overlap — check more points
        let anyInside = false;
        for (const p of el.pts) {
          if (p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minY && p[1] <= bounds.maxY) {
            anyInside = true;
            break;
          }
        }
        if (!anyInside) continue;
      }
      drawFn(ctx, el);
    }
  }

  drawPolygon(ctx, pts, fill, stroke) {
    if (pts.length < 3) return;
    ctx.beginPath();
    const p0 = this.worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = this.worldToScreen(pts[i][0], pts[i][1]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }

  drawPolyline(ctx, pts, color, width) {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const p0 = this.worldToScreen(pts[0][0], pts[0][1]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = this.worldToScreen(pts[i][0], pts[i][1]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  drawStreet(ctx, el, bounds) {
    const c = this.colors;
    const w = (el.w || 5) * this.cam.zoom;
    this.drawPolyline(ctx, el.pts, c.street, Math.max(1.5, w));
  }

  drawBuilding(ctx, el, bounds) {
    const c = this.colors;
    const pts = el.pts;
    if (pts.length < 3) return;

    // Gebouwhoogte in pixels (op scherm)
    // Default hoogte: minimaal 10m zodat er altijd een zichtbaar 3D effect is
    const heightM = Math.max(10, el.h || 12);
    const height = heightM * this.heightScale * this.cam.zoom;

    // Bereken screen coords voor alle punten (ground level)
    const ground = pts.map(p => this.worldToScreen(p[0], p[1]));
    // Dak = ground omhoog geschoven
    const roof = ground.map(p => ({ x: p.x, y: p.y - height }));

    // 1. Tekenen zijvlakken — alleen de randen die "naar voren" wijzen
    // In iso projectie: een rand is zichtbaar als de buiten-normal een positieve screen-y heeft
    if (height > 1.5) {
      for (let i = 0; i < ground.length - 1; i++) {
        const a = ground[i];
        const b = ground[i + 1];
        const edgeDx = b.x - a.x;
        // Normal naar buiten: (edgeDy, -edgeDx) → als normal.y > 0 is zichtbaar
        // normalY = -edgeDx → rand zichtbaar als edgeDx < 0 (rand loopt naar links op scherm)
        // Maar we willen ALLE randen die naar voren wijzen — breder criterium:
        // Een rand is zichtbaar als de middelste punt op scherm lager ligt dan beide buren
        // Simpeler: teken alle randen waarvan de normal naar beneden wijst
        const normalY = -edgeDx;
        // Versoepel: ook randen die horizontaal lopen (normalY ≈ 0) zijn zichtbaar
        if (normalY >= -1) {
          ctx.fillStyle = c.buildingSide;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineTo(b.x, b.y - height);
          ctx.lineTo(a.x, a.y - height);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // 2. Tekenen dak (de top polygon)
    ctx.beginPath();
    ctx.moveTo(roof[0].x, roof[0].y);
    for (let i = 1; i < roof.length; i++) {
      ctx.lineTo(roof[i].x, roof[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = c.buildingRoof;
    ctx.fill();

    // Dak outline (subtle)
    ctx.strokeStyle = c.buildingSide;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  drawVehicles(ctx, bounds) {
    const c = this.colors;
    const z = this.cam.zoom;

    // Busafmetingen in world units — schaalt natuurgetrouw met zoom
    const busW = 18 * z;
    const busH = 10 * z;

    const now = Date.now() / 1000;

    for (const v of this.vehicles) {
      // Lijnfilter
      if (this.filteredLines.size > 0 && !this.filteredLines.has(v.lijn)) continue;

      // === Vloeiende interpolatie tussen bekende punten ===
      // Buffer: prev (oud) en cur (nieuw). Bus reist in exact de tijd die
      // tussen de twee polls zat. Met route snapping ziet stilstaan er
      // natuurlijk uit (bus bij halte/stoplicht).
      let dispWx, dispWy;
      const buf = this._vehicleBuffer?.get(v.id);

      if (buf && buf.prev && buf.cur && buf.interpStart) {
        // Bereken snelheid + richting voor de popup
        const dt = Math.max(buf.cur.t - buf.prev.t, 1);
        const dist = Math.hypot(buf.cur.x - buf.prev.x, buf.cur.y - buf.prev.y);
        if (dist > 1) {
          v._calcSpeed = Math.round((dist / dt) * 10) / 10;
          const wh = Math.atan2(buf.cur.y - buf.prev.y, buf.cur.x - buf.prev.x);
          let br = (wh + Math.PI / 2) * 180 / Math.PI;
          if (br < 0) br += 360;
          v._calcBearing = Math.round(br);
        } else {
          v._calcSpeed = 0;
        }

        // Interpoleer van prev naar cur, startend vanaf interpStart
        const elapsed = Date.now() / 1000 - buf.interpStart;
        const reisTijd = Math.max(buf.cur.t - buf.prev.t, 1);
        const t = Math.min(elapsed / reisTijd, 1);
        dispWx = buf.prev.x + (buf.cur.x - buf.prev.x) * t;
        dispWy = buf.prev.y + (buf.cur.y - buf.prev.y) * t;

        // Snelheid weergeven in popup (0 is correct als bus stilstaat)
        if (t >= 1) v._calcSpeed = 0; // stilstaand bij cur

      } else if (buf?.cur) {
        dispWx = buf.cur.x;
        dispWy = buf.cur.y;
      } else {
        dispWx = v._wx;
        dispWy = v._wy;
      }

      // Route snapping — bepaal ook de route-richting voor vloeiende heading
      let snapped = null;
      if (this.mapData?.routes) {
        if (!this._routeSpatialIndex) {
          this._routeSpatialIndex = this.mapData.routes
            .filter(r => r.cls !== 'lijn-route')
            .map(route => {
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (const p of route.pts) {
                if (p[0] < minX) minX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] > maxY) maxY = p[1];
              }
              return { route, minX, minY, maxX, maxY };
            });
        }
        let bestDist = Infinity;
        let bestX = dispWx;
        let bestY = dispWy;
        let bestEntry = null;
        let bestSnap = null;
        for (const entry of this._routeSpatialIndex) {
          if (dispWx < entry.minX - 100 || dispWx > entry.maxX + 100 ||
              dispWy < entry.minY - 100 || dispWy > entry.maxY + 100) continue;
          const snap = this.snapToRoute(dispWx, dispWy, entry.route.pts, 100);
          if (snap && snap.dist < bestDist) {
            bestDist = snap.dist;
            bestX = snap.x;
            bestY = snap.y;
            bestEntry = entry;
            bestSnap = snap;
          }
        }
        if (bestDist < 100) {
          dispWx = bestX;
          dispWy = bestY;
          // Bepaal richting uit de route segmenten
          if (bestSnap && bestEntry) {
            const pts = bestEntry.route.pts;
            const seg = bestSnap.seg;
            if (seg >= 0 && seg + 1 < pts.length) {
              const dx = pts[seg + 1][0] - pts[seg][0];
              const dy = pts[seg + 1][1] - pts[seg][1];
              const wh = Math.atan2(dy, dx);
              let br = (wh + Math.PI / 2) * 180 / Math.PI;
              if (br < 0) br += 360;
              v._calcBearing = Math.round(br);
            }
          }
        }
      }

      // Sla de getoonde positie op voor de hover popup
      v._dispWx = dispWx;
      v._dispWy = dispWy;

      // Bereken bewegingsrichting (heading) — gebruik route-richting als beschikbaar
      let heading = null;
      let useBearing = v._calcBearing || v.bearing;
      if (useBearing !== null && useBearing !== undefined) {
        const rad = useBearing * Math.PI / 180;
        heading = rad - Math.PI / 2;
      }
      if (heading === null && v._prevWx !== undefined && v._prevWy !== undefined) {
        const dx = dispWx - v._prevWx;
        const dy = dispWy - v._prevWy;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          heading = Math.atan2(dy, dx);
        }
      }
      if (heading === null && v.richting !== null && v.richting !== undefined) {
        heading = v.richting === 0 ? -Math.PI / 2 : Math.PI / 2;
      }

      const p = this.worldToScreen(dispWx, dispWy);
      if (p.x < -50 || p.x > this.vw + 50 || p.y < -50 || p.y > this.vh + 50) continue;

      const isHovered = this.hoveredVehicle && this.hoveredVehicle.id === v.id;

      // Schaduw (ellipse onder de bus)
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(p.x + 2, p.y + busH * 0.4 + 3, busW * 0.55, busH * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      // Bus body — afgeronde rechthoek
      ctx.save();
      ctx.translate(p.x, p.y);
      if (heading !== null) {
        // Roteer de bus in bewegingsrichting (maar in iso projectie)
        // Converteer world-heading naar screen-heading
        const screenAngle = Math.atan2(
          (Math.cos(heading) + Math.sin(heading)) * this.sinA,
          (Math.cos(heading) - Math.sin(heading)) * this.cosA
        );
        ctx.rotate(screenAngle);
      }

      // Bus body (afgeronde rechthoek)
      const rx = busW / 2;
      const ry = busH / 2;
      const r = Math.min(rx, ry) * 0.25; // afgeronde hoeken

      ctx.fillStyle = c.vehicle;
      ctx.beginPath();
      ctx.moveTo(-rx + r, -ry);
      ctx.lineTo(rx - r, -ry);
      ctx.arcTo(rx, -ry, rx, -ry + r, r);
      ctx.lineTo(rx, ry - r);
      ctx.arcTo(rx, ry, rx - r, ry, r);
      ctx.lineTo(-rx + r, ry);
      ctx.arcTo(-rx, ry, -rx, ry - r, r);
      ctx.lineTo(-rx, -ry + r);
      ctx.arcTo(-rx, -ry, -rx + r, -ry, r);
      ctx.closePath();
      ctx.fill();

      // Voorruit (lichter vlak aan de voorkant)
      if (heading !== null) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.moveTo(rx * 0.4, -ry * 0.6);
        ctx.lineTo(rx * 0.85, -ry * 0.4);
        ctx.lineTo(rx * 0.85, ry * 0.4);
        ctx.lineTo(rx * 0.4, ry * 0.6);
        ctx.closePath();
        ctx.fill();
      }

      // Hover ring
      if (isHovered) {
        ctx.strokeStyle = c.route;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(rx, ry) + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();

      // Lijnnummer label (bovenop de bus, niet geroteerd)
      if (v.lijn && z > 0.25) {
        const fontSize = Math.max(11, 14 * z);
        ctx.font = `bold ${fontSize}px ${this.monoFont || 'monospace'}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = c.vehicleLabel;
        ctx.fillText(v.lijn, p.x, p.y);
      }
    }
  }

  drawVehicleInfo(ctx, v) {
    // Wordt via DOM gedaan in app.js
  }

  inBounds(pts, bounds) {
    for (const p of pts) {
      if (p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minY && p[1] <= bounds.maxY) return true;
    }
    return false;
  }

  // === Interaction ===

  setupEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.lastMouse.x;
        const dy = e.clientY - this.lastMouse.y;
        this.pan(dx, dy);
        this.lastMouse = { x: e.clientX, y: e.clientY };
        // Direct render na pan voor vloeiende ervaring
        this.render();
        return; // Skip hover tijdens slepen
      }

      // Hover detection (alleen als we niet slepen)
      const world = this.screenToWorld(e.clientX, e.clientY);
      this.mouseWorld = world;
      this.checkHover(e.clientX, e.clientY);
    });

    canvas.addEventListener('mouseup', () => {
      this.dragging = false;
    });

    canvas.addEventListener('mouseleave', () => {
      this.dragging = false;
      this.hoveredVehicle = null;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    // Touch
    let touchDist = 0;
    let touchCenter = { x: 0, y: 0 };

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        this.dragging = true;
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        this.dragging = false;
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        touchDist = Math.sqrt(dx * dx + dy * dy);
        touchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && this.dragging) {
        const dx = e.touches[0].clientX - this.lastMouse.x;
        const dy = e.touches[0].clientY - this.lastMouse.y;
        this.pan(dx, dy);
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.render();
      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (touchDist > 0) {
          this.zoomAt(touchCenter.x, touchCenter.y, dist / touchDist);
        }
        touchDist = dist;
        touchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
      }
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
      this.dragging = false;
    });
  }

  checkHover(sx, sy) {
    const vehicles = this.vehicles;
    if (!vehicles || vehicles.length === 0) return;
    const z = this.cam.zoom;
    const hitR = Math.max(18 * z, 10 * z) / 2 + 4;
    const now = Date.now() / 1000;
    let hBest = null, hMin = Infinity;
    for (let vi = 0; vi < vehicles.length; vi++) {
      const v = vehicles[vi];
      if (this.filteredLines.size > 0 && !this.filteredLines.has(v.lijn)) continue;
      let dx = v._wx, dy = v._wy;
      const inTransit = v.st === 2 || v.st === 0;
      if (v._pollT && inTransit) {
        const dt = now - v._pollT;
        if (dt > 0 && dt < 35) {
          const speed = v._calcSpeed !== undefined ? v._calcSpeed : 6;
          let bearing = v._calcBearing;
          if (bearing === undefined && v._prevWx !== undefined) {
            const dx2 = v._wx - v._prevWx, dy2 = v._wy - v._prevWy;
            if (Math.abs(dx2) > 0.5 || Math.abs(dy2) > 0.5) {
              const wh = Math.atan2(dy2, dx2);
              bearing = (wh + Math.PI / 2) * 180 / Math.PI;
              if (bearing < 0) bearing += 360;
            }
          }
          if (bearing === undefined && v.richting !== null && v.richting !== undefined) bearing = v.richting === 0 ? 0 : 180;
          if (bearing !== undefined && bearing !== null) {
            const br = bearing * Math.PI / 180;
            dx = v._wx + Math.sin(br) * speed * dt;
            dy = v._wy - Math.cos(br) * speed * dt;
          }
        }
      }
      const p = this.worldToScreen(dx, dy);
      const dd = Math.hypot(sx - p.x, sy - p.y);
      if (dd < hitR && dd < hMin) { hMin = dd; hBest = v; }
    }
    if (hBest !== this.hoveredVehicle) {
      this.hoveredVehicle = hBest;
      this.onHoverChange?.(hBest);
    }
  }

  // Projecteer een punt op de dichtstbijzijnde route polyline
  snapToRoute(wx, wy, routePts, maxDist = 100) {
    if (!routePts || routePts.length < 2) return null;

    let bestDist = Infinity;
    let bestX = wx;
    let bestY = wy;
    let bestSeg = 0;

    for (let i = 0; i < routePts.length - 1; i++) {
      const ax = routePts[i][0];
      const ay = routePts[i][1];
      const bx = routePts[i + 1][0];
      const by = routePts[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      if (dx === 0 && dy === 0) {
        const d = Math.hypot(wx - ax, wy - ay);
        if (d < bestDist) { bestDist = d; bestX = ax; bestY = ay; bestSeg = i; }
        continue;
      }
      const t = ((wx - ax) * dx + (wy - ay) * dy) / (dx * dx + dy * dy);
      const tc = Math.max(0, Math.min(1, t));
      const px = ax + tc * dx;
      const py = ay + tc * dy;
      const d = Math.hypot(wx - px, wy - py);
      if (d < bestDist) { bestDist = d; bestX = px; bestY = py; bestSeg = i; }
    }

    if (bestDist > maxDist) return null;
    return { x: bestX, y: bestY, dist: bestDist, seg: bestSeg };
  }

  // Web Mercator projectie
  // radius = 6378137 (WGS84 equator radius)
  latlonToMeters(lat, lon, centerLat, centerLon) {
    const R = 6378137;
    const n = Math.PI / 180;
    const r = Math.cos(centerLat * n);
    const x = (lon - centerLon) * n * R * r;
    const y = (lat - centerLat) * n * R;
    return [x, -y]; // negatief y zodat noorden +y is
  }

  // Vehicle data bevat lat/lon — we moeten dit converteren naar world meters
  // net als de kaartdata. We gebruiken dezelfde center als de kaart.
  updateVehiclePositions() {
    if (!this.mapData || !this.mapData.center) return;

    const center = this.mapData.center;
    const centerLat = center.lat;
    const centerLon = center.lon;
    const R = 6378137;
    const n = Math.PI / 180;
    const cosLat = Math.cos(centerLat * n);

    const now = Date.now() / 1000;

    for (const v of this.vehicles) {
      if (v.lat !== undefined && v.lon !== undefined) {
        // Sla vorige positie + tijd op voor snelheidsberekening
        if (v._wx !== undefined) {
          v._prevWx = v._wx;
          v._prevWy = v._wy;
          v._prevT = v._t || 0;
        }
        // Web Mercator projectie (zelfde als kaart_generator.py)
        v._wx = (v.lon - centerLon) * n * R * cosLat;
        v._wy = -(v.lat - centerLat) * n * R;
        v._t = v.t || now;

        // Bereken snelheid uit positieverandering
        // (alleen als we vorige data hebben en er tijd tussen zit)
        if (v._prevWx !== undefined && v._prevT && v._prevT > 0) {
          const dt = v._t - v._prevT;
          if (dt > 1 && dt < 120) { // tussen 1s en 2min
            const dx = v._wx - v._prevWx; // meters
            const dy = v._wy - v._prevWy; // meters
            const dist = Math.sqrt(dx * dx + dy * dy);
            const speedMs = dist / dt;
            // Sanity check: max 30 m/s (108 km/u)
            if (speedMs <= 30) {
              v._calcSpeed = Math.round(speedMs * 10) / 10; // m/s, 1 decimaal
              // Bereken bearing uit verplaatsing
              if (dist > 2) {
                // atan2(dy, dx) geeft world-heading
                // Converteer naar bearing (0=noord, 90=oost)
                const worldHeading = Math.atan2(dy, dx);
                let bearing = (worldHeading + Math.PI / 2) * 180 / Math.PI;
                if (bearing < 0) bearing += 360;
                v._calcBearing = Math.round(bearing);
              }
            }
          }
        }
      }
    }
  }
}