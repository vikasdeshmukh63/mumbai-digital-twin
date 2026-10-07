/* ============================================================================
   sim.js — the analysis and scenario engines.

   Every function here returns SIMULATION OUTPUT. Each result carries a
   `method` block stating the model, its parameters and its limitations, which
   the UI renders alongside the numbers. No result is presented as observation.
   ========================================================================== */
(function (MT) {
  'use strict';
  const geo = MT.geo, city = MT.city, G = city.graph;
  const sim = MT.sim = {};

  /* ======================================================= FLOOD SIMULATION */
  /*
     Lumped rainfall–runoff–ponding model on the 200 m analysis grid.

       excess_mm   = max(0, intensity_mm_h − drainage_mm_h) × duration_h
       ponding_m   = excess_m × imperviousness × (0.25 + 8 × depression²)
       coastal_m   = max(0, (tide_m − 2.0) + 0.3 − ground_elev)  within 700 m of water

     depression is the cell's depth below its 1 km neighbourhood mean, so water
     collects where the synthetic terrain dips. This is a screening model, not
     a hydraulic one: no routing between cells, no sewer network, no river
     stage. It exists to demonstrate the workflow, not to size infrastructure.
  */
  sim.flood = function (p) {
    const rain = p.rain, hours = p.hours, tide = p.tide, eff = p.drainEff;
    const N = city.grid.w * city.grid.h;
    const depth = new Float32Array(N);
    const intensity = rain / hours;
    const baseCap = 28 * eff;                                   // mm/h, tunable
    const tideChoke = 1 - 0.55 * Math.max(0, Math.min(1, (tide - 1.4) / 2.6));
    const cap = baseCap * tideChoke;
    const excess_m = Math.max(0, intensity - cap) * hours / 1000;

    let cells = 0, sum = 0, maxD = 0;
    const classes = [0, 0, 0, 0];   // <0.15 / 0.15-0.3 / 0.3-0.6 / >0.6
    for (let k = 0; k < N; k++) {
      if (!city.land[k]) continue;
      const dens = city.density[k];
      const imperv = city.green[k] ? 0.22 : (dens > 0.45 ? 0.93 : dens > 0.2 ? 0.74 : 0.5);
      const dep = city.depression[k];
      let d = excess_m * imperv * (0.25 + 8 * dep * dep);
      /* tide only surcharges the coastal fringe once it passes normal high water */
      if (city.coastDist[k] < 700) {
        const sea = (tide - 2.0) + 0.3 - city.elev[k];
        if (sea > 0) d = Math.max(d, Math.min(sea, 2.4));
      }
      if (city.waterMask[k]) d = Math.max(d, 0.8);
      if (d > 0.10) {
        depth[k] = d; cells++; sum += d; if (d > maxD) maxD = d;
        classes[d < 0.15 ? 0 : d < 0.3 ? 1 : d < 0.6 ? 2 : 3]++;
      }
    }

    /* impacts ------------------------------------------------------------ */
    const cellArea = city.grid.cell * city.grid.cell / 1e6;
    const res = {
      params: { rain, hours, tide, eff },
      depth, cells, areaKm2: cells * cellArea, maxDepth: maxD,
      meanDepth: cells ? sum / cells : 0,
      classes, classAreas: classes.map(c => c * cellArea),
      intensity, capacity: cap, excess_mm: excess_m * 1000,
      at: new Date().toISOString()
    };

    let bAff = 0, bSevere = 0;
    for (const b of city.buildings) {
      const k = city.cellIndex(b.x, b.y);
      if (k < 0) continue;
      const d = depth[k];
      if (d > 0.15) { bAff++; if (d > 0.5) bSevere++; }
    }
    res.buildings = bAff; res.buildingsSevere = bSevere;

    let roadM = 0, roadCut = 0;
    const cutEdges = [];
    for (const e of G.edges) {
      if (e.road < 0) continue;
      const mx = (G.nodes[e.a].x + G.nodes[e.b].x) / 2, my = (G.nodes[e.a].y + G.nodes[e.b].y) / 2;
      const k = city.cellIndex(mx, my); if (k < 0) continue;
      const d = depth[k];
      if (e.cls === 'bridge') continue;             // elevated structures excluded
      if (d > 0.15) { roadM += e.len; if (d > 0.30) { roadCut += e.len; cutEdges.push(e.id); } }
    }
    res.roadKmAffected = roadM / 1000;
    res.roadKmImpassable = roadCut / 1000;
    res.cutEdges = new Set(cutEdges);

    const hitAt = p2 => { const k = city.cellIndex(p2.x, p2.y); return k < 0 ? 0 : depth[k]; };
    res.hospitals = city.hospitals.filter(h => hitAt(h) > 0.2);
    res.fire = city.fire.filter(h => hitAt(h) > 0.2);
    res.stations = city.stations.filter(s => hitAt(s) > 0.2);
    res.metroAffected = res.stations.filter(s => s.cat === 'metro').length;
    res.railAffected = res.stations.filter(s => s.cat === 'rail').length;

    res.zones = city.zones.map(z => ({ name: z.name, sector: z.sector, cells: 0, sum: 0, max: 0, x: z.x, y: z.y }));
    for (let k = 0; k < N; k++) {
      if (depth[k] <= 0.10) continue;
      const z = city.zoneOf[k]; if (z < 0) continue;
      const Z = res.zones[z]; Z.cells++; Z.sum += depth[k]; if (depth[k] > Z.max) Z.max = depth[k];
    }
    res.zones.forEach((z, i) => {
      z.areaKm2 = z.cells * cellArea;
      z.mean = z.cells ? z.sum / z.cells : 0;
      z.pct = city.zones[i].cells ? z.cells / city.zones[i].cells * 100 : 0;
    });
    res.topZones = res.zones.slice().sort((a, b) => b.pct * b.mean - a.pct * a.mean).filter(z => z.cells > 0).slice(0, 8);

    res.method = {
      model: 'Lumped rainfall–runoff–ponding, 200 m grid',
      assumptions: [
        'Rainfall is uniform across the city for the whole duration.',
        'Drainage is one city-wide capacity value (' + cap.toFixed(1) + ' mm/h after tide reduction) — the real network is not connected.',
        'Ponding depth scales with the cell\'s depression below its 1 km neighbourhood mean on a SYNTHETIC terrain surface.',
        'No overland routing between cells, no river stage, no pumping stations.',
        'Elevated structures (sea links, freeways on viaduct) are excluded from road impacts.'
      ],
      limits: 'Screening tool only. Do not use for design, insurance pricing or evacuation planning.',
      inputs: ['terrain (simulated)', 'density (simulated)', 'coastline (limited)', 'roads (limited)']
    };
    return res;
  };

  /* ===================================================== TRAFFIC SIMULATION */
  /*
     Static user-equilibrium-flavoured assignment.
       demand  : gravity model over zone density index and network distance
       cost    : BPR  t = t0 (1 + 0.15 (v/c)^4)
       solver  : 4 iterations of the Method of Successive Averages
     Volumes are in "model vehicles" — an internal unit. They are NOT counts.
  */
  function nearestNode(x, y) {
    const h = city.nodeIndex.nearest(x, y, 6000);
    return h ? h.item.i : -1;
  }
  const zoneNodes = city.zones.map(z => nearestNode(z.x, z.y));

  function dijkstra(src, cost, blocked) {
    const n = G.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevE = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const h = new geo.Heap();
    dist[src] = 0; h.push({ k: 0, v: src });
    for (;;) {
      const top = h.pop(); if (!top) break;
      const u = top.v; if (done[u]) continue; done[u] = 1;
      const es = G.nodes[u].edges;
      for (let i = 0; i < es.length; i++) {
        const eid = es[i], e = G.edges[eid];
        if (blocked && blocked(e)) continue;
        const v = e.a === u ? e.b : e.a;
        if (done[v]) continue;
        const nd = dist[u] + cost(e);
        if (nd < dist[v]) { dist[v] = nd; prevE[v] = eid; h.push({ k: nd, v }); }
      }
    }
    return { dist, prevE };
  }
  sim.dijkstra = dijkstra;

  function pathEdges(prevE, src, dst) {
    const out = []; let cur = dst, guard = 0;
    while (cur !== src && prevE[cur] >= 0 && guard++ < 5000) {
      const eid = prevE[cur]; out.push(eid);
      const e = G.edges[eid];
      cur = e.a === cur ? e.b : e.a;
    }
    return cur === src ? out.reverse() : null;
  }
  sim.pathEdges = pathEdges;

  sim.edgeGeometry = function (eids) {
    const pts = [];
    for (let i = 0; i < eids.length; i++) {
      const e = G.edges[eids[i]];
      const a = G.nodes[e.a], b = G.nodes[e.b];
      if (i === 0) pts.push(a.x, a.y);
      const last = pts.length;
      const px = pts[last - 2], py = pts[last - 1];
      if (Math.hypot(px - a.x, py - a.y) < Math.hypot(px - b.x, py - b.y)) pts.push(b.x, b.y);
      else pts.push(a.x, a.y);
    }
    return pts;
  };

  /* Gravity demand, built once and then SCALED so the free-flow baseline peaks
     at V/C ≈ 0.92. Without that calibration the arbitrary gravity constant has
     no meaning, and the BPR term (v/c)^4 explodes into nonsense travel times.
     Calibration fixes the units of the model: volumes stay relative, but the
     loading sits in a range where the volume-delay curve behaves.            */
  let demand = null;
  function buildDemand() {
    const Z = city.zones, n = Z.length;
    demand = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = Math.hypot(Z[i].x - Z[j].x, Z[i].y - Z[j].y) / 1000;
      if (d < 0.5) continue;
      const pull = (Z[i].densityIdx * Z[i].areaKm2) * (Z[j].densityIdx * Z[j].areaKm2 + Z[j].builtPct * 0.02);
      const v = 1000 * pull / Math.pow(d + 2.2, 1.85);
      if (v > 1) demand.push([i, j, v]);
    }
    /* one free-flow all-or-nothing pass to find the peak loading */
    const nE = G.edges.length;
    const vol = new Float64Array(nE);
    const ff = e => e.len / 1000 / e.speed * 60;
    const bySrc = new Map();
    for (const [i, j, v] of demand) {
      let sp = bySrc.get(i);
      if (!sp) { sp = dijkstra(zoneNodes[i], ff, null); bySrc.set(i, sp); }
      const path = pathEdges(sp.prevE, zoneNodes[i], zoneNodes[j]);
      if (!path) continue;
      for (const eid of path) vol[eid] += v;
    }
    let peak = 0;
    for (const e of G.edges) if (e.road >= 0) peak = Math.max(peak, vol[e.id] / e.cap);
    const k = peak > 0 ? 0.92 / peak : 1;
    for (const row of demand) row[2] *= k;
    sim.demandScale = k;
  }

  /** Largest origin–destination pairs in the gravity matrix, for the arcs. */
  sim.topOD = function (n) {
    if (!demand) buildDemand();
    if (!sim._topOD) {
      const Z = city.zones;
      sim._topOD = demand.slice().sort((a, b) => b[2] - a[2]).slice(0, 80).map(([i, j, v]) => ({
        from: Z[i].name, to: Z[j].name, v,
        ax: Z[i].x, ay: Z[i].y, bx: Z[j].x, by: Z[j].y
      }));
    }
    return sim._topOD.slice(0, n || 40);
  };

  /* ============================================ EMERGENCY RESPONSE COVERAGE */
  /*
     Multi-source Dijkstra outward from every mapped fire station, over the
     modelled link times. The result is how much of the arterial network each
     station group can reach inside 5, 10 and 15 minutes — and, with the flood
     scenario applied, how much of that coverage a storm takes away.
  */
  sim.responseCoverage = function (opts) {
    opts = opts || {};
    const bands = opts.bands || [5, 10, 15];
    const sources = (opts.sources || city.fire).map(f => nearestNode(f.x, f.y)).filter(i => i >= 0);
    const tr = MT.state.traffic;
    const floodCut = opts.avoidFlood && MT.state.flood ? MT.state.flood.cutEdges : null;
    const blocked = e => e.closed || (floodCut && floodCut.has(e.id));
    const cost = e => (tr && isFinite(tr.tt[e.id]) ? tr.tt[e.id] : e.len / 1000 / e.speed * 60);

    const n = G.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const done = new Uint8Array(n);
    const h = new geo.Heap();
    /* turnout delay: the time between a call and the appliance moving */
    const turnout = opts.turnout === undefined ? 1.5 : opts.turnout;
    for (const s0 of sources) { dist[s0] = turnout; h.push({ k: turnout, v: s0 }); }
    for (;;) {
      const top = h.pop(); if (!top) break;
      const u = top.v; if (done[u]) continue; done[u] = 1;
      for (const eid of G.nodes[u].edges) {
        const e = G.edges[eid];
        if (blocked(e)) continue;
        const v = e.a === u ? e.b : e.a;
        if (done[v]) continue;
        const nd = dist[u] + cost(e);
        if (nd < dist[v]) { dist[v] = nd; h.push({ k: nd, v }); }
      }
    }

    const band = new Int8Array(G.edges.length).fill(-1);
    const km = [0, 0, 0, 0];
    let totalKm = 0, unreachableKm = 0;
    for (const e of G.edges) {
      if (e.road < 0) continue;
      totalKm += e.len / 1000;
      if (blocked(e)) { unreachableKm += e.len / 1000; continue; }
      const t = Math.max(dist[e.a], dist[e.b]);
      let b = 3;
      for (let i = 0; i < bands.length; i++) if (t <= bands[i]) { b = i; break; }
      if (!isFinite(t)) { unreachableKm += e.len / 1000; continue; }
      band[e.id] = b;
      km[b] += e.len / 1000;
    }
    return {
      band, bands, km, totalKm, unreachableKm,
      stations: sources.length, turnout,
      pct: km.map(v => totalKm ? v / totalKm * 100 : 0),
      withFlood: !!floodCut,
      method: {
        model: 'Multi-source least-time Dijkstra from ' + sources.length + ' station locations',
        assumptions: [
          'A single turnout delay of ' + turnout + ' minutes is applied at every station.',
          'Link times come from the traffic model if one has been run, otherwise free-flow.',
          'Coverage is measured along the modelled arterial network only — local streets, where most incidents actually are, are absent.',
          'Every station is treated as always available, with unlimited appliances.',
          'Flooded links (>0.30 m modelled depth) are removed when the flood option is on.'
        ],
        limits: 'A network-reach measure, not a response-time prediction. Do not use for station siting or service standards.',
        inputs: ['fire (limited)', 'roads (limited)', 'terrain (simulated)']
      }
    };
  };

  /** Flood state part-way through the storm: same intensity, elapsed duration. */
  sim.floodAt = function (params, fraction) {
    const f = Math.max(0.001, Math.min(1, fraction));
    return sim.flood({ rain: params.rain * f, hours: params.hours * f,
                       tide: params.tide, drainEff: params.eff });
  };

  sim.traffic = function (opts) {
    if (!demand) buildDemand();
    const closed = new Set(opts.closed || []);
    const floodCut = opts.useFlood && MT.state.flood ? MT.state.flood.cutEdges : null;
    const blocked = e => closed.has(e.roadId) || e.closed || (floodCut && floodCut.has(e.id));

    const nE = G.edges.length;
    const vol = new Float64Array(nE);
    const t0 = new Float64Array(nE);
    for (let i = 0; i < nE; i++) t0[i] = G.edges[i].len / 1000 / G.edges[i].speed * 60; // minutes

    const peak = opts.peak === undefined ? 1 : opts.peak;
    const cur = new Float64Array(nE);
    for (let iter = 1; iter <= 4; iter++) {
      const cost = e => t0[e.id] * (1 + 0.15 * Math.pow(vol[e.id] / (e.cap * peak), 4));
      cur.fill(0);
      const bySrc = new Map();
      for (const [i, j, v] of demand) {
        let sp = bySrc.get(i);
        if (!sp) { sp = dijkstra(zoneNodes[i], cost, blocked); bySrc.set(i, sp); }
        const path = pathEdges(sp.prevE, zoneNodes[i], zoneNodes[j]);
        if (!path) continue;
        for (const eid of path) cur[eid] += v;
      }
      const w = 1 / iter;
      for (let e = 0; e < nE; e++) vol[e] = vol[e] * (1 - w) + cur[e] * w;
    }

    const vc = new Float64Array(nE);
    const tt = new Float64Array(nE);
    for (let i = 0; i < nE; i++) {
      const e = G.edges[i];
      vc[i] = blocked(e) ? 0 : vol[i] / (e.cap * peak);
      tt[i] = blocked(e) ? Infinity : t0[i] * (1 + 0.15 * Math.pow(vc[i], 4));
    }

    /* corridor readouts -------------------------------------------------- */
    const corridors = {};
    for (const e of G.edges) {
      if (e.road < 0) continue;
      const c = corridors[e.roadId] || (corridors[e.roadId] = { id: e.roadId, name: e.name, len: 0, volLen: 0, vcLen: 0, tt: 0, closed: blocked(e) });
      c.len += e.len; c.volLen += vol[e.id] * e.len; c.vcLen += vc[e.id] * e.len;
      c.tt += isFinite(tt[e.id]) ? tt[e.id] : 0;
    }
    const corrList = Object.values(corridors).map(c => ({
      id: c.id, name: c.name, km: c.len / 1000,
      vc: c.len ? c.vcLen / c.len : 0, vol: c.len ? c.volLen / c.len : 0,
      minutes: c.tt, closed: c.closed
    })).sort((a, b) => b.vc - a.vc);

    /* sample OD travel times for the comparison table */
    const SAMPLES = [
      ['Bandra West', 'Worli'], ['Andheri East', 'Bandra East & BKC'],
      ['Borivali', 'Lower Parel'], ['Mulund', 'Bandra East & BKC'],
      ['Chembur', 'Worli'], ['Juhu & Vile Parle', 'Dadar & Mahim']
    ];
    const zIdx = n => city.zones.findIndex(z => z.name === n);
    const cost = e => tt[e.id];
    const odCache = new Map();
    const od = SAMPLES.map(([a, b]) => {
      const ia = zIdx(a), ib = zIdx(b);
      if (ia < 0 || ib < 0) return null;
      let sp = odCache.get(ia);
      if (!sp) { sp = dijkstra(zoneNodes[ia], cost, blocked); odCache.set(ia, sp); }
      const path = pathEdges(sp.prevE, zoneNodes[ia], zoneNodes[ib]);
      let km = 0; if (path) for (const eid of path) km += G.edges[eid].len / 1000;
      return { from: a.replace('Thane-side: ', ''), to: b, minutes: sp.dist[zoneNodes[ib]], km, path };
    }).filter(Boolean);

    return {
      vol, vc, tt, t0, corridors: corrList, od, closed: [...closed],
      blockedFn: blocked,
      networkVKT: G.edges.reduce((s, e) => s + vol[e.id] * e.len / 1000, 0),
      at: new Date().toISOString(),
      method: {
        model: 'Static assignment, BPR volume-delay, 4 MSA iterations',
        assumptions: [
          'Demand is a gravity model over the SIMULATED density surface — not an observed OD matrix. It is scaled so the uncongested baseline peaks near V/C 0.92, because the gravity constant itself carries no real-world units.',
          'Capacity is 1,800 model vehicles per lane per hour, a generic planning value.',
          'Only ' + MT.ROADS.length + ' arterial corridors are modelled. Local streets are represented by short "local connector" links inserted wherever two corridors pass within 900 m of each other.',
          'No signals, no junction delay, no mode shift, no departure-time choice.',
          'Volumes are model units, not vehicle counts.'
        ],
        limits: 'Use for relative comparison between scenarios only. Absolute travel times are not predictions.',
        inputs: ['roads (limited)', 'density (simulated)', 'traffic_live (not connected)']
      }
    };
  };

  /* ======================================================= EMERGENCY ROUTING */
  /* nearest node that still has an open link — a point beside a closed road
     (the Sea Link during a closure scenario) starts from the nearest open one */
  function nearestOpenNode(x, y) {
    for (const r of [1500, 6000]) for (const h of city.nodeIndex.within(x, y, r)) {
      const n = G.nodes[h.item.i];
      if (n.edges.some(id => !G.edges[id].closed)) return h.item.i;
    }
    return nearestNode(x, y);
  }
  sim.emergencyRoute = function (from, opts) {
    opts = opts || {};
    const src = nearestOpenNode(from.x, from.y);
    if (src < 0) return null;
    const tr = MT.state.traffic;
    const floodCut = opts.avoidFlood && MT.state.flood ? MT.state.flood.cutEdges : null;
    const blocked = e => e.closed || (floodCut && floodCut.has(e.id));
    const cost = e => (tr && isFinite(tr.tt[e.id]) ? tr.tt[e.id] : e.len / 1000 / e.speed * 60);
    let sp = dijkstra(src, cost, blocked);

    const targets = (opts.targets || city.hospitals).map(h => ({ h, n: nearestOpenNode(h.x, h.y) }));
    const pick = () => {
      let b = null;
      for (const t of targets) {
        if (t.n < 0) continue;
        const d = sp.dist[t.n];
        if (isFinite(d) && (!b || d < b.minutes)) b = { minutes: d, node: t.n, target: t.h };
      }
      return b;
    };
    let best = pick(), throughFlood = 0;
    /* Every hospital cut off by flood water: rather than give up, take the
       route that uses the fewest flooded links (each one weighted 8x) and say
       plainly that it passes through flood water. */
    if (!best && floodCut) {
      sp = dijkstra(src, e => cost(e) * (floodCut.has(e.id) ? 8 : 1), e => e.closed);
      best = pick();
      if (best) {
        const ids = pathEdges(sp.prevE, src, best.node) || [];
        best.minutes = ids.reduce((a, id) => a + cost(G.edges[id]), 0);
        throughFlood = ids.filter(id => floodCut.has(id)).length;
      }
    }
    if (!best) return { ok: false, reason: floodCut ? 'No route — every link to a hospital is closed.' : 'No routable path on the modelled network from here.' };

    const eids = pathEdges(sp.prevE, src, best.node) || [];
    let km = 0; const names = [];
    for (const eid of eids) {
      const e = G.edges[eid]; km += e.len / 1000;
      if (e.road >= 0 && names[names.length - 1] !== e.name) names.push(e.name);
    }
    return {
      ok: true, minutes: best.minutes, km, target: best.target,
      path: sim.edgeGeometry(eids), via: names, edges: eids,
      avoidedFlood: !!floodCut && !throughFlood, throughFlood,
      method: {
        model: 'Dijkstra least-time path on the modelled arterial graph',
        assumptions: [
          'Origin and destination snap to the nearest modelled arterial node (up to 6 km away).',
          'Link times come from the traffic model if one has been run, otherwise free-flow.',
          'Flooded links (>0.30 m modelled depth) are removed when "avoid flooded links" is on.',
          'No signal delay, no emergency-vehicle priority, no live incident data.'
        ],
        limits: 'Indicative only. Never use for live dispatch.',
        inputs: ['roads (limited)', 'health (limited)', 'flood scenario (simulation)']
      }
    };
  };

  /* ============================================== INFRASTRUCTURE SIMULATION */
  sim.infrastructure = function (place) {
    const r = place.radius || 800;
    const cellA = city.grid.cell * city.grid.cell / 1e6;
    let cells = 0, newly = 0, densSum = 0, newDens = 0;
    const gx = city.grid;
    const i0 = Math.max(0, Math.floor((place.x - r - gx.x0) / gx.cell));
    const i1 = Math.min(gx.w - 1, Math.ceil((place.x + r - gx.x0) / gx.cell));
    const j0 = Math.max(0, Math.floor((place.y - r - gx.y0) / gx.cell));
    const j1 = Math.min(gx.h - 1, Math.ceil((place.y + r - gx.y0) / gx.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * gx.w + i;
      if (!city.land[k]) continue;
      const c = city.cellCentre(k);
      if (Math.hypot(c.x - place.x, c.y - place.y) > r) continue;
      cells++; densSum += city.density[k];
      const alreadyServed = place.type === 'Metro Station' ? city.metroServed[k] : city.transitServed[k];
      if (!alreadyServed) { newly++; newDens += city.density[k]; }
    }
    const b = city.buildingIndex.within(place.x, place.y, r).map(h => h.item);
    const hosp = city.hospitalIndex.within(place.x, place.y, Math.max(r, 3000));
    const nearestMetro = city.metroIndex.nearest(place.x, place.y, 30000);
    const nearestStn = city.stationIndex.nearest(place.x, place.y, 30000);
    const nearestRoad = (() => {
      let best = null, bd = Infinity;
      for (const e of G.edges) {
        if (e.road < 0) continue;
        const d = geo.distToSeg(place.x, place.y, G.nodes[e.a].x, G.nodes[e.a].y, G.nodes[e.b].x, G.nodes[e.b].y);
        if (d < bd) { bd = d; best = e; }
      }
      return best ? { name: best.name, cls: best.cls, d: bd } : null;
    })();

    return {
      type: place.type, x: place.x, y: place.y, radius: r,
      catchmentKm2: cells * cellA,
      newlyServedKm2: newly * cellA,
      newlyServedPct: cells ? newly / cells * 100 : 0,
      densityIndex: cells ? densSum / cells : 0,
      newDensityIndex: newly ? newDens / newly : 0,
      buildings: b.length,
      floors: b.reduce((s, x) => s + x.floors, 0),
      hospitalsNear: hosp.length,
      nearestMetro: nearestMetro ? { name: nearestMetro.item.name, line: nearestMetro.item.line, d: nearestMetro.d } : null,
      nearestStation: nearestStn ? { name: nearestStn.item.name, line: nearestStn.item.line, d: nearestStn.d } : null,
      nearestRoad,
      population: null,     // withheld by design — no verified dataset
      method: {
        model: 'Catchment overlay — ' + r + ' m radius, 200 m grid',
        assumptions: [
          'Catchment is a straight-line radius, not a walk-network isochrone.',
          '"Newly served" means cells outside every existing station catchment of the same class.',
          'Density is the SIMULATED surface. It supports relative comparison only.'
        ],
        limits: 'Population served cannot be reported: no census dataset is connected.',
        inputs: ['rail (limited)', 'density (simulated)', 'buildings (simulated)']
      }
    };
  };

  /* ==================================================== BUILDING SIMULATION */
  sim.building = function (b) {
    const k = city.cellIndex(b.x, b.y);
    const floodDepth = MT.state.flood && k >= 0 ? MT.state.flood.depth[k] : null;
    const elev = k >= 0 ? city.elev[k] : 0;
    const near = city.buildingIndex.within(b.x, b.y, 400).map(h => h.item);
    const avgH = near.length ? near.reduce((s, x) => s + x.h, 0) / near.length : 0;
    const hosp = city.hospitalIndex.nearest(b.x, b.y, 20000);
    const stn = city.stationIndex.nearest(b.x, b.y, 20000);
    const met = city.metroIndex.nearest(b.x, b.y, 20000);
    const gfa = b.footprint * b.floors;

    /* trip generation — generic planning rates, stated as assumptions */
    const RATE = { 'Residential': 0.42, 'Commercial': 1.55, 'Mixed use': 0.85, 'Institutional': 0.95, 'Industrial': 0.55 };
    const rate = RATE[b.use] || 0.5;
    const peakTrips = Math.round(gfa / 100 * rate);
    const parkingDemand = Math.round(gfa / 100 * (b.use === 'Residential' ? 0.55 : 0.9));

    /* shadow at a winter-morning sun elevation of 30° */
    const shadow = b.height / Math.tan(30 * Math.PI / 180);

    /* local road capacity within 500 m */
    let capNear = 0;
    for (const e of G.edges) {
      if (e.road < 0) continue;
      const d = geo.distToSeg(b.x, b.y, G.nodes[e.a].x, G.nodes[e.a].y, G.nodes[e.b].x, G.nodes[e.b].y);
      if (d < 500) capNear = Math.max(capNear, e.cap);
    }

    return {
      input: b, gfa, elev, floodDepth,
      contextHeight: avgH,
      heightRatio: avgH ? b.height / avgH : null,
      shadowLength: shadow,
      peakTrips, parkingDemand,
      capNear,
      loadPct: capNear ? peakTrips / capNear * 100 : null,
      nearestHospital: hosp ? { name: hosp.item.name, d: hosp.d } : null,
      nearestStation: stn ? { name: stn.item.name, line: stn.item.line, d: stn.d } : null,
      nearestMetro: met ? { name: met.item.name, line: met.item.line, d: met.d } : null,
      buildingsNear: near.length,
      method: {
        model: 'Site-context overlay + generic trip-generation rates',
        assumptions: [
          'Trip rates are generic planning values per 100 m² gross floor area (' + rate + ' peak-hour trips), not local survey rates.',
          'Shadow length assumes a 30° sun elevation on flat ground and ignores neighbouring massing.',
          'Context height is the mean of SIMULATED buildings within 400 m.',
          'Flood depth is read from the current scenario, if one has been run.'
        ],
        limits: 'Not a development-control assessment. No FSI, setback, or by-law checking.',
        inputs: ['buildings (simulated)', 'roads (limited)', 'health (limited)', 'rail (limited)']
      }
    };
  };

  /* ============================================================== ANALYTICS */
  sim.areaStats = function (rect) {
    const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
    const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
    const gx = city.grid;
    let cells = 0, green = 0, low = 0, densSum = 0, floodCells = 0;
    for (let j = 0; j < gx.h; j++) for (let i = 0; i < gx.w; i++) {
      const c = city.cellCentre(j * gx.w + i);
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
      const k = j * gx.w + i;
      if (!city.land[k]) continue;
      cells++; densSum += city.density[k];
      if (city.green[k]) green++;
      if (city.elev[k] < 4) low++;
      if (MT.state.flood && MT.state.flood.depth[k] > 0.15) floodCells++;
    }
    const inR = p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    const bs = city.buildings.filter(inR);
    let roadM = 0;
    for (const e of G.edges) {
      if (e.road < 0) continue;
      const mx = (G.nodes[e.a].x + G.nodes[e.b].x) / 2, my = (G.nodes[e.a].y + G.nodes[e.b].y) / 2;
      if (mx >= x0 && mx <= x1 && my >= y0 && my <= y1) roadM += e.len;
    }
    const cellA = gx.cell * gx.cell / 1e6;
    return {
      areaKm2: (x1 - x0) * (y1 - y0) / 1e6,
      landKm2: cells * cellA,
      buildings: bs.length,
      builtAreaKm2: bs.reduce((s, b) => s + b.area, 0) / 1e6,
      floors: bs.reduce((s, b) => s + b.floors, 0),
      meanHeight: bs.length ? bs.reduce((s, b) => s + b.h, 0) / bs.length : 0,
      roadKm: roadM / 1000,
      hospitals: city.hospitals.filter(inR).length,
      schools: city.schools.filter(inR).length,
      fire: city.fire.filter(inR).length,
      metro: city.metroStations.filter(inR).length,
      rail: city.railStations.filter(inR).length,
      greenPct: cells ? green / cells * 100 : 0,
      lowPct: cells ? low / cells * 100 : 0,
      floodPct: cells ? floodCells / cells * 100 : 0,
      densityIndex: cells ? densSum / cells : 0,
      population: null
    };
  };

  sim.zoneTable = function () {
    const fl = MT.state.flood;
    return city.zones.map((z, i) => {
      let floodPct = null;
      if (fl) {
        let c = 0, t = 0;
        for (let k = 0; k < city.zoneOf.length; k++) {
          if (city.zoneOf[k] !== i) continue;
          t++; if (fl.depth[k] > 0.15) c++;
        }
        floodPct = t ? c / t * 100 : 0;
      }
      return {
        name: z.name, sector: z.sector, areaKm2: z.areaKm2,
        buildings: z.buildings, builtPct: z.builtPct, floors: z.floors,
        roadDensity: z.roadDensity, greenPct: z.greenPct,
        transitPct: z.transitPct, metroPct: z.metroPct,
        densityIndex: z.densityIdx, meanElev: z.meanElev, lowPct: z.lowPct,
        hospitals: z.hospitals, schools: z.schools, fire: z.fire,
        metro: z.metro, rail: z.rail, floodPct, x: z.x, y: z.y
      };
    });
  };

  /* ==================================================== SCENARIO COMPARISON */
  sim.compare = function (a, b) {
    const rows = [];
    const push = (label, va, vb, unit, better) => rows.push({ label, a: va, b: vb, unit, better });
    if (a.kind === 'flood' && b.kind === 'flood') {
      push('Rainfall', a.r.params.rain, b.r.params.rain, 'mm');
      push('Duration', a.r.params.hours, b.r.params.hours, 'h');
      push('Area with standing water', a.r.areaKm2, b.r.areaKm2, 'km²', 'low');
      push('Severe (> 0.6 m) area', a.r.classAreas[3], b.r.classAreas[3], 'km²', 'low');
      push('Buildings affected', a.r.buildings, b.r.buildings, '', 'low');
      push('Arterial road affected', a.r.roadKmAffected, b.r.roadKmAffected, 'km', 'low');
      push('Arterial road impassable', a.r.roadKmImpassable, b.r.roadKmImpassable, 'km', 'low');
      push('Hospitals in standing water', a.r.hospitals.length, b.r.hospitals.length, '', 'low');
      push('Stations affected', a.r.stations.length, b.r.stations.length, '', 'low');
    } else if (a.kind === 'traffic' && b.kind === 'traffic') {
      push('Network vehicle-km (model units)', a.r.networkVKT, b.r.networkVKT, '', 'low');
      /* both runs averaged over the same journeys: those reachable in both */
      const both = a.r.od.map((o, i) => isFinite(o.minutes) && isFinite(b.r.od[i] && b.r.od[i].minutes));
      const avg = r => { const v = r.od.filter((o, i) => both[i]).map(o => o.minutes);
        return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
      push('Mean sampled journey time', avg(a.r), avg(b.r), 'min', 'low');
      push('Corridors above capacity', a.r.corridors.filter(c => c.vc > 1).length, b.r.corridors.filter(c => c.vc > 1).length, '', 'low');
      a.r.od.forEach((o, i) => push(o.from + ' → ' + o.to, o.minutes, b.r.od[i] ? b.r.od[i].minutes : NaN, 'min', 'low'));
    } else if (a.kind === 'infra' && b.kind === 'infra') {
      push('Catchment', a.r.catchmentKm2, b.r.catchmentKm2, 'km²', 'high');
      push('Newly served area', a.r.newlyServedKm2, b.r.newlyServedKm2, 'km²', 'high');
      push('Newly served share', a.r.newlyServedPct, b.r.newlyServedPct, '%', 'high');
      push('Buildings in catchment', a.r.buildings, b.r.buildings, '', 'high');
      push('Density index in catchment', a.r.densityIndex, b.r.densityIndex, '', 'high');
    }
    return rows;
  };

  /* ================================================================ REPORTS */
  sim.report = function (kind) {
    const now = new Date();
    const stamp = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const used = new Set();
    const rep = { title: '', at: stamp, sections: [], kind };

    const dsBlock = ids => MT.DATASETS.filter(d => ids.has(d.id)).map(d =>
      ({ name: d.name, status: d.status, source: d.source, updated: d.updated, accuracy: d.accuracy, note: d.note }));

    if (kind === 'flood') {
      const r = MT.state.flood;
      if (!r) return null;
      rep.title = 'Mumbai Flood Impact Analysis';
      ['terrain', 'density', 'coastline', 'roads', 'health', 'rail', 'buildings', 'rain_live', 'drainage', 'tide', 'population'].forEach(i => used.add(i));
      rep.sections.push({ h: 'Executive summary', p:
        'A rainfall scenario of ' + r.params.rain + ' mm over ' + r.params.hours + ' hours (' +
        r.intensity.toFixed(1) + ' mm/h) was run against a modelled drainage capacity of ' +
        r.capacity.toFixed(1) + ' mm/h at a tide level of ' + r.params.tide.toFixed(1) + ' m. ' +
        'The model places standing water over ' + r.areaKm2.toFixed(1) + ' km² of land, of which ' +
        r.classAreas[3].toFixed(1) + ' km² exceeds 0.6 m. ' +
        r.buildings.toLocaleString('en-IN') + ' simulated structures fall inside affected cells, ' +
        r.roadKmAffected.toFixed(1) + ' km of modelled arterial road is affected and ' +
        r.roadKmImpassable.toFixed(1) + ' km is classified impassable. ' +
        r.hospitals.length + ' of ' + city.hospitals.length + ' mapped hospitals and ' +
        r.stations.length + ' stations sit in affected cells. ' +
        'Every figure in this report is model output from synthetic terrain and must not be treated as a forecast.' });
      rep.sections.push({ h: 'Area analysed', p:
        'Mumbai Metropolitan Region (Virar to Panvel, Colaba to Badlapur), generalised coastline and creeks, ' + (city.zones.length) + ' demo analysis zones, 200 m grid (' +
        city.grid.w + ' × ' + city.grid.h + ' cells).' });
      rep.sections.push({ h: 'Simulation parameters', table: [
        ['Rainfall depth', r.params.rain + ' mm'], ['Duration', r.params.hours + ' h'],
        ['Mean intensity', r.intensity.toFixed(1) + ' mm/h'],
        ['Tide level', r.params.tide.toFixed(2) + ' m'],
        ['Drainage efficiency factor', r.params.eff.toFixed(2)],
        ['Effective drainage capacity', r.capacity.toFixed(1) + ' mm/h'],
        ['Net excess', r.excess_mm.toFixed(1) + ' mm']] });
      rep.sections.push({ h: 'Affected infrastructure', table: [
        ['Simulated buildings in affected cells', r.buildings.toLocaleString('en-IN')],
        ['…of which above 0.5 m', r.buildingsSevere.toLocaleString('en-IN')],
        ['Arterial road affected', r.roadKmAffected.toFixed(1) + ' km'],
        ['Arterial road impassable (> 0.30 m)', r.roadKmImpassable.toFixed(1) + ' km'],
        ['Hospitals in affected cells', r.hospitals.length + ' — ' + (r.hospitals.map(h => h.name).join('; ') || 'none')],
        ['Fire stations in affected cells', r.fire.length],
        ['Metro stations affected', r.metroAffected],
        ['Railway stations affected', r.railAffected]] });
      rep.sections.push({ h: 'Zones ranked by exposure', table:
        r.topZones.map(z => [z.name, z.pct.toFixed(0) + '% of zone · mean ' + z.mean.toFixed(2) + ' m · peak ' + z.max.toFixed(2) + ' m']) });
      rep.sections.push({ h: 'Assumptions', list: r.method.assumptions });
      rep.sections.push({ h: 'Limitations', p: r.method.limits +
        ' Population exposure is not reported: no census dataset is connected to this build, and the platform does not estimate it.' });
    } else if (kind === 'traffic') {
      const r = MT.state.traffic;
      if (!r) return null;
      rep.title = 'Mumbai Traffic Disruption Analysis';
      ['roads', 'density', 'traffic_live', 'population'].forEach(i => used.add(i));
      const closedNames = r.closed.map(id => (MT.ROADS.find(x => x.id === id) || {}).name).filter(Boolean);
      rep.sections.push({ h: 'Executive summary', p:
        (closedNames.length ? 'Closure scenario: ' + closedNames.join(', ') + '. ' : 'Baseline network, no closures. ') +
        'The assignment loads ' + Math.round(r.networkVKT).toLocaleString('en-IN') + ' model vehicle-km onto the arterial graph. ' +
        r.corridors.filter(c => c.vc > 1).length + ' of ' + r.corridors.length +
        ' corridors carry more than their modelled capacity. Sampled journey times are listed below. ' +
        'These are relative model outputs — no observed traffic data is connected.' });
      rep.sections.push({ h: 'Corridor loading', table:
        r.corridors.slice(0, 12).map(c => [c.name + (c.closed ? '  (CLOSED)' : ''), 'V/C ' + c.vc.toFixed(2) + ' · ' + c.km.toFixed(1) + ' km']) });
      rep.sections.push({ h: 'Sampled journey times', table:
        r.od.map(o => [o.from + ' → ' + o.to, isFinite(o.minutes) ? o.minutes.toFixed(1) + ' min · ' + o.km.toFixed(1) + ' km' : 'no route']) });
      rep.sections.push({ h: 'Assumptions', list: r.method.assumptions });
      rep.sections.push({ h: 'Limitations', p: r.method.limits });
    } else {
      rep.title = 'Mumbai Urban Analytics Summary';
      ['buildings', 'density', 'roads', 'rail', 'health', 'coastline', 'population'].forEach(i => used.add(i));
      const z = sim.zoneTable();
      rep.sections.push({ h: 'Executive summary', p:
        'Summary of ' + city.zones.length + ' demo analysis zones across the Mumbai Metropolitan Region. ' +
        city.buildings.length.toLocaleString('en-IN') + ' simulated structures, ' +
        city.roadKm.toFixed(0) + ' km of modelled arterial road, ' + city.metroStations.length +
        ' metro and ' + city.railStations.length + ' suburban rail station records. ' +
        'Zone boundaries are nearest-centroid partitions, not BMC ward boundaries.' });
      rep.sections.push({ h: 'Transit accessibility (share of zone within 800 m of a station)', table:
        z.slice().sort((a, b) => a.transitPct - b.transitPct).slice(0, 10)
          .map(r2 => [r2.name, r2.transitPct.toFixed(0) + '% · metro ' + r2.metroPct.toFixed(0) + '%']) });
      rep.sections.push({ h: 'Green cover by zone (lowest ten)', table:
        z.slice().sort((a, b) => a.greenPct - b.greenPct).slice(0, 10).map(r2 => [r2.name, r2.greenPct.toFixed(1) + '%']) });
      rep.sections.push({ h: 'Limitations', p:
        'Built-up figures derive from a synthetic building stock. Population, employment and land-use datasets are not connected, so no per-capita metric is produced.' });
    }

    rep.datasets = dsBlock(used);
    rep.provenance = 'Generated by Mumbai Digital Twin ' + MT.META.build + ' at ' + stamp +
      '. Verified live data sources connected: 0.';
    return rep;
  };

  sim.reportMarkdown = function (rep) {
    let md = '# ' + rep.title + '\n\n_' + rep.provenance + '_\n\n';
    for (const s of rep.sections) {
      md += '## ' + s.h + '\n\n';
      if (s.p) md += s.p + '\n\n';
      if (s.list) { for (const l of s.list) md += '- ' + l + '\n'; md += '\n'; }
      if (s.table) { md += '| Item | Value |\n| --- | --- |\n'; for (const [a, b] of s.table) md += '| ' + a + ' | ' + b + ' |\n'; md += '\n'; }
    }
    md += '## Dataset provenance\n\n| Dataset | Status | Source | Accuracy |\n| --- | --- | --- | --- |\n';
    for (const d of rep.datasets) md += '| ' + d.name + ' | ' + d.status + ' | ' + d.source + ' | ' + d.accuracy + ' |\n';
    return md;
  };

  sim.reportCSV = function (rep) {
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    let csv = 'section,item,value\n';
    for (const s of rep.sections) {
      if (s.p) csv += [esc(s.h), esc('narrative'), esc(s.p)].join(',') + '\n';
      if (s.list) s.list.forEach((l, i) => csv += [esc(s.h), esc('assumption ' + (i + 1)), esc(l)].join(',') + '\n');
      if (s.table) s.table.forEach(([a, b]) => csv += [esc(s.h), esc(a), esc(b)].join(',') + '\n');
    }
    for (const d of rep.datasets) csv += [esc('dataset provenance'), esc(d.name), esc(d.status + ' — ' + d.source)].join(',') + '\n';
    return csv;
  };
})(window.MT);
