/* ============================================================================
   motion.js — the living layer: vehicles, trains, aircraft and vessels.

   This is SIMULATION OUTPUT, not observation. Nothing here is fed by ADS-B,
   AIS, GPS or signalling data, and no callsign or vessel name is ever shown.

   Road agents are the exception that earns its keep: their speed is read
   straight out of the traffic assignment, so a corridor running at V/C 1.2
   visibly crawls and bunches, and closing a link empties it on screen. The
   motion is the model's output made legible, not an ambient effect.
   ========================================================================== */
(function (MT) {
  'use strict';
  const geo = MT.geo, city = MT.city, G = city.graph;
  const M = MT.motion = {};

  const TIME_SCALE = 4;             // simulated seconds per real second
  const cfg = M.config = { on: true, density: 1, speed: TIME_SCALE };
  M.on = () => cfg.on && !document.hidden;

  /* ------------------------------------------------------------- utilities */
  const rng = city.rngFrom(77021);

  /** Build a traversable polyline with cumulative distance (and altitude). */
  function track(ptsLonLat, withAlt) {
    const n = ptsLonLat.length;
    const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
    const cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = geo.x(ptsLonLat[i][0]);
      y[i] = geo.y(ptsLonLat[i][1]);
      z[i] = withAlt ? (ptsLonLat[i][2] || 0) : 0;
      if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    }
    return { x, y, z, cum, n, total: cum[n - 1] };
  }

  const _p = { x: 0, y: 0, z: 0, hx: 1, hy: 0 };
  /** Position + unit heading at distance s along a track. */
  function at(t, s) {
    if (s <= 0) s = 0;
    if (s >= t.total) s = t.total;
    let i = 1;
    while (i < t.n - 1 && t.cum[i] < s) i++;
    const seg = t.cum[i] - t.cum[i - 1] || 1;
    const f = (s - t.cum[i - 1]) / seg;
    _p.x = t.x[i - 1] + (t.x[i] - t.x[i - 1]) * f;
    _p.y = t.y[i - 1] + (t.y[i] - t.y[i - 1]) * f;
    _p.z = t.z[i - 1] + (t.z[i] - t.z[i - 1]) * f;
    const dx = t.x[i] - t.x[i - 1], dy = t.y[i] - t.y[i - 1], L = Math.hypot(dx, dy) || 1;
    _p.hx = dx / L; _p.hy = dy / L;
    return _p;
  }

  /* =============================================================== VEHICLES */
  const vehicles = [];
  let edgePick = null;              // cumulative weights for spawning

  function blocked(e) {
    if (e.closed) return true;
    const fl = MT.state.flood;
    return !!(fl && fl.cutEdges && fl.cutEdges.has(e.id));
  }

  /** Free-flow speed degraded by the assignment's volume/capacity ratio. */
  function edgeSpeed(e) {
    const tr = MT.state.traffic;
    let kmh = e.speed;
    if (tr && tr.vc) {
      const vc = tr.vc[e.id] || 0;
      kmh = e.speed / (1 + 0.15 * Math.pow(vc, 4));
    }
    return Math.max(5, kmh) / 3.6;   // m/s
  }

  function buildEdgePick() {
    const tr = MT.state.traffic;
    edgePick = { ids: [], cum: new Float64Array(G.edges.length), total: 0 };
    let acc = 0;
    for (const e of G.edges) {
      let w = 0;
      /* Only real, drawn carriageways. The synthetic local connectors exist
         to keep the routing graph joined up; they are not streets, and a car
         running along one looks like it is driving across open ground. */
      if (!blocked(e) && e.road >= 0) {
        w = tr && tr.vol ? tr.vol[e.id] * e.len : e.lanes * e.speed * e.len;
      }
      acc += w;
      edgePick.ids.push(e.id);
      edgePick.cum[edgePick.ids.length - 1] = acc;
    }
    edgePick.total = acc;
  }

  function pickEdge() {
    if (!edgePick || !edgePick.total) return null;
    const r = rng() * edgePick.total;
    let lo = 0, hi = edgePick.ids.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (edgePick.cum[mid] < r) lo = mid + 1; else hi = mid; }
    return G.edges[edgePick.ids[lo]];
  }

  function respawn(v) {
    const e = pickEdge();
    if (!e) return false;
    v.e = e.id;
    v.fwd = rng() < 0.5;
    v.s = rng() * e.len;
    v.lane = Math.floor(rng() * Math.max(1, Math.min(3, e.lanes)));
    v.jitter = 0.82 + rng() * 0.36;
    v.kind = rng() < 0.12 ? 'bus' : rng() < 0.2 ? 'lcv' : 'car';
    v.body = v.kind === 'car' ? pickBody(rng()) : v.kind;
    v.life = 55 + rng() * 90;
    return true;
  }

  function targetVehicleCount() {
    return Math.round(620 * cfg.density);
  }

  function syncVehicles() {
    buildEdgePick();
    const want = MT.layerOn('traffic_flow') && M.on() ? targetVehicleCount() : 0;
    while (vehicles.length > want) vehicles.pop();
    while (vehicles.length < want) {
      const v = { e: -1, fwd: true, s: 0, lane: 0, jitter: 1, kind: 'car', life: 0, spd: 0 };
      if (!respawn(v)) break;
      vehicles.push(v);
    }
  }

  function stepVehicle(v, dt) {
    let e = G.edges[v.e];
    if (!e || blocked(e)) { respawn(v); return; }
    const sp = edgeSpeed(e) * v.jitter;
    v.spd = sp / (e.speed / 3.6);
    v.s += sp * dt;
    v.life -= dt;
    while (v.s > e.len) {
      v.s -= e.len;
      const node = v.fwd ? e.b : e.a;
      if (v.life <= 0) { respawn(v); return; }
      /* choose the onward link, preferring to carry straight on */
      const inx = (G.nodes[v.fwd ? e.b : e.a].x - G.nodes[v.fwd ? e.a : e.b].x);
      const iny = (G.nodes[v.fwd ? e.b : e.a].y - G.nodes[v.fwd ? e.a : e.b].y);
      const iL = Math.hypot(inx, iny) || 1;
      let best = -1, bestW = -1;
      const list = G.nodes[node].edges;
      for (let i = 0; i < list.length; i++) {
        const id = list[i];
        if (id === v.e) continue;
        const c = G.edges[id];
        if (blocked(c) || c.road < 0) continue;      // stay on drawn roads
        const fwd = c.a === node;
        const A = G.nodes[fwd ? c.a : c.b], B = G.nodes[fwd ? c.b : c.a];
        const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
        const align = (inx / iL) * (dx / L) + (iny / iL) * (dy / L);
        const w = Math.pow(Math.max(0.03, (align + 1) / 2), 3) * (c.road >= 0 ? 1 : 0.35) * (0.6 + rng() * 0.8);
        if (w > bestW) { bestW = w; best = id; }
      }
      /* Dead end on the modelled corridor set: turn round rather than vanish,
         so the carriageway keeps carrying traffic. */
      if (best < 0) { v.fwd = !v.fwd; continue; }
      const c = G.edges[best];
      v.fwd = c.a === node;
      v.e = best;
      e = c;
    }
  }

  /* ================================================================= TRAINS */
  const trains = [];
  function buildTrains() {
    trains.length = 0;
    const lines = [];
    MT.RAIL.forEach(l => lines.push({ line: l, kind: 'rail', z: 5, speed: 13.5, headway: 165, dwell: 25 }));
    MT.METRO.forEach(l => lines.push({ line: l, kind: 'metro', z: l.underground ? 0 : 11, speed: 16.5, headway: 190, dwell: 20 }));
    for (const L of lines) {
      /* with altitude: the track carries the bed height, so trains ride up over rail flyovers */
      const t = track((city.railLL && city.railLL[L.line.id]) || L.line.stations.map(s => [s.lon, s.lat, L.z]), true);
      const stops = [], isStop = city.railStop && city.railStop[L.line.id];
      for (let i = 0; i < t.n; i++) if (!isStop || isStop[i]) stops.push(t.cum[i]);   // stations only, not densified track points
      const n = Math.max(2, Math.round(t.total / (L.speed * L.headway)));
      for (let i = 0; i < n * 2; i++) {
        trains.push({
          t, stops, z: L.z, color: L.line.color, kind: L.kind,
          name: L.line.name, dwellFor: 0, dwell: L.dwell, speed: L.speed,
          dir: i % 2 ? 1 : -1,
          s: (i % 2 ? 1 : 0) * t.total + (i % 2 ? -1 : 1) * ((i >> 1) / n) * t.total,
          ug: !!L.line.underground,
          /* keep left, as Indian Railways and Mumbai Metro do: a train running
             with the track (dir +1) takes a track on the left of the centre
             line, one running against it the right; locals alternate fast and slow */
          lane: (i % 2 ? 1 : -1) * (L.kind === 'metro' ? 4.2 : ((i >> 1) % 2 ? 13.5 : 4.5)),
          len: L.kind === 'metro' ? 148 : 276,
          coaches: L.kind === 'metro' ? 8 : 12, nextStop: 0
        });
      }
    }
  }

  /* Crowding is a shape, not a count: two commuting peaks, a strong peak
     direction, and the heaviest loading on the approach to the island city.
     No ticketing, gateline or occupancy feed is connected, so this describes
     the assumed pattern — never a measured load. */
  function railLoad(tr) {
    const tod = MT.state.tod;
    const peak = Math.max(
      Math.exp(-Math.pow((tod - 9.3) / 1.9, 2)),
      Math.exp(-Math.pow((tod - 19.1) / 2.0, 2)));
    const base = 0.20 + 0.78 * peak;
    const inboundDir = tod < 14 ? 1 : -1;
    const dirF = tr.dir === inboundDir ? 1 : 0.52;
    const f = tr.t.total ? tr.s / tr.t.total : 0;
    const core = 1 - Math.min(1, Math.abs(f - 0.18) * 1.35);
    const v = base * dirF * (0.5 + 0.85 * core) * (tr.kind === 'rail' ? 1.15 : 0.92);
    return Math.max(0.05, Math.min(1.25, v));
  }
  M.railLoad = railLoad;

  function stepTrain(tr, dt) {
    tr.load = railLoad(tr);
    if (tr.dwellFor > 0) { tr.dwellFor -= dt; return; }
    tr.s += tr.speed * tr.dir * dt;
    /* the rake is drawn coach by coach along the track, so its centre turns
       back half a train-length short of the buffers rather than overhanging */
    const lo = Math.min(tr.len / 2, tr.t.total / 2), hi = tr.t.total - lo;
    if (tr.s > hi) { tr.s = hi; tr.dir = -1; tr.dwellFor = tr.dwell * 2; }
    if (tr.s < lo) { tr.s = lo; tr.dir = 1; tr.dwellFor = tr.dwell * 2; }
    for (let i = 0; i < tr.stops.length; i++) {
      const d = tr.s - tr.stops[i];
      if (Math.abs(d) < tr.speed * dt && i !== tr.nextStop) { tr.nextStop = i; tr.dwellFor = tr.dwell; break; }
    }
  }

  /* =============================================================== AIRCRAFT */
  const aircraft = [];
  function buildAircraft() {
    aircraft.length = 0;
    MT.AIRTRACKS.forEach((A, ai) => {
      const t = track(A.pts, true);
      for (let i = 0; i < 4; i++) {
        aircraft.push({
          t, kind: A.kind, name: A.name,
          s: (i / 4 + ai * 0.11) * t.total, trail: [], strobe: rng()
        });
      }
    });
  }
  /* Aircraft run at 40% of the shared time-scale: at the 4x clock the
     ground and rail traffic uses, a jet crossed the city in seconds. */
  const AC_SLOW = 0.4;
  function acSpeed(a) {
    const p = at(a.t, a.s);
    return (78 + Math.min(1, p.z / 5000) * 160) * AC_SLOW;   // m/s ground speed by altitude
  }
  /* Tallest structure within 900 m of a point — the terrain the aircraft
     must clear. Buildings under the approach are already capped by the
     airport funnel in city.js, so this rarely bites near the runway. */
  function localCeiling(x, y) {
    const C = MT.city; if (!C || !C.buildingIndex) return 0;
    let m = 0;
    for (const c of C.buildingIndex.within(x, y, 900)) if (c.item.h > m) m = c.item.h;
    return m;
  }
  function distToRunway(x, y) {
    const A = MT.city && MT.city.airport; if (!A) return Infinity;
    let d = Infinity;
    for (const r of A.runways) d = Math.min(d, MT.geo.distToSeg(x, y, r.ax, r.ay, r.bx, r.by));
    return d;
  }
  function stepAircraft(a, dt) {
    a.s += acSpeed(a) * dt;
    a.strobe = (a.strobe + dt * 0.85) % 1;
    if (a.s > a.t.total) {
      a.s = 0; a.trail.length = 0;
    }
    const p = at(a.t, a.s);
    a.x = p.x; a.y = p.y; a.hx = p.hx; a.hy = p.hy;
    { const zb = at(a.t, Math.max(0, a.s - 80)).z, zf = at(a.t, Math.min(a.t.total, a.s + 80)).z;
      a.pitch = Math.max(-0.12, Math.min(0.2, Math.atan2(zf - zb, 160))); at(a.t, a.s); }
    /* clearance: at least 120 m over the tallest structure nearby, blending
       down to the track itself over the last 2 km to the runway, so arrivals
       still touch down and departures still lift off */
    if (!a.ceilT || a.ceilT > 0.5) { a.ceil = localCeiling(p.x, p.y); a.ceilT = 0; }
    a.ceilT += dt;
    const near = Math.max(0, Math.min(1, (distToRunway(p.x, p.y) - 300) / 2000));
    a.ceilNear = a.ceil * near;
    a.z = Math.max(p.z, (a.ceil + 120) * near);
    if (!a.trailT || a.trailT > 0.6) {
      a.trail.push(p.x, p.y, a.z);
      if (a.trail.length > 42) a.trail.splice(0, 3);
      a.trailT = 0;
    }
    a.trailT = (a.trailT || 0) + dt;
  }

  /* ================================================================ VESSELS */
  const vessels = [];
  /** True when the whole hull — bow, stern and both sides — is over water. */
  function hullAfloat(t, s, size) {
    const C = MT.city;
    if (!C || !C.isLand) return true;
    const p = at(t, s);
    const x = p.x, y = p.y, hx = p.hx, hy = p.hy;
    const half = size / 2 + 12, bm = size * 0.14 + 8;    // plus a small berth
    return !(C.isLand(x, y) ||
             C.isLand(x + hx * half, y + hy * half) ||
             C.isLand(x - hx * half, y - hy * half) ||
             C.isLand(x + hy * bm, y - hx * bm) ||
             C.isLand(x - hy * bm, y + hx * bm));
  }


  /* Display exaggeration for hulls, as for buildings and vehicles: a 34 m
     ferry is under a pixel at harbour scale. Applied before the coastline
     trim below, so the enlarged hull is what is kept off the land. */
  const SHIP_SCALE = { cargo: 2.0, ferry: 3.3 };
  function buildVessels() {
    vessels.length = 0;
    MT.SEATRACKS.forEach((S0, si) => {
      const S = Object.assign({}, S0, { size: S0.size * (SHIP_SCALE[S0.kind] || 1.6) });
      const t = track(S.pts, false);
      /* A route may end at a pier or a dock that the generalised coastline
         counts as land. Trim each end inward until the whole hull floats, so
         a ship turns around in open water instead of sailing onto the quay. */
      let s0 = 0, s1 = t.total;
      while (s0 < t.total && !hullAfloat(t, s0, S.size)) s0 += 10;
      while (s1 > s0 && !hullAfloat(t, s1, S.size)) s1 -= 10;
      if (s1 - s0 < S.size * 2) return;                 // no room to sail: skip
      const n = 3;
      for (let i = 0; i < n; i++) {
        vessels.push({
          t, kind: S.kind, size: S.size, speed: S.speed, s0, s1,
          s: s0 + (((i / n) + si * 0.11) % 1) * (s1 - s0),
          dir: i % 2 ? -1 : 1
        });
      }
    });
  }
  function stepVessel(v, dt) {
    v.s += v.speed * v.dir * dt;
    if (v.s > v.s1) { v.s = v.s1; v.dir = -1; }
    if (v.s < v.s0) { v.s = v.s0; v.dir = 1; }
    const p = at(v.t, v.s);
    v.x = p.x; v.y = p.y; v.hx = p.hx * v.dir; v.hy = p.hy * v.dir;
  }

  /* ================================================== EMERGENCY RESPONDER */
  let responders = [];
  function syncResponders() {
    /* compare against the routes that can actually be driven; comparing with
       the unfiltered list rebuilt the responders every frame whenever one
       route was empty, so the others never left the station (audit #16) */
    const routes = (MT.state.routes || []).filter(r => r.path && r.path.length >= 4);
    if (responders.length === routes.length &&
        responders.every((r, i) => r.src === routes[i])) return;
    responders = routes.map((r, i) => {
      const pts = [];
      for (let k = 0; k < r.path.length; k += 2) pts.push([geo.lon(r.path[k]), geo.lat(r.path[k + 1])]);
      return {
        src: r, t: track(pts, false), s: 0, flash: i * 0.37,
        /* appliances do not leave the instant the call lands */
        wait: r.turnout === undefined ? 1.5 : r.turnout,
        emergency: r.emergency !== false
      };
    }).filter(Boolean);
  }
  function stepResponders(dt) {
    for (const r of responders) {
      r.flash = (r.flash + dt * 3.4) % 1;
      if (r.wait > 0) { r.wait -= dt / 60; continue; }
      r.s += 17 * dt;
      if (r.s > r.t.total) { r.s = 0; r.wait = 1.0; }
    }
  }

  /* ==================================================================== TICK */
  let rebuildIn = 0;
  M.update = function (dtReal) {
    const dt = Math.min(0.12, dtReal) * cfg.speed;
    rebuildIn -= dtReal;
    if (rebuildIn <= 0) { syncVehicles(); rebuildIn = 2.5; }
    if (MT.layerOn('traffic_flow')) for (let i = 0; i < vehicles.length; i++) stepVehicle(vehicles[i], dt);
    if (MT.layerOn('trains')) for (let i = 0; i < trains.length; i++) stepTrain(trains[i], dt);
    if (MT.layerOn('aircraft')) for (let i = 0; i < aircraft.length; i++) stepAircraft(aircraft[i], dt);
    if (MT.layerOn('vessels')) for (let i = 0; i < vessels.length; i++) stepVessel(vessels[i], dt);
    syncResponders(); stepResponders(dt);
    rainPhase = (rainPhase + dtReal) % 1000;
  };
  /** Force an immediate re-seed — called when a scenario changes the network. */
  M.resync = function () { rebuildIn = 0; };

  /* ================================================================ COLLECT */
  const R = () => MT.render.internals;
  const sp = { x: 0, y: 0, d: 0 };

  M.collect = function (items) {
    const I = R(), cam = MT.cam;
    const vr = cam.dist * 2.4 + 6000, vr2 = vr * vr;

    if (MT.layerOn('traffic_flow')) {
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i], e = G.edges[v.e];
        if (!e) continue;
        const A = v.fwd ? G.nodes[e.a] : G.nodes[e.b];
        const B = v.fwd ? G.nodes[e.b] : G.nodes[e.a];
        const f = v.s / e.len;
        const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
        /* India drives on the left, so offset to the left of travel */
        const lx = dy / L, ly = -dx / L;
        /* lanes spread across the left half of the drawn carriageway, and a
           vehicle never hangs over the kerb */
        const rh = I.roadHalf ? I.roadHalf(e.cls) : 12;
        const nl = Math.max(1, Math.min(3, e.lanes || 1));
        const cw = (CAR_DIM[v.kind] || CAR_DIM.car)[1] * VEH_SCALE / 2;
        const off = Math.min(rh - cw - 0.5, rh * (Math.min(v.lane, nl - 1) + 0.5) / nl);
        const x = A.x + dx * f - lx * off, y = A.y + dy * f - ly * off;
        const ddx = x - cam.tx, ddy = y - cam.ty;
        if (ddx * ddx + ddy * ddy > vr2) continue;
        /* on a bridge, ride the deck: it ramps from grade to deck height */
        const za = v.fwd ? e.za : e.zb, zb = v.fwd ? e.zb : e.za;
        const vz = (za || 0) + ((zb || 0) - (za || 0)) * f + 0.4;
        I.proj(x, y, vz, sp);
        if (sp.d < 120) continue;
        if (sp.x < -20 || sp.x > I.W + 20 || sp.y < -20 || sp.y > I.H + 20) continue;
        items.push({ d: sp.d, t: 4, k: 0, x, y, z: vz,
                     hx: dx / L, hy: dy / L, v, f: e.tunnel ? 0.28 : undefined });   // in a tunnel: seen faintly, as if through the ground
      }
    }
    if (MT.layerOn('trains')) {
      for (const tr of trains) {
        if (tr.ug) continue;                           // runs in tunnel: not visible from above
        const p = at(tr.t, tr.s);
        const ddx = p.x - cam.tx, ddy = p.y - cam.ty;
        if (ddx * ddx + ddy * ddy > vr2 * 1.6) continue;
        I.proj(p.x, p.y, tr.z, sp);
        const nearT = (tr.len || 200) * 0.5 + 130;       // whole rake in front of the eye
        if (sp.d < nearT) continue;
        items.push({ d: sp.d, t: 4, k: 1, x: p.x, y: p.y, z: tr.z, hx: p.hx, hy: p.hy, tr,
                     f: Math.min(1, (sp.d - nearT) / 120) });
      }
    }
    if (MT.layerOn('vessels')) {
      for (const v of vessels) {
        I.proj(v.x, v.y, 1.5, sp);
        /* A ship is long: testing only its midpoint let a 400 m hull sit with
           its bow behind the camera, and that projects to a screen-filling
           shape (a full-screen blue flash). Keep the whole hull and its wake
           in front of the eye, fading out as it nears that limit. */
        const nearV = v.size * 0.55 + 160;           // bow and stern both stay in front of the eye
        if (sp.d < nearV) continue;
        items.push({ d: sp.d, t: 4, k: 2, x: v.x, y: v.y, z: 1.5, hx: v.hx, hy: v.hy, ve: v,
                     f: Math.min(1, (sp.d - nearV) / 150) });
      }
    }
    if (MT.layerOn('aircraft')) {
      /* Buildings are drawn taller than life at overview zoom (the readout
         shows the factor); aircraft are lifted by the same exaggeration of the
         structures beneath them, so a plane never appears inside a tower. */
      const lift = ((MT.state.vscale || 1) - 1);
      for (const a of aircraft) {
        const zd = a.z + (a.ceilNear || 0) * lift;
        I.proj(a.x, a.y, zd, sp);
        /* Only a followed aircraft may come right up to the lens. Any other one
           passing near the camera would have part of its airframe behind the
           eye, which projects to a screen-filling shape: a full-screen flash.
           Those fade out as they approach and are dropped before that point. */
        const follow = MT.render && MT.render.following && MT.render.following();
        const near = follow ? 25 : 300;
        if (sp.d < near) continue;
        const fade = follow ? 1 : Math.min(1, (sp.d - near) / 400);
        items.push({ d: sp.d, t: 4, k: 3, x: a.x, y: a.y, z: zd, hx: a.hx, hy: a.hy, ac: a, lift: (a.ceilNear || 0) * lift, f: fade });
      }
    }
    for (const r of responders) {
      if (r.wait > 0) continue;
      const p = at(r.t, r.s);
      I.proj(p.x, p.y, 3, sp);
      if (sp.d > 120) items.push({ d: sp.d - 30, t: 4, k: 4, x: p.x, y: p.y, z: 3, hx: p.hx, hy: p.hy, r });
    }
  };

  /* =================================================================== DRAW */
  const VEH_FAST = [214, 226, 244], VEH_MID = [237, 174, 69], VEH_SLOW = [236, 95, 112];
  const a1 = { x: 0, y: 0, d: 0 }, a2 = { x: 0, y: 0, d: 0 }, a3 = { x: 0, y: 0, d: 0 };
  const CB = [], CT = [];
  for (let i = 0; i < 4; i++) { CB.push({ x: 0, y: 0, d: 0 }); CT.push({ x: 0, y: 0, d: 0 }); }

  /* ------------------------------------------------ holographic airliner ---
     A narrow-body airliner at true size (44 m long, 40 m span) built as a
     white wireframe: a lofted fuselage of ring frames and stringers with an
     upswept tail cone, swept low wings with ribs and spars, a tailplane, a
     fin and two under-wing engines with glowing intakes. Close up it is a
     model you can orbit; far away it falls back to a symbol. Generic type —
     no airline, livery or registration, because none of this is a real flight. */
  const AL = 44, AR = 2.05, ASPAN = 40;
  const acP = { x: 0, y: 0, d: 0 }, acQ = { x: 0, y: 0, d: 0 };
  function acFrame(it, a) {
    const th = a.pitch || 0, c = Math.cos(th), s2 = Math.sin(th);
    return { fx: it.hx * c, fy: it.hy * c, fz: s2, rx: it.hy, ry: -it.hx, ux: -it.hx * s2, uy: -it.hy * s2, uz: c };
  }
  function acPt(I, it, F, al, lat, up, out) {
    return I.proj(it.x + F.fx * al + F.rx * lat + F.ux * up,
                  it.y + F.fy * al + F.ry * lat + F.uy * up,
                  it.z + F.fz * al + F.uz * up, out);
  }
  function fuseR(f) {                                  // f: 0 tail → 1 nose
    if (f > 0.86) { const t = (f - 0.86) / 0.14; return AR * Math.sqrt(Math.max(0, 1 - t * t * t)); }
    if (f < 0.22) { const t = f / 0.22; return AR * (0.26 + 0.74 * t); }
    return AR;
  }
  const fuseUp = f => f < 0.22 ? AR * 0.6 * (1 - f / 0.22) : 0;   // the tail cone sweeps up

  function drawAirliner(I, ctx, it, a, fg) {
    const F = acFrame(it, a), al = 1 - fg;
    const W = 'rgba(236,246,255,';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    const poly = (pts, close) => {
      ctx.beginPath();
      pts.forEach((p, i) => { acPt(I, it, F, p[0], p[1], p[2], acP); i ? ctx.lineTo(acP.x, acP.y) : ctx.moveTo(acP.x, acP.y); });
      if (close) ctx.closePath();
    };
    /* fuselage: frames */
    const NS = 15, NR = 12;
    ctx.strokeStyle = W + (0.42 * al).toFixed(3) + ')'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < NS; k++) {
      const f = 0.02 + 0.96 * k / (NS - 1), r = fuseR(f), uc = fuseUp(f), aa = -AL / 2 + f * AL;
      if (r < 0.1) continue;
      for (let q = 0; q <= NR; q++) {
        const t = q / NR * Math.PI * 2;
        acPt(I, it, F, aa, Math.cos(t) * r, uc + Math.sin(t) * r, acP);
        q ? ctx.lineTo(acP.x, acP.y) : ctx.moveTo(acP.x, acP.y);
      }
    }
    ctx.stroke();
    /* fuselage: stringers, brighter along the crown and the belly */
    for (let q = 0; q < NR; q++) {
      const t = q / NR * Math.PI * 2;
      ctx.strokeStyle = W + ((q === 3 || q === 9 ? 0.95 : 0.55) * al).toFixed(3) + ')';
      ctx.lineWidth = q === 3 || q === 9 ? 1.4 : 1;
      ctx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const f = k / 30, r = fuseR(f), uc = fuseUp(f), aa = -AL / 2 + f * AL;
        acPt(I, it, F, aa, Math.cos(t) * r, uc + Math.sin(t) * r, acP);
        k ? ctx.lineTo(acP.x, acP.y) : ctx.moveTo(acP.x, acP.y);
      }
      ctx.stroke();
    }
    /* cockpit windows */
    ctx.strokeStyle = W + (0.9 * al).toFixed(3) + ')'; ctx.lineWidth = 1.2;
    poly([[AL / 2 - 4.4, -1.1, 1.0], [AL / 2 - 3.2, -0.9, 1.25], [AL / 2 - 3.2, 0.9, 1.25], [AL / 2 - 4.4, 1.1, 1.0]], false);
    ctx.stroke();
    /* wings: outline, ribs, spars; faint fill so the surface reads */
    const wa = 1.5, wz = -AR * 0.55, root = 7.2, tip = 2.1, sweep = 7.5, dih = 1.6;
    for (const sd of [1, -1]) {
      const le0 = [wa + root / 2, sd * AR * 0.9, wz], te0 = [wa - root / 2, sd * AR * 0.9, wz];
      const le1 = [wa + root / 2 - sweep, sd * ASPAN / 2, wz + dih], te1 = [wa + root / 2 - sweep - tip, sd * ASPAN / 2, wz + dih];
      poly([le0, le1, te1, te0], true);
      ctx.fillStyle = W + (0.07 * al).toFixed(3) + ')'; ctx.fill();
      ctx.strokeStyle = W + (0.92 * al).toFixed(3) + ')'; ctx.lineWidth = 1.3; ctx.stroke();
      ctx.strokeStyle = W + (0.4 * al).toFixed(3) + ')'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k < 7; k++) {
        const f = k / 7;
        const L = le0.map((v, i) => v + (le1[i] - v) * f), T = te0.map((v, i) => v + (te1[i] - v) * f);
        acPt(I, it, F, L[0], L[1], L[2], acP); acPt(I, it, F, T[0], T[1], T[2], acQ);
        ctx.moveTo(acP.x, acP.y); ctx.lineTo(acQ.x, acQ.y);
      }
      for (const g of [0.3, 0.68]) {
        const A0 = le0.map((v, i) => v + (te0[i] - v) * g), A1 = le1.map((v, i) => v + (te1[i] - v) * g);
        acPt(I, it, F, A0[0], A0[1], A0[2], acP); acPt(I, it, F, A1[0], A1[1], A1[2], acQ);
        ctx.moveTo(acP.x, acP.y); ctx.lineTo(acQ.x, acQ.y);
      }
      ctx.stroke();
      /* winglet */
      ctx.strokeStyle = W + (0.85 * al).toFixed(3) + ')'; ctx.lineWidth = 1.2;
      poly([le1, [le1[0] - 1.6, le1[1], le1[2] + 2.4], [te1[0] + 0.2, te1[1], te1[2] + 2.2], te1], false); ctx.stroke();
      /* engine: nacelle rings, stringers, a bright intake and a pylon */
      const ea = wa + root / 2 + 1.2, el = sd * 6.4, ez = wz - 1.9, er = 1.08, eL = 4.4;
      ctx.strokeStyle = W + (0.6 * al).toFixed(3) + ')'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const k of [0, 0.5, 1]) for (let q = 0; q <= 12; q++) {
        const t = q / 12 * Math.PI * 2, rr = er * (k === 1 ? 0.78 : 1);
        acPt(I, it, F, ea - eL * k, el + Math.cos(t) * rr, ez + Math.sin(t) * rr, acP);
        q ? ctx.lineTo(acP.x, acP.y) : ctx.moveTo(acP.x, acP.y);
      }
      for (let q = 0; q < 8; q++) {
        const t = q / 8 * Math.PI * 2;
        acPt(I, it, F, ea, el + Math.cos(t) * er, ez + Math.sin(t) * er, acP);
        acPt(I, it, F, ea - eL, el + Math.cos(t) * er * 0.78, ez + Math.sin(t) * er * 0.78, acQ);
        ctx.moveTo(acP.x, acP.y); ctx.lineTo(acQ.x, acQ.y);
      }
      acPt(I, it, F, ea - eL * 0.4, el, ez + er, acP); acPt(I, it, F, ea - eL * 0.6, el, wz, acQ);
      ctx.moveTo(acP.x, acP.y); ctx.lineTo(acQ.x, acQ.y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(170,230,255,' + (0.95 * al).toFixed(3) + ')'; ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let q = 0; q <= 14; q++) {
        const t = q / 14 * Math.PI * 2;
        acPt(I, it, F, ea + 0.05, el + Math.cos(t) * er * 0.86, ez + Math.sin(t) * er * 0.86, acP);
        q ? ctx.lineTo(acP.x, acP.y) : ctx.moveTo(acP.x, acP.y);
      }
      ctx.stroke();
      /* tailplane */
      const ta = -AL / 2 + 3.4;
      ctx.strokeStyle = W + (0.85 * al).toFixed(3) + ')'; ctx.lineWidth = 1.2;
      poly([[ta + 2.2, sd * 0.8, AR * 0.45], [ta - 1.4, sd * 6.4, AR * 0.6], [ta - 2.8, sd * 6.4, AR * 0.6], [ta - 1.6, sd * 0.8, AR * 0.45]], true);
      ctx.fillStyle = W + (0.07 * al).toFixed(3) + ')'; ctx.fill(); ctx.stroke();
    }
    /* fin */
    const fa = -AL / 2 + 4.2;
    poly([[fa + 3.6, 0, AR * 0.95], [fa - 1.8, 0, AR + 7.2], [fa - 4.0, 0, AR + 7.2], [fa - 3.0, 0, AR * 0.8]], true);
    ctx.fillStyle = W + (0.08 * al).toFixed(3) + ')'; ctx.fill();
    ctx.strokeStyle = W + (0.92 * al).toFixed(3) + ')'; ctx.lineWidth = 1.3; ctx.stroke();
    /* lights: red port, green starboard, white strobes, red beacon */
    const lamp = (p, col, r) => { acPt(I, it, F, p[0], p[1], p[2], acP); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(acP.x, acP.y, r, 0, 6.283); ctx.fill(); };
    const tipA = wa + root / 2 - sweep - 0.4;
    lamp([tipA, -ASPAN / 2, wz + dih], 'rgba(255,80,96,' + al.toFixed(3) + ')', 2.2);
    lamp([tipA, ASPAN / 2, wz + dih], 'rgba(80,240,150,' + al.toFixed(3) + ')', 2.2);
    if (a.strobe < 0.14) { lamp([tipA, -ASPAN / 2, wz + dih], 'rgba(255,255,255,.95)', 4.5); lamp([tipA, ASPAN / 2, wz + dih], 'rgba(255,255,255,.95)', 4.5); }
    if (a.strobe > 0.5 && a.strobe < 0.62) lamp([-2, 0, AR + 0.3], 'rgba(255,60,70,.95)', 3);
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ------------------------------------------------ holographic train ------
     Each coach is an extruded cross-section (skirt, bodyside, curved roof)
     placed on the track at its own position and heading, so a twelve-car
     local bends round a curve instead of cutting the chord. The end cars
     carry a tapered cab with a windscreen. Length is true to the rake; the
     cross-section is exaggerated, as buildings and cars are, so the train can
     be read at city scale. Gold, so it is neither a building (cyan) nor the
     violet guideway it runs on. */
  const TRAIN_XS = 2.2;
  const TRAIN_RGB = '255,200,74';
  const TSEC = [[-.92, .10], [-1, .30], [-1, .80], [-.80, .97],
                [.80, .97], [1, .80], [1, .30], [.92, .10]];       // [y, z] closed loop
  const tRing = [];
  for (let r = 0; r < 6; r++) tRing.push(TSEC.map(() => ({ x: 0, y: 0, d: 0 })));
  const tWin = [];                                   // window-band lines, 4 per ring
  for (let r = 0; r < 6; r++) tWin.push([0, 1, 2, 3].map(() => ({ x: 0, y: 0, d: 0 })));
  const tQ0 = { x: 0, y: 0, d: 0 }, tQ1 = { x: 0, y: 0, d: 0 };
  const coachPos = [];
  for (let i = 0; i < 16; i++) coachPos.push({ x: 0, y: 0, fx: 1, fy: 0 });

  /** Ring stations along one coach: [along offset, width scale, height scale]. */
  function coachRings(cl, cabFront, cabRear, full) {
    const h = cl / 2 - 0.45, nose = 4.2 * TRAIN_XS;
    const R = [];
    if (cabRear) R.push([-h, .80, .72], [-h + nose * .5, .95, .90], [-h + nose, 1, 1]);
    else R.push([-h, 1, 1]);
    if (full && !cabRear && !cabFront) R.push([-h / 3, 1, 1], [h / 3, 1, 1]);
    if (cabFront) R.push([h - nose, 1, 1], [h - nose * .5, .95, .90], [h, .80, .72]);
    else R.push([h, 1, 1]);
    return R;
  }

  function drawTrainHolo(I, ctx, it, tr, fg) {
    const al = 1 - fg;
    const nC = tr.coaches || 10, cl = tr.len / nC, dir = tr.dir || 1;
    const W = (tr.kind === 'metro' ? 3.2 : 3.66) / 2 * TRAIN_XS;
    const H = (tr.kind === 'metro' ? 3.9 : 3.8) * TRAIN_XS;
    let base = tr.z;
    /* coach centres and headings, following the track */
    for (let c = 0; c < nC; c++) {
      const sc = tr.s + dir * (tr.len / 2 - (c + 0.5) * cl);
      const p = at(tr.t, sc), q = coachPos[c], o = tr.lane || 0;
      q.x = p.x - p.hy * o; q.y = p.y + p.hx * o; q.z = p.z; q.fx = p.hx * dir; q.fy = p.hy * dir;
    }
    base = coachPos[0].z;
    /* how big is one coach on screen? decides the level of detail */
    const q0 = coachPos[0];
    I.proj(q0.x - q0.fx * cl / 2, q0.y - q0.fy * cl / 2, base, tQ0);
    I.proj(q0.x + q0.fx * cl / 2, q0.y + q0.fy * cl / 2, base, tQ1);
    const cpx = Math.hypot(tQ1.x - tQ0.x, tQ1.y - tQ0.y);
    const scale = I.focal / Math.max(1, it.d);

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';

    /* crowding glow beneath the rake (an assumed load pattern, not a count) */
    const ld = tr.load === undefined ? 0.4 : tr.load;
    const lc = ld > 1.0 ? '255,96,110' : ld > 0.75 ? '255,140,70' : ld > 0.5 ? '255,196,84' : '110,236,170';
    ctx.strokeStyle = 'rgba(' + lc + ',' + (0.07 * al).toFixed(3) + ')';
    if (cpx >= 6) for (const k of [2.6, 1.7]) {
      ctx.lineWidth = Math.max(3, W * k * scale);
      ctx.beginPath();
      for (let c = 0; c < nC; c++) {
        const q = coachPos[c];
        I.proj(q.x, q.y, q.z, tQ0);
        if (c === 0) ctx.moveTo(tQ0.x, tQ0.y); else ctx.lineTo(tQ0.x, tQ0.y);
      }
      ctx.stroke();
    }

    /* far away: a gold line through the coach centres, still following curves */
    if (cpx < 6) {
      /* no additive blending here: at a junction like Dadar a dozen distant
         rakes overlap, and added light burns out to white */
      ctx.globalCompositeOperation = 'source-over';
      I.proj(q0.x + q0.fx * cl / 2, q0.y + q0.fy * cl / 2, base + H * .5, tQ1);
      ctx.strokeStyle = 'rgba(255,184,48,' + (0.32 * al).toFixed(3) + ')';
      ctx.lineWidth = Math.max(4.5, W * 2.4 * scale);
      ctx.beginPath(); ctx.moveTo(tQ1.x, tQ1.y);
      for (let c = 0; c < nC; c++) { const q = coachPos[c]; I.proj(q.x, q.y, q.z + H * .5, tQ0); ctx.lineTo(tQ0.x, tQ0.y); }
      const qL = coachPos[nC - 1];
      I.proj(qL.x - qL.fx * cl / 2, qL.y - qL.fy * cl / 2, qL.z + H * .5, tQ0); ctx.lineTo(tQ0.x, tQ0.y);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255,206,92,' + (0.95 * al).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1.8, W * 0.9 * scale);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,250,230,' + (0.95 * al).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(tQ1.x, tQ1.y, Math.min(5, Math.max(1.6, W * scale)), 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      return { cpx, top: tQ1.y };
    }

    const full = cpx >= 18;
    let topY = 1e9;
    /* draw the coaches rear-first, so the leading cab lands on top */
    for (let c = nC - 1; c >= 0; c--) {
      const q = coachPos[c], nx = q.fy, ny = -q.fx;
      base = q.z;
      const R = coachRings(cl, c === 0, c === nC - 1, full);
      const nR = R.length;
      for (let r = 0; r < nR; r++) {
        const [a, sw, sh] = R[r];
        const cx = q.x + q.fx * a, cy = q.y + q.fy * a;
        for (let k = 0; k < 8; k++) {
          const yy = TSEC[k][0] * W * sw, zz = base + TSEC[k][1] * H * sh;
          I.proj(cx + nx * yy, cy + ny * yy, zz, tRing[r][k]);
        }
        if (full) {
          const wy = W * sw;
          I.proj(cx + nx * wy, cy + ny * wy, base + .52 * H * sh, tWin[r][0]);
          I.proj(cx + nx * wy, cy + ny * wy, base + .76 * H * sh, tWin[r][1]);
          I.proj(cx - nx * wy, cy - ny * wy, base + .52 * H * sh, tWin[r][2]);
          I.proj(cx - nx * wy, cy - ny * wy, base + .76 * H * sh, tWin[r][3]);
        }
        topY = Math.min(topY, tRing[r][3].y, tRing[r][4].y);
      }
      /* dark body shell, so the far side of the coach sits behind the near */
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(38,24,4,' + (0.58 * al).toFixed(3) + ')';
      ctx.beginPath();
      for (let r = 0; r + 1 < nR; r++) {
        for (let k = 1; k < 6; k++) {
          const A = tRing[r][k], B = tRing[r][k + 1], C = tRing[r + 1][k + 1], D = tRing[r + 1][k];
          ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.lineTo(D.x, D.y); ctx.closePath();
        }
      }
      ctx.fill();
      /* the body itself glows gold, as in a lit hologram, which is also what
         keeps a rake legible at district distance */
      ctx.fillStyle = 'rgba(' + TRAIN_RGB + ',' + ((full ? 0.07 : 0.16) * al).toFixed(3) + ')';
      ctx.fill();
      /* glazing: the window band, and the windscreen on a leading cab */
      if (full) {
        ctx.fillStyle = 'rgba(' + TRAIN_RGB + ',' + (0.10 * al).toFixed(3) + ')';
        ctx.beginPath();
        for (let r = 0; r + 1 < nR; r++) {
          for (const [lo, hi] of [[0, 1], [2, 3]]) {
            ctx.moveTo(tWin[r][lo].x, tWin[r][lo].y); ctx.lineTo(tWin[r + 1][lo].x, tWin[r + 1][lo].y);
            ctx.lineTo(tWin[r + 1][hi].x, tWin[r + 1][hi].y); ctx.lineTo(tWin[r][hi].x, tWin[r][hi].y);
            ctx.closePath();
          }
        }
        ctx.fill();
      }
      if (c === 0 || c === nC - 1) {
        const F = c === 0 ? tRing[nR - 1] : tRing[0];
        ctx.fillStyle = 'rgba(' + TRAIN_RGB + ',' + ((c === 0 ? 0.30 : 0.14) * al).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(F[2].x, F[2].y); ctx.lineTo(F[3].x, F[3].y);
        ctx.lineTo(F[4].x, F[4].y); ctx.lineTo(F[5].x, F[5].y); ctx.closePath();
        ctx.fill();
      }
      /* rings: the cross-section frames */
      ctx.strokeStyle = 'rgba(' + TRAIN_RGB + ',' + (0.55 * al).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let r = 0; r < nR; r++) {
        const G = tRing[r];
        ctx.moveTo(G[0].x, G[0].y);
        for (let k = 1; k < 8; k++) ctx.lineTo(G[k].x, G[k].y);
        ctx.closePath();
      }
      /* window mullions and doors, the grid that makes it read as a coach */
      if (full && cpx > 34) {
        const nM = 8;
        for (let m = 1; m < nM; m++) {
          const f = m / nM;
          for (const [lo, hi] of [[0, 1], [2, 3]]) {
            const A = tWin[0][lo], B = tWin[nR - 1][lo], C = tWin[0][hi], D = tWin[nR - 1][hi];
            ctx.moveTo(A.x + (B.x - A.x) * f, A.y + (B.y - A.y) * f);
            ctx.lineTo(C.x + (D.x - C.x) * f, C.y + (D.y - C.y) * f);
          }
        }
      }
      ctx.stroke();
      /* long lines: skirt, bodyside, cantrail and roof, bright */
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        ctx.moveTo(tRing[0][k].x, tRing[0][k].y);
        for (let r = 1; r < nR; r++) ctx.lineTo(tRing[r][k].x, tRing[r][k].y);
      }
      if (full) for (let w = 0; w < 4; w++) {
        ctx.moveTo(tWin[0][w].x, tWin[0][w].y);
        for (let r = 1; r < nR; r++) ctx.lineTo(tWin[r][w].x, tWin[r][w].y);
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,190,60,' + (0.16 * al).toFixed(3) + ')';   // bloom
      ctx.lineWidth = full ? 4 : 3;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255,214,110,' + (0.95 * al).toFixed(3) + ')';
      ctx.lineWidth = 1.25;
      ctx.stroke();
      /* lamps: headlights on the leading cab, red tail lights on the last */
      if (c === 0 || c === nC - 1) {
        const F = c === 0 ? tRing[nR - 1] : tRing[0];
        const lr = Math.min(4, Math.max(1.4, cpx * 0.035));
        ctx.fillStyle = c === 0 ? 'rgba(255,250,230,' + (0.95 * al).toFixed(3) + ')'
                                : 'rgba(255,70,90,' + (0.9 * al).toFixed(3) + ')';
        ctx.beginPath();
        for (const [i0, i1] of [[0, 1], [7, 6]]) {
          const x = (F[i0].x * 2 + F[i1].x) / 3, y = (F[i0].y * 2 + F[i1].y) / 3;
          ctx.moveTo(x + lr, y); ctx.arc(x, y, lr, 0, 6.283);
        }
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    return { cpx, top: topY };
  }

  /* ------------------------------------------------- holographic car -------
     A lofted body rather than a box: a list of stations from the rear bumper
     to the nose, each giving the roof/deck height and width, the beltline
     height and the body width. Stroked as frames plus long lines it reads the
     way a wireframe car does: bonnet, windscreen, roof, rear deck, wheels.
     Real vehicle dimensions, then a display exaggeration (like the building
     height exaggeration) so a car can be seen on a map at city scale. */
  const VEH_SCALE = 3.8;
  /* Body styles. 'car' is the saloon; the others are drawn variants of the
     same traffic agent — the traffic model only knows car / LCV / bus. The
     taxi is Mumbai's black-and-yellow, the auto its three-wheeler. */
  const CAR_DIM = {                                   // length, width, height (m)
    car: [4.6, 1.9, 1.35], hatch: [3.9, 1.75, 1.5], suv: [4.7, 1.95, 1.75],
    taxi: [4.2, 1.7, 1.45], auto: [2.7, 1.35, 1.75],
    lcv: [6.4, 2.2, 2.5], bus: [12.0, 2.55, 3.2]
  };
  /* rows: [f along (0 rear → 1 nose), roof z, roof half-width, belt z, body half-width] */
  const PROF = {
    car: [[0, .44, .70, .42, .80], [.07, .56, .86, .53, .93], [.20, .60, .88, .56, 1],
          [.34, .95, .66, .57, 1], [.50, 1, .63, .56, 1], [.62, .90, .66, .54, .99],
          [.75, .55, .84, .51, .97], [.90, .41, .84, .39, .90], [1, .27, .70, .25, .76]],
    lcv: [[0, .96, .96, .40, .98], [.62, 1, .96, .42, 1], [.66, .92, .90, .45, 1],
          [.80, .86, .86, .46, 1], [.90, .52, .88, .42, .96], [1, .40, .80, .36, .90]],
    bus: [[0, .96, .96, .34, .98], [.04, 1, .97, .36, 1], [.96, 1, .97, .36, 1],
          [1, .94, .92, .33, .96]],
    hatch: [[0, .80, .76, .50, .86], [.06, .92, .84, .55, .95], [.20, .97, .80, .56, 1],
            [.50, 1, .72, .56, 1], [.64, .88, .72, .55, 1], [.78, .54, .86, .50, .97],
            [.92, .43, .84, .41, .90], [1, .31, .72, .29, .78]],
    suv:   [[0, .90, .86, .50, .92], [.05, .98, .90, .55, .97], [.20, 1, .90, .56, 1],
            [.55, 1, .88, .56, 1], [.70, .92, .84, .55, 1], [.80, .64, .90, .53, 1],
            [.93, .56, .90, .48, .95], [1, .46, .82, .40, .86]],
    taxi:  [[0, .46, .72, .44, .82], [.08, .58, .86, .54, .94], [.22, .62, .88, .56, 1],
            [.34, .96, .70, .57, 1], [.52, 1, .68, .56, 1], [.64, .92, .70, .54, .99],
            [.76, .58, .84, .51, .97], [.91, .44, .84, .40, .90], [1, .30, .72, .27, .78]],
    auto:  [[0, .95, .92, .34, .95], [.14, 1, .95, .38, 1], [.54, 1, .92, .38, 1],
            [.70, .96, .72, .42, .82], [.86, .62, .42, .50, .56], [1, .46, .26, .42, .34]]
  };
  const GLASS = { car: [2, 6], hatch: [1, 5], suv: [1, 5], taxi: [2, 6], auto: [2, 3], lcv: [2, 4], bus: [1, 2] };
  const WHEELS = { car: [.19, .79], hatch: [.17, .80], suv: [.18, .80], taxi: [.19, .79], auto: [.18, .88], lcv: [.17, .82], bus: [.15, .80] };
  const WHEEL_R = { car: .27, hatch: .25, suv: .27, taxi: .26, auto: .17, lcv: .16, bus: .16 };   // fraction of height
  function pickBody(r) { return r < 0.34 ? 'car' : r < 0.58 ? 'hatch' : r < 0.76 ? 'suv' : r < 0.9 ? 'taxi' : 'auto'; }
  const CLEAR = 0.12;                                      // ground clearance, fraction of height
  const CAR_RGB = '120,255,210';                           // mint: not the buildings' cyan
  const cP = [];
  for (let i = 0; i < 9; i++) cP.push([0, 1, 2, 3, 4, 5].map(() => ({ x: 0, y: 0, d: 0 })));
  const cW = []; for (let i = 0; i < 10; i++) cW.push({ x: 0, y: 0, d: 0 });
  const cWc = { x: 0, y: 0, d: 0 };

  function carDims(kind) {
    const D = CAR_DIM[kind] || CAR_DIM.car;
    return { L: D[0] * VEH_SCALE, W: D[1] * VEH_SCALE / 2, H: D[2] * VEH_SCALE };
  }

  /** Project the body stations. zs = 1 for the car, -1 for its reflection. */
  function projCar(I, it, kind, zs) {
    const { L, W, H } = carDims(kind);
    const P = PROF[kind] || PROF.car, nx = it.hy, ny = -it.hx;
    for (let i = 0; i < P.length; i++) {
      const r = P[i], a = -L / 2 + r[0] * L;
      const cx = it.x + it.hx * a, cy = it.y + it.hy * a;
      const q = cP[i], bw = r[4] * W, tw = r[2] * W;
      I.proj(cx + nx * bw, cy + ny * bw, it.z + CLEAR * H * zs, q[0]);
      I.proj(cx - nx * bw, cy - ny * bw, it.z + CLEAR * H * zs, q[1]);
      I.proj(cx + nx * bw, cy + ny * bw, it.z + r[3] * H * zs, q[2]);
      I.proj(cx - nx * bw, cy - ny * bw, it.z + r[3] * H * zs, q[3]);
      I.proj(cx + nx * tw, cy + ny * tw, it.z + r[1] * H * zs, q[4]);
      I.proj(cx - nx * tw, cy - ny * tw, it.z + r[1] * H * zs, q[5]);
    }
    return P.length;
  }

  function polyline(ctx, n, k) {
    ctx.moveTo(cP[0][k].x, cP[0][k].y);
    for (let i = 1; i < n; i++) ctx.lineTo(cP[i][k].x, cP[i][k].y);
  }

  /** Stroke the projected body. a = alpha for this pass; solid adds the shell. */
  function strokeCar(ctx, n, kind, a, solid) {
    if (a <= 0.015) return;
    if (solid) {
      /* a dark shell first, so the far side reads as behind the near side */
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(4,34,40,' + (0.62 * a).toFixed(3) + ')';
      for (const [b, t] of [[0, 4], [1, 5]]) {
        ctx.beginPath(); polyline(ctx, n, b);
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(cP[i][t].x, cP[i][t].y);
        ctx.closePath(); ctx.fill();
      }
      ctx.beginPath(); polyline(ctx, n, 4);
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(cP[i][5].x, cP[i][5].y);
      ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      /* glazing: side windows, windscreen and rear screen glow faintly */
      const g = GLASS[kind] || GLASS.car;
      ctx.fillStyle = 'rgba(' + CAR_RGB + ',' + (0.13 * a).toFixed(3) + ')';
      ctx.beginPath();
      for (let i = g[0]; i < g[1]; i++) {
        for (const [b, t] of [[2, 4], [3, 5]]) {
          ctx.moveTo(cP[i][b].x, cP[i][b].y); ctx.lineTo(cP[i + 1][b].x, cP[i + 1][b].y);
          ctx.lineTo(cP[i + 1][t].x, cP[i + 1][t].y); ctx.lineTo(cP[i][t].x, cP[i][t].y);
          ctx.closePath();
        }
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    /* frames: the cross-sections that give the wireframe its mesh */
    ctx.strokeStyle = 'rgba(' + CAR_RGB + ',' + (0.42 * a).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const q = cP[i];
      ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[2].x, q[2].y); ctx.lineTo(q[4].x, q[4].y);
      ctx.lineTo(q[5].x, q[5].y); ctx.lineTo(q[3].x, q[3].y); ctx.lineTo(q[1].x, q[1].y);
    }
    polyline(ctx, n, 0); polyline(ctx, n, 1);
    ctx.stroke();
    /* character lines: beltline and roofline, bright */
    ctx.strokeStyle = 'rgba(196,255,236,' + (0.95 * a).toFixed(3) + ')';
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    polyline(ctx, n, 2); polyline(ctx, n, 3); polyline(ctx, n, 4); polyline(ctx, n, 5);
    ctx.stroke();
  }

  /** Four spoked wheels, turning with the distance the vehicle has covered. */
  function drawWheels(I, ctx, it, kind, a, spin, zs, spokes) {
    const { L, W, H } = carDims(kind);
    const r = (WHEEL_R[kind] || WHEEL_R.car) * H;
    const nx = it.hy, ny = -it.hx;
    ctx.strokeStyle = 'rgba(206,255,240,' + (0.85 * a).toFixed(3) + ')';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const WH = WHEELS[kind] || WHEELS.car;
    for (const f of WH) {
      const sides = kind === 'auto' && f === WH[1] ? [0] : [1, -1];   // the auto's one front wheel
      for (const side of sides) {
        const a0 = -L / 2 + f * L;
        const cx = it.x + it.hx * a0 + nx * W * side, cy = it.y + it.hy * a0 + ny * W * side;
        const cz = it.z + r * zs;
        for (let k = 0; k < 10; k++) {
          const th = k / 10 * 6.2832 + spin;
          const c = Math.cos(th) * r, s = Math.sin(th) * r;
          I.proj(cx + it.hx * c, cy + it.hy * c, cz + s * zs, cW[k]);
        }
        ctx.moveTo(cW[0].x, cW[0].y);
        for (let k = 1; k < 10; k++) ctx.lineTo(cW[k].x, cW[k].y);
        ctx.closePath();
        if (spokes) {
          I.proj(cx, cy, cz, cWc);
          for (let k = 0; k < 10; k += 2) { ctx.moveTo(cWc.x, cWc.y); ctx.lineTo(cW[k].x, cW[k].y); }
        }
      }
    }
    ctx.stroke();
  }

  /* ------------------------------------------------- holographic vessel ----
     A ship is the one moving object big enough to be worth building as real
     geometry: a lofted hull of transverse frames between a keel, a waterline
     and a sheered deck, with a superstructure block aft and a mast forward.
     The hull is mirrored through the waterline for the reflection, which is
     what makes it sit *in* the water rather than on top of it. Nothing here
     is a real vessel — no AIS feed is connected — so it is drawn as a
     hologram and labelled as simulated rather than given a name. */
  const SHIP_N = 13;                                  // stations, stern → bow
  const sDk = [], sWl = [], sKl = [];                 // deck, waterline, keel
  for (let i = 0; i < SHIP_N; i++) {
    sDk.push([{ x: 0, y: 0, d: 0 }, { x: 0, y: 0, d: 0 }]);
    sWl.push([{ x: 0, y: 0, d: 0 }, { x: 0, y: 0, d: 0 }]);
    sKl.push({ x: 0, y: 0, d: 0 });
  }
  const sBox = []; for (let i = 0; i < 8; i++) sBox.push({ x: 0, y: 0, d: 0 });
  const sM0 = { x: 0, y: 0, d: 0 }, sM1 = { x: 0, y: 0, d: 0 },
        sM2 = { x: 0, y: 0, d: 0 };

  /** Beam profile: full amidships, fine at the bow, a transom at the stern. */
  function halfBeamAt(f) {
    if (f > 0.70) { const t = (f - 0.70) / 0.30; return Math.max(0.04, 1 - t * t * 0.96); }
    if (f < 0.10) { const t = f / 0.10; return 0.62 + 0.38 * t; }
    return 1;
  }
  /** Sheer: the deck lifts toward the bow and a little at the stern. */
  function sheerAt(f) {
    const b = f > 0.58 ? (f - 0.58) / 0.42 : 0;
    const s = f < 0.18 ? (0.18 - f) / 0.18 : 0;
    return 1 + 0.42 * b * b + 0.12 * s * s;
  }

  /** Project the hull for one side of the waterline. zs = 1 hull, -1 mirror. */
  function projHull(I, it, L, beam, fb, dr, zs) {
    const half = L / 2, nx = it.hy, ny = -it.hx;
    for (let i = 0; i < SHIP_N; i++) {
      const f = i / (SHIP_N - 1);
      const hb = halfBeamAt(f) * beam;
      const along = -half + f * L;
      const cut = f > 0.76 ? (f - 0.76) / 0.24 * L * 0.07 : 0;   // raked forefoot
      const ax = it.x + it.hx * along, ay = it.y + it.hy * along;
      const bx = it.x + it.hx * (along - cut), by = it.y + it.hy * (along - cut);
      const dz = fb * sheerAt(f) * zs;
      I.proj(ax + nx * hb, ay + ny * hb, dz, sDk[i][0]);
      I.proj(ax - nx * hb, ay - ny * hb, dz, sDk[i][1]);
      const wb = hb * 0.87;
      I.proj(bx + nx * wb, by + ny * wb, 0, sWl[i][0]);
      I.proj(bx - nx * wb, by - ny * wb, 0, sWl[i][1]);
      I.proj(bx, by, -dr * zs, sKl[i]);
    }
  }

  /** Project an on-deck box given fractions along the hull. */
  function projBox(I, it, L, beam, f0, f1, hw, z0, z1, zs) {
    const half = L / 2, nx = it.hy, ny = -it.hx;
    const xs = [-half + f0 * L, -half + f1 * L];
    const zz = [z0 * zs, z1 * zs];
    let k = 0;
    for (let zi = 0; zi < 2; zi++) {
      for (const [sa, sb] of [[0, 1], [1, 1], [1, -1], [0, -1]]) {
        const a = xs[sa], w = hw * sb;
        I.proj(it.x + it.hx * a + nx * w, it.y + it.hy * a + ny * w, zz[zi], sBox[k++]);
      }
    }
  }

  function strokeBox(ctx) {
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      ctx.moveTo(sBox[i].x, sBox[i].y); ctx.lineTo(sBox[j].x, sBox[j].y);
      ctx.moveTo(sBox[4 + i].x, sBox[4 + i].y); ctx.lineTo(sBox[4 + j].x, sBox[4 + j].y);
      ctx.moveTo(sBox[i].x, sBox[i].y); ctx.lineTo(sBox[4 + i].x, sBox[4 + i].y);
    }
    ctx.stroke();
  }

  /** One pass over the hull wireframe. a = overall alpha for this pass. */
  function strokeHull(ctx, a, solid) {
    if (a <= 0.015) return;
    if (solid) {                                       // translucent shell
      ctx.fillStyle = 'rgba(14,74,112,' + (0.34 * a).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(sDk[0][0].x, sDk[0][0].y);
      for (let i = 1; i < SHIP_N; i++) ctx.lineTo(sDk[i][0].x, sDk[i][0].y);
      for (let i = SHIP_N - 1; i >= 0; i--) ctx.lineTo(sWl[i][0].x, sWl[i][0].y);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sDk[0][0].x, sDk[0][0].y);
      for (let i = 1; i < SHIP_N; i++) ctx.lineTo(sDk[i][0].x, sDk[i][0].y);
      for (let i = SHIP_N - 1; i >= 0; i--) ctx.lineTo(sDk[i][1].x, sDk[i][1].y);
      ctx.closePath(); ctx.fill();
    }
    /* transverse frames and the keel: the mesh that reads as a hull */
    ctx.strokeStyle = 'rgba(96,206,244,' + (0.46 * a).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < SHIP_N; i++) {
      ctx.moveTo(sDk[i][0].x, sDk[i][0].y);
      ctx.lineTo(sWl[i][0].x, sWl[i][0].y);
      ctx.lineTo(sKl[i].x, sKl[i].y);
      ctx.lineTo(sWl[i][1].x, sWl[i][1].y);
      ctx.lineTo(sDk[i][1].x, sDk[i][1].y);
    }
    for (let s = 0; s < 2; s++) {                     // longitudinal stringers
      for (let L = 1; L <= 3; L++) {
        const t = L / 4;
        ctx.moveTo(sWl[0][s].x + (sDk[0][s].x - sWl[0][s].x) * t,
                   sWl[0][s].y + (sDk[0][s].y - sWl[0][s].y) * t);
        for (let i = 1; i < SHIP_N; i++)
          ctx.lineTo(sWl[i][s].x + (sDk[i][s].x - sWl[i][s].x) * t,
                     sWl[i][s].y + (sDk[i][s].y - sWl[i][s].y) * t);
      }
      for (let L = 1; L <= 2; L++) {                   // and below the water
        const t = L / 3;
        ctx.moveTo(sWl[0][s].x + (sKl[0].x - sWl[0][s].x) * t,
                   sWl[0][s].y + (sKl[0].y - sWl[0][s].y) * t);
        for (let i = 1; i < SHIP_N; i++)
          ctx.lineTo(sWl[i][s].x + (sKl[i].x - sWl[i][s].x) * t,
                     sWl[i][s].y + (sKl[i].y - sWl[i][s].y) * t);
      }
    }
    ctx.moveTo(sKl[0].x, sKl[0].y);
    for (let i = 1; i < SHIP_N; i++) ctx.lineTo(sKl[i].x, sKl[i].y);
    ctx.stroke();
    /* waterline and sheer line, bright */
    ctx.strokeStyle = 'rgba(158,242,255,' + (0.88 * a).toFixed(3) + ')';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let s = 0; s < 2; s++) {
      ctx.moveTo(sWl[0][s].x, sWl[0][s].y);
      for (let i = 1; i < SHIP_N; i++) ctx.lineTo(sWl[i][s].x, sWl[i][s].y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(206,250,255,' + (1.0 * a).toFixed(3) + ')';
    ctx.lineWidth = 1.6;
    ctx.beginPath();                                    // deck edge, closed
    ctx.moveTo(sDk[0][0].x, sDk[0][0].y);
    for (let i = 1; i < SHIP_N; i++) ctx.lineTo(sDk[i][0].x, sDk[i][0].y);
    for (let i = SHIP_N - 1; i >= 0; i--) ctx.lineTo(sDk[i][1].x, sDk[i][1].y);
    ctx.closePath(); ctx.stroke();
  }

  M.draw = function (it) {
    const I = R(), ctx = I.ctx;
    const fg = I.fogAmt(it.d);
    const scale = I.focal / it.d;

    if (it.k === 0) {                                   /* ---------- vehicle */
      const v = it.v;
      const kind = v.kind === 'car' ? (CAR_DIM[v.body] ? v.body : 'car') : (CAR_DIM[v.kind] ? v.kind : 'car');
      const len = CAR_DIM[kind][0] * VEH_SCALE;
      const half = len / 2;
      I.proj(it.x - it.hx * half, it.y - it.hy * half, it.z, a1);
      I.proj(it.x + it.hx * half, it.y + it.hy * half, it.z, a2);
      const r = v.spd;
      if (a1.d < 60 || a2.d < 60) return;                // at the near plane
      const pxLen = Math.hypot(a2.x - a1.x, a2.y - a1.y);
      const HOLO = MT.isHolo && MT.isHolo();

      /* Close enough to resolve: the wireframe car. */
      if (HOLO && pxLen > 14) {
        const al = 1 - fg;
        const { W, H } = carDims(kind);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        /* speed-coded glow on the carriageway beneath it — the only place the
           modelled speed is shown, so the body keeps one colour */
        const glow = r > 0.55 ? '92,236,160' : r > 0.32 ? '255,186,84' : '255,96,110';
        ctx.globalCompositeOperation = 'lighter';
        /* three stacked round-ended strokes, inset from the bumpers, give a
           feathered pool of light rather than a hard-edged rectangle */
        {
          const ix = (a2.x - a1.x) * 0.18, iy = (a2.y - a1.y) * 0.18;
          const bw = Math.max(3, W * 2.0 * scale);
          ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(' + glow + ',' + (0.075 * al).toFixed(3) + ')';
          for (const k of [1.35, 0.95, 0.55]) {
            ctx.lineWidth = bw * k;
            ctx.beginPath(); ctx.moveTo(a1.x + ix, a1.y + iy); ctx.lineTo(a2.x - ix, a2.y - iy); ctx.stroke();
          }
        }
        const spin = -(v.s || 0) / ((WHEEL_R[kind] || .27) * H);
        /* the reflection, on the ground only — a car on a flyover has none */
        if (pxLen > 56 && it.z < 2) {
          const n0 = projCar(I, it, kind, -1);
          strokeCar(ctx, n0, kind, al * 0.22, false);
          drawWheels(I, ctx, it, kind, al * 0.22, spin, -1, false);
        }
        const n = projCar(I, it, kind, 1);
        strokeCar(ctx, n, kind, al, true);
        if (pxLen > 22) drawWheels(I, ctx, it, kind, al, spin, 1, pxLen > 40);
        /* headlamps at the nose, tail lamps at the rear */
        const fr = cP[n - 1], rr = cP[0], lr = Math.min(3.2, Math.max(1.2, pxLen * 0.035));
        ctx.fillStyle = 'rgba(240,255,250,' + (0.95 * al).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(fr[2].x + lr, fr[2].y); ctx.arc(fr[2].x, fr[2].y, lr, 0, 6.283);
        ctx.moveTo(fr[3].x + lr, fr[3].y); ctx.arc(fr[3].x, fr[3].y, lr, 0, 6.283);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,70,96,' + (0.9 * al).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(rr[2].x + lr, rr[2].y); ctx.arc(rr[2].x, rr[2].y, lr, 0, 6.283);
        ctx.moveTo(rr[3].x + lr, rr[3].y); ctx.arc(rr[3].x, rr[3].y, lr, 0, 6.283);
        ctx.fill();
        /* LED light bars across the nose and the tail */
        if (pxLen > 30) {
          ctx.lineWidth = Math.min(3, Math.max(1.2, pxLen * 0.02));
          ctx.strokeStyle = 'rgba(235,255,250,' + (0.85 * al).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(fr[2].x, fr[2].y); ctx.lineTo(fr[3].x, fr[3].y); ctx.stroke();
          ctx.strokeStyle = 'rgba(255,60,90,' + (0.85 * al).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(rr[2].x, rr[2].y); ctx.lineTo(rr[3].x, rr[3].y); ctx.stroke();
        }
        /* taxi: yellow roof and a lit roof sign; auto: a yellow canopy */
        if (kind === 'taxi' || kind === 'auto') {
          const i0 = kind === 'taxi' ? 3 : 0, i1 = kind === 'taxi' ? 5 : 3;
          ctx.fillStyle = 'rgba(255,208,60,' + ((kind === 'auto' ? 0.42 : 0.5) * al).toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(cP[i0][4].x, cP[i0][4].y);
          for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(cP[i][4].x, cP[i][4].y);
          for (let i = i1; i >= i0; i--) ctx.lineTo(cP[i][5].x, cP[i][5].y);
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = 'rgba(255,224,120,' + (0.9 * al).toFixed(3) + ')'; ctx.lineWidth = 1.2; ctx.stroke();
          if (kind === 'taxi' && pxLen > 26) {
            const { H: Hh } = carDims(kind);
            const m = cP[4], cx = (m[4].x + m[5].x) / 2, cy = (m[4].y + m[5].y) / 2;
            const sx = Math.abs(m[4].x - m[5].x) * 0.3 + 2, sh = Math.max(2, Hh * scale * 0.14);
            ctx.fillStyle = 'rgba(255,230,120,' + (0.9 * al).toFixed(3) + ')';
            ctx.fillRect(cx - sx, cy - sh * 1.6, sx * 2, sh);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
        return;
      }

      /* Far away a car is sub-pixel, so it becomes a symbol: a warm streak,
         held to a minimum length and kept distinct from the road beneath. */
      const MINPX = 7.0;
      if (pxLen < MINPX) {
        const ux = pxLen > 0.001 ? (a2.x - a1.x) / pxLen : 1;
        const uy = pxLen > 0.001 ? (a2.y - a1.y) / pxLen : 0;
        const mx = (a1.x + a2.x) / 2, my = (a1.y + a2.y) / 2;
        a1.x = mx - ux * MINPX / 2; a1.y = my - uy * MINPX / 2;
        a2.x = mx + ux * MINPX / 2; a2.y = my + uy * MINPX / 2;
      }
      ctx.lineCap = 'round';
      if (HOLO) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(' + CAR_RGB + ',' + (0.5 * (1 - fg)).toFixed(3) + ')';
        ctx.lineWidth = Math.min(Math.max(4.2, 6.4 * scale), 14);
        ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
        ctx.strokeStyle = 'rgba(214,255,240,' + (0.95 * (1 - fg)).toFixed(3) + ')';
        ctx.lineWidth = Math.min(Math.max(1.7, 2.4 * scale), 5);
        ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
      const c = r > 0.7 ? VEH_FAST : r > 0.42 ? VEH_MID : VEH_SLOW;
      const bright = 0.58 + 0.42 * MT.sun.day;
      ctx.strokeStyle = I.fogged(c[0] * bright, c[1] * bright, c[2] * bright, fg * 0.7);
      ctx.lineWidth = Math.max(2.3, (v.kind === 'car' ? 2.9 : 3.6) * scale);
      ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
      if (len * scale > 7 && fg < 0.5 && MT.sun.night > 0.25) {   // lamps after dark
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,225,170,' + (0.5 * (1 - fg) * MT.sun.night).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(a2.x, a2.y, Math.max(1, 1.5 * scale * 1.4), 0, 6.283); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(236,95,112,.55)';
        ctx.beginPath(); ctx.arc(a1.x, a1.y, Math.max(.8, scale), 0, 6.283); ctx.fill();
      }
      return;
    }

    if (it.k === 1) {                                   /* ------------ train */
      const tr = it.tr, half = tr.len / 2;
      if (MT.isHolo && MT.isHolo()) {
        const res = drawTrainHolo(I, ctx, it, tr, fg);
        if (res.cpx > 9) {
          ctx.font = '600 9px "IBM Plex Mono", ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(255,232,170,' + (0.8 * (1 - fg)).toFixed(2) + ')';
          const q = coachPos[Math.floor((tr.coaches || 10) / 2)];
          /* pinned just above the roof of the middle coach, not the top of the whole rake */
          I.proj(q.x, q.y, q.z + (tr.kind === 'metro' ? 3.9 : 3.8) * TRAIN_XS + 3, a3);
          ctx.fillText((tr.kind === 'metro' ? 'METRO · ' : 'LOCAL · ') + tr.name.replace(' Line', ''),
                       a3.x, a3.y - 6);
        }
        return;
      }
      I.proj(it.x - it.hx * half, it.y - it.hy * half, it.z, a1);
      I.proj(it.x + it.hx * half, it.y + it.hy * half, it.z, a2);
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.18 * (1 - fg);
      ctx.strokeStyle = tr.color; ctx.lineWidth = Math.max(2, 11 * scale);
      ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      const railW = Math.max(3.4, 11 * scale);
      const ld = tr.load === undefined ? 0.4 : tr.load;
      const lc = ld > 1.0 ? [236, 95, 112] : ld > 0.75 ? [238, 127, 69]
               : ld > 0.5 ? [237, 174, 69] : [150, 225, 180];
      const pxLen = Math.hypot(a2.x - a1.x, a2.y - a1.y);

      /* A 12-car local is 276 m of train. Once it is long enough on screen,
         draw the individual coaches — that is what makes it read as a rake
         working the line rather than a coloured dash. */
      if (pxLen > 26) {
        const nC = tr.coaches || 10;
        ctx.lineCap = 'butt';
        for (let c = 0; c < nC; c++) {
          const f0 = c / nC + 0.07 / nC, f1 = (c + 1) / nC - 0.15 / nC;
          const x0 = a1.x + (a2.x - a1.x) * f0, y0 = a1.y + (a2.y - a1.y) * f0;
          const x1 = a1.x + (a2.x - a1.x) * f1, y1 = a1.y + (a2.y - a1.y) * f1;
          ctx.strokeStyle = tr.color; ctx.lineWidth = railW;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          ctx.strokeStyle = I.fogged(lc[0], lc[1], lc[2], fg * 0.5);
          ctx.lineWidth = Math.max(1, railW * 0.42);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
        ctx.lineCap = 'round';
      } else {
        ctx.strokeStyle = tr.color; ctx.lineWidth = railW;
        ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
        ctx.strokeStyle = I.fogged(lc[0], lc[1], lc[2], fg * 0.5);
        ctx.lineWidth = Math.max(0.9, railW * 0.42);
        ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
      }

      /* headlight on the leading cab */
      const hx = tr.dir > 0 ? a2.x : a1.x, hy = tr.dir > 0 ? a2.y : a1.y;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,248,225,' + (0.9 * (1 - fg)).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(hx, hy, Math.min(Math.max(1.6, railW * 0.6), 9), 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      if (pxLen > 64 && tr.kind === 'rail') {
        ctx.font = '600 9px "IBM Plex Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(232,242,252,' + (0.75 * (1 - fg)).toFixed(2) + ')';
        ctx.fillText('LOCAL · ' + tr.name.replace(' Line', ''),
          (a1.x + a2.x) / 2, Math.min(a1.y, a2.y) - railW - 5);
      }
      return;
    }

    if (it.k === 2) {                                   /* ----------- vessel */
      const v = it.ve, half = v.size / 2;
      const ferry = v.kind === 'ferry';
      I.proj(it.x + it.hx * half, it.y + it.hy * half, 2.5, a1);         // bow
      I.proj(it.x - it.hx * half, it.y - it.hy * half, 2.5, a2);         // stern
      I.proj(it.x - it.hx * half * 5.5, it.y - it.hy * half * 5.5, 0.4, a3); // wake tail
      const pxLen = Math.hypot(a2.x - a1.x, a2.y - a1.y);
      const al = 1 - fg;

      /* wake: a widening pale trail astern, drawn first so the hull sits on it */
      /* Butt-capped and starting just astern: a round cap here paints a pale
         disc over the stern and hides the hull that sits in front of it. */
      I.proj(it.x - it.hx * half * 1.04, it.y - it.hy * half * 1.04, 0.4, sM0);
      if (a3.d < 100) {                          // wake runs back past the camera: shorten it
        const k = Math.max(0.05, (sM0.d - 110) / Math.max(1, sM0.d - a3.d));
        const ex = it.x - it.hx * half * 1.04, ey = it.y - it.hy * half * 1.04;
        const tx = it.x - it.hx * half * 5.5, ty = it.y - it.hy * half * 5.5;
        I.proj(ex + (tx - ex) * k, ey + (ty - ey) * k, 0.4, a3);
      }
      const g = ctx.createLinearGradient(sM0.x, sM0.y, a3.x, a3.y);
      g.addColorStop(0, 'rgba(150,222,248,' + (0.22 * al).toFixed(2) + ')');
      g.addColorStop(1, 'rgba(150,222,248,0)');
      ctx.strokeStyle = g; ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(2.4, v.size * (ferry ? 0.26 : 0.17) * scale);
      ctx.beginPath(); ctx.moveTo(sM0.x, sM0.y); ctx.lineTo(a3.x, a3.y); ctx.stroke();
      ctx.lineCap = 'round';

      /* Close enough to resolve: build the hull. Below that a ship is a few
         pixels long and any "structure" would be invented, so it stays a mark. */
      if (pxLen > 15 && al > 0.06) {
        const L = v.size;
        const beam = L * (ferry ? 0.27 : 0.17) / 2;
        const fb = L * (ferry ? 0.075 : 0.086);          // freeboard
        const dr = fb * 0.66;                            // draft
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'lighter';

        /* reflection first: the hull mirrored through the waterline, dimmed */
        if (pxLen > 46) {
          projHull(I, it, L, beam, fb, dr, -1);
          strokeHull(ctx, al * 0.30, false);
        }
        projHull(I, it, L, beam, fb, dr, 1);
        /* light spilling onto the water where the hull meets it */
        ctx.strokeStyle = 'rgba(64,196,240,' + (0.16 * al).toFixed(3) + ')';
        ctx.lineWidth = Math.min(22, Math.max(4, pxLen * 0.06));
        ctx.beginPath();
        ctx.moveTo(sWl[0][0].x, sWl[0][0].y);
        for (let i = 1; i < SHIP_N; i++) ctx.lineTo(sWl[i][0].x, sWl[i][0].y);
        for (let i = SHIP_N - 1; i >= 0; i--) ctx.lineTo(sWl[i][1].x, sWl[i][1].y);
        ctx.closePath(); ctx.stroke();
        strokeHull(ctx, al, true);

        /* superstructure aft, wheelhouse above it, funnel behind */
        const boxCol = 'rgba(170,240,255,' + (0.80 * al).toFixed(3) + ')';
        ctx.lineWidth = 1.2;
        projBox(I, it, L, beam, ferry ? 0.30 : 0.14, ferry ? 0.66 : 0.30,
                beam * (ferry ? 0.70 : 0.62), fb * 1.02, fb * (ferry ? 2.1 : 2.9), 1);
        ctx.fillStyle = 'rgba(18,92,132,' + (0.42 * al).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(sBox[0].x, sBox[0].y); ctx.lineTo(sBox[1].x, sBox[1].y);
        ctx.lineTo(sBox[5].x, sBox[5].y); ctx.lineTo(sBox[4].x, sBox[4].y);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = boxCol; strokeBox(ctx);
        /* bridge windows: a lit band across the wheelhouse front */
        if (pxLen > 60) {
          projBox(I, it, L, beam, ferry ? 0.62 : 0.26, ferry ? 0.66 : 0.30, beam * (ferry ? 0.66 : 0.58),
                  fb * (ferry ? 1.6 : 2.3), fb * (ferry ? 1.85 : 2.6), 1);
          ctx.fillStyle = 'rgba(255,226,150,' + (0.55 * al).toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(sBox[5].x, sBox[5].y); ctx.lineTo(sBox[6].x, sBox[6].y);
          ctx.lineTo(sBox[2].x, sBox[2].y); ctx.lineTo(sBox[1].x, sBox[1].y); ctx.closePath(); ctx.fill();
        }
        /* cargo: container stacks in bays along the deck */
        if (!ferry && pxLen > 40) {
          const CC = ['255,138,60', '64,214,200', '236,84,140', '120,160,255', '240,200,80'];
          const bays = 7, f0 = 0.35, f1 = 0.9, bw = (f1 - f0) / bays;
          for (let bI = 0; bI < bays; bI++) {
            const tiers = 2 + ((bI * 7 + (v.size | 0)) % 3);
            const col = CC[(bI * 3 + (v.size | 0)) % CC.length];
            projBox(I, it, L, beam, f0 + bI * bw + bw * 0.06, f0 + (bI + 1) * bw - bw * 0.06, beam * 0.8,
                    fb * 1.02, fb * (1.02 + tiers * 0.42), 1);
            ctx.fillStyle = 'rgba(' + col + ',' + (0.30 * al).toFixed(3) + ')';
            ctx.beginPath(); ctx.moveTo(sBox[4].x, sBox[4].y);
            for (let q = 5; q < 8; q++) ctx.lineTo(sBox[q].x, sBox[q].y);
            ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(sBox[0].x, sBox[0].y); ctx.lineTo(sBox[1].x, sBox[1].y);
            ctx.lineTo(sBox[5].x, sBox[5].y); ctx.lineTo(sBox[4].x, sBox[4].y); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = 'rgba(' + col + ',' + (0.75 * al).toFixed(3) + ')'; ctx.lineWidth = 0.9;
            strokeBox(ctx);
          }
        }
        if (!ferry) {
          projBox(I, it, L, beam, 0.17, 0.27, beam * 0.46, fb * 2.9, fb * 3.7, 1);
          ctx.strokeStyle = 'rgba(200,248,255,' + (0.88 * al).toFixed(3) + ')';
          strokeBox(ctx);
          projBox(I, it, L, beam, 0.09, 0.14, beam * 0.26, fb * 1.02, fb * 3.2, 1);
          ctx.strokeStyle = boxCol; strokeBox(ctx);
        }

        /* masts and the forestay — the lines that make it read as a ship */
        const mast = (f, h, out) => {
          const ax = it.x + it.hx * (-half + f * L), ay = it.y + it.hy * (-half + f * L);
          I.proj(ax, ay, fb * 1.02, sM0); I.proj(ax, ay, h, out);
        };
        ctx.strokeStyle = 'rgba(160,236,255,' + (0.72 * al).toFixed(3) + ')';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        mast(ferry ? 0.50 : 0.22, fb * (ferry ? 3.4 : 5.4), sM1);
        let topY = sM1.y;
        ctx.moveTo(sM0.x, sM0.y); ctx.lineTo(sM1.x, sM1.y);
        if (!ferry) {
          mast(0.86, fb * 3.6, sM2);
          topY = Math.min(topY, sM2.y);
          ctx.moveTo(sM0.x, sM0.y); ctx.lineTo(sM2.x, sM2.y);
          ctx.moveTo(sM2.x, sM2.y); ctx.lineTo(sM1.x, sM1.y);     // forestay
        }
        ctx.stroke();

        /* navigation lights: masthead white, a red port light at the bridge */
        ctx.fillStyle = 'rgba(255,252,236,' + (0.95 * al).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(sM1.x, sM1.y, 1.9, 0, 6.283); ctx.fill();
        if (!ferry) { ctx.beginPath(); ctx.arc(sM2.x, sM2.y, 1.4, 0, 6.283); ctx.fill(); }
        ctx.fillStyle = 'rgba(255,120,130,' + (0.9 * al).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(sBox[7].x, sBox[7].y, 1.5, 0, 6.283); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        /* The reference badge on the hull said OFFLINE. Ours says what is
           true here: there is no AIS feed, so this vessel is simulated. */
        if (pxLen > 96) {
          ctx.font = '600 9px "IBM Plex Mono", ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(150,232,255,' + (0.62 * al).toFixed(2) + ')';
          ctx.fillText('SIMULATED · NO AIS', (a1.x + a2.x) / 2, topY - 7);
        }
        return;
      }

      /* too small to resolve: the same hologram, reduced to a glowing hull mark */
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(70,200,244,' + (0.34 * al).toFixed(3) + ')';
      ctx.lineWidth = Math.max(5, (ferry ? 9 : 16) * scale);
      ctx.beginPath(); ctx.moveTo(a2.x, a2.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(196,248,255,' + (0.92 * al).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1.6, (ferry ? 3 : 5) * scale);
      ctx.beginPath(); ctx.moveTo(a2.x, a2.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,238,200,.85)';
      ctx.beginPath(); ctx.arc(a1.x, a1.y, Math.min(Math.max(1.8, 3.2 * scale), 8), 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      return;
    }

    if (it.k === 3) {                                   /* --------- aircraft */
      const a = it.ac;
      /* close enough to resolve: the white wireframe airliner */
      I.proj(it.x + it.hx * AL / 2, it.y + it.hy * AL / 2, it.z, a1);
      I.proj(it.x - it.hx * AL / 2, it.y - it.hy * AL / 2, it.z, a2);
      const acPx = Math.hypot(a2.x - a1.x, a2.y - a1.y) + Math.abs(ASPAN * scale) * 0.6;
      if (acPx > 34) {
        I.proj(it.x, it.y, 0, a3); I.proj(it.x, it.y, it.z, a1);
        ctx.strokeStyle = 'rgba(220,235,255,' + (0.22 * (1 - fg)).toFixed(2) + ')';
        ctx.setLineDash([3, 6]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a3.x, a3.y); ctx.stroke(); ctx.setLineDash([]);
        drawAirliner(I, ctx, it, a, fg);
        if (acPx > 90) {
          ctx.font = '600 9.5px "IBM Plex Mono", ui-monospace, monospace';
          ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(236,246,255,' + (0.8 * (1 - fg)).toFixed(2) + ')';
          I.proj(it.x, it.y, it.z + 14, a1);
          ctx.fillText('SIMULATED · ' + Math.round(a.z / 10) * 10 + ' m', a1.x, a1.y - 8);
        }
        return;
      }
      I.proj(it.x, it.y, 0, a3);                        // ground point
      const px = Math.max(8.5, 34 * scale);               // symbol size floor: this
      const wing = px * 0.78;                           // is a radar symbol, not
      const nose = px * 0.62, tail = px * 0.5;          // a scale model

      if (a.trail.length > 5) {                         // recent track
        ctx.beginPath();
        for (let i = 0; i < a.trail.length; i += 3) {
          I.proj(a.trail[i], a.trail[i + 1], a.trail[i + 2] + (it.lift || 0), a1);
          if (i === 0) ctx.moveTo(a1.x, a1.y); else ctx.lineTo(a1.x, a1.y);
        }
        ctx.strokeStyle = 'rgba(225,238,255,' + (0.30 * (1 - fg)).toFixed(2) + ')';
        ctx.lineWidth = 1.2; ctx.stroke();
      }
      I.proj(it.x, it.y, it.z, a1);
      // leader line down to the surface + shadow
      ctx.strokeStyle = 'rgba(150,185,225,' + (0.30 * (1 - fg)).toFixed(2) + ')';
      ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a3.x, a3.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(8,12,24,' + (0.35 * (1 - fg)).toFixed(2) + ')';
      ctx.beginPath(); ctx.ellipse(a3.x, a3.y, px * 0.28, px * 0.12, 0, 0, 6.283); ctx.fill();

      // screen-space heading from the projected velocity
      I.proj(it.x + it.hx * 300, it.y + it.hy * 300, it.z, a2);
      let ang = Math.atan2(a2.y - a1.y, a2.x - a1.x);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const px2 = (dx, dy) => [a1.x + dx * ca - dy * sa, a1.y + dx * sa + dy * ca];
      const body = 'rgba(244,250,255,' + (0.95 * (1 - fg * 0.6)).toFixed(3) + ')';   // white, like the model
      ctx.strokeStyle = body; ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.4, px * 0.15);
      let A = px2(nose, 0), B = px2(-tail, 0);
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      ctx.lineWidth = Math.max(1.1, px * 0.11);
      A = px2(-px * 0.05, -wing / 2); B = px2(-px * 0.05, wing / 2);
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      A = px2(-tail * 0.82, -wing * 0.22); B = px2(-tail * 0.82, wing * 0.22);
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();

      if (fg < 0.7) {                                    // nav + strobe lights
        ctx.globalCompositeOperation = 'lighter';
        const rr = Math.max(1, px * 0.1);
        const L = px2(-px * 0.05, -wing / 2), Rr = px2(-px * 0.05, wing / 2);
        ctx.fillStyle = 'rgba(236,95,112,.85)';
        ctx.beginPath(); ctx.arc(L[0], L[1], rr, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(63,190,132,.85)';
        ctx.beginPath(); ctx.arc(Rr[0], Rr[1], rr, 0, 6.283); ctx.fill();
        if (a.strobe < 0.16) {
          ctx.fillStyle = 'rgba(255,255,255,.95)';
          ctx.beginPath(); ctx.arc(a1.x, a1.y, rr * 2.8, 0, 6.283); ctx.fill();
        }
        ctx.fillStyle = 'rgba(180,230,255,.55)';
        ctx.beginPath(); ctx.arc(a1.x, a1.y, rr * 1.5, 0, 6.283); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      if (px > 17) {
        ctx.font = '500 9.5px "IBM Plex Mono", ui-monospace, monospace';
        ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(190,205,230,' + (0.72 * (1 - fg)).toFixed(2) + ')';
        ctx.fillText(Math.round(a.z / 10) * 10 + ' m · sim', a1.x + px * 0.7, a1.y - px * 0.5);
      }
      return;
    }

    if (it.k === 4) {                                   /* -------- responder */
      I.proj(it.x - it.hx * 3, it.y - it.hy * 3, it.z, a1);
      I.proj(it.x + it.hx * 3, it.y + it.hy * 3, it.z, a2);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#EAEEF8'; ctx.lineWidth = Math.max(2, 3.2 * scale);
      ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      const on = it.r.flash < 0.5;
      ctx.fillStyle = it.r.emergency
        ? (on ? 'rgba(80,140,255,.9)' : 'rgba(255,70,90,.9)')
        : 'rgba(127,235,250,.85)';
      const rr = Math.max(3, 5 * scale * 2);
      ctx.beginPath(); ctx.arc(a2.x, a2.y, rr, 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  /* ============================================== SCREEN-SPACE: SCENARIO RAIN */
  let rainPhase = 0;
  const drops = [];
  for (let i = 0; i < 260; i++) {
    drops.push({ x: Math.random(), y: Math.random(), l: 0.4 + Math.random() * 0.9, v: 0.55 + Math.random() * 0.7 });
  }
  M.drawScreen = function () {
    if (!MT.state.flood || !MT.layerOn('rain')) return;
    const I = R(), ctx = I.ctx, W = I.W, H = I.H;
    const intensity = Math.min(1, MT.state.flood.intensity / 45);
    ctx.save();
    ctx.strokeStyle = 'rgba(178,208,238,' + (0.10 + intensity * 0.12).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = Math.round(drops.length * (0.4 + intensity * 0.6));
    for (let i = 0; i < n; i++) {
      const d = drops[i];
      const y = ((d.y + rainPhase * d.v * 0.85) % 1) * (H + 120) - 60;
      const x = ((d.x + y / H * 0.06) % 1) * W;
      const len = 16 + d.l * 26;
      ctx.moveTo(x, y); ctx.lineTo(x - len * 0.16, y + len);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(96,132,178,' + (0.05 + intensity * 0.06).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  };

  /* ------------------------------------------------------------------ boot */
  buildTrains(); buildAircraft(); buildVessels(); syncVehicles();
  /* counts of what is actually moving on screen (audit #13) */
  M.counts = () => {
    const on = M.on();
    return {
      vehicles: on && MT.layerOn('traffic_flow') ? vehicles.length : 0,
      trains: on && MT.layerOn('trains') ? trains.length : 0,
      aircraft: on && MT.layerOn('aircraft') ? aircraft.length : 0,
      vessels: on && MT.layerOn('vessels') ? vessels.length : 0
    };
  };
  /* positions only, for framing the camera — none of these has an identity */
  M.aircraftAt = i => { const a = aircraft[i]; return a ? { x: a.x, y: a.y, z: a.z, s: a.s } : null; };
  /* where the aircraft is DRAWN (lifted with the building exaggeration) — the camera follows this */
  M.aircraftView = i => {
    const a = aircraft[i]; if (!a || a.x === undefined) return null;
    const lift = (a.ceilNear || 0) * ((MT.state.vscale || 1) - 1);
    return { x: a.x, y: a.y, z: a.z + lift, alt: a.z, hx: a.hx, hy: a.hy, track: a.name, kind: a.kind,
             speed: acSpeed(a) / AC_SLOW, i };
  };
  M.pickAircraft = (sx, sy) => {
    if (!MT.layerOn('aircraft')) return -1;
    const I = R(); let best = -1, bd = 26;
    aircraft.forEach((a, i) => {
      if (a.x === undefined) return;
      const v = M.aircraftView(i);
      I.proj(v.x, v.y, v.z, sp);
      if (sp.d < 60) return;
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      const reach = Math.max(bd, ASPAN * I.focal / sp.d * 0.6);
      if (d < reach && d < (best < 0 ? Infinity : bd)) { best = i; bd = d; }
    });
    return best;
  };
  M.trainAt = i => {
    const tr = trains[i % Math.max(1, trains.length)];
    if (!tr) return null;
    const p = at(tr.t, tr.s);
    return { x: p.x, y: p.y, z: tr.z, kind: tr.kind, dwell: tr.dwellFor > 0,
             yaw: Math.atan2(p.hy * tr.dir, p.hx * tr.dir) };
  };
  M.vehicleAt = i => {
    const v = vehicles[i % Math.max(1, vehicles.length)];
    if (!v || v.e < 0) return null;
    const e = G.edges[v.e];
    const A = v.fwd ? G.nodes[e.a] : G.nodes[e.b], B = v.fwd ? G.nodes[e.b] : G.nodes[e.a];
    const f = v.s / e.len, dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    /* same lane offset and deck height as the drawn vehicle */
    const rh = R().roadHalf ? R().roadHalf(e.cls) : 12;
    const nl = Math.max(1, Math.min(3, e.lanes || 1));
    const cw = (CAR_DIM[v.kind] || CAR_DIM.car)[1] * VEH_SCALE / 2;
    const off = Math.min(rh - cw - 0.5, rh * (Math.min(v.lane, nl - 1) + 0.5) / nl);
    const za = v.fwd ? e.za : e.zb, zb = v.fwd ? e.zb : e.za;
    return { x: A.x + dx * f - dy / L * off, y: A.y + dy * f + dx / L * off, z: (za || 0) + ((zb || 0) - (za || 0)) * f,
             kind: v.kind, body: v.body, yaw: Math.atan2(dy, dx) };
  };

  /* positions only — no identity, because these vessels do not have one */
  M.vesselAt = i => {
    const v = vessels[i % vessels.length];
    return v ? { x: v.x, y: v.y, kind: v.kind, size: v.size } : null;
  };
})(window.MT);
