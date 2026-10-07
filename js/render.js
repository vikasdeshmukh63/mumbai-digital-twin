/* ============================================================================
   render.js — perspective 3D city renderer on a 2D canvas.
   No WebGL, no external libraries: painter's algorithm with per-face culling.
   ========================================================================== */
(function (MT) {
  'use strict';
  const geo = MT.geo, city = MT.city;

  /* ------------------------------------------------------------- app state */
  MT.state = {
    layers: {},                 // id -> {on, opacity}
    surface: 'relief',          // ground overlay: none|relief|density|floodrisk|flood|heat|air|zones
    selection: null,            // {kind, ...}
    highlight: null,            // {points:[], rings:[], label}
    routes: [],                 // [{path:[x,y,...], color, label}]
    tool: null,                 // distance|area|radius|select|place
    measure: { pts: [], done: false },
    areaSel: null,              // {x0,y0,x1,y1}
    style: 'holo',             // 'holo' (wireframe hologram) | 'lit' (shaded dusk)
    year: 2026,
    tod: 18.3,                  // hour of day, drives the lighting model
    iso: null,                  // emergency-response isochrone bands
    flood: null,                // sim result
    traffic: null,
    placed: [],                 // hypothetical infrastructure/buildings
    labels: true,
    showBuildings: true
  };

  const LAYERS = MT.LAYERS = [
    { g: 'Base',           id: 'land',      label: 'Land & coastline',      on: true,  ds: 'coastline' },
    { g: 'Base',           id: 'satellite', label: 'Satellite (synthetic)', on: false, ds: 'terrain' },
    { g: 'Base',           id: 'terrain',   label: 'Terrain relief',        on: true,  ds: 'terrain' },
    { g: 'Base',           id: 'buildings', label: '3D buildings',          on: true,  ds: 'buildings' },

    { g: 'Transportation', id: 'roads',     label: 'Roads & highways',      on: true,  ds: 'roads' },
    { g: 'Transportation', id: 'bridges',   label: 'Sea links & bridges',   on: true,  ds: 'roads' },
    { g: 'Transportation', id: 'rail',      label: 'Suburban railway',      on: true,  ds: 'rail' },
    { g: 'Transportation', id: 'metro',     label: 'Metro network',         on: true,  ds: 'rail' },
    { g: 'Transportation', id: 'stations',  label: 'Stations',              on: true,  ds: 'rail' },
    { g: 'Transportation', id: 'airport',   label: 'Airport & ports',       on: true,  ds: 'projects' },

    { g: 'Environment',    id: 'water',     label: 'Water bodies & rivers', on: true,  ds: 'coastline' },
    { g: 'Environment',    id: 'green',     label: 'Green cover',           on: true,  ds: 'coastline' },
    { g: 'Environment',    id: 'floodzone', label: 'Flood scenario depth',  on: true,  ds: 'terrain' },
    { g: 'Environment',    id: 'rain',      label: 'Scenario rainfall (animated)', on: true, ds: 'terrain' },

    { g: 'Live motion',    id: 'traffic_flow', label: 'Road traffic',        on: true,  ds: 'movement' },
    { g: 'Live motion',    id: 'trains',       label: 'Trains & metro',      on: true,  ds: 'movement' },
    { g: 'Live motion',    id: 'aircraft',     label: 'Aircraft',            on: true,  ds: 'movement' },
    { g: 'Live motion',    id: 'vessels',      label: 'Shipping & ferries',  on: true,  ds: 'movement' },

    { g: 'Infrastructure', id: 'hospitals', label: 'Hospitals',             on: true,  ds: 'health' },
    { g: 'Infrastructure', id: 'fire',      label: 'Fire stations',         on: false, ds: 'fire' },
    { g: 'Infrastructure', id: 'police',    label: 'Police (simulated)',    on: false, ds: 'buildings' },
    { g: 'Infrastructure', id: 'schools',   label: 'Schools (simulated)',   on: false, ds: 'buildings' },
    { g: 'Infrastructure', id: 'landmarks', label: 'Landmarks',             on: true,  ds: 'coastline' },
    { g: 'Infrastructure', id: 'heritage',  label: 'Heritage models (3D)',  on: true,  ds: 'coastline' },
    { g: 'Infrastructure', id: 'banks',     label: 'Bank & exchange HQs',   on: true,  ds: 'banks' },
    { g: 'Infrastructure', id: 'utility',   label: 'Utility network',       on: false, ds: 'drainage', disabled: true },

    { g: 'Urban development', id: 'projects', label: 'Project register',    on: true,  ds: 'projects' },
    { g: 'Urban development', id: 'twins',    label: 'Building twins (demo)', on: true, ds: 'building_twins' },
    { g: 'Urban development', id: 'proposed', label: 'Proposed alignments', on: false, ds: 'projects' },

    { g: 'Risk',           id: 'congestion', label: 'Modelled congestion',  on: true,  ds: 'traffic_live' },
    { g: 'Risk',           id: 'lowlying',   label: 'Low-lying cells (<4 m)', on: false, ds: 'terrain' },
    { g: 'Risk',           id: 'coastal',    label: 'Coastal exposure band', on: false, ds: 'terrain' },
    { g: 'Risk',           id: 'access',     label: 'Emergency access gaps', on: false, ds: 'health' },
    { g: 'Risk',           id: 'isochrone',  label: 'Response-time bands',   on: true,  ds: 'health' },

    { g: 'Analysis',       id: 'odflows',    label: 'Demand flow arcs',      on: false, ds: 'density' }
  ];
  LAYERS.forEach(l => MT.state.layers[l.id] = { on: !!l.on, opacity: 1 });
  MT.layerOn = id => { const l = MT.state.layers[id]; return l && l.on; };
  MT.layerOp = id => { const l = MT.state.layers[id]; return l ? l.opacity : 1; };

  /* -------------------------------------------------------------- daylight */
  /* Solar position for Mumbai (19.09 N) at the equinox — declination is taken
     as zero, so sunrise and sunset sit at 06:00 and 18:00 all year. That is a
     simplification, and it is the only assumption the lighting model makes. */
  const D2R = Math.PI / 180;
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const holo = () => MT.state.style === 'holo';
  MT.isHolo = holo;
  const sun = MT.sun = { tod: 18.3, alt: 0, az: 0, dx: 0, dy: -1, day: 0, night: 1, golden: 0 };
  let lightKey = -1;
  function updateSun() {
    const lat = 19.09 * D2R, tod = MT.state.tod;
    const h = (tod - 12) * 15 * D2R;
    const sinAlt = Math.max(-1, Math.min(1, Math.cos(lat) * Math.cos(h)));
    const alt = Math.asin(sinAlt);
    let cosAz = (-sinAlt * Math.sin(lat)) / ((Math.cos(alt) * Math.cos(lat)) || 1e-6);
    cosAz = Math.max(-1, Math.min(1, cosAz));
    let az = Math.acos(cosAz);
    if (h > 0) az = Math.PI * 2 - az;
    sun.tod = tod; sun.alt = alt / D2R; sun.az = az;
    const ch = Math.cos(alt);
    let dx = ch * Math.sin(az), dy = ch * Math.cos(az);
    const L = Math.hypot(dx, dy) || 1;
    sun.dx = dx / L; sun.dy = dy / L;
    sun.day = clamp01((sun.alt + 5) / 16);
    sun.night = 1 - sun.day;
    sun.golden = clamp01(1 - Math.abs(sun.alt - 3) / 13);
    const key = Math.round(sun.day * 15) * 64 + Math.round(sun.golden * 15) * 2 + (holo() ? 1 : 0);
    if (key !== lightKey) {
      lightKey = key; groundDirty = true;
      colCache.clear(); shadeCache.clear();
      FOG[0] = 50 + 56 * sun.day; FOG[1] = 64 + 68 * sun.day; FOG[2] = 106 + 62 * sun.day;
    }
  }
  const mix = (a, b, t) => a + (b - a) * t;
  const rgbStr = (r, g, b) => 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  /** Deep-water colour for the current light — shared by raster and sea plane. */
  function seaRGB() {
    return [mix(12, 34, sun.day) + 8 * sun.golden,
            mix(28, 76, sun.day) + 3 * sun.golden,
            mix(54, 114, sun.day)];
  }

  /* ---------------------------------------------------------------- camera */
  const cam = MT.cam = {
    tx: geo.x(72.8700), ty: geo.y(19.0700),
    yaw: -0.22, pitch: 0.80, dist: 26000,
    tz: 0,                                  // height of the point the camera looks at (non-zero only while following an aircraft)
    minDist: 190, maxDist: 160000
  };
  let dpr = 1, W = 0, H = 0, focal = 0;
  /* Adaptive quality. Frame cost is watched as a moving average; on a slow
     machine the pixel density steps down and the smallest distant buildings
     drop out a little earlier, and both come back when there is headroom.
     Level 0 is full quality. */
  const QUAL = [{ dpr: 1.6, lod: 1 }, { dpr: 1.25, lod: 1.4 }, { dpr: 1.0, lod: 2.0 }];   // never below 1× — no blur
  let qLevel = 0, qAvg = 0, qSince = 0;
  let canvas, ctx;
  let dirty = true, anim = null, spin = 0;

  const R = MT.render = {};
  /* Follow mode: a getter returning {x, y, z} each frame; the camera target
     tracks it. Panning ends it; orbiting and zooming keep it. */
  let followFn = null;
  R.follow = fn => {
    followFn = fn || null;
    cam.minDist = followFn ? 60 : Math.min(190, cam.dist);   // no jump when letting go close in
    dirty = true;
  };
  R.following = () => !!followFn;
  R.quality = () => qLevel;
  R.invalidate = () => { dirty = true; };

  /* Projection: world (x,y,z) -> {sx, sy, depth}. Screen units are CSS px.   */
  let ca = 1, sa = 0, cp = 1, sp = 0, camX = 0, camY = 0;
  /* Optional off-centre framing, held as a fraction of the viewport so it
     survives resizes. The landing page uses it to push the city off-axis. */
  let offFX = 0, offFY = 0, offX = 0, offY = 0;
  let fogNear = 0, fogFar = 1;
  function updateCam() {
    ca = Math.cos(cam.yaw); sa = Math.sin(cam.yaw);
    cp = Math.cos(cam.pitch); sp = Math.sin(cam.pitch);
    camX = cam.tx - cam.dist * cp * sa;
    camY = cam.ty - cam.dist * cp * ca;
    offX = W * offFX; offY = H * offFY;
    fogNear = cam.dist * 0.5;
    fogFar = cam.dist * 2.1 + 11000;
  }
  /* Grazing-angle attenuation for additive line glow. Near the horizon at a
     low pitch, kilometres of corridor fold onto a few rows of pixels and their
     added light burns out to white; the ratio of camera height to distance is
     the sine of that grazing angle, so glow fades only where it would stack. */
  function graze(d) {
    return Math.max(0.16, Math.min(1, cam.dist * sp / Math.max(1, d) / 0.09));
  }
  function proj(x, y, z, out) {
    const dx = x - cam.tx, dy = y - cam.ty;
    z -= cam.tz;
    const ex = dx * ca - dy * sa;
    const ey = dx * sa + dy * ca;
    const depth = ey * cp - z * sp + cam.dist;
    const inv = focal / depth;
    out.x = W / 2 + offX + ex * inv;
    out.y = H / 2 + offY - (ey * sp + z * cp) * inv;
    out.d = depth;
    return out;
  }
  const P = () => ({ x: 0, y: 0, d: 0 });
  const pa = P(), pb = P(), pc = P(), pd = P();
  const t0 = P(), t1 = P(), t2 = P(), t3 = P();
  R.project = (x, y, z) => proj(x, y, z || 0, P());

  /* Inverse: screen point -> ground plane (z=0) world coords. */
  R.unproject = function (sx, sy) {
    // Solve for depth where z = 0.
    const nx = sx - W / 2 - offX, ny = H / 2 + offY - sy;
    // ex = nx*depth/focal ; ey*sp = ny*depth/focal ; depth = ey*cp + dist
    // => ey = ny*depth/(focal*sp)
    // depth = ny*depth*cp/(focal*sp) + dist  => depth (1 - ny*cp/(focal*sp)) = dist
    /* with the look-at point raised by tz, the ground plane sits at z = -tz
       in camera terms: depth (1 - ny·cp/(f·sp)) = dist + tz/sp */
    const k = 1 - (ny * cp) / (focal * sp || 1e-6);
    if (Math.abs(k) < 1e-6) return null;
    const depth = (cam.dist + cam.tz / (sp || 1e-6)) / k;
    if (depth <= 0) return null;
    const ex = nx * depth / focal;
    const ey = (ny * depth / focal + cam.tz * cp) / (sp || 1e-6);
    return { x: cam.tx + ex * ca + ey * sa, y: cam.ty - ex * sa + ey * ca, d: depth };
  };

  /* ------------------------------------------------------------ attachment */
  R.attach = function (cnv) {
    canvas = cnv; ctx = canvas.getContext('2d', { alpha: false });
    resize();
    new ResizeObserver(resize).observe(canvas.parentElement);
    bindInput();
    requestAnimationFrame(frame);
  };
  function resize() {
    if (!canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, QUAL[qLevel].dpr);
    W = Math.max(320, Math.round(r.width)); H = Math.max(240, Math.round(r.height));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    focal = H * 2.45;
    groundDirty = true; dirty = true;
  }
  R.size = () => ({ W, H });

  /* --------------------------------------------------------- ground raster */
  const G = city.grid;
  const TEXM = 100;                                   // metres per texel
  /* The raster reaches well past the analysis grid so its own edge never
     shows: everything outside the grid simply paints as open sea. */
  const SEA_PAD = 16000;
  const EXTT = {
    x0: city.extent.x0 - SEA_PAD, y0: city.extent.y0 - SEA_PAD,
    x1: city.extent.x1 + SEA_PAD, y1: city.extent.y1 + SEA_PAD
  };
  const TW = Math.ceil((EXTT.x1 - EXTT.x0) / TEXM);
  const TH = Math.ceil((EXTT.y1 - EXTT.y0) / TEXM);
  const tex = document.createElement('canvas');
  tex.width = TW; tex.height = TH;
  const tctx = tex.getContext('2d');
  const img = tctx.createImageData(TW, TH);
  let groundDirty = true;
  let cellCol = null;                                 // per-cell ground colour cache
  R.markGround = () => { groundDirty = true; dirty = true; };

  const RAMPS = {
    relief:  [[0, 26, 34, 55], [6, 34, 44, 68], [20, 45, 56, 80], [60, 60, 72, 92], [150, 88, 99, 110], [320, 128, 137, 146]],
    density: [[0, 16, 26, 40], [.25, 20, 62, 86], [.5, 40, 120, 128], [.75, 150, 160, 92], [1, 224, 122, 60]],
    heat:    [[0, 22, 34, 56], [.4, 60, 96, 120], [.7, 200, 150, 70], [1, 224, 88, 72]],
    air:     [[0, 30, 90, 80], [.4, 120, 140, 70], [.7, 200, 140, 60], [1, 200, 80, 90]]
  };
  function ramp(name, t) {
    const R2 = RAMPS[name]; let i = 0;
    while (i < R2.length - 2 && t > R2[i + 1][0]) i++;
    const a = R2[i], b = R2[i + 1];
    const f = Math.max(0, Math.min(1, (t - a[0]) / ((b[0] - a[0]) || 1)));
    return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
  }

  const ZONE_HUES = [];
  for (let i = 0; i < 40; i++) {
    const h = (i * 137.508) % 360;
    ZONE_HUES.push(hsl2rgb(h / 360, 0.42, 0.42));
  }
  function hsl2rgb(h, s, l) {
    const f = n => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
    };
    return [f(0), f(8), f(4)];
  }

  function paintGround() {
    const d = img.data;
    const surf = MT.state.surface;
    const flood = MT.state.flood;
    const shadeOn = MT.layerOn('terrain');
    const SEA = seaRGB();
    const HOLO = holo();
    /* One light term for the whole surface: a multiplier plus a coloured
       ambient, warmed near sunrise and sunset. */
    const lm = 0.55 + 0.60 * sun.day;
    const la = [6 + 16 * sun.golden, 8 + 7 * sun.golden, 14 - 2 * sun.golden];
    const nightGlow = sun.night;
    const FB = city.frameBox;
    /* Colour is a function of the 200 m analysis cell, so it is worked out
       once per cell and then copied to the texels that cell covers — the
       raster has four texels per cell and most of it is open sea. */
    const NC = G.w * G.h;
    if (!cellCol || cellCol.length !== NC * 4) cellCol = new Float32Array(NC * 4);
    const CC = cellCol;
    for (let k = 0; k < NC; k++) {
      const q = k * 4;
      if (!city.land[k]) { CC[q + 3] = -1; continue; }
      const wx = G.x0 + (k % G.w + 0.5) * G.cell, wy = G.y0 + (Math.floor(k / G.w) + 0.5) * G.cell;
      let r, g2, b;
      if (surf === 'density') { const c = ramp('density', city.density[k]); r = c[0]; g2 = c[1]; b = c[2]; }
      else if (surf === 'heat') { const c = ramp('heat', Math.min(1, city.density[k] * 0.85 + (city.green[k] ? -0.4 : 0.15))); r = c[0]; g2 = c[1]; b = c[2]; }
      else if (surf === 'air') { const c = ramp('air', Math.min(1, Math.max(0, city.density[k] * 0.8 + 0.1 - (city.green[k] ? 0.5 : 0)))); r = c[0]; g2 = c[1]; b = c[2]; }
      else if (surf === 'zones') { const c = ZONE_HUES[(city.zoneOf[k] + 40) % 40]; r = c[0]; g2 = c[1]; b = c[2]; }
      else if (surf === 'floodrisk') {
        const risk = Math.max(0, Math.min(1, (6 - city.elev[k]) / 6 * 0.65 + city.depression[k] * 0.55));
        r = 20 + risk * 40; g2 = 34 + risk * 70; b = 48 + risk * 150;
      } else { const c = ramp('relief', Math.max(0, city.elev[k])); r = c[0]; g2 = c[1]; b = c[2]; }

      /* warm sodium cast over the dense core, cool over the hills */
      if (surf === 'relief') {
        const gl = city.density[k];
        if (gl > 0.16) { const a = (gl - 0.16) * 0.72 * (0.22 + 0.78 * nightGlow); r += 84 * a; g2 += 48 * a; b += 10 * a; }
      }
      if (city.green[k]) { r = r * .34 + 16; g2 = g2 * .42 + 34; b = b * .36 + 22; }
      if (city.waterMask[k]) { r = 17; g2 = 56; b = 88; }

      if (shadeOn) {
        const ka = city.cellIndex(wx + 220, wy), kb = city.cellIndex(wx, wy + 220);
        if (ka >= 0 && kb >= 0) {
          const gx = city.elev[ka] - city.elev[k], gy = city.elev[kb] - city.elev[k];
          const s = Math.max(-0.45, Math.min(0.45,
            (-gx * sun.dx - gy * sun.dy) / 16 * (0.35 + 0.65 * sun.day)));
          r = Math.max(0, Math.min(255, r * (1 + s))); g2 = Math.max(0, Math.min(255, g2 * (1 + s))); b = Math.max(0, Math.min(255, b * (1 + s)));
        }
      }
      if (MT.layerOn('satellite')) {
        const n = ((k * 2654435761) % 1000) / 1000;
        r = r * .55 + 40 + n * 26; g2 = g2 * .55 + 40 + n * 22; b = b * .5 + 34 + n * 18;
      }
      if (MT.layerOn('lowlying') && city.elev[k] < 4) { r = r * .5 + 80; g2 = g2 * .5 + 40; b = b * .5 + 110; }
      if (MT.layerOn('coastal') && city.coastDist[k] < 900) { r = r * .6 + 70; g2 = g2 * .6 + 60; b = b * .6 + 40; }

      if (HOLO) {
        /* collapse the shaded surface to a dark teal substrate; structure
           comes from the grid and the wireframes, not from the fill */
        const lum = (r * 0.30 + g2 * 0.52 + b * 0.18) / 255;
        r = 3 + lum * 12; g2 = 13 + lum * 40; b = 21 + lum * 46;
        if (city.green[k]) { g2 += 16; b += 4; }
      }
      if (flood && MT.layerOn('floodzone')) {
        const dep = flood.depth[k];
        if (dep > 0.10) {
          const t = Math.min(1, dep / 1.2);
          const fr = 40 + t * 20, fg = 110 + t * 30, fb = 200 + t * 45;
          const a = (HOLO ? 0.44 : 0.30) + t * 0.55;
          r = r * (1 - a) + fr * a; g2 = g2 * (1 - a) + fg * a; b = b * (1 - a) + fb * a;
        }
      }
      if (!HOLO) { r = r * lm + la[0]; g2 = g2 * lm + la[1]; b = b * lm + la[2]; }
      /* Land fades out over the last few kilometres before the model's outer
         frame, so where the model stops reads as "no data", not as a coast. */
      let fa = 1;
      if (FB) {
        let dd = Math.min(FB.y1 - wy, FB.x1 - wx);
        if (wx > FB.x0 + 8000) dd = Math.min(dd, wy - FB.y0);
        fa = Math.max(0, Math.min(1, dd / 6000));
        fa = fa * fa * (3 - 2 * fa);
      }
      if (fa < 1) {
        if (HOLO) { CC[q] = r; CC[q + 1] = g2; CC[q + 2] = b; CC[q + 3] = 255 * fa; continue; }
        r = r * fa + SEA[0] * (1 - fa); g2 = g2 * fa + SEA[1] * (1 - fa); b = b * fa + SEA[2] * (1 - fa);
      }
      CC[q] = r > 255 ? 255 : r; CC[q + 1] = g2 > 255 ? 255 : g2; CC[q + 2] = b > 255 ? 255 : b; CC[q + 3] = 255;
    }
    const gx0 = G.x0, gy0 = G.y0, gcell = G.cell, gw = G.w, gh = G.h;
    for (let ty = 0; ty < TH; ty++) {
      const wy = EXTT.y0 + (ty + 0.5) * TEXM;
      const j = Math.floor((wy - gy0) / gcell);
      for (let tx2 = 0; tx2 < TW; tx2++) {
        const o = ((TH - 1 - ty) * TW + tx2) * 4;
        const i = Math.floor((EXTT.x0 + (tx2 + 0.5) * TEXM - gx0) / gcell);
        const q = (i < 0 || j < 0 || i >= gw || j >= gh) ? -1 : (j * gw + i) * 4;
        if (q < 0 || CC[q + 3] < 0) {
          /* Open water is a single flat value matching the sea plane, so the
             edge of the analysis grid never reads as a line on the water.
             In hologram style it is left transparent so the wireframe swell
             drawn underneath shows through. */
          if (HOLO) { d[o + 3] = 0; continue; }
          d[o] = SEA[0]; d[o + 1] = SEA[1]; d[o + 2] = SEA[2]; d[o + 3] = 255;
          continue;
        }
        d[o] = CC[q]; d[o + 1] = CC[q + 1]; d[o + 2] = CC[q + 2]; d[o + 3] = CC[q + 3];
      }
    }
    tctx.putImageData(img, 0, 0);
    groundDirty = false;
  }

  /* Draw the ground raster onto the perspective ground plane via a           */
  /* subdivided affine patch grid (piecewise-affine texture mapping).         */
  /* The ground raster is mapped with a piecewise-affine patch grid. The grid
     is laid out in SCREEN space, not world space: subdividing the world put
     kilometre-wide quads under the camera at close zoom, where an affine
     approximation of a perspective mapping falls apart and patches sample the
     wrong part of the texture. Screen-space cells stay a constant size on
     screen, so the approximation is always good. */
  const SUB = 20;
  const _u = { x: 0, y: 0, ok: false };
  function groundAt(sx, sy) {
    const nx = sx - W / 2 - offX, ny = H / 2 + offY - sy;
    const k = 1 - (ny * cp) / (focal * sp || 1e-6);
    if (k < 1e-4) { _u.ok = false; return _u; }
    const depth = cam.dist / k;
    if (depth <= 0 || depth > 1e7) { _u.ok = false; return _u; }
    const ex = nx * depth / focal;
    const ey = ny * depth / (focal * sp || 1e-6);
    _u.x = cam.tx + ex * ca + ey * sa;
    _u.y = cam.ty - ex * sa + ey * ca;
    _u.ok = true;
    return _u;
  }

  const gx = new Float64Array((SUB + 1) * (SUB + 1));
  const gy = new Float64Array((SUB + 1) * (SUB + 1));
  const gok = new Uint8Array((SUB + 1) * (SUB + 1));

  function drawGround() {
    const cw = W / SUB, ch = H / SUB;
    for (let j = 0; j <= SUB; j++) for (let i = 0; i <= SUB; i++) {
      const k = j * (SUB + 1) + i;
      const g = groundAt(i * cw, j * ch);
      gok[k] = g.ok ? 1 : 0;
      if (g.ok) {
        gx[k] = (g.x - EXTT.x0) / TEXM;
        gy[k] = TH - (g.y - EXTT.y0) / TEXM;
      }
    }
    for (let j = 0; j < SUB; j++) for (let i = 0; i < SUB; i++) {
      const k00 = j * (SUB + 1) + i, k10 = k00 + 1, k01 = k00 + SUB + 1, k11 = k01 + 1;
      if (!gok[k00] || !gok[k10] || !gok[k01] || !gok[k11]) continue;
      const u0 = gx[k00], v0 = gy[k00];
      const du1 = gx[k10] - u0, dv1 = gy[k10] - v0;
      const du2 = gx[k01] - u0, dv2 = gy[k01] - v0;
      const det = du1 * dv2 - du2 * dv1;
      if (!det || !isFinite(det)) continue;

      /* affine texture->screen from three correspondences:
         (u0,v0)->(sx0,sy0), +(du1,dv1)->+(cw,0), +(du2,dv2)->+(0,ch) */
      const sx0 = i * cw, sy0 = j * ch;
      const a =  cw * dv2 / det;
      const c = -cw * du2 / det;
      const b = -ch * dv1 / det;
      const d =  ch * du1 / det;
      const e = sx0 - a * u0 - c * v0;
      const f = sy0 - b * u0 - d * v0;
      if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) continue;

      let ux = Math.min(gx[k00], gx[k10], gx[k01], gx[k11]) - 1;
      let vy = Math.min(gy[k00], gy[k10], gy[k01], gy[k11]) - 1;
      let uw = Math.max(gx[k00], gx[k10], gx[k01], gx[k11]) + 1 - ux;
      let vh = Math.max(gy[k00], gy[k10], gy[k01], gy[k11]) + 1 - vy;
      if (ux < 0) { uw += ux; ux = 0; }
      if (vy < 0) { vh += vy; vy = 0; }
      if (ux >= TW || vy >= TH || uw <= 0 || vh <= 0) continue;
      if (ux + uw > TW) uw = TW - ux;
      if (vy + vh > TH) vh = TH - vy;

      ctx.save();
      ctx.beginPath();
      ctx.rect(sx0 - 0.5, sy0 - 0.5, cw + 1, ch + 1);
      ctx.clip();
      ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
      ctx.drawImage(tex, ux, vy, uw, vh, ux, vy, uw, vh);
      ctx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ------------------------------------------------------------- materials */
  const USE_BASE = {
    'Residential':  [112, 125, 143],
    'Commercial':   [108, 134, 152],
    'Mixed use':    [118, 123, 136],
    'Industrial':   [122, 113, 104],
    'Institutional':[111, 131, 127]
  };

  /* Aerial perspective: everything fades toward the horizon haze with depth.
     This is what stops a flat painter's-algorithm scene reading as cardboard. */
  const FOG = [50, 64, 106];   // mutated by the daylight model
  const FOG_MAX = 0.72;
  function fogAmt(d) {
    const t = (d - fogNear) / (fogFar - fogNear);
    return t <= 0 ? 0 : t >= 1 ? FOG_MAX : t * t * FOG_MAX;
  }
  const colCache = new Map();
  function fogged(r, g, b, f) {
    const q = Math.round(f * 12);
    const key = (Math.round(r) << 17) + (Math.round(g) << 9) + (Math.round(b) << 1) + q * 16777216;
    let s = colCache.get(key);
    if (!s) {
      const k = q / 12;
      s = 'rgb(' + Math.round(r + (FOG[0] - r) * k) + ',' +
                   Math.round(g + (FOG[1] - g) * k) + ',' +
                   Math.round(b + (FOG[2] - b) * k) + ')';
      colCache.set(key, s);
    }
    return s;
  }
  const shadeCache = new Map();
  function shadeColor(use, mul, f, tint) {
    const q = Math.round(mul * 12), fq = Math.round((f || 0) * 12);
    const tq = tint === undefined ? 3 : Math.round(tint * 5);
    const key = use + ':' + q + ':' + fq + ':' + tq;
    let s = shadeCache.get(key);
    if (!s) {
      const c = USE_BASE[use] || USE_BASE.Residential;
      const m = q / 12;
      /* small per-building shift, warmer one way and cooler the other */
      const d = (tq / 5 - 0.5) * 22;
      s = fogged(Math.min(255, Math.max(0, (c[0] + d * 1.1) * m)),
                 Math.min(255, Math.max(0, (c[1] + d * 0.5) * m)),
                 Math.min(255, Math.max(0, (c[2] - d * 0.6) * m)), fq / 12);
      shadeCache.set(key, s);
    }
    return s;
  }

  const ROAD_STYLE = {
    /* display widths, ~35% over the earlier set so the network reads at city scale */
    expressway: { w: 96, c: [60, 78, 102], t: [132, 154, 182], min: 5.4 },
    arterial:   { w: 70, c: [52, 66, 88],  t: [108, 128, 154], min: 4.4 },
    link:       { w: 48, c: [44, 56, 74],  t: [88, 105, 128],  min: 3.3 },
    bridge:     { w: 84, c: [70, 88, 114], t: [154, 182, 208], min: 5.4 }
  };
  /* Roads are drawn wider than life so the network reads from far away. Close
     in, that exaggeration makes neighbouring carriageways pile on top of each
     other at interchanges, so the drawn width eases back toward the real
     width (about 45% of the overview width) as the camera comes down. */
  const roadZoomK = () => { const t = Math.max(0, Math.min(1, (cam.dist - 1200) / 4800)); return 0.45 + 0.55 * t * t * (3 - 2 * t); };
  const RW = cls => (ROAD_STYLE[cls] || ROAD_STYLE.link).w * roadZoomK();
  const CONG = [[63, 190, 132], [154, 200, 96], [237, 174, 69], [238, 127, 69], [236, 95, 112]];
  /* emergency response bands: reachable in 5 / 10 / 15 / over 15 minutes */
  const ISO_BAND = [[63, 190, 132], [154, 200, 96], [237, 174, 69], [236, 95, 112]];

  /* ------------------------------------------------------------ draw items */
  let items = [];
  /* Ground-level roads and rail lie flat under everything, so they are drawn
     in their own pass first. Sorting a long road by its midpoint against the
     buildings beside it made it pop over and under them as the camera turned. */
  let groundItems = [], deckItems = [];
  function collect() {
    items.length = 0; groundItems.length = 0; deckItems.length = 0;
    const vr = cam.dist * 2.4 + 6000;           // view radius
    const g = city.graph;

    if (MT.layerOn('roads') || MT.layerOn('bridges')) {
      for (let i = 0; i < g.edges.length; i++) {
        const e = g.edges[i];
        if (e.road < 0) continue;
        const cls = e.cls;
        if (cls === 'bridge' && !MT.layerOn('bridges')) continue;
        if (cls !== 'bridge' && !MT.layerOn('roads')) continue;
        const na = g.nodes[e.a], nb = g.nodes[e.b];
        const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
        if (Math.hypot(mx - cam.tx, my - cam.ty) > vr) continue;
        proj(mx, my, 0, pa);
        if (pa.d < 120) continue;
        if (e.dup) continue;                       // shares a carriageway with a road already drawn
        const flat = !e.bridge && !(e.za > 0) && !(e.zb > 0);
        (flat ? groundItems : items).push({ d: pa.d, t: 1, e });
        /* bridges over water: piers and deck slabs go in one pass beneath all
           carriageways, so twin decks (Sea Link, Atal Setu) never patch over
           each other's road surface */
        if (e.bridge && e.overWater) deckItems.push({ d: pa.d, e });
      }
    }
    if (MT.layerOn('rail') || MT.layerOn('metro')) {
      for (const L of railSegs) {
        if (L.kind === 'metro' && !MT.layerOn('metro')) continue;
        if (L.kind === 'rail' && !MT.layerOn('rail')) continue;
        if (Math.hypot(L.mx - cam.tx, L.my - cam.ty) > vr) continue;
        proj(L.mx, L.my, L.z, pa);
        let dd = pa.d;
        if (dd < 120) {                              // midpoint behind the eye: keep the visible end
          proj(L.ax, L.ay, L.z, pc); proj(L.bx, L.by, L.z, pd);
          const far = Math.max(pc.d, pd.d);
          if (far < 140) continue;
          dd = (far + 110) / 2;
        }
        /* a rail flyover sorts slightly nearer than the line it passes over */
        (L.z > 0 ? items : groundItems).push({ d: dd - Math.max(0, L.z - 5) * 4, t: 2, L });
      }
    }
    if (MT.layerOn('buildings') && MT.state.showBuildings) {
      const yr = MT.state.year;
      const all = city.buildings, vr2 = vr * vr;
      /* The hologram draws a distant building as one lit stroke, so it can
         afford to keep the far fabric. A lit prism costs gradients, floor
         bands and a cast shadow, so it drops the same buildings earlier. */
      const ql = QUAL[qLevel].lod;
      const minHpx = (holo() ? 1.0 : 2.9) * ql, minApx = (holo() ? 6 : 56) * ql;   // lit scaled with focal²
      for (let i = 0; i < all.length; i++) {
        const b = all[i];
        if (b.year > yr) continue;
        const ddx = b.x - cam.tx, ddy = b.y - cam.ty;
        if (ddx * ddx + ddy * ddy > vr2) continue;
        proj(b.x, b.y, 0, pa);
        if (pa.d < 150) continue;
        if (pa.x < -180 || pa.x > W + 180 || pa.y < -260 || pa.y > H + 180) continue;
        const spx = focal / pa.d;
        /* screen-area LOD: a 3 px smudge costs five fills and shows nothing */
        /* Screen-area LOD. Kept generous so that the whole-city view still
           carries its built fabric — a city of roads with no buildings on it
           reads as a network diagram, not a twin. */
        const lod = Math.min(b.h * spx / minHpx, b.area * spx * spx / minApx);
        if (lod < 1) continue;
        /* fade in across the LOD threshold instead of popping on and off */
        items.push({ d: pa.d, t: 0, b, f: Math.min(1, lod - 1) });
      }
    }
    for (const p of MT.state.placed) {
      proj(p.x, p.y, 0, pa);
      if (pa.d > 150) items.push({ d: pa.d, t: 3, p });
    }
    if (MT.layerOn('bridges')) for (const T of city.bridgeTowers || []) {
      if (Math.hypot(T.x - cam.tx, T.y - cam.ty) > vr) continue;
      proj(T.x, T.y, 0, pa);
      if (pa.d > 150) items.push({ d: pa.d, t: 6, T });
    }
    if (MT.layerOn('airport')) for (const A of city.airports || []) {
      for (const t of A.terminals) { proj(t.x, t.y, 0, pa); if (pa.d > 150 && Math.hypot(t.x - cam.tx, t.y - cam.ty) < vr) items.push({ d: pa.d, t: 7, term: t }); }
      if (A.tower) { proj(A.tower.x, A.tower.y, 0, pa); if (pa.d > 150 && Math.hypot(A.tower.x - cam.tx, A.tower.y - cam.ty) < vr) items.push({ d: pa.d, t: 8, twr: A.tower }); }
    }
    if (MT.layerOn('rail') && cam.dist < 9000) for (const Pf of city.platforms || []) {
      if (Math.abs(Pf.x - cam.tx) > vr || Math.abs(Pf.y - cam.ty) > vr) continue;
      proj(Pf.x, Pf.y, Pf.z, pa); if (pa.d > 150) items.push({ d: pa.d - 40, t: 10, pf: Pf });
    }
    if (MT.layerOn('heritage')) for (const M of city.monuments || []) {
      if (Math.hypot(M.x - cam.tx, M.y - cam.ty) > vr) continue;
      proj(M.x, M.y, 0, pa); if (pa.d > 120) items.push({ d: pa.d, t: 9, mon: M });
    }
    if (MT.layerOn('twins')) for (const tw of city.twins || []) {
      proj(tw.x, tw.y, 0, pa);
      if (pa.d > 150 && pa.x > -400 && pa.x < W + 400 && pa.y > -600 && pa.y < H + 400)
        items.push({ d: pa.d, t: 5, tw });
    }
    if (MT.motion && MT.motion.on()) MT.motion.collect(items);
    items.sort((a, b) => b.d - a.d);
    groundItems.sort((a, b) => b.d - a.d);
    deckItems.sort((a, b) => b.d - a.d);
  }

  /* pre-flatten rail/metro into segments */
  const railSegs = [];
  function buildRailSegs() {
    const add = (line, kind, z, color, dash) => {
      const p = (city.railXY && city.railXY[line.id]) || geo.pathXY(line.stations.map(s => [s.lon, s.lat]));
      const Z = city.railZ && city.railZ[line.id];
      for (let i = 0; i < p.length - 2; i += 2) {
        const za0 = Z ? Z[i / 2] : z, zb0 = Z ? Z[i / 2 + 1] : z;
        /* Drawn in pieces of at most 150 m. A station-to-station run can be
           2 km long, and sorted by its midpoint it was drawn after buildings
           standing behind its near end — so they appeared on the tracks. */
        const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]), n = Math.max(1, Math.ceil(len / 150));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const ax = p[i] + (p[i + 2] - p[i]) * t0, ay = p[i + 1] + (p[i + 3] - p[i + 1]) * t0;
          const bx = p[i] + (p[i + 2] - p[i]) * t1, by = p[i + 1] + (p[i + 3] - p[i + 1]) * t1;
          const za = za0 + (zb0 - za0) * t0, zb = za0 + (zb0 - za0) * t1;
          railSegs.push({
            ax, ay, bx, by, mx: (ax + bx) / 2, my: (ay + by) / 2,
            z: (za + zb) / 2, za, zb, el: kind === 'rail' && Math.min(za, zb) > 8,   // el: on a rail flyover
            kind, color, dash, name: line.name
          });
        }
      }
    };
    MT.RAIL.forEach(l => add(l, 'rail', 5, l.color, false));   // raised bed: bridge piers read over creeks
    MT.METRO.forEach(l => { add(l, 'metro', l.underground ? 0 : 11, l.color, l.status !== 'operational' && !l.underground);
      if (l.underground) for (const S of railSegs) if (S.name === l.name) S.ug = true; });
  }
  buildRailSegs();

  /* ---------------------------------------------------------------- render */
  /* ------------------------------------------------------------- buildings */
  /* Footprints are N-gons, not boxes: chamfered towers, L-plans and clipped
     slabs, with an optional podium setback. Faces carry a vertical gradient,
     roofs a parapet inset, and the whole stock casts shadows from the same
     sun that lights it. */
  const MAXV = 20;
  const wx = new Float64Array(MAXV), wy = new Float64Array(MAXV);
  const SA = [], SB = [];
  for (let i = 0; i < MAXV; i++) { SA.push(P()); SB.push(P()); }

  function drawPrism(b, scale, z0, z1, fg, sel, opts) {
    const poly = b.poly, n = poly.length / 2;
    const cr = Math.cos(b.rot), sr = Math.sin(b.rot);
    for (let i = 0; i < n; i++) {
      const lx = poly[i * 2] * scale, ly = poly[i * 2 + 1] * scale;
      wx[i] = b.x + lx * cr - ly * sr;
      wy[i] = b.y + lx * sr + ly * cr;
      proj(wx[i], wy[i], z0, SA[i]);
      proj(wx[i], wy[i], z1, SB[i]);
    }
    const ph = Math.abs(SA[0].y - SB[0].y);
    /* after dark the sun contributes nothing, so ambient has to carry the
       massing — otherwise the stock sinks below the sodium-lit ground */
    const amb = 0.46 + 0.10 * sun.day, dif = 0.10 + 0.62 * sun.day;
    const detail = ph > 15 && fg < 0.62;
    const rich = ph > 30 && fg < 0.5;   // gradient + specular budget
    const glassy = b.use === 'Commercial' || b.use === 'Mixed use';

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = wx[j] - wx[i], ey = wy[j] - wy[i];
      const nx = ey, ny = -ex;
      const mx = (wx[i] + wx[j]) / 2, my = (wy[i] + wy[j]) / 2;
      if (nx * (camX - mx) + ny * (camY - my) <= 0) continue;
      const len = Math.hypot(nx, ny) || 1;
      const face = (nx / len) * sun.dx + (ny / len) * sun.dy;
      const lit = amb + dif * Math.max(0, face);

      if (sel) {
        ctx.fillStyle = HOV ? 'rgba(236,72,180,' + (0.62 + lit * 0.34) + ')'
                            : 'rgba(63,211,230,' + (0.55 + lit * 0.35) + ')';
      } else if (rich) {
        /* vertical falloff: streets are darker than the sky-facing upper floors */
        const g = ctx.createLinearGradient(
          (SB[i].x + SB[j].x) / 2, (SB[i].y + SB[j].y) / 2,
          (SA[i].x + SA[j].x) / 2, (SA[i].y + SA[j].y) / 2);
        g.addColorStop(0, shadeColor(b.use, lit * (1.08 + 0.10 * sun.day), fg, b.tint));
        g.addColorStop(1, shadeColor(b.use, lit * (0.82 - 0.16 * sun.day), fg, b.tint));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = shadeColor(b.use, lit, fg, b.tint);
      }
      ctx.beginPath();
      ctx.moveTo(SA[i].x, SA[i].y); ctx.lineTo(SA[j].x, SA[j].y);
      ctx.lineTo(SB[j].x, SB[j].y); ctx.lineTo(SB[i].x, SB[i].y);
      ctx.closePath(); ctx.fill();

      /* a soft specular band down the sun-facing glass */
      if (rich && glassy && !sel && face > 0.55 && sun.day > 0.25) {
        const t0 = 0.30, t1 = 0.46;
        ctx.fillStyle = 'rgba(226,244,255,' + (0.13 * sun.day * (1 - fg)).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(SA[i].x + (SA[j].x - SA[i].x) * t0, SA[i].y + (SA[j].y - SA[i].y) * t0);
        ctx.lineTo(SA[i].x + (SA[j].x - SA[i].x) * t1, SA[i].y + (SA[j].y - SA[i].y) * t1);
        ctx.lineTo(SB[i].x + (SB[j].x - SB[i].x) * t1, SB[i].y + (SB[j].y - SB[i].y) * t1);
        ctx.lineTo(SB[i].x + (SB[j].x - SB[i].x) * t0, SB[i].y + (SB[j].y - SB[i].y) * t0);
        ctx.closePath(); ctx.fill();
      }

      /* lit floor bands after dark */
      if (opts.bands && !sel) {
        ctx.strokeStyle = 'rgba(255,209,150,' + (opts.warmth * (1 - fg) * (0.6 + lit * 0.5)).toFixed(3) + ')';
        ctx.lineWidth = Math.max(0.6, ph / (opts.bands * 7));
        ctx.beginPath();
        for (let k = 1; k <= opts.bands; k++) {
          const t = k / (opts.bands + 1);
          ctx.moveTo(SA[i].x + (SB[i].x - SA[i].x) * t, SA[i].y + (SB[i].y - SA[i].y) * t);
          ctx.lineTo(SA[j].x + (SB[j].x - SA[j].x) * t, SA[j].y + (SB[j].y - SA[j].y) * t);
        }
        ctx.stroke();
      }
    }

    /* roof */
    ctx.fillStyle = HOV ? '#FF8AD8' : sel ? '#7FEBFA' : shadeColor(b.use, 0.64 + 0.86 * sun.day, fg, b.tint);
    ctx.beginPath();
    ctx.moveTo(SB[0].x, SB[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(SB[i].x, SB[i].y);
    ctx.closePath(); ctx.fill();

    if (detail && !sel && ph > 38) {
      /* parapet: a slightly inset, slightly darker deck reads as a real roof */
      let cxs = 0, cys = 0;
      for (let i = 0; i < n; i++) { cxs += SB[i].x; cys += SB[i].y; }
      cxs /= n; cys /= n;
      ctx.fillStyle = shadeColor(b.use, 0.48 + 0.64 * sun.day, fg, b.tint);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const px = cxs + (SB[i].x - cxs) * 0.82, py = cys + (SB[i].y - cys) * 0.82;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
    if (ph > 46 && !sel && sun.night > 0.3) {       // obstruction light on towers
      ctx.strokeStyle = 'rgba(168,214,236,' + (0.34 * (1 - fg) * sun.night).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(SB[0].x, SB[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(SB[i].x, SB[i].y);
      ctx.closePath(); ctx.stroke();
    }
    return ph;
  }

  /* ------------------------------------------------------ hover aura ---
     The building under the cursor turns magenta — a colour no other layer
     uses, so it cannot be mistaken for a road, a train or a selection — and
     is wrapped in a soft glow with a pulsing ring on the ground beneath it.
     Its roof point is published so the UI can pin a readout card to it. */
  let HOV = false;
  const HOV_RGB = '255,95,200', SEL_RGB = '120,240,255';
  const auA = P(), auB = P();
  R.hoverAnchor = null;
  function drawAura(b, h, podH, fg, rgb) {
    const al = 1 - fg * 0.8;
    const poly = b.poly, n = poly.length / 2;
    const cr = Math.cos(b.rot), sr = Math.sin(b.rot);
    const ts = podH > 0 ? b.tScale : 1;
    const pulse = 0.5 + 0.5 * Math.sin(holoPhase * 6);
    /* ground ring: a footprint-sized ellipse, breathing */
    const rad = Math.hypot(b.w, b.d) * 0.62 * (1 + 0.10 * pulse);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    for (let k = 0; k <= 28; k++) {
      const th = k / 28 * Math.PI * 2;
      proj(b.x + Math.cos(th) * rad, b.y + Math.sin(th) * rad, 0.4, auA);
      if (k === 0) ctx.moveTo(auA.x, auA.y); else ctx.lineTo(auA.x, auA.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(' + rgb + ',' + (0.10 * al).toFixed(3) + ')'; ctx.fill();
    ctx.strokeStyle = 'rgba(' + rgb + ',' + ((0.45 + 0.35 * pulse) * al).toFixed(3) + ')';
    ctx.lineWidth = 1.6; ctx.stroke();
    /* silhouette glow: every vertical edge and the crown, blurred */
    ctx.shadowColor = 'rgba(' + rgb + ',0.95)';
    ctx.shadowBlur = 14 + 8 * pulse;
    ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.85 * al).toFixed(3) + ')';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const lx = poly[i * 2] * ts, ly = poly[i * 2 + 1] * ts;
      const x = b.x + lx * cr - ly * sr, y = b.y + lx * sr + ly * cr;
      proj(x, y, podH, auA); proj(x, y, h, auB);
      ctx.moveTo(auA.x, auA.y); ctx.lineTo(auB.x, auB.y);
    }
    for (let i = 0; i <= n; i++) {
      const k = i % n, lx = poly[k * 2] * ts, ly = poly[k * 2 + 1] * ts;
      proj(b.x + lx * cr - ly * sr, b.y + lx * sr + ly * cr, h, auB);
      if (i === 0) ctx.moveTo(auB.x, auB.y); else ctx.lineTo(auB.x, auB.y);
    }
    ctx.stroke();
    /* a beam from the roof up to where the card is pinned */
    proj(b.x, b.y, h, auA); proj(b.x, b.y, h + Math.max(24, h * 0.18), auB);
    ctx.shadowBlur = 0;
    const g = ctx.createLinearGradient(auA.x, auA.y, auB.x, auB.y);
    g.addColorStop(0, 'rgba(' + rgb + ',' + (0.9 * al).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.strokeStyle = g; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(auA.x, auA.y); ctx.lineTo(auB.x, auB.y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,240,250,' + al.toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(auA.x, auA.y, 2.4, 0, 6.283); ctx.fill();
    ctx.restore();
    if (rgb === HOV_RGB) R.hoverAnchor = { x: auB.x, y: auB.y };
    dirty = true;                                  // keep the pulse alive
  }

  function drawBuilding(b, depth) {
    const fg = fogAmt(depth);
    const h = b.h * (MT.state.vscale || 1);
    const sel = MT.state.selection && MT.state.selection.kind === 'building' && MT.state.selection.ref === b;

    proj(b.x, b.y, 0, pa); proj(b.x, b.y, h, pb);
    const ph = Math.abs(pa.y - pb.y);
    const bands = (ph > 24 && b.floors >= 5 && b.use !== 'Industrial' && fg < 0.55)
      ? Math.min(8, Math.max(2, Math.round(ph / 13))) : 0;
    const opts = { bands, warmth: (0.09 + ((b.year * 7 + b.floors) % 5) * 0.025) * sun.night, top: true };
    if (opts.warmth < 0.01) opts.bands = 0;

    const podH = b.podH * (MT.state.vscale || 1);
    const prism = holo() ? drawPrismHolo : drawPrism;
    HOV = MT.state.hover === b && !sel;
    if (podH > 0 && ph > 10) {
      prism(b, 1, 0, podH, fg, sel || HOV, { bands: 0, warmth: 0 });
      prism(b, b.tScale, podH, h, fg, sel || HOV, opts);
    } else {
      prism(b, 1, 0, h, fg, sel || HOV, opts);
    }
    if (HOV || sel) drawAura(b, h, podH, fg, sel ? SEL_RGB : HOV_RGB);
    HOV = false;

    const fl = MT.state.flood;
    if (fl) {
      const k = city.cellIndex(b.x, b.y);
      const flooded = k >= 0 ? fl.depth[k] : 0;
      if (flooded > 0.15) {                        // waterline against the facade
        const wl = Math.min(flooded, b.h * 0.9);
        const poly = b.poly, n = poly.length / 2;
        const cr = Math.cos(b.rot), sr = Math.sin(b.rot);
        ctx.fillStyle = 'rgba(92,168,255,0.42)';
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const lx = poly[i * 2], ly = poly[i * 2 + 1];
          proj(b.x + lx * cr - ly * sr, b.y + lx * sr + ly * cr, wl, pc);
          i ? ctx.lineTo(pc.x, pc.y) : ctx.moveTo(pc.x, pc.y);
        }
        ctx.closePath(); ctx.fill();
      }
    }
  }

  /* --------------------------------------------------------------- shadows */
  /* One batched pass over the visible stock. A building's shadow is its
     footprint swept away from the sun by height / tan(elevation), plus a tight
     contact shadow that persists after dark — which is what stops the massing
     floating off the ground.

     The swept outline is built by walking the footprint once and switching
     between the base and offset copies at the two silhouette edges. That is
     O(n) with no allocation, which matters when it runs for a few thousand
     buildings every frame. */
  const shBX = new Float64Array(MAXV), shBY = new Float64Array(MAXV);
  const shSign = new Uint8Array(MAXV);
  const sp1 = P(), sp2 = P();

  function sweepOutline(b, ox, oy, grow) {
    const poly = b.poly, n = poly.length / 2;
    const cr = Math.cos(b.rot), sr = Math.sin(b.rot);
    for (let i = 0; i < n; i++) {
      const lx = poly[i * 2] * grow, ly = poly[i * 2 + 1] * grow;
      shBX[i] = b.x + lx * cr - ly * sr;
      shBY[i] = b.y + lx * sr + ly * cr;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = shBX[j] - shBX[i], ey = shBY[j] - shBY[i];
      shSign[i] = (ey * ox - ex * oy) > 0 ? 1 : 0;   // outward normal is (ey, -ex)
    }
    let started = false;
    const emit = (x, y, z) => {
      proj(x, y, z, sp1);
      if (!started) { ctx.moveTo(sp1.x, sp1.y); started = true; } else ctx.lineTo(sp1.x, sp1.y);
    };
    for (let i = 0; i < n; i++) {
      const prev = shSign[(i + n - 1) % n], cur = shSign[i];
      if (prev === 0 && cur === 0) emit(shBX[i], shBY[i], 0.5);
      else if (prev === 1 && cur === 1) emit(shBX[i] + ox, shBY[i] + oy, 0.5);
      else if (prev === 0) { emit(shBX[i], shBY[i], 0.5); emit(shBX[i] + ox, shBY[i] + oy, 0.5); }
      else { emit(shBX[i] + ox, shBY[i] + oy, 0.5); emit(shBX[i], shBY[i], 0.5); }
    }
    ctx.closePath();
  }

  function drawShadows(list) {
    if (!MT.layerOn('buildings')) return;
    const castable = sun.alt > 3;
    const tanA = Math.tan(Math.max(4, sun.alt) * D2R);
    ctx.beginPath();
    let drew = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.t !== 0) continue;
      if (fogAmt(it.d) > 0.6) continue;
      const b = it.b;
      const h = b.h * (MT.state.vscale || 1);
      if (h * focal / it.d < 4) continue;
      const reach = castable ? Math.min(h / tanA, h * 5.5) : 0;
      sweepOutline(b, -sun.dx * reach, -sun.dy * reach, 1.1);
      drew++;
    }
    if (!drew) return;
    ctx.fillStyle = 'rgba(4,8,18,' + (0.19 + 0.17 * sun.day).toFixed(3) + ')';
    ctx.fill();
  }

  /* How far a butt-ended band must run past each end of an edge to close the
     wedge at that node: half-width × tan(bend/2), where the bend is measured
     against the most nearly straight continuation on the same corridor.
     Straight-through nodes get 0, so densified polylines add no overlap. */
  let bendReady = false;
  function computeBends() {
    const g = city.graph, inc = new Map();
    for (const e of g.edges) {
      if (e.road < 0) continue;
      for (const n of [e.a, e.b]) { if (!inc.has(n)) inc.set(n, []); inc.get(n).push(e); }
    }
    const away = (e, n) => {
      const A = g.nodes[n], B = g.nodes[n === e.a ? e.b : e.a];
      const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
      return [dx / L, dy / L];
    };
    for (const e of g.edges) {
      if (e.road < 0) continue;
      for (const [n, key] of [[e.a, '_tA'], [e.b, '_tB']]) {
        const u = away(e, n);
        let best = -2, bv = null;                        // cos of the continuation angle
        for (const f of inc.get(n) || []) {
          if (f === e || f.road !== e.road) continue;
          const v = away(f, n);
          const c = -(u[0] * v[0] + u[1] * v[1]);        // 1 = dead straight
          if (c > best) { best = c; bv = v; }
        }
        /* mitre factor for solid decks: along-edge shift per metre of offset
           so the slab end lies on the bisector and meets its neighbour exactly */
        const mk = key === '_tA' ? '_fA' : '_fB';
        e[mk] = 0;
        if (bv) {
          const A0 = g.nodes[e.a], B0 = g.nodes[e.b], Le = Math.hypot(B0.x - A0.x, B0.y - A0.y) || 1;
          const nX = -(B0.y - A0.y) / Le, nY = (B0.x - A0.x) / Le;   // same normal as deckGeom
          let bx = u[0] + bv[0], by = u[1] + bv[1];
          if (Math.hypot(bx, by) > 1e-4) {
            const cnb = nX * by - nY * bx, cub = u[0] * by - u[1] * bx;
            if (Math.abs(cub) > 1e-4) e[mk] = Math.max(-0.45, Math.min(0.45, -cnb / cub));   // gentle mitres only: sharp ones spike past the kerb
          }
        }
        if (best < -1) { e[key] = 0; continue; }
        const th = Math.acos(Math.max(-1, Math.min(1, best)));   // bend angle
        e[key] = Math.min(1.2, Math.tan(th / 2));
      }
    }
    bendReady = true;
  }

  /* ------------------------------------------------------------ bridges ---
     A deck over water is drawn as a structure, not a line: twin-column piers
     with caps and footings, a girder under each deck edge, a lit railing with
     lamp beads on top, and — over water in hologram style — the whole thing
     mirrored faintly in the surface. Named cable-stayed spans add towers and
     stay cables (drawTower). Dimensions are illustrative. */
  const bA = P(), bB = P(), bC = P(), bD = P();
  const pq0 = P(), pq1 = P(), pq2 = P(), pq3 = P();
  /* One row of bridge piers, drawn as solid structure: columns with real
     width, a cap beam under the deck and a footing ring where they meet the
     water. (cx,cy) is the pier line centre, (nx,ny) the unit across-deck
     direction, span the half-width the columns spread over. */
  function drawPierRow(cx, cy, nx, ny, zTop, span, nCols, colW, fg, over) {
    const a = 1 - fg; if (a < 0.04 || zTop < 1) return;
    const HOLO = holo();
    const fill = HOLO ? 'rgba(72,118,190,' + (0.92 * a).toFixed(3) + ')' : I_LIT(142, 148, 160, fg);
    const side = HOLO ? 'rgba(42,70,128,' + (0.95 * a).toFixed(3) + ')' : I_LIT(104, 110, 122, fg);
    const edge = HOLO ? 'rgba(150,228,255,' + (0.95 * a).toFixed(3) + ')' : I_LIT(196, 202, 212, fg);
    const capT = Math.max(1.2, Math.min(2.2, zTop * 0.12));
    const zc = zTop - capT;
    /* columns */
    for (let k = 0; k < nCols; k++) {
      const o = nCols === 1 ? 0 : -span + (2 * span) * k / (nCols - 1);
      const x = cx + nx * o, y = cy + ny * o;
      proj(x, y, zc, pq0); proj(x, y, over ? -0.3 : 0, pq1);
      if (pq0.d < 60 || pq1.d < 60) continue;
      const w0 = Math.max(1.2, colW * focal / pq0.d) / 2, w1 = Math.max(1.2, colW * focal / pq1.d) / 2;
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.moveTo(pq0.x - w0, pq0.y); ctx.lineTo(pq0.x + w0, pq0.y);
      ctx.lineTo(pq1.x + w1, pq1.y); ctx.lineTo(pq1.x - w1, pq1.y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = side;                        // shaded half, so the column reads round
      ctx.beginPath(); ctx.moveTo(pq0.x + w0 * 0.15, pq0.y); ctx.lineTo(pq0.x + w0, pq0.y);
      ctx.lineTo(pq1.x + w1, pq1.y); ctx.lineTo(pq1.x + w1 * 0.15, pq1.y); ctx.closePath(); ctx.fill();
      if (w0 > 1.6) {
        ctx.strokeStyle = edge; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pq0.x - w0, pq0.y); ctx.lineTo(pq1.x - w1, pq1.y);
        ctx.moveTo(pq0.x + w0, pq0.y); ctx.lineTo(pq1.x + w1, pq1.y); ctx.stroke();
      }
      if (over && w1 > 1.5) {                      // footing ring at the waterline
        ctx.strokeStyle = HOLO ? 'rgba(160,230,255,' + (0.5 * a).toFixed(3) + ')' : 'rgba(220,235,245,' + (0.45 * a).toFixed(3) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(pq1.x, pq1.y, w1 * 1.7, w1 * 0.6, 0, 0, 6.283); ctx.stroke();
      }
    }
    /* cap beam across the full width */
    const cw = span + colW * 1.2;
    proj(cx + nx * cw, cy + ny * cw, zTop, pq0); proj(cx - nx * cw, cy - ny * cw, zTop, pq1);
    proj(cx - nx * cw, cy - ny * cw, zc, pq2); proj(cx + nx * cw, cy + ny * cw, zc, pq3);
    if (pq0.d > 60 && pq1.d > 60) {
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.moveTo(pq0.x, pq0.y); ctx.lineTo(pq1.x, pq1.y); ctx.lineTo(pq2.x, pq2.y); ctx.lineTo(pq3.x, pq3.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pq3.x, pq3.y); ctx.lineTo(pq2.x, pq2.y); ctx.lineTo(pq1.x, pq1.y); ctx.lineTo(pq0.x, pq0.y); ctx.closePath(); ctx.stroke();
    }
  }
  /* exact water test (shoreline rings, rivers, lakes) for where a railway
     is on a bridge — the 200 m grid misses narrow creeks and nullahs */
  function waterExact(x, y) {
    if (!city.isLand(x, y)) return true;
    for (const r of city.rivers) if (geo.distToPath(r.path, x, y) < r.w / 2 + 4) return true;
    for (const l of city.lakes) { const dx = (x - l.x) / l.rx, dy = (y - l.y) / l.ry; if (dx * dx + dy * dy < 1) return true; }
    return false;
  }
  function waterAtPt(x, y) { const k = city.cellIndex(x, y); return k < 0 || !city.land[k] || !!city.waterMask[k]; }
  function bridgeColours(fg) {
    const a = 1 - fg;
    return holo()
      ? { pier: 'rgba(96,206,255,' + (0.62 * a).toFixed(3) + ')', girder: 'rgba(120,220,255,' + (0.55 * a).toFixed(3) + ')',
          rail: 'rgba(170,236,255,' + (0.8 * a).toFixed(3) + ')', bead: 'rgba(200,245,255,' + (0.95 * a).toFixed(3) + ')',
          refl: 'rgba(90,190,255,' + (0.16 * a).toFixed(3) + ')', glow: true }
      : { pier: I_LIT(150, 158, 170, fg), girder: I_LIT(120, 128, 142, fg),
          rail: I_LIT(206, 212, 222, fg), bead: 'rgba(255,226,170,' + (0.85 * a * (0.25 + 0.75 * sun.night)).toFixed(3) + ')',
          refl: null, glow: false };
  }
  function I_LIT(r, g, b, fg) { return fogged(r * (0.55 + 0.45 * sun.day), g * (0.55 + 0.45 * sun.day), b * (0.55 + 0.45 * sun.day), fg); }
  function deckGeom(e) {
    const g = city.graph, A = g.nodes[e.a], B = g.nodes[e.b];
    const st = ROAD_STYLE[e.cls] || ROAD_STYLE.link;
    const L = e.len, ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
    return { A, B, L, ux, uy, nx: -uy, ny: ux, hw: RW(e.cls) * 0.85 / 2 };
  }
  /** piers, girders and reflection — drawn before the deck */
  function drawBridgeUnder(e, fg, pxScale) {
    const G2 = deckGeom(e), C = bridgeColours(fg);
    const S = e.cls === 'bridge' ? 70 : 60;
    const n = Math.max(1, Math.round(G2.L / S));
    const over = e.overWater;
    ctx.lineCap = 'round';
    if (C.glow) ctx.globalCompositeOperation = 'lighter';
    /* reflection first, so the real structure sits on top of it */
    if (C.refl && over && pxScale > 0.02) {
      ctx.strokeStyle = C.refl; ctx.lineWidth = Math.max(1, Math.min(3, 1.5 * pxScale * 6));
      ctx.beginPath();
      for (const side of [1, -1]) {
        proj(G2.A.x + G2.nx * G2.hw * side, G2.A.y + G2.ny * G2.hw * side, -(e.za || 0), bA);
        proj(G2.B.x + G2.nx * G2.hw * side, G2.B.y + G2.ny * G2.hw * side, -(e.zb || 0), bB);
        ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
      }
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, z = (e.za || 0) + ((e.zb || 0) - (e.za || 0)) * t;
        if (z < 2) continue;
        const cx = G2.A.x + (G2.B.x - G2.A.x) * t, cy = G2.A.y + (G2.B.y - G2.A.y) * t;
        for (const side of [0.55, -0.55]) {
          proj(cx + G2.nx * G2.hw * side, cy + G2.ny * G2.hw * side, 0, bA);
          proj(cx + G2.nx * G2.hw * side, cy + G2.ny * G2.hw * side, -z, bB);
          ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
        }
      }
      ctx.stroke();
    }
    /* piers only once a pier is a few pixels tall — below that they are noise */
    if (Math.max(e.za || 0, e.zb || 0) * pxScale < (over ? 1.2 : 4)) { ctx.globalCompositeOperation = 'source-over'; return; }   // land piers only once they read as columns
    /* piers: solid columns, cap beam and footing (see drawPierRow) */
    ctx.globalCompositeOperation = 'source-over';
    const nCols = G2.hw > 30 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, z = (e.za || 0) + ((e.zb || 0) - (e.za || 0)) * t;
      if (z < 2) continue;
      const cx = G2.A.x + (G2.B.x - G2.A.x) * t, cy = G2.A.y + (G2.B.y - G2.A.y) * t;
      drawPierRow(cx, cy, G2.nx, G2.ny, z, G2.hw * 0.62, nCols, e.cls === 'bridge' ? 4.2 : 3.2, fg, over);
    }
    if (C.glow) ctx.globalCompositeOperation = 'lighter';
    /* girders under both deck edges */
    ctx.strokeStyle = C.girder; ctx.lineWidth = Math.max(1, Math.min(3, 1.6 * pxScale * 6));
    ctx.beginPath();
    for (const side of [1, -1]) {
      proj(G2.A.x + G2.nx * G2.hw * side, G2.A.y + G2.ny * G2.hw * side, Math.max(0, (e.za || 0) - 1.4), bA);
      proj(G2.B.x + G2.nx * G2.hw * side, G2.B.y + G2.ny * G2.hw * side, Math.max(0, (e.zb || 0) - 1.4), bB);
      ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  /* The bridge deck as a solid concrete slab: its two edge faces, then the
     riding surface, all opaque, so piers and water sit under it rather than
     showing through the carriageway. */
  function drawDeckSlab(e, fg) {
    const G2 = deckGeom(e), a = 1 - fg;
    if (a < 0.04) return;
    const za = e.za || 0, zb = e.zb || 0, T = 2.6;
    const HOLO = holo();
    const top = HOLO ? (e.overWater ? 'rgba(24,32,52,' : 'rgba(58,46,34,') + (0.97 * a).toFixed(3) + ')' : I_LIT(88, 94, 106, fg);
    const face = HOLO ? 'rgba(40,62,104,' + (0.97 * a).toFixed(3) + ')' : I_LIT(120, 126, 138, fg);
    const hw = G2.hw;
    if (!bendReady) computeBends();
    /* ends mitred on the bisector of each bend, so neighbouring slabs meet
       edge to edge: no wedge gaps, and no overlap painting over the road */
    const fl = 0.35 * G2.L / Math.max(1, hw);            // a mitre may never take more than a third of a short link
    const mit = e.overWater ? 1 : 0;                     // flyovers over land: square ends, the carriageway covers the joint
    const fA = mit * Math.max(-fl, Math.min(fl, e._fA || 0)), fB = mit * Math.max(-fl, Math.min(fl, e._fB || 0));
    /* over land the slab stops a little short of each joint: the carriageway
       band covers the joint, and a square slab end can no longer poke out past
       a band end that is cut square on screen rather than on the ground */
    const ins = mit ? 0 : Math.min(G2.L * 0.2, hw * 0.6);
    const aX = o => G2.A.x + G2.ux * ins + G2.nx * o + G2.ux * fA * o, aY = o => G2.A.y + G2.uy * ins + G2.ny * o + G2.uy * fA * o;
    const bX = o => G2.B.x - G2.ux * ins + G2.nx * o - G2.ux * fB * o, bY = o => G2.B.y - G2.uy * ins + G2.ny * o - G2.uy * fB * o;
    const P4 = (o0, z0a, z0b, o1, z1a, z1b) => {
      proj(aX(o0), aY(o0), z0a, pq0); proj(bX(o0), bY(o0), z0b, pq1);
      proj(bX(o1), bY(o1), z1b, pq2); proj(aX(o1), aY(o1), z1a, pq3);
      if (pq0.d < 60 || pq1.d < 60 || pq2.d < 60 || pq3.d < 60) return false;
      ctx.beginPath(); ctx.moveTo(pq0.x, pq0.y); ctx.lineTo(pq1.x, pq1.y); ctx.lineTo(pq2.x, pq2.y); ctx.lineTo(pq3.x, pq3.y); ctx.closePath();
      return true;
    };
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = face;
    for (const sd of [1, -1]) if (P4(hw * sd, za, zb, hw * sd, Math.max(0, za - T), Math.max(0, zb - T))) ctx.fill();
    ctx.fillStyle = top;
    if (P4(hw, za, zb, -hw, za, zb)) ctx.fill();
  }
  /** railing and its lamp beads — drawn after the deck */
  function drawBridgeOver(e, fg, pxScale) {
    /* the railing and its beads only once the deck is wide enough on screen
       to show them apart — far away they pile up into a white smear */
    const deckPx = RW(e.cls) * 0.85 * pxScale;
    if (deckPx < 7) return;
    const beadsOn = 32 * pxScale > 20;               // lamps only close up — further out they merge into a white border
    const G2 = deckGeom(e), C = bridgeColours(fg);
    if (C.glow) ctx.globalCompositeOperation = 'lighter';
    /* girder fascia: a solid band down each deck edge, so the bridge reads
       as a structure with depth rather than a line in the air */
    ctx.fillStyle = C.glow ? 'rgba(90,190,255,' + (0.16 * (1 - fg)).toFixed(3) + ')' : I_LIT(96, 104, 118, fg);
    for (const side of [1, -1]) {
      const ox = G2.nx * G2.hw * side, oy = G2.ny * G2.hw * side;
      proj(G2.A.x + ox, G2.A.y + oy, (e.za || 0), bA); proj(G2.B.x + ox, G2.B.y + oy, (e.zb || 0), bB);
      proj(G2.B.x + ox, G2.B.y + oy, Math.max(0, (e.zb || 0) - 2.6), pc); proj(G2.A.x + ox, G2.A.y + oy, Math.max(0, (e.za || 0) - 2.6), pd);
      ctx.beginPath(); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); ctx.lineTo(pc.x, pc.y); ctx.lineTo(pd.x, pd.y); ctx.closePath(); ctx.fill();
    }
    /* on a flyover over land: lane markings painted on the slab itself */
    if (!e.overWater && deckPx > 40) {
      const za0 = e.za || 0, zb0 = e.zb || 0;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255,214,120,' + (0.75 * (1 - fg)).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, Math.min(2, pxScale * 0.25));
      ctx.beginPath();
      for (const o of [0.6, -0.6]) { proj(G2.A.x + G2.nx * o, G2.A.y + G2.ny * o, za0 + 0.05, bA); proj(G2.B.x + G2.nx * o, G2.B.y + G2.ny * o, zb0 + 0.05, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,240,210,' + (0.45 * (1 - fg)).toFixed(3) + ')';
      ctx.setLineDash([Math.max(2, 6 * pxScale), Math.max(2, 9 * pxScale)]);
      ctx.beginPath();
      for (const f of [0.5, -0.5]) { const o = G2.hw * f; proj(G2.A.x + G2.nx * o, G2.A.y + G2.ny * o, za0 + 0.05, bA); proj(G2.B.x + G2.nx * o, G2.B.y + G2.ny * o, zb0 + 0.05, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
      ctx.stroke(); ctx.setLineDash([]);
      if (C.glow) ctx.globalCompositeOperation = 'lighter';
    }
    /* two barrier rails per side: crash barrier and hand rail */
    ctx.strokeStyle = C.rail; ctx.lineWidth = Math.max(0.8, Math.min(1.5, pxScale * 5));
    ctx.beginPath();
    for (const side of [1, -1]) for (const hz of (deckPx > 40 ? [0.7, 1.4] : [1.4])) {
      proj(G2.A.x + G2.nx * G2.hw * side, G2.A.y + G2.ny * G2.hw * side, (e.za || 0) + hz, bA);
      proj(G2.B.x + G2.nx * G2.hw * side, G2.B.y + G2.ny * G2.hw * side, (e.zb || 0) + hz, bB);
      ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
    }
    ctx.stroke();
    if (!beadsOn) { ctx.globalCompositeOperation = 'source-over'; return; }
    /* lamp beads every ~32 m on each railing, sized in screen pixels */
    const nb = Math.max(1, Math.round(G2.L / 32));
    const r = Math.max(0.8, Math.min(1.8, pxScale * 9));
    ctx.fillStyle = C.bead;
    ctx.beginPath();
    for (let i = 0; i < nb; i++) {
      const t = (i + 0.5) / nb, z = (e.za || 0) + ((e.zb || 0) - (e.za || 0)) * t + 1.5;
      const cx = G2.A.x + (G2.B.x - G2.A.x) * t, cy = G2.A.y + (G2.B.y - G2.A.y) * t;
      for (const side of [1, -1]) {
        proj(cx + G2.nx * G2.hw * side, cy + G2.ny * G2.hw * side, z, bA);
        ctx.moveTo(bA.x + r, bA.y); ctx.arc(bA.x, bA.y, r, 0, 6.283);
      }
    }
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  /** A cable-stayed tower: inverted-Y legs, a single mast, two fans of stays
      to each deck edge on either side, an aviation light — and its reflection. */
  function drawTower(T, depth) {
    const fg = fogAmt(depth), a = 1 - fg;
    if (a < 0.03) return;
    const vs = MT.state.vscale || 1;
    const H = T.h * vs, dz = T.deckZ, st = ROAD_STYLE.bridge, hw = RW('bridge') * 0.85 / 2;
    const nx = -T.hy, ny = T.hx;
    const HOLO = holo();
    const P3 = (al, lat, z, out) => proj(T.x + T.hx * al + nx * lat, T.y + T.hy * al + ny * lat, z, out);
    const legBase = hw * 1.15, split = 0.58 * H;
    const span = Math.min(170, T.h * 1.35);           // stays land on the straight deck either side of the tower
    const N = 11;
    const pass = (zs, alpha) => {
      const col = HOLO ? 'rgba(120,225,255,' : 'rgba(226,232,240,';
      /* legs and mast, drawn as twin lines (a ~5 m thick member) */
      ctx.strokeStyle = col + (0.9 * alpha).toFixed(3) + ')';
      ctx.lineWidth = zs > 0 ? 1.6 : 1;
      ctx.beginPath();
      for (const off of [-2.5, 2.5]) {
        for (const side of [1, -1]) {
          P3(off, legBase * side, -1 * zs, bA); P3(off, 0, split * zs, bB);
          ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
        }
        P3(off, 0, split * zs, bA); P3(off, 0, H * zs, bB);
        ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
      }
      /* ladder rungs: the lattice look of the reference */
      const rungs = Math.max(4, Math.round(H / 12));
      for (let k = 1; k < rungs; k++) {
        const z = H * k / rungs;
        if (z < split) {
          const lat = legBase * (1 - z / split);
          for (const side of [1, -1]) { P3(-2.5, lat * side, z * zs, bA); P3(2.5, lat * side, z * zs, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
        } else { P3(-2.5, 0, z * zs, bA); P3(2.5, 0, z * zs, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
      }
      /* cross-beam under the deck */
      P3(0, legBase * 0.9, (dz - 2) * zs, bA); P3(0, -legBase * 0.9, (dz - 2) * zs, bB);
      ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
      ctx.stroke();
      /* stays: semi-harp, anchored up the mast, landing on both deck edges */
      ctx.strokeStyle = col + ((HOLO ? 0.55 : 0.6) * alpha).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k <= N; k++) {
        const zt = (split + (H - split) * (0.18 + 0.8 * k / N)) * zs;
        const d = span * k / N;
        for (const dir of [1, -1]) for (const side of [1, -1]) {
          P3(0, 0, zt, bA); P3(d * dir, hw * 0.92 * side, (dz + 1.3) * zs, bB);
          ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
        }
      }
      ctx.stroke();
    };
    if (HOLO) {
      ctx.globalCompositeOperation = 'lighter';
      pass(-1, 0.16 * a);                          // reflection in the water
      pass(1, a);
      /* beads along the outermost stays, like the lit cables of the reference */
      ctx.fillStyle = 'rgba(210,248,255,' + (0.9 * a).toFixed(3) + ')';
      ctx.beginPath();
      const zt = split + (H - split) * 0.98;
      for (const dir of [1, -1]) for (const side of [1, -1]) for (let q = 1; q < 8; q++) {
        const f = q / 8;
        P3(span * dir * f, hw * 0.92 * side * f, zt + (dz + 1.3 - zt) * f, bA);
        ctx.moveTo(bA.x + 1.6, bA.y); ctx.arc(bA.x, bA.y, 1.6, 0, 6.283);
      }
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else pass(1, a);
    /* aviation obstruction light */
    P3(0, 0, H + 2, bA);
    ctx.fillStyle = 'rgba(255,80,90,' + (0.95 * a).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(bA.x, bA.y, 2.4, 0, 6.283); ctx.fill();
  }

  /** Runways: outline, centreline, threshold bars and edge lights. */
  function drawRunways() {
    if (!MT.layerOn('airport')) return;
    for (const A of city.airports || []) drawAirfield(A);
  }
  function drawAirfield(A) {
    const HOLO = holo();
    /* apron: the paved stand area in front of each terminal */
    for (const t of A.terminals) {
      const c = Math.cos(t.rotR), s2 = Math.sin(t.rotR);
      /* apron sits on the runway side of the terminal (−y in the terminal frame) */
      const pts = [[-t.w / 2 - 60, -t.d / 2 - 260], [t.w / 2 + 60, -t.d / 2 - 260], [t.w / 2 + 60, -t.d / 2], [-t.w / 2 - 60, -t.d / 2]];
      let ok = true;
      ctx.beginPath();
      pts.forEach(([lx, ly], i) => { proj(t.x + lx * c - ly * s2, t.y + lx * s2 + ly * c, 0.2, bA); if (bA.d < 150) ok = false; if (i) ctx.lineTo(bA.x, bA.y); else ctx.moveTo(bA.x, bA.y); });
      if (!ok) continue;
      ctx.closePath();
      const fg = fogAmt(bA.d), a = 1 - fg;
      ctx.fillStyle = HOLO ? 'rgba(40,90,130,' + (0.30 * a).toFixed(3) + ')' : fogged(58, 62, 70, fg);
      ctx.fill();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = HOLO ? 'rgba(150,225,255,' + (0.45 * a).toFixed(3) + ')' : fogged(190, 196, 206, fg);
      ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    for (const r of A.runways) {
      /* parallel taxiway 190 m off the centreline, joined at both ends */
      {
        const nx = -r.uy * r.taxiSide, ny = r.ux * r.taxiSide, off = 190;
        proj(r.ax + nx * off, r.ay + ny * off, 0.25, bA); proj(r.bx + nx * off, r.by + ny * off, 0.25, bB);
        proj(r.ax, r.ay, 0.25, bC); proj(r.bx, r.by, 0.25, bD);
        if (bA.d > 150 && bB.d > 150 && bC.d > 150 && bD.d > 150) {
          const fg = fogAmt((bA.d + bB.d) / 2), a = 1 - fg;
          if (HOLO) ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = HOLO ? 'rgba(255,214,120,' + (0.55 * a).toFixed(3) + ')' : fogged(96, 102, 112, fg);
          ctx.lineWidth = Math.max(1.2, Math.min(6, 23 * focal / Math.max(1, (bA.d + bB.d) / 2)));
          ctx.beginPath();
          ctx.moveTo(bC.x, bC.y); ctx.lineTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); ctx.lineTo(bD.x, bD.y);
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      const hw = r.width / 2, nx = -r.uy, ny = r.ux;
      const corner = (t, s, z, out) => proj(r.ax + r.ux * t + nx * hw * s, r.ay + r.uy * t + ny * hw * s, z, out);
      corner(0, 1, 0.3, bA); corner(r.L, 1, 0.3, bB); corner(r.L, -1, 0.3, bC); corner(0, -1, 0.3, bD);
      if (bA.d < 150 || bB.d < 150 || bC.d < 150 || bD.d < 150) continue;
      const fg = fogAmt((bA.d + bC.d) / 2), a = 1 - fg;
      if (a < 0.03) continue;
      ctx.fillStyle = HOLO ? 'rgba(30,60,90,' + (0.55 * a).toFixed(3) + ')' : fogged(44, 48, 56, fg);
      ctx.beginPath(); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); ctx.lineTo(bC.x, bC.y); ctx.lineTo(bD.x, bD.y); ctx.closePath(); ctx.fill();
      if (HOLO) ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = HOLO ? 'rgba(170,235,255,' + (0.7 * a).toFixed(3) + ')' : fogged(214, 218, 226, fg);
      ctx.lineWidth = 1; ctx.stroke();
      /* dashed centreline */
      proj(r.ax, r.ay, 0.4, bA); proj(r.bx, r.by, 0.4, bB);
      const segPx = Math.hypot(bB.x - bA.x, bB.y - bA.y) / (r.L / 60);
      ctx.setLineDash([Math.max(2, segPx * 0.5), Math.max(2, segPx * 0.5)]);
      ctx.beginPath(); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); ctx.stroke();
      ctx.setLineDash([]);
      /* edge lights every 60 m, green at the thresholds */
      const n = Math.round(r.L / 60);
      ctx.fillStyle = HOLO ? 'rgba(220,248,255,' + (0.9 * a).toFixed(3) + ')' : 'rgba(255,236,190,' + (0.8 * a * (0.3 + 0.7 * sun.night)).toFixed(3) + ')';
      ctx.beginPath();
      for (let i = 0; i <= n; i++) for (const sd of [1, -1]) {
        corner(r.L * i / n, sd * 1.15, 0.5, bA);
        ctx.moveTo(bA.x + 1.3, bA.y); ctx.arc(bA.x, bA.y, 1.3, 0, 6.283);
      }
      ctx.fill();
      ctx.fillStyle = 'rgba(80,240,150,' + (0.95 * a).toFixed(3) + ')';
      ctx.beginPath();
      for (const t of [0, r.L]) for (let q = -3; q <= 3; q++) {
        corner(t, q / 3, 0.5, bA);
        ctx.moveTo(bA.x + 1.5, bA.y); ctx.arc(bA.x, bA.y, 1.5, 0, 6.283);
      }
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /* Terminal: an edge-lit glass hall with a roof grid and gate stands. */
  function drawTerminal(t, depth) {
    const fg = fogAmt(depth), a = 1 - fg;
    if (a < 0.03) return;
    const HOLO = holo(), vs = Math.min(MT.state.vscale || 1, 1.6);
    const c = Math.cos(t.rotR), s2 = Math.sin(t.rotR), H = t.h * vs;
    const P2 = (lx, ly, z, out) => proj(t.x + lx * c - ly * s2, t.y + lx * s2 + ly * c, z, out);
    const cx = [-t.w / 2, t.w / 2, t.w / 2, -t.w / 2], cy = [-t.d / 2, -t.d / 2, t.d / 2, t.d / 2];
    const line = HOLO ? 'rgba(200,240,255,' : 'rgba(210,216,226,';
    /* body faces */
    ctx.fillStyle = HOLO ? 'rgba(20,70,110,' + (0.42 * a).toFixed(3) + ')' : fogged(120 + 60 * sun.day, 128 + 60 * sun.day, 140 + 60 * sun.day, fg);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      P2(cx[i], cy[i], 0, bA); P2(cx[j], cy[j], 0, bB); P2(cx[j], cy[j], H, bC); P2(cx[i], cy[i], H, bD);
      if (bA.d < 150) return;
      ctx.beginPath(); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); ctx.lineTo(bC.x, bC.y); ctx.lineTo(bD.x, bD.y); ctx.closePath(); ctx.fill();
    }
    ctx.beginPath();
    for (let i = 0; i < 4; i++) { P2(cx[i], cy[i], H, bA); i ? ctx.lineTo(bA.x, bA.y) : ctx.moveTo(bA.x, bA.y); }
    ctx.closePath();
    ctx.fillStyle = HOLO ? 'rgba(40,110,160,' + (0.45 * a).toFixed(3) + ')' : fogged(170 + 50 * sun.day, 176 + 50 * sun.day, 186 + 50 * sun.day, fg);
    ctx.fill();
    if (HOLO) ctx.globalCompositeOperation = 'lighter';
    /* roof grid, glazing lines and outline */
    ctx.strokeStyle = line + ((HOLO ? 0.35 : 0.4) * a).toFixed(3) + ')'; ctx.lineWidth = 1;
    ctx.beginPath();
    const nx = Math.max(2, Math.round(t.w / 30)), ny = Math.max(2, Math.round(t.d / 30));
    for (let i = 1; i < nx; i++) { const lx = -t.w / 2 + t.w * i / nx; P2(lx, -t.d / 2, H, bA); P2(lx, t.d / 2, H, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
      P2(lx, -t.d / 2, 0, bC); P2(lx, -t.d / 2, H, bD); ctx.moveTo(bC.x, bC.y); ctx.lineTo(bD.x, bD.y); }
    for (let j = 1; j < ny; j++) { const ly = -t.d / 2 + t.d * j / ny; P2(-t.w / 2, ly, H, bA); P2(t.w / 2, ly, H, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
    for (const f of [0.5]) { P2(-t.w / 2, -t.d / 2, H * f, bA); P2(t.w / 2, -t.d / 2, H * f, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
    ctx.stroke();
    ctx.strokeStyle = line + (0.95 * a).toFixed(3) + ')'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) { P2(cx[i], cy[i], 0, bA); P2(cx[i], cy[i], H, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
    for (let i = 0; i <= 4; i++) { P2(cx[i % 4], cy[i % 4], H, bA); i ? ctx.lineTo(bA.x, bA.y) : ctx.moveTo(bA.x, bA.y); }
    ctx.stroke();
    /* gate stands along the airside face: jet bridges reaching onto the apron */
    if (t.d > 60 && focal / depth > 0.25) {
      const nG = Math.max(2, Math.round(t.w / 70));
      ctx.strokeStyle = line + (0.7 * a).toFixed(3) + ')'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let g = 0; g < nG; g++) {
        const lx = -t.w / 2 + t.w * (g + 0.5) / nG;
        P2(lx, -t.d / 2, 6, bA); P2(lx + 8, -t.d / 2 - 38, 5, bB);
        ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------------------------------------------------- heritage models ---
     Wireframe models of Mumbai's best-known heritage buildings, in a warm
     "stone" white so they read apart from the cyan generated stock. Heights
     are close to the real buildings; the geometry is simplified. */
  function drawMonument(M, depth) {
    const fg = fogAmt(depth), a = 1 - fg;
    if (a < 0.03) return;
    const HOLO = holo(), vs = Math.min(MT.state.vscale || 1, 1.8), sel = MT.state.hover === M;
    const c = Math.cos(M.rotR), s2 = Math.sin(M.rotR);
    const P3 = (lx, ly, z, out) => proj(M.x + lx * c - ly * s2, M.y + lx * s2 + ly * c, z * vs, out);
    proj(M.x, M.y, 0, bA); if (bA.d < 120) return;
    const px = focal / depth;                      // pixels per metre here
    const col = (al) => (sel ? 'rgba(255,150,220,' : HOLO ? 'rgba(255,232,188,' : 'rgba(236,226,206,') + (al * a).toFixed(3) + ')';
    if (HOLO) ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const seg = (x0, y0, z0, x1, y1, z1) => { P3(x0, y0, z0, bA); P3(x1, y1, z1, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); };
    const box = (x0, y0, x1, y1, z0, z1) => {
      for (const z of [z0, z1]) { P3(x0, y0, z, bA); ctx.moveTo(bA.x, bA.y); P3(x1, y0, z, bA); ctx.lineTo(bA.x, bA.y); P3(x1, y1, z, bA); ctx.lineTo(bA.x, bA.y); P3(x0, y1, z, bA); ctx.lineTo(bA.x, bA.y); P3(x0, y0, z, bA); ctx.lineTo(bA.x, bA.y); }
      seg(x0, y0, z0, x0, y0, z1); seg(x1, y0, z0, x1, y0, z1); seg(x1, y1, z0, x1, y1, z1); seg(x0, y1, z0, x0, y1, z1);
    };
    const shellFill = (x0, y0, x1, y1, z1) => {
      ctx.beginPath(); P3(x0, y0, z1, bA); ctx.moveTo(bA.x, bA.y); P3(x1, y0, z1, bA); ctx.lineTo(bA.x, bA.y); P3(x1, y1, z1, bA); ctx.lineTo(bA.x, bA.y); P3(x0, y1, z1, bA); ctx.lineTo(bA.x, bA.y); ctx.closePath();
      ctx.fillStyle = HOLO ? 'rgba(255,214,150,' + (0.08 * a).toFixed(3) + ')' : fogged(196, 184, 160, fg); ctx.fill();
    };
    const ring = (cx, cy, r, z, n2) => { for (let k = 0; k <= n2; k++) { const th = k / n2 * 6.283; P3(cx + Math.cos(th) * r, cy + Math.sin(th) * r, z, bA); k ? ctx.lineTo(bA.x, bA.y) : ctx.moveTo(bA.x, bA.y); } };
    const dome = (cx, cy, r, z, h, n2) => {           // meridians + two rings, and a finial
      for (let m = 0; m < 8; m++) { const th = m / 8 * 6.283; for (let k = 0; k <= 6; k++) { const ph = k / 6 * Math.PI / 2; P3(cx + Math.cos(th) * r * Math.cos(ph), cy + Math.sin(th) * r * Math.cos(ph), z + h * Math.sin(ph), bA); k ? ctx.lineTo(bA.x, bA.y) : ctx.moveTo(bA.x, bA.y); } }
      ring(cx, cy, r, z, n2); ring(cx, cy, r * 0.7, z + h * 0.72, n2);
      seg(cx, cy, z + h, cx, cy, z + h + h * 0.35);
    };
    const turret = (cx, cy, r, z0, z1) => {
      for (let m = 0; m < 8; m++) { const th = m / 8 * 6.283; seg(cx + Math.cos(th) * r, cy + Math.sin(th) * r, z0, cx + Math.cos(th) * r, cy + Math.sin(th) * r, z1); }
      ring(cx, cy, r, z0, 8); ring(cx, cy, r, z1, 8); dome(cx, cy, r, z1, r * 1.3, 8);
    };
    const arch = (x0, x1, y, zs, zt) => {             // round arch in the plane y = const
      const cxm = (x0 + x1) / 2, r = (x1 - x0) / 2;
      P3(x0, y, 0, bA); ctx.moveTo(bA.x, bA.y); P3(x0, y, zs, bA); ctx.lineTo(bA.x, bA.y);
      for (let k = 1; k <= 12; k++) { const th = Math.PI - k / 12 * Math.PI; P3(cxm + Math.cos(th) * r, y, zs + Math.sin(th) * (zt - zs), bA); ctx.lineTo(bA.x, bA.y); }
      P3(x1, y, 0, bA); ctx.lineTo(bA.x, bA.y);
    };
    const hw = M.w / 2, hd = M.d / 2, H = M.h;

    if (M.model === 'gateway') {
      shellFill(-hw, -hd, hw, hd, H * 0.78);
      ctx.strokeStyle = col(0.9); ctx.lineWidth = 1.4; ctx.beginPath();
      box(-hw, -hd, hw, hd, 0, H * 0.78);
      box(-hw * 0.55, -hd, hw * 0.55, hd, H * 0.78, H * 0.9);          // attic storey
      for (const y of [-hd, hd]) { arch(-7.5, 7.5, y, 11, 19); arch(-hw + 3, -hw + 9, y, 6, 10); arch(hw - 9, hw - 3, y, 6, 10); }
      ctx.stroke();
      ctx.strokeStyle = col(0.75); ctx.lineWidth = 1.1; ctx.beginPath();
      for (const [x, y] of [[-hw + 3, -hd + 3], [hw - 3, -hd + 3], [-hw + 3, hd - 3], [hw - 3, hd - 3]]) turret(x, y, 2.6, H * 0.78, H * 0.95);
      /* jali lattice across the front */
      if (px > 1.2) for (let k = 1; k < 8; k++) { const z = H * 0.78 * k / 8; seg(-hw, -hd, z, -8, -hd, z); seg(8, -hd, z, hw, -hd, z); }
      ctx.stroke();
    } else if (M.model === 'terminus') {
      shellFill(-hw, -hd, hw, hd, H);
      ctx.strokeStyle = col(0.9); ctx.lineWidth = 1.3; ctx.beginPath();
      box(-hw, -hd, hw, hd, 0, H);
      box(-22, -hd - 14, 22, hd * 0.2, 0, H * 1.25);                    // central block, forward
      box(-hw, -hd - 26, -hw + 26, -hd, 0, H * 0.9);                    // east & west wings
      box(hw - 26, -hd - 26, hw, -hd, 0, H * 0.9);
      ctx.stroke();
      ctx.strokeStyle = col(0.8); ctx.lineWidth = 1.1; ctx.beginPath();
      for (let k = 0; k <= 12; k++) ring(0, -4, 11, H * 1.25 + k * 1.7, 12);   // drum
      dome(0, -4, 11, H * 1.25 + 20, 16, 12);
      for (const x of [-hw + 13, hw - 13, -22, 22]) turret(x, -hd - 13, 2.4, H * 0.9, H * 1.3);
      /* gothic arcade along the front */
      if (px > 0.6) for (let k = 0; k < 14; k++) { const x0 = -hw + 30 + k * ((M.w - 60) / 14); if (Math.abs(x0) < 26) continue; arch(x0, x0 + (M.w - 60) / 14 - 2, -hd, H * 0.3, H * 0.45); }
      ctx.stroke();
    } else if (M.model === 'clocktower') {
      ctx.strokeStyle = col(0.9); ctx.lineWidth = 1.3; ctx.beginPath();
      box(-hw, -hd, hw, hd, 0, H * 0.64);
      box(-hw * 0.8, -hd * 0.8, hw * 0.8, hd * 0.8, H * 0.64, H * 0.8);
      for (let m = 0; m < 8; m++) {                                     // octagonal lantern and spire
        const th = m / 8 * 6.283, r = hw * 0.62;
        seg(Math.cos(th) * r, Math.sin(th) * r, H * 0.8, Math.cos(th) * r, Math.sin(th) * r, H * 0.9);
        seg(Math.cos(th) * r, Math.sin(th) * r, H * 0.9, 0, 0, H);
      }
      ring(0, 0, hw * 0.62, H * 0.8, 8); ring(0, 0, hw * 0.62, H * 0.9, 8);
      for (let k = 1; k < 8; k++) { const z = H * 0.64 * k / 8; seg(-hw, -hd, z, hw, -hd, z); seg(hw, -hd, z, hw, hd, z); }
      ctx.stroke();
      /* clock faces */
      ctx.strokeStyle = 'rgba(255,240,200,' + (0.95 * a).toFixed(3) + ')'; ctx.lineWidth = 1.3; ctx.beginPath();
      for (const [x, y, ax] of [[0, -hd * 0.8, 0], [0, hd * 0.8, 0], [-hw * 0.8, 0, 1], [hw * 0.8, 0, 1]]) {
        for (let k = 0; k <= 14; k++) { const th = k / 14 * 6.283, rr = 3.2; const lx = ax ? x : x + Math.cos(th) * rr, ly = ax ? y + Math.cos(th) * rr : y;
          P3(lx, ly, H * 0.72 + Math.sin(th) * rr, bA); k ? ctx.lineTo(bA.x, bA.y) : ctx.moveTo(bA.x, bA.y); }
      }
      ctx.stroke();
    } else if (M.model === 'palace') {
      shellFill(-hw, -hd, hw, hd, H);
      ctx.strokeStyle = col(0.9); ctx.lineWidth = 1.3; ctx.beginPath();
      box(-hw, -hd, hw, hd, 0, H);
      for (let k = 1; k < 6; k++) { const z = H * k / 6; seg(-hw, -hd, z, hw, -hd, z); seg(hw, -hd, z, hw, hd, z); }
      ctx.stroke();
      ctx.strokeStyle = col(0.8); ctx.lineWidth = 1.1; ctx.beginPath();
      for (let k = 0; k <= 6; k++) ring(0, 0, 9, H + k * 1.4, 12);
      dome(0, 0, 9, H + 8.4, 13, 12);
      for (const x of [-hw + 6, hw - 6]) for (const y of [-hd + 6, hd - 6]) { turret(x, y, 3.4, H, H + 4); }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    if (px > 0.35 && !MT.state.cinematic) {
      P3(0, 0, (M.model === 'clocktower' ? H : M.model === 'terminus' ? H * 2.2 : H * 1.35) + 8, bA);
      ctx.font = '600 10px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,232,188,' + (0.9 * a).toFixed(3) + ')';
      ctx.fillText(M.name.replace(/ \(.*\)$/, '').toUpperCase(), bA.x, bA.y - 6);
    }
  }

  /* Control tower: shaft, a wider glazed cab, a beacon. */
  function drawControlTower(T, depth) {
    const fg = fogAmt(depth), a = 1 - fg;
    if (a < 0.03) return;
    const HOLO = holo(), vs = MT.state.vscale || 1, H = T.h * vs;
    const ring = (r, z, n) => { ctx.beginPath(); for (let i = 0; i <= n; i++) { const th = i / n * Math.PI * 2; proj(T.x + Math.cos(th) * r, T.y + Math.sin(th) * r, z, bA); i ? ctx.lineTo(bA.x, bA.y) : ctx.moveTo(bA.x, bA.y); } };
    const line = HOLO ? 'rgba(210,244,255,' : 'rgba(214,220,230,';
    if (HOLO) ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = line + (0.85 * a).toFixed(3) + ')'; ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const th = i / 6 * Math.PI * 2; proj(T.x + Math.cos(th) * 5, T.y + Math.sin(th) * 5, 0, bA); proj(T.x + Math.cos(th) * 4, T.y + Math.sin(th) * 4, H * 0.82, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
    ctx.stroke();
    for (let k = 1; k <= 6; k++) { ring(4.6, H * 0.82 * k / 7, 10); ctx.stroke(); }
    /* cab */
    ctx.fillStyle = HOLO ? 'rgba(80,200,255,' + (0.25 * a).toFixed(3) + ')' : fogged(120, 170, 200, fg);
    ring(11, H * 0.86, 12); ctx.fill(); ctx.stroke();
    ring(12.5, H * 0.93, 12); ctx.stroke();
    ring(9, H, 12); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    proj(T.x, T.y, H + 3, bA);
    ctx.fillStyle = 'rgba(255,80,90,' + (0.95 * a).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(bA.x, bA.y, 2.4, 0, 6.283); ctx.fill();
  }

  function drawRoadEdge(e) {
    if (!e.bridge) { drawRoadDeck(e); return; }
    const g = city.graph, na = g.nodes[e.a], nb = g.nodes[e.b];
    proj((na.x + nb.x) / 2, (na.y + nb.y) / 2, 0, bA);
    if (bA.d < 100) return;
    const fg = fogAmt(bA.d), pxScale = focal / bA.d;
    if (!e.overWater) { drawBridgeUnder(e, fg, pxScale); drawDeckSlab(e, fg); }   // over water: done in the deck pass
    drawRoadDeck(e);
    drawBridgeOver(e, fg, pxScale);
  }

  function drawBridgeBase(e) {
    const g = city.graph, na = g.nodes[e.a], nb = g.nodes[e.b];
    proj((na.x + nb.x) / 2, (na.y + nb.y) / 2, 0, bA);
    if (bA.d < 100) return;
    const fg = fogAmt(bA.d);
    drawBridgeUnder(e, fg, focal / bA.d);
    drawDeckSlab(e, fg);
  }

  /* An underground road: the carriageway seen "through" the ground as a dim
     dashed tube in cyan, and a lit arch where it enters the hillside. */
  function drawTunnelDeck(e) {
    const g = city.graph, na = g.nodes[e.a], nb = g.nodes[e.b];
    proj(na.x, na.y, 0, pa); proj(nb.x, nb.y, 0, pb);
    if (pa.d < 100 || pb.d < 100) return;
    const mid = (pa.d + pb.d) / 2, scale = focal / mid, fg = fogAmt(mid), al = (1 - fg) * graze(mid);
    const st = ROAD_STYLE[e.cls] || ROAD_STYLE.link, hw = RW(e.cls) * 0.85 / 2;
    const L = e.len || 1, ux = (nb.x - na.x) / L, uy = (nb.y - na.y) / L, nx = -uy, ny = ux;
    ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'butt';
    /* faint body */
    ctx.strokeStyle = 'rgba(80,200,255,' + (0.07 * al).toFixed(3) + ')';
    ctx.lineWidth = Math.max(2, RW(e.cls) * 0.85 * scale);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    /* dashed tube walls */
    ctx.strokeStyle = 'rgba(120,220,255,' + (0.55 * al).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, Math.min(2, scale * 1.2));
    ctx.setLineDash([Math.max(3, 10 * scale), Math.max(3, 8 * scale)]);
    ctx.beginPath();
    for (const sd of [1, -1]) { proj(na.x + nx * hw * sd, na.y + ny * hw * sd, 0, bA); proj(nb.x + nx * hw * sd, nb.y + ny * hw * sd, 0, bB); ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y); }
    ctx.stroke(); ctx.setLineDash([]);
    ctx.globalCompositeOperation = 'source-over';
    /* portals: where this link meets a surface link of the same road */
    for (const [n, dir] of [[e.a, -1], [e.b, 1]]) {
      const N = g.nodes[n];
      const open = N.edges.some(id => { const f = g.edges[id]; return f !== e && f.road >= 0 && f.roadId === e.roadId && !f.tunnel; });
      if (!open) continue;
      const H = 9, S = 14;
      const pts = [];
      for (let k = 0; k <= S; k++) { const t = Math.PI * k / S; pts.push([N.x + nx * hw * 1.05 * Math.cos(t), N.y + ny * hw * 1.05 * Math.cos(t), H * Math.sin(t)]); }
      ctx.fillStyle = 'rgba(6,14,30,' + (0.85 * (1 - fg)).toFixed(3) + ')';
      ctx.beginPath(); pts.forEach(([x, y, z], k) => { proj(x, y, z, pc); k ? ctx.lineTo(pc.x, pc.y) : ctx.moveTo(pc.x, pc.y); }); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,190,110,' + (0.9 * (1 - fg)).toFixed(3) + ')'; ctx.lineWidth = Math.max(1.2, Math.min(3, scale * 1.6));
      ctx.beginPath(); pts.forEach(([x, y, z], k) => { proj(x, y, z, pc); k ? ctx.lineTo(pc.x, pc.y) : ctx.moveTo(pc.x, pc.y); }); ctx.stroke();
      /* portal label, close up */
      if (scale > 0.25 && dir === 1) {
        proj(N.x, N.y, H + 4, pc);
        ctx.font = '600 10px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center';
        const tl = tunnelName(e.tunnel).toUpperCase();
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,8,14,.85)'; ctx.strokeText(tl, pc.x, pc.y);
        ctx.fillStyle = '#FFC46B'; ctx.fillText(tl, pc.x, pc.y);
      }
    }
  }

  /* A roundabout: an asphalt ring around a landscaped island with a lit kerb
     and a lamp-post in the middle, laid over the junction. */
  function drawCircle(C) {
    proj(C.x, C.y, 0, pa); if (pa.d < 120 || pa.d > 20000) return;
    const fg = fogAmt(pa.d), a = 1 - fg, sc = focal / pa.d;
    if (C.r * sc < 3) return;
    const ring = (r, z) => { ctx.beginPath(); for (let k = 0; k <= 32; k++) { const t = k / 32 * 6.2832; proj(C.x + Math.cos(t) * r, C.y + Math.sin(t) * r, z, pc); k ? ctx.lineTo(pc.x, pc.y) : ctx.moveTo(pc.x, pc.y); } ctx.closePath(); };
    const rr = C.r * (0.55 + 0.45 * roadZoomK()) + RW('arterial') * 0.35;
    ctx.globalCompositeOperation = 'source-over';
    ring(rr, 0.05); ctx.fillStyle = 'rgba(46,38,30,' + (0.98 * a).toFixed(3) + ')'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,214,140,' + (0.85 * a).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, Math.min(2.5, sc * 1.2)); ctx.stroke();
    /* island */
    const ri = C.r * 0.55;
    ring(ri, 0.6); ctx.fillStyle = 'rgba(30,90,64,' + (0.95 * a).toFixed(3) + ')'; ctx.fill();
    ctx.strokeStyle = 'rgba(160,255,200,' + (0.8 * a).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, Math.min(2, sc)); ctx.stroke();
    /* lane ring (dashed) */
    if (sc > 0.15) { ctx.setLineDash([Math.max(3, 8 * sc), Math.max(3, 8 * sc)]); ring((rr + ri) / 2, 0.1); ctx.strokeStyle = 'rgba(255,240,210,' + (0.45 * a).toFixed(3) + ')'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); }
    /* centre lamp-post with a glow */
    proj(C.x, C.y, 0.6, t0); proj(C.x, C.y, 14, t1);
    ctx.strokeStyle = 'rgba(200,210,230,' + (0.8 * a).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, sc * 0.6);
    ctx.beginPath(); ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    const gr = Math.max(3, 9 * sc); const g = ctx.createRadialGradient(t1.x, t1.y, 0, t1.x, t1.y, gr);
    g.addColorStop(0, 'rgba(255,220,150,' + (0.9 * a).toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(t1.x, t1.y, gr, 0, 6.2832); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    if (sc > 0.12 && MT.state.labels) {
      ctx.font = '600 11px Archivo, system-ui, sans-serif'; ctx.textAlign = 'center';
      proj(C.x, C.y, 22, pc); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,8,14,.85)'; ctx.strokeText(C.name, pc.x, pc.y);
      ctx.fillStyle = '#B9F5CF'; ctx.fillText(C.name, pc.x, pc.y);
    }
  }

  function drawRoadDeck(e) {
    if (e.tunnel && holo()) { drawTunnelDeck(e); return; }
    if (!bendReady) computeBends();
    const g = city.graph, na = g.nodes[e.a], nb = g.nodes[e.b];
    proj(na.x, na.y, e.za || 0, pa);
    proj(nb.x, nb.y, e.zb || 0, pb);
    if (pa.d < 100 || pb.d < 100) return;
    const st = ROAD_STYLE[e.cls] || ROAD_STYLE.link;
    const mid = (pa.d + pb.d) / 2;
    const scale = focal / mid;
    const fg = fogAmt(mid);
    let w = Math.max(st.min, RW(e.cls) * scale);
    let colA = st.c, topA = st.t;

    const tr = MT.state.traffic;
    if (tr && MT.layerOn('congestion') && tr.vc[e.id] !== undefined) {
      const vc = tr.vc[e.id];
      const bucket = vc > 1.15 ? 4 : vc > 0.95 ? 3 : vc > 0.78 ? 2 : vc > 0.55 ? 1 : 0;
      topA = CONG[bucket]; colA = [28, 38, 54];
    }
    if (e.closed) { topA = [224, 87, 94]; colA = [42, 20, 24]; }
    const iso = MT.state.iso;
    if (iso && MT.layerOn('isochrone') && e.road >= 0) {
      const band = iso.band[e.id];
      topA = band < 0 ? [92, 96, 118] : ISO_BAND[band];
      colA = [22, 28, 42];
      w = Math.max(w * 1.15, 2.6);
      const t2 = fogged(topA[0], topA[1], topA[2], fg * 0.3);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = fogged(colA[0], colA[1], colA[2], fg);
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.strokeStyle = t2; ctx.lineWidth = Math.max(1.2, w * 0.55);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      return;
    }
    if (holo()) {
      /* light trails: the carriageway reads as flowing energy, not asphalt.
         When a traffic run is shown, the trail takes the V/C colour, so the
         congestion legend means something in this style too (audit #9). */
      const cong = tr && MT.layerOn('congestion') && tr.vc[e.id] !== undefined && !e.closed;
      const hRGB = cong ? topA.join(',') : '255,160,52';
      const dRGB = cong ? topA.join(',') : '255,168,66';
      const kRGB = cong ? topA.map(v => Math.min(255, v + 60)).join(',') : '255,214,140';
      const cRGB = cong ? topA.map(v => Math.min(255, v + 90)).join(',') : '255,208,126';
      const gw = Math.max(3.0, RW(e.cls) * scale * 0.85);
      ctx.globalAlpha = graze(mid);
      /* The bloom is a fixed-width skirt, not a multiple of the carriageway:
         at street level a proportional halo swallows the whole viewport. */
      const halo = e.bridge && e.overWater ? gw * 1.15 : Math.min(gw * 2.8, gw + 30);   // no glow skirt spilling onto the water
      const wide = Math.min(1, 26 / gw);          // wide roads read flatter
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const pulse = 0.5 + 0.5 * Math.sin(holoPhase * 5);
      ctx.strokeStyle = e.closed ? 'rgba(236,95,112,' + ((0.18 + 0.3 * pulse) * (0.35 + 0.65 * wide)).toFixed(3) + ')'
                                 : 'rgba(' + hRGB + ',' + ((cong ? 0.2 : 0.11) * (1 - fg) * (0.3 + 0.7 * wide)).toFixed(3) + ')';
      /* butt ends: round caps on every segment stack up into glowing discs
         wherever segments meet, which reads as a light source that is not there */
      /* Butt ends crack open at bends, so each butt-ended band is run a
         little past both nodes: enough overlap to close the wedge, far less
         than the full disc a round cap would stack at every junction. */
      const sl = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const ex = (pb.x - pa.x) / sl, ey = (pb.y - pa.y) / sl;
      const onDeck = e.bridge && e.overWater;          // a solid slab already closes the joints on a bridge
      const tA = onDeck ? 0 : e._tA || 0, tB = onDeck ? 0 : e._tB || 0;
      const band = width => {
        const h = width / 2;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(pa.x - ex * Math.min(h * tA, sl * 0.5), pa.y - ey * Math.min(h * tA, sl * 0.5));
        ctx.lineTo(pb.x + ex * Math.min(h * tB, sl * 0.5), pb.y + ey * Math.min(h * tB, sl * 0.5));
        ctx.stroke();
      };
      if (e.bridge && !e.overWater && gw > 40) { /* raised over land, close up: no ground glow skirt */ }
      else if (gw > 12) { ctx.lineCap = 'butt'; band(halo); }
      else { ctx.lineWidth = halo; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke(); }
      if (e.bridge && !e.overWater && gw > 40) { /* close up: deck markings are drawn on the slab (drawBridgeOver) */ }
      else if (gw > 18 && !(e.bridge && !e.overWater && gw > 40)) {
        /* close in, the corridor becomes a carriageway: a dim deck between two
           bright kerb lines and a dashed centre, rather than one amber slab */
        /* an opaque asphalt deck, tinted toward the trail colour: overlapping
           joints no longer add up into bright bars across the road */
        if (e.bridge) {                                   // bridges and flyovers have their own slab: keep the light tint, towers show through
          if (e.overWater) { ctx.strokeStyle = 'rgba(' + dRGB + ',' + ((cong ? 0.2 : 0.13) * (1 - fg) * Math.min(1, 0.35 + 60 / gw)).toFixed(3) + ')'; band(gw); }
        } else { const k = (cong ? 0.2 : 0.13) * Math.min(1, 0.35 + 60 / gw), d0 = dRGB.split(',').map(Number), a2 = 1 - fg;
          const base = [12, 18, 28], col = base.map((b0, i) => Math.round((b0 + d0[i] * k * 2.6) * a2 + b0 * (1 - a2)));
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = 'rgb(' + col.join(',') + ')';
          band(gw);
          ctx.globalCompositeOperation = 'lighter'; }
        const ux = pb.x - pa.x, uy = pb.y - pa.y, ul = Math.hypot(ux, uy) || 1;
        const nx = -uy / ul * gw * 0.5, ny = ux / ul * gw * 0.5;
        ctx.strokeStyle = e.closed ? 'rgba(255,120,138,0.85)'
                                   : 'rgba(' + kRGB + ',' + (0.62 * (1 - fg) + 0.14).toFixed(3) + ')';
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.min(3, Math.max(1.4, gw * 0.055));   // a kerb line stays a line
        ctx.beginPath();
        ctx.moveTo(pa.x + nx, pa.y + ny); ctx.lineTo(pb.x + nx, pb.y + ny);
        ctx.moveTo(pa.x - nx, pa.y - ny); ctx.lineTo(pb.x - nx, pb.y - ny);
        ctx.stroke();
        const major = e.cls === 'expressway' || e.cls === 'arterial' || e.cls === 'bridge';
        const lw = Math.min(2.4, Math.max(1, gw * 0.03));
        ctx.lineCap = 'butt';
        if (major) {
          /* divided carriageway: a double median line, and dashed lane lines
             halfway across each side */
          const mx = nx * 0.06, my = ny * 0.06;
          ctx.strokeStyle = 'rgba(255,214,120,' + (0.55 * (1 - fg)).toFixed(3) + ')';
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(pa.x + mx, pa.y + my); ctx.lineTo(pb.x + mx, pb.y + my);
          ctx.moveTo(pa.x - mx, pa.y - my); ctx.lineTo(pb.x - mx, pb.y - my);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(255,240,210,' + (0.34 * (1 - fg)).toFixed(3) + ')';
          ctx.setLineDash([gw * 0.35, gw * 0.5]);
          ctx.beginPath();
          for (const f of [0.5, -0.5]) { ctx.moveTo(pa.x + nx * f, pa.y + ny * f); ctx.lineTo(pb.x + nx * f, pb.y + ny * f); }
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(255,236,190,' + (0.32 * (1 - fg)).toFixed(3) + ')';
          ctx.lineWidth = lw;
          ctx.setLineDash([gw * 0.55, gw * 0.75]);
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        }
        /* street lights: warm dots along both kerbs, about every 40 m */
        const lampGap = 40 * scale;
        if (lampGap > 14 && !(e.bridge && e.overWater)) {
          const lr = Math.min(4, Math.max(1.6, scale * 1.6));
          ctx.setLineDash([0.01, lampGap]); ctx.lineCap = 'round'; ctx.lineWidth = lr;
          ctx.strokeStyle = 'rgba(255,230,170,' + (0.85 * (1 - fg)).toFixed(3) + ')';
          ctx.beginPath();
          for (const f of [1.08, -1.08]) { ctx.moveTo(pa.x + nx * f, pa.y + ny * f); ctx.lineTo(pb.x + nx * f, pb.y + ny * f); }
          ctx.stroke();
          ctx.lineWidth = lr * 3.2;
          ctx.strokeStyle = 'rgba(255,200,120,' + (0.14 * (1 - fg)).toFixed(3) + ')';
          ctx.stroke();
        }
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = e.closed ? 'rgba(255,120,138,0.8)' : 'rgba(' + cRGB + ',' + ((cong ? 0.8 : 0.5) * (1 - fg) + 0.12).toFixed(3) + ')';
        ctx.lineWidth = Math.max(0.9, gw * 0.4);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      return;
    }
    const col = fogged(colA[0], colA[1], colA[2], fg);
    const top = fogged(topA[0], topA[1], topA[2], fg * 0.8);

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = col; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    if (w > 3.2) {
      ctx.strokeStyle = top; ctx.lineWidth = Math.max(0.8, w * 0.42);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    if (e.closed) {
      const pulse = 0.5 + 0.5 * Math.sin(holoPhase * 5);
      ctx.strokeStyle = 'rgba(236,95,112,' + (0.55 + 0.45 * pulse).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1.4, w * 1.2);
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawRailSeg(L) {
    const zA0 = L.za !== undefined ? L.za : L.z, zB0 = L.zb !== undefined ? L.zb : L.z;
    proj(L.ax, L.ay, zA0, pa); proj(L.bx, L.by, zB0, pb);
    if (pa.d < 100 && pb.d < 100) return;
    if (pa.d < 100 || pb.d < 100) {
      /* A station-to-station segment can be kilometres long: when one end
         passes behind the camera, trim it at the near plane instead of
         dropping the whole run (the track used to vanish when zoomed in). */
      const t = (110 - pa.d) / (pb.d - pa.d);
      const C = Object.assign({}, L, { ow: undefined, wet: undefined });
      if (pa.d < 100) { C.ax = L.ax + (L.bx - L.ax) * t; C.ay = L.ay + (L.by - L.ay) * t; C.za = zA0 + (zB0 - zA0) * t; }
      else { const u = (110 - pb.d) / (pa.d - pb.d); C.bx = L.bx + (L.ax - L.bx) * u; C.by = L.by + (L.ay - L.by) * u; C.zb = zB0 + (zA0 - zB0) * u; }
      C.za = C.za !== undefined ? C.za : zA0; C.zb = C.zb !== undefined ? C.zb : zB0; C.z = (C.za + C.zb) / 2;
      proj(C.ax, C.ay, C.za, pa); proj(C.bx, C.by, C.zb, pb);
      if (pa.d < 100 || pb.d < 100) return;
      return drawRailSeg(C);
    }
    const mid = (pa.d + pb.d) / 2;
    const scale = focal / mid;
    const fg = fogAmt(mid);
    const w = Math.max(2.6, (L.kind === 'metro' ? 21 : 30) * scale);
    /* a rail crossing over water (Vasai, Thane and Vashi creeks, the Mithi)
       is a bridge: piers every 40 m down to the water, and a reflection */
    if (L.ow === undefined) {
      /* sample the segment: station-to-station runs are often part land, part creek */
      const len0 = Math.hypot(L.bx - L.ax, L.by - L.ay), n0 = Math.max(1, Math.round(len0 / 40));
      L.wet = [];
      for (let i = 0; i < n0; i++) { const t = (i + 0.5) / n0; L.wet.push(waterExact(L.ax + (L.bx - L.ax) * t, L.ay + (L.by - L.ay) * t)); }
      L.ow = !L.dash && !L.ug && L.wet.some(Boolean);
    }
    if (L.ow && scale > 0.012) {
      const C = bridgeColours(fg);
      const len = Math.hypot(L.bx - L.ax, L.by - L.ay) || 1;
      const ux = (L.bx - L.ax) / len, uy = (L.by - L.ay) / len, nx = -uy, ny = ux;
      const n = L.wet.length, hw = L.kind === 'metro' ? 8 : 17;
      /* piers every 40 m under the wet stretches: a row of solid columns
         across the bed (the metro's own viaduct draws its piers itself) */
      if (L.kind !== 'metro' && scale > 0.02) for (let i = 0; i < n; i++) {
        if (!L.wet[i]) continue;
        const t = (i + 0.5) / n, cx = L.ax + (L.bx - L.ax) * t, cy = L.ay + (L.by - L.ay) * t;
        /* spread to the bed's full width: the outer columns and the cap beam
           show past the deck edges, the inner ones carry the middle tracks */
        drawPierRow(cx, cy, nx, ny, L.z, 19.5, 5, 3.4, fg, true);
      }
      if (C.glow) ctx.globalCompositeOperation = 'lighter';
      if (C.refl) {
        ctx.strokeStyle = C.refl;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (!L.wet[i]) continue;
          const t0 = i / n, t1 = (i + 1) / n;
          proj(L.ax + (L.bx - L.ax) * t0, L.ay + (L.by - L.ay) * t0, -L.z, bA);
          proj(L.ax + (L.bx - L.ax) * t1, L.ay + (L.by - L.ay) * t1, -L.z, bB);
          ctx.moveTo(bA.x, bA.y); ctx.lineTo(bB.x, bB.y);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    if (L.el && !L.ow && holo() && scale > 0.02) {
      /* rail flyover over land: a pier row under each 40 m piece */
      const len = Math.hypot(L.bx - L.ax, L.by - L.ay) || 1;
      drawPierRow(L.mx, L.my, -(L.by - L.ay) / len, (L.bx - L.ax) / len, L.z, 19.5, 4, 3.4, fg, false);
    }
    ctx.lineCap = 'round';
    if (L.dash) ctx.setLineDash([9 * scale + 2, 6 * scale + 2]);
    if (holo()) {
      ctx.setLineDash([]);
      if (L.ug) drawTunnelHolo(L, w, mid, fg);
      else if (L.kind === 'metro') drawViaductHolo(L, w, mid, fg, scale);
      else drawRailBedHolo(L, w, mid, fg, scale);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineCap = 'round';
      return;
    }
    /* additive halo first, so transit lines glow through the haze */
    if (fg < 0.7) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.13 * (1 - fg) * (holo() ? 0.55 : 1);
      ctx.strokeStyle = L.color; ctx.lineWidth = w * 3.4;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.strokeStyle = L.color; ctx.lineWidth = w;
    ctx.globalAlpha = (L.kind === 'metro' ? 0.95 : 0.82) * (1 - fg * 0.75) * (holo() ? 0.5 : 1);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.setLineDash([]);
  }

  /* ------------------------------------------------ track geometry helpers */
  const tq = [P(), P(), P(), P()], tr0 = P(), tr1 = P();
  /* project a strip offset o metres to the left of the segment centre line */
  function offLine(L, o, z, A, B) {
    const len = Math.hypot(L.bx - L.ax, L.by - L.ay) || 1;
    const nx = -(L.by - L.ay) / len * o, ny = (L.bx - L.ax) / len * o;
    /* heights are given against the segment's mean; a ramp tilts them end to
       end. z = 0 always means the ground itself. */
    const dA = L.za !== undefined ? L.za - L.z : 0, dB = L.zb !== undefined ? L.zb - L.z : 0;
    proj(L.ax + nx, L.ay + ny, z <= 0.01 ? z : z + dA, A); proj(L.bx + nx, L.by + ny, z <= 0.01 ? z : z + dB, B);
    return A.d > 30 && B.d > 30;           // detail may sit a few metres nearer than the clipped centre line
  }
  function quad(L, o0, o1, z0, z1) {           // strip between two offsets / heights
    offLine(L, o0, z0, tq[0], tq[1]); offLine(L, o1, z1, tq[3], tq[2]);
    ctx.beginPath(); ctx.moveTo(tq[0].x, tq[0].y); ctx.lineTo(tq[1].x, tq[1].y);
    ctx.lineTo(tq[2].x, tq[2].y); ctx.lineTo(tq[3].x, tq[3].y); ctx.closePath();
  }
  function railPair(L, c, z, gauge) {           // two running rails of one track
    for (const s of [gauge / 2, -gauge / 2]) {
      if (!offLine(L, c + s, z, tr0, tr1)) continue;
      ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y);
    }
  }

  /* Suburban railway: a raised ballast bed carrying four tracks, each a pair
     of steel rails on concrete sleepers, edged in the line's own colour so
     Western, Central and Harbour stay tellable apart. */
  /* Track layout at the same 2.2x display scale as the trains, so a rake
     sits on its own track instead of straddling two. Shared with motion.js. */
  const TXS = 2.2;
  const RAIL_TRACKS = [-13.5, -4.5, 4.5, 13.5], RAIL_GAUGE = 1.676 * TXS;   // broad gauge
  const METRO_TRACKS = [4.2, -4.2], METRO_GAUGE = 1.435 * TXS;              // standard gauge
  MT.TRACKS = { rail: RAIL_TRACKS, metro: METRO_TRACKS };
  function drawRailBedHolo(L, w, mid, fg, scale) {
    const al = (1 - fg) * graze(mid);
    if (w < 7) {                                   // overview: one clean line in the line colour
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = L.color; ctx.globalAlpha = 0.5 * al; ctx.lineWidth = Math.max(1.4, w * 0.55);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.globalAlpha = 0.9 * al; ctx.strokeStyle = 'rgba(230,236,248,0.9)'; ctx.lineWidth = Math.max(0.8, w * 0.16);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      return;
    }
    const HW = 21.5, z = L.z;                       // shoulders wide enough for the outer rakes
    /* embankment sides, then the ballast top */
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(22,26,38,' + (0.9 * al).toFixed(3) + ')';
    if (L.ow || L.el) {                            // on a bridge or rail flyover: a slim girder, the piers show beneath
      quad(L, HW, HW, z, z - 1.6); ctx.fill();
      quad(L, -HW, -HW, z, z - 1.6); ctx.fill();
    } else {                                       // on land: an embankment down to the ground
      quad(L, HW + 2.5, HW, 0, z); ctx.fill();
      quad(L, -HW - 2.5, -HW, 0, z); ctx.fill();
    }
    ctx.fillStyle = 'rgba(46,50,62,' + (0.95 * al).toFixed(3) + ')';
    quad(L, HW, -HW, z, z); ctx.fill();
    /* line-colour edge stripes */
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = L.color; ctx.globalAlpha = 0.55 * al; ctx.lineWidth = Math.max(1, scale * 1.2);
    ctx.beginPath();
    for (const o of [HW, -HW]) if (offLine(L, o, z, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
    ctx.stroke();
    /* sleepers: one dashed stroke per track, dash spacing ~0.65 m */
    const sl = 0.65 * scale;
    if (sl > 1.6) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(150,146,140,' + (0.75 * al).toFixed(3) + ')';
      ctx.lineWidth = RAIL_GAUGE * 1.7 * scale; ctx.lineCap = 'butt';
      ctx.setLineDash([Math.max(1, 0.26 * scale), Math.max(1, 0.39 * scale)]);
      ctx.beginPath();
      for (const c of RAIL_TRACKS) if (offLine(L, c, z, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    /* overhead electrification: a portal every 60 m spanning all four
       tracks, with the contact wire drawn above each track */
    if (scale > 0.22 && !L.ow) {
      const len = Math.hypot(L.bx - L.ax, L.by - L.ay) || 1, ux = (L.bx - L.ax) / len, uy = (L.by - L.ay) / len, nx = -uy, ny = ux;
      const zc = z + 7.5, nP = Math.max(1, Math.round(len / 60));
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(150,164,196,' + (0.75 * al).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, Math.min(2.2, scale * 0.5));
      ctx.beginPath();
      for (let k = 0; k < nP; k++) {
        const f = (k + 0.5) / nP, cx = L.ax + (L.bx - L.ax) * f, cy = L.ay + (L.by - L.ay) * f;
        for (const sd of [1, -1]) { proj(cx + nx * 19.5 * sd, cy + ny * 19.5 * sd, z, tr0); proj(cx + nx * 19.5 * sd, cy + ny * 19.5 * sd, zc + 1, tr1); ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
        proj(cx + nx * 19.5, cy + ny * 19.5, zc + 1, tr0); proj(cx - nx * 19.5, cy - ny * 19.5, zc + 1, tr1); ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y);
      }
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(190,220,255,' + (0.35 * al).toFixed(3) + ')'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const c of RAIL_TRACKS) if (offLine(L, c, zc, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
      ctx.stroke();
    }
    /* steel rails */
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = al;
    ctx.strokeStyle = 'rgba(214,224,240,0.85)'; ctx.lineWidth = Math.max(0.8, Math.min(2.2, scale * 0.22));
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const c of RAIL_TRACKS) {
      if (RAIL_GAUGE * scale > 2.2) railPair(L, c, z + 0.2, RAIL_GAUGE);
      else if (offLine(L, c, z + 0.2, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
    }
    ctx.stroke();
  }

  /* Metro: an elevated concrete box-girder viaduct on single-column piers
     with pier caps, parapets along both edges, twin tracks on the deck and
     the line's colour banded along the girder — how Mumbai's elevated lines
     actually read from above. */
  function drawViaductHolo(L, w, mid, fg, scale) {
    const al = (1 - fg) * graze(mid);
    const z = L.z, HW = 8.6, GD = 2.6;             // deck half-width, girder depth (display scale)
    if (L.dash) {                                  // under construction: a dashed outline only
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.7 * al;
      ctx.strokeStyle = L.color; ctx.lineWidth = Math.max(1, Math.min(2, scale * 0.6));
      ctx.setLineDash([Math.max(3, 6 * scale), Math.max(3, 5 * scale)]);
      ctx.beginPath();
      for (const o of [HW, -HW]) if (offLine(L, o, z, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
      if (w < 7) { ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); }
      ctx.stroke(); ctx.setLineDash([]);
      return;
    }
    if (w < 6) {                                   // overview: bright line in the line colour
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = L.color; ctx.globalAlpha = 0.35 * al; ctx.lineWidth = Math.max(3, w * 1.4);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.globalAlpha = 0.95 * al; ctx.lineWidth = Math.max(1.3, w * 0.45);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      return;
    }
    const segLen = Math.hypot(L.bx - L.ax, L.by - L.ay) || 1;
    const ux = (L.bx - L.ax) / segLen, uy = (L.by - L.ay) / segLen, nx = -uy, ny = ux;
    /* piers every ~32 m: column plus a hammerhead cap under the girder */
    const nP = Math.max(1, Math.round(segLen / 32));
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    for (let k = 0; k < nP; k++) {
      const f = (k + 0.5) / nP, x = L.ax + (L.bx - L.ax) * f, y = L.ay + (L.by - L.ay) * f;
      drawPierRow(x, y, nx, ny, z - GD, HW * 0.7, 1, 2.6, fg, false);   // single column, hammerhead cap
    }
    /* girder sides (visible one drawn last), then the deck */
    ctx.fillStyle = 'rgba(78,86,118,' + (0.96 * al).toFixed(3) + ')';
    quad(L, HW, HW * 0.8, z, z - GD); ctx.fill();
    quad(L, -HW, -HW * 0.8, z, z - GD); ctx.fill();
    ctx.fillStyle = 'rgba(52,58,84,' + (0.97 * al).toFixed(3) + ')';
    quad(L, HW, -HW, z, z); ctx.fill();
    /* the girder faces carry the line's colour (Blue, Yellow, Red...) */
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = L.color; ctx.globalAlpha = 0.22 * al;
    quad(L, HW, HW * 0.8, z, z - GD); ctx.fill();
    quad(L, -HW, -HW * 0.8, z, z - GD); ctx.fill();
    ctx.globalAlpha = 0.95 * al; ctx.strokeStyle = L.color; ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(1.4, 0.8 * scale);
    ctx.beginPath();
    for (const o of [HW * 0.93, -HW * 0.93]) if (offLine(L, o, z - GD * 0.45, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
    ctx.stroke();
    /* parapets */
    ctx.globalAlpha = al; ctx.strokeStyle = 'rgba(206,214,240,0.8)'; ctx.lineWidth = Math.max(0.8, Math.min(2, 0.3 * scale));
    ctx.beginPath();
    for (const o of [HW, -HW]) if (offLine(L, o, z + 1.1, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
    ctx.stroke();
    /* twin tracks: sleepers, then rails */
    if (0.6 * scale > 1.6) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(128,134,160,' + (0.8 * al).toFixed(3) + ')'; ctx.lineWidth = METRO_GAUGE * 1.6 * scale;
      ctx.setLineDash([Math.max(1, 0.24 * scale), Math.max(1, 0.36 * scale)]);
      ctx.beginPath();
      for (const c of METRO_TRACKS) if (offLine(L, c, z + 0.15, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.globalCompositeOperation = 'lighter';
    }
    ctx.strokeStyle = 'rgba(226,232,250,0.9)'; ctx.lineWidth = Math.max(0.7, Math.min(1.8, scale * 0.2));
    ctx.beginPath();
    for (const c of METRO_TRACKS) {
      if (METRO_GAUGE * scale > 2.2) railPair(L, c, z + 0.3, METRO_GAUGE);
      else if (offLine(L, c, z + 0.3, tr0, tr1)) { ctx.moveTo(tr0.x, tr0.y); ctx.lineTo(tr1.x, tr1.y); }
    }
    ctx.stroke();
  }

  /* Underground metro (Line 3): the tunnel's route traced faintly on the
     surface, so it is on the map without pretending to be a viaduct. */
  function drawTunnelHolo(L, w, mid, fg) {
    const al = (1 - fg) * graze(mid);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = L.color; ctx.lineCap = 'butt';
    ctx.globalAlpha = 0.16 * al; ctx.lineWidth = Math.max(4, w * 0.9);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.globalAlpha = 0.75 * al; ctx.lineWidth = Math.max(1, Math.min(2.4, w * 0.12));
    ctx.setLineDash([Math.max(4, w * 0.5), Math.max(3, w * 0.35)]);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.setLineDash([]);
  }

  /* A suburban station: two 270 m island platforms between the track pairs,
     each with a long canopy on columns and a footbridge across the tracks. */
  function drawPlatform(Pf, depth) {
    const fg = fogAmt(depth), a = (1 - fg); if (a < 0.05) return;
    const scale = focal / depth; if (scale < 0.05) return;
    const hx = Pf.hx, hy = Pf.hy, nx = -hy, ny = hx, z = Pf.z, HL = 135;
    const box = (o, w, z0, z1, fill, edge) => {
      const c = [[-HL, -w], [HL, -w], [HL, w], [-HL, w]].map(([al, lat]) => [Pf.x + hx * al + nx * (o + lat), Pf.y + hy * al + ny * (o + lat)]);
      ctx.fillStyle = fill; ctx.beginPath();
      c.forEach(([x, y], k) => { proj(x, y, z1, pc); k ? ctx.lineTo(pc.x, pc.y) : ctx.moveTo(pc.x, pc.y); }); ctx.closePath(); ctx.fill();
      if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.stroke(); }
      if (z1 - z0 > 0.5) {                          // front face
        proj(c[0][0], c[0][1], z0, t0); proj(c[1][0], c[1][1], z0, t1); proj(c[1][0], c[1][1], z1, t2); proj(c[0][0], c[0][1], z1, t3);
        ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.lineTo(t3.x, t3.y); ctx.closePath(); ctx.fill();
      }
    };
    ctx.globalCompositeOperation = 'source-over';
    for (const o of [0, 18, -18]) {                    // islands between the track pairs (tracks at ±4.5 and ±13.5 m)
      /* platform deck: 1 m above the rails */
      box(o, 2.6, z, z + 1.2, 'rgba(120,128,150,' + (0.92 * a).toFixed(3) + ')', 'rgba(255,214,120,' + (0.7 * a).toFixed(3) + ')');
      if (scale > 0.18) {
        /* canopy columns */
        ctx.strokeStyle = 'rgba(170,184,220,' + (0.7 * a).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, scale * 0.5);
        ctx.beginPath();
        for (let k = -4; k <= 4; k++) { const x = Pf.x + hx * k * 30 + nx * o, y = Pf.y + hy * k * 30 + ny * o; proj(x, y, z + 1.2, t0); proj(x, y, z + 6.5, t1); ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); }
        ctx.stroke();
      }
      /* canopy roof */
      box(o, 3.4, z + 6.5, z + 7.2, 'rgba(60,72,104,' + (0.75 * a).toFixed(3) + ')', 'rgba(150,228,255,' + (0.55 * a).toFixed(3) + ')');
    }
    /* footbridge across all tracks */
    if (scale > 0.12) {
      const fb = [[-30, -34], [-30, 34], [-24, 34], [-24, -34]].map(([al, lat]) => [Pf.x + hx * al + nx * lat, Pf.y + hy * al + ny * lat]);
      ctx.fillStyle = 'rgba(90,100,130,' + (0.9 * a).toFixed(3) + ')'; ctx.beginPath();
      fb.forEach(([x, y], k) => { proj(x, y, z + 9.5, pc); k ? ctx.lineTo(pc.x, pc.y) : ctx.moveTo(pc.x, pc.y); }); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,214,120,' + (0.6 * a).toFixed(3) + ')'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  function drawPlaced(p) {
    const h = p.height || 40, r = p.radius || 26;
    proj(p.x, p.y, 0, pa); proj(p.x, p.y, h, pb);
    if (pa.d < 100) return;
    const s = focal / pa.d;
    ctx.strokeStyle = '#3FD3E6'; ctx.lineWidth = 1.4;
    ctx.fillStyle = 'rgba(63,211,230,0.20)';
    ctx.beginPath();
    ctx.ellipse(pa.x, pa.y, r * s, r * s * Math.cos(cam.pitch) * 0.55 + r * s * 0.15, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#3FD3E6';
    ctx.beginPath(); ctx.arc(pb.x, pb.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = '600 11px Archivo, system-ui, sans-serif';
    ctx.fillStyle = '#D4F3FB';
    ctx.textAlign = 'center';
    ctx.fillText(p.label || 'Proposed', pb.x, pb.y - 9);
  }

  /* ------------------------------------------------------------- overlays */
  const MARK = {
    hospital:  { c: '#EC5F70', g: 'H' },
    fire:      { c: '#EE7F45', g: 'F' },
    police:    { c: '#8B7BF0', g: 'P' },
    school:    { c: '#8B9ECF', g: 'S' },
    metro:     { c: '#3FD3E6', g: 'M' },
    rail:      { c: '#EDAE45', g: 'R' },
    landmark:  { c: '#C9D6E8', g: '◆' },
    project:   { c: '#77E4AE', g: '▲' },
    bank:      { c: '#F2C46D', g: '₹' }
  };

  function drawMarkers() {
    if (MT.state.cinematic) return;   // landing / hero view stays unlabelled
    const list = [];
    const push = (arr, cat, lim) => {
      for (const p of arr) {
        proj(p.x, p.y, 0, pa);
        if (pa.d < 150 || pa.d > lim) continue;
        if (pa.x < -30 || pa.x > W + 30 || pa.y < -30 || pa.y > H + 30) continue;
        list.push({ x: pa.x, y: pa.y, d: pa.d, cat, p });
      }
    };
    if (MT.layerOn('hospitals')) push(city.hospitals, 'hospital', 90000);
    if (MT.layerOn('fire')) push(city.fire, 'fire', 60000);
    if (MT.layerOn('police')) push(city.police, 'police', 22000);
    if (MT.layerOn('schools')) push(city.schools, 'school', 16000);
    if (MT.layerOn('stations')) {
      push(city.metroStations, 'metro', 38000);
      if (cam.dist < 20000) push(city.railStations, 'rail', 20000);
    }
    if (MT.layerOn('landmarks')) push(city.landmarks, 'landmark', 95000);
    if (MT.layerOn('projects')) push(city.projects, 'project', 95000);
    if (MT.layerOn('banks')) push(city.banks, 'bank', 30000);

    list.sort((a, b) => b.d - a.d);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const m of list) {
      const st = MARK[m.cat];
      const sel = MT.state.selection && MT.state.selection.ref === m.p;
      const r = sel ? 8 : (m.cat === 'school' || m.cat === 'police' ? 3.2 : 5.4);
      ctx.beginPath();
      ctx.fillStyle = 'rgba(5,9,16,0.75)';
      ctx.arc(m.x, m.y, r + 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.fillStyle = st.c; ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.fill();
      if (r > 4) {
        ctx.fillStyle = '#060812'; ctx.font = '700 ' + (r * 1.3).toFixed(0) + 'px Archivo, system-ui, sans-serif';
        ctx.fillText(st.g, m.x, m.y + 0.5);
      }
      if (sel) {
        ctx.strokeStyle = '#9AF2FF'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(m.x, m.y, r + 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  const occ = [];
  function labelFits(x, y, w, h) {
    for (const o of occ) if (x < o[2] && x + w > o[0] && y < o[3] && y + h > o[1]) return false;
    occ.push([x, y, x + w, y + h]); return true;
  }

  /* ------------------------------------------------------ place names
     Parks, hills, lakes, rivers, seas and landmarks, named on the map so the
     city is recognisable at a glance. They claim label space before the
     locality names, in order of importance. */
  const SHORT = {
    'Trombay hills / eastern green': 'Trombay Hills',
    'Mahalaxmi Racecourse & Hanging Gardens belt': 'Mahalaxmi Racecourse',
    'Yeoor hills (SGNP, Thane)': 'Yeoor Hills',
    'Parsik hill range': 'Parsik Hills', 'Kharghar hills': 'Kharghar Hills', 'Tungareshwar hills': 'Tungareshwar Hills',
    'Chhatrapati Shivaji Maharaj Intl Airport (T2)': 'Mumbai Airport (CSMIA)',
    'Chhatrapati Shivaji Maharaj Terminus (CSMT)': 'CSMT',
    'Jawaharlal Nehru Port (JNPA)': 'JNPA Port',
    'Atal Setu (Mumbai Trans Harbour Link)': 'Atal Setu',
    'Navi Mumbai International Airport': 'Navi Mumbai Airport',
    'IIT Bombay, Powai': 'IIT Bombay'
  };
  const PN_STYLE = {
    park:     { c: [96, 214, 140],  g: 'tree' },
    water:    { c: [98, 206, 250],  g: 'drop' },
    heritage: { c: [240, 176, 86],  g: 'star' },
    place:    { c: [236, 214, 160], g: 'dot' },
    airport:  { c: [226, 236, 250], g: 'plane' },
    beach:    { c: [120, 220, 230], g: 'wave' },
    tunnel:   { c: [255, 196, 107], g: 'arch' }
  };
  let placeList = null;
  const tunnelName = t => /underpass|tunnel/i.test(t) ? t : t.replace(/^Mumbai /, '') + ' Tunnel';
  function buildPlaces() {
    const L = [];
    const cen = ring => { let x = 0, y = 0; const n = ring.length / 2 | 0;
      for (let i = 0; i < ring.length; i += 2) { x += ring[i]; y += ring[i + 1]; } return { x: x / n, y: y / n }; };
    for (const q of city.placeNames || []) {
      if (q.kind === 'sea') L.push({ name: q.name, x: q.x, y: q.y, st: 'sea', rank: 0, lim: 140000 });
      else L.push({ name: q.name, x: q.x, y: q.y, st: q.kind === 'beach' ? 'beach' : q.kind === 'park' ? 'park' : q.kind === 'heritage' ? 'heritage' : 'place', rank: 3, lim: 26000 });
    }
    for (const g of city.greenRings || []) {
      const r = g.ring, flat = Array.isArray(r[0]) ? r.flatMap(p => [p[0], p[1]]) : (r[0] && r[0].x !== undefined ? r.flatMap(p => [p.x, p.y]) : r);
      const c = cen(flat);
      L.push({ name: SHORT[g.name] || g.name, x: c.x, y: c.y, st: 'park', rank: g.name.startsWith('Sanjay') ? 1 : 2, lim: 110000 });
    }
    for (const k of city.lakes || []) L.push({ name: k.name, x: k.x, y: k.y, st: 'water', rank: 1, lim: 80000 });
    for (const rv of city.rivers || []) {
      const P = rv.path, flat = Array.isArray(P[0]) ? P.flatMap(p => [p[0], p[1]]) : (P[0] && P[0].x !== undefined ? P.flatMap(p => [p.x, p.y]) : P);
      const m = (flat.length / 4 | 0) * 2;
      L.push({ name: rv.name, x: flat[m], y: flat[m + 1], st: 'water', rank: 2, lim: 60000 });
    }
    for (const lm of city.landmarks || []) {
      if (lm.kind === 'settlement' || (lm.kind === 'park' && lm.name.startsWith('Sanjay'))) continue;
      const st = lm.kind === 'airport' ? 'airport' : lm.kind === 'park' ? 'park' : lm.kind === 'heritage' ? 'heritage' : 'place';
      L.push({ name: SHORT[lm.name] || lm.name, x: lm.x, y: lm.y, st, rank: lm.kind === 'airport' ? 1 : 2, lim: lm.kind === 'airport' ? 90000 : 45000, dot: true });
    }
    /* tunnels: one tag at the middle of each underground stretch */
    const g = city.graph, seen = new Set();
    for (const e of g.edges) {
      if (!e.tunnel || seen.has(e)) continue;
      const grp = [], st = [e]; seen.add(e);
      while (st.length) { const f = st.pop(); grp.push(f); for (const n of [f.a, f.b]) for (const id of g.nodes[n].edges) { const h = g.edges[id]; if (h.tunnel && h.roadId === f.roadId && !seen.has(h)) { seen.add(h); st.push(h); } } }
      const tot = grp.reduce((s2, f) => s2 + f.len, 0); let acc = 0, mid = grp[0];
      grp.sort((a, b) => (g.nodes[a.a].x + g.nodes[a.a].y) - (g.nodes[b.a].x + g.nodes[b.a].y));
      for (const f of grp) { acc += f.len; if (acc >= tot / 2) { mid = f; break; } }
      L.push({ name: tunnelName(e.tunnel), x: (g.nodes[mid.a].x + g.nodes[mid.b].x) / 2, y: (g.nodes[mid.a].y + g.nodes[mid.b].y) / 2, st: 'tunnel', rank: 1, lim: 30000 });
    }
    L.sort((a, b) => a.rank - b.rank);
    return L;
  }
  function glyph(kind, x, y, col) {
    ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 1.3;
    ctx.beginPath();
    if (kind === 'tree') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y + 2); ctx.lineTo(x - 4, y + 2); ctx.closePath(); ctx.fill(); ctx.fillRect(x - 0.7, y + 2, 1.4, 3); return; }
    if (kind === 'drop') { ctx.moveTo(x, y - 5); ctx.quadraticCurveTo(x + 4.2, y + 0.5, x, y + 4); ctx.quadraticCurveTo(x - 4.2, y + 0.5, x, y - 5); ctx.fill(); return; }
    if (kind === 'star') { for (let i = 0; i < 10; i++) { const r = i % 2 ? 2 : 4.6, a = -Math.PI / 2 + i * Math.PI / 5; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } ctx.closePath(); ctx.fill(); return; }
    if (kind === 'plane') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 1, y - 1); ctx.lineTo(x + 5, y + 1); ctx.lineTo(x + 1, y + 1); ctx.lineTo(x + 0.8, y + 4); ctx.lineTo(x + 2, y + 5); ctx.lineTo(x - 2, y + 5); ctx.lineTo(x - 0.8, y + 4); ctx.lineTo(x - 1, y + 1); ctx.lineTo(x - 5, y + 1); ctx.lineTo(x - 1, y - 1); ctx.closePath(); ctx.fill(); return; }
    if (kind === 'arch') { ctx.lineWidth = 1.6; ctx.moveTo(x - 4.5, y + 4); ctx.lineTo(x - 4.5, y); ctx.arc(x, y, 4.5, Math.PI, 0); ctx.lineTo(x + 4.5, y + 4); ctx.stroke(); return; }
    if (kind === 'wave') { ctx.moveTo(x - 5, y + 1); ctx.quadraticCurveTo(x - 2.5, y - 3, x, y + 1); ctx.quadraticCurveTo(x + 2.5, y + 5, x + 5, y + 1); ctx.stroke(); return; }
    ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  function rrect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  const placeHits = [];                               // screen rects of drawn place tags, for clicks
  function drawPlaceNames() {
    placeHits.length = 0;
    if (!placeList) placeList = buildPlaces();
    for (const q of placeList) {
      proj(q.x, q.y, 0, pa);
      if (pa.d < 300 || pa.d > q.lim) continue;
      /* keep clear of the info banner (top), time bar (bottom) and map tools (right) */
      if (pa.x < 70 || pa.x > W - 110 || pa.y < 110 || pa.y > H - 85) continue;
      if (q.st === 'sea') {                           // water: spaced italic caps, no chip
        const fs = Math.max(11, Math.min(17, 2600 / Math.sqrt(pa.d)));
        ctx.font = 'italic 500 ' + fs.toFixed(1) + 'px Archivo, system-ui, sans-serif';
        const txt = q.name.toUpperCase().split('').join('\u200A');
        const w = ctx.measureText(txt).width;
        if (!labelFits(pa.x - w / 2 - 4, pa.y - fs, w + 8, fs + 6)) continue;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,10,24,0.7)'; ctx.strokeText(txt, pa.x, pa.y);
        ctx.fillStyle = 'rgba(120,200,245,0.72)'; ctx.fillText(txt, pa.x, pa.y);
        continue;
      }
      const S = PN_STYLE[q.st], c = S.c, rgb = c[0] + ',' + c[1] + ',' + c[2];
      const fs = Math.max(10, Math.min(13.5, 1900 / Math.sqrt(pa.d)));
      ctx.font = '600 ' + fs.toFixed(1) + 'px Archivo, system-ui, sans-serif';
      const tw = ctx.measureText(q.name).width, h = fs + 9, w = tw + 26;
      const lift = q.dot ? 16 : 10;                   // sit above the landmark marker
      const bx = pa.x - w / 2, by = pa.y - lift - h;
      if (bx < 8 || bx + w > W - 64 || by < 72) continue;   // whole chip on screen, clear of the tools
      if (!labelFits(bx - 2, by - 2, w + 4, h + lift + 4)) continue;
      /* stalk down to the exact spot */
      ctx.strokeStyle = 'rgba(' + rgb + ',0.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pa.x, by + h); ctx.lineTo(pa.x, pa.y); ctx.stroke();
      if (!q.dot) { ctx.fillStyle = 'rgba(' + rgb + ',0.9)'; ctx.beginPath(); ctx.arc(pa.x, pa.y, 2, 0, Math.PI * 2); ctx.fill(); }
      placeHits.push({ x0: bx, y0: by, x1: bx + w, y1: by + h, q });
      const sel = MT.state.selection && MT.state.selection.kind === 'place' && MT.state.selection.ref === q;
      rrect(bx, by, w, h, h / 2);
      ctx.fillStyle = sel ? 'rgba(' + rgb + ',0.28)' : 'rgba(6,12,28,0.82)'; ctx.fill();
      ctx.strokeStyle = 'rgba(' + rgb + ',0.55)'; ctx.lineWidth = 1; ctx.stroke();
      glyph(S.g, bx + 11, by + h / 2, 'rgb(' + rgb + ')');
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(240,246,252,0.95)';
      ctx.fillText(q.name, bx + 19, by + h / 2 + 0.5);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  }

  /* Road names written along the carriageway, like a street map: on the
     longest straight links of each corridor, turned to follow the road and
     kept upright. One name per corridor per ~1.5 km so they do not repeat. */
  const shortRoad = n => n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/^Mumbai\s+/, '').trim();
  function drawRoadNames() {
    if (cam.dist > 9000 || !MT.layerOn('roads') || !city.roadPathXY) return;
    for (const C of city.circles || []) { proj(C.x, C.y, 0, pa); if (pa.d < 120) continue; const r = (C.r + 40) * focal / pa.d; occ.push([pa.x - r, pa.y - r - 30, pa.x + r, pa.y + r * 0.7]); }   // keep names off the roundabouts
    const fs = cam.dist < 3000 ? 12 : 11;
    ctx.font = '700 ' + fs + 'px Archivo, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const sx = [], sy = [], sc = [];
    MT.ROADS.forEach((r, ri) => {
      const q = city.roadPathXY[ri]; if (!q) return;
      const txt = shortRoad(r.name); const tw = ctx.measureText(txt).width + 14;
      /* screen polyline of the visible part */
      sx.length = sy.length = sc.length = 0; let acc = 0;
      for (let i = 0; i < q.length; i += 2) {
        proj(q[i], q[i + 1], 0, pa);
        if (pa.d < 150) { acc += 1e6; continue; }        // behind the eye: a break no window can span
        if (sx.length) acc += Math.hypot(pa.x - sx[sx.length - 1], pa.y - sy[sy.length - 1]);
        sx.push(pa.x); sy.push(pa.y); sc.push(acc);
      }
      if (sx.length < 2) return;
      /* slide a window of the text's length along it; take straight, on-screen spots */
      let lastAt = -1e9;
      for (let a = 0, b = 0; a < sx.length; a++) {
        if (sc[a] - lastAt < Math.max(tw * 3, 420)) continue;
        while (b < sx.length - 1 && sc[b] - sc[a] < tw) b++;
        if (sc[b] - sc[a] < tw) break;
        if (sc[b] - sc[a] > tw * 2) continue;               // window crosses a break
        const ch = Math.hypot(sx[b] - sx[a], sy[b] - sy[a]);
        if (ch < (sc[b] - sc[a]) * 0.97) continue;               // too curved here
        const mx = (sx[a] + sx[b]) / 2, my = (sy[a] + sy[b]) / 2;
        if (Math.min(sx[a], sx[b]) < 20 || Math.max(sx[a], sx[b]) > W - 70 || Math.min(sy[a], sy[b]) < 100 || Math.max(sy[a], sy[b]) > H - 80) continue;
        let ang = Math.atan2(sy[b] - sy[a], sx[b] - sx[a]);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        const cw = Math.abs(Math.cos(ang)) * tw + Math.abs(Math.sin(ang)) * fs, chh = Math.abs(Math.sin(ang)) * tw + Math.abs(Math.cos(ang)) * fs;
        if (!labelFits(mx - cw / 2, my - chh / 2, cw, chh)) continue;
        lastAt = sc[a];
        ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(20,12,4,0.92)'; ctx.strokeText(txt, 0, 0);
        ctx.fillStyle = r.cls === 'expressway' || r.cls === 'bridge' ? '#FFE3B0' : '#F2E6CF'; ctx.fillText(txt, 0, 0);
        ctx.restore();
      }
    });
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  }

  function drawLabels() {
    if (!MT.state.labels) return;
    occ.length = 0;
    if (MT.layerOn('landmarks')) drawPlaceNames();
    drawRoadNames();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const near = cam.dist < 14000;
    for (const L of city.localities) {
      proj(L.x, L.y, 0, pa);
      if (pa.d < 200) continue;
      if (pa.x < 40 || pa.x > W - 40 || pa.y < 20 || pa.y > H - 20) continue;
      const fs = Math.max(9.5, Math.min(15, 2200 / Math.sqrt(pa.d)));
      ctx.font = '600 ' + fs.toFixed(1) + 'px Archivo, system-ui, sans-serif';
      const w = ctx.measureText(L.name).width;
      if (!labelFits(pa.x - w / 2 - 4, pa.y - fs - 4, w + 8, fs + 8)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,8,14,0.82)';
      ctx.strokeText(L.name, pa.x, pa.y);
      ctx.fillStyle = 'rgba(232,240,250,0.92)';
      ctx.fillText(L.name, pa.x, pa.y);
    }
    if (near && MT.layerOn('stations')) {
      /* suburban railway stations first: amber chip-less labels above the R dot */
      ctx.font = '600 10.5px "IBM Plex Mono", ui-monospace, monospace';
      const seenRS = new Set();
      for (const s of city.railStations) {
        if (seenRS.has(s.name)) continue;
        proj(s.x, s.y, 0, pa);
        if (pa.d < 200 || pa.d > 12000) continue;
        if (pa.x < 30 || pa.x > W - 110 || pa.y < 100 || pa.y > H - 80) continue;
        const w = ctx.measureText(s.name).width;
        if (!labelFits(pa.x - w / 2 - 3, pa.y - 24, w + 6, 14)) continue;
        seenRS.add(s.name);
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,8,14,0.9)';
        ctx.strokeText(s.name, pa.x, pa.y - 12);
        ctx.fillStyle = '#FFC46B'; ctx.fillText(s.name, pa.x, pa.y - 12);
      }
      ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
      for (const s of city.metroStations) {
        proj(s.x, s.y, 0, pa);
        if (pa.d < 200 || pa.d > 15000) continue;
        const w = ctx.measureText(s.name).width;
        if (pa.x < 30 || pa.x > W - 30) continue;
        if (!labelFits(pa.x - w / 2 - 3, pa.y - 22, w + 6, 13)) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,8,14,0.85)';
        ctx.strokeText(s.name, pa.x, pa.y - 12);
        ctx.fillStyle = '#96E9F7'; ctx.fillText(s.name, pa.x, pa.y - 12);
      }
    }
  }

  /* Origin–destination demand, drawn as lifted arcs. Width and brightness
     scale with the modelled trip volume between two analysis zones — this is
     the gravity matrix the traffic model solves, made visible. */
  let odPhase = 0;
  function drawODFlows() {
    if (!MT.layerOn('odflows') || !MT.sim || !MT.sim.topOD) return;
    const list = MT.sim.topOD(46);
    if (!list || !list.length) return;
    odPhase = (odPhase + 0.6) % 64;
    const maxV = list[0].v || 1;
    ctx.lineCap = 'round';
    for (const o of list) {
      const w = o.v / maxV;
      const span = Math.hypot(o.bx - o.ax, o.by - o.ay);
      const lift = Math.min(9000, span * 0.55);
      const N = 26;
      let started = false;
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const x = o.ax + (o.bx - o.ax) * t;
        const y = o.ay + (o.by - o.ay) * t;
        const z = Math.sin(t * Math.PI) * lift;
        proj(x, y, z, pa);
        if (pa.d < 120) { started = false; continue; }
        if (!started) { ctx.moveTo(pa.x, pa.y); started = true; } else ctx.lineTo(pa.x, pa.y);
      }
      ctx.strokeStyle = 'rgba(139,123,240,' + (0.10 + w * 0.26).toFixed(3) + ')';
      ctx.lineWidth = 1 + w * 4.2;
      ctx.stroke();
      ctx.setLineDash([3, 13]);
      ctx.lineDashOffset = -odPhase;
      ctx.strokeStyle = 'rgba(159,232,247,' + (0.28 + w * 0.5).toFixed(3) + ')';
      ctx.lineWidth = 1 + w * 1.9;
      ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
  }

  function drawRoutes() {
    for (const r of MT.state.routes) {
      const p = r.path;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < p.length; i += 2) {
        proj(p[i], p[i + 1], 20, pa);
        if (pa.d < 100) { started = false; continue; }
        if (!started) { ctx.moveTo(pa.x, pa.y); started = true; } else ctx.lineTo(pa.x, pa.y);
      }
      ctx.strokeStyle = 'rgba(5,9,16,0.6)'; ctx.lineWidth = 8; ctx.stroke();
      ctx.strokeStyle = r.color || '#77E4AE'; ctx.lineWidth = 3.4; ctx.stroke();
      ctx.setLineDash([2, 7]);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawHighlight() {
    const hl = MT.state.highlight;
    if (!hl) return;
    if (hl.circles) for (const c of hl.circles) {
      const steps = 48; ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const a = i / steps * Math.PI * 2;
        proj(c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r, 2, pa);
        if (i === 0) ctx.moveTo(pa.x, pa.y); else ctx.lineTo(pa.x, pa.y);
      }
      ctx.closePath();
      ctx.fillStyle = hl.fill || 'rgba(63,211,230,0.10)'; ctx.fill();
      ctx.strokeStyle = hl.stroke || 'rgba(63,211,230,0.75)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (hl.points) {
      ctx.textAlign = 'center';
      for (const p of hl.points) {
        proj(p.x, p.y, 0, pa);
        if (pa.d < 150) continue;
        const t = (Date.now() % 1400) / 1400;
        ctx.strokeStyle = 'rgba(127,227,242,' + (0.9 - t * 0.9) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(pa.x, pa.y, 6 + t * 16, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#7FEBFA';
        ctx.beginPath(); ctx.arc(pa.x, pa.y, 4, 0, Math.PI * 2); ctx.fill();
        if (p.name && cam.dist < 30000) {
          ctx.font = '600 11px Archivo, system-ui, sans-serif';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(4,8,14,0.85)';
          ctx.strokeText(p.name, pa.x, pa.y - 12);
          ctx.fillStyle = '#DFF2F9'; ctx.fillText(p.name, pa.x, pa.y - 12);
        }
      }
    }
  }

  function drawMeasure() {
    const m = MT.state.measure;
    if (!m.pts.length) return;
    const tool = MT.state.tool;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < m.pts.length; i++) {
      proj(m.pts[i].x, m.pts[i].y, 4, pa);
      if (i === 0) ctx.moveTo(pa.x, pa.y); else ctx.lineTo(pa.x, pa.y);
    }
    if (tool === 'area' && m.pts.length > 2) ctx.closePath();
    if (tool === 'area') { ctx.fillStyle = 'rgba(63,211,230,0.14)'; ctx.fill(); }
    ctx.strokeStyle = '#3FD3E6'; ctx.lineWidth = 2; ctx.stroke();

    if (tool === 'radius' && m.pts.length >= 2) {
      const r = Math.hypot(m.pts[1].x - m.pts[0].x, m.pts[1].y - m.pts[0].y);
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const a = i / 64 * Math.PI * 2;
        proj(m.pts[0].x + Math.cos(a) * r, m.pts[0].y + Math.sin(a) * r, 2, pa);
        if (i === 0) ctx.moveTo(pa.x, pa.y); else ctx.lineTo(pa.x, pa.y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(63,211,230,0.10)'; ctx.fill();
      ctx.strokeStyle = '#3FD3E6'; ctx.stroke();
    }
    for (const p of m.pts) {
      proj(p.x, p.y, 4, pa);
      ctx.fillStyle = '#060812'; ctx.beginPath(); ctx.arc(pa.x, pa.y, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3FD3E6'; ctx.beginPath(); ctx.arc(pa.x, pa.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawAreaSel() {
    const a = MT.state.areaSel; if (!a) return;
    const pts = [[a.x0, a.y0], [a.x1, a.y0], [a.x1, a.y1], [a.x0, a.y1]];
    ctx.beginPath();
    pts.forEach((p, i) => { proj(p[0], p[1], 3, pa); i ? ctx.lineTo(pa.x, pa.y) : ctx.moveTo(pa.x, pa.y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(63,211,230,0.10)'; ctx.fill();
    ctx.strokeStyle = '#3FD3E6'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
  }

  /* Sky above the horizon, open sea below it, so the data extent never shows
     its own edge. The horizon sits at H/2 − focal·tan(pitch) in screen space. */
  function horizonY() { return H / 2 + offY - focal * Math.tan(cam.pitch); }

  function drawSky() {
    const hy = horizonY();
    const skyH = Math.max(0, Math.min(H, hy));
    if (skyH > 0) {
      /* the sky follows the clock: deep night, a blue day, a warm band at dusk */
      const d = sun.day, gd = sun.golden;
      const mix = (n, dy) => 'rgb(' + n.map((v, k) => Math.round(v + (dy[k] - v) * d)).join(',') + ')';
      const g2 = ctx.createLinearGradient(0, 0, 0, skyH);
      g2.addColorStop(0, mix([5, 6, 15], [18, 44, 92]));
      g2.addColorStop(0.42, mix([9, 15, 36], [34, 72, 128]));
      g2.addColorStop(0.78, mix([23, 34, 62], [66, 110, 160]));
      g2.addColorStop(1, mix([42, 59, 82], [104, 146, 186]));
      ctx.fillStyle = g2; ctx.fillRect(0, 0, W, skyH);
      if (gd > 0.02) {
        const gg = ctx.createLinearGradient(0, skyH * 0.35, 0, skyH);
        gg.addColorStop(0, 'rgba(255,140,70,0)'); gg.addColorStop(1, 'rgba(255,140,70,' + (0.35 * gd).toFixed(3) + ')');
        ctx.fillStyle = gg; ctx.fillRect(0, skyH * 0.35, W, skyH * 0.65);
      }
      /* warm sodium band right on the horizon — the city's own light */
      const gw = ctx.createLinearGradient(0, skyH - Math.min(70, skyH * 0.5), 0, skyH);
      gw.addColorStop(0, 'rgba(184,124,74,0)');
      gw.addColorStop(1, 'rgba(198,132,78,0.30)');
      ctx.fillStyle = gw; ctx.fillRect(0, skyH - Math.min(70, skyH * 0.5), W, Math.min(70, skyH * 0.5));
    }
    if (skyH < H) {
      /* Flat, and exactly the raster's deep-water value, so the edge of the
         data extent is invisible where the two meet. */
      ctx.fillStyle = 'rgb(12,28,54)';
      ctx.fillRect(0, skyH, W, H - skyH);
    }
  }

  /* ====================================================== HOLOGRAM FURNITURE */
  /* The wireframe style is a second visual language over the same geometry:
     a lit swell on the water, a measured graticule on the ground, a glowing
     coastline, and buildings drawn as edge-lit volumes instead of solids. */
  let holoPhase = 0;

  function drawSeaMesh() {
    const R2 = Math.min(26000, cam.dist * 1.6 + 7000);
    const step = R2 > 18000 ? 1600 : R2 > 9000 ? 900 : 500;
    const cx = Math.round(cam.tx / step) * step, cy = Math.round(cam.ty / step) * step;
    const n = Math.min(34, Math.round(R2 / step));
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = -n; i <= n; i++) {
        let started = false;
        for (let j = -n; j <= n; j++) {
          const wxx = cx + (pass ? i : j) * step;
          const wyy = cy + (pass ? j : i) * step;
          const k = city.cellIndex(wxx, wyy);
          if (k >= 0 && city.land[k]) { started = false; continue; }
          const z = Math.sin(wxx * 0.00042 + holoPhase) * 46
                  + Math.sin(wyy * 0.00031 - holoPhase * 0.7) * 38;
          proj(wxx, wyy, z, pa);
          if (pa.d < 300) { started = false; continue; }
          if (!started) { ctx.moveTo(pa.x, pa.y); started = true; } else ctx.lineTo(pa.x, pa.y);
        }
      }
      ctx.strokeStyle = 'rgba(38,126,214,0.30)';
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawLandGrid() {
    const step = cam.dist > 26000 ? 4000 : cam.dist > 12000 ? 2000 : cam.dist > 5000 ? 1000 : 500;
    const R2 = Math.min(30000, cam.dist * 1.7 + 5000);
    const cx = Math.round(cam.tx / step) * step, cy = Math.round(cam.ty / step) * step;
    const n = Math.min(40, Math.round(R2 / step));
    ctx.globalCompositeOperation = 'lighter';
    for (let major = 0; major < 2; major++) {
      ctx.beginPath();
      for (let i = -n; i <= n; i++) {
        if ((Math.abs(i) % 5 === 0) !== (major === 1)) continue;
        for (let pass = 0; pass < 2; pass++) {
          const a1x = pass ? cx + i * step : cx - n * step;
          const a1y = pass ? cy - n * step : cy + i * step;
          const a2x = pass ? cx + i * step : cx + n * step;
          const a2y = pass ? cy + n * step : cy + i * step;
          proj(a1x, a1y, 1, pa); proj(a2x, a2y, 1, pb);
          if (pa.d < 300 || pb.d < 300) continue;
          ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
        }
      }
      ctx.strokeStyle = major ? 'rgba(74,214,238,0.30)' : 'rgba(52,178,214,0.15)';
      ctx.lineWidth = major ? 1.2 : 1;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawCoastGlow() {
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    for (const L of city.landRings) {
      const ring = L.ring, n = ring.length / 2;
      let started = false;
      for (let i = 0; i <= n; i++) {
        const k = i % n, kp = (i + n - 1) % n;
        /* an edge between two frame vertices is the model's outer edge, not coast */
        if (i > 0 && L.frame[k] && L.frame[kp]) { started = false; }
        proj(ring[k * 2], ring[k * 2 + 1], 2, pa);
        if (pa.d < 300) { started = false; continue; }
        if (!started || (i > 0 && L.frame[k] && L.frame[kp])) { ctx.moveTo(pa.x, pa.y); started = true; }
        else ctx.lineTo(pa.x, pa.y);
      }
    }
    ctx.strokeStyle = 'rgba(52,196,232,0.18)'; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = 'rgba(126,235,250,0.55)'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }


  /* ---------------------------------------------------- building twins ---
     A few demonstration buildings drawn at building level rather than as
     massing: a glass curtain wall, lit floor plates, a service riser whose
     pipes branch along every ceiling, plant on the roof and in a basement
     seen through the ground. All of it is illustrative — no BIM model or BMS
     is connected — and the UI says so wherever a twin can be inspected. */
  const TW_PIPES = [                       // riser order, one colour per service
    [255, 138, 61],                        // heating / hot water
    [224, 86, 253],                        // chilled-water return
    [139, 123, 240],                       // electrical
    [63, 224, 138],                        // domestic water
    [63, 211, 230]                         // chilled-water supply
  ];
  const twA = P(), twB = P(), twQ = [P(), P(), P(), P()], twR = [P(), P(), P(), P()];
  const twPoly = [];
  for (let i = 0; i < 12; i++) twPoly.push(P());
  let twCos = 1, twSin = 0, twRef = null;
  function twP(lx, ly, z, out) {
    return proj(twRef.x + lx * twCos - ly * twSin, twRef.y + lx * twSin + ly * twCos, z, out);
  }
  function twRect(x0, y0, x1, y1, z) {          // adds a closed rectangle to the path
    twP(x0, y0, z, twQ[0]); twP(x1, y0, z, twQ[1]); twP(x1, y1, z, twQ[2]); twP(x0, y1, z, twQ[3]);
    ctx.moveTo(twQ[0].x, twQ[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(twQ[i].x, twQ[i].y);
    ctx.closePath();
  }
  function twSeg(x0, y0, z0, x1, y1, z1) {
    twP(x0, y0, z0, twA); twP(x1, y1, z1, twB);
    ctx.moveTo(twA.x, twA.y); ctx.lineTo(twB.x, twB.y);
  }
  function twBox(x0, y0, x1, y1, z0, z1) {      // twelve edges
    twRect(x0, y0, x1, y1, z0); twRect(x0, y0, x1, y1, z1);
    twSeg(x0, y0, z0, x0, y0, z1); twSeg(x1, y0, z0, x1, y0, z1);
    twSeg(x1, y1, z0, x1, y1, z1); twSeg(x0, y1, z0, x0, y1, z1);
  }
  function twPipe(pts, rgb, w, a) {             // a polyline in local metres
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      twP(pts[i][0], pts[i][1], pts[i][2], twA);
      if (i === 0) ctx.moveTo(twA.x, twA.y); else ctx.lineTo(twA.x, twA.y);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.22 * a).toFixed(3) + ')';
    ctx.lineWidth = w * 2.6; ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(' + rgb + ',' + (0.95 * a).toFixed(3) + ')';
    ctx.lineWidth = w; ctx.stroke();
  }

  /* a hovered twin gets the same ring, glow and pinned card as a building */
  function drawTwin(tw, depth) {
    drawTwinBody(tw, depth);
    if (MT.state.hover !== tw) return;
    const vs = MT.state.vscale || 1, Ht = tw.floors * 4.2 * vs;
    const hw = tw.w / 2, hd = tw.d / 2;
    const box = { x: tw.x, y: tw.y, w: tw.w, d: tw.d, rot: tw.rot, tScale: 1,
                  poly: [-hw, -hd, hw, -hd, hw, hd, -hw, hd] };
    drawAura(box, Ht, 0, fogAmt(depth), HOV_RGB);
  }
  function drawTwinBody(tw, depth) {
    const fg = fogAmt(depth), al = 1 - fg;
    if (al < 0.03) return;
    twRef = tw; twCos = Math.cos(tw.rot); twSin = Math.sin(tw.rot);
    const vs = MT.state.vscale || 1, hs = Math.min(vs, 1.8);
    const hw = tw.w / 2, hd = tw.d / 2, fh = 4.2 * vs, N = tw.floors, Ht = N * fh;
    const sel = MT.state.selection && MT.state.selection.kind === 'twin' && MT.state.selection.ref === tw;
    twP(0, 0, 0, twA); twP(0, 0, Ht, twB);
    const ph = Math.abs(twA.y - twB.y), roofX = twB.x, roofY = twB.y;
    const scale = focal / Math.max(1, depth);
    const cx = [-hw, hw, hw, -hw], cy = [-hd, -hd, hd, hd];
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    /* far: a lit block and a gold marker, so the few sites can be found */
    if (ph < 14) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,196,110,' + (0.30 * al).toFixed(3) + ')';
      ctx.beginPath(); twRect(-hw, -hd, hw, hd, Ht); ctx.fill();
      ctx.strokeStyle = 'rgba(170,236,255,' + (0.85 * al).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath(); twBox(-hw, -hd, hw, hd, 0, Ht); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      twMarker(roofX, roofY - 9, al, sel);
      return;
    }

    /* site pad */
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(120,220,255,' + (0.45 * al).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath(); twRect(-hw - 12, -hd - 12, hw + 12, hd + 12, 0.3); ctx.stroke();
    ctx.setLineDash([]);

    /* basement plant room, read through the ground */
    const bz = -fh * 1.15, rx = -hw * 0.12, pg = 2.6;
    ctx.fillStyle = 'rgba(8,30,48,' + (0.55 * al).toFixed(3) + ')';
    ctx.beginPath(); twRect(-hw * 0.92, -hd * 0.9, hw * 0.92, hd * 0.9, bz); ctx.fill();
    ctx.strokeStyle = 'rgba(110,210,250,' + (0.50 * al).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath(); twBox(-hw * 0.92, -hd * 0.9, hw * 0.92, hd * 0.9, bz, 0); ctx.stroke();
    const pw = Math.max(1.3, Math.min(4, 0.9 * scale));
    if (ph > 34) {
      ctx.strokeStyle = 'rgba(220,244,255,' + (0.8 * al).toFixed(3) + ')';
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {                  // chillers / pumps / switchgear
        const x0 = hw * (0.28 + i * 0.2);
        twBox(x0, -hd * 0.5, x0 + hw * 0.13, hd * 0.2, bz, bz + 2.6 * hs);
      }
      ctx.stroke();
      TW_PIPES.forEach((c, i) => {
        const ly = (i - 2) * pg, zz = bz + 1.6 * hs + i * 0.5 * hs;
        twPipe([[rx, ly, bz * 0.45], [rx, ly, zz], [hw * (0.3 + (i % 3) * 0.2), ly, zz],
                [hw * (0.3 + (i % 3) * 0.2), ly, bz + 2.6 * hs]], c.join(','), pw, al * 0.8);
      });
    }

    /* which faces are towards the camera */
    const front = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ax = tw.x + cx[i] * twCos - cy[i] * twSin, ay = tw.y + cx[i] * twSin + cy[i] * twCos;
      const bx = tw.x + cx[j] * twCos - cy[j] * twSin, by = tw.y + cx[j] * twSin + cy[j] * twCos;
      const ex = bx - ax, ey = by - ay, mx = (ax + bx) / 2, my = (ay + by) / 2;
      front.push(ey * (camX - mx) - ex * (camY - my) > 0);
    }
    const wall = (i, fill, strokeRGBA) => {
      const j = (i + 1) % 4;
      twP(cx[i], cy[i], 0, twR[0]); twP(cx[j], cy[j], 0, twR[1]);
      twP(cx[j], cy[j], Ht, twR[2]); twP(cx[i], cy[i], Ht, twR[3]);
      ctx.beginPath(); ctx.moveTo(twR[0].x, twR[0].y);
      for (let k = 1; k < 4; k++) ctx.lineTo(twR[k].x, twR[k].y);
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      /* mullions every ~6 m */
      const L = i % 2 ? tw.d : tw.w, nM = Math.max(2, Math.round(L / 6));
      ctx.beginPath();
      for (let m = 1; m < nM; m++) {
        const f = m / nM;
        const lx = cx[i] + (cx[j] - cx[i]) * f, ly = cy[i] + (cy[j] - cy[i]) * f;
        twSeg(lx, ly, 0, lx, ly, Ht);
      }
      ctx.strokeStyle = strokeRGBA; ctx.lineWidth = 1; ctx.stroke();
    };

    /* back walls first */
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) if (!front[i]) wall(i, 'rgba(60,150,220,' + (0.06 * al).toFixed(3) + ')',
                                                    'rgba(120,200,255,' + (0.18 * al).toFixed(3) + ')');
    ctx.globalCompositeOperation = 'source-over';

    /* floors: warm lit plates, desks when close, bright slab edges */
    const desks = ph > 150;
    for (let k = 0; k < N; k++) {
      const z = k * fh + 0.2;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,190,112,' + ((k === 0 ? 0.13 : 0.085) * al).toFixed(3) + ')';
      ctx.beginPath(); twRect(-hw * 0.97, -hd * 0.97, hw * 0.97, hd * 0.97, z); ctx.fill();
      if (desks && k > 0) {
        ctx.fillStyle = 'rgba(255,218,160,' + (0.32 * al).toFixed(3) + ')';
        ctx.beginPath();
        for (let dx = -hw * 0.82; dx < hw * 0.84; dx += 8) {
          if (Math.abs(dx - rx) < 7) continue;                 // keep the core clear
          for (let dy = -hd * 0.72; dy < hd * 0.74; dy += 7) twRect(dx - 1.3, dy - 0.7, dx + 1.3, dy + 0.7, z + 0.9);
        }
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /* the service riser and its branches along each ceiling */
    const riserTop = Ht + 1.4 * hs;
    TW_PIPES.forEach((c, i) => {
      const ly = (i - 2) * pg;
      twPipe([[rx, ly, bz * 0.45], [rx, ly, riserTop]], c.join(','), pw, al);
    });
    if (ph > 26) {
      for (let k = 0; k < N; k++) {
        const zc = k * fh + fh * 0.82;
        const bw = Math.max(1, pw * 0.7);
        twPipe([[rx, -2 * pg, zc], [hw * 0.82, -2 * pg, zc], [hw * 0.82, hd * 0.62, zc]], TW_PIPES[0].join(','), bw, al * 0.9);
        twPipe([[rx, 2 * pg, zc - 0.5], [-hw * 0.82, 2 * pg, zc - 0.5], [-hw * 0.82, -hd * 0.62, zc - 0.5]], TW_PIPES[4].join(','), bw, al * 0.9);
        twPipe([[rx, 0, zc - 1], [rx, hd * 0.8, zc - 1]], TW_PIPES[2].join(','), bw, al * 0.8);
        if (k % 2 === 0) twPipe([[rx, -pg, zc - 1.4], [rx, -hd * 0.8, zc - 1.4]], TW_PIPES[1].join(','), bw, al * 0.8);
        else twPipe([[rx, pg, zc - 1.4], [hw * 0.5, pg, zc - 1.4]], TW_PIPES[3].join(','), bw, al * 0.8);
      }
    }

    /* slab edges: the bright horizontal bands of the reference */
    ctx.beginPath();
    for (let k = 0; k <= N; k++) twRect(-hw, -hd, hw, hd, k * fh);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(80,190,255,' + (0.16 * al).toFixed(3) + ')'; ctx.lineWidth = 4; ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = sel ? 'rgba(255,236,170,' + al.toFixed(3) + ')' : 'rgba(140,226,255,' + (0.85 * al).toFixed(3) + ')';
    ctx.lineWidth = 1.3; ctx.stroke();

    /* entrance canopy on the -y face */
    ctx.strokeStyle = 'rgba(200,240,255,' + (0.8 * al).toFixed(3) + ')';
    ctx.fillStyle = 'rgba(120,200,255,' + (0.12 * al).toFixed(3) + ')';
    ctx.beginPath(); twRect(-hw * 0.25, -hd - 7, hw * 0.25, -hd, fh * 0.8); ctx.fill(); ctx.stroke();

    /* roof: slab, parapet, HVAC units with fans, solar array, roof pipework */
    const rz = Ht + 0.3;
    ctx.fillStyle = 'rgba(10,28,46,' + (0.55 * al).toFixed(3) + ')';
    ctx.beginPath(); twRect(-hw, -hd, hw, hd, rz); ctx.fill();
    ctx.strokeStyle = 'rgba(160,230,255,' + (0.7 * al).toFixed(3) + ')'; ctx.lineWidth = 1;
    ctx.beginPath(); twRect(-hw * 0.98, -hd * 0.98, hw * 0.98, hd * 0.98, rz + 1.1 * hs); ctx.stroke();
    if (ph > 22) {
      /* solar: tilted panels on the west half */
      const sx0 = -hw * 0.9, sx1 = -hw * 0.32;
      for (let r = 0; r < 3; r++) {
        const y0 = -hd * 0.75 + r * hd * 0.52, y1 = y0 + hd * 0.4;
        twP(sx0, y0, rz + 0.6, twQ[0]); twP(sx1, y0, rz + 0.6, twQ[1]);
        twP(sx1, y1, rz + 0.6 + 1.6 * hs, twQ[2]); twP(sx0, y1, rz + 0.6 + 1.6 * hs, twQ[3]);
        ctx.beginPath(); ctx.moveTo(twQ[0].x, twQ[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(twQ[i].x, twQ[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(40,86,210,' + (0.62 * al).toFixed(3) + ')'; ctx.fill();
        ctx.strokeStyle = 'rgba(130,180,255,' + (0.9 * al).toFixed(3) + ')'; ctx.stroke();
        if (ph > 60) {
          ctx.beginPath();
          for (let m = 1; m < 6; m++) {
            const f = m / 6;
            ctx.moveTo(twQ[0].x + (twQ[1].x - twQ[0].x) * f, twQ[0].y + (twQ[1].y - twQ[0].y) * f);
            ctx.lineTo(twQ[3].x + (twQ[2].x - twQ[3].x) * f, twQ[3].y + (twQ[2].y - twQ[3].y) * f);
          }
          ctx.strokeStyle = 'rgba(150,196,255,' + (0.5 * al).toFixed(3) + ')'; ctx.stroke();
        }
      }
      /* HVAC units on the east half */
      const uh = 2.4 * hs;
      for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) {
        const x0 = hw * (0.22 + a * 0.36), y0 = -hd * 0.62 + b2 * hd * 0.7;
        const x1 = x0 + hw * 0.26, y1 = y0 + hd * 0.42;
        ctx.fillStyle = 'rgba(214,232,244,' + (0.30 * al).toFixed(3) + ')';
        ctx.beginPath(); twRect(x0, y0, x1, y1, rz + uh); ctx.fill();
        ctx.strokeStyle = 'rgba(230,246,255,' + (0.9 * al).toFixed(3) + ')';
        ctx.beginPath(); twBox(x0, y0, x1, y1, rz, rz + uh); ctx.stroke();
        if (ph > 60) {                                    // fan ring on top
          const fx = (x0 + x1) / 2, fy = (y0 + y1) / 2, fr = Math.min(x1 - x0, y1 - y0) * 0.36;
          ctx.beginPath();
          for (let q = 0; q <= 10; q++) {
            const th = q / 10 * Math.PI * 2;
            twP(fx + Math.cos(th) * fr, fy + Math.sin(th) * fr, rz + uh + 0.05, twA);
            if (q === 0) ctx.moveTo(twA.x, twA.y); else ctx.lineTo(twA.x, twA.y);
          }
          ctx.stroke();
        }
      }
      /* roof pipework from the riser head to the plant */
      TW_PIPES.forEach((c, i) => {
        const ly = (i - 2) * pg;
        twPipe([[rx, ly, riserTop], [hw * (0.22 + (i % 2) * 0.36), ly, riserTop],
                [hw * (0.22 + (i % 2) * 0.36), ly, rz + uh * 0.6]], c.join(','), pw, al);
      });
    }

    /* front walls last: glass, mullions, then the bright corner posts */
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) if (front[i]) wall(i, 'rgba(70,170,240,' + (0.07 * al).toFixed(3) + ')',
                                                   'rgba(150,222,255,' + (0.34 * al).toFixed(3) + ')');
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    for (let i = 0; i < 4; i++) twSeg(cx[i], cy[i], 0, cx[i], cy[i], Ht);
    ctx.strokeStyle = sel ? 'rgba(255,236,170,' + al.toFixed(3) + ')' : 'rgba(186,240,255,' + (0.95 * al).toFixed(3) + ')';
    ctx.lineWidth = 1.7; ctx.stroke();

    /* tag */
    if (ph > 40) {
      twP(0, 0, Ht + 6 * hs, twA);
      ctx.font = '700 9px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,214,122,' + (0.95 * al).toFixed(3) + ')';
      ctx.fillText('BUILDING TWIN · DEMO', twA.x, twA.y - 16);
      ctx.font = '500 10px "Inter", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(226,240,250,' + (0.85 * al).toFixed(3) + ')';
      ctx.fillText(tw.area, twA.x, twA.y - 4);
    } else twMarker(roofX, roofY - 9, al, sel);
  }

  function twMarker(x, y, al, sel) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,196,90,' + (0.28 * al).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(x, y, 8, 0, 6.283); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = sel ? '#FFF1C8' : 'rgba(255,210,122,' + al.toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 4, y);
    ctx.closePath(); ctx.fill();
  }

  /** The twin under a screen point, from its projected volume. */
  R.pickTwin = function (sx, sy) {
    if (!MT.layerOn('twins')) return null;
    let best = null, bd = Infinity;
    const vs = MT.state.vscale || 1;
    for (const tw of city.twins || []) {
      twRef = tw; twCos = Math.cos(tw.rot); twSin = Math.sin(tw.rot);
      const hw = tw.w / 2, hd = tw.d / 2, Ht = tw.floors * 4.2 * vs;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, dd = 0;
      for (const [lx, ly] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) for (const z of [0, Ht]) {
        twP(lx, ly, z, twA);
        if (twA.d < 150) { dd = -1; break; }
        x0 = Math.min(x0, twA.x); x1 = Math.max(x1, twA.x); y0 = Math.min(y0, twA.y); y1 = Math.max(y1, twA.y);
        dd = twA.d;
      }
      if (dd < 0) continue;
      const pad = Math.max(0, 12 - (x1 - x0)) / 2;       // small on screen: stay clickable
      if (sx >= x0 - pad && sx <= x1 + pad && sy >= y0 - pad - 12 && sy <= y1 + pad && dd < bd) { bd = dd; best = tw; }
    }
    return best;
  };

  /* Edge-lit volume: a dark translucent body with glowing verticals, a bright
     roof outline and floor lines standing in for the facade grid. */
  /* Hologram palette by building use — all within the cyan family, so the
     "Buildings" key still holds, but distinct enough to read the city's mix:
     homes aqua, offices blue glass, industry steel, institutions ice-white. */
  const USE_HOLO = {
    'Residential':   { edge: '96,226,248',  body: '8,56,72',  roof: '12,72,92',  bands: 0.30 },
    'Mixed use':     { edge: '110,214,250', body: '10,52,80', roof: '14,66,98',  bands: 0.20 },
    'Commercial':    { edge: '110,178,255', body: '10,38,92', roof: '16,52,116', bands: 0.10 },
    'Industrial':    { edge: '150,176,206', body: '26,40,58', roof: '34,52,72',  bands: 0.08 },
    'Institutional': { edge: '205,228,255', body: '28,46,78', roof: '38,60,98',  bands: 0.16 }
  };
  MT.USE_HOLO = USE_HOLO;
  function drawPrismHolo(b, scale, z0, z1, fg, sel, opts) {
    const UC = USE_HOLO[b.use] || USE_HOLO.Residential;
    /* Far away a building is a few pixels of light. Drawing five filled faces
       and a floor grid for that costs the frame and shows nothing, so it
       becomes a single lit stroke — enough to keep the built fabric visible
       across the whole-city view without paying prism prices for it. */
    if (!sel) {
      proj(b.x, b.y, z0, pa);
      if (pa.d > 150) {
        const spx = focal / pa.d;
        if (b.area * spx * spx < 46) {
          proj(b.x, b.y, z1, pb);
          const a = (1 - fg);
          if (a <= 0.02) return;
          ctx.strokeStyle = 'rgba(' + UC.edge + ',' + (0.42 * a + 0.06).toFixed(3) + ')';
          ctx.lineWidth = Math.max(0.8, Math.min(3, Math.sqrt(b.area) * spx * 0.55));
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
          return;
        }
      }
    }
    const poly = b.poly, n = poly.length / 2;
    const cr = Math.cos(b.rot), sr = Math.sin(b.rot);
    for (let i = 0; i < n; i++) {
      const lx = poly[i * 2] * scale, ly = poly[i * 2 + 1] * scale;
      wx[i] = b.x + lx * cr - ly * sr;
      wy[i] = b.y + lx * sr + ly * cr;
      proj(wx[i], wy[i], z0, SA[i]);
      proj(wx[i], wy[i], z1, SB[i]);
    }
    const ph = Math.abs(SA[0].y - SB[0].y);
    const a = (1 - fg);
    const vis = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = wx[j] - wx[i], ey = wy[j] - wy[i];
      const mx = (wx[i] + wx[j]) / 2, my = (wy[i] + wy[j]) / 2;
      if (ey * (camX - mx) - ex * (camY - my) > 0) vis.push(i);
    }
    /* body */
    ctx.fillStyle = HOV ? 'rgba(150,40,120,0.52)' : sel ? 'rgba(80,225,245,0.42)' : 'rgba(' + UC.body + ',' + (0.50 * a + 0.16).toFixed(3) + ')';
    for (const i of vis) {
      const j = (i + 1) % n;
      ctx.beginPath();
      ctx.moveTo(SA[i].x, SA[i].y); ctx.lineTo(SA[j].x, SA[j].y);
      ctx.lineTo(SB[j].x, SB[j].y); ctx.lineTo(SB[i].x, SB[i].y);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = HOV ? 'rgba(255,120,214,0.62)' : sel ? 'rgba(150,245,255,0.55)' : 'rgba(' + UC.roof + ',' + (0.56 * a + 0.16).toFixed(3) + ')';
    ctx.beginPath();
    ctx.moveTo(SB[0].x, SB[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(SB[i].x, SB[i].y);
    ctx.closePath(); ctx.fill();

    if (ph < 2.2) return ph;
    ctx.globalCompositeOperation = 'lighter';
    /* floor lines — the facade grid of the reference towers */
    if (ph > 16 && fg < 0.55) {
      const rows = Math.min(14, Math.max(2, Math.round(ph / 7)));
      /* floor lines; on homes these are balcony slabs, so they read brighter */
      ctx.strokeStyle = HOV ? 'rgba(255,140,220,0.55)' : 'rgba(' + UC.edge + ',' + (UC.bands * a).toFixed(3) + ')';
      ctx.lineWidth = b.use === 'Residential' && ph > 50 ? 1.2 : 0.8;
      ctx.beginPath();
      for (const i of vis) {
        const j = (i + 1) % n;
        for (let k2 = 1; k2 <= rows; k2++) {
          const t = k2 / (rows + 1);
          ctx.moveTo(SA[i].x + (SB[i].x - SA[i].x) * t, SA[i].y + (SB[i].y - SA[i].y) * t);
          ctx.lineTo(SA[j].x + (SB[j].x - SA[j].x) * t, SA[j].y + (SB[j].y - SA[j].y) * t);
        }
      }
      ctx.stroke();
    }
    /* verticals + roof outline */
    ctx.strokeStyle = HOV ? 'rgba(255,190,236,0.98)' : sel ? 'rgba(180,250,255,0.95)' : 'rgba(' + UC.edge + ',' + (0.50 * a + 0.12).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const i of vis) { ctx.moveTo(SA[i].x, SA[i].y); ctx.lineTo(SB[i].x, SB[i].y); }
    ctx.moveTo(SB[0].x, SB[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(SB[i].x, SB[i].y);
    ctx.closePath();
    ctx.stroke();
    if (ph > 30) {                                   // brighter crown
      ctx.strokeStyle = 'rgba(' + UC.edge + ',' + (0.7 * a).toFixed(3) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(SB[0].x, SB[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(SB[i].x, SB[i].y);
      ctx.closePath(); ctx.stroke();
    }
    if (ph > 26 && fg < 0.6 && !HOV && !sel) holoDetail(b, scale, z0, z1, a, ph, vis, n, opts && opts.top);
    ctx.globalCompositeOperation = 'source-over';
    return ph;
  }

  /* Close-range facade and roof detail for the hologram style: a glowing
     footing line, mullions, a sparse pattern of lit windows (a fixed hash per
     building, so it never flickers), and on the roof an antenna with a
     blinking red light on the tallest towers, a helipad on some, and a plant
     room on large low blocks. All of it is decorative — the buildings are
     generated, so none of it describes a real roof. */
  const hq = (a, b2, c) => { const x = Math.sin(a * 12.9898 + b2 * 78.233 + c * 37.719) * 43758.5453; return x - Math.floor(x); };
  function holoDetail(b, scale, z0, z1, a, ph, vis, n, isTop) {
    ctx.globalCompositeOperation = 'lighter';
    /* footing: where the building meets the ground */
    if (z0 === 0) {
      ctx.strokeStyle = 'rgba(120,240,255,' + (0.38 * a).toFixed(3) + ')';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const i of vis) { const j = (i + 1) % n; ctx.moveTo(SA[i].x, SA[i].y); ctx.lineTo(SA[j].x, SA[j].y); }
      ctx.stroke();
    }
    if (ph > 44) {
      const rows = Math.min(22, Math.max(3, Math.round(ph / 9)));
      const warm = 0.28 + 0.7 * sun.night;
      let budget = Math.round(50 + 90 * sun.night);        // more windows lit after dark
      const litFrac = 0.07 + 0.25 * sun.night;
      ctx.lineWidth = 1;
      for (const i of vis) {
        const j = (i + 1) % n;
        const fw = Math.hypot(SA[j].x - SA[i].x, SA[j].y - SA[i].y);
        if (fw < 14) continue;
        const cols = Math.min(14, Math.max(2, Math.round(fw / 9)));
        /* mullions */
        ctx.strokeStyle = b.use === 'Commercial' ? 'rgba(130,190,255,' + (0.34 * a).toFixed(3) + ')'   // glass fins
                                                 : 'rgba(80,210,245,' + (0.13 * a).toFixed(3) + ')';
        ctx.beginPath();
        for (let c = 1; c < cols; c++) {
          const t = c / cols;
          ctx.moveTo(SA[i].x + (SA[j].x - SA[i].x) * t, SA[i].y + (SA[j].y - SA[i].y) * t);
          ctx.lineTo(SB[i].x + (SB[j].x - SB[i].x) * t, SB[i].y + (SB[j].y - SB[i].y) * t);
        }
        ctx.stroke();
        /* lit windows */
        const cw = fw / cols * 0.5, rh = ph / rows * 0.42;
        for (let r = 0; r < rows && budget > 0; r++) for (let c = 0; c < cols && budget > 0; c++) {
          const h = hq(b.tint * 997 + i, r, c);
          if (h > litFrac) continue;
          budget--;
          const u = (c + 0.5) / cols, v = (r + 0.55) / rows;
          const bx = SA[i].x + (SA[j].x - SA[i].x) * u, by = SA[i].y + (SA[j].y - SA[i].y) * u;
          const tx = SB[i].x + (SB[j].x - SB[i].x) * u, ty = SB[i].y + (SB[j].y - SB[i].y) * u;
          const x = bx + (tx - bx) * v, y = by + (ty - by) * v;
          ctx.fillStyle = h < 0.07 ? 'rgba(255,214,150,' + (0.55 * a * warm).toFixed(3) + ')'
                                   : 'rgba(150,236,255,' + (0.38 * a).toFixed(3) + ')';
          ctx.fillRect(x - cw / 2, y - rh / 2, cw, Math.max(1, rh));
        }
      }
    }
    if (!isTop || ph < 18) return;
    /* roof centre */
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += wx[i]; cy += wy[i]; }
    cx /= n; cy /= n;
    const seed = hq(b.tint * 311, 1, 2);
    const zs = z1 / Math.max(1, b.h);                      // display height exaggeration
    if (b.use === 'Residential' && b.h < 16 && b.shape === 0) {
      /* low-rise home: a pitched roof along the long side */
      const c0 = Math.cos(b.rot), s0 = Math.sin(b.rot), hw = b.w / 2 * scale, hd = b.d / 2 * scale;
      const along = hw >= hd, rise = Math.min(hw, hd) * 0.5 * zs;
      const P2 = (lx, ly, z) => proj(b.x + lx * c0 - ly * s0, b.y + lx * s0 + ly * c0, z, pa);
      ctx.strokeStyle = 'rgba(150,240,255,' + (0.75 * a).toFixed(3) + ')'; ctx.lineWidth = 1.1;
      ctx.beginPath();
      const ends = along ? [[-hw, 0], [hw, 0]] : [[0, -hd], [0, hd]];
      P2(ends[0][0], ends[0][1], z1 + rise); ctx.moveTo(pa.x, pa.y); P2(ends[1][0], ends[1][1], z1 + rise); ctx.lineTo(pa.x, pa.y);
      for (const [ex, ey] of ends) {
        const sides = along ? [[ex, -hd], [ex, hd]] : [[-hw, ey], [hw, ey]];
        for (const [sx, sy] of sides) { P2(sx, sy, z1); ctx.moveTo(pa.x, pa.y); P2(ex, ey, z1 + rise); ctx.lineTo(pa.x, pa.y); }
      }
      ctx.stroke();
      return;
    }
    if (b.use === 'Residential' && b.h >= 16 && b.h < 110 && ph > 28) {
      /* the Mumbai rooftop water tank: a short cylinder on legs */
      const r = Math.min(4.5, Math.sqrt(b.area) * 0.09) * scale, tz = z1 + 2.2 * zs, th2 = 3 * zs;
      const ox = cx + (seed - 0.5) * b.w * 0.3 * scale, oy = cy + (hq(b.tint, 3, 4) - 0.5) * b.d * 0.3 * scale;
      ctx.strokeStyle = 'rgba(170,244,255,' + (0.7 * a).toFixed(3) + ')'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const z of [tz, tz + th2]) for (let k = 0; k <= 10; k++) { const t = k / 10 * 6.283; proj(ox + Math.cos(t) * r, oy + Math.sin(t) * r, z, pa); k ? ctx.lineTo(pa.x, pa.y) : ctx.moveTo(pa.x, pa.y); }
      for (let k = 0; k < 4; k++) { const t = k / 4 * 6.283 + 0.4; proj(ox + Math.cos(t) * r * 0.8, oy + Math.sin(t) * r * 0.8, z1, pa); ctx.moveTo(pa.x, pa.y); proj(ox + Math.cos(t) * r * 0.8, oy + Math.sin(t) * r * 0.8, tz + th2, pb); ctx.lineTo(pb.x, pb.y); }
      ctx.stroke();
    }
    if (ph < 34) return;
    if (b.h > 120) {
      /* antenna mast with a blinking aviation light */
      const mh = Math.min(40, 8 + b.h * 0.08) * (z1 / Math.max(1, b.h));
      proj(cx, cy, z1, pa); proj(cx, cy, z1 + mh, pb);
      ctx.strokeStyle = 'rgba(190,246,255,' + (0.8 * a).toFixed(3) + ')'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      const on = Math.sin(holoPhase * 9 + seed * 6.28) > 0.2;
      ctx.fillStyle = 'rgba(255,70,80,' + ((on ? 0.95 : 0.28) * a).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(pb.x, pb.y, on ? 2.6 : 1.6, 0, 6.283); ctx.fill();
      dirty = true;
    }
    if (b.h > 90 && seed < 0.35 && b.area > 900) {
      /* helipad: a ring and an H */
      const r = Math.sqrt(b.area) * 0.22 * scale;
      ctx.strokeStyle = 'rgba(255,226,150,' + (0.75 * a).toFixed(3) + ')'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k <= 16; k++) { const th = k / 16 * 6.283; proj(cx + Math.cos(th) * r, cy + Math.sin(th) * r, z1 + 0.3, pa); k ? ctx.lineTo(pa.x, pa.y) : ctx.moveTo(pa.x, pa.y); }
      ctx.stroke();
      const hr = r * 0.45, c0 = Math.cos(b.rot), s0 = Math.sin(b.rot);
      const P2 = (lx, ly) => proj(cx + lx * c0 - ly * s0, cy + lx * s0 + ly * c0, z1 + 0.3, pa);
      ctx.beginPath();
      P2(-hr, -hr); ctx.moveTo(pa.x, pa.y); P2(-hr, hr); ctx.lineTo(pa.x, pa.y);
      P2(hr, -hr); ctx.moveTo(pa.x, pa.y); P2(hr, hr); ctx.lineTo(pa.x, pa.y);
      P2(-hr, 0); ctx.moveTo(pa.x, pa.y); P2(hr, 0); ctx.lineTo(pa.x, pa.y);
      ctx.stroke();
    } else if (b.h <= 90 && b.area > 1800) {
      /* rooftop plant room */
      const hw = b.w * 0.18 * scale, hd = b.d * 0.18 * scale, c0 = Math.cos(b.rot), s0 = Math.sin(b.rot), ph2 = 3.5 * (z1 / Math.max(1, b.h));
      const corner = (sx, sy, z) => proj(cx + sx * hw * c0 - sy * hd * s0, cy + sx * hw * s0 + sy * hd * c0, z, pa);
      ctx.strokeStyle = 'rgba(170,240,255,' + (0.6 * a).toFixed(3) + ')'; ctx.lineWidth = 1;
      ctx.beginPath();
      const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const z of [z1, z1 + ph2]) { cs.forEach(([sx, sy], k) => { corner(sx, sy, z); k ? ctx.lineTo(pa.x, pa.y) : ctx.moveTo(pa.x, pa.y); }); ctx.closePath(); }
      cs.forEach(([sx, sy]) => { corner(sx, sy, z1); ctx.moveTo(pa.x, pa.y); corner(sx, sy, z1 + ph2); ctx.lineTo(pa.x, pa.y); });
      ctx.stroke();
    }
  }

  /* Screen-space haze over the ground raster, strongest at the horizon. The
     raster has no depth of its own, so this stands in for aerial perspective. */
  function drawHaze() {
    const top = Math.max(0, Math.min(H, horizonY()));
    const span = Math.max(120, H * 0.62);
    const g = ctx.createLinearGradient(0, top, 0, top + span);
    const t = sun.day;
    const hr = mix(50, 136, t) | 0, hg = mix(64, 162, t) | 0, hb = mix(108, 192, t) | 0;
    g.addColorStop(0, 'rgba(' + hr + ',' + hg + ',' + hb + ',' + (0.58 - 0.34 * t).toFixed(2) + ')');
    g.addColorStop(0.26, 'rgba(' + hr + ',' + hg + ',' + hb + ',' + (0.27 - 0.17 * t).toFixed(2) + ')');
    g.addColorStop(0.60, 'rgba(' + hr + ',' + hg + ',' + hb + ',0.09)');
    g.addColorStop(1, 'rgba(' + hr + ',' + hg + ',' + hb + ',0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, top, W, span);
  }

  /* Anchored readout stalks. The canvas draws the mast and the ground mark;
     the shell positions a glass card at the projected top of each. */
  MT.HUD = [];
  function drawHudStalks() {
    if (!holo() || cam.dist > 17000) { MT.HUD.forEach(a => a.vis = false); return; }
    ctx.globalCompositeOperation = 'lighter';
    for (const a of MT.HUD) {
      proj(a.x, a.y, 0, pa); proj(a.x, a.y, a.z, pb);
      a.vis = pa.d > 400 && pb.x > 110 && pb.x < W - 110 && pb.y > 150 && pb.y < H - 90;
      if (!a.vis || a.expired) continue;
      a.sx = pb.x; a.sy = pb.y;
      ctx.strokeStyle = 'rgba(96,226,248,0.42)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.fillStyle = 'rgba(126,235,250,0.9)';
      ctx.beginPath(); ctx.arc(pa.x, pa.y, 2.6, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(126,235,250,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pa.x, pa.y, 7, 0, 6.283); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H * 0.5, Math.min(W, H) * 0.26,
                                       W / 2, H * 0.5, Math.max(W, H) * 0.76);
    g.addColorStop(0, 'rgba(3,4,13,0)');
    g.addColorStop(0.62, 'rgba(3,4,13,0.10)');
    g.addColorStop(1, 'rgba(3,4,13,' + (0.46 - 0.2 * sun.day).toFixed(2) + ')');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  /* ------------------------------------------------------------ main frame */
  let lastT = 0, fps = 0, lastMotion = 0;
  let spinLast = 0;
  /* Resilience: a fault in one frame must not freeze the twin. The error is
     reported once (console + MT.lastError), the canvas state is reset, and
     the next frame is drawn normally. */
  let frameErrs = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) { lastMotion = 0; return; }   // background tab: no drawing, no simulation step
    try { frameInner(t); }
    catch (err) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.setLineDash([]);
      if (frameErrs++ < 3) { console.error('[twin] frame error', err); MT.lastError = String(err && err.stack || err); }
      dirty = true;
    }
  }
  function frameInner(t) {
    if (MT.motion && MT.motion.on()) {
      const dt = lastMotion ? Math.min(0.2, (t - lastMotion) / 1000) : 0.016;
      lastMotion = t;
      MT.motion.update(dt);
      dirty = true;
    } else { lastMotion = 0; }
    if (anim) stepAnim(t);
    if (followFn && !anim) {
      const f = followFn();
      if (f) {
        cam.tx += (f.x - cam.tx) * 0.5; cam.ty += (f.y - cam.ty) * 0.5; cam.tz += (f.z - cam.tz) * 0.5;
        dirty = true;
      } else R.follow(null);
    }
    /* spin is authored per 60 Hz frame; scale by real elapsed time so the
       orbit stays even when a frame runs long */
    if (spin) {
      const sdt = spinLast ? Math.min(50, t - spinLast) : 16.67;
      cam.yaw += spin * sdt / 16.67; dirty = true; spinLast = t;
    } else spinLast = 0;
    if (MT.state.highlight && MT.state.highlight.points) dirty = true;
    if (!dirty) return;
    dirty = false;
    const t0m = performance.now();

    updateSun();
    updateCam();
    /* At overview zooms a real skyline is sub-pixel, so heights are stretched.
       The exact factor is shown in the readout so nothing is read off silently. */
    MT.state.vscale = 1 + Math.max(0, Math.min(1, (cam.dist - 6000) / 20000)) * 2.0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSky();
    holoPhase += 0.012;
    if (groundDirty) paintGround();
    if (holo()) drawSeaMesh();
    drawGround();
    if (holo()) { drawLandGrid(); drawCoastGlow(); }
    drawRunways();
    drawHaze();

    R.hoverAnchor = null;
    collect();
    if (!holo()) drawShadows(items);
    for (let i = 0; i < groundItems.length; i++) {
      const it = groundItems[i];
      if (it.t === 1) drawRoadEdge(it.e); else drawRailSeg(it.L);
    }
    for (let i = 0; i < deckItems.length; i++) drawBridgeBase(deckItems[i].e);
    if (MT.layerOn('roads')) for (const C of city.circles || []) drawCircle(C);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.t === 0) {
        if (it.f < 1) { ctx.globalAlpha = it.f; drawBuilding(it.b, it.d); ctx.globalAlpha = 1; }
        else drawBuilding(it.b, it.d);
      }
      else if (it.t === 1) drawRoadEdge(it.e);
      else if (it.t === 2) drawRailSeg(it.L);
      else if (it.t === 3) drawPlaced(it.p);
      else if (it.t === 4) {
        if (it.f !== undefined && it.f < 1) { ctx.globalAlpha = it.f; MT.motion.draw(it); ctx.globalAlpha = 1; }
        else MT.motion.draw(it);
      }
      else if (it.t === 5) drawTwin(it.tw, it.d);
      else if (it.t === 6) drawTower(it.T, it.d);
      else if (it.t === 7) drawTerminal(it.term, it.d);
      else if (it.t === 8) drawControlTower(it.twr, it.d);
      else if (it.t === 9) drawMonument(it.mon, it.d);
      else if (it.t === 10) drawPlatform(it.pf, it.d);
    }
    drawHudStalks();
    drawHighlight();
    drawODFlows();
    drawRoutes();
    if (!holo()) drawVignette();
    if (MT.motion) MT.motion.drawScreen();
    drawMeasure();
    drawAreaSel();
    drawMarkers();
    drawLabels();

    const dt = performance.now() - t0m;
    qAvg = qAvg ? qAvg * 0.92 + dt * 0.08 : dt;
    if (++qSince > 45) {                                // decide at most every ~45 drawn frames
      const was = qLevel;
      if (qAvg > 34 && qLevel < QUAL.length - 1) qLevel++;
      else if (qAvg < 14 && qLevel > 0) qLevel--;
      if (qLevel !== was) { qSince = 0; qAvg = 0; resize(); }
    }
    fps = fps ? fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1 : 1000 / Math.max(dt, 1);
    if (MT.onFrame) MT.onFrame({ ms: dt, items: items.length + groundItems.length });
    lastT = t;
  }

  /* --------------------------------------------------------------- camera */
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  R.flyTo = function (to, ms) {
    const from = { tx: cam.tx, ty: cam.ty, tz: cam.tz, dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch };
    const tgt = Object.assign({}, from, { tz: 0 }, to);   // back to the ground unless a height is asked for
    if (!to.keepFollow) R.follow(null);
    let dy = tgt.yaw - from.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    tgt.yaw = from.yaw + dy;
    if (ms === 0) {                       // an instant cut really is instant
      anim = null;
      cam.tx = tgt.tx; cam.ty = tgt.ty; cam.tz = tgt.tz; cam.dist = tgt.dist; cam.yaw = tgt.yaw; cam.pitch = tgt.pitch;
      dirty = true; return;
    }
    anim = { from, tgt, t0: performance.now(), ms: ms == null ? 1100 : ms };
    dirty = true;
  };
  function stepAnim(t) {
    const a = anim, k = Math.min(1, (performance.now() - a.t0) / a.ms), e = ease(k);
    for (const key of ['tx', 'ty', 'tz', 'dist', 'yaw', 'pitch']) cam[key] = a.from[key] + (a.tgt[key] - a.from[key]) * e;
    dirty = true;
    if (k >= 1) anim = null;
  }
  /* Read-only window into the renderer for the motion module: the same
     projection, focal length and fog the rest of the scene uses. */
  R.internals = {
    proj: (x, y, z, out) => proj(x, y, z, out),
    fogAmt: d => fogAmt(d), fogged: (r, g, b, f) => fogged(r, g, b, f),
    get ctx() { return ctx; }, get focal() { return focal; },
    get W() { return W; }, get H() { return H; },
    /* half-width of the drawn carriageway, so vehicles keep to their side of it */
    roadHalf: cls => RW(cls) * 0.85 / 2
  };

  R.setSpin = v => { spin = v; dirty = true; };
  R.setOffsetFrac = (fx, fy) => { offFX = fx; offFY = fy; dirty = true; };
  R.zoom = f => {
    cam.dist = Math.max(cam.minDist, Math.min(cam.maxDist, cam.dist * f));
    if (!followFn && cam.dist >= 190) cam.minDist = 190;       // normal limit returns once clear
    dirty = true;
  };
  R.setPitch = p => { cam.pitch = Math.max(0.12, Math.min(1.52, p)); dirty = true; };
  R.is2D = () => cam.pitch > 1.40;

  /* ---------------------------------------------------------------- input */
  function bindInput() {
    let drag = null;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      const orbit = e.button === 2 || e.button === 1 || e.shiftKey || e.altKey;
      drag = { x: e.clientX, y: e.clientY, orbit, moved: 0, t: Date.now() };
      spin = 0;
    });
    canvas.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      const hx = e.clientX - r.left, hy = e.clientY - r.top;
      if (MT.onHover) MT.onHover(R.unproject(hx, hy), hx, hy, !!(drag && drag.moved > 4));
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (followFn && !drag.orbit && drag.moved > 6) {      // a pan means "let go of the aircraft"
        R.follow(null);                                        // the view stays where it is
        if (MT.onFollowEnd) MT.onFollowEnd();
      }
      if (drag.orbit) {
        cam.yaw -= dx * 0.005;
        R.setPitch(cam.pitch - dy * 0.005);
      } else {
        const s = cam.dist / focal;
        const ex = -dx * s, ey = dy * s / Math.max(0.25, Math.sin(cam.pitch));
        cam.tx += ex * ca + ey * sa;
        cam.ty += -ex * sa + ey * ca;
      }
      drag.x = e.clientX; drag.y = e.clientY;
      anim = null; dirty = true;
    });
    canvas.addEventListener('pointerup', e => {
      if (drag && drag.moved < 6 && Date.now() - drag.t < 500) {
        const r = canvas.getBoundingClientRect();
        if (MT.onClick) MT.onClick(e.clientX - r.left, e.clientY - r.top, e);
      }
      drag = null;
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      R.zoom(Math.exp(e.deltaY * 0.0014));
      anim = null;
    }, { passive: false });

    // pinch
    let pinch = null;
    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && pinch) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        R.zoom(pinch / d); pinch = d;
      }
    }, { passive: true });
    canvas.addEventListener('touchend', () => { pinch = null; }, { passive: true });
  }

  /* -------------------------------------------------------------- picking */
  /* Picks against the whole drawn prism — roof and every side, at the
     exaggerated display height — so a tall tower is hit anywhere along its
     facade, not only on its roof. The hit nearest the camera wins. */
  const pkB = [], pkT = [];
  for (let i = 0; i < 12; i++) { pkB.push(P()); pkT.push(P()); }
  const pkQ = [null, null, null, null];
  R.pickBuilding = function (sx, sy) {
    if (!MT.layerOn('buildings') || !MT.state.showBuildings) return null;
    const vs = MT.state.vscale || 1, yr = MT.state.year;
    let best = null, bestD = Infinity;
    /* search along the view ray, not just around the ground point — the
       cursor may be over the upper floors of a tower whose base is further up
       the screen */
    const seen = new Set();
    for (let t = 0; t <= 1.0001; t += 0.25) {
      const w = R.unproject(sx, sy + t * H * 0.35);
      if (!w) continue;
      for (const c of city.buildingIndex.within(w.x, w.y, 520)) {
        const b = c.item;
        if (seen.has(b)) continue; seen.add(b);
        if (b.year > yr) continue;
        const h = b.h * vs, poly = b.poly, n = poly.length / 2;
        const cr = Math.cos(b.rot), sr = Math.sin(b.rot);
        let bad = false;
        for (let i = 0; i < n; i++) {
          const lx = poly[i * 2], ly = poly[i * 2 + 1];
          const x = b.x + lx * cr - ly * sr, y = b.y + lx * sr + ly * cr;
          proj(x, y, 0, pkB[i]); proj(x, y, h, pkT[i]);
          if (pkB[i].d < 150) { bad = true; break; }
        }
        if (bad) continue;
        const d = pkB[0].d;
        if (d >= bestD) continue;
        let hit = pointInPoly(sx, sy, pkT.slice(0, n));
        for (let i = 0; i < n && !hit; i++) {
          const j = (i + 1) % n;
          pkQ[0] = pkB[i]; pkQ[1] = pkB[j]; pkQ[2] = pkT[j]; pkQ[3] = pkT[i];
          hit = pointInPoly(sx, sy, pkQ);
        }
        if (hit) { best = b; bestD = d; }
      }
    }
    return best;
  };
  function pointInPoly(px, py, q) {
    let inside = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      if ((q[i].y > py) !== (q[j].y > py) &&
          px < (q[j].x - q[i].x) * (py - q[i].y) / (q[j].y - q[i].y) + q[i].x) inside = !inside;
    }
    return inside;
  }
  R.pickPlace = (sx, sy) => {
    for (let i = placeHits.length - 1; i >= 0; i--) { const h = placeHits[i]; if (sx >= h.x0 - 3 && sx <= h.x1 + 3 && sy >= h.y0 - 3 && sy <= h.y1 + 3) return h.q; }
    return null;
  };
  R.pickMarker = function (sx, sy) {
    const sets = [];
    if (MT.layerOn('hospitals')) sets.push(city.hospitals);
    if (MT.layerOn('fire')) sets.push(city.fire);
    if (MT.layerOn('stations')) sets.push(city.metroStations, city.railStations);
    if (MT.layerOn('landmarks')) sets.push(city.landmarks);
    if (MT.layerOn('projects')) sets.push(city.projects);
    if (MT.layerOn('banks')) sets.push(city.banks);
    if (MT.layerOn('schools')) sets.push(city.schools);
    if (MT.layerOn('police')) sets.push(city.police);
    let best = null, bd = 13;
    for (const s of sets) for (const p of s) {
      proj(p.x, p.y, 0, pa);
      if (pa.d < 150) continue;
      const d = Math.hypot(pa.x - sx, pa.y - sy);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  R.pickRoad = function (sx, sy) {
    const w = R.unproject(sx, sy);
    if (!w) return null;
    /* tolerance is ~12 screen pixels, not a fixed 260 m that balloons when
       zoomed in; and only roads that are actually drawn can be hit (audit #10) */
    const w2 = R.unproject(sx + 12, sy);
    const tol = w2 ? Math.max(15, Math.min(400, Math.hypot(w2.x - w.x, w2.y - w.y))) : 120;
    const roadsOn = MT.layerOn('roads'), bridgesOn = MT.layerOn('bridges');
    const g = city.graph;
    let best = null, bd = tol;
    for (const e of g.edges) {
      if (e.road < 0) continue;
      if (e.cls === 'bridge' ? !bridgesOn : !roadsOn) continue;
      const d = geo.distToSeg(w.x, w.y, g.nodes[e.a].x, g.nodes[e.a].y, g.nodes[e.b].x, g.nodes[e.b].y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };

  R.scaleBar = function () {
    const w0 = R.unproject(W * 0.5 - 50, H * 0.82), w1 = R.unproject(W * 0.5 + 50, H * 0.82);
    if (!w0 || !w1) return { px: 100, label: '—' };
    const m = Math.hypot(w1.x - w0.x, w1.y - w0.y);
    const nice = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    let pick = nice[0];
    for (const n of nice) if (n <= m * 1.4) pick = n;
    return { px: Math.round(100 * pick / m), label: geo.fmtDist(pick) };
  };
})(window.MT);
