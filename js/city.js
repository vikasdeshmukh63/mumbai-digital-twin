/* ============================================================================
   city.js — builds the computational model of the city.

   Everything produced here is SIMULATED unless it derives directly from the
   reference geometry in data.js. The build is deterministic: the same seed
   always yields the same city, so scenario results are reproducible.
   ========================================================================== */
(function (MT) {
  'use strict';

  const geo = MT.geo;
  const SEED = 20260921;

  /* mulberry32 — small, fast, deterministic */
  function rngFrom(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const city = { seed: SEED };

  /* ---------------------------------------------------------------- extent */
  /* Land is the union of several rings: Mumbai + Salsette island (the
     original coast), the mainland, and Elephanta. Mainland vertices flagged
     as "frame" sit on the model's outer edge — where the model stops, not a
     shoreline — so they are never drawn or treated as coast. */
  const coastRing = geo.pathXY(MT.COAST);
  const landRings = [{ name: 'Mumbai & Salsette', ring: coastRing, frame: new Uint8Array(coastRing.length / 2) }]
    .concat((MT.LANDMASSES || []).map(L => ({
      name: L.name, ring: geo.pathXY(L.ring), frame: Uint8Array.from(L.ring.map(p => p[2] ? 1 : 0))
    })));
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const L of landRings) {
    const b = geo.ringBBox(L.ring);
    bb.x0 = Math.min(bb.x0, b.x0); bb.y0 = Math.min(bb.y0, b.y0);
    bb.x1 = Math.max(bb.x1, b.x1); bb.y1 = Math.max(bb.y1, b.y1);
  }
  const PAD = 2500;
  const EXT = { x0: bb.x0 - PAD, y0: bb.y0 - PAD, x1: bb.x1 + PAD, y1: bb.y1 + PAD };
  const CELL = 200;
  const GW = Math.ceil((EXT.x1 - EXT.x0) / CELL);
  const GH = Math.ceil((EXT.y1 - EXT.y0) / CELL);

  city.coastRing = coastRing;
  city.landRings = landRings;
  /* bounding box of the frame vertices: the model's outer edge on land */
  city.frameBox = null;
  for (const L of landRings) for (let i = 0; i < L.frame.length; i++) if (L.frame[i]) {
    const x = L.ring[i * 2], y = L.ring[i * 2 + 1], F = city.frameBox || (city.frameBox = { x0: x, y0: y, x1: x, y1: y });
    F.x0 = Math.min(F.x0, x); F.y0 = Math.min(F.y0, y); F.x1 = Math.max(F.x1, x); F.y1 = Math.max(F.y1, y);
  }
  city.isLand = (x, y) => {
    for (const L of landRings) if (geo.inRing(L.ring, x, y)) return true;
    return false;
  };
  city.extent = EXT;
  city.grid = { cell: CELL, w: GW, h: GH, x0: EXT.x0, y0: EXT.y0 };
  city.cellIndex = (x, y) => {
    const i = Math.floor((x - EXT.x0) / CELL), j = Math.floor((y - EXT.y0) / CELL);
    if (i < 0 || j < 0 || i >= GW || j >= GH) return -1;
    return j * GW + i;
  };
  city.cellCentre = idx => ({
    x: EXT.x0 + (idx % GW + 0.5) * CELL,
    y: EXT.y0 + (Math.floor(idx / GW) + 0.5) * CELL
  });

  /* ----------------------------------------------------------- land / water */
  const greenRings = MT.GREEN.map(g => ({ name: g.name, ring: geo.pathXY(g.ring) }));
  const lakes = MT.LAKES.map(l => ({
    name: l.name, x: geo.x(l.lon), y: geo.y(l.lat),
    rx: l.rx * geo.M_LON, ry: l.ry * geo.M_LAT
  }));
  const rivers = MT.RIVERS.map(r => ({ name: r.name, w: r.width, path: geo.pathXY(r.path) }));
  city.greenRings = greenRings; city.lakes = lakes; city.rivers = rivers;

  const land = new Uint8Array(GW * GH);
  const green = new Uint8Array(GW * GH);
  const water = new Uint8Array(GW * GH);

  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const idx = j * GW + i;
    const x = EXT.x0 + (i + 0.5) * CELL, y = EXT.y0 + (j + 0.5) * CELL;
    land[idx] = city.isLand(x, y) ? 1 : 0;
    if (!land[idx]) continue;
    for (const g of greenRings) if (geo.inRing(g.ring, x, y)) { green[idx] = 1; break; }
    for (const l of lakes) {
      const dx = (x - l.x) / l.rx, dy = (y - l.y) / l.ry;
      if (dx * dx + dy * dy < 1) { water[idx] = 1; break; }
    }
    if (!water[idx]) for (const r of rivers) {
      if (geo.distToPath(r.path, x, y) < r.w) { water[idx] = 1; break; }
    }
  }
  city.land = land; city.green = green; city.waterMask = water;

  /* ------------------------------------------------- distance to open water */
  /* Two-pass chamfer over the grid; seeds are non-land cells and lakes.       */
  const coastDist = new Float32Array(GW * GH).fill(1e9);
  for (let k = 0; k < GW * GH; k++) if (!land[k] || water[k]) coastDist[k] = 0;
  const D1 = CELL, D2 = CELL * 1.41421356;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i; let v = coastDist[k];
    if (i > 0) v = Math.min(v, coastDist[k - 1] + D1);
    if (j > 0) v = Math.min(v, coastDist[k - GW] + D1);
    if (i > 0 && j > 0) v = Math.min(v, coastDist[k - GW - 1] + D2);
    if (i < GW - 1 && j > 0) v = Math.min(v, coastDist[k - GW + 1] + D2);
    coastDist[k] = v;
  }
  for (let j = GH - 1; j >= 0; j--) for (let i = GW - 1; i >= 0; i--) {
    const k = j * GW + i; let v = coastDist[k];
    if (i < GW - 1) v = Math.min(v, coastDist[k + 1] + D1);
    if (j < GH - 1) v = Math.min(v, coastDist[k + GW] + D1);
    if (i < GW - 1 && j < GH - 1) v = Math.min(v, coastDist[k + GW + 1] + D2);
    if (i > 0 && j < GH - 1) v = Math.min(v, coastDist[k + GW - 1] + D2);
    coastDist[k] = v;
  }
  city.coastDist = coastDist;

  /* --------------------------------------------------- synthetic elevation */
  /* NOT a DEM. Coast-distance ramp + named hill masses + value noise.        */
  const HILLS = [
    { lon: 72.7990, lat: 18.9560, r: 1400, h: 48,  n: 'Malabar Hill' },
    { lon: 72.8250, lat: 19.0610, r: 1100, h: 38,  n: 'Pali Hill' },
    { lon: 72.9100, lat: 19.2250, r: 6500, h: 310, n: 'Sanjay Gandhi NP ridge' },
    { lon: 72.8800, lat: 19.1850, r: 3200, h: 130, n: 'Aarey plateau' },
    { lon: 72.9150, lat: 19.1350, r: 2200, h: 70,  n: 'Powai hills' },
    { lon: 72.9450, lat: 19.0080, r: 2600, h: 240, n: 'Trombay hill' },
    { lon: 72.9100, lat: 19.0900, r: 1500, h: 45,  n: 'Ghatkopar hill' },
    { lon: 72.8430, lat: 19.0280, r: 900,  h: 22,  n: 'Matunga rise' },
    { lon: 72.9500, lat: 19.2400, r: 3000, h: 260, n: 'Yeoor hills' },
    { lon: 73.0380, lat: 19.1100, r: 4200, h: 210, n: 'Parsik hill range' },
    { lon: 73.0780, lat: 19.0450, r: 2600, h: 190, n: 'Kharghar hills' },
    { lon: 72.9400, lat: 19.4200, r: 5500, h: 460, n: 'Tungareshwar hills' },
    { lon: 72.9310, lat: 18.9640, r: 900,  h: 150, n: 'Elephanta' }
  ].map(h => ({ ...h, x: geo.x(h.lon), y: geo.y(h.lat) }));
  city.hills = HILLS;

  const noiseRng = rngFrom(SEED + 7);
  const NW = 64, NH = 96;
  const noiseGrid = new Float32Array(NW * NH);
  for (let i = 0; i < noiseGrid.length; i++) noiseGrid[i] = noiseRng();
  function smoothNoise(x, y) {
    const u = ((x - EXT.x0) / (EXT.x1 - EXT.x0)) * (NW - 1);
    const v = ((y - EXT.y0) / (EXT.y1 - EXT.y0)) * (NH - 1);
    const i = Math.max(0, Math.min(NW - 2, Math.floor(u))), j = Math.max(0, Math.min(NH - 2, Math.floor(v)));
    const fu = u - i, fv = v - j;
    const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
    const a = noiseGrid[j * NW + i], b = noiseGrid[j * NW + i + 1];
    const c = noiseGrid[(j + 1) * NW + i], d = noiseGrid[(j + 1) * NW + i + 1];
    return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
  }

  const elev = new Float32Array(GW * GH);
  for (let k = 0; k < GW * GH; k++) {
    const c = city.cellCentre(k);
    if (!land[k]) { elev[k] = -2; continue; }
    const cd = Math.min(coastDist[k], 4000);
    let e = 1.2 + 6.5 * (cd / 4000) + 3.0 * Math.pow(cd / 4000, 2);
    for (const h of HILLS) {
      const d = Math.hypot(c.x - h.x, c.y - h.y);
      if (d < h.r) { const t = 1 - d / h.r; e += h.h * t * t * (3 - 2 * t) * 0.5; }
    }
    e += (smoothNoise(c.x, c.y) - 0.5) * 5.5;
    if (water[k]) e -= 2.5;
    elev[k] = e;
  }
  city.elev = elev;
  city.elevAt = function (x, y) { const k = city.cellIndex(x, y); return k < 0 ? 0 : elev[k]; };

  /* Neighbourhood-relative depression — the ponding driver in the flood model */
  const smoothElev = new Float32Array(GW * GH);
  const R = 5;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    let s = 0, n = 0;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue;
      s += elev[jj * GW + ii]; n++;
    }
    smoothElev[j * GW + i] = s / n;
  }
  const depression = new Float32Array(GW * GH);
  for (let k = 0; k < GW * GH; k++) {
    depression[k] = Math.max(0, Math.min(1, (smoothElev[k] - elev[k]) / 5));
  }
  city.depression = depression;

  /* ---------------------------------------- synthetic density & zone raster */
  const locs = MT.LOCALITIES.map(l => ({ ...l, x: geo.x(l.lon), y: geo.y(l.lat) }));
  city.localities = locs;

  const density = new Float32Array(GW * GH);
  const zoneOf = new Int16Array(GW * GH).fill(-1);
  for (let k = 0; k < GW * GH; k++) {
    if (!land[k]) continue;
    const c = city.cellCentre(k);
    let best = -1, bestD = Infinity, d = 0;
    for (let i = 0; i < locs.length; i++) {
      const L = locs[i];
      const dd = Math.hypot(c.x - L.x, c.y - L.y);
      if (dd < bestD) { bestD = dd; best = i; }
      d += L.densityClass * Math.exp(-(dd * dd) / (2 * L.r * L.r * 1.6));
    }
    zoneOf[k] = best;
    density[k] = green[k] || water[k] ? d * 0.06 : d;
  }
  let dMax = 0; for (let k = 0; k < density.length; k++) if (density[k] > dMax) dMax = density[k];
  for (let k = 0; k < density.length; k++) density[k] /= (dMax || 1);
  city.density = density; city.zoneOf = zoneOf;

  /* ------------------------------------------------------------ road graph */
  /* ---- corridor geometry, reconciled before anything is built on it ----
     1. Rail lines that share a corridor with another line (the Harbour
        Goregaon branch on the Western tracks, the Trans-Harbour line into
        Vashi) are drawn alongside it, offset sideways, not on top of it.
     2. Roads and railway lines are drawn wider than life so they read at city
        scale; where a road runs parallel to a suburban line closer than the
        two drawn widths allow, the road is eased sideways away from the
        tracks. Crossings are left exactly where they are. Metro lines are
        elevated over their roads in reality (Line 7 over the WEH, 2A over the
        Link Road), so they are not separated from them. */
  function offsetPathXY(q, d) {
    if (!d) return q.slice();
    const n = q.length / 2, out = new Array(q.length);
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const dx = q[i1 * 2] - q[i0 * 2], dy = q[i1 * 2 + 1] - q[i0 * 2 + 1], L = Math.hypot(dx, dy) || 1;
      out[i * 2] = q[i * 2] + dy / L * d; out[i * 2 + 1] = q[i * 2 + 1] - dx / L * d;
    }
    return out;
  }
  city.railXY = {}; city.railLL = {};
  MT.RAIL.concat(MT.METRO).forEach(l => {
    /* OpenStreetMap track where the line was matched (js/osm.js), else the schematic station-to-station line */
    const q = l.osmPath ? geo.pathXY(l.osmPath) : offsetPathXY(geo.pathXY(l.stations.map(st => [st.lon, st.lat])), l.offset || 0);
    city.railXY[l.id] = q;
    const ll = []; for (let i = 0; i < q.length; i += 2) ll.push([geo.lon(q[i]), geo.lat(q[i + 1])]);
    city.railLL[l.id] = ll;
  });
  /* Rail flyovers. Where two suburban lines cross, one is carried over the
     other on a viaduct, as at real grade-separated junctions: the line later
     in the list (normally the branch) rises from the 5 m bed to 17 m, holds
     that height for 80 m either side of the crossing and ramps down over
     360 m. Both lines are densified to 40 m pieces around each crossing so
     the ramp is smooth and the two decks sort cleanly when drawn. */
  const RAIL_BED_Z = 5, RAIL_FLY_Z = 17, FLAT = 80, RAMP = 360, ZONE = FLAT + RAMP + 60;
  city.railZ = {}; city.railStop = {};   // railStop: 1 where a track vertex is a station
  /* the undensified alignment: same line, far fewer segments — used for the
     2D clearance work (roads, right of way), which only needs the geometry */
  city.railXY2D = {}; for (const id in city.railXY) city.railXY2D[id] = city.railXY[id];
  {
    const ids = MT.RAIL.map(l => l.id);
    const arc = q => { const c = [0]; for (let i = 2; i < q.length; i += 2) c.push(c[c.length - 1] + Math.hypot(q[i] - q[i - 2], q[i + 1] - q[i - 1])); return c; };
    const X = (ax, ay, bx, by, cx, cy, dx, dy) => {
      const r = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx); if (Math.abs(r) < 1e-9) return null;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / r, u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / r;
      return (t > 0 && t < 1 && u > 0 && u < 1) ? { t, u } : null;
    };
    const cross = {}; ids.forEach(id => cross[id] = { up: [], near: [] });   // arc positions: where this line rises / where it passes under
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const A = city.railXY[ids[a]], B = city.railXY[ids[b]], cA = arc(A), cB = arc(B);
      for (let i = 0; i + 3 < A.length; i += 2) for (let j = 0; j + 3 < B.length; j += 2) {
        const h = X(A[i], A[i + 1], A[i + 2], A[i + 3], B[j], B[j + 1], B[j + 2], B[j + 3]);
        if (!h) continue;
        /* a real crossing, not two lines sharing a corridor or merging at a junction */
        { const ax = A[i + 2] - A[i], ay = A[i + 3] - A[i + 1], bx = B[j + 2] - B[j], by = B[j + 3] - B[j + 1];
          const c = Math.abs(ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
          if (c > 0.9) continue; }
        const sA = cA[i / 2] + h.t * (cA[i / 2 + 1] - cA[i / 2]), sB = cB[j / 2] + h.u * (cB[j / 2 + 1] - cB[j / 2]);
        cross[ids[b]].up.push(sB); cross[ids[a]].near.push(sA);          // the later line goes over
      }
    }
    /* Water crossings: sampled every 40 m against the exact shoreline, rivers
       and lakes. Over water the bed is carried on a bridge 12 m up, ramped
       over 250 m of land each side, so the piers read as a real bridge. */
    const RAIL_BRIDGE_Z = 12, WRAMP = 250;
    const exactWet = (x, y) => {
      /* cheap first: if this 200 m cell and all its neighbours are plain land,
         there is no water within ~200 m and the exact test can be skipped */
      const k0 = city.cellIndex(x, y);
      if (k0 >= 0) {
        const i0 = k0 % GW, j0 = (k0 / GW) | 0; let dry = true;
        for (let dj = -1; dj <= 1 && dry; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i0 + di, jj = j0 + dj;
          if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) { dry = false; break; }
          const kk = jj * GW + ii; if (!land[kk] || water[kk]) { dry = false; break; }
        }
        if (dry) return false;
      }
      if (!city.isLand(x, y)) return true;
      for (const r of rivers) if (geo.distToPath(r.path, x, y) < r.w / 2 + 4) return true;
      for (const k of lakes) { const dx = (x - k.x) / k.rx, dy = (y - k.y) / k.ry; if (dx * dx + dy * dy < 1) return true; }
      return false;
    };
    const wetRuns = {};
    for (const l of MT.RAIL) {
      const q = city.railXY[l.id], runs = []; let s = 0, cur = null;
      for (let i = 0; i + 3 < q.length; i += 2) {
        const L = Math.hypot(q[i + 2] - q[i], q[i + 3] - q[i + 1]), n = Math.max(1, Math.round(L / 40));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n, w = exactWet(q[i] + (q[i + 2] - q[i]) * t, q[i + 1] + (q[i + 3] - q[i + 1]) * t), sc = s + L * t;
          if (w) { if (cur) cur[1] = sc + 20; else cur = [sc - 20, sc + 20]; }
          else if (cur) { runs.push(cur); cur = null; }
        }
        s += L;
      }
      if (cur) runs.push(cur);
      wetRuns[l.id] = runs;
    }
    for (const l of MT.RAIL.concat(MT.METRO)) {
      const q = city.railXY[l.id], C = cross[l.id], WR = wetRuns[l.id] || [];
      /* which vertices are stations: all of them on a schematic line, the listed ones on an OSM track */
      const stnSet = l.osmStops ? new Set(l.osmStops) : null, isStn = i => !stnSet || stnSet.has(i);
      const zConst = MT.METRO.includes(l) ? (l.underground ? 0 : 11) : RAIL_BED_Z;
      if (!C || (!C.up.length && !C.near.length && !WR.length)) {
        city.railZ[l.id] = new Float64Array(q.length / 2).fill(zConst);
        city.railStop[l.id] = new Uint8Array(q.length / 2).map((_, i) => isStn(i) ? 1 : 0);
      } else {
        const c = arc(q), marks = C.up.concat(C.near), out = [], outS = [], stop = [];
        for (let i = 0; i + 3 < q.length; i += 2) {
          const s0 = c[i / 2], s1 = c[i / 2 + 1];
          const hot = marks.some(m => s1 > m - ZONE && s0 < m + ZONE) || WR.some(r => s1 > r[0] - WRAMP - 60 && s0 < r[1] + WRAMP + 60);
          const n = hot ? Math.max(1, Math.ceil((s1 - s0) / 40)) : 1;
          for (let k = 0; k < n; k++) { const t = k / n; out.push(q[i] + (q[i + 2] - q[i]) * t, q[i + 1] + (q[i + 3] - q[i + 1]) * t); outS.push(s0 + (s1 - s0) * t); stop.push(k === 0 && isStn(i / 2) ? 1 : 0); }
        }
        out.push(q[q.length - 2], q[q.length - 1]); outS.push(c[c.length - 1]); stop.push(1);
        city.railStop[l.id] = Uint8Array.from(stop);
        const z = new Float64Array(outS.length);
        for (let k = 0; k < outS.length; k++) {
          let f = 0;
          for (const m of C.up) { const d = Math.abs(outS[k] - m); f = Math.max(f, d <= FLAT ? 1 : d >= FLAT + RAMP ? 0 : 1 - (d - FLAT) / RAMP); }
          f = f * f * (3 - 2 * f);                                           // eased ramp
          let w = 0;
          for (const r of WR) { const d = outS[k] < r[0] ? r[0] - outS[k] : outS[k] > r[1] ? outS[k] - r[1] : 0; w = Math.max(w, d >= WRAMP ? 0 : 1 - d / WRAMP); }
          w = w * w * (3 - 2 * w);
          z[k] = Math.max(RAIL_BED_Z + (RAIL_FLY_Z - RAIL_BED_Z) * f, RAIL_BED_Z + (RAIL_BRIDGE_Z - RAIL_BED_Z) * w);
        }
        city.railXY[l.id] = out; city.railZ[l.id] = z;
      }
      const qq = city.railXY[l.id], zz = city.railZ[l.id], ll = [];
      for (let i = 0; i < qq.length; i += 2) ll.push([geo.lon(qq[i]), geo.lat(qq[i + 1]), zz[i / 2]]);
      city.railLL[l.id] = ll;
    }
    city.railFlyovers = Object.values(cross).reduce((n, c) => n + c.up.length, 0);
  }
  /* drawn half-widths: the rail bed with its embankment, and the (widened) roads */
  const RAIL_DRAWN_HALF = 25, ROAD_DRAWN_HALF = { expressway: 41, arterial: 30, link: 21, bridge: 36 };
  const railSegsXY = [];
  MT.RAIL.forEach(l => { const q = city.railXY2D[l.id]; for (let i = 0; i + 3 < q.length; i += 2) railSegsXY.push([q[i], q[i + 1], q[i + 2], q[i + 3]]); });
  const RXG = new Map();
  railSegsXY.forEach((r, i) => {
    for (let gx = Math.floor((Math.min(r[0], r[2]) - 120) / 300); gx <= Math.floor((Math.max(r[0], r[2]) + 120) / 300); gx++)
      for (let gy = Math.floor((Math.min(r[1], r[3]) - 120) / 300); gy <= Math.floor((Math.max(r[1], r[3]) + 120) / 300); gy++) {
        const k = gx + ':' + gy; (RXG.get(k) || RXG.set(k, []).get(k)).push(r);
      }
  });
  const railSegsNear = (x, y) => RXG.get(Math.floor(x / 300) + ':' + Math.floor(y / 300)) || [];
  city.roadPathXY = MT.ROADS.map(r => {
    const q = geo.densify(geo.pathXY(r.path), 150);
    const need = (ROAD_DRAWN_HALF[r.cls] || 18) + RAIL_DRAWN_HALF + 10;
    const n = q.length / 2;
    const push = () => {
      let moved = 0;
      for (let i = 1; i < n - 1; i++) {                 // ends stay put: they are junctions
        const x = q[i * 2], y = q[i * 2 + 1];
        const tx = q[(i + 1) * 2] - q[(i - 1) * 2], ty = q[(i + 1) * 2 + 1] - q[(i - 1) * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        for (const sg of railSegsNear(x, y)) {
          const d = geo.distToSeg(x, y, sg[0], sg[1], sg[2], sg[3]);
          if (d >= need) continue;
          const sx = sg[2] - sg[0], sy = sg[3] - sg[1], sl = Math.hypot(sx, sy) || 1;
          if (Math.abs((tx * sx + ty * sy) / (tl * sl)) < 0.88) continue;   // a crossing, not a parallel run
          let nx = -sy / sl, ny = sx / sl;
          if ((x - sg[0]) * nx + (y - sg[1]) * ny < 0) { nx = -nx; ny = -ny; }
          q[i * 2] += nx * (need - d); q[i * 2 + 1] += ny * (need - d);
          moved++;
          break;
        }
      }
      return moved;
    };
    const smooth = () => {
      for (let i = 1; i < n - 1; i++) {
        q[i * 2] = (q[(i - 1) * 2] + 2 * q[i * 2] + q[(i + 1) * 2]) / 4;
        q[i * 2 + 1] = (q[(i - 1) * 2 + 1] + 2 * q[i * 2 + 1] + q[(i + 1) * 2 + 1]) / 4;
      }
    };
    for (let pass = 0; pass < 6; pass++) { if (!push()) break; smooth(); }
    push(); push();                                     // finish on a push, never on a smooth
    return q;
  });

  const nodes = [];           // {x,y,edges:[]}
  const nodeKey = new Map();
  const edges = [];           // {a,b,len,road,cls,lanes,speed,cap,base,vol,closed}
  const SNAP = 140;

  /* A node keeps its exact position; a new point merges into an existing
     node only within 30 m (shared junctions). Snapping every vertex to a
     140 m lattice used to move road geometry by up to 70 m — enough to put a
     carriageway back on top of the railway line it had been eased away from. */
  const MERGE = 30;
  function nodeAt(x, y) {
    const kx = Math.floor(x / SNAP), ky = Math.floor(y / SNAP);
    for (let i = kx - 1; i <= kx + 1; i++) for (let j = ky - 1; j <= ky + 1; j++) {
      const list = nodeKey.get(i + ':' + j); if (!list) continue;
      for (const id of list) if (Math.hypot(nodes[id].x - x, nodes[id].y - y) < MERGE) return id;
    }
    const id = nodes.length;
    nodes.push({ x, y, edges: [], roads: new Set() });
    const k = kx + ':' + ky;
    if (!nodeKey.has(k)) nodeKey.set(k, []);
    nodeKey.get(k).push(id);
    return id;
  }
  const edgeKeys = new Set();
  const ekey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);

  const CAP_PER_LANE = 1800; // veh/h/lane — a standard planning value, not measured
  MT.ROADS.forEach((r, ri) => {
    const p = city.roadPathXY[ri];
    let prev = nodeAt(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) {
      const cur = nodeAt(p[i], p[i + 1]);
      if (cur === prev) continue;
      const len = Math.hypot(nodes[cur].x - nodes[prev].x, nodes[cur].y - nodes[prev].y);
      if (len < 1) continue;
      const e = {
        id: edges.length, a: prev, b: cur, len,
        road: ri, name: r.name, roadId: r.id, cls: r.cls,
        lanes: r.lanes, speed: r.speed,
        cap: r.lanes * CAP_PER_LANE, base: 0, vol: 0, closed: false
      };
      edges.push(e); edgeKeys.add(ekey(prev, cur));
      nodes[prev].edges.push(e.id); nodes[cur].edges.push(e.id);
      nodes[prev].roads.add(ri); nodes[cur].roads.add(ri);
      prev = cur;
    }
  });

  /* Only arterial corridors are modelled, so the raw graph is fragmented: two
     corridors that meet in the real street grid may be a kilometre apart here.
     Each node is therefore linked to its nearest node on every OTHER corridor
     within 900 m. These connectors stand in for the missing local network and
     are declared as an assumption wherever the traffic model is reported.    */
  const nIdx = new geo.PointIndex(nodes.map((n, i) => ({ x: n.x, y: n.y, i })), 500);
  const STITCH = 900;
  for (let i = 0; i < nodes.length; i++) {
    const near = nIdx.within(nodes[i].x, nodes[i].y, STITCH);
    const bestPerRoad = new Map();
    for (const h of near) {
      const j = h.item.i;
      if (j === i) continue;
      for (const rd of nodes[j].roads) {
        if (nodes[i].roads.has(rd)) continue;
        const cur = bestPerRoad.get(rd);
        if (!cur || h.d < cur.d) bestPerRoad.set(rd, { j, d: h.d });
      }
    }
    for (const { j, d } of bestPerRoad.values()) {
      if (edgeKeys.has(ekey(i, j))) continue;
      const e = {
        id: edges.length, a: i, b: j, len: Math.max(60, d),
        road: -1, name: 'Local connector', roadId: 'CONN', cls: 'link',
        lanes: 2, speed: 22, cap: 2 * CAP_PER_LANE, base: 0, vol: 0, closed: false
      };
      edges.push(e); edgeKeys.add(ekey(i, j));
      nodes[i].edges.push(e.id); nodes[j].edges.push(e.id);
    }
  }
  /* Island pass. A corridor more than 900 m from every other one (Atal Setu at
     Sewri, Mumbra Bypass, the Kalyan–Badlapur and Panvel–JNPA groups) would be
     left as a separate network that no route could reach. Join every pair of
     pieces whose nearest LAND nodes are within 2.5 km, then tie anything still
     separate to the main network, so routing and traffic work everywhere. */
  {
    const onLand = n => { const k = city.cellIndex(n.x, n.y); return k >= 0 && land[k] && !water[k]; };
    const link = (i, j, d) => {
      if (edgeKeys.has(ekey(i, j))) return;
      const e = { id: edges.length, a: i, b: j, len: Math.max(60, d * 1.25),
        road: -1, name: 'Local connector', roadId: 'CONN', cls: 'link',
        lanes: 2, speed: 22, cap: 2 * CAP_PER_LANE, base: 0, vol: 0, closed: false };
      edges.push(e); edgeKeys.add(ekey(i, j));
      nodes[i].edges.push(e.id); nodes[j].edges.push(e.id);
    };
    const comps = () => {
      const par = nodes.map((_, i) => i), f = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
      for (const e of edges) par[f(e.a)] = f(e.b);
      const m = new Map(); nodes.forEach((_, i) => { const r = f(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); });
      return { root: f, list: [...m.values()].sort((a, b) => b.length - a.length) };
    };
    /* nearest land-node pair between piece `c` and any node outside it accepted by ok() */
    const nearestOut = (c, root, ok, R) => {
      const rc = root(c[0]); let best = null;
      for (const i of c) { if (!onLand(nodes[i])) continue;
        for (const h of nIdx.within(nodes[i].x, nodes[i].y, R)) { const j = h.item.i;
          if (root(j) === rc || !onLand(nodes[j]) || !ok(root(j))) continue;
          if (!best || h.d < best.d) best = { i, j, d: h.d }; } }
      return best;
    };
    let C = comps();
    if (C.list.length > 1) {
      /* every piece may link once to each other piece within 2.5 km */
      const pairs = new Map();
      for (const c of C.list) { const rc = C.root(c[0]);
        for (const i of c) { if (!onLand(nodes[i])) continue;
          for (const h of nIdx.within(nodes[i].x, nodes[i].y, 2500)) { const j = h.item.i, rj = C.root(j);
            if (rj === rc || !onLand(nodes[j])) continue;
            const k = rc < rj ? rc + ':' + rj : rj + ':' + rc, cur = pairs.get(k);
            if (!cur || h.d < cur.d) pairs.set(k, { i, j, d: h.d }); } } }
      for (const p of pairs.values()) link(p.i, p.j, p.d);
      /* anything still apart joins the main network at its nearest point */
      for (let guard = 0; guard < 20; guard++) {
        C = comps(); if (C.list.length < 2) break;
        const main = C.root(C.list[0][0]);
        const b = nearestOut(C.list[1], C.root, r => r === main, 20000);
        if (!b) break; link(b.i, b.j, b.d);
      }
    }
    city.graphPieces = comps().list.length;
  }
  /* Decks over water. A road edge whose end sits over sea, creek or river is
     carried on a deck (the named sea bridges higher than an ordinary creek
     crossing); an edge that hops a narrow channel between two land nodes gets
     a low deck. Land ends stay at grade, so every bridge ramps up and down. */
  /* sea, creeks and rivers — but not lakes, which roads skirt rather than cross */
  const inLake = (x, y) => lakes.some(l => { const dx = (x - l.x) / l.rx, dy = (y - l.y) / l.ry; return dx * dx + dy * dy < 1.15; });
  const overWater = (x, y) => { const k = city.cellIndex(x, y); return k < 0 || !land[k] || (!!water[k] && !inLake(x, y)); };
  /* Underground roads: a link lying along an OpenStreetMap tunnel (Coastal
     Road under Malabar Hill, Eastern Freeway, the underpasses) is marked as a
     tunnel — never a bridge or flyover, and drawn below ground. */
  const tunSegs = [];
  for (const t of ((MT.OSM && MT.OSM.tunnels) || [])) { const q = geo.pathXY(t.path); for (let i = 0; i + 3 < q.length; i += 2) tunSegs.push([q[i], q[i + 1], q[i + 2], q[i + 3], t.name]); }
  const nearTunnel = (x, y) => { for (const t of tunSegs) if (geo.distToSeg(x, y, t[0], t[1], t[2], t[3]) < 45) return t[4] || 'Tunnel'; return null; };
  city.tunnelKm = 0;
  if (tunSegs.length) for (const e of edges) {
    if (e.road < 0) continue;
    const A = nodes[e.a], B = nodes[e.b];
    const m = nearTunnel((A.x + B.x) / 2, (A.y + B.y) / 2);
    if (!m || !(nearTunnel(A.x, A.y) || nearTunnel(B.x, B.y))) continue;
    /* only the same road goes underground: a road that merely passes over or
       beside a tunnel (Marine Drive over the Coastal Road) stays on the surface */
    const words = t => t.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !/^(road|mumbai|marg|underpass|phase|tunnel)$/.test(w));
    const ew = words(e.name || ''), tw = words(m);
    if (/elevated/i.test(e.name || '') || !ew.some(w => tw.includes(w))) continue;
    e.tunnel = m; city.tunnelKm += e.len / 1000;
  }
  /* one continuous tunnel: a short surface piece between two tunnel pieces of
     the same road (a gap in the OSM tagging) is underground too */
  for (let pass = 0; pass < 3; pass++) for (const e of edges) {
    if (e.road < 0 || e.tunnel || e.len > 260) continue;
    const tunAt = n => nodes[n].edges.some(id => { const f = edges[id]; return f !== e && f.tunnel && f.roadId === e.roadId; });
    if (tunAt(e.a) && tunAt(e.b)) { e.tunnel = edges[nodes[e.a].edges.find(id => edges[id].tunnel)].tunnel; city.tunnelKm += e.len / 1000; }
  }
  for (const e of edges) {
    if (e.road < 0) { e.za = e.zb = 0; continue; }
    if (e.tunnel) { e.za = e.zb = 0; e.bridge = false; e.overWater = false; continue; }
    const A = nodes[e.a], B = nodes[e.b];
    const H = e.cls === 'bridge' ? 22 : 12;   // deck height over water, m (illustrative)
    /* An ordinary road only counts as crossing water where there is water on
       BOTH sides of it — a road that merely runs along a generalised shore
       (Marine Drive, the Coastal Road) is not a bridge. Named bridges always are. */
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1, nx = -(B.y - A.y) / L * 160, ny = (B.x - A.x) / L * 160;
    const wet = e.cls === 'bridge'
      ? (x, y) => overWater(x, y)
      : (x, y) => overWater(x, y) && overWater(x + nx, y + ny) && overWater(x - nx, y - ny);
    e.za = wet(A.x, A.y) ? H : 0;
    e.zb = wet(B.x, B.y) ? H : 0;
    if (!e.za && !e.zb && wet((A.x + B.x) / 2, (A.y + B.y) / 2)) e.za = e.zb = H * 0.6;
    if (e.cls === 'bridge' && !e.za && !e.zb) e.za = e.zb = H;   // named bridge fully over land ends
    e.bridge = e.za > 0 || e.zb > 0;
    e.overWater = overWater((A.x + B.x) / 2, (A.y + B.y) / 2);
  }

  /* Flyovers and road-over-rail bridges. Wherever a road crosses a surface
     railway line, or two corridors cross without meeting at a junction, the
     road is lifted on a deck over the crossing and ramps back to grade on the
     links either side. Between two roads the more important one goes over
     (expressway > bridge > arterial > link). Positions follow the modelled
     crossings, not surveyed structures. */
  const segX = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
  };
  const RANK = { expressway: 4, bridge: 3, arterial: 2, link: 1 };
  const FLY = 11;                                        // flyover deck height, m (display: clearance reads at city scale)
  const FLY_RAIL = 17;                                   // over the railway: clears the raised bed and the (display-scale) trains
  const lift = new Set(), railLift = new Set();
  const railSegs = [];
  MT.RAIL.forEach(l => { const q = city.railXY2D[l.id]; for (let i = 0; i + 3 < q.length; i += 2) railSegs.push(q.slice(i, i + 4)); });
  /* drawn half-widths (ROAD_STYLE × 0.85 / 2) and the rail bed with its embankment */
  const DRAWN_HALF = { expressway: 41, arterial: 30, link: 21, bridge: 36 }, BED_HALF = 25;
  /* spatial index over the rail segments (400 m cells); callers only care about
     rail within a few hundred metres, so the search stops at two rings */
  const RSG = new Map(), RC = 400;
  railSegs.forEach((r, i) => {
    for (let gx = Math.floor(Math.min(r[0], r[2]) / RC); gx <= Math.floor(Math.max(r[0], r[2]) / RC); gx++)
      for (let gy = Math.floor(Math.min(r[1], r[3]) / RC); gy <= Math.floor(Math.max(r[1], r[3]) / RC); gy++) {
        const k = gx + ':' + gy; (RSG.get(k) || RSG.set(k, []).get(k)).push(i);
      }
  });
  const railNear = (x, y) => {                          // nearest rail segment: distance and unit normal pointing away
    let best = Infinity, nx = 0, ny = 0;
    const cx = Math.floor(x / RC), cy = Math.floor(y / RC), seen = new Set();
    const cand = [];
    for (let i = cx - 2; i <= cx + 2; i++) for (let j = cy - 2; j <= cy + 2; j++) for (const k of RSG.get(i + ':' + j) || []) if (!seen.has(k)) { seen.add(k); cand.push(railSegs[k]); }
    for (const r of cand) {
      const d = geo.distToSeg(x, y, r[0], r[1], r[2], r[3]);
      if (d < best) {
        best = d; const L = Math.hypot(r[2] - r[0], r[3] - r[1]) || 1;
        nx = -(r[3] - r[1]) / L; ny = (r[2] - r[0]) / L;
        if ((x - r[0]) * nx + (y - r[1]) * ny < 0) { nx = -nx; ny = -ny; }
      }
    }
    return { d: best, nx, ny };
  };
  /* 1. Nudge ground-level road nodes that sit on the rail bed out to its
        edge. Junction ends of corridors were never eased away (they are
        fixed), which is where a carriageway still lay over the tracks. */
  const nodeHalf = new Float64Array(nodes.length);
  for (const e of edges) if (e.road >= 0) for (const n of [e.a, e.b]) nodeHalf[n] = Math.max(nodeHalf[n], DRAWN_HALF[e.cls] || 20);
  for (let pass = 0; pass < 3; pass++) {
    let moved = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (!nodeHalf[i]) continue;
      const N = nodes[i];
      if (N.edges.some(id => edges[id].za > 0 || edges[id].zb > 0)) continue;   // bridge ends stay
      const r = railNear(N.x, N.y), need = nodeHalf[i] + BED_HALF + 4;
      if (r.d >= need) continue;
      /* a node whose edges run across the line is a crossing: it gets lifted below, not moved */
      const across = N.edges.some(id => { const e = edges[id]; if (e.road < 0) return false;
        const O = nodes[e.a === i ? e.b : e.a]; const rr = railNear(O.x, O.y);
        return (O.x - N.x) * r.nx + (O.y - N.y) * r.ny < -(r.d + 1) && rr.d < 400; });
      if (across) continue;
      N.x += r.nx * (need - r.d); N.y += r.ny * (need - r.d); moved++;
    }
    if (!moved) break;
  }
  /* ...and whole edges whose middle drifts onto the bed while both ends are
     clear (the line curves toward the road between two nodes): shift both
     ends out together, parallel runs only */
  for (let pass = 0; pass < 4; pass++) {
    let moved = 0;
    for (const e of edges) {
      if (e.road < 0 || e.za > 0 || e.zb > 0) continue;
      const A = nodes[e.a], B = nodes[e.b], L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L, need = (DRAWN_HALF[e.cls] || 20) + BED_HALF + 4;
      let worst = null;
      for (let k = 0, n = Math.max(2, Math.ceil(L / 20)); k <= n; k++) {
        const t = k / n, r = railNear(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t);
        if (r.d < need && (!worst || r.d < worst.d)) worst = r;
      }
      if (!worst || Math.abs(ux * worst.nx + uy * worst.ny) > 0.35) continue;   // crossings are lifted, not moved
      const m = need - worst.d;
      for (const N of [A, B]) if (!N.edges.some(id => edges[id].za > 0 || edges[id].zb > 0)) { N.x += worst.nx * m; N.y += worst.ny * m; moved++; }
    }
    if (!moved) break;
  }
  for (const e of edges) { const A = nodes[e.a], B = nodes[e.b]; e.len = Math.max(1, Math.hypot(B.x - A.x, B.y - A.y)); }
  const roadEdges = edges.filter(e => e.road >= 0);
  const eGrid = new Map(), EG = 1000;
  roadEdges.forEach(e => {
    const A = nodes[e.a], B = nodes[e.b];
    for (let i = Math.floor(Math.min(A.x, B.x) / EG); i <= Math.floor(Math.max(A.x, B.x) / EG); i++)
      for (let j = Math.floor(Math.min(A.y, B.y) / EG); j <= Math.floor(Math.max(A.y, B.y) / EG); j++) {
        const k = i + ':' + j; if (!eGrid.has(k)) eGrid.set(k, []); eGrid.get(k).push(e);
      }
  });
  let railX = 0, roadX = 0;
  for (const e of roadEdges) {
    if (e.bridge || e.tunnel) continue;
    const A = nodes[e.a], B = nodes[e.b];
    for (const r of railSegs) if (segX(A.x, A.y, B.x, B.y, r[0], r[1], r[2], r[3])) { lift.add(e); railLift.add(e); railX++; break; }
    /* 2. near-misses: an edge that still touches the bed at an angle (not a
          parallel run) is a crossing too, and becomes a road overbridge */
    if (!lift.has(e)) {
      const need = (DRAWN_HALF[e.cls] || 20) + BED_HALF, L = e.len, ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      for (let k = 0, n = Math.max(2, Math.ceil(L / 20)); k <= n; k++) {
        const t = k / n, r = railNear(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t);
        if (r.d < need && Math.abs(ux * r.nx + uy * r.ny) > 0.35) { lift.add(e); railLift.add(e); railX++; break; }
      }
    }
    if (lift.has(e)) continue;
    const seen = new Set();
    for (let i = Math.floor(Math.min(A.x, B.x) / EG); i <= Math.floor(Math.max(A.x, B.x) / EG); i++)
      for (let j = Math.floor(Math.min(A.y, B.y) / EG); j <= Math.floor(Math.max(A.y, B.y) / EG); j++) {
        for (const f of eGrid.get(i + ':' + j) || []) {
          if (f === e || seen.has(f) || f.roadId === e.roadId) continue; seen.add(f);
          if (f.a === e.a || f.a === e.b || f.b === e.a || f.b === e.b) continue;   // a real junction
          const C = nodes[f.a], D = nodes[f.b];
          if (!segX(A.x, A.y, B.x, B.y, C.x, C.y, D.x, D.y)) continue;
          const re = RANK[e.cls] || 1, rf = RANK[f.cls] || 1;
          if (re > rf || (re === rf && e.road < f.road)) { lift.add(e); roadX++; }
        }
      }
  }
  /* lift the crossing links, then ramp the neighbouring links of the same road */
  /* Real flyovers and road bridges from OpenStreetMap (bridge=yes): a link
     that runs along one, in the same direction, is raised onto it. Short
     gaps are bridged so a flyover does not bob up and down; stretches under
     120 m (culverts over nullahs) stay at grade. */
  { const BG = new Map(), BC = 200, bsegs = [];
    for (const bw of ((MT.OSM && MT.OSM.bridges) || [])) { const q = geo.pathXY(bw.path); for (let i = 0; i + 3 < q.length; i += 2) {
      const sg = [q[i], q[i + 1], q[i + 2], q[i + 3]]; bsegs.push(sg);
      for (let gx = Math.floor((Math.min(sg[0], sg[2]) - 40) / BC); gx <= Math.floor((Math.max(sg[0], sg[2]) + 40) / BC); gx++)
        for (let gy = Math.floor((Math.min(sg[1], sg[3]) - 40) / BC); gy <= Math.floor((Math.max(sg[1], sg[3]) + 40) / BC); gy++) { const k = gx + ':' + gy; (BG.get(k) || BG.set(k, []).get(k)).push(sg); } } }
    const onBridge = (x, y, ux, uy) => { for (const sg of BG.get(Math.floor(x / BC) + ':' + Math.floor(y / BC)) || []) {
      if (geo.distToSeg(x, y, sg[0], sg[1], sg[2], sg[3]) > 28) continue;
      const L2 = Math.hypot(sg[2] - sg[0], sg[3] - sg[1]) || 1; if (Math.abs(ux * (sg[2] - sg[0]) / L2 + uy * (sg[3] - sg[1]) / L2) > 0.85) return true; } return false; };
    const osmB = new Set();
    for (const e of roadEdges) {
      if (e.tunnel || e.bridge || lift.has(e)) continue;
      const A = nodes[e.a], B = nodes[e.b], L = e.len || 1, ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      let hit = 0, n = Math.max(2, Math.ceil(L / 25));
      for (let k = 0; k <= n; k++) if (onBridge(A.x + (B.x - A.x) * k / n, A.y + (B.y - A.y) * k / n, ux, uy)) hit++;
      if (hit / (n + 1) > 0.6) osmB.add(e);
    }
    /* runs along each corridor: fill gaps < 150 m, drop runs < 120 m */
    const byRoad = new Map(); for (const e of roadEdges) (byRoad.get(e.roadId) || byRoad.set(e.roadId, []).get(e.roadId)).push(e);
    for (const [, list] of byRoad) {
      const adj = new Map(); for (const e of list) for (const n of [e.a, e.b]) (adj.get(n) || adj.set(n, []).get(n)).push(e);
      for (let pass = 0; pass < 3; pass++) for (const e of list) {
        if (osmB.has(e) || e.len > 150 || e.tunnel || e.bridge) continue;
        if ((adj.get(e.a) || []).some(f => f !== e && osmB.has(f)) && (adj.get(e.b) || []).some(f => f !== e && osmB.has(f))) osmB.add(e);
      }
      const seen = new Set();
      for (const e of list) { if (!osmB.has(e) || seen.has(e)) continue;
        const run = [], st = [e]; seen.add(e);
        while (st.length) { const f = st.pop(); run.push(f); for (const n of [f.a, f.b]) for (const g2 of adj.get(n) || []) if (osmB.has(g2) && !seen.has(g2)) { seen.add(g2); st.push(g2); } }
        if (run.reduce((s2, f) => s2 + f.len, 0) < 120) run.forEach(f => osmB.delete(f));
      }
    }
    for (const e of osmB) lift.add(e);
    city.osmFlyKm = [...osmB].reduce((s2, e) => s2 + e.len, 0) / 1000;
  }
  for (const e of lift) { const H = railLift.has(e) ? FLY_RAIL : FLY; e.za = Math.max(e.za, H); e.zb = Math.max(e.zb, H); e.bridge = true; e.flyover = true; }
  /* a water bridge that also passes over the railway must clear the trains */
  for (const e of roadEdges) {
    if (!e.bridge || lift.has(e) || Math.max(e.za, e.zb) >= FLY_RAIL) continue;
    const A = nodes[e.a], B = nodes[e.b], need = (DRAWN_HALF[e.cls] || 20) + BED_HALF;
    for (let k = 0, n = Math.max(2, Math.ceil(e.len / 20)); k <= n; k++) {
      const t = k / n;
      if (railNear(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t).d < need) { e.za = Math.max(e.za, FLY_RAIL); e.zb = Math.max(e.zb, FLY_RAIL); break; }
    }
  }
  for (const e of lift) {
    const H = railLift.has(e) ? FLY_RAIL : FLY;
    for (const n of [e.a, e.b]) for (const id of nodes[n].edges) {
      const f = edges[id];
      if (f === e || f.roadId !== e.roadId || lift.has(f) || f.overWater || f.tunnel) continue;
      if (f.a === n) f.za = Math.max(f.za || 0, H); else f.zb = Math.max(f.zb || 0, H);
      f.bridge = true; f.flyover = true;
    }
  }
  /* Shared carriageways: where two corridors run on the same real road (the
     Sion–Panvel Highway along Thane–Belapur Road, the Coastal Road and its
     approaches) the higher-class one is drawn and the other link is marked
     as a duplicate — still routable, just not painted twice. */
  { const RK = { expressway: 4, bridge: 3, arterial: 2, link: 1 };
    const EG2 = new Map(), C2 = 300;
    for (const e of roadEdges) { const A = nodes[e.a], B = nodes[e.b]; const k = Math.floor((A.x + B.x) / 2 / C2) + ':' + Math.floor((A.y + B.y) / 2 / C2); (EG2.get(k) || EG2.set(k, []).get(k)).push(e); }
    for (const e of roadEdges) {
      const A = nodes[e.a], B = nodes[e.b], mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, L = e.len || 1, ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      const gx = Math.floor(mx / C2), gy = Math.floor(my / C2);
      for (let i = gx - 1; i <= gx + 1 && !e.dup; i++) for (let j = gy - 1; j <= gy + 1 && !e.dup; j++) for (const f of EG2.get(i + ':' + j) || []) {
        if (f === e || f.roadId === e.roadId || f.dup) continue;
        const C = nodes[f.a], D = nodes[f.b];
        if (geo.distToSeg(mx, my, C.x, C.y, D.x, D.y) > 22) continue;
        const fl = f.len || 1; if (Math.abs(ux * (D.x - C.x) / fl + uy * (D.y - C.y) / fl) < 0.9) continue;
        if ((!!e.bridge) !== (!!f.bridge) || (!!e.tunnel) !== (!!f.tunnel)) continue;
        const re = RK[e.cls] || 1, rf = RK[f.cls] || 1;
        if (re < rf || (re === rf && e.road > f.road)) { e.dup = f.roadId; break; }
      }
    }
    city.dupKm = roadEdges.reduce((s2, e) => s2 + (e.dup ? e.len : 0), 0) / 1000;
  }
  city.crossings = { rail: railX, road: roadX };
  city.graph = { nodes, edges };
  /* bridge towers (cable-stayed spans) */
  city.bridgeTowers = [];
  MT.ROADS.forEach(r => (r.towers || []).forEach(t => {
    const path = geo.pathXY(r.path);
    const x0 = geo.x(t.lon), y0 = geo.y(t.lat); let x = x0, y = y0;
    /* deck direction at the tower, from the nearest path segment */
    let best = Infinity, hx = 1, hy = 0;
    for (let i = 0; i + 3 < path.length; i += 2) {
      const d = geo.distToSeg(x0, y0, path[i], path[i + 1], path[i + 2], path[i + 3]);
      if (d < best) { best = d; const L = Math.hypot(path[i + 2] - path[i], path[i + 3] - path[i + 1]) || 1; hx = (path[i + 2] - path[i]) / L; hy = (path[i + 3] - path[i + 1]) / L;
        /* stand the tower on the deck centreline: the path may be real (OSM) geometry now */
        const t2 = Math.max(0, Math.min(1, ((x0 - path[i]) * (path[i + 2] - path[i]) + (y0 - path[i + 1]) * (path[i + 3] - path[i + 1])) / (L * L)));
        x = path[i] + (path[i + 2] - path[i]) * t2; y = path[i + 1] + (path[i + 3] - path[i + 1]) * t2; }
    }
    city.bridgeTowers.push({ road: r.id, name: r.name, x, y, h: t.h, hx, hy, deckZ: 22, halfW: 16 });
  }));
  /* landmark tags that name a bridge sit on that bridge's (real) deck */
  city.__snapLandmarks = () => {
    const pairs = [['Bandra–Worli Sea Link', 'BWSL'], ['Atal Setu', 'MTHL']];
    for (const [nm, rid] of pairs) {
      const L = city.landmarks.find(l => l.name.startsWith(nm)), r = MT.ROADS.find(r => r.id === rid); if (!L || !r) continue;
      const path = geo.pathXY(r.path); let best = Infinity;
      for (let i = 0; i + 3 < path.length; i += 2) {
        const dx = path[i + 2] - path[i], dy = path[i + 3] - path[i + 1], L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((L.x - path[i]) * dx + (L.y - path[i + 1]) * dy) / L2)), px = path[i] + dx * t, py = path[i + 1] + dy * t;
        const d = Math.hypot(px - L.x, py - L.y); if (d < best) { best = d; L.sx = px; L.sy = py; }
      }
      if (L.sx !== undefined) { L.x = L.sx; L.y = L.sy; }
    }
  };
  /* roundabouts: snap each known circle to the nearest at-grade road junction */
  city.circles = [];
  for (const c of (MT.CIRCLES || [])) {
    const x0 = geo.x(c.lon), y0 = geo.y(c.lat); let best = null, bd = 150;
    for (const N of nodes) { if (!N.edges.some(id => edges[id].road >= 0 && !edges[id].bridge && !edges[id].tunnel)) continue;
      const d = Math.hypot(N.x - x0, N.y - y0); if (d < bd) { bd = d; best = N; } }
    if (!best) continue;
    /* where two roads end close together, centre the circle between them so it joins both */
    const cl = nodes.filter(N => Math.hypot(N.x - best.x, N.y - best.y) < 80 && N.edges.some(id => edges[id].road >= 0 && !edges[id].bridge));
    const ends = cl.filter(N => N.edges.filter(id => edges[id].road >= 0).length === 1 || new Set(N.edges.map(id => edges[id].roadId)).size > 1);
    const S = ends.length >= 2 ? ends : [best];
    const cx = S.reduce((a, N) => a + N.x, 0) / S.length, cy = S.reduce((a, N) => a + N.y, 0) / S.length;
    city.circles.push({ name: c.name, x: cx, y: cy, r: Math.max(c.r, ...S.map(N => Math.hypot(N.x - cx, N.y - cy) + 20)) });
  }
  city.nodeIndex = new geo.PointIndex(nodes.map((n, i) => ({ x: n.x, y: n.y, i })), 700);
  city.roadKm = edges.reduce((s, e) => s + (e.road >= 0 ? e.len : 0), 0) / 1000;

  /* --------------------------------------------------------------- places */
  function pt(o, extra) {
    return Object.assign({ x: geo.x(o.lon), y: geo.y(o.lat), lon: o.lon, lat: o.lat }, o, extra || {});
  }
  city.hospitals = MT.HOSPITALS.map((h, i) => pt(h, { id: 'HOS' + (i + 1), cat: 'hospital' }));
  city.fire = MT.FIRE.map((h, i) => pt(h, { id: 'FIR' + (i + 1), cat: 'fire' }));
  city.banks = (MT.BANKS || []).map((h, i) => pt(h, { id: 'BNK' + (i + 1), cat: 'bank' }));
  city.placeNames = (MT.PLACE_NAMES || []).map(q => ({ name: q.name, kind: q.kind, x: geo.x(q.lon), y: geo.y(q.lat) }));
  city.landmarks = MT.LANDMARKS.map((h, i) => pt(h, { id: 'LMK' + (i + 1), cat: 'landmark' }));
  city.__snapLandmarks();
  city.projects = MT.PROJECTS.map((p, i) => pt(p, { id: 'PRJ' + (i + 1), cat: 'project' }));

  /* Rail & metro stations. An interchange (Dadar, Kurla, Thane, Kalyan…)
     appears on several line lists but is one station: merge by name when the
     positions agree, and keep every line that calls there. */
  /* platform sites: every station vertex on each suburban line, with the
     track direction there (drawn as island platforms in the bed) */
  city.platforms = [];
  MT.RAIL.forEach(line => {
    const q = city.railXY[line.id], st = city.railStop && city.railStop[line.id], Z = city.railZ && city.railZ[line.id];
    if (!q || !st) return;
    for (let i = 0; i < q.length / 2; i++) {
      if (!st[i]) continue;
      const i0 = Math.max(0, i - 1), i1 = Math.min(q.length / 2 - 1, i + 1);
      const dx = q[i1 * 2] - q[i0 * 2], dy = q[i1 * 2 + 1] - q[i0 * 2 + 1], L = Math.hypot(dx, dy) || 1;
      if (city.platforms.some(p => Math.hypot(p.x - q[i * 2], p.y - q[i * 2 + 1]) < 120)) continue;
      city.platforms.push({ x: q[i * 2], y: q[i * 2 + 1], hx: dx / L, hy: dy / L, z: Z ? Z[i] : 5, color: line.color });
    }
  });
  city.stations = [];
  const railByName = new Map();
  MT.RAIL.forEach(line => line.stations.forEach(s => {
    const prev = railByName.get(s.name);
    if (prev && Math.hypot(geo.x(s.lon) - prev.x, geo.y(s.lat) - prev.y) < 600) {
      const short = line.name.replace(/ \(.*\)$/, '');
      if (!prev.lines.includes(short)) { prev.lines.push(short); prev.line = prev.lines.join(' · '); }
      return;
    }
    const st = pt(s, { id: 'STN-' + line.id + '-' + s.name.replace(/\W/g, ''), cat: 'rail',
      line: line.name.replace(/ \(.*\)$/, ''), lines: [line.name.replace(/ \(.*\)$/, '')], lineId: line.id, color: line.color });
    railByName.set(s.name, st);
    city.stations.push(st);
  }));
  MT.METRO.forEach(line => line.stations.forEach(s => city.stations.push(
    pt(s, { id: 'MET-' + line.id + '-' + s.name.replace(/\W/g, ''), cat: 'metro', line: line.name, lineId: line.id, color: line.color, status: line.status })
  )));
  city.metroStations = city.stations.filter(s => s.cat === 'metro');
  city.railStations = city.stations.filter(s => s.cat === 'rail');

  /* Police and education are SIMULATED point sets — no verified register.    */
  const prng = rngFrom(SEED + 31);
  function scatter(count, cat, prefix, namer) {
    const out = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 60) {
      const L = locs[Math.floor(prng() * locs.length)];
      const a = prng() * Math.PI * 2, rr = Math.sqrt(prng()) * L.r * 1.2;
      const x = L.x + Math.cos(a) * rr, y = L.y + Math.sin(a) * rr;
      const k = city.cellIndex(x, y);
      if (k < 0 || !land[k] || water[k] || green[k]) continue;
      out.push({
        id: prefix + (out.length + 1), cat, x, y,
        lon: geo.lon(x), lat: geo.lat(y),
        name: namer(out.length + 1, L), area: L.name, simulated: true
      });
    }
    return out;
  }
  city.schools = scatter(180, 'school', 'SCH', (i, L) => 'School site ' + i + ' · ' + L.name);
  city.police = scatter(48, 'police', 'POL', (i, L) => 'Police post ' + i + ' · ' + L.name);

  /* ------------------------------------------------------------- buildings */
  const brng = rngFrom(SEED + 101);
  const buildings = [];
  const USES = [
    ['Residential', 0.60], ['Commercial', 0.17], ['Mixed use', 0.12],
    ['Industrial', 0.06], ['Institutional', 0.05]
  ];
  function pickUse(r) { let a = 0; for (const [u, p] of USES) { a += p; if (r < a) return u; } return 'Residential'; }
  const ERA_YEARS = {
    old:      [[1900, .30], [1960, .35], [1990, .20], [2010, .12], [2020, .03]],
    mixed:    [[1960, .18], [1990, .30], [2010, .30], [2020, .22]],
    new:      [[1990, .18], [2005, .28], [2015, .32], [2022, .22]],
    informal: [[1970, .30], [1990, .35], [2005, .25], [2015, .10]]
  };
  function pickYear(era, r) {
    const t = ERA_YEARS[era] || ERA_YEARS.mixed; let a = 0;
    for (const [y, p] of t) { a += p; if (r < a) return y + Math.floor(brng() * 9); }
    return 2000;
  }

  /* Footprint shapes. Winding is counter-clockwise throughout so the renderer
     can take (ey, -ex) as the outward normal of every edge. */
  function footprint(w, d, shape) {
    const hw = w / 2, hd = d / 2;
    if (shape === 1) {                       // chamfered — reads as a tower
      const c = Math.min(hw, hd) * 0.3;
      return [-hw + c, -hd, hw - c, -hd, hw, -hd + c, hw, hd - c,
              hw - c, hd, -hw + c, hd, -hw, hd - c, -hw, -hd + c];
    }
    if (shape === 2) {                       // L-shaped block
      const nx = -hw + w * 0.42, ny = -hd + d * 0.46;
      return [-hw, -hd, hw, -hd, hw, ny, nx, ny, nx, hd, -hw, hd];
    }
    if (shape === 3) {                       // slab with a clipped corner
      const c = Math.min(hw, hd) * 0.55;
      return [-hw, -hd, hw - c, -hd, hw, -hd + c, hw, hd, -hw, hd];
    }
    return [-hw, -hd, hw, -hd, hw, hd, -hw, hd];
  }

  /* ---- right of way -------------------------------------------------------
     Nothing gets built on a carriageway or a track. Every road link and every
     surface rail alignment is inserted into a coarse segment grid with a
     half-width, and a candidate footprint is rejected if it would overlap one.
     Metro Line 3 is excluded from the test because it runs underground — the
     city above it is real, and carving a gap through Girgaon would be wrong. */
  const ROW_CELL = 400;
  const rowGrid = new Map();
  function rowAdd(ax, ay, bx, by, halfW) {
    const i0 = Math.floor((Math.min(ax, bx) - halfW) / ROW_CELL);
    const i1 = Math.floor((Math.max(ax, bx) + halfW) / ROW_CELL);
    const j0 = Math.floor((Math.min(ay, by) - halfW) / ROW_CELL);
    const j1 = Math.floor((Math.max(ay, by) + halfW) / ROW_CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = i + ':' + j;
      let arr = rowGrid.get(key);
      if (!arr) { arr = []; rowGrid.set(key, arr); }
      arr.push(ax, ay, bx, by, halfW);
    }
  }
  const ROAD_HALF = { expressway: 46, arterial: 34, link: 24, bridge: 40 };   // matches the wider drawn roads
  for (const e of edges) {
    if (e.road < 0) continue;                      // synthetic local connectors
    if (e.tunnel) continue;                        // underground: the ground above stays built up
    rowAdd(nodes[e.a].x, nodes[e.a].y, nodes[e.b].x, nodes[e.b].y, ROAD_HALF[e.cls] || 16);
  }
  function rowAddPath(pts, halfW) {
    for (let i = 0; i < pts.length - 2; i += 2) rowAdd(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], halfW);
  }
  MT.RAIL.forEach(l => rowAddPath(city.railXY2D[l.id], 30));   // bed + embankment + a margin
  MT.METRO.forEach(l => {
    if (l.id === 'M3') return;                     // underground
    rowAddPath(city.railXY2D[l.id], 18);
  });
  function onRightOfWay(x, y, r) {
    const i0 = Math.floor((x - r) / ROW_CELL), i1 = Math.floor((x + r) / ROW_CELL);
    const j0 = Math.floor((y - r) / ROW_CELL), j1 = Math.floor((y + r) / ROW_CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = rowGrid.get(i + ':' + j);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k += 5) {
        if (geo.distToSeg(x, y, arr[k], arr[k + 1], arr[k + 2], arr[k + 3]) < arr[k + 4] + r) return true;
      }
    }
    return false;
  }
  city.onRightOfWay = onRightOfWay;
  /* Bank and exchange markers sit at their real addresses, some of which are
     right beside the tracks; nudge any that fall on a road or the rail bed
     to the nearest clear spot (at most a few hundred metres). */
  for (const B of city.banks) {
    if (!onRightOfWay(B.x, B.y, 14)) continue;
    let done = false;
    for (let rad = 15; rad <= 300 && !done; rad += 15) for (let a = 0; a < 16 && !done; a++) {
      const th = a / 16 * Math.PI * 2, x = B.x + Math.cos(th) * rad, y = B.y + Math.sin(th) * rad;
      if (!onRightOfWay(x, y, 14) && city.isLand(x, y)) { B.x = x; B.y = y; done = true; }
    }
  }

  /* Buildings are sampled from the density surface itself rather than scattered
     around locality centroids, so the fabric stays continuous between centres —
     which is how the city actually reads — while height and use still follow
     the locality profile. */
  /* Airport: no buildings on the airfield, and heights capped under each
     runway's approach funnel — 25 m at the threshold, rising 1 m in 40 along
     the approach and 1 m in 7 sideways out of a 600 m-wide core. The slopes
     are illustrative, not the published obstacle-limitation surfaces. */
  const toRunway = r => {
    const ax = geo.x(r.a[0]), ay = geo.y(r.a[1]), bx = geo.x(r.b[0]), by = geo.y(r.b[1]);
    const L = Math.hypot(bx - ax, by - ay);
    return { id: r.id, ax, ay, bx, by, L, ux: (bx - ax) / L, uy: (by - ay) / L, width: r.width, taxiSide: r.taxiSide || 1 };
  };
  city.airports = (MT.AIRPORTS || (MT.AIRPORT ? [MT.AIRPORT] : [])).map(A => ({
    id: A.id, name: A.name, site: geo.pathXY(A.site), runways: A.runways.map(toRunway),
    terminals: (A.terminals || []).map(t => ({ ...t, x: geo.x(t.lon), y: geo.y(t.lat), rotR: t.rot * Math.PI / 180 })),
    tower: A.tower ? { ...A.tower, x: geo.x(A.tower.lon), y: geo.y(A.tower.lat) } : null
  }));
  city.airport = city.airports[0] || null;           // the airport the air tracks serve
  const airfields = city.airports.map(A => A.site);
  const airfield = airfields.length ? { some: (x, y) => airfields.some(f => geo.inRing(f, x, y)) } : null;
  const runways = city.airports.flatMap(A => A.runways);
  function funnelCap(x, y) {
    let cap = Infinity;
    for (const r of runways) {
      const t = (x - r.ax) * r.ux + (y - r.ay) * r.uy;              // along the runway axis
      const lat = Math.abs((x - r.ax) * -r.uy + (y - r.ay) * r.ux);  // off the axis
      const beyond = t < 0 ? -t : t > r.L ? t - r.L : 0;
      if (beyond > 9000 || lat > 3000) continue;
      cap = Math.min(cap, 25 + beyond / 40 + Math.max(0, lat - 300) / 7);
    }
    return cap;
  }
  /* occupancy grid of accepted footprints (oriented rectangles) */
  const OCC = 120, occ = new Map();
  function obb(x, y, hw, hd, rot) {
    const c = Math.cos(rot), s2 = Math.sin(rot);
    return { x, y, hw, hd, ux: c, uy: s2, vx: -s2, vy: c, R: Math.hypot(hw, hd) };
  }
  function separated(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    for (const [ax, ay] of [[a.ux, a.uy], [a.vx, a.vy], [b.ux, b.uy], [b.vx, b.vy]]) {
      const ra = a.hw * Math.abs(a.ux * ax + a.uy * ay) + a.hd * Math.abs(a.vx * ax + a.vy * ay);
      const rb = b.hw * Math.abs(b.ux * ax + b.uy * ay) + b.hd * Math.abs(b.vx * ax + b.vy * ay);
      if (Math.abs(dx * ax + dy * ay) > ra + rb) return true;
    }
    return false;
  }
  function occupied(x, y, hw, hd, rot) {
    const a = obb(x, y, hw, hd, rot), reach = a.R + 90;
    const i0 = Math.floor((x - reach) / OCC), i1 = Math.floor((x + reach) / OCC);
    const j0 = Math.floor((y - reach) / OCC), j1 = Math.floor((y + reach) / OCC);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = occ.get(i + ':' + j); if (!list) continue;
      for (const b of list) {
        if (Math.hypot(b.x - x, b.y - y) > a.R + b.R) continue;
        if (!separated(a, b)) return true;
      }
    }
    return false;
  }
  function occupy(x, y, hw, hd, rot) {
    const k = Math.floor(x / OCC) + ':' + Math.floor(y / OCC);
    if (!occ.has(k)) occ.set(k, []);
    occ.get(k).push(obb(x, y, hw, hd, rot));
  }
  const GM_SECTORS = new Set(['Island City', 'Western Suburbs', 'Eastern Suburbs']);
  const cellW = new Float64Array(GW * GH);
  let wAcc = 0;
  for (let k = 0; k < GW * GH; k++) {
    let w = 0;
    if (land[k] && !water[k] && !green[k]) {
      /* the small floor that keeps fabric continuous between centres applies
         only around a settlement — open mainland (farmland, salt pans,
         hills) stays open rather than being sprinkled with buildings */
      const L = locs[zoneOf[k]], c = city.cellCentre(k);
      const near = L && Math.hypot(c.x - L.x, c.y - L.y) < L.r * 2.4;
      w = Math.pow(density[k], 1.3) + (near ? 0.016 : 0);
      if (L && !GM_SECTORS.has(L.sector)) w *= 0.95;   // the region's towns, a touch less dense than the core
    }
    wAcc += w;
    cellW[k] = wAcc;
  }
  /* exact water test, used only along coasts, lake shores and river banks */
  const nearWaterCache = new Int8Array(GW * GH).fill(-1);
  function nearWater(k) {
    if (nearWaterCache[k] >= 0) return nearWaterCache[k] === 1;
    const i = k % GW, j = (k / GW) | 0; let f = 0;
    for (let dj = -1; dj <= 1 && !f; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) { f = 1; break; }
      const q = jj * GW + ii;
      if (!land[q] || water[q]) { f = 1; break; }
    }
    nearWaterCache[k] = f; return f === 1;
  }
  function wetPoint(x, y) {
    if (!city.isLand(x, y)) return true;
    for (const l of lakes) { const dx = (x - l.x) / l.rx, dy = (y - l.y) / l.ry; if (dx * dx + dy * dy < 1.02) return true; }
    for (const r of rivers) if (geo.distToPath(r.path, x, y) < r.w / 2 + 6) return true;
    return false;
  }
  function dryFootprint(x, y, hw, hd, rot) {
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const P = [[0, 0], [hw, hd], [hw, -hd], [-hw, hd], [-hw, -hd], [hw, 0], [-hw, 0], [0, hd], [0, -hd]];
    for (const [lx, ly] of P) if (wetPoint(x + lx * cr - ly * sr, y + lx * sr + ly * cr)) return false;
    return true;
  }
  /* Scaled with the land modelled: Greater Mumbai carried 8,600 on its own. */
  const TOTAL_BUILDINGS = 18000;
  let bid = 1;
  let attempts = 0;
  while (buildings.length < TOTAL_BUILDINGS && attempts < TOTAL_BUILDINGS * 40) {
    attempts++;
    const r = brng() * wAcc;
    let lo = 0, hi = GW * GH - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cellW[mid] < r) lo = mid + 1; else hi = mid; }
    const k = lo;
    const zi = zoneOf[k];
    if (zi < 0 || !land[k]) continue;
    const L = locs[zi];
    const c = city.cellCentre(k);
    const x = c.x + (brng() - 0.5) * CELL * 0.96;
    const y = c.y + (brng() - 0.5) * CELL * 0.96;

    const use = pickUse(brng());
    const dens = density[k];
    /* Bimodal by design: most of the stock is low-rise, but a real minority
       are genuine towers, which is what gives a skyline its shape. A single
       power-law leaves everything stubby. */
    const towerRoll = brng();
    const towerChance = 0.07 + 0.17 * dens + (L.towerBias || 0);   // tower districts (Ghodbunder, Kharghar…)
    const tall = towerRoll < towerChance
      ? 0.66 + 0.34 * brng()
      : Math.pow(brng(), 2.4) * (0.45 + 0.75 * dens);
    let h = L.hMin + tall * (L.hMax - L.hMin);
    if (use === 'Industrial') h = Math.min(h, 22);
    if (L.era === 'informal') h = Math.min(h, 12);
    if (runways.length) { const cap = funnelCap(x, y); if (h > cap) h = Math.max(6, cap); }
    const floors = Math.max(1, Math.round(h / 3.1));
    const big = use === 'Industrial' || use === 'Commercial';
    /* footprints drawn ~20% larger than typical plots so blocks read at city scale */
    const w = ((big ? 48 : 25) + brng() * (big ? 78 : 40)) * 1.2;
    const d = ((big ? 41 : 21) + brng() * (big ? 62 : 34)) * 1.2;
    const rot = brng() * Math.PI;
    /* keep the carriageway and the permanent way clear — measured to the
       footprint's corners, not the middle of its sides, so a rotated block
       cannot poke a corner onto the road */
    if (onRightOfWay(x, y, Math.hypot(w, d) / 2)) continue;
    /* and never on top of another building: exact test on the rotated
       footprints, with a few metres of clear ground between neighbours */
    if (occupied(x, y, w / 2 + 2, d / 2 + 2, rot)) continue;
    if (airfield && airfield.some(x, y)) continue;
    /* On a cell that touches the sea, a lake or a river, the cell being
       "land" at its centre is not enough: every corner of the footprint
       (plus a few metres of shore) must be on land and clear of water. */
    if (nearWater(k) && !dryFootprint(x, y, w / 2 + 6, d / 2 + 6, rot)) continue;

    /* Form follows height: towers get chamfered corners and a podium
       setback, mid-rise gets the occasional L-plan, the rest stay slabs. */
    let shape = 0;
    const rs = brng();
    if (h > 52) shape = rs < 0.72 ? 1 : 0;
    else if (h > 22) shape = rs < 0.22 ? 2 : rs < 0.32 ? 3 : 0;
    else shape = rs < 0.12 ? 3 : 0;
    const wantPodium = h > 58 && shape !== 2 && brng() < 0.66;

    occupy(x, y, w / 2 + 2, d / 2 + 2, rot);
    buildings.push({
      id: 'MT-B-' + String(bid).padStart(5, '0'),
      x, y, w, d, rot, h, floors, use,
      shape, poly: footprint(w, d, shape),
      podH: wantPodium ? h * (0.10 + brng() * 0.16) : 0,
      tScale: wantPodium ? 0.62 + brng() * 0.18 : 1,
      tint: brng(),
      zone: zi, year: pickYear(L.era, brng()),
      area: Math.round(w * d), elev: elev[k]
    });
    bid++;
  }

  /* Building twins. Each target point is moved outward, ring by ring, to the
     first plot that is land (not park, not water), clear of every road and
     rail corridor. The generated buildings on that plot are removed, and the
     twin is turned square to its nearest road, as a real plot would be. */
  const onPlainLand = (x, y) => {
    const k = city.cellIndex(x, y);
    return k >= 0 && land[k] === 1 && !green[k] && !water[k];
  };
  city.twins = [];
  for (const T of (MT.BUILDING_TWINS || [])) {
    const R = Math.hypot(T.w, T.d) / 2 + 16;             // footprint plus a plaza
    const tx = geo.x(T.lon), ty = geo.y(T.lat);
    let site = null;
    for (let ring = 0; ring <= 40 && !site; ring++) {
      const rad = ring * 40, nA = ring === 0 ? 1 : 10 + ring * 2;
      for (let a = 0; a < nA && !site; a++) {
        const th = a / nA * Math.PI * 2 + ring * 0.37;
        const x = tx + Math.cos(th) * rad, y = ty + Math.sin(th) * rad;
        if (!onPlainLand(x, y) || onRightOfWay(x, y, R)) continue;
        let ok = true;
        for (let c = 0; c < 8 && ok; c++) {
          const ca = c / 8 * Math.PI * 2;
          ok = onPlainLand(x + Math.cos(ca) * R, y + Math.sin(ca) * R);
        }
        if (ok && city.twins.every(o => Math.hypot(o.x - x, o.y - y) > 400)) site = { x, y };
      }
    }
    if (!site) continue;
    let rot = 0, best = 1e9;
    for (const e of edges) {
      if (e.road < 0) continue;
      const A = nodes[e.a], B = nodes[e.b];
      const dd = geo.distToSeg(site.x, site.y, A.x, A.y, B.x, B.y);
      if (dd < best) { best = dd; rot = Math.atan2(B.y - A.y, B.x - A.x); }
    }
    for (let i = buildings.length - 1; i >= 0; i--) {
      const b = buildings[i];
      if (Math.hypot(b.x - site.x, b.y - site.y) < R + Math.max(b.w, b.d) * 0.55) buildings.splice(i, 1);
    }
    const k = city.cellIndex(site.x, site.y);
    city.twins.push({
      id: T.id, area: T.area, floors: T.floors, w: T.w, d: T.d,
      x: site.x, y: site.y, rot, plaza: R, elev: k >= 0 ? elev[k] : 0,
      moved: Math.round(Math.hypot(site.x - tx, site.y - ty))
    });
  }

  /* heritage monuments: clear the generated fabric off their plots */
  city.monuments = (MT.MONUMENTS || []).map(M => ({ ...M, x: geo.x(M.lon), y: geo.y(M.lat), rotR: M.rot * Math.PI / 180 }));
  for (const M of city.monuments) {
    const R = Math.hypot(M.w, M.d) / 2 + 22;
    for (let i = buildings.length - 1; i >= 0; i--) {
      const b = buildings[i];
      if (Math.hypot(b.x - M.x, b.y - M.y) < R + Math.hypot(b.w, b.d) / 2) buildings.splice(i, 1);
    }
  }

  city.buildings = buildings;
  city.buildingIndex = new geo.PointIndex(buildings, 600);
  city.builtArea = buildings.reduce((s, b) => s + b.area, 0);

  /* zone rollups ---------------------------------------------------------- */
  city.zones = locs.map((L, i) => {
    const z = {
      i, name: L.name, sector: L.sector, x: L.x, y: L.y, lon: L.lon, lat: L.lat,
      cells: 0, greenCells: 0, waterCells: 0, densitySum: 0,
      buildings: 0, builtArea: 0, floors: 0, roadM: 0,
      hospitals: 0, schools: 0, fire: 0, metro: 0, rail: 0, elevSum: 0, lowCells: 0
    };
    return z;
  });
  for (let k = 0; k < GW * GH; k++) {
    const z = zoneOf[k]; if (z < 0) continue;
    const Z = city.zones[z];
    Z.cells++; Z.densitySum += density[k]; Z.elevSum += elev[k];
    if (green[k]) Z.greenCells++;
    if (water[k]) Z.waterCells++;
    if (elev[k] < 4) Z.lowCells++;
  }
  buildings.forEach(b => { const Z = city.zones[b.zone]; if (Z) { Z.buildings++; Z.builtArea += b.area; Z.floors += b.floors; } });
  function assignZone(list, key) {
    list.forEach(p => {
      const k = city.cellIndex(p.x, p.y); if (k < 0) return;
      const z = zoneOf[k]; if (z < 0) return;
      p.zone = z; city.zones[z][key]++;
    });
  }
  assignZone(city.hospitals, 'hospitals');
  assignZone(city.schools, 'schools');
  assignZone(city.fire, 'fire');
  assignZone(city.metroStations, 'metro');
  assignZone(city.railStations, 'rail');
  edges.forEach(e => {
    if (e.road < 0) return;
    const mx = (nodes[e.a].x + nodes[e.b].x) / 2, my = (nodes[e.a].y + nodes[e.b].y) / 2;
    const k = city.cellIndex(mx, my); if (k < 0) return;
    const z = zoneOf[k]; if (z >= 0) city.zones[z].roadM += e.len;
  });
  city.zones.forEach(Z => {
    Z.areaKm2 = Z.cells * CELL * CELL / 1e6;
    Z.densityIdx = Z.cells ? Z.densitySum / Z.cells : 0;
    Z.greenPct = Z.cells ? Z.greenCells / Z.cells * 100 : 0;
    Z.builtPct = Z.areaKm2 ? (Z.builtArea / 1e6) / Z.areaKm2 * 100 : 0;
    Z.roadDensity = Z.areaKm2 ? (Z.roadM / 1000) / Z.areaKm2 : 0;
    Z.meanElev = Z.cells ? Z.elevSum / Z.cells : 0;
    Z.lowPct = Z.cells ? Z.lowCells / Z.cells * 100 : 0;
  });

  /* transit accessibility: share of the zone's cells within 800 m of a       */
  /* metro or suburban station — a standard planning catchment.               */
  const stIdx = new geo.PointIndex(city.stations, 800);
  const metIdx = new geo.PointIndex(city.metroStations, 800);
  const hosIdx = new geo.PointIndex(city.hospitals, 1500);
  city.stationIndex = stIdx; city.metroIndex = metIdx; city.hospitalIndex = hosIdx;

  const served = new Uint8Array(GW * GH);
  const metroServed = new Uint8Array(GW * GH);
  for (let k = 0; k < GW * GH; k++) {
    if (!land[k]) continue;
    const c = city.cellCentre(k);
    served[k] = stIdx.within(c.x, c.y, 800).length ? 1 : 0;
    metroServed[k] = metIdx.within(c.x, c.y, 1000).length ? 1 : 0;
  }
  city.transitServed = served; city.metroServed = metroServed;
  city.zones.forEach(Z => { Z.servedCells = 0; Z.metroCells = 0; });
  for (let k = 0; k < GW * GH; k++) {
    const z = zoneOf[k]; if (z < 0) continue;
    if (served[k]) city.zones[z].servedCells++;
    if (metroServed[k]) city.zones[z].metroCells++;
  }
  city.zones.forEach(Z => {
    Z.transitPct = Z.cells ? Z.servedCells / Z.cells * 100 : 0;
    Z.metroPct = Z.cells ? Z.metroCells / Z.cells * 100 : 0;
  });

  /* search corpus --------------------------------------------------------- */
  city.searchables = []
    .concat(locs.map(l => ({ name: l.name, kind: 'Area', sub: l.sector, x: l.x, y: l.y, zoom: 6500 })))
    .concat(city.landmarks.map(l => ({ name: l.name, kind: 'Landmark', sub: l.kind, x: l.x, y: l.y, zoom: l.kind === 'heritage' ? 700 : 3200 })))
    .concat(city.hospitals.map(h => ({ name: h.name, kind: 'Hospital', sub: h.area, x: h.x, y: h.y, zoom: 2200, ref: h })))
    .concat(city.fire.map(h => ({ name: h.name, kind: 'Fire station', sub: '', x: h.x, y: h.y, zoom: 2200, ref: h })))
    .concat(city.banks.map(h => ({ name: h.name, kind: 'Bank HQ', sub: h.kind, x: h.x, y: h.y, zoom: 1800, ref: h })))
    .concat(city.metroStations.map(s => ({ name: s.name + ' (Metro)', kind: 'Metro station', sub: s.line, x: s.x, y: s.y, zoom: 2000, ref: s })))
    .concat(city.railStations.map(s => ({ name: s.name + ' (Rail)', kind: 'Railway station', sub: s.line, x: s.x, y: s.y, zoom: 2000, ref: s })))
    .concat(MT.ROADS.map(r => {
      const p = geo.pathXY(r.path);
      return { name: r.name, kind: 'Road', sub: r.cls, x: p[Math.floor(p.length / 4) * 2], y: p[Math.floor(p.length / 4) * 2 + 1], zoom: 5200 };
    }))
    .concat(city.projects.map(p => ({ name: p.name, kind: 'Project', sub: p.status, x: p.x, y: p.y, zoom: 5200, ref: p })));

  /* de-duplicate station names that appear on several lines */
  const seen = new Set();
  city.searchables = city.searchables.filter(s => {
    const k = s.kind + '|' + s.name;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  /* Dataset coverage lines are written from the model, so they cannot drift
     from what is actually built (they used to be hand-typed and fell behind). */
  const DS = id => MT.DATASETS.find(d => d.id === id) || {};
  const nRoads = MT.ROADS.length;
  DS('roads').coverage = nRoads + ' arterial corridors (' + Math.round(city.roadKm) + ' km) — not the full street network';
  DS('health').coverage = city.hospitals.length + ' major facilities. Not an exhaustive register';
  DS('fire').coverage = city.fire.length + ' stations — indicative subset';
  DS('projects').coverage = city.projects.length + ' major projects';
  DS('buildings').coverage = '~' + (Math.round(city.buildings.length / 100) * 100).toLocaleString('en-IN') +
    ' synthetic structures across ' + city.zones.length + ' analysis zones';
  DS('movement').coverage = 'Arterial graph, ' + (MT.RAIL.length + MT.METRO.length) + ' rail/metro lines and branches, ' +
    MT.AIRTRACKS.length + ' air tracks, ' + MT.SEATRACKS.length + ' sea tracks';
  DS('building_twins').coverage = (city.twins || []).length + ' demonstration sites in commercial districts';

  city.rngFrom = rngFrom;
  MT.city = city;
})(window.MT);
