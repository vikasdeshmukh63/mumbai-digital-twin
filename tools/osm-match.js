/* Map-match the twin's road corridors and rail/metro lines onto OSM geometry. */
const fs = require('fs'), vm = require('vm');
const TAIL = fs.readFileSync(__dirname + '/tail.js', 'utf8');
const ctx = { window: {}, console }; ctx.MT = {}; ctx.window.MT = ctx.MT; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'js', 'data.js'), 'utf8'), ctx);
const MT = ctx.MT || ctx.window.MT;
const OSM = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const KX = 111320 * Math.cos(19.05 * Math.PI / 180), KY = 110574;
const X = lon => (lon - 72.9) * KX, Y = lat => (lat - 19.05) * KY;
const LON = x => x / KX + 72.9, LAT = y => y / KY + 19.05;

function Graph() { return { id: new Map(), x: [], y: [], adj: [], cls: [] }; }
function node(G, lon, lat) {
  const k = lon.toFixed(7) + ',' + lat.toFixed(7);
  let i = G.id.get(k); if (i !== undefined) return i;
  i = G.x.length; G.id.set(k, i); G.x.push(X(lon)); G.y.push(Y(lat)); G.adj.push([]); G.cls.push(0); return i;
}
function addWay(G, coords, factor, cl, nm) {
  if (nm !== undefined) G.names = G.names || [];
  let p = node(G, coords[0][0], coords[0][1]); G.cls[p] |= cl;
  for (let k = 1; k < coords.length; k++) {
    const q = node(G, coords[k][0], coords[k][1]); G.cls[q] |= cl;
    const L = Math.hypot(G.x[q] - G.x[p], G.y[q] - G.y[p]);
    const ei = G.edgeName ? G.edgeName.length : 0; if (nm !== undefined) { (G.edgeName = G.edgeName || []).push(nm); }
    G.adj[p].push([q, L * factor, L, nm !== undefined ? ei : -1]); G.adj[q].push([p, L * factor, L, nm !== undefined ? ei : -1]); p = q;
  }
}
const RG = Graph(), RailG = Graph(), SubG = Graph();
const HW = { motorway: [1.0, 1], trunk: [1.0, 2], primary: [1.12, 4], secondary: [1.45, 8] };
for (const f of OSM.features) {
  const p = f.properties, g = f.geometry; if (g.type !== 'LineString') continue;
  if (p.highway && HW[p.highway]) addWay(RG, g.coordinates, HW[p.highway][0], HW[p.highway][1], ((p.name || '') + ' | ' + (p.ref || '')).toLowerCase());
  else if (p.railway === 'rail' && !p.service && p.usage !== 'industrial') addWay(RailG, g.coordinates, 1, 1);
  else if (p.railway === 'rail' && (p.service === 'crossover' || p.service === 'siding')) addWay(RailG, g.coordinates, 4, 2);   // hop between parallel tracks
  else if (p.railway === 'rail' && p.service === 'yard') addWay(RailG, g.coordinates, 8, 2);
  else if (p.railway === 'subway') addWay(SubG, g.coordinates, 1, 1, ((p.name || '') + ' | ' + (p.ref || '')).toLowerCase());
}
function grid(G) { const m = new Map(); for (let i = 0; i < G.x.length; i++) { const k = Math.floor(G.x[i] / 250) + ':' + Math.floor(G.y[i] / 250); (m.get(k) || m.set(k, []).get(k)).push(i); } G.grid = m; }
[RG, RailG, SubG].forEach(grid);
/* close small gaps: a way end with no continuation joins the nearest node of
   another way within 40 m (slip roads and links were not in the export) */
function joinGaps(G, R) {
  let n = 0;
  for (let u = 0; u < G.x.length; u++) {
    if (G.adj[u].length !== 1) continue;
    const gx = Math.floor(G.x[u] / 250), gy = Math.floor(G.y[u] / 250); let best = -1, bd = R;
    const nb = new Set(G.adj[u].map(e => e[0]));
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) for (const v of G.grid.get(i + ':' + j) || []) {
      if (v === u || nb.has(v)) continue; const d = Math.hypot(G.x[v] - G.x[u], G.y[v] - G.y[u]); if (d < bd) { bd = d; best = v; } }
    if (best >= 0) { G.adj[u].push([best, bd * 1.5, bd, -1]); G.adj[best].push([u, bd * 1.5, bd, -1]); n++; }
  }
  return n;
}
console.log('gap joins road/rail/subway', joinGaps(RG, 40), joinGaps(RailG, 60), joinGaps(SubG, 60));
function snap(G, x, y, maxD, mask) {
  let best = -1, bd = maxD; const gx = Math.floor(x / 250), gy = Math.floor(y / 250), r = Math.ceil(maxD / 250);
  for (let i = gx - r; i <= gx + r; i++) for (let j = gy - r; j <= gy + r; j++) for (const n of G.grid.get(i + ':' + j) || []) {
    if (mask && !(G.cls[n] & mask)) continue;
    const d = Math.hypot(G.x[n] - x, G.y[n] - y); if (d < bd) { bd = d; best = n; }
  }
  return best;
}
/* A* between two nodes, bounded to a box around them */
function route(G, a, b, pad, pref, pen, box) {
  const x0 = box ? box[0] : Math.min(G.x[a], G.x[b]) - pad, x1 = box ? box[1] : Math.max(G.x[a], G.x[b]) + pad, y0 = box ? box[2] : Math.min(G.y[a], G.y[b]) - pad, y1 = box ? box[3] : Math.max(G.y[a], G.y[b]) + pad;
  const dist = new Map([[a, 0]]), prev = new Map(), hk = pref ? 0.3 : 1, h = n => hk * Math.hypot(G.x[n] - G.x[b], G.y[n] - G.y[b]);
  const heap = [[h(a), a]]; const push = e => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const t = heap[0], l = heap.pop(); if (heap.length) { heap[0] = l; let i = 0; for (;;) { const L = 2 * i + 1, R = L + 1; let m = i; if (L < heap.length && heap[L][0] < heap[m][0]) m = L; if (R < heap.length && heap[R][0] < heap[m][0]) m = R; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return t; };
  let it = 0;
  while (heap.length && it++ < 3000000) {
    const [, u] = pop(); if (u === b) break;
    const du = dist.get(u);
    for (const [v, w0, , ei] of G.adj[u]) {
      let w = pref && ei >= 0 && pref.test(G.edgeName[ei]) ? w0 * 0.3 : (pref && G === SubG && ei >= 0 && G.edgeName[ei].replace(/[ |]/g, '') ? w0 * 25 : w0);
      if (pen) w *= pen(v);
      if (G.x[v] < x0 || G.x[v] > x1 || G.y[v] < y0 || G.y[v] > y1) continue;
      const nd = du + w; if (nd < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, nd); prev.set(v, u); push([nd + h(v), v]); }
    }
  }
  if (!dist.has(b)) return null;
  const path = [b]; let u = b; while (u !== a) { u = prev.get(u); path.push(u); } return path.reverse();
}
function rdp(pts, eps, force) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [];
  if (force && force.length) { const f = [...new Set([0, ...force, pts.length - 1])].sort((a, b) => a - b); f.forEach(i => keep[i] = 1); for (let k = 0; k + 1 < f.length; k++) st.push([f[k], f[k + 1]]); }
  else st.push([0, pts.length - 1]);
  while (st.length) { const [i, j] = st.pop(); let md = 0, mi = -1; const [ax, ay] = pts[i], [bx, by] = pts[j], L = Math.hypot(bx - ax, by - ay) || 1;
    for (let k = i + 1; k < j; k++) { const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / L; if (d > md) { md = d; mi = k; } }
    if (md > eps) { keep[mi] = 1; st.push([i, mi], [mi, j]); } }
  if (force) { const map = []; let c = 0; for (let k = 0; k < pts.length; k++) { if (keep[k]) { map[k] = c++; } } force.forEach((fi, j) => force[j] = map[fi]); }
  return pts.filter((_, k) => keep[k]);
}
const distSeg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1; let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
/* remove fold-backs: a path that goes out along one carriageway and returns on
   the other makes a hairpin; collapse the sharpest reversal until none remain */
function unfold(pts) {
  const p = pts.slice(); let changed = true, guard = 0;
  while (changed && guard++ < 5000) {
    changed = false; let worst = -1, wc = -0.6;
    for (let i = 1; i + 1 < p.length; i++) {
      const ax = p[i][0] - p[i - 1][0], ay = p[i][1] - p[i - 1][1], bx = p[i + 1][0] - p[i][0], by = p[i + 1][1] - p[i][1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by); if (la < 0.5 || lb < 0.5) { worst = i; wc = -2; break; }
      const c = (ax * bx + ay * by) / (la * lb); if (c < wc) { wc = c; worst = i; }
    }
    if (worst > 0) { p.splice(worst, 1); changed = true; }
  }
  return p;
}
const plen = (G, p) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(G.x[p[i]] - G.x[p[i - 1]], G.y[p[i]] - G.y[p[i - 1]]); return s; };

/* ---- roads: follow the corridor's own OSM name ---- */
const MASK = { expressway: 1 | 2, arterial: 2 | 4 | 8, link: 15, bridge: 15 };
const NAMES = {
  WEH:/western express highway/, EEH:/eastern express highway/, SVR:/swami vivekanand/, LBS:/lal bahadur shastri/,
  BWSL:/sea link/, MCR:/coastal road/, MD:/marine drive/, EFW:/eastern freeway/, JVLR:/jvlr|jogeshwari-vikroli|adi sankaracharya|adi shankaracharya/,
  SPH:/sion.?panvel|\bsph\b/, LINK:/^link road|new link road/, ABM:/annie besant/, SBM:/senapati bapat/, DAR:/ambedkar marg/,
  PED:/gopalrao deshmukh|kemps corner|hughes road|warden road|peddar/, SAH:/sahar elevated|sahar road/, BKCR:/bandra kurla complex|bkc/,
  MTHL:/atal setu|trans harbour/, GHR:/ghatkopar - mankhurd|gmlr/, MLR:/mulund.{0,3}airoli|airoli/, MAHC:/mahim causeway|mahim/,
  SDL:/sion bandra link|mahim sion|dharavi/, BRAMP:/sea link|bandra reclamation/, NH48:/nh48|mumbai delhi highway|mumbai ahmedabad/,
  GBR:/ghodbunder/, MBR:/mira bhayandar|mira road/, NH160:/nh160|mumbai agra|agra road/, TKB:/kalwa/, ARB:/airoli/,
  TBR:/thane belapur|\btbr\b/, MBP:/mumbra/, KSR:/kalyan.{0,3}shil/, SMR:/shil phata|mahape/, KBW:/kalyan.?bhiwandi|nh61|nh 61|b k birla/,
  KBD:/kalyan badlapur|sh.?35/, KMR:/murbad|titwala/, VBR:/sion.?panvel|vashi/, SPHN:/sion.?panvel|\bsph\b/, PBR:/palm beach/,
  CPR:/jnpt road|\| nh348$/, JNPR:/jnpt road|\| nh348$/, VVR:/vasai|virar|sh40/, NGR:/naigaon|sh41/, VPH:/virar|sh40/,
  VSP:/sh40|vasai road|vasai phata/, WRAMP:/khan abdul gaffar|sea link|annie besant/
};
const named = (G, re) => { const S = new Set(); for (let u = 0; u < G.x.length; u++) for (const [, , , ei] of G.adj[u]) if (ei >= 0 && re.test(G.edgeName[ei])) { S.add(u); break; } return S; };
function snapIn(G, S, x, y, maxD) { let best = -1, bd = maxD; for (const n of S) { const d = Math.hypot(G.x[n] - x, G.y[n] - y); if (d < bd) { bd = d; best = n; } } return best; }
const out = { roads: {}, rail: {}, stats: { roads: {}, rail: {} } };
for (const r of MT.ROADS) {
  /* two corridors whose generalised line was drawn in the wrong place: guide
     them by the real JNPT Road (NH348) instead — JNPA port to the Atal Setu
     landing at Chirle, and Chirle east to Panvel */
  const GUIDE = { JNPR: [[72.972, 18.923], [73.003, 18.905], [73.0325, 18.946]], CPR: [[73.0325, 18.946], [73.085, 18.981], [73.138, 18.967]] };
  const W = (GUIDE[r.id] || r.path).map(([lo, la]) => [X(lo), Y(la)]);
  const oldLen = W.reduce((s, p, k) => k ? s + Math.hypot(p[0] - W[k - 1][0], p[1] - W[k - 1][1]) : 0, 0);
  const CORRIDOR_ONLY = {};
  const re = CORRIDOR_ONLY[r.id] ? null : NAMES[r.id], S = re ? named(RG, re) : new Set();
  let pts = null, how = 'fallback';
  if (S.size) {
    /* anchors: the ends, plus any interior waypoint that has the named road within 700 m */
    const anchors = [];
    W.forEach((w, k) => { const lim = (k === 0 || k === W.length - 1) ? 5000 : 700; const n = snapIn(RG, S, w[0], w[1], lim); if (n >= 0 && anchors[anchors.length - 1] !== n) anchors.push(n); });
    if (anchors.length >= 2) {
      let ok = true, acc = [];
      /* bridge gaps inside the named road (tunnels, ramps and links missing from
         the export): join its loose ends to the nearest node of the same road */
      const temp = [];
      for (const u of S) { if (RG.adj[u].length !== 1) continue; let best = -1, bd = 450;
        for (const v of S) { if (v === u || RG.adj[u].some(e => e[0] === v)) continue; const d = Math.hypot(RG.x[v] - RG.x[u], RG.y[v] - RG.y[u]); if (d < bd && d > 1) { bd = d; best = v; } }
        if (best >= 0) { RG.adj[u].push([best, bd * 1.2, bd, -1]); RG.adj[best].push([u, bd * 1.2, bd, -1]); temp.push([u, best]); } }
      /* separate carriageways or phases of the same road: link each pair of pieces at their closest point */
      { const comp = new Map(); let c = 0; for (const u of S) { if (comp.has(u)) continue; c++; const st = [u]; comp.set(u, c); while (st.length) { const a0 = st.pop(); for (const [v] of RG.adj[a0]) if (S.has(v) && !comp.has(v)) { comp.set(v, c); st.push(v); } } }
        const Sa = [...S];
        for (let ca = 1; ca <= c; ca++) for (let cb = ca + 1; cb <= c; cb++) {
          let bu = -1, bv = -1, bd = 400;
          for (const u of Sa) if (comp.get(u) === ca) for (const v of Sa) if (comp.get(v) === cb) { const d = Math.hypot(RG.x[v] - RG.x[u], RG.y[v] - RG.y[u]); if (d < bd) { bd = d; bu = u; bv = v; } }
          if (bu >= 0) { RG.adj[bu].push([bv, bd * 1.2, bd, -1]); RG.adj[bv].push([bu, bd * 1.2, bd, -1]); temp.push([bu, bv]); }
        } }
      for (let k = 0; k + 1 < anchors.length && ok; k++) {
        const p = route(RG, anchors[k], anchors[k + 1], 3000, re);
        if (!p) { ok = false; break; }
        const seg = p.map(n => [RG.x[n], RG.y[n]]); acc.push(...(acc.length ? seg.slice(1) : seg));
      }
      for (const [u, v] of temp) { RG.adj[u].pop(); RG.adj[v].pop(); }
      const L = acc.reduce((s, p, k) => k ? s + Math.hypot(p[0] - acc[k - 1][0], p[1] - acc[k - 1][1]) : 0, 0);
      if (ok && L < oldLen * 1.7 + 1500 && L > oldLen * 0.4) { pts = acc; how = 'named ' + (L / 1000).toFixed(1) + 'km vs ' + (oldLen / 1000).toFixed(1); }
      else how = 'rejected ' + (ok ? (L / 1000).toFixed(1) + 'km vs ' + (oldLen / 1000).toFixed(1) : 'no route');
    } else how = 'no anchors';
  } else how = 'no name';
  if (!pts) {
    /* second method: route over the whole network, charging each road by its
       distance from the intended corridor (as for the railways) */
    if (!RG.giant) { const comp = new Int32Array(RG.x.length).fill(-1); let best = -1, bs = 0, c = 0;
      for (let u = 0; u < RG.x.length; u++) { if (comp[u] >= 0) continue; let n = 0; const st = [u]; comp[u] = c; while (st.length) { const x = st.pop(); n++; for (const [v] of RG.adj[x]) if (comp[v] < 0) { comp[v] = c; st.push(v); } } if (n > bs) { bs = n; best = c; } c++; }
      RG.giant = comp.map(v => v === best ? 1 : 0); }
    const snapG = (x, y, D) => { let bi = -1, bd = D; const gx = Math.floor(x / 250), gy = Math.floor(y / 250), rr = Math.ceil(D / 250);
      for (let i = gx - rr; i <= gx + rr; i++) for (let j = gy - rr; j <= gy + rr; j++) for (const n of RG.grid.get(i + ':' + j) || []) { if (!RG.giant[n]) continue; const d = Math.hypot(RG.x[n] - x, RG.y[n] - y); if (d < bd) { bd = d; bi = n; } } return bi; };
    const a = snapG(W[0][0], W[0][1], 6000), b = snapG(W[W.length - 1][0], W[W.length - 1][1], 3000);
    if (a >= 0 && b >= 0 && a !== b) {
      const cache = new Map();
      const pen = v => { let c = cache.get(v); if (c !== undefined) return c; let d = Infinity; for (let k = 1; k < W.length; k++) { const dd = distSeg(RG.x[v], RG.y[v], W[k - 1][0], W[k - 1][1], W[k][0], W[k][1]); if (dd < d) d = dd; } c = 1 + Math.pow(d / 220, 2); cache.set(v, c); return c; };
      const xs = W.map(p => p[0]).concat([RG.x[a], RG.x[b]]), ys = W.map(p => p[1]).concat([RG.y[a], RG.y[b]]);
      const bx = [Math.min(...xs) - 12000, Math.max(...xs) + 12000, Math.min(...ys) - 12000, Math.max(...ys) + 12000];
      const p = route(RG, a, b, 0, re || null, pen, bx);
      if (p) { const acc = p.map(n => [RG.x[n], RG.y[n]]); const L = plen(RG, p);
        if (L < oldLen * 1.6 + 1200 && L > oldLen * 0.5) { pts = acc; how = 'corridor ' + (L / 1000).toFixed(1) + 'km vs ' + (oldLen / 1000).toFixed(1); }
        else how += ' / corridor rejected ' + (L / 1000).toFixed(1); }
      else how += ' / corridor no route';
    }
  }
  if (!pts) {
    /* third method, for roads whose OSM pieces are not joined up in the
       export: trace the corridor every 50 m and move each point onto the
       nearest real carriageway within 300 m */
    const segsNear = (x, y) => { const out2 = []; const gx = Math.floor(x / 250), gy = Math.floor(y / 250);
      for (let i = gx - 2; i <= gx + 2; i++) for (let j = gy - 2; j <= gy + 2; j++) for (const u of RG.grid.get(i + ':' + j) || []) for (const [v, , , ei] of RG.adj[u]) if (ei >= 0) out2.push([u, v]); return out2; };
    const tr = []; let hit = 0, tot = 0;
    for (let k = 0; k + 1 < W.length; k++) {
      const L = Math.hypot(W[k + 1][0] - W[k][0], W[k + 1][1] - W[k][1]), n = Math.max(1, Math.round(L / 50));
      for (let t = 0; t < n; t++) {
        const x = W[k][0] + (W[k + 1][0] - W[k][0]) * t / n, y = W[k][1] + (W[k + 1][1] - W[k][1]) * t / n; tot++;
        let bd = 300, bp = null;
        for (const [u, v] of segsNear(x, y)) { const ax = RG.x[u], ay = RG.y[u], dx = RG.x[v] - ax, dy = RG.y[v] - ay, L2 = dx * dx + dy * dy || 1;
          let f = ((x - ax) * dx + (y - ay) * dy) / L2; f = Math.max(0, Math.min(1, f)); const px = ax + f * dx, py = ay + f * dy, d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; bp = [px, py]; } }
        if (bp) { hit++; tr.push(bp); } else tr.push([x, y]);
      }
    }
    tr.push(W[W.length - 1]);
    /* light smoothing so a jump between two nearby roads does not zig-zag */
    for (let it = 0; it < 2; it++) for (let i = 1; i + 1 < tr.length; i++) tr[i] = [(tr[i - 1][0] + 2 * tr[i][0] + tr[i + 1][0]) / 4, (tr[i - 1][1] + 2 * tr[i][1] + tr[i + 1][1]) / 4];
    if (hit / tot > 0.7) { pts = tr; how = 'traced ' + Math.round(hit / tot * 100) + '% on OSM'; } else how += ' / trace ' + Math.round(hit / tot * 100) + '%';
  }
  if (!pts) pts = W;
  pts = unfold(rdp(unfold(pts), 6));
  if (/^(named|corridor|traced)/.test(how)) out.roads[r.id] = pts.map(([x, y]) => [+LON(x).toFixed(6), +LAT(y).toFixed(6)]);
  out.stats.roads[r.id] = how; if (/^(named|corridor|traced)/.test(how)) (out.mRoads = out.mRoads || []).push(r.id);
}
/* ---- rail & metro: route each whole line end to end, then place stations on it ---- */
for (const [lines, G] of [[MT.RAIL, RailG], [MT.METRO, SubG]]) for (const l of lines) {
  const S = l.stations.map(s => [X(s.lon), Y(s.lat)]);
  const oldLen = S.reduce((s2, p, k) => k ? s2 + Math.hypot(p[0] - S[k - 1][0], p[1] - S[k - 1][1]) : 0, 0);
  const mask = G === RailG ? 1 : 0;
  let a = snap(G, S[0][0], S[0][1], 1200, mask), b = snap(G, S[S.length - 1][0], S[S.length - 1][1], 1200, mask);
  /* a metro line starts and ends on its own named track, not a neighbouring line's */
  const MP = { M1: /metro line 1/, M2A: /line.?2\b|line-2|dahisar/, M7: /line 7\b|line-7/, M3: /line.?3|seepz/ }[l.id];
  if (G === SubG && MP) { const own = named(G, MP); if (own.size) { const a2 = snapIn(G, own, S[0][0], S[0][1], 1500), b2 = snapIn(G, own, S[S.length - 1][0], S[S.length - 1][1], 1500); if (a2 >= 0) a = a2; if (b2 >= 0) b = b2; } }
  let raw = null, how = 'fallback';
  if (a >= 0 && b >= 0) {
    /* chain via interior stations that sit close to the network, which keeps a
       branch from short-cutting across the wrong line */
    /* one route end to end; every track is charged by its distance from the
       line's intended corridor, so it keeps to the right set of tracks */
    const anchors = [a, b];
    const cache = new Map();
    const pen = v => { let c = cache.get(v); if (c !== undefined) return c; let d = Infinity;
      for (let k = 1; k < S.length; k++) { const dd = distSeg(G.x[v], G.y[v], S[k - 1][0], S[k - 1][1], S[k][0], S[k][1]); if (dd < d) d = dd; }
      c = 1 + Math.pow(d / 160, 2); cache.set(v, c); return c; };
    l.__pen = pen;
    let acc = [], ok = true;
    for (let k = 0; k + 1 < anchors.length; k++) { const bx = [Math.min(...S.map(p => p[0])) - 3000, Math.max(...S.map(p => p[0])) + 3000, Math.min(...S.map(p => p[1])) - 3000, Math.max(...S.map(p => p[1])) + 3000];
      const MPREF = { M1: /metro line 1/, M2A: /line.?2\b|line-2|dahisar/, M7: /line 7\b|line-7/, M3: /line.?3|seepz/ };
      const p = route(G, anchors[k], anchors[k + 1], 5000, G === SubG ? MPREF[l.id] : null, l.__pen, bx); if (!p) { ok = false; break; } const seg = p.map(n => [G.x[n], G.y[n]]); acc.push(...(acc.length ? seg.slice(1) : seg)); }
    const L = acc.reduce((s2, p, k) => k ? s2 + Math.hypot(p[0] - acc[k - 1][0], p[1] - acc[k - 1][1]) : 0, 0);
    if (ok && L < oldLen * 1.35 + 800 && L > oldLen * 0.75) { raw = acc; how = 'line ' + (L / 1000).toFixed(1) + 'km vs ' + (oldLen / 1000).toFixed(1); }
    else how = 'rejected ' + (ok ? (L / 1000).toFixed(1) + ' vs ' + (oldLen / 1000).toFixed(1) : 'no route');
  }
  let pts, idx;
  if (raw) {
    /* each station: the nearest path vertex, moving forward along the line */
    idx = []; let from = 0;
    for (let k = 0; k < S.length; k++) {
      let bi = from, bd = Infinity;
      for (let v = from; v < raw.length; v++) { const d = Math.hypot(raw[v][0] - S[k][0], raw[v][1] - S[k][1]); if (d < bd) { bd = d; bi = v; } }
      if (k === S.length - 1) bi = raw.length - 1;
      idx.push(bi); from = bi;
    }
    { const u = unfold(raw); if (u.length !== raw.length) {        // re-place stations on the unfolded line
        raw = u; idx = []; let from = 0;
        for (let k = 0; k < S.length; k++) { let bi = from, bd = Infinity; for (let v = from; v < raw.length; v++) { const d = Math.hypot(raw[v][0] - S[k][0], raw[v][1] - S[k][1]); if (d < bd) { bd = d; bi = v; } } if (k === S.length - 1) bi = raw.length - 1; idx.push(bi); from = bi; } } }
    pts = unfold(rdp(raw, 5, idx));
    if (pts.length !== rdp(raw, 5, idx.slice()).length) { idx = []; let from = 0; for (let k = 0; k < S.length; k++) { let bi = from, bd = Infinity; for (let v = from; v < pts.length; v++) { const d = Math.hypot(pts[v][0] - S[k][0], pts[v][1] - S[k][1]); if (d < bd) { bd = d; bi = v; } } if (k === S.length - 1) bi = pts.length - 1; idx.push(bi); from = bi; } }
  } else { pts = S.slice(); idx = S.map((_, k) => k); }
  if (raw) out.rail[l.id] = { path: pts.map(([x, y]) => [+LON(x).toFixed(6), +LAT(y).toFixed(6)]), stops: idx,
                     stations: idx.map(i => [+LON(pts[i][0]).toFixed(6), +LAT(pts[i][1]).toFixed(6)]) };
  out.stats.rail[l.id] = how; if (how.startsWith('line')) (out.mRail = out.mRail || []).push(l.id);
}
console.log('graph nodes road/rail/subway', RG.x.length, RailG.x.length, SubG.x.length);
for (const k in out.stats.roads) console.log('  road', k, out.stats.roads[k]);
for (const k in out.stats.rail) console.log('  rail', k, out.stats.rail[k]);
const pts = Object.values(out.roads).reduce((s, p) => s + p.length, 0) + Object.values(out.rail).reduce((s, r) => s + r.path.length, 0);
console.log('total output points', pts);
/* underground road sections (tunnel=yes) — to mark the matching road links */
out.tunnels = [];
for (const f of OSM.features) { const p = f.properties; if (!p.highway || p.tunnel !== 'yes' || f.geometry.type !== 'LineString') continue;
  const c = f.geometry.coordinates; if (c.length < 2) continue;
  out.tunnels.push({ name: p.name || '', path: c.map(([lo, la]) => [+lo.toFixed(6), +la.toFixed(6)]) }); }
console.log('tunnels', out.tunnels.length);
out.bridges = [];
for (const f of OSM.features) { const p = f.properties; if (!p.highway || !p.bridge || f.geometry.type !== 'LineString') continue;
  const c = f.geometry.coordinates; if (c.length < 2) continue;
  out.bridges.push({ name: p.name || '', path: c.map(([lo, la]) => [+lo.toFixed(6), +la.toFixed(6)]) }); }
console.log('bridges', out.bridges.length);
fs.writeFileSync(process.argv[3], '/* Road and rail geometry map-matched from OpenStreetMap.\n   © OpenStreetMap contributors, available under the Open Database License (ODbL).\n   Generated from an Overpass export (motorway–secondary roads; rail, subway) of the MMR. */\nMT.OSM = ' + JSON.stringify({ source: 'OpenStreetMap (ODbL)', roads: out.roads, rail: out.rail, tunnels: out.tunnels, bridges: out.bridges }) + ';\n' + TAIL);
