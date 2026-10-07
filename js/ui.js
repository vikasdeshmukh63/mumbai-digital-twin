/* ============================================================================
   ui.js — application shell: navigation, panels, tools, scenarios, reports.
   ========================================================================== */
(function (MT) {
  'use strict';
  const geo = MT.geo, city = MT.city, sim = MT.sim, R = MT.render, S = MT.state;
  const ui = MT.ui = {};
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n0 = v => Math.round(v).toLocaleString('en-IN');
  const n1 = v => v.toFixed(1);
  const n2 = v => v.toFixed(2);

  /* ------------------------------------------------------------------ nav */
  const ICON = {
    explore: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
    layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/>',
    analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    simulation: '<path d="M4 14c2-3 4-3 6 0s4 3 6 0 4-3 4-3"/><path d="M4 19c2-3 4-3 6 0s4 3 6 0 4-3 4-3"/><circle cx="12" cy="6" r="2.5"/>',
    ai: '<rect x="4" y="6" width="16" height="12" rx="3"/><path d="M9 11v2M15 11v2M12 3v3"/>',
    infrastructure: '<path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/>',
    projects: '<path d="M3 20h18"/><path d="M6 20V9l5-4 5 4v11"/><path d="M16 20v-6h4v6"/>',
    alerts: '<path d="M12 4a6 6 0 0 0-6 6v4l-2 3h16l-2-3v-4a6 6 0 0 0-6-6Z"/><path d="M10 20h4"/>',
    reports: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    admin: '<circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    logout: '<path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10"/><path d="M15 8l4 4-4 4M19 12H9"/>'
  };
  const NAV = [
    ['explore', 'Explore'], ['layers', 'Layers'], ['analytics', 'Analytics'],
    ['simulation', 'Simulation'], ['ai', 'Mumbai AI'], ['infrastructure', 'Infra'],
    ['projects', 'Projects'], ['alerts', 'Alerts'], ['reports', 'Reports'],
    ['data', 'Data'], ['admin', 'Admin']
  ];
  const TITLES = {
    explore: 'Explore', layers: 'City layers', analytics: 'Urban analytics',
    simulation: 'Simulation centre', ai: 'Mumbai AI', infrastructure: 'Infrastructure',
    projects: 'Infrastructure projects', alerts: 'Alerts', reports: 'Reports',
    data: 'Data governance', admin: 'Administration'
  };
  let active = 'explore';

  $('#rail').innerHTML = NAV.map(([id, label]) =>
    `<button data-nav="${id}" title="${TITLES[id]}">
       <svg viewBox="0 0 24 24">${ICON[id]}</svg><span>${label}</span>
       ${id === 'alerts' ? `<i class="badge">${MT.ALERTS.length}</i>` : ''}
     </button>`).join('') +
    `<i class="rail-sep" aria-hidden="true"></i>
     <button id="railLogout" class="logout" title="Log out — end this session and return to the start page">
       <svg viewBox="0 0 24 24">${ICON.logout}</svg><span>Log out</span>
     </button>`;

  $('#mobileTabs').innerHTML = ['explore', 'layers', 'simulation', 'ai', 'data'].map(id =>
    `<button data-nav="${id}"><svg viewBox="0 0 24 24">${ICON[id]}</svg><span>${TITLES[id].split(' ')[0]}</span></button>`).join('') +
    /* phones have no rail, so the tab bar carries the way out */
    `<button id="mobileLogout" class="logout" title="Log out"><svg viewBox="0 0 24 24">${ICON.logout}</svg><span>Log out</span></button>`;

  function setPane(id, fromNav) {
    const same = active === id && !$('#panel').classList.contains('hidden');
    if (same && fromNav) { $('#panel').classList.add('hidden'); markNav(null); R.invalidate(); return; }
    active = id;
    $('#panel').classList.remove('hidden');
    $('#panelTitle').textContent = TITLES[id];
    $$('#panelBody .pane').forEach(p => p.hidden = p.dataset.pane !== id);
    markNav(id);
    if (BUILD[id]) BUILD[id]();
    $('#panelBody').scrollTop = 0;
  }
  function markNav(id) {
    $$('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === id));
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-nav]');
    if (b) setPane(b.dataset.nav, true);
  });
  ui.setPane = setPane;
  ui.flyToExtent = () => R.flyTo(VIEWS[0][1], 1300);

  /* --------------------------------------------------------------- toasts */
  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
  }
  ui.toast = toast;

  /* ==================================================== EXPLORE ========== */
  const VIEWS = [
    ['Whole region (MMR)', { tx: geo.x(72.985), ty: geo.y(19.205), dist: 118000, pitch: 0.95, yaw: -0.22 }],
    ['Greater Mumbai', { tx: geo.x(72.893), ty: geo.y(19.078), dist: 36000, pitch: 0.86, yaw: -0.42 }],
    ['Island City', { tx: geo.x(72.833), ty: geo.y(18.975), dist: 12000, pitch: 0.72, yaw: -0.10 }],
    ['Western suburbs', { tx: geo.x(72.848), ty: geo.y(19.14), dist: 15000, pitch: 0.78, yaw: -0.22 }],
    ['Eastern suburbs', { tx: geo.x(72.915), ty: geo.y(19.10), dist: 15000, pitch: 0.78, yaw: 0.20 }],
    ['Mira–Bhayandar', { tx: geo.x(72.860), ty: geo.y(19.290), dist: 11000, pitch: 0.70, yaw: -0.15 }],
    ['Vasai–Virar', { tx: geo.x(72.835), ty: geo.y(19.410), dist: 16000, pitch: 0.74, yaw: -0.25 }],
    ['Thane & Ghodbunder', { tx: geo.x(72.970), ty: geo.y(19.225), dist: 14000, pitch: 0.72, yaw: 0.25 }],
    ['Kalyan–Dombivli', { tx: geo.x(73.115), ty: geo.y(19.225), dist: 16000, pitch: 0.74, yaw: 0.10 }],
    ['Navi Mumbai', { tx: geo.x(73.020), ty: geo.y(19.075), dist: 17000, pitch: 0.74, yaw: 0.30 }],
    ['Atal Setu & Panvel', { tx: geo.x(72.995), ty: geo.y(18.990), dist: 22000, pitch: 0.70, yaw: -0.05 }],
    ['BKC & Mithi corridor', { tx: geo.x(72.862), ty: geo.y(19.058), dist: 5200, pitch: 0.62, yaw: -0.35 }],
    ['Sea Link & Worli', { tx: geo.x(72.820), ty: geo.y(19.025), dist: 5200, pitch: 0.48, yaw: 0.42 }],
    ['Sanjay Gandhi NP', { tx: geo.x(72.905), ty: geo.y(19.215), dist: 13000, pitch: 0.70, yaw: 0.10 }],
    ['Top-down region plan', { tx: geo.x(72.990), ty: geo.y(19.170), dist: 135000, pitch: 1.50, yaw: 0 }]
  ];

  const BUILD = {};
  BUILD.explore = function () {
    const p = $('[data-pane=explore]');
    p.innerHTML = `
      <div class="sec">
        <h3>Camera presets</h3>
        <div class="btnrow">${VIEWS.map((v, i) => `<button class="btn" data-view="${i}">${esc(v[0])}</button>`).join('')}</div>
      </div>
      ${(city.twins || []).length ? `<div class="sec">
        <h3>Building twins <span class="tag sim">demo</span></h3>
        <div class="btnrow">${city.twins.map((t, i) => `<button class="btn twin" data-twin="${i}"><i class="tw-dot"></i>${esc(t.area)}</button>`).join('')}</div>
        <p class="note sim">Five illustrative buildings drawn at building level: floors, service risers, roof and basement plant. Not real buildings.</p>
      </div>` : ''}
      <div class="sec">
        <h3>Jump to an area</h3>
        ${[...new Set(city.localities.map(l => l.sector))].map(sec => `
          <div class="loc-sec">${esc(sec)}</div>
          <div class="btnrow">${city.localities.filter(l => l.sector === sec).map(l => `<button class="btn" data-loc="${esc(l.name)}">${esc(l.name)}</button>`).join('')}</div>`).join('')}
      </div>
      <div class="sec">
        <h3>City at a glance</h3>
        <div class="tiles">
          <div class="tile acc"><div class="l">Structures modelled</div><div class="v">${n0(city.buildings.length)}</div><div class="u">simulated</div></div>
          <div class="tile"><div class="l">Arterial network</div><div class="v">${n0(city.roadKm)}</div><div class="u">km modelled</div></div>
          <div class="tile"><div class="l">Station records</div><div class="v">${city.stations.length}</div><div class="u">rail + metro</div></div>
          <div class="tile"><div class="l">Analysis zones</div><div class="v">${city.zones.length}</div><div class="u">demo partition</div></div>
        </div>
        <p class="note sim">Zones are nearest-centroid partitions around locality centres. They are <strong>not</strong> BMC ward boundaries and must not be used as such.</p>
      </div>
      <div class="sec">
        <h3>How to move</h3>
        <p class="note">Drag to pan · right-drag or shift-drag to orbit · scroll to zoom · click a building, station or road to inspect it. Measurement and area-selection tools sit at the top right of the viewport.</p>
      </div>`;
    p.querySelectorAll('[data-view]').forEach(b => b.onclick = () => R.flyTo(VIEWS[+b.dataset.view][1], 1300));
    p.querySelectorAll('[data-twin]').forEach(b => b.onclick = () => flyToTwin(city.twins[+b.dataset.twin]));
    p.querySelectorAll('[data-loc]').forEach(b => b.onclick = () => {
      const l = city.localities.find(x => x.name === b.dataset.loc);
      R.flyTo({ tx: l.x, ty: l.y, dist: 6200, pitch: 0.75 }, 1200);
      showZone(city.zones.findIndex(z => z.name === l.name));
    });
  };

  /* ==================================================== LAYERS =========== */
  const SWATCH = {
    land: '#1E2E3C', satellite: '#4A5B55', terrain: '#6A7C66', buildings: '#8A97AA',
    roads: '#4B5E77', bridges: '#5C7590', rail: '#EDAE45', metro: '#3FD3E6',
    stations: '#96E9F7', airport: '#C9D6E8', water: '#14486E', green: '#1D4A2C',
    floodzone: '#3C8EE8', rain: '#7FA8E8',
    traffic_flow: '#D8E4F2', trains: '#EDAE45', aircraft: '#8B7BF0', vessels: '#C4CCF8',
    isochrone: '#3FBE84', odflows: '#8B7BF0', hospitals: '#EC5F70', fire: '#EE7F45',
    police: '#8B7BF0', schools: '#8B9ECF', landmarks: '#C9D6E8', utility: '#555',
    projects: '#77E4AE', proposed: '#77E4AE', congestion: '#EC5F70',
    lowlying: '#7A5CD0', coastal: '#C8A45A', access: '#EE7F45'
  };
  const SURFACES = [
    ['relief', 'Terrain relief'], ['density', 'Density (simulated)'], ['floodrisk', 'Baseline flood risk'],
    ['zones', 'Analysis zones'], ['heat', 'Heat pattern (illustrative)'], ['air', 'Air pattern (illustrative)']
  ];

  BUILD.layers = function () {
    const p = $('[data-pane=layers]');
    const groups = {};
    MT.LAYERS.forEach(l => (groups[l.g] = groups[l.g] || []).push(l));
    const mc = MT.motion ? MT.motion.config : null;
    p.innerHTML = (mc ? `
      <div class="sec">
        <h3>Live motion <span class="tag sim">simulated</span></h3>
        <label class="layer" style="grid-template-columns:auto 1fr auto">
          <span class="sw" style="background:#D8E4F2"></span>
          <span class="nm">Animate the city</span>
          <span class="toggle${mc.on ? ' on' : ''}" id="mOn" role="switch" aria-checked="${mc.on}" tabindex="0"></span>
        </label>
        <div class="field">
          <label for="mDensity">Agent density <b><span id="mDensityV">${mc.density.toFixed(1)}</span>×</b></label>
          <input type="range" id="mDensity" min="0.2" max="2" step="0.1" value="${mc.density}">
        </div>
        <div class="field">
          <label for="mSpeed">Clock rate <b><span id="mSpeedV">${mc.speed}</span>× real time</b></label>
          <input type="range" id="mSpeed" min="1" max="12" step="1" value="${mc.speed}">
        </div>
        <p class="note sim" id="mCounts"></p>
        <p class="note">Road agents take their speed from the traffic assignment, so congested corridors visibly crawl and a closed link empties. Train cores are coloured by an <strong>assumed</strong> crowding pattern — two commuting peaks, a strong peak direction, heaviest on the approach to the island city — because no ticketing or occupancy feed exists. Aircraft and vessels run fixed headways. <strong>No ADS-B, AIS, GPS or signalling feed is connected</strong>: nothing here is a real movement, and no callsign or vessel name is shown.</p>
      </div>` : '') + `
      <div class="sec">
        <h3>Ground surface</h3>
        <div class="field"><select id="surfSel">${SURFACES.map(([v, t]) =>
          `<option value="${v}"${S.surface === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>` +
      Object.entries(groups).map(([g, ls]) => `
      <div class="sec"><h3>${esc(g)}</h3>${ls.map(l => {
        const st = S.layers[l.id], d = MT.DATASETS.find(x => x.id === l.ds) || {};
        return `<div class="layer${l.disabled ? ' disabled' : ''}" data-layer="${l.id}">
          <span class="sw" style="background:${SWATCH[l.id] || '#666'}"></span>
          <span class="nm${st.on ? '' : ' off'}" title="${esc(d.name || '')} — ${esc(d.note || '')}">${esc(l.label)}</span>
          <span class="toggle${st.on ? ' on' : ''}" role="switch" aria-checked="${st.on}" tabindex="0"></span>
          <span class="op"><input type="range" min="0.15" max="1" step="0.05" value="${st.opacity}" aria-label="${esc(l.label)} opacity"></span>
          <span class="op" style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--txt-4);margin-top:-6px">
            <span>${esc((d.name || '—'))}</span><span class="tag ${d.status || 'missing'}">${d.status || 'n/a'}</span></span>
          <span class="op" style="font-size:9.5px;color:var(--txt-4);margin-top:-3px">Updated ${esc(d.updated || '—')}</span>
        </div>`;
      }).join('')}</div>`).join('') + `
      <p class="note warn">Opacity here controls whether a layer is drawn and how strongly. Layers backed by a <strong>missing</strong> dataset cannot be enabled — the platform will not draw a layer it has no data for.</p>`;

    $('#surfSel').onchange = e => { S.surface = e.target.value; R.markGround(); buildLegend(); };
    if (mc) {
      const counts = () => {
        const c = MT.motion.counts();
        $('#mCounts').innerHTML = `Currently simulating <strong>${n0(c.vehicles)}</strong> road agents, `
          + `<strong>${c.trains}</strong> train sets, <strong>${c.aircraft}</strong> aircraft and `
          + `<strong>${c.vessels}</strong> vessels.`;
      };
      counts(); setTimeout(counts, 2600);
      const mt = $('#mOn');
      const flip = () => {
        mc.on = !mc.on; mt.classList.toggle('on', mc.on); mt.setAttribute('aria-checked', mc.on);
        MT.motion.resync(); R.invalidate(); setTimeout(counts, 120);
      };
      mt.onclick = flip;
      mt.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
      $('#mDensity').oninput = e => {
        mc.density = +e.target.value; $('#mDensityV').textContent = mc.density.toFixed(1);
        MT.motion.resync(); setTimeout(counts, 200);
      };
      $('#mSpeed').oninput = e => { mc.speed = +e.target.value; $('#mSpeedV').textContent = mc.speed; };
    }
    p.querySelectorAll('[data-layer]').forEach(row => {
      const id = row.dataset.layer, spec = MT.LAYERS.find(l => l.id === id);
      const tog = row.querySelector('.toggle'), rng = row.querySelector('input[type=range]');
      const flip = () => {
        if (spec.disabled) { toast('No dataset bound for this layer.'); return; }
        S.layers[id].on = !S.layers[id].on;
        tog.classList.toggle('on', S.layers[id].on);
        tog.setAttribute('aria-checked', S.layers[id].on);
        row.querySelector('.nm').classList.toggle('off', !S.layers[id].on);
        R.markGround(); buildLegend();
      };
      tog.onclick = flip;
      tog.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
      rng.oninput = e => { S.layers[id].opacity = +e.target.value; R.markGround(); };
    });
  };

  /* ==================================================== ANALYTICS ======== */
  const METRICS = [
    ['densityIndex', 'Density index (sim)', v => n2(v)],
    ['builtPct', 'Built-up share', v => n1(v) + '%'],
    ['roadDensity', 'Road density', v => n1(v) + ' km/km²'],
    ['transitPct', 'Within 800 m of a station', v => n0(v) + '%'],
    ['metroPct', 'Within 1 km of metro', v => n0(v) + '%'],
    ['greenPct', 'Green cover', v => n1(v) + '%'],
    ['lowPct', 'Land below 4 m', v => n0(v) + '%'],
    ['meanElev', 'Mean elevation', v => n1(v) + ' m'],
    ['buildings', 'Structures', v => n0(v)],
    ['hospitals', 'Hospitals', v => n0(v)],
    ['floodPct', 'Flooded in current scenario', v => v === null ? '—' : n0(v) + '%']
  ];
  let metric = 'transitPct';

  BUILD.analytics = function () {
    const p = $('[data-pane=analytics]');
    const rows = sim.zoneTable();
    const totalBuilt = city.builtArea / 1e6;
    p.innerHTML = `
      <div class="sec">
        <h3>City totals</h3>
        <div class="tiles">
          <div class="tile"><div class="l">Built-up area</div><div class="v">${n1(totalBuilt)}</div><div class="u">km² footprint (sim)</div></div>
          <div class="tile"><div class="l">Arterial road</div><div class="v">${n0(city.roadKm)}</div><div class="u">km modelled</div></div>
          <div class="tile"><div class="l">Mean transit access</div><div class="v">${n0(rows.reduce((s, r) => s + r.transitPct, 0) / rows.length)}</div><div class="u">% of land</div></div>
          <div class="tile"><div class="l">Population</div><div class="v" style="font-size:12px;color:var(--crit)">DATA SOURCE REQUIRED</div><div class="u">no census bound</div></div>
        </div>
      </div>
      <div class="sec">
        <h3>Compare zones</h3>
        <div class="field"><select id="metricSel">${METRICS.map(([k, l]) =>
          `<option value="${k}"${k === metric ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="bars" id="metricBars"></div>
      </div>
      <div class="sec">
        <h3>Zone table</h3>
        <div class="scrollx"><table class="data" id="zoneTable">
          <thead><tr><th>Zone</th><th>km²</th><th>Struct.</th><th>Transit</th><th>Green</th><th>&lt;4 m</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr class="clickable" data-z="${i}">
            <td>${esc(r.name)}</td><td>${n1(r.areaKm2)}</td><td>${n0(r.buildings)}</td>
            <td>${n0(r.transitPct)}%</td><td>${n1(r.greenPct)}%</td><td>${n0(r.lowPct)}%</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <p class="note sim">Every figure derives from generalised reference geometry and a synthetic building, terrain and density model. Use for relative comparison between zones, never as a measurement of Mumbai.</p>`;

    const drawBars = () => {
      const def = METRICS.find(m => m[0] === metric);
      const list = rows.map(r => ({ name: r.name, v: r[metric] === null ? 0 : r[metric], raw: r[metric] }))
        .sort((a, b) => b.v - a.v);
      const max = Math.max(...list.map(x => x.v)) || 1;
      $('#metricBars').innerHTML = list.map(x => {
        const pct = x.v / max * 100;
        const cls = pct > 78 ? 'c4' : pct > 55 ? 'c3' : pct > 32 ? 'c2' : 'c1';
        return `<div class="bar ${cls}"><button class="n" data-zn="${esc(x.name)}">${esc(x.name)}</button>
          <span class="v">${def[2](x.raw)}</span><span class="t"><i style="width:${pct}%"></i></span></div>`;
      }).join('');
      $('#metricBars').querySelectorAll('[data-zn]').forEach(b => b.onclick = () => {
        showZone(city.zones.findIndex(z => z.name === b.dataset.zn), true);
      });
    };
    drawBars();
    $('#metricSel').onchange = e => { metric = e.target.value; drawBars(); };
    p.querySelectorAll('#zoneTable tr[data-z]').forEach(tr => tr.onclick = () => showZone(+tr.dataset.z, true));
  };

  /* ==================================================== INFRASTRUCTURE === */
  BUILD.infrastructure = function () {
    const p = $('[data-pane=infrastructure]');
    const sets = [
      ['Hospitals', city.hospitals, 'limited', 'Major facilities, approximate positions, not exhaustive'],
      ['Fire stations', city.fire, 'limited', 'Indicative subset'],
      ['Metro stations', city.metroStations, 'limited', 'Includes alignments under construction'],
      ['Railway stations', city.railStations, 'limited', 'Western, Central and Harbour lines'],
      ['Landmarks & gateways', city.landmarks, 'limited', 'Airport, ports, business districts'],
      ['Schools', city.schools, 'sim', 'SIMULATED point set — no verified register connected'],
      ['Police posts', city.police, 'sim', 'SIMULATED point set — no verified register connected']
    ];
    p.innerHTML = sets.map(([name, list, st, note], gi) => `
      <div class="sec"><h3>${esc(name)} <span class="tag ${st}">${st}</span></h3>
        <p class="note ${st === 'sim' ? 'sim' : ''}">${esc(note)} · <strong>${list.length}</strong> records</p>
        <div class="scrollx"><table class="data"><tbody>${list.slice(0, 24).map((h, i) =>
          `<tr class="clickable" data-set="${gi}" data-i="${i}"><td>${esc(h.name)}</td>
           <td style="text-align:right;color:var(--txt-4)">${esc(h.area || h.line || h.kind || '')}</td></tr>`).join('')}
        </tbody></table></div>
        ${list.length > 24 ? `<p class="note">Showing 24 of ${list.length}. Use search to reach the rest.</p>` : ''}
      </div>`).join('');
    p.querySelectorAll('tr[data-set]').forEach(tr => tr.onclick = () => {
      const item = sets[+tr.dataset.set][1][+tr.dataset.i];
      R.flyTo({ tx: item.x, ty: item.y, dist: 2600, pitch: 0.62 }, 1100);
      selectPoint(item);
    });
  };

  /* ==================================================== PROJECTS ========= */
  BUILD.projects = function () {
    const p = $('[data-pane=projects]');
    const STATUS_COLOR = { 'Operational': 'verified', 'Under Construction': 'limited', 'Planned': 'sim', 'Commissioning': 'limited', 'Completed': 'verified', 'Proposed': 'sim' };
    p.innerHTML = `
      <p class="note warn">Compiled from public announcements and reporting — <strong>not</strong> an agency feed. Verify status and dates with the delivering agency before citing.</p>` +
      city.projects.map((pr, i) => `
      <div class="sec">
        <h3>${esc(pr.type)} <span class="tag ${STATUS_COLOR[pr.status] || 'sim'}">${esc(pr.status)}</span></h3>
        <button class="btn wide" data-prj="${i}" style="justify-content:flex-start;text-align:left;height:auto;padding:8px 10px;white-space:normal">${esc(pr.name)}</button>
        <dl class="kv">
          <dt>Agency</dt><dd class="txt">${esc(pr.agency)}</dd>
          <dt>Start</dt><dd>${esc(pr.start)}</dd>
          <dt>Completion</dt><dd>${esc(pr.end)}</dd>
        </dl>
        <p class="note">${esc(pr.desc)}</p>
        <p class="note">Affected areas: ${esc(pr.affects)}</p>
      </div>`).join('');
    p.querySelectorAll('[data-prj]').forEach(b => b.onclick = () => {
      const pr = city.projects[+b.dataset.prj];
      R.flyTo({ tx: pr.x, ty: pr.y, dist: 8000, pitch: 0.7 }, 1200);
      selectPoint(pr);
    });
  };

  /* ==================================================== ALERTS =========== */
  BUILD.alerts = function () {
    const p = $('[data-pane=alerts]');
    const SEV = { critical: 'crit', warning: 'warn', info: '' };
    p.innerHTML = `<p class="note crit">Every alert below is <strong>scenario-derived</strong>. No live monitoring feed is connected, so nothing here reflects current conditions in Mumbai.</p>` +
      MT.ALERTS.map(a => `
        <div class="sec"><h3>${esc(a.sev)}</h3>
          <div class="note ${SEV[a.sev]}"><strong>${esc(a.title)}</strong><br>${esc(a.body)}<br>
          <span style="color:var(--txt-4)">Source: ${esc(a.src)}</span></div>
        </div>`).join('') + `
      <div class="sec"><h3>Alerting architecture</h3>
        <p class="note">In production, alert rules bind to live sources — rain gauges, tide gauges, traffic feeds, IoT sensors — and each firing alert carries the source, the threshold it crossed, and the observation timestamp. Until those sources exist, this panel only ever surfaces model output.</p>
      </div>`;
  };

  /* ==================================================== DATA ============= */
  BUILD.data = function () {
    const p = $('[data-pane=data]');
    const counts = { verified: 0, limited: 0, sim: 0, missing: 0 };
    MT.DATASETS.forEach(d => counts[d.status]++);
    p.innerHTML = `
      <div class="sec">
        <h3>Source register</h3>
        <div class="tiles">
          <div class="tile good"><div class="l">Verified</div><div class="v">${counts.verified}</div><div class="u">signed sources</div></div>
          <div class="tile warn"><div class="l">Limited</div><div class="v">${counts.limited}</div><div class="u">generalised</div></div>
          <div class="tile"><div class="l">Simulation</div><div class="v" style="color:var(--sim)">${counts.sim}</div><div class="u">generated</div></div>
          <div class="tile crit"><div class="l">Missing</div><div class="v">${counts.missing}</div><div class="u">not connected</div></div>
        </div>
        <p class="note crit"><strong>Zero verified sources are connected.</strong> That is the honest state of this build, and it is shown on every screen rather than hidden. Analyses that need a missing dataset are refused, not estimated.</p>
      </div>` +
      MT.DATASETS.map(d => `
        <div class="sec">
          <h3><span class="tag ${d.status}">${d.status}</span> ${esc(d.name)}</h3>
          <dl class="kv">
            <dt>Source</dt><dd class="txt">${esc(d.source)}</dd>
            <dt>Owner</dt><dd class="txt">${esc(d.owner)}</dd>
            <dt>Licence</dt><dd class="txt">${esc(d.license)}</dd>
            <dt>Updated</dt><dd>${esc(d.updated)}</dd>
            <dt>Version</dt><dd>${esc(d.version)}</dd>
            <dt>Frequency</dt><dd class="txt">${esc(d.freq)}</dd>
            <dt>Accuracy</dt><dd class="txt">${esc(d.accuracy)}</dd>
            <dt>Coverage</dt><dd class="txt">${esc(d.coverage)}</dd>
          </dl>
          <p class="note ${d.status === 'missing' ? 'crit' : d.status === 'sim' ? 'sim' : ''}">${esc(d.note)}</p>
        </div>`).join('') + `
      <div class="sec"><h3>Real-time integration contract</h3>
        <p class="note">Any source bound later must declare source, dataset, timestamp, update frequency, licence and data quality before the platform will render it. A source that cannot declare those fields stays unbound.</p>
      </div>`;
  };

  /* ==================================================== ADMIN ============ */
  BUILD.admin = function () {
    const p = $('[data-pane=admin]');
    p.innerHTML = `
      <div class="sec">
        <h3>Active role</h3>
        <div class="field"><select id="roleSel">${MT.ROLES.map(r =>
          `<option${r.role === $('#roleName').textContent ? ' selected' : ''}>${r.role}</option>`).join('')}</select></div>
        <div id="roleCaps"></div>
      </div>
      <div class="sec"><h3>Security posture</h3>
        <ul style="margin:0;padding-left:16px;font-size:11.5px;color:var(--txt-2);line-height:1.6">
          <li>No API keys in client code — all third-party calls proxy through the backend.</li>
          <li>RBAC enforced server-side; the client role selector is a demonstration only.</li>
          <li>Every simulation run is written to an append-only audit log with user, parameters and dataset versions.</li>
          <li>Tenant-scoped data access; restricted datasets never cross tenants.</li>
          <li>Rate limits per role on simulation and AI endpoints.</li>
          <li>Input validation on every scenario parameter, with hard bounds on grid and radius sizes.</li>
        </ul>
        <p class="note warn">This demo runs entirely in the browser with no backend, no authentication and no network calls. The controls above describe the intended production posture.</p>
      </div>
      <div class="sec"><h3>API surface</h3>
        <div class="scrollx"><table class="data"><tbody>${MT.API.map(([m, path, desc]) =>
          `<tr><td style="white-space:nowrap"><span class="tag ${m === 'GET' ? 'verified' : 'limited'}">${m}</span> <span class="mono">${esc(path)}</span></td>
           <td style="text-align:left;font-family:var(--ui);color:var(--txt-3)">${esc(desc)}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="sec"><h3>Multi-city architecture</h3>
        <p class="note">The city is configuration, not code: origin, coastline, corridor set, zone definitions and model parameters all load from a city descriptor. Mumbai is city 1. Pune, Delhi, Bengaluru, Hyderabad, Chennai, Kolkata and Ahmedabad drop in behind the same engine.</p>
      </div>`;
    const showRole = () => {
      const r = MT.ROLES.find(x => x.role === $('#roleSel').value);
      $('#roleName').textContent = r.role;
      $('#roleCaps').innerHTML =
        `<p class="note"><strong>Can</strong><br>${r.caps.map(esc).join('<br>')}</p>
         <p class="note crit"><strong>Cannot</strong><br>${r.denied.map(esc).join('<br>')}</p>`;
    };
    $('#roleSel').onchange = showRole; showRole();
  };

  /* ==================================================== REPORTS ========== */
  let lastReport = null;
  BUILD.reports = function () {
    const p = $('[data-pane=reports]');
    p.innerHTML = `
      <div class="sec">
        <h3>Generate</h3>
        <div class="btnrow">
          <button class="btn run" data-rep="flood">Flood impact analysis</button>
          <button class="btn" data-rep="traffic">Traffic disruption</button>
          <button class="btn" data-rep="analytics">Urban analytics summary</button>
        </div>
        <p class="note">A flood or traffic report requires its scenario to have been run first, so the report can cite the exact parameters used.</p>
      </div>
      <div class="sec"><h3>Export</h3>
        <div class="btnrow">
          <button class="btn" id="repMd">Copy Markdown</button>
          <button class="btn" id="repCsv">Copy CSV</button>
          <button class="btn" id="repPrint">Print / save as PDF</button>
        </div>
        <p class="note warn">Direct file download is blocked inside the embedded viewer, so exports copy to the clipboard. The print route produces the PDF.</p>
      </div>
      <div id="repOut"></div>`;
    p.querySelectorAll('[data-rep]').forEach(b => b.onclick = () => {
      const rep = sim.report(b.dataset.rep);
      if (!rep) { toast('Run that scenario first, then generate the report.'); return; }
      lastReport = rep; renderReport(rep);
    });
    $('#repMd').onclick = () => copy(lastReport ? sim.reportMarkdown(lastReport) : '', 'Markdown');
    $('#repCsv').onclick = () => copy(lastReport ? sim.reportCSV(lastReport) : '', 'CSV');
    $('#repPrint').onclick = () => {
      if (!lastReport) { toast('Generate a report first.'); return; }
      $('#printArea').innerHTML = $('#repOut').innerHTML;
      window.print();
    };
    if (lastReport) renderReport(lastReport);
  };
  function renderReport(rep) {
    $('#repOut').innerHTML = `<div class="report">
      <h3>${esc(rep.title)}</h3>
      <div class="meta">${esc(rep.provenance)}</div>
      ${rep.sections.map(s => `<h4>${esc(s.h)}</h4>` +
        (s.p ? `<p>${esc(s.p)}</p>` : '') +
        (s.list ? `<ul>${s.list.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '') +
        (s.table ? `<table><tbody>${s.table.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>` : '')
      ).join('')}
      <h4>Dataset provenance</h4>
      <table><tbody>${rep.datasets.map(d =>
        `<tr><td><span class="tag ${d.status}">${d.status}</span> ${esc(d.name)}</td><td style="font-family:var(--ui);font-size:10.5px">${esc(d.accuracy)}</td></tr>`).join('')}</tbody></table>
    </div>`;
  }
  function copy(text, what) {
    if (!text) { toast('Generate a report first.'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(what + ' copied to clipboard'), () => toast('Copy blocked by the browser'));
    } else toast('Clipboard unavailable here');
  }

  /* ==================================================== MUMBAI AI ======== */
  function aiPush(cls, html) {
    const log = $('#aiLog');
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = html;
    log.appendChild(d);
    $('#panelBody').scrollTop = $('#panelBody').scrollHeight;
    return d;
  }
  BUILD.ai = function () {
    if ($('#aiSuggest').childElementCount) return;
    $('#aiSuggest').innerHTML = MT.ai.SUGGESTIONS.map(s => `<button>${esc(s)}</button>`).join('');
    $('#aiSuggest').querySelectorAll('button').forEach(b => b.onclick = () => ask(b.textContent));
    aiPush('ai', `<div class="bubble"><p><strong>Mumbai AI</strong> answers by running a query against the loaded twin — never from memory.</p>
      <p class="ai-note">Each answer shows the intent it inferred, the GIS plan it executed and the datasets it touched. When a question needs a dataset that is not connected, it says so instead of estimating.</p></div>`);
  };
  function ask(q) {
    setPane('ai');
    aiPush('user', `<div class="bubble">${esc(q)}</div>`);
    const thinking = aiPush('ai', `<div class="bubble"><p style="color:var(--txt-3)">Planning GIS query…</p></div>`);
    setTimeout(() => {
      const r = MT.ai.ask(q);
      thinking.innerHTML =
        `<div class="plan"><span class="h">${esc(r.intent)}</span><ol>${r.plan.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>
         <div class="bubble">${r.html}
           ${r.table ? `<div class="scrollx" style="margin-top:8px"><table class="data"><thead><tr>${r.table.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
             <tbody>${r.table.rows.map(row => `<tr>${row.map((c, i) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
         </div>
         ${r.datasets && r.datasets.length ? `<div class="chips">${r.datasets.map(d =>
            `<span class="chip"><i class="dot ${d.status}"></i>${esc(d.name)}</span>`).join('')}</div>` : ''}`;
      thinking.querySelectorAll('.ailink[data-zone]').forEach(a => a.onclick = () => {
        showZone(city.zones.findIndex(z => z.name === a.dataset.zone), true);
      });
      if (r.highlight) S.highlight = r.highlight;
      if (r.action) r.action();
      R.markGround(); R.invalidate();
      updateSimState(); buildLegend();
      $('#panelBody').scrollTop = $('#panelBody').scrollHeight;
    }, 260);
  }
  ui.ask = ask;
  $('#aiForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#aiInput').value.trim();
    if (!v) return;
    $('#aiInput').value = '';
    ask(v);
  });

  /* ==================================================== SIMULATION ======= */
  let placeMode = null, pickMode = null;
  const scen = { A: null, B: null };

  const link = (id, out, fmt) => {
    const el = $('#' + id), o = $('#' + out);
    const upd = () => o.textContent = fmt ? fmt(+el.value) : el.value;
    el.oninput = upd; upd();
  };
  link('fRain', 'fRainV'); link('fHours', 'fHoursV');
  link('fTide', 'fTideV', v => v.toFixed(1)); link('fDrain', 'fDrainV', v => v.toFixed(2));
  link('tPeak', 'tPeakV', v => v.toFixed(2));
  link('iRad', 'iRadV'); link('bFloors', 'bFloorsV'); link('bFoot', 'bFootV');

  $('#simTabs').querySelectorAll('button').forEach(b => b.onclick = () => openSim(b.dataset.sim));
  function openSim(which) {
    setPane('simulation');
    $('#simTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.sim === which));
    $$('[data-simpane]').forEach(s => s.hidden = s.dataset.simpane !== which);
  }
  ui.openSim = openSim;

  $('#tRoad').innerHTML = MT.ROADS.map(r => `<option value="${r.id}"${r.id === 'BWSL' ? ' selected' : ''}>${esc(r.name)}</option>`).join('');

  /* ---- flood ---- */
  $('#fPreset').onclick = () => {
    $('#fRain').value = 200; $('#fHours').value = 6; $('#fTide').value = 3.2; $('#fDrain').value = 1;
    ['fRain', 'fHours', 'fTide', 'fDrain'].forEach(i => $('#' + i).dispatchEvent(new Event('input')));
    runFlood();
  };
  $('#fRun').onclick = () => runFlood();
  function runFlood() {
    const params = {
      rain: +$('#fRain').value, hours: +$('#fHours').value,
      tide: +$('#fTide').value, eff: +$('#fDrain').value, drainEff: +$('#fDrain').value
    };
    const r = sim.flood(params);
    storm = { params, fraction: 1 };
    S.flood = r;
    S.layers.floodzone.on = true;
    R.markGround();
    renderFloodOut(r, false);
    updateSimState(); buildLegend();
    if (MT.motion) MT.motion.resync();
    /* Show the result. Running a storm while looking somewhere else and
       seeing nothing move is the fastest way to lose trust in the model. */
    frameFlood(r);
    /* a new run is a complete storm: put the storm timeline back at its end (audit #14) */
    if (tlMode === 'storm') setTlMode('storm');
    return r;
  }
  ui.runFlood = runFlood;

  /** Fly to the centre of the worst-affected zones and pin them. */
  function frameFlood(r) {
    const top = r.topZones.slice(0, 3);
    if (!top.length) { toast('No standing water at these parameters.'); return; }
    let cx = 0, cy = 0, wsum = 0;
    top.forEach(z => { const w = z.pct * z.mean + 1; cx += z.x * w; cy += z.y * w; wsum += w; });
    cx /= wsum; cy /= wsum;
    let spread = 0;
    top.forEach(z => { spread = Math.max(spread, Math.hypot(z.x - cx, z.y - cy)); });
    /* close enough to read depth on the ground, not a whole-city pull-back */
    S.highlight = { points: r.topZones.slice(0, 5).map(z => ({ x: z.x, y: z.y, name: z.name })) };
    R.flyTo({ tx: cx, ty: cy, dist: Math.max(6000, Math.min(15000, spread * 2.4)), pitch: 0.70 }, 1500);
    toast('Framed the worst-affected zones — ' + top.slice(0, 3).map(z => z.name).join(', '));
  }

  /* Rendered both on a fresh run and on every step of a storm scrub, so the
     impact figures track the replay rather than only showing the end state. */
  function renderFloodOut(r, scrubbing) {
    $('#floodOut').innerHTML = `
      <div class="tiles" style="margin-top:4px">
        <div class="tile acc"><div class="l">Area with standing water</div><div class="v">${n1(r.areaKm2)}</div><div class="u">km²</div></div>
        <div class="tile crit"><div class="l">Above 0.6 m</div><div class="v">${n1(r.classAreas[3])}</div><div class="u">km²</div></div>
        <div class="tile warn"><div class="l">Structures affected</div><div class="v">${n0(r.buildings)}</div><div class="u">simulated</div></div>
        <div class="tile crit"><div class="l">Road impassable</div><div class="v">${n1(r.roadKmImpassable)}</div><div class="u">km arterial</div></div>
        <div class="tile"><div class="l">Hospitals affected</div><div class="v">${r.hospitals.length}</div><div class="u">of ${city.hospitals.length} mapped</div></div>
        <div class="tile"><div class="l">Stations affected</div><div class="v">${r.stations.length}</div><div class="u">${r.metroAffected} metro</div></div>
      </div>
      <div class="sec"><h3>Depth distribution</h3><div class="bars">
        ${[['Under 0.15 m', 0, 'c1'], ['0.15 – 0.30 m', 1, 'c2'], ['0.30 – 0.60 m', 2, 'c3'], ['Above 0.60 m', 3, 'c4']].map(([l, i, c]) => {
          const pct = r.cells ? r.classes[i] / r.cells * 100 : 0;
          return `<div class="bar ${c}"><span class="n">${l}</span><span class="v">${n1(r.classAreas[i])} km²</span><span class="t"><i style="width:${pct}%"></i></span></div>`;
        }).join('')}
      </div></div>
      <div class="sec"><h3>Most exposed zones</h3><div class="bars">
        ${r.topZones.map(z => `<div class="bar c3"><button class="n" data-fz="${esc(z.name)}">${esc(z.name)}</button>
          <span class="v">${n0(z.pct)}% · ${n2(z.mean)} m</span><span class="t"><i style="width:${Math.min(100, z.pct)}%"></i></span></div>`).join('')}
      </div></div>
      <div class="sec"><h3>Affected hospitals</h3>
        ${r.hospitals.length ? `<div class="scrollx"><table class="data"><tbody>${r.hospitals.map(h =>
          `<tr><td>${esc(h.name)}</td><td>${esc(h.area)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="note">No mapped hospital falls in an affected cell at these parameters.</p>'}
      </div>
      <div class="btnrow"><button class="btn" id="fAnimate">Replay the storm</button>
        <button class="btn" id="fRoute">Emergency route avoiding flood</button>
        <button class="btn" id="fReport">Generate report</button></div>
      <p class="note">${scrubbing ? 'Showing the storm part-way through — impacts recompute at every step.'
        : 'Use <strong>Replay the storm</strong>, or the <strong>Storm</strong> tab on the timeline, to scrub hour by hour and watch the water rise and the roads drop out.'}</p>
      ${methodBlock(r.method)}`;
    $('#floodOut').querySelectorAll('[data-fz]').forEach(b => b.onclick = () =>
      showZone(city.zones.findIndex(z => z.name === b.dataset.fz), true));
    $('#fAnimate').onclick = animateRain;
    $('#fRoute').onclick = () => { openSim('emergency'); startPick('emergency'); };
    $('#fReport').onclick = () => { const rep = sim.report('flood'); lastReport = rep; setPane('reports'); renderReport(rep); };
  }

  /** Scrub the storm from its first minute to its last. */
  function animateRain() {
    if (!storm) runFlood();
    setTlMode('storm');
    tSlider.value = 0; applyTl();
    if (playT) $('#playBtn').click();
    $('#playBtn').click();
  }
  ui.animateRain = animateRain;

  function methodBlock(m) {
    return `<div class="sec"><h3>Model &amp; limitations</h3>
      <p class="note sim"><strong>${esc(m.model)}</strong></p>
      <ul style="margin:0;padding-left:16px;font-size:11px;color:var(--txt-3);line-height:1.55">
        ${m.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
      <p class="note crit">${esc(m.limits)}</p>
      <p class="note">Inputs: ${m.inputs.map(esc).join(' · ')}</p></div>`;
  }

  /* ---- traffic ---- */
  let tFloodOn = false;
  $('#tFlood').onclick = function () {
    tFloodOn = !tFloodOn; this.classList.toggle('on', tFloodOn); this.setAttribute('aria-checked', tFloodOn);
  };
  $('#tReset').onclick = () => {
    city.graph.edges.forEach(e => e.closed = false);
    S.traffic = null; $('#trafficOut').innerHTML = ''; R.invalidate(); updateSimState(); buildLegend();
    if (MT.motion) MT.motion.resync();
  };
  $('#tRun').onclick = () => runTraffic($('#tRoad').value);
  function runTraffic(roadId) {
    const peak = +$('#tPeak').value;
    city.graph.edges.forEach(e => e.closed = false);
    const base = sim.traffic({ closed: [], peak, useFlood: false });
    const after = sim.traffic({ closed: roadId ? [roadId] : [], peak, useFlood: tFloodOn });
    S.traffic = after;
    city.graph.edges.forEach(e => e.closed = roadId ? e.roadId === roadId : false);
    R.invalidate();
    const road = MT.ROADS.find(r => r.id === roadId);
    /* Average only journeys that exist in both runs; a journey the closure
       makes impossible is reported as cut, not averaged in as zero (audit #2). */
    const pairs = after.od.map((o, i) => [base.od[i].minutes, o.minutes]).filter(([b0, a0]) => isFinite(b0) && isFinite(a0));
    const dMean = pairs.length ? pairs.reduce((sm, [b0, a0]) => sm + a0 - b0, 0) / pairs.length : NaN;
    const cut = after.od.filter((o, i) => !isFinite(o.minutes) && isFinite(base.od[i].minutes)).length;
    $('#trafficOut').innerHTML = `
      <div class="tiles" style="margin-top:4px">
        <div class="tile ${cut || dMean > 3 ? 'crit' : dMean > 1 ? 'warn' : 'good'}"><div class="l">Mean journey change</div>
          <div class="v">${isFinite(dMean) ? (dMean >= 0 ? '+' : '') + n1(dMean) : '—'}</div>
          <div class="u">${cut ? cut + ' journey' + (cut > 1 ? 's' : '') + ' cut off' : 'min, sampled ODs'}</div></div>
        <div class="tile"><div class="l">Corridors over capacity</div>
          <div class="v">${after.corridors.filter(c => c.vc > 1).length}</div><div class="u">of ${after.corridors.length}</div></div>
      </div>
      <div class="sec"><h3>Sampled journey times</h3>
        <div class="scrollx"><table class="data"><thead><tr><th>Journey</th><th>Base</th><th>Scenario</th><th>Δ</th></tr></thead>
        <tbody>${after.od.map((o, i) => {
          const b = base.od[i];
          const d = isFinite(o.minutes) && isFinite(b.minutes) ? o.minutes - b.minutes : NaN;
          return `<tr class="clickable" data-od="${i}"><td>${esc(o.from)} → ${esc(o.to)}</td>
            <td>${n1(b.minutes)}</td><td>${isFinite(o.minutes) ? n1(o.minutes) : '—'}</td>
            <td style="color:${d > 1 ? 'var(--crit)' : d < -1 ? 'var(--good)' : 'var(--txt-3)'}">${isFinite(d) ? (d >= 0 ? '+' : '') + n1(d) : '—'}</td></tr>`;
        }).join('')}</tbody></table></div></div>
      <div class="sec"><h3>Corridor loading (V/C)</h3><div class="bars">
        ${after.corridors.slice(0, 10).map(c => {
          const pct = Math.min(100, c.vc * 70);
          const cls = c.vc > 1.15 ? 'c4' : c.vc > 0.95 ? 'c3' : c.vc > 0.7 ? 'c2' : 'c1';
          return `<div class="bar ${cls}"><span class="n">${esc(c.name)}${c.closed ? ' — CLOSED' : ''}</span>
            <span class="v">${n2(c.vc)}</span><span class="t"><i style="width:${pct}%"></i></span></div>`;
        }).join('')}</div></div>
      <p class="note warn">Closure duration is recorded on the scenario but does not change a static assignment — this model has no time dimension and no behavioural response. A 1-hour and a 7-day closure load the network identically here; in reality they do not.</p>
      <div class="btnrow"><button class="btn" id="tReport">Generate report</button></div>
      ${methodBlock(after.method)}`;
    $('#trafficOut').querySelectorAll('[data-od]').forEach(tr => tr.onclick = () => {
      const o = after.od[+tr.dataset.od];
      if (!o.path) return;
      S.routes = [{ path: sim.edgeGeometry(o.path), color: '#3FD3E6', label: o.from + ' → ' + o.to }];
      R.flyTo({ dist: 22000, pitch: 1.1 }, 900); R.invalidate();
    });
    $('#tReport').onclick = () => { const rep = sim.report('traffic'); lastReport = rep; setPane('reports'); renderReport(rep); };
    if (MT.motion) MT.motion.resync();
    if (road) {
      const pth = geo.pathXY(road.path);
      let cx = 0, cy = 0;
      for (let i = 0; i < pth.length; i += 2) { cx += pth[i]; cy += pth[i + 1]; }
      cx /= (pth.length / 2); cy /= (pth.length / 2);
      const len = geo.pathLength(pth);
      S.highlight = { points: [{ x: cx, y: cy, name: road.name + ' — closed' }] };
      R.flyTo({ tx: cx, ty: cy, dist: Math.max(6000, len * 1.9), pitch: 0.66 }, 1500);
    }
    toast(road ? road.name + ' closed — network reassigned' : 'Baseline assignment');
    updateSimState(); buildLegend();
    return after;
  }
  ui.runTraffic = runTraffic;

  /* ---- infrastructure & building placement ---- */
  $('#iPlace').onclick = () => { placeMode = 'infra'; toast('Click the map to place a ' + $('#iType').value.toLowerCase()); };
  $('#bPlace').onclick = () => { placeMode = 'building'; toast('Click the map to place the building'); };
  $('#iClear').onclick = $('#bClear').onclick = () => { S.placed = []; S.highlight = null; $('#infraOut').innerHTML = ''; $('#buildOut').innerHTML = ''; R.invalidate(); updateSimState(); };
  link('eTurnout', 'eTurnoutV', v => v.toFixed(1));
  $('#eCoverClear').onclick = () => { S.iso = null; $('#coverOut').innerHTML = ''; R.invalidate(); updateSimState(); buildLegend(); };
  $('#eCover').onclick = () => {
    const turnout = +$('#eTurnout').value;
    const dry = sim.responseCoverage({ turnout, avoidFlood: false });
    const wet = S.flood ? sim.responseCoverage({ turnout, avoidFlood: true }) : null;
    S.iso = wet || dry;
    S.layers.isochrone.on = true;
    R.invalidate(); buildLegend(); updateSimState();
    R.flyTo(VIEWS[0][1], 1400);
    const row = (label, i, cls) => {
      const a = dry.pct[i], b = wet ? wet.pct[i] : null;
      const d = b === null ? null : b - a;
      return `<div class="bar ${cls}"><span class="n">${label}</span>
        <span class="v">${n0(a)}%${d === null ? '' : ' → ' + n0(b) + '%'}</span>
        <span class="t"><i style="width:${Math.min(100, wet ? b : a)}%"></i></span></div>`;
    };
    $('#coverOut').innerHTML = `
      <div class="tiles" style="margin-top:4px">
        <div class="tile good"><div class="l">Within 5 min</div><div class="v">${n0((wet || dry).pct[0])}</div><div class="u">% of arterial km</div></div>
        <div class="tile ${wet ? 'crit' : ''}"><div class="l">Unreachable</div>
          <div class="v">${n1((wet || dry).unreachableKm)}</div><div class="u">km cut off</div></div>
      </div>
      <div class="sec"><h3>Network reached from ${dry.stations} stations</h3><div class="bars">
        ${row('Within 5 minutes', 0, 'c1')}${row('5 – 10 minutes', 1, 'c2')}
        ${row('10 – 15 minutes', 2, 'c3')}${row('Over 15 minutes', 3, 'c4')}
      </div></div>
      ${wet ? `<p class="note crit">With the current flood scenario applied, 5-minute coverage falls from
        <strong>${n0(dry.pct[0])}%</strong> to <strong>${n0(wet.pct[0])}%</strong> of the modelled network, and
        <strong>${n1(wet.unreachableKm)} km</strong> becomes unreachable. That gap is the operational cost of the storm.</p>`
        : '<p class="note">Run a flood scenario and compute again to see how much coverage a storm takes away.</p>'}
      ${methodBlock((wet || dry).method)}`;
  };
  $('#ePick').onclick = () => startPick('emergency');
  $('#eClear').onclick = () => { S.routes = []; $('#emergOut').innerHTML = ''; R.invalidate(); updateSimState(); };
  let eAvoid = true;
  $('#eAvoid').onclick = function () { eAvoid = !eAvoid; this.classList.toggle('on', eAvoid); this.setAttribute('aria-checked', eAvoid); };
  /* A hospital's "route here" button pins that hospital as the destination;
     otherwise the nearest one is chosen (audit #3). */
  let pickTarget = null;
  function startPick(mode, target) {
    pickMode = mode; pickTarget = target || null;
    toast(target ? 'Click the map to set the incident — routing to ' + target.name : 'Click the map to set the incident location');
  }

  function placeInfra(w) {
    const type = $('#iType').value, r = +$('#iRad').value;
    const res = sim.infrastructure({ x: w.x, y: w.y, type, radius: r });
    S.placed = [{ x: w.x, y: w.y, label: 'Proposed ' + type, height: type === 'Metro Station' ? 26 : 34, radius: 40 }];
    S.highlight = { circles: [{ x: w.x, y: w.y, r }] };
    R.invalidate();
    setTimeout(updateSimState, 0);
    $('#infraOut').innerHTML = `
      <div class="tiles" style="margin-top:4px">
        <div class="tile acc"><div class="l">Catchment</div><div class="v">${n2(res.catchmentKm2)}</div><div class="u">km² land</div></div>
        <div class="tile good"><div class="l">Newly served</div><div class="v">${n2(res.newlyServedKm2)}</div><div class="u">km² (${n0(res.newlyServedPct)}%)</div></div>
        <div class="tile"><div class="l">Structures served</div><div class="v">${n0(res.buildings)}</div><div class="u">simulated</div></div>
        <div class="tile"><div class="l">Density index</div><div class="v">${n2(res.densityIndex)}</div><div class="u">relative, simulated</div></div>
      </div>
      <dl class="kv">
        <dt>Nearest metro</dt><dd class="txt">${res.nearestMetro ? esc(res.nearestMetro.name) + ' · ' + geo.fmtDist(res.nearestMetro.d) : '—'}</dd>
        <dt>Nearest station (any)</dt><dd class="txt">${res.nearestStation ? esc(res.nearestStation.name) + ' · ' + geo.fmtDist(res.nearestStation.d) : '—'}</dd>
        <dt>Nearest arterial road</dt><dd class="txt">${res.nearestRoad ? esc(res.nearestRoad.name) + ' · ' + geo.fmtDist(res.nearestRoad.d) : '—'}</dd>
        <dt>Hospitals within 3 km</dt><dd>${res.hospitalsNear}</dd>
        <dt>Population served</dt><dd class="txt" style="color:var(--crit)">DATA SOURCE REQUIRED</dd>
      </dl>
      ${methodBlock(res.method)}`;
    scen.pending = { kind: 'infra', r: res, label: type + ' at ' + geo.fmtLatLon(geo.lon(w.x), geo.lat(w.y)) };
  }

  function placeBuilding(w) {
    const floors = +$('#bFloors').value, foot = +$('#bFoot').value, use = $('#bUse').value;
    const height = floors * 3.1;
    const res = sim.building({ x: w.x, y: w.y, height, floors, footprint: foot, use });
    S.placed = [{ x: w.x, y: w.y, label: use + ' · ' + floors + 'F', height, radius: Math.sqrt(foot / Math.PI) }];
    S.highlight = { circles: [{ x: w.x, y: w.y, r: 400 }] };
    R.invalidate();
    const fr = res.floodDepth;
    /* Before / after on the nearest main road: today's modelled load from the
       baseline traffic run, then the same road with this building's peak-hour
       trips added — a worst case that puts every trip on that road. */
    let near = null, nd = Infinity;
    for (const e of city.graph.edges) {
      if (e.road < 0 || e.cls === 'link') continue;
      const A = city.graph.nodes[e.a], B = city.graph.nodes[e.b];
      const d = geo.distToSeg(w.x, w.y, A.x, A.y, B.x, B.y);
      if (d < nd) { nd = d; near = e; }
    }
    let ba = '';
    if (near && nd < 1500) {
      const baseT = S.traffic && !S.traffic.closed.length ? S.traffic : sim.traffic({ closed: [], peak: 1, useFlood: false });
      const vc0 = baseT.vc[near.id] || 0, vc1 = vc0 + res.peakTrips / near.cap;
      const bar = (v, c) => `<div class="babar"><i style="width:${Math.min(100, v / 1.4 * 100).toFixed(1)}%;background:${c}"></i></div>`;
      const col = v => v > 1 ? '#EC5F70' : v > 0.85 ? '#EE7F45' : v > 0.6 ? '#EDAE45' : '#3FBE84';
      const word = v => v > 1 ? 'jammed' : v > 0.85 ? 'heavy' : v > 0.6 ? 'busy' : 'free-flowing';
      ba = `<div class="sec"><h3>Before → after</h3>
        <p class="note">${esc(near.name)} · ${geo.fmtDist(nd)} away · peak hour</p>
        <div class="barow"><span>Today</span>${bar(vc0, col(vc0))}<b style="color:${col(vc0)}">${n2(vc0)}</b><em>${word(vc0)}</em></div>
        <div class="barow"><span>With building</span>${bar(vc1, col(vc1))}<b style="color:${col(vc1)}">${n2(vc1)}</b><em>${word(vc1)}</em></div>
        <p class="note">Road load as volume ÷ capacity (1.00 = full). Worst case: all ${n0(res.peakTrips)} peak trips use this road.</p></div>`;
    }
    $('#buildOut').innerHTML = ba + `
      <div class="tiles" style="margin-top:4px">
        <div class="tile acc"><div class="l">Gross floor area</div><div class="v">${n0(res.gfa)}</div><div class="u">m²</div></div>
        <div class="tile"><div class="l">Height</div><div class="v">${n0(height)}</div><div class="u">m · ${floors} floors</div></div>
        <div class="tile warn"><div class="l">Peak-hour trips</div><div class="v">${n0(res.peakTrips)}</div><div class="u">estimate</div></div>
        <div class="tile"><div class="l">Parking demand</div><div class="v">${n0(res.parkingDemand)}</div><div class="u">spaces, estimate</div></div>
      </div>
      <dl class="kv">
        <dt>Context mean height</dt><dd>${n0(res.contextHeight)} m</dd>
        <dt>Height vs context</dt><dd>${res.heightRatio ? n1(res.heightRatio) + '×' : '—'}</dd>
        <dt>Shadow at 30° sun</dt><dd>${n0(res.shadowLength)} m</dd>
        <dt>Nearest arterial capacity</dt><dd>${n0(res.capNear)} veh/h</dd>
        <dt>Added load on that link</dt><dd>${res.loadPct ? n1(res.loadPct) + '%' : '—'}</dd>
        <dt>Ground elevation</dt><dd>${n1(res.elev)} m</dd>
        <dt>Flood depth (current scenario)</dt><dd style="color:${fr > 0.3 ? 'var(--crit)' : fr > 0.1 ? 'var(--warn)' : 'inherit'}">${fr === null ? 'no scenario run' : n2(fr) + ' m'}</dd>
        <dt>Nearest hospital</dt><dd class="txt">${res.nearestHospital ? esc(res.nearestHospital.name) + ' · ' + geo.fmtDist(res.nearestHospital.d) : '—'}</dd>
        <dt>Nearest station</dt><dd class="txt">${res.nearestStation ? esc(res.nearestStation.name) + ' · ' + geo.fmtDist(res.nearestStation.d) : '—'}</dd>
        <dt>Structures within 400 m</dt><dd>${res.buildingsNear}</dd>
      </dl>
      <p class="note sim"><strong>Simulation / estimate</strong> — trips, parking and shadow are derived from generic planning rates, not site survey. Context figures come from the synthetic building stock.</p>
      ${methodBlock(res.method)}`;
    updateSimState();
  }

  function runEmergency(w) {
    const r = sim.emergencyRoute(w, { avoidFlood: eAvoid && !!S.flood, targets: pickTarget ? [pickTarget] : undefined });
    pickTarget = null;
    if (!r || !r.ok) {
      $('#emergOut').innerHTML = `<p class="note crit">${esc(r ? r.reason : 'No route found.')}</p>`;
      return;
    }
    const turnout = +$('#eTurnout').value;
    S.routes = [{ path: r.path, color: '#77E4AE', label: 'Casualty transfer', turnout: 0, emergency: true }];
    R.flyTo({ tx: (w.x + r.target.x) / 2, ty: (w.y + r.target.y) / 2,
              dist: Math.max(4200, Math.hypot(w.x - r.target.x, w.y - r.target.y) * 2.2), pitch: 0.72 }, 1400);
    /* a fire appliance runs the other way: station to incident, after turnout */
    const nearestFire = city.fire.map(f => ({ f, d: Math.hypot(f.x - w.x, f.y - w.y) }))
      .sort((a, b) => a.d - b.d)[0];
    if (nearestFire) {
      const fr = sim.emergencyRoute({ x: nearestFire.f.x, y: nearestFire.f.y },
        { avoidFlood: eAvoid && !!S.flood, targets: [{ x: w.x, y: w.y, name: 'Incident', area: '' }] });
      if (fr && fr.ok) S.routes.push({ path: fr.path, color: '#EE7F45',
        label: 'Appliance from ' + nearestFire.f.name, turnout, emergency: true });
    }
    S.highlight = { points: [{ x: w.x, y: w.y, name: 'Incident' }, { x: r.target.x, y: r.target.y, name: r.target.name }] };
    R.invalidate();
    updateSimState();
    $('#emergOut').innerHTML = `${r.throughFlood ? '<p class="note crit">Flood water cuts every route to a hospital from here. Showing the least-flooded route — expect delay; a high-clearance vehicle or boat may be needed.</p>' : ''}
      <div class="tiles" style="margin-top:4px">
        <div class="tile ${r.throughFlood ? 'warn' : 'good'}"><div class="l">Travel time</div><div class="v">${n1(r.minutes)}</div><div class="u">min, modelled</div></div>
        <div class="tile"><div class="l">Distance</div><div class="v">${n1(r.km)}</div><div class="u">km on network</div></div>
      </div>
      <dl class="kv">
        <dt>Destination</dt><dd class="txt">${esc(r.target.name)}</dd>
        <dt>Area</dt><dd class="txt">${esc(r.target.area || '—')}</dd>
        <dt>Emergency type</dt><dd class="txt">${esc($('#eType').value)}</dd>
        <dt>Flooded links avoided</dt><dd class="txt">${r.throughFlood ? 'not possible — ' + r.throughFlood + ' flooded link' + (r.throughFlood > 1 ? 's' : '') + ' on route' : r.avoidedFlood ? 'yes' : 'no scenario / disabled'}</dd>
      </dl>
      <div class="sec"><h3>Route</h3><p class="note">${r.via.map(esc).join(' → ')}</p></div>
      <div class="sec"><h3>Nearest response assets</h3>
        <div class="scrollx"><table class="data"><tbody>
        ${city.fire.map(f => ({ f, d: Math.hypot(f.x - w.x, f.y - w.y) })).sort((a, b) => a.d - b.d).slice(0, 3)
          .map(o => `<tr><td>${esc(o.f.name)}</td><td>${geo.fmtDist(o.d)}</td></tr>`).join('')}
        ${city.police.map(f => ({ f, d: Math.hypot(f.x - w.x, f.y - w.y) })).sort((a, b) => a.d - b.d).slice(0, 2)
          .map(o => `<tr><td>${esc(o.f.name)} <span class="tag sim">sim</span></td><td>${geo.fmtDist(o.d)}</td></tr>`).join('')}
        </tbody></table></div></div>
      ${methodBlock(r.method)}`;
  }

  /* ---- scenario comparison ---- */
  /* The tab being looked at decides what "save" means; only on the other
     tabs does it fall back to whatever ran last (audit #5). */
  function currentScenario() {
    const tab = ($('#simTabs .on') || {}).dataset ? $('#simTabs .on').dataset.sim : '';
    const flood = () => S.flood ? { kind: 'flood', r: S.flood, label: S.flood.params.rain + ' mm / ' + S.flood.params.hours + ' h' } : null;
    const traffic = () => S.traffic ? { kind: 'traffic', r: S.traffic, label: S.traffic.closed.length ? 'closure: ' + S.traffic.closed.join(', ') : 'baseline network' } : null;
    if (tab === 'flood') return flood();
    if (tab === 'traffic') return traffic();
    if (tab === 'infra' || tab === 'building') return scen.pending || null;
    return traffic() || flood() || scen.pending || null;
  }
  $('#cSaveA').onclick = () => { scen.A = currentScenario(); toast(scen.A ? 'Saved scenario A — ' + scen.A.label : 'Run a scenario first'); };
  $('#cSaveB').onclick = () => { scen.B = currentScenario(); toast(scen.B ? 'Saved scenario B — ' + scen.B.label : 'Run a scenario first'); };
  $('#cRun').onclick = () => {
    if (!scen.A || !scen.B) { toast('Save two scenarios of the same type first'); return; }
    if (scen.A.kind !== scen.B.kind) { toast('Scenarios must be the same type'); return; }
    const rows = sim.compare(scen.A, scen.B);
    $('#compareOut').innerHTML = `
      <div class="scrollx"><table class="data">
        <thead><tr><th>Measure</th><th>A</th><th>B</th><th>Δ</th></tr></thead>
        <tbody>${rows.map(r => {
          const d = (typeof r.a === 'number' && typeof r.b === 'number' && isFinite(r.a) && isFinite(r.b)) ? r.b - r.a : NaN;
          const good = r.better === 'low' ? d < 0 : r.better === 'high' ? d > 0 : null;
          const col = !isFinite(d) || Math.abs(d) < 1e-9 || good === null ? 'var(--txt-3)' : good ? 'var(--good)' : 'var(--crit)';
          const f = v => typeof v === 'number' ? (Math.abs(v) >= 100 ? n0(v) : n2(v)) : v;
          return `<tr><td>${esc(r.label)}</td><td>${f(r.a)}</td><td>${f(r.b)}</td>
            <td style="color:${col}">${isFinite(d) ? (d >= 0 ? '+' : '') + f(d) : '—'}</td></tr>`;
        }).join('')}</tbody></table></div>
      <p class="note">A: ${esc(scen.A.label)} · B: ${esc(scen.B.label)}</p>
      <p class="note warn">No overall score is computed. Trade-offs between accessibility, traffic and exposure are a policy judgement, not an arithmetic one.</p>`;
  };

  /* ==================================================== SELECTION ======== */
  function showZone(i, fly) {
    if (i < 0) return;
    const z = sim.zoneTable()[i], Z = city.zones[i];
    if (fly) R.flyTo({ tx: Z.x, ty: Z.y, dist: 7000, pitch: 0.78 }, 1100);
    S.selection = { kind: 'zone', ref: Z };
    openCtx('Analysis zone', `
      <div class="sec"><h3>${esc(z.name)} <span class="tag limited">demo zone</span></h3>
        <p class="note">${esc(z.sector)} · nearest-centroid partition, not a BMC ward boundary</p></div>
      <div class="tiles">
        <div class="tile"><div class="l">Area</div><div class="v">${n1(z.areaKm2)}</div><div class="u">km²</div></div>
        <div class="tile acc"><div class="l">Structures</div><div class="v">${n0(z.buildings)}</div><div class="u">simulated</div></div>
        <div class="tile"><div class="l">Transit access</div><div class="v">${n0(z.transitPct)}</div><div class="u">% within 800 m</div></div>
        <div class="tile"><div class="l">Below 4 m</div><div class="v">${n0(z.lowPct)}</div><div class="u">% of land</div></div>
      </div>
      <dl class="kv">
        <dt>Built-up share</dt><dd>${n1(z.builtPct)}%</dd>
        <dt>Total floors</dt><dd>${n0(z.floors)}</dd>
        <dt>Road density</dt><dd>${n1(z.roadDensity)} km/km²</dd>
        <dt>Green cover</dt><dd>${n1(z.greenPct)}%</dd>
        <dt>Mean elevation</dt><dd>${n1(z.meanElev)} m</dd>
        <dt>Density index</dt><dd>${n2(z.densityIndex)}</dd>
        <dt>Hospitals</dt><dd>${z.hospitals}</dd>
        <dt>Schools (sim)</dt><dd>${z.schools}</dd>
        <dt>Fire stations</dt><dd>${z.fire}</dd>
        <dt>Metro stations</dt><dd>${z.metro}</dd>
        <dt>Rail stations</dt><dd>${z.rail}</dd>
        <dt>Flooded (scenario)</dt><dd>${z.floodPct === null ? '—' : n0(z.floodPct) + '%'}</dd>
        <dt>Population</dt><dd class="txt" style="color:var(--crit)">DATA SOURCE REQUIRED</dd>
      </dl>
      <div class="btnrow"><button class="btn" id="zAsk">Ask Mumbai AI about this zone</button></div>`);
    $('#zAsk').onclick = () => ask('Tell me about ' + z.name);
    R.invalidate();
  }

  /* ---- aircraft: fly in and ride along ---- */
  let followAc = -1;
  function stopFollow(silent) {
    if (followAc < 0) return;
    followAc = -1; R.follow(null);
    document.body.classList.remove('following');
    const b = $('#acFollow'); if (b) { b.textContent = 'Follow this aircraft'; b.classList.add('run'); }
    if (!silent) toast('Stopped following');
  }
  MT.onFollowEnd = () => stopFollow(false);
  function selectAircraft(i, fly) {
    const v = MT.motion.aircraftView(i); if (!v) return;
    S.selection = { kind: 'aircraft', ref: i };
    openCtx('Aircraft', `
      <div class="sec"><h3>Airliner <span class="tag sim">simulated</span></h3>
        <p class="note sim">A <strong>simulated</strong> aircraft on an illustrative ${esc(v.kind)} track. No ADS-B or flight feed is connected, so it has no callsign, airline or registration, and it does not correspond to any real flight.</p></div>
      <dl class="kv">
        <dt>Track</dt><dd class="txt">${esc(v.track)}</dd>
        <dt>Altitude</dt><dd id="acAlt">${n0(v.alt)} m</dd>
        <dt>Ground speed</dt><dd id="acSpd">${n0(v.speed * 3.6)} km/h</dd>
        <dt>Model</dt><dd class="txt">Generic narrow-body, 44 m</dd>
      </dl>
      <div class="btnrow"><button class="btn run" id="acFollow">Follow this aircraft</button></div>
      <p class="note">While following: scroll to zoom right up to it, right-drag to orbit. Drag the map to let go.</p>`);
    const btn = $('#acFollow');
    const start = () => {
      followAc = i;
      document.body.classList.add('following');
      const w = MT.motion.aircraftView(i);
      R.flyTo({ tx: w.x, ty: w.y, tz: w.z, dist: 260, pitch: 0.34, yaw: Math.atan2(w.hx, w.hy) + 2.2, keepFollow: true }, 1300);
      setTimeout(() => { if (followAc === i) R.follow(() => MT.motion.aircraftView(i)); }, 1320);
      btn.textContent = 'Stop following'; btn.classList.remove('run');
    };
    btn.onclick = () => (followAc === i ? stopFollow(false) : start());
    if (fly) start();
    /* keep the readout live while the card is open */
    clearInterval(selectAircraft.t);
    selectAircraft.t = setInterval(() => {
      if (!S.selection || S.selection.kind !== 'aircraft' || S.selection.ref !== i) { clearInterval(selectAircraft.t); return; }
      const w = MT.motion.aircraftView(i); if (!w) return;
      const a1 = $('#acAlt'), s1 = $('#acSpd');
      if (a1) a1.textContent = n0(w.alt) + ' m';
      if (s1) s1.textContent = n0(w.speed * 3.6) + ' km/h';
    }, 500);
  }

  /* ---- building twins (demo) ---- */
  const TWIN_SERVICES = [
    ['#FF8A3D', 'Heating / hot water'], ['#E056FD', 'Chilled-water return'],
    ['#8B7BF0', 'Electrical'], ['#3FE08A', 'Domestic water'], ['#3FD3E6', 'Chilled-water supply']
  ];
  function flyToTwin(tw) {
    if (!tw) return;
    const vs = S.vscale || 1;
    R.flyTo({ tx: tw.x, ty: tw.y, dist: 260 + tw.floors * 4.2 * vs * 2.4, pitch: 0.42, yaw: tw.rot + 0.72 }, 1500);
    setTimeout(() => selectTwin(tw), 900);
  }
  function selectTwin(tw) {
    S.selection = { kind: 'twin', ref: tw };
    const vs = S.vscale || 1;
    const k = city.cellIndex(tw.x, tw.y);
    const fd = S.flood && k >= 0 ? S.flood.depth[k] : null;
    const risk = fd !== null ? (fd > 0.6 ? 'Severe' : fd > 0.3 ? 'High' : fd > 0.15 ? 'Moderate' : 'Low') :
      (tw.elev < 3 ? 'High (baseline, low-lying)' : tw.elev < 6 ? 'Moderate (baseline)' : 'Low (baseline)');
    const stn = city.stationIndex.within(tw.x, tw.y, 1500).slice(0, 3);
    openCtx('Building twin', `
      <div class="sec"><h3>${esc(tw.area)} · ${esc(tw.id)} <span class="tag sim">demo</span></h3>
        <p class="note sim">An <strong>illustrative</strong> building, drawn to show what a building-level twin adds inside the city twin. It is not a real building: no BIM model, as-built drawings or building-management (BMS) feed is connected, and every system shown is a placeholder.</p></div>
      <dl class="kv">
        <dt>Location</dt><dd>${geo.fmtLatLon(geo.lon(tw.x), geo.lat(tw.y))}</dd>
        <dt>Floors</dt><dd>${tw.floors} + basement</dd>
        <dt>Height</dt><dd>${n1(tw.floors * 4.2)} m${vs !== 1 ? ` <span style="color:var(--txt-4)">(drawn ×${n1(vs)})</span>` : ''}</dd>
        <dt>Footprint</dt><dd>${n0(tw.w * tw.d)} m²</dd>
        <dt>Gross floor area</dt><dd>${n0(tw.w * tw.d * tw.floors)} m²</dd>
        <dt>Ground elevation</dt><dd>${n1(tw.elev)} m</dd>
        <dt>Flood risk</dt><dd class="txt" style="color:${/Severe|High/.test(risk) ? 'var(--crit)' : /Moderate/.test(risk) ? 'var(--warn)' : 'inherit'}">${esc(risk)}${fd !== null ? ' · ' + n2(fd) + ' m' : ''}</dd>
        ${stn.length ? `<dt>Nearest station</dt><dd class="txt">${esc(stn[0].item.name)} · ${geo.fmtDist(stn[0].d)}</dd>` : ''}
      </dl>
      <div class="sec"><h3>What is drawn</h3>
        <div class="twin-key">${TWIN_SERVICES.map(([c, l]) => `<div><i style="background:${c}"></i>${l}</div>`).join('')}</div>
        <dl class="kv" style="margin-top:8px">
          <dt>Service riser</dt><dd class="txt">5 services, branching on every floor</dd>
          <dt>Roof</dt><dd class="txt">4 HVAC units · solar PV array</dd>
          <dt>Basement</dt><dd class="txt">Plant room: chillers, pumps, switchgear</dd>
        </dl></div>
      <div class="sec"><h3>With a real building connected</h3>
        <p class="note">A BIM model would replace this geometry, and a BMS feed would add live energy use per floor, occupancy, equipment status and maintenance alerts. <strong>None of that is connected here</strong>, so no such figures are shown.</p></div>
      <div class="btnrow"><button class="btn run" id="twOrbit">Orbit this building</button></div>`);
    $('#twOrbit').onclick = () => {
      R.flyTo({ tx: tw.x, ty: tw.y, dist: 240 + tw.floors * 4.2 * vs * 2.2, pitch: 0.38 }, 900);
      setTimeout(() => R.setSpin(0.0016), 950);
    };
    R.invalidate();
  }

  function selectBuilding(b) {
    S.selection = { kind: 'building', ref: b };
    const roads = [];
    for (const e of city.graph.edges) {
      if (e.road < 0) continue;
      const d = geo.distToSeg(b.x, b.y, city.graph.nodes[e.a].x, city.graph.nodes[e.a].y, city.graph.nodes[e.b].x, city.graph.nodes[e.b].y);
      if (d < 900) { const f = roads.find(r => r.name === e.name); if (!f || f.d > d) { if (f) f.d = d; else roads.push({ name: e.name, d }); } }
    }
    roads.sort((a, b2) => a.d - b2.d);
    const stn = city.stationIndex.within(b.x, b.y, 1500).slice(0, 4);
    const hos = city.hospitalIndex.within(b.x, b.y, 4000).slice(0, 4);
    const sch = new geo.PointIndex(city.schools, 800).within(b.x, b.y, 1500).slice(0, 3);
    const k = city.cellIndex(b.x, b.y);
    const fd = S.flood && k >= 0 ? S.flood.depth[k] : null;
    const elev = k >= 0 ? city.elev[k] : 0;
    const risk = fd !== null ? (fd > 0.6 ? 'Severe' : fd > 0.3 ? 'High' : fd > 0.15 ? 'Moderate' : 'Low') :
      (elev < 3 ? 'High (baseline, low-lying)' : elev < 6 ? 'Moderate (baseline)' : 'Low (baseline)');
    const zone = city.zones[b.zone];

    openCtx('Building information', `
      <div class="sec"><h3>${esc(b.id)} <span class="tag sim">simulated</span></h3>
        <p class="note sim">This structure is <strong>generated</strong>. Footprint, height, floors, use and year come from a seeded model, not a cadastre. No real building is represented.</p></div>
      <dl class="kv">
        <dt>Location</dt><dd>${geo.fmtLatLon(geo.lon(b.x), geo.lat(b.y))}</dd>
        <dt>Zone</dt><dd class="txt">${esc(zone ? zone.name : '—')}</dd>
        <dt>Height</dt><dd>${n1(b.h)} m</dd>
        <dt>Floors</dt><dd>${b.floors}</dd>
        <dt>Footprint</dt><dd>${n0(b.area)} m²</dd>
        <dt>Gross floor area</dt><dd>${n0(b.area * b.floors)} m²</dd>
        <dt>Building type</dt><dd class="txt">${esc(b.use)}</dd>
        <dt>Year (modelled)</dt><dd>${b.year}</dd>
        <dt>Ground elevation</dt><dd>${n1(elev)} m</dd>
        <dt>Flood risk</dt><dd class="txt" style="color:${/Severe|High/.test(risk) ? 'var(--crit)' : /Moderate/.test(risk) ? 'var(--warn)' : 'inherit'}">${esc(risk)}${fd !== null ? ' · ' + n2(fd) + ' m' : ''}</dd>
      </dl>
      <div class="sec"><h3>Nearby roads</h3>
        ${roads.length ? `<dl class="kv">${roads.slice(0, 4).map(r => `<dt>${esc(r.name)}</dt><dd>${geo.fmtDist(r.d)}</dd>`).join('')}</dl>`
          : '<p class="note">No modelled arterial road within 900 m. Only major corridors are in this build.</p>'}</div>
      <div class="sec"><h3>Nearby public transport</h3>
        ${stn.length ? `<dl class="kv">${stn.map(s => `<dt>${esc(s.item.name)} <span style="color:var(--txt-4)">${esc(s.item.cat)}</span></dt><dd>${geo.fmtDist(s.d)}</dd>`).join('')}</dl>`
          : '<p class="note">No station within 1.5 km.</p>'}</div>
      <div class="sec"><h3>Nearby hospitals</h3>
        ${hos.length ? `<dl class="kv">${hos.map(h => `<dt>${esc(h.item.name)}</dt><dd>${geo.fmtDist(h.d)}</dd>`).join('')}</dl>`
          : '<p class="note">No mapped hospital within 4 km.</p>'}</div>
      <div class="sec"><h3>Nearby schools <span class="tag sim">sim</span></h3>
        ${sch.length ? `<dl class="kv">${sch.map(h => `<dt>${esc(h.item.name)}</dt><dd>${geo.fmtDist(h.d)}</dd>`).join('')}</dl>`
          : '<p class="note">None in the simulated set within 1.5 km.</p>'}</div>
      <div class="sec"><h3>Infrastructure</h3>
        <p class="note">Utility networks — water, sewer, power, drainage — are <strong>not connected</strong>. The platform will not display them until a source is bound.</p></div>
      <div class="btnrow"><button class="btn" id="bRoute">Route to nearest hospital</button></div>`);
    $('#bRoute').onclick = () => { openSim('emergency'); runEmergency({ x: b.x, y: b.y }); };
    R.invalidate();
  }

  function selectPoint(p) {
    S.selection = { kind: 'point', ref: p };
    const isSim = p.simulated;
    const near = city.stationIndex.within(p.x, p.y, 1200).slice(0, 3);
    openCtx(p.cat === 'project' ? 'Project' : p.cat === 'bank' ? 'Bank headquarters' : 'Facility', `
      <div class="sec"><h3>${esc(p.name)} <span class="tag ${isSim ? 'sim' : 'limited'}">${isSim ? 'simulated' : 'limited'}</span></h3>
        ${p.status ? `<p class="note">Status: <strong>${esc(p.status)}</strong></p>` : ''}
        ${p.desc ? `<p class="note">${esc(p.desc)}</p>` : ''}</div>
      <dl class="kv">
        <dt>Category</dt><dd class="txt">${esc(p.cat)}</dd>
        ${p.area ? `<dt>Area</dt><dd class="txt">${esc(p.area)}</dd>` : ''}
        ${p.line ? `<dt>Line</dt><dd class="txt">${esc(p.line)}</dd>` : ''}
        ${p.agency ? `<dt>Agency</dt><dd class="txt">${esc(p.agency)}</dd>` : ''}
        ${p.kind ? `<dt>Type</dt><dd class="txt">${esc(p.kind)}</dd>` : ''}
        <dt>Location</dt><dd>${geo.fmtLatLon(p.lon, p.lat)}</dd>
      </dl>
      ${near.length ? `<div class="sec"><h3>Nearby stations</h3><dl class="kv">${near.map(s =>
        `<dt>${esc(s.item.name)}</dt><dd>${geo.fmtDist(s.d)}</dd>`).join('')}</dl></div>` : ''}
      ${p.cat === 'bank' ? `<p class="note">Head office only. Branches and ATMs are not modelled — no verified branch register is connected.</p>` : ''}
      <p class="note ${isSim ? 'sim' : 'warn'}">${isSim
        ? 'This record is generated. No verified register of this facility type is connected.'
        : 'Position is approximate (±400 m or worse) and compiled from public knowledge. Not an authoritative register.'}</p>
      ${p.cat === 'hospital' ? `<div class="btnrow"><button class="btn" id="pRoute">Route here from an incident</button></div>` : ''}`);
    if (p.cat === 'hospital') $('#pRoute').onclick = () => { openSim('emergency'); startPick('emergency', p); };
    R.invalidate();
  }

  /* A named place (park, lake, river, sea, landmark tag): what it is and what
     the model around it says — nearest stations and hospital, buildings and
     flood water close by. All computed from the loaded model. */
  const PLACE_KIND = { park: 'Park / green area', water: 'Lake or river', sea: 'Sea / creek', heritage: 'Heritage landmark', place: 'Landmark', airport: 'Airport', beach: 'Beach' };
  function selectPlace(q) {
    S.selection = { kind: 'place', ref: q };
    const near = (arr, lim) => arr.map(o => ({ o, d: Math.hypot(o.x - q.x, o.y - q.y) })).sort((a, b) => a.d - b.d).slice(0, lim);
    const rs = near(city.railStations, 1)[0], ms = near(city.metroStations, 1)[0], hs = near(city.hospitals, 1)[0];
    let nb = 0, tall = 0;
    for (const b of city.buildings) { const d = Math.hypot(b.x - q.x, b.y - q.y); if (d < 1000) { nb++; if (b.h > tall) tall = b.h; } }
    let wet = null;
    if (S.flood) { let dmax = 0; for (let dx = -600; dx <= 600; dx += 200) for (let dy = -600; dy <= 600; dy += 200) { const k = city.cellIndex(q.x + dx, q.y + dy); if (k >= 0) dmax = Math.max(dmax, S.flood.depth[k] || 0); } wet = dmax; }
    const k0 = city.cellIndex(q.x, q.y), elev = k0 >= 0 ? city.elev[k0] : null;
    const water = q.st === 'sea' || q.st === 'water';
    openCtx(PLACE_KIND[q.st] || 'Place', `
      <div class="sec"><h3>${esc(q.name)}</h3>
        <p class="note">Position from public knowledge, accurate to a few hundred metres. Figures below come from the model around it.</p></div>
      <div class="tiles">
        <div class="tile acc"><div class="l">Buildings within 1 km</div><div class="v">${n0(nb)}</div><div class="u">simulated</div></div>
        <div class="tile"><div class="l">Tallest within 1 km</div><div class="v">${tall ? n0(tall) : '—'}</div><div class="u">m, simulated</div></div>
      </div>
      <dl class="kv">
        <dt>Nearest local station</dt><dd class="txt">${rs ? esc(rs.o.name) + ' · ' + geo.fmtDist(rs.d) : '—'}</dd>
        <dt>Nearest metro station</dt><dd class="txt">${ms ? esc(ms.o.name) + ' · ' + geo.fmtDist(ms.d) : '—'}</dd>
        <dt>Nearest hospital</dt><dd class="txt">${hs ? esc(hs.o.name) + ' · ' + geo.fmtDist(hs.d) : '—'}</dd>
        ${water ? '' : `<dt>Ground level (model)</dt><dd>${elev === null ? '—' : n1(elev) + ' m'}</dd>`}
        <dt>Flood water nearby</dt><dd style="color:${wet > 0.3 ? 'var(--crit)' : wet > 0.1 ? 'var(--warn)' : 'inherit'}">${wet === null ? 'no flood scenario' : wet > 0.05 ? 'up to ' + n2(wet) + ' m' : 'none'}</dd>
      </dl>
      <div class="btnrow"><button class="btn" id="plZoom">Fly here</button>${hs ? '<button class="btn" id="plRoute">Ambulance route from here</button>' : ''}</div>`);
    $('#plZoom').onclick = () => R.flyTo({ tx: q.x, ty: q.y, dist: water ? 6000 : 2200, pitch: 0.55 }, 1300);
    if ($('#plRoute')) $('#plRoute').onclick = () => { openSim('emergency'); runEmergency({ x: q.x, y: q.y }); };
    R.invalidate();
  }

  function selectRoad(e) {
    S.selection = { kind: 'road', ref: e };
    const road = MT.ROADS.find(r => r.id === e.roadId);
    const tr = S.traffic;
    const corr = tr ? tr.corridors.find(c => c.id === e.roadId) : null;
    openCtx('Road', `
      <div class="sec"><h3>${esc(e.name)} <span class="tag limited">limited</span></h3>
        <p class="note">Corridor-level centreline. Lane geometry, junctions and local streets are not modelled.</p></div>
      <dl class="kv">
        <dt>Class</dt><dd class="txt">${esc(e.cls)}</dd>
        <dt>Lanes each way</dt><dd>${e.lanes}</dd>
        <dt>Free-flow speed</dt><dd>${e.speed} km/h</dd>
        <dt>Modelled capacity</dt><dd>${n0(e.cap)} veh/h</dd>
        <dt>Corridor length</dt><dd>${corr ? n1(corr.km) + ' km' : '—'}</dd>
        <dt>Volume/capacity</dt><dd style="color:${corr && corr.vc > 1 ? 'var(--crit)' : corr && corr.vc > 0.8 ? 'var(--warn)' : 'inherit'}">${corr ? n2(corr.vc) : 'run traffic model'}</dd>
        <dt>Status</dt><dd class="txt">${e.closed ? 'CLOSED in scenario' : 'Open'}</dd>
        ${e.tunnel ? `<dt>Level</dt><dd class="txt">Underground · ${esc(e.tunnel)} (OSM)</dd>` : e.flyover ? '<dt>Level</dt><dd class="txt">Flyover</dd>' : e.bridge ? '<dt>Level</dt><dd class="txt">Bridge</dd>' : ''}
      </dl>
      <div class="btnrow">
        <button class="btn danger" id="rClose">Close this corridor</button>
        <button class="btn" id="rZoom">Follow corridor</button>
      </div>`);
    $('#rClose').onclick = () => { openSim('traffic'); $('#tRoad').value = e.roadId; runTraffic(e.roadId); };
    $('#rZoom').onclick = () => {
      const p = geo.pathXY(road.path);
      R.flyTo({ tx: p[Math.floor(p.length / 4) * 2], ty: p[Math.floor(p.length / 4) * 2 + 1], dist: 6500, pitch: 0.6 }, 1100);
    };
    R.invalidate();
  }

  function showAreaStats(rect) {
    const s = sim.areaStats(rect);
    openCtx('Selected area', `
      <div class="tiles">
        <div class="tile acc"><div class="l">Area</div><div class="v">${n2(s.areaKm2)}</div><div class="u">km² (${n2(s.landKm2)} land)</div></div>
        <div class="tile"><div class="l">Structures</div><div class="v">${n0(s.buildings)}</div><div class="u">simulated</div></div>
        <div class="tile"><div class="l">Road network</div><div class="v">${n1(s.roadKm)}</div><div class="u">km arterial</div></div>
        <div class="tile ${s.floodPct > 20 ? 'crit' : ''}"><div class="l">Flooded (scenario)</div><div class="v">${S.flood ? n0(s.floodPct) : '—'}</div><div class="u">% of land</div></div>
      </div>
      <dl class="kv">
        <dt>Estimated population</dt><dd class="txt" style="color:var(--crit)">DATA SOURCE REQUIRED</dd>
        <dt>Built footprint</dt><dd>${n2(s.builtAreaKm2)} km²</dd>
        <dt>Total floors</dt><dd>${n0(s.floors)}</dd>
        <dt>Mean height</dt><dd>${n1(s.meanHeight)} m</dd>
        <dt>Hospitals</dt><dd>${s.hospitals}</dd>
        <dt>Schools (sim)</dt><dd>${s.schools}</dd>
        <dt>Fire stations</dt><dd>${s.fire}</dd>
        <dt>Metro stations</dt><dd>${s.metro}</dd>
        <dt>Rail stations</dt><dd>${s.rail}</dd>
        <dt>Green cover</dt><dd>${n1(s.greenPct)}%</dd>
        <dt>Land below 4 m</dt><dd>${n0(s.lowPct)}%</dd>
        <dt>Density index</dt><dd>${n2(s.densityIndex)}</dd>
      </dl>
      <p class="note crit">Population is withheld deliberately. No census dataset is connected, and the platform does not convert its simulated density surface into head counts.</p>`);
  }

  function openCtx(title, html) {
    $('#ctxTitle').textContent = title;
    $('#ctxBody').innerHTML = html;
    $('#context').classList.remove('hidden');
    $('#ctxBody').scrollTop = 0;
  }
  $('#ctxClose').onclick = () => { $('#context').classList.add('hidden'); S.selection = null; stopFollow(true); R.invalidate(); };

  /* ==================================================== MAP INPUT ======== */
  MT.onClick = function (sx, sy) {
    const w = R.unproject(sx, sy);
    if (S.tool && ['distance', 'area', 'radius'].includes(S.tool)) {
      if (!w) return;
      S.measure.pts.push(w); updateMeasure(); R.invalidate(); return;
    }
    if (S.tool === 'select') {
      if (!w) return;
      if (!S.areaSel || S.areaSel.done) S.areaSel = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, done: false };
      else { S.areaSel.x1 = w.x; S.areaSel.y1 = w.y; S.areaSel.done = true; showAreaStats(S.areaSel); setTool(null); }
      R.invalidate(); return;
    }
    if (placeMode && w) {
      if (placeMode === 'infra') placeInfra(w); else placeBuilding(w);
      placeMode = null; return;
    }
    if (pickMode && w) { runEmergency(w); pickMode = null; return; }

    hoverHide();
    const ac = MT.motion && MT.motion.pickAircraft ? MT.motion.pickAircraft(sx, sy) : -1;
    if (ac >= 0) { selectAircraft(ac, true); return; }
    const tw = R.pickTwin(sx, sy);
    if (tw) { selectTwin(tw); return; }
    const pl = R.pickPlace && R.pickPlace(sx, sy);
    if (pl) { selectPlace(pl); return; }
    const m = R.pickMarker(sx, sy);
    if (m) { selectPoint(m); return; }
    const b = R.pickBuilding(sx, sy);
    if (b) { selectBuilding(b); return; }
    const e = R.pickRoad(sx, sy);
    if (e) { selectRoad(e); return; }
    if (w) {
      const k = city.cellIndex(w.x, w.y);
      if (k >= 0 && city.land[k]) showZone(city.zoneOf[k]);
    }
  };

  let hoverW = null;
  /* ---- hover: the building under the cursor lights up and a card is pinned
     to its roof. One pick per animation frame, however fast the mouse moves. */
  const hoverCard = document.createElement('div');
  hoverCard.id = 'hoverCard'; hoverCard.className = 'hovercard';
  hoverCard.setAttribute('aria-hidden', 'true');
  $('#stage').appendChild(hoverCard);
  let hoverPending = null, hoverRaf = 0, hoverKey = null;
  const USE_ICON = {
    Residential: '<path d="M4 11l8-6 8 6v9H4z"/><path d="M10 20v-5h4v5"/>',
    Commercial: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
    Industrial: '<path d="M3 20V10l6 3V10l6 3V6h4v14z"/>',
    Institutional: '<path d="M3 9l9-5 9 5M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20h18"/>',
    'Mixed use': '<rect x="4" y="9" width="7" height="11"/><rect x="11" y="4" width="9" height="16"/>',
    twin: '<rect x="5" y="4" width="14" height="16" rx="1"/><path d="M5 9h14M5 14h14M12 4v16"/>'
  };
  function hoverHide() {
    if (S.hover) { S.hover = null; R.invalidate(); }
    hoverKey = null;
    hoverCard.classList.remove('on');
    $('#map').style.cursor = '';
  }
  function hoverPick() {
    hoverRaf = 0;
    const h = hoverPending; hoverPending = null;
    if (!h) return;
    const busy = document.body.classList.contains('landing') || S.tool || placeMode || pickMode || h.drag;
    if (busy) { hoverHide(); return; }
    const hit = R.pickTwin(h.x, h.y) || R.pickBuilding(h.x, h.y);
    if (!hit) { hoverHide(); return; }
    $('#map').style.cursor = 'pointer';
    if (hit === S.hover) return;
    S.hover = hit; R.invalidate();
    const twin = !!hit.floors && !!hit.area && typeof hit.area === 'string';
    const key = twin ? hit.id : hit.id;
    if (key === hoverKey) return;
    hoverKey = key;
    if (twin) {
      hoverCard.innerHTML = `
        <div class="hc-head"><svg viewBox="0 0 24 24">${USE_ICON.twin}</svg>
          <div><b>${esc(hit.area)}</b><span>Building twin · ${esc(hit.id)}</span></div></div>
        <dl><dt>Floors</dt><dd>${hit.floors} + basement</dd>
            <dt>Height</dt><dd>${n1(hit.floors * 4.2)} m</dd>
            <dt>Floor area</dt><dd>${n0(hit.w * hit.d * hit.floors)} m²</dd>
            <dt>Systems</dt><dd>5 services drawn</dd></dl>
        <div class="hc-foot"><i class="tag sim">demo</i>Illustrative · click for details</div>`;
    } else {
      const zone = city.zones[hit.zone];
      hoverCard.innerHTML = `
        <div class="hc-head"><svg viewBox="0 0 24 24">${USE_ICON[hit.use] || USE_ICON.Commercial}</svg>
          <div><b>${esc(hit.use)}</b><span>${esc(hit.id)}${zone ? ' · ' + esc(zone.name) : ''}</span></div></div>
        <dl><dt>Height</dt><dd>${n1(hit.h)} m</dd>
            <dt>Floors</dt><dd>${hit.floors}</dd>
            <dt>Floor area</dt><dd>${n0(hit.area * hit.floors)} m²</dd>
            <dt>Built</dt><dd>${hit.year}</dd></dl>
        <div class="hc-foot"><i class="tag sim">simulated</i>Generated structure · click for details</div>`;
    }
  }
  MT.onHover = function (w, sx, sy, dragging) {
    hoverW = w;
    if (sx !== undefined) {
      hoverPending = { x: sx, y: sy, drag: dragging };
      if (!hoverRaf) hoverRaf = requestAnimationFrame(hoverPick);
    }
    if (!w) return;
    $('#coordOut').textContent = geo.fmtLatLon(geo.lon(w.x), geo.lat(w.y));
    if (S.tool === 'select' && S.areaSel && !S.areaSel.done) { S.areaSel.x1 = w.x; S.areaSel.y1 = w.y; R.invalidate(); }
  };
  $('#map').addEventListener('pointerleave', hoverHide);
  function placeHoverCard() {
    const A = R.hoverAnchor;
    if (!S.hover || !A) { hoverCard.classList.remove('on'); return; }
    const st = $('#stage').getBoundingClientRect();
    const w = hoverCard.offsetWidth || 200, h = hoverCard.offsetHeight || 120;
    const x = Math.max(8, Math.min(st.width - w - 8, A.x - w / 2));
    const y = Math.max(8, Math.min(st.height - h - 8, A.y - h - 6));
    hoverCard.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    hoverCard.classList.add('on');
  }
  const btn3D = $('#btn3D');
  MT.onFrame = function (info) {
    placeHoverCard();
    /* keep the 3D/2D button honest when a preset or tour changes the pitch */
    const lbl = R.is2D() ? '2D' : '3D';
    if (btn3D.textContent !== lbl) { btn3D.textContent = lbl; btn3D.classList.toggle('on', lbl === '3D'); }
    const sb = R.scaleBar();
    $('#scaleBar').style.width = Math.max(30, Math.min(150, sb.px)) + 'px';
    $('#scaleLabel').textContent = sb.label;
    $('#needle').style.transform = 'rotate(' + (MT.cam.yaw * 180 / Math.PI) + 'deg)';
    $('#perfOut').textContent = info.ms.toFixed(1) + ' ms · ' + n0(info.items) + ' objects';
    hudFrame();
    const vx = S.vscale || 1;
    $('#vexOut').hidden = vx < 1.05;
    $('#vexOut').textContent = 'Heights ×' + vx.toFixed(1) + ' (display)';
  };

  /* ---- tools ---- */
  function setTool(t) {
    S.tool = t;
    S.measure = { pts: [], done: false };
    if (t && t !== 'select') S.areaSel = null;   // setTool(null) keeps a finished selection visible
    $$('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    $('#measureOut').hidden = !t;
    if (t) updateMeasure();
    R.invalidate();
  }
  $$('[data-tool]').forEach(b => b.onclick = () => setTool(S.tool === b.dataset.tool ? null : b.dataset.tool));
  function updateMeasure() {
    const p = S.measure.pts, t = S.tool;
    let txt = '';
    if (t === 'distance') {
      let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      const e0 = p.length ? city.elevAt(p[0].x, p[0].y) : 0, e1 = p.length ? city.elevAt(p[p.length - 1].x, p[p.length - 1].y) : 0;
      txt = p.length < 2 ? 'Click points to measure distance' :
        geo.fmtDist(L) + ' · ' + (p.length - 1) + ' segment' + (p.length > 2 ? 's' : '') +
        ' · Δ elevation ' + (e1 - e0).toFixed(1) + ' m (simulated)';
    } else if (t === 'area') {
      if (p.length < 3) txt = 'Click at least three points to measure area';
      else {
        const ring = []; p.forEach(q => ring.push(q.x, q.y));
        txt = geo.fmtArea(geo.ringArea(Float64Array.from(ring))) + ' · ' + p.length + ' vertices';
      }
    } else if (t === 'radius') {
      txt = p.length < 2 ? 'Click a centre, then a point on the circle' :
        (() => { const r = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
          return 'r = ' + geo.fmtDist(r) + ' · area ' + geo.fmtArea(Math.PI * r * r); })();
    } else if (t === 'select') {
      txt = !S.areaSel ? 'Click one corner, then the opposite corner' : 'Click the opposite corner';
    }
    $('#measureOut').innerHTML = `<span>${esc(txt)}</span><button id="mClear">Clear</button><button id="mDone">Done</button>`;
    $('#mClear').onclick = () => { S.measure.pts = []; S.areaSel = null; updateMeasure(); R.invalidate(); };
    $('#mDone').onclick = () => setTool(null);
  }

  $('#btnZoomIn').onclick = () => R.zoom(0.72);
  $('#btnZoomOut').onclick = () => R.zoom(1.38);
  $('#compass').onclick = () => R.flyTo({ yaw: 0 }, 600);
  $('#btn3D').onclick = function () {
    const to2D = !R.is2D();
    R.flyTo({ pitch: to2D ? 1.50 : 0.82, yaw: to2D ? 0 : MT.cam.yaw }, 700);
    this.textContent = to2D ? '2D' : '3D';
    this.classList.toggle('on', !to2D);
  };
  /* The legend starts hidden; the key button shows it. The choice is kept
     for this viewer when the browser allows it. */
  let legendOn = false;
  try { legendOn = localStorage.getItem('mt.legend') === '1'; } catch (e) { /* storage blocked */ }
  function applyLegend() {
    document.body.classList.toggle('legend-off', !legendOn);
    $('#btnLegend').classList.toggle('on', legendOn);
    $('#btnLegend').title = legendOn ? 'Hide the map key' : 'Show the map key';
  }
  $('#btnLegend').onclick = () => {
    legendOn = !legendOn; applyLegend();
    try { localStorage.setItem('mt.legend', legendOn ? '1' : '0'); } catch (e) { /* storage blocked */ }
  };
  applyLegend();
  $('#btnStyle').onclick = function () {
    S.style = S.style === 'holo' ? 'lit' : 'holo';
    this.classList.toggle('on', S.style === 'holo');
    this.textContent = S.style === 'holo' ? '\u25C8' : '\u25C7';
    this.title = S.style === 'holo' ? 'Hologram style — switch to lit' : 'Lit style — switch to hologram';
    R.markGround(); buildLegend();
    toast(S.style === 'holo' ? 'Hologram style' : 'Lit style — sun, shadows and materials');
  };
  $('#btnLabels').onclick = function () {
    S.labels = !S.labels; this.classList.toggle('on', S.labels); R.invalidate();
  };

  /* ==================================================== SEARCH =========== */
  const sInput = $('#globalSearch'), sBox = $('#searchResults');
  let sIdx = -1, sHits = [];
  sInput.addEventListener('input', () => {
    const q = sInput.value.trim().toLowerCase();
    if (q.length < 2) { sBox.hidden = true; return; }
    sHits = city.searchables
      .map(s => {
        const n = s.name.toLowerCase();
        const i = n.indexOf(q);
        return i < 0 ? null : { s, score: (i === 0 ? 0 : 10) + i + n.length * 0.05 };
      })
      .filter(Boolean).sort((a, b) => a.score - b.score).slice(0, 14).map(x => x.s);
    if (!sHits.length) {
      sBox.innerHTML = `<button disabled style="color:var(--txt-4)">Nothing in the twin matches “${esc(sInput.value)}”</button>`;
    } else {
      sBox.innerHTML = sHits.map((h, i) =>
        `<button data-i="${i}"><span>${esc(h.name)}${h.sub ? ` <span class="s">${esc(h.sub)}</span>` : ''}</span><span class="k">${esc(h.kind)}</span></button>`).join('');
      sBox.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => goSearch(sHits[+b.dataset.i]));
    }
    sIdx = -1; sBox.hidden = false;
  });
  sInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { sBox.hidden = true; sInput.blur(); return; }
    if (!sHits.length || sBox.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sIdx = (sIdx + (e.key === 'ArrowDown' ? 1 : sHits.length - 1)) % sHits.length;
      sBox.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === sIdx));
    } else if (e.key === 'Enter') { e.preventDefault(); goSearch(sHits[Math.max(0, sIdx)]); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('#searchWrap')) sBox.hidden = true; });
  function goSearch(h) {
    if (!h) return;
    sBox.hidden = true; sInput.value = h.name; sInput.blur();
    R.flyTo({ tx: h.x, ty: h.y, dist: h.zoom || 4000, pitch: 0.75 }, 1300);
    /* each kind of result opens its own card (audit #11) */
    if (h.ref) { selectPoint(h.ref); return; }
    if (h.kind === 'Road') {
      const road = MT.ROADS.find(r => r.name === h.name);
      let best = null, bd = Infinity;
      if (road) for (const e of city.graph.edges) {
        if (e.roadId !== road.id) continue;
        const A = city.graph.nodes[e.a], B = city.graph.nodes[e.b];
        const d = geo.distToSeg(h.x, h.y, A.x, A.y, B.x, B.y);
        if (d < bd) { bd = d; best = e; }
      }
      if (best) { selectRoad(best); return; }
    }
    if (h.kind === 'Landmark') {
      const lm = city.landmarks.find(l => l.name === h.name);
      if (lm) { selectPoint(lm); return; }
    }
    if (h.kind === 'Area') {
      const zi = city.zones.findIndex(z => z.name === h.name);
      if (zi >= 0) { showZone(zi); return; }
    }
    const k = city.cellIndex(h.x, h.y); if (k >= 0) showZone(city.zoneOf[k]);
  }
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== sInput && !/input|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault(); sInput.focus();
    }
    if (e.key === 'Escape') { if (present.on) exitPresent(); }
  });

  /* ==================================================== LEGEND =========== */
  function buildLegend() {
    const parts = [];
    if (S.flood && MT.layerOn('floodzone')) {
      parts.push(`<h4>Flood depth (simulated)</h4>
        <div class="grad" style="background:linear-gradient(90deg,rgba(60,140,235,.35),rgba(40,90,210,.9))"></div>
        <div class="ends"><span>0.10 m</span><span>1.2 m+</span></div>`);
    }
    const SURFLEG = {
      relief: ['Elevation (synthetic)', 'linear-gradient(90deg,#122636,#3E4A3A,#8C9474)', '0 m', '300 m+'],
      density: ['Density index (simulated)', 'linear-gradient(90deg,#101A28,#287A8E,#96A05C,#EE7F45)', 'low', 'high'],
      floodrisk: ['Baseline flood exposure', 'linear-gradient(90deg,#142230,#3C5AA0)', 'low', 'high'],
      heat: ['Heat pattern (illustrative)', 'linear-gradient(90deg,#16223A,#3C6078,#C89646,#E05848)', 'cooler', 'hotter'],
      air: ['Air pattern (illustrative)', 'linear-gradient(90deg,#1E5A50,#788C46,#C88C3C,#C8505A)', 'better', 'worse'],
      zones: ['Analysis zones', 'linear-gradient(90deg,#3B7A56,#6B5A9A,#9A6A4A)', '', '']
    };
    const sl = SURFLEG[S.surface];
    if (sl) parts.push(`<h4>${sl[0]}</h4><div class="grad" style="background:${sl[1]}"></div>
      <div class="ends"><span>${sl[2]}</span><span>${sl[3]}</span></div>`);
    if (S.iso && MT.layerOn('isochrone')) {
      parts.push(`<h4>Response time from stations</h4>` +
        [['#3FBE84', 'Within 5 min'], ['#9AC860', '5 – 10 min'], ['#EDAE45', '10 – 15 min'],
         ['#EC5F70', 'Over 15 min'], ['#5C6076', 'Not reached']]
          .map(([c, l]) => `<div class="row"><span class="sw" style="background:${c}"></span>${l}</div>`).join(''));
    }
    if (S.style === 'holo') {
      parts.push(`<h4>Hologram key</h4>` +
        [['#3FD3E6', 'Buildings'], ['#FFB04C', 'Roads'], ['#78FFD2', 'Vehicles (simulated)'], ['#8B7BF0', 'Railway guideway'], ['#FFC84A', 'Trains (simulated)'], ['#FFD27A', 'Building twins (demo)'], ['#FFE8BC', 'Heritage models'], ['#A6F2FF', 'Vessels (simulated)']]
          .map(([c, l]) => `<div class="row"><span class="sw" style="background:${c}"></span>${l}</div>`).join(''));
      parts.push(`<h4>Building use</h4>` +
        [['#60E2F8', 'Residential'], ['#6EB2FF', 'Commercial'], ['#6ED6FA', 'Mixed use'], ['#96B0CE', 'Industrial'], ['#CDE4FF', 'Institutional']]
          .map(([c, l]) => `<div class="row"><span class="sw" style="background:${c}"></span>${l}</div>`).join(''));
    }
    if (MT.layerOn('odflows')) {
      parts.push(`<h4>Demand arcs</h4><div class="row"><span class="sw" style="background:#8B7BF0"></span>Modelled trips between zones</div>`);
    }
    if (S.traffic && MT.layerOn('congestion')) {
      parts.push(`<h4>Modelled V/C</h4>` +
        [['#3FBE84', '< 0.55'], ['#9ABE58', '0.55 – 0.78'], ['#EDAE45', '0.78 – 0.95'], ['#EE7F45', '0.95 – 1.15'], ['#EC5F70', '> 1.15']]
          .map(([c, l]) => `<div class="row"><span class="sw" style="background:${c}"></span>${l}</div>`).join(''));
    }
    const pts = [];
    if (MT.layerOn('hospitals')) pts.push(['#EC5F70', 'Hospital']);
    if (MT.layerOn('fire')) pts.push(['#EE7F45', 'Fire station']);
    if (MT.layerOn('stations')) pts.push(['#3FD3E6', 'Metro'], ['#EDAE45', 'Suburban rail']);
    if (MT.layerOn('projects')) pts.push(['#77E4AE', 'Project']);
    if (MT.layerOn('banks')) pts.push(['#F2C46D', 'Bank / exchange HQ']);
    if (pts.length) parts.push('<h4>Points</h4>' + pts.map(([c, l]) =>
      `<div class="row"><span class="sw" style="background:${c};border-radius:50%;width:9px"></span>${l}</div>`).join(''));
    $('#legend').innerHTML = parts.join('');
  }

  /* ==================================================== HUD READOUTS ===== */
  /* Three glass panels pinned over the city. Everything on them is read from
     the live model — they are instruments, not chrome. */
  const HUD_DEFS = [
    { id: 'form',  lon: 72.832, lat: 18.998, z: 520 },
    { id: 'road',  lon: 72.868, lat: 19.066, z: 560 },
    { id: 'scene', lon: 72.845, lat: 19.118, z: 600 }
  ];
  MT.HUD = HUD_DEFS.map(d => ({ x: geo.x(d.lon), y: geo.y(d.lat), z: d.z, id: d.id, vis: false }));
  $('#hud').innerHTML = HUD_DEFS.map(d => `<div class="hudcard" id="hud-${d.id}"></div>`).join('');
  const hudEl = {}; HUD_DEFS.forEach(d => hudEl[d.id] = $('#hud-' + d.id));
  let hudTick = 0;

  function hudContent() {
    /* built form around the anchor */
    const a = MT.HUD[0];
    const near = city.buildingIndex.within(a.x, a.y, 1500).map(h => h.item);
    const mean = near.length ? near.reduce((s2, b) => s2 + b.h, 0) / near.length : 0;
    const tallest = near.reduce((m, b) => Math.max(m, b.h), 0);
    const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
    near.forEach(b => buckets[Math.min(7, Math.floor(b.h / 22))]++);
    const bmax = Math.max(1, ...buckets);
    hudEl.form.innerHTML = `<h5>Built form · 1.5 km</h5>
      <div class="big">${n0(near.length)}</div><div class="sub">structures · simulated</div>
      <div class="spark">${buckets.map(v => `<s style="height:${Math.max(6, v / bmax * 100)}%"></s>`).join('')}</div>
      <div class="rows"><div class="r"><span>Mean height</span><span>${n0(mean)} m</span></div>
      <div class="r"><span>Tallest</span><span>${n0(tallest)} m</span></div></div>`;

    /* corridor loading */
    const tr = S.traffic;
    const corr = tr ? tr.corridors.slice(0, 3) : null;
    hudEl.road.innerHTML = `<h5>Corridor loading</h5>` + (corr
      ? `<div class="big">${n2(corr[0].vc)}</div><div class="sub">peak V/C · modelled</div>
         <div class="rows">${corr.map(c => `<div class="r"><span>${esc(c.name.slice(0, 22))}</span><span>${n2(c.vc)}</span>
           <i><b style="width:${Math.min(100, c.vc * 70)}%"></b></i></div>`).join('')}</div>`
      : `<div class="big">—</div><div class="sub">no assignment run</div>
         <div class="rows"><div class="r"><span>Modelled corridors</span><span>${MT.ROADS.length}</span></div>
         <div class="r"><span>Arterial network</span><span>${n0(city.roadKm)} km</span></div></div>`);

    /* scenario state */
    const f = S.flood;
    hudEl.scene.innerHTML = `<h5>Scenario state</h5>` + (f
      ? `<div class="big">${n1(f.areaKm2)}</div><div class="sub">km² standing water</div>
         <div class="rows"><div class="r"><span>Rainfall</span><span>${n0(f.params.rain)} mm</span></div>
         <div class="r"><span>Road impassable</span><span>${n1(f.roadKmImpassable)} km</span></div>
         <div class="r"><span>Hospitals hit</span><span>${f.hospitals.length}</span></div></div>`
      : `<div class="big">${n0(MT.motion ? MT.motion.counts().vehicles : 0)}</div><div class="sub">road agents live</div>
         <div class="rows"><div class="r"><span>Verified sources</span><span>0</span></div>
         <div class="r"><span>Clock</span><span>${hhmm(S.tod * 60)}</span></div></div>`);
  }

  function hudFrame() {
    const on = S.style === 'holo';
    for (let i = 0; i < MT.HUD.length; i++) {
      const a = MT.HUD[i], el = hudEl[a.id];
      if (!on || !a.vis) { el.classList.remove('on'); a.shownAt = 0; a.expired = false; continue; }
      /* each card shows for one second when it comes into view, then fades
         out (stalk included) until it leaves the view and returns */
      const now = performance.now();
      if (!a.shownAt) { a.shownAt = now; setTimeout(() => R.invalidate(), 1050); }
      if (now - a.shownAt > 1000) { a.expired = true; el.classList.remove('on'); continue; }
      el.style.transform = 'translate(-50%,-100%) translate(' + a.sx.toFixed(1) + 'px,' + (a.sy - 10).toFixed(1) + 'px)';
      el.classList.add('on');
    }
    if (++hudTick % 30 === 0) hudContent();
  }
  hudContent();

  /* ==================================================== TIMELINE ========= */
  /* One slider, three jobs: the time of day that drives the lighting and the
     crowding model, the elapsed time through a storm scenario, and the long
     view across development years. */
  const YEARS = [2010, 2015, 2020, 2025, 2030, 2040, 2050];
  const tSlider = $('#timeSlider');
  let tlMode = 'clock', playT = null;
  let storm = null;                     // {params, fraction}

  const MODES = {
    clock: { label: 'Time of day', min: 0, max: 1439, step: 5,
             ticks: ['00:00', '06:00', '12:00', '18:00', '24:00'] },
    storm: { label: 'Storm elapsed', min: 0, max: 100, step: 1,
             ticks: ['start', '25%', '50%', '75%', 'end'] },
    years: { label: 'Development year', min: 0, max: YEARS.length - 1, step: 1,
             ticks: YEARS.map(String) }
  };

  function hhmm(mins) {
    const h = Math.floor(mins / 60) % 24, m = Math.floor(mins % 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function setTlMode(m) {
    if (m === 'storm' && !storm) { toast('Run a flood scenario first — then you can scrub through it.'); return; }
    stopPlay();
    tlMode = m;
    $('#tlMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tl === m));
    const d = MODES[m];
    $('#tlLabel').textContent = d.label;
    tSlider.min = d.min; tSlider.max = d.max; tSlider.step = d.step;
    $('#timeTicks').innerHTML = d.ticks.map(t => `<span>${t}</span>`).join('');
    tSlider.value = m === 'clock' ? Math.round(S.tod * 60)
                  : m === 'storm' ? Math.round((storm ? storm.fraction : 1) * 100)
                  : YEARS.indexOf(S.year) < 0 ? 3 : YEARS.indexOf(S.year);
    applyTl();
  }

  function applyTl() {
    const v = +tSlider.value;
    if (tlMode === 'clock') {
      S.tod = v / 60;
      $('#tlValue').textContent = hhmm(v);
      R.invalidate();
    } else if (tlMode === 'storm' && storm) {
      storm.fraction = Math.max(0.01, v / 100);
      const elapsed = storm.params.hours * storm.fraction;
      $('#tlValue').textContent = 'T+' + elapsed.toFixed(1) + ' h / ' + storm.params.hours + ' h';
      const r = sim.floodAt(storm.params, storm.fraction);
      S.flood = r; R.markGround();
      renderFloodOut(r, true);
      if (MT.motion) MT.motion.resync();
    } else if (tlMode === 'years') {
      const y = YEARS[v];
      S.year = y;
      $('#tlValue').textContent = String(y);
      const future = y > 2026;
      $('#simChipText').textContent = future ? 'Projection · ' + y : 'Demo dataset · ' + y;
      $('#chipSim').querySelector('.dot').className = 'dot ' + (future ? 'sim' : 'limited');
      R.invalidate();
    }
    updateSimState();
  }
  tSlider.oninput = applyTl;
  $('#tlMode').querySelectorAll('button').forEach(b => b.onclick = () => setTlMode(b.dataset.tl));

  /* The play loop captures its mode's step and limit, so anything that
     changes mode or leaves the app must stop it first (audit #1). */
  function stopPlay() {
    if (playT) { clearInterval(playT); playT = null; $('#playBtn').textContent = '▶'; updateSimState(); }
  }
  $('#playBtn').onclick = function () {
    if (playT) { stopPlay(); return; }
    this.textContent = '❚❚';
    setTimeout(updateSimState, 0);
    const d = MODES[tlMode];
    const stepMs = tlMode === 'clock' ? 60 : tlMode === 'storm' ? 110 : 1100;
    const stepBy = tlMode === 'clock' ? 6 : tlMode === 'storm' ? 2 : 1;
    playT = setInterval(() => {
      let v = +tSlider.value + stepBy;
      if (v > d.max) {
        if (tlMode === 'clock') v = d.min;
        else { clearInterval(playT); playT = null; $('#playBtn').textContent = '▶'; v = d.max; }
      }
      tSlider.value = v; applyTl();
    }, stepMs);
  };

  /* Stop: the flood tab's own Stop ends the rain playback and clears the
     flood; Stop all clears every running scenario and the timeline. */
  function stopFlood() {
    stopPlay();
    if (tlMode === 'storm') setTlMode('clock');
    storm = null;
    if (S.flood) { S.flood = null; R.markGround(); }
    $('#floodOut').innerHTML = '';
    if ($('#tFlood').classList.contains('on') && S.traffic) $('#tReset').click();
    updateSimState(); buildLegend(); R.invalidate();
  }
  function stopAllSims() {
    stopFlood();
    ['#tReset', '#eClear', '#eCoverClear', '#iClear'].forEach(id => { const b = $(id); if (b) b.click(); });
    S.highlight = null; S.routes = [];
    updateSimState(); buildLegend(); R.invalidate();
    toast('All simulations stopped');
  }
  $('#fStop').onclick = () => { stopFlood(); toast('Flood simulation stopped'); };
  $('#simStopAll').onclick = stopAllSims;
  ui.stopAllSims = stopAllSims;

  function updateSimState() {
    const bits = [];
    if (S.year > 2026) bits.push('Projection ' + S.year + ' — scenario, not forecast');
    if (S.flood) bits.push('Flood ' + Math.round(S.flood.params.rain) + ' mm / ' + S.flood.params.hours.toFixed(1) + ' h');
    if (S.traffic) bits.push(S.traffic.closed.length ? 'Closure: ' + S.traffic.closed.join(', ') : 'Traffic baseline');
    if (S.iso) bits.push('Coverage bands' + (S.iso.withFlood ? ' (flooded)' : ''));
    $('#simStateText').textContent = bits.length ? bits.join(' · ') : 'No scenario running';
    const running = bits.length > 0 || !!playT || (S.routes && S.routes.length > 0) || (S.placed && S.placed.length > 0);
    $('#simRunBar').hidden = !running;
    $('#simRunText').textContent = bits.length ? bits.join(' · ') : 'Scenario on the map';
  }

  /* ==================================================== PRESENTATION ===== */
  /* A 2-minute guided story, in plain words: the city, a monsoon flood, the
     roads it closes, what that does to traffic and to an ambulance, a new
     station, and the report. Plays on its own; Back / Next / Pause steer it. */
  const STEP_MS = 13000;
  const STEPS = [
    { t: 'Meet the twin', b: `A live 3D model of the whole Mumbai region, Virar to Panvel. Roads, railways, metro, ${n0(Math.round(city.buildings.length / 100) * 100)} buildings — all simulated for this demo, and labelled as such.`,
      run: () => { S.surface = 'relief'; R.markGround(); setPane('explore'); buildLegend(); R.flyTo(VIEWS[0][1], 1800); setTimeout(() => R.setSpin(0.0009), 1850); } },
    { t: 'A city in motion', b: 'Local trains stop at stations, metros run on their viaducts, cars follow the traffic model and ships work the harbour. The moving city is the model made visible.',
      run: () => { S.surface = 'relief'; R.markGround(); setPane('explore'); R.flyTo({ tx: geo.x(72.8445), ty: geo.y(19.0200), dist: 2400, pitch: 0.55, yaw: 0.6 }, 1800); setTimeout(() => R.setSpin(0.0006), 1850); } },
    { t: 'Heavy rain: 200 mm in 6 hours', b: 'We drop a monsoon storm on the city at high tide. Water collects in the low-lying areas — the blue shows how deep it gets.',
      run: () => { openSim('flood'); R.flyTo({ tx: geo.x(72.860), ty: geo.y(19.03), dist: 13000, pitch: 0.78, yaw: -0.15 }, 1600); setTimeout(() => { $('#fPreset').click(); ui.animateRain(); }, 500); } },
    { t: 'Roads close, hospitals at risk', b: 'The twin lists every main road that becomes impassable, and every hospital and station standing in flood water. A picture becomes a decision.',
      run: () => { if (!S.flood) { openSim('flood'); $('#fPreset').click(); } else openSim('flood'); R.flyTo({ tx: geo.x(72.855), ty: geo.y(19.035), dist: 6500, pitch: 0.62, yaw: 0.25 }, 1600); } },
    { t: 'An ambulance during the flood', b: 'A call comes from Wadala. The twin routes the ambulance around flooded roads to Sion Hospital, and sends a fire appliance from the closest fire station.',
      run: () => { openSim('emergency'); if (!$('#eAvoid').classList.contains('on')) $('#eAvoid').click(); setTimeout(() => runEmergency({ x: geo.x(72.862), y: geo.y(19.018) }), 500); } },
    { t: 'Close a bridge, see the traffic', b: 'Shut the Bandra–Worli Sea Link. Traffic spreads to other roads — red and orange show where it jams, and journey times change.',
      run: () => { S.routes = []; S.highlight = null; openSim('traffic'); $('#tRoad').value = 'BWSL'; R.flyTo({ tx: geo.x(72.830), ty: geo.y(19.03), dist: 9000, pitch: 0.55, yaw: 0.5 }, 1500); setTimeout(() => ui.runTraffic('BWSL'), 700); } },
    { t: 'Plan a new metro station', b: 'Drop a station anywhere. The twin shows who it would serve and which areas no station reaches today.',
      run: () => { openSim('infra'); const w = { x: geo.x(72.893), y: geo.y(19.155) }; R.flyTo({ tx: w.x, ty: w.y, dist: 6000, pitch: 0.72, yaw: -0.1 }, 1500); setTimeout(() => placeInfra(w), 800); } },
    { t: 'Ask the city', b: 'Mumbai AI answers questions from the model itself — and says so when it has no data, instead of guessing.',
      run: () => { setPane('ai'); setTimeout(() => ask('Which areas have high density but poor public transport access?'), 400); } },
    { t: 'A report you can hand over', b: 'Every scenario becomes a report: what was tested, the assumptions, the limits and the data behind it — ready for a planning meeting.',
      run: () => { const rep = sim.report('flood') || sim.report('analytics'); lastReport = rep; setPane('reports'); renderReport(rep); R.flyTo(VIEWS[0][1], 1800); setTimeout(() => R.setSpin(0.0006), 1850); } }
  ];
  const present = { on: false, i: 0, auto: true, t0: 0, raf: 0, paused: 0 };
  $('#pDots').innerHTML = STEPS.map(() => '<i></i>').join('');
  function tick() {
    if (!present.on) return;
    present.raf = requestAnimationFrame(tick);
    const bar = $('#presentTop').firstElementChild;
    if (!present.auto) return;
    const k = Math.min(1, (performance.now() - present.t0) / STEP_MS);
    bar.style.width = ((present.i + k) / STEPS.length * 100) + '%';
    $('#pTimer').style.width = (k * 100) + '%';
    if (k >= 1) { if (present.i === STEPS.length - 1) { setAuto(false); } else nextStep(1); }
  }
  function setAuto(on) {
    if (on && !present.auto) present.t0 = performance.now() - present.paused;
    if (!on && present.auto) present.paused = performance.now() - present.t0;
    present.auto = on;
    $('#pPlay').textContent = on ? '❚❚ Pause' : '▶ Play';
    $('#presentCard').classList.toggle('paused', !on);
  }
  function enterPresent() {
    if (document.body.classList.contains('landing')) leaveLanding();
    present.on = true; present.i = -1; present.auto = false; present.paused = 0;
    $('#present').classList.remove('off');
    $('#context').classList.add('hidden');
    nextStep();
    setAuto(true);
    cancelAnimationFrame(present.raf); tick();
  }
  function exitPresent() {
    stopPlay();
    present.on = false; cancelAnimationFrame(present.raf);
    $('#present').classList.add('off'); R.setSpin(0);
  }
  function nextStep(dir) {
    present.i = Math.max(0, Math.min(STEPS.length - 1, present.i + (dir === -1 ? -1 : 1)));
    const s = STEPS[present.i];
    $('#presentStep').textContent = 'Step ' + (present.i + 1) + ' of ' + STEPS.length;
    $('#presentTitle').textContent = s.t;
    $('#presentBody').textContent = s.b;
    $('#presentTop').firstElementChild.style.width = (present.i / STEPS.length * 100) + '%';
    $('#pDots').querySelectorAll('i').forEach((d, i) => { d.classList.toggle('on', i <= present.i); d.classList.toggle('cur', i === present.i); });
    $('#pNext').textContent = present.i === STEPS.length - 1 ? 'Finish' : 'Next →';
    const card = $('#presentCard'); card.classList.remove('swap'); void card.offsetWidth; card.classList.add('swap');
    present.t0 = performance.now(); present.paused = 0; $('#pTimer').style.width = '0%';
    R.setSpin(0);
    s.run();
  }
  $('#btnPresent').onclick = enterPresent;
  $('#pNext').onclick = () => { if (present.i === STEPS.length - 1) exitPresent(); else nextStep(1); };
  $('#pPrev').onclick = () => nextStep(-1);
  $('#pPlay').onclick = () => setAuto(!present.auto);
  $('#pExit').onclick = exitPresent;
  document.addEventListener('keydown', e => {
    if (!present.on || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight') $('#pNext').click();
    else if (e.key === 'ArrowLeft') nextStep(-1);
    else if (e.key === ' ') { e.preventDefault(); setAuto(!present.auto); }
    else if (e.key === 'Escape') exitPresent();
  });

  /* ==================================================== LANDING ========== */
  /* landing stats count up once, then hold their true values */
  const countUp = (id, v) => {
    const el = $(id); if (!el) return;
    const t0 = performance.now(), dur = 1400;
    el.textContent = n0(0);
    (function step(t) {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = n0(Math.round(v * e));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  };
  countUp('#fBuildings', city.buildings.length);
  countUp('#fRoads', Math.round(city.roadKm));
  countUp('#fStations', city.stations.length);
  countUp('#fZones', city.zones.length);
  const LANDING_CAM = { tx: geo.x(72.838), ty: geo.y(19.000), dist: 13800, pitch: 0.40, yaw: 0.78 };
  function leaveLanding() {
    $('#landing').classList.add('gone');
    document.body.classList.remove('landing');
    S.cinematic = false; S.labels = true;
    $('#btnLabels').classList.add('on');
    R.setSpin(0);
    R.setOffsetFrac(0, 0);
    /* Enter among the towers: a whole-city plan is one click away under
       Camera presets, but the first thing you should see is the city itself. */
    R.flyTo({ tx: geo.x(72.8335), ty: geo.y(18.9995), dist: 5600, pitch: 0.42, yaw: 0.72 }, 1900);
    setTimeout(() => R.invalidate(), 60);
  }
  const brandHome = $('#brandHome');
  if (brandHome) brandHome.onclick = e => { e.preventDefault(); R.flyTo(VIEWS[0][1], 1300); };
  /* Log out: end the session and go back to the start page. The next person
     in starts from the baseline city, so every scenario, placement, route and
     coverage band this session made is cleared on the way out. */
  function enterLanding() {
    if (present.on) exitPresent();
    stopPlay(); stopFollow(true);
    /* everything a session can leave behind, not only the scenarios (audit #6) */
    setTool(null); S.areaSel = null; placeMode = null; pickMode = null; pickTarget = null;
    S.hover = null;
    $('#context').classList.add('hidden'); S.selection = null; S.highlight = null;
    ['#tReset', '#eClear', '#eCoverClear', '#iClear'].forEach(id => { const b = $(id); if (b) b.click(); });
    if (S.flood) { S.flood = null; R.markGround(); }
    storm = null;
    S.year = 2026;
    $('#simChipText').textContent = 'Demo dataset';
    $('#chipSim').querySelector('.dot').className = 'dot sim';
    setTlMode('clock');
    scen.A = scen.B = null; scen.pending = null; lastReport = null;
    ['#floodOut', '#compareOut', '#coverOut', '#infraOut', '#buildOut', '#emergOut', '#trafficOut', '#aiLog']
      .forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
    /* switches back to their defaults: flood-closes-roads off, avoid-flood on */
    if ($('#tFlood').classList.contains('on')) $('#tFlood').click();
    if (!$('#eAvoid').classList.contains('on')) $('#eAvoid').click();
    updateSimState(); buildLegend();
    if (MT.motion && MT.motion.resync) MT.motion.resync();
    setPane('explore');
    document.body.classList.add('landing');
    $('#landing').classList.remove('gone');
    S.cinematic = true; S.labels = false;
    $('#btnLabels').classList.remove('on');
    R.setOffsetFrac(0.19, -0.03);
    R.flyTo(LANDING_CAM, 1500);
    setTimeout(() => R.setSpin(0.00032), 1550);
    /* replay the hero's entrance, so the page reads as arrived-at, not revealed */
    $$('.hero > *').forEach(el => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; });
    setTimeout(() => $('#btnExplore').focus({ preventScroll: true }), 700);
    toast('Signed out — scenarios cleared');
  }
  $('#railLogout').onclick = enterLanding;
  $('#mobileLogout').onclick = enterLanding;
  $('#btnExplore').onclick = leaveLanding;
  if ($('#btnDemo')) $('#btnDemo').onclick = () => { leaveLanding(); setTimeout(enterPresent, 480); };
  /* landing header: nav pills, log in, and the Mumbai AI chat bubble all enter the app */
  $('#btnLogin').onclick = leaveLanding;
  $$('#landing .lnav [data-go]').forEach(b => b.onclick = () => { leaveLanding(); setTimeout(() => setPane(b.dataset.go), 200); });
  if ($('#btnChat')) $('#btnChat').onclick = () => { leaveLanding(); setTimeout(() => setPane('ai'), 200); };

  /* ==================================================== MINI-MAP ========= */
  /* The whole region in 150 px: land, the rail lines, and a cone for where the
     camera is and which way it looks. Click to fly the camera there. */
  (function miniMap() {
    const box = $('#minimap'), cv = box.querySelector('canvas'), SZ = 150, DPR = Math.min(2, window.devicePixelRatio || 1);
    cv.width = SZ * DPR; cv.height = SZ * DPR; cv.style.width = cv.style.height = SZ + 'px';
    const g = cv.getContext('2d');
    const E = city.frameBox || city.extent;
    const pad = 6, sx = (SZ - pad * 2) / (E.x1 - E.x0), sy = (SZ - pad * 2) / (E.y1 - E.y0), k = Math.min(sx, sy);
    const ox = pad + ((SZ - pad * 2) - (E.x1 - E.x0) * k) / 2, oy = pad + ((SZ - pad * 2) - (E.y1 - E.y0) * k) / 2;
    const X = x => ox + (x - E.x0) * k, Y = y => SZ - (oy + (y - E.y0) * k);   // north up
    const base = document.createElement('canvas'); base.width = cv.width; base.height = cv.height;
    const b = base.getContext('2d'); b.scale(DPR, DPR);
    b.fillStyle = '#0B1A36'; b.fillRect(0, 0, SZ, SZ);
    /* land from the model's own 200 m grid, so it matches the 3D view exactly */
    const Gd = city.grid, cs = Gd.cell * k + 0.6;
    for (let j = 0; j < Gd.h; j++) for (let i = 0; i < Gd.w; i++) {
      const q = j * Gd.w + i; if (!city.land[q]) continue;
      const wx = Gd.x0 + i * Gd.cell, wy = Gd.y0 + (j + 1) * Gd.cell;
      if (wx < E.x0 - Gd.cell || wx > E.x1 || wy < E.y0 || wy > E.y1 + Gd.cell) continue;
      b.fillStyle = city.waterMask[q] ? '#1C4C7A' : city.green[q] ? '#1E4A3A' : city.density[q] > 0.35 ? '#2C3F66' : '#1D2E50';
      b.fillRect(X(wx), Y(wy), cs, cs);
    }
    b.lineWidth = 1;
    for (const l of MT.RAIL.concat(MT.METRO)) { const q = city.railXY2D ? city.railXY2D[l.id] : city.railXY[l.id]; if (!q) continue; b.strokeStyle = l.color; b.globalAlpha = 0.8; b.beginPath(); for (let i = 0; i < q.length; i += 2) { const px = X(q[i]), py = Y(q[i + 1]); i ? b.lineTo(px, py) : b.moveTo(px, py); } b.stroke(); }
    b.globalAlpha = 1;
    let last = '';
    function draw() {
      const c = MT.cam, key = [c.tx | 0, c.ty | 0, c.dist | 0, c.yaw.toFixed(2)].join();
      if (key !== last && !box.hidden) {
        last = key;
        g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(base, 0, 0); g.setTransform(DPR, 0, 0, DPR, 0, 0);
        const px = X(c.tx), py = Y(c.ty), reach = Math.max(6, Math.min(60, c.dist * 1.6 * k));
        const a = Math.PI / 2 - c.yaw, spread = 0.55;              // screen-up is the camera heading
        const fx = Math.cos(a), fy = -Math.sin(a);
        const grd = g.createRadialGradient(px, py, 0, px, py, reach);
        grd.addColorStop(0, 'rgba(232,118,30,.55)'); grd.addColorStop(1, 'rgba(232,118,30,0)');
        g.fillStyle = grd; g.beginPath(); g.moveTo(px, py);
        g.arc(px, py, reach, Math.atan2(fy, fx) - spread, Math.atan2(fy, fx) + spread); g.closePath(); g.fill();
        g.fillStyle = '#FFB36B'; g.strokeStyle = '#081436'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(px, py, 3.2, 0, 6.283); g.fill(); g.stroke();
      }
      setTimeout(() => requestAnimationFrame(draw), 120);
    }
    draw();
    $('#mmClose').onclick = () => { box.hidden = true; $('#mmOpen').hidden = false; };
    $('#mmOpen').onclick = () => { box.hidden = false; $('#mmOpen').hidden = true; last = ''; };
    cv.onclick = e => {
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const wx = E.x0 + (mx - ox) / k, wy = E.y0 + (SZ - my - oy) / k;
      R.flyTo({ tx: wx, ty: wy, dist: Math.min(MT.cam.dist, 9000) }, 1200);
    };
  })();

  /* ==================================================== BOOT ============= */
  if (!document.documentElement.lang) document.documentElement.lang = 'en';
  document.body.classList.add('landing');
  S.cinematic = true; S.labels = false;
  R.attach($('#map'));
  R.flyTo(LANDING_CAM, 0);
  R.setOffsetFrac(0.19, -0.03);
  R.setSpin(0.00032);
  setPane('explore');
  if (window.innerWidth <= 760) { $('#panel').classList.add('hidden'); markNav(null); }
  buildLegend();
  setTlMode('clock');
  BUILD.ai();
  window.addEventListener('resize', () => R.invalidate());
})(window.MT);
