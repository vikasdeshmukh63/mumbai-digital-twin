/* ============================================================================
   geo.js — coordinate transforms and planar geometry
   Local ENU metres about MT.META.origin. x = east, y = north, z = up.
   ========================================================================== */
(function (MT) {
  'use strict';

  const D2R = Math.PI / 180;
  const O = MT.META.origin;
  const M_LAT = 110574;                       // metres per degree latitude
  const M_LON = 111320 * Math.cos(O.lat * D2R); // metres per degree longitude here

  const geo = {};

  geo.M_LAT = M_LAT;
  geo.M_LON = M_LON;

  geo.x = lon => (lon - O.lon) * M_LON;
  geo.y = lat => (lat - O.lat) * M_LAT;
  geo.lon = x => O.lon + x / M_LON;
  geo.lat = y => O.lat + y / M_LAT;

  /** [lon,lat] → {x,y} */
  geo.toXY = p => ({ x: geo.x(p[0]), y: geo.y(p[1]) });
  /** [[lon,lat],…] → flat [x0,y0,x1,y1,…] */
  geo.pathXY = path => {
    const out = new Float64Array(path.length * 2);
    for (let i = 0; i < path.length; i++) { out[i * 2] = geo.x(path[i][0]); out[i * 2 + 1] = geo.y(path[i][1]); }
    return out;
  };

  geo.dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  /** Format metres as a human distance. */
  geo.fmtDist = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
  geo.fmtArea = m2 => m2 < 1e6 ? Math.round(m2).toLocaleString('en-IN') + ' m²'
                               : (m2 / 1e6).toFixed(2) + ' km²';

  /** Degrees-minutes style lat/lon readout. */
  geo.fmtLatLon = (lon, lat) =>
    Math.abs(lat).toFixed(4) + '° ' + (lat >= 0 ? 'N' : 'S') + '  ' +
    Math.abs(lon).toFixed(4) + '° ' + (lon >= 0 ? 'E' : 'W');

  /* ------------------------------------------------------------ polygons */

  /** Ray-casting test on a flat [x,y,…] ring. */
  geo.inRing = function (ring, px, py) {
    let inside = false;
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2], yi = ring[i * 2 + 1];
      const xj = ring[j * 2], yj = ring[j * 2 + 1];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  geo.ringArea = function (ring) {
    let a = 0; const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      a += (ring[j * 2] + ring[i * 2]) * (ring[j * 2 + 1] - ring[i * 2 + 1]);
    }
    return Math.abs(a / 2);
  };

  geo.ringBBox = function (ring) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] < x0) x0 = ring[i]; if (ring[i] > x1) x1 = ring[i];
      if (ring[i + 1] < y0) y0 = ring[i + 1]; if (ring[i + 1] > y1) y1 = ring[i + 1];
    }
    return { x0, y0, x1, y1 };
  };

  /** Shortest distance from a point to a flat polyline. */
  geo.distToPath = function (path, px, py) {
    let best = Infinity;
    for (let i = 0; i < path.length - 2; i += 2) {
      best = Math.min(best, geo.distToSeg(px, py, path[i], path[i + 1], path[i + 2], path[i + 3]));
    }
    return best;
  };

  geo.distToSeg = function (px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  geo.pathLength = function (path) {
    let L = 0;
    for (let i = 0; i < path.length - 2; i += 2) L += Math.hypot(path[i + 2] - path[i], path[i + 3] - path[i + 1]);
    return L;
  };

  /** Densify a flat polyline so every gap is at most `step` metres. */
  geo.densify = function (path, step) {
    const out = [path[0], path[1]];
    for (let i = 0; i < path.length - 2; i += 2) {
      const ax = path[i], ay = path[i + 1], bx = path[i + 2], by = path[i + 3];
      const L = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.round(L / step));
      for (let k = 1; k <= n; k++) out.push(ax + (bx - ax) * k / n, ay + (by - ay) * k / n);
    }
    return Float64Array.from(out);
  };

  /* ------------------------------------------------------------- indexing */

  /** Uniform bucket grid for fast nearest / radius queries over point sets. */
  geo.PointIndex = function (items, cell) {
    this.cell = cell || 1000;
    this.map = new Map();
    this.items = items;
    for (let i = 0; i < items.length; i++) {
      const k = this._key(items[i].x, items[i].y);
      let b = this.map.get(k); if (!b) { b = []; this.map.set(k, b); }
      b.push(i);
    }
  };
  geo.PointIndex.prototype._key = function (x, y) {
    return (Math.floor(x / this.cell)) + ':' + (Math.floor(y / this.cell));
  };
  geo.PointIndex.prototype.within = function (x, y, radius) {
    const c = this.cell, rad = Math.ceil(radius / c);
    const cx = Math.floor(x / c), cy = Math.floor(y / c), out = [];
    for (let i = -rad; i <= rad; i++) for (let j = -rad; j <= rad; j++) {
      const b = this.map.get((cx + i) + ':' + (cy + j)); if (!b) continue;
      for (const idx of b) {
        const it = this.items[idx];
        const d = Math.hypot(it.x - x, it.y - y);
        if (d <= radius) out.push({ item: it, d });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  };
  geo.PointIndex.prototype.nearest = function (x, y, maxR) {
    let r = this.cell;
    const cap = maxR || 40000;
    while (r <= cap) {
      const hits = this.within(x, y, r);
      if (hits.length) return hits[0];
      r *= 2;
    }
    return null;
  };

  /* ------------------------------------------------------------- min-heap */
  geo.Heap = function () { this.a = []; };
  geo.Heap.prototype.push = function (node) {
    const a = this.a; a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  };
  geo.Heap.prototype.pop = function () {
    const a = this.a; if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1; let s = i;
        if (l < a.length && a[l].k < a[s].k) s = l;
        if (r < a.length && a[r].k < a[s].k) s = r;
        if (s === i) break;
        const t = a[s]; a[s] = a[i]; a[i] = t; i = s;
      }
    }
    return top;
  };
  geo.Heap.prototype.size = function () { return this.a.length; };

  MT.geo = geo;
})(window.MT);
