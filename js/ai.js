/* ============================================================================
   ai.js — "Mumbai AI": a grounded question-answering layer.

   The assistant never answers from language alone. It classifies intent, plans
   a GIS operation, executes that operation against the in-browser model, and
   only then writes an explanation of what the query returned. When no dataset
   can support the question it refuses, by design.
   ========================================================================== */
(function (MT) {
  'use strict';
  const geo = MT.geo, city = MT.city, sim = MT.sim;
  const ai = MT.ai = {};

  const REFUSAL = 'This analysis requires a verified dataset that is not currently connected.';

  ai.SUGGESTIONS = [
    'Show me flood-prone areas of Mumbai',
    'What hospitals are within 5 km of BKC?',
    'Show areas within 1 km of a metro station',
    'Which areas have high density but poor public transport access?',
    'What happens if rainfall reaches 200 mm in 6 hours?',
    'Close the Bandra–Worli Sea Link for 24 hours',
    'Fastest emergency route from Dharavi to a hospital',
    'Which corridors are most congested?',
    'How many people live in Andheri?',
    'Which zones have the least green cover?',
    'Show metro projects under construction',
    'Which areas are lowest lying?'
  ];

  /* ------------------------------------------------------------- utilities */
  function norm(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

  function findPlace(q) {
    const n = norm(q);
    /* 1. A place named in full wins outright, longest name first — so
       "Lower Parel" is Lower Parel, not the "parel" alias (audit #12). */
    const exact = city.searchables
      .filter(s => { const sn = norm(s.name); return sn.length > 3 && new RegExp('(^| )' + sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(n); })
      .sort((a, b) => b.name.length - a.name.length || (a.kind === 'Area' ? -1 : 1))[0];
    if (exact) return exact;
    /* 2. Common short names, matched on whole words only */
    const ALIASES = {
      'bkc': 'Bandra East & BKC', 'bandra kurla': 'Bandra East & BKC',
      'sea link': 'Bandra–Worli Sea Link', 'airport': 'Chhatrapati Shivaji Maharaj Intl Airport (T2)',
      'town': 'Fort & Ballard', 'south mumbai': 'Fort & Ballard',
      'parel': 'Parel & Sewri', 'sion': 'Sion & Wadala', 'wadala': 'Sion & Wadala',
      'mahim': 'Dadar & Mahim', 'dadar': 'Dadar & Mahim', 'khar': 'Santacruz & Khar', 'santacruz': 'Santacruz & Khar',
      'juhu': 'Juhu & Vile Parle', 'vile parle': 'Juhu & Vile Parle', 'iit': 'IIT Bombay, Powai',
      'mankhurd': 'Govandi & Mankhurd', 'govandi': 'Govandi & Mankhurd',
      /* wider region */
      'navi mumbai': 'Vashi & Sanpada', 'vashi': 'Vashi & Sanpada', 'sanpada': 'Vashi & Sanpada',
      'nerul': 'Nerul & Seawoods', 'seawoods': 'Nerul & Seawoods',
      'belapur': 'Belapur & Kharghar', 'kharghar': 'Belapur & Kharghar',
      'airoli': 'Airoli & Ghansoli', 'ghansoli': 'Airoli & Ghansoli',
      'thane': 'Thane West', 'ghodbunder': 'Ghodbunder Road',
      'kalwa': 'Kalwa & Mumbra', 'mumbra': 'Kalwa & Mumbra',
      'ulhasnagar': 'Ulhasnagar & Ambernath', 'ambernath': 'Ulhasnagar & Ambernath',
      'mira bhayandar': 'Mira Road', 'mira': 'Mira Road',
      'ulwe': 'Ulwe & Uran', 'uran': 'Ulwe & Uran',
      'jnpt': 'Jawaharlal Nehru Port (JNPA)', 'jnpa': 'Jawaharlal Nehru Port (JNPA)', 'nhava sheva': 'Jawaharlal Nehru Port (JNPA)',
      'atal setu': 'Atal Setu (Mumbai Trans Harbour Link)', 'mthl': 'Atal Setu (Mumbai Trans Harbour Link)',
      'navi mumbai airport': 'Navi Mumbai International Airport', 'elephanta': 'Elephanta Caves'
    };
    const keys = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (new RegExp('(^| )' + k + '( |$)').test(n)) {
        const hit = city.searchables.find(s => s.name === ALIASES[k]);
        if (hit) return hit;
      }
    }
    let best = null, bestScore = 0;
    for (const s of city.searchables) {
      const sn = norm(s.name);
      if (sn.length < 3) continue;
      let score = 0;
      if (n.includes(sn)) score = sn.length * 2;
      else {
        const first = sn.split(' ')[0];
        if (first.length > 3 && n.includes(first)) score = first.length;
      }
      if (s.kind === 'Area') score *= 1.25;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return bestScore >= 4 ? best : null;
  }

  function num(q, units, dflt) {
    const re = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + units + ')', 'i');
    const m = q.match(re);
    if (m) return parseFloat(m[1]);
    const bare = q.match(/(\d+(?:\.\d+)?)/);
    return bare && dflt === undefined ? parseFloat(bare[1]) : dflt;
  }

  function ds(...ids) {
    return ids.map(id => MT.DATASETS.find(d => d.id === id)).filter(Boolean);
  }

  function zoneLink(name) { return '<a class="ailink" data-zone="' + name + '">' + name + '</a>'; }

  /* ------------------------------------------------------------ the router */
  ai.ask = function (q) {
    const n = norm(q);
    const has = (...words) => words.some(w => n.includes(w));

    /* ---- population: refuse ------------------------------------------- */
    if (has('how many people', 'population of', 'residents of', 'populace', 'how many residents', 'population density of')) {
      return {
        intent: 'Population query',
        plan: ['Resolve place', 'Look up census population', 'HALT — no source bound'],
        datasets: ds('population'),
        refused: true,
        html: '<p>' + REFUSAL + '</p><p class="ai-note">Mumbai Digital Twin holds a <strong>simulated</strong> density surface used for relative comparison between zones. It deliberately does not convert that surface into head counts, because doing so would manufacture a number that looks authoritative and is not. Bind a census or civic-register source under <strong>Data</strong> and this question becomes answerable.</p>',
        chips: [['Population & demographics', 'missing']]
      };
    }
    if (has('air quality', 'aqi', 'pm2 5', 'pm10') && !has('layer', 'show layer')) {
      return {
        intent: 'Air quality query', plan: ['Resolve place', 'Query monitoring network', 'HALT — no source bound'],
        datasets: [], refused: true,
        html: '<p>' + REFUSAL + '</p><p class="ai-note">No air-quality monitoring feed is bound. The "air quality" surface in the layer panel is an illustrative pattern derived from the simulated density surface and is labelled as such — it is not measurement.</p>',
        chips: [['Air quality monitoring', 'missing']]
      };
    }
    if (has('which flight', 'what flight', 'flight number', 'callsign', 'which ship', 'which vessel',
            'ship name', 'track this plane', 'where is the train', 'which train')) {
      return {
        intent: 'Live movement query',
        plan: ['Resolve the moving object', 'Query ADS-B / AIS / signalling', 'HALT — no source bound'],
        datasets: ds('movement'), refused: true,
        html: '<p>' + REFUSAL + '</p><p class="ai-note">The aircraft, vessels, trains and vehicles moving on the twin are <strong>agents</strong>, not observations. They carry no callsign, registration or vessel name because none exists — inventing one would be the exact failure this platform is built to avoid. Road agents do carry real meaning: their speed comes from the traffic assignment, so they show you the model, not the street.</p>',
        chips: [['Movement (synthetic)', 'sim']]
      };
    }
    if (has('rainfall right now', 'current rainfall', 'raining now', 'weather right now', 'current weather', 'live traffic', 'traffic right now')) {
      return {
        intent: 'Live conditions query', plan: ['Query live feed', 'HALT — no source bound'],
        datasets: ds('rain_live', 'traffic_live'), refused: true,
        html: '<p>' + REFUSAL + '</p><p class="ai-note">This build runs entirely offline on demo data. Rainfall and traffic are scenario inputs you set yourself in the Simulation panel, never observations.</p>',
        chips: [['Rainfall & weather', 'missing'], ['Real-time traffic', 'missing']]
      };
    }

    /* ---- run a flood scenario ----------------------------------------- */
    if (has('rainfall', 'rain', 'flood') && /\d+\s*mm/.test(n)) {
      const mm = num(q, 'mm', 200);
      const hrs = num(q.replace(/\d+\s*mm/i, ''), 'hours?|hrs?|h', 6) || 6;
      /* Same parameters the Simulation pane will run with, so the answer and
         the map agree; the run itself goes through the UI so the storm
         timeline, legend, results panel and layers all update (audit #8). */
      const rain = Math.max(50, Math.min(400, Math.round(mm / 10) * 10));
      const hours = Math.max(1, Math.min(24, Math.round(hrs)));
      const $ = sel => document.querySelector(sel);
      const tide = $('#fTide') ? +$('#fTide').value : 3.2, eff = $('#fDrain') ? +$('#fDrain').value : 1;
      const r = sim.flood({ rain, hours, tide, eff, drainEff: eff });
      MT.state.surface = 'relief';
      return {
        intent: 'Flood scenario execution',
        plan: ['Parse rainfall ' + rain + ' mm over ' + hours + ' h' + (rain !== mm || hours !== hrs ? ' (clamped to the model range)' : ''), 'Run rainfall–runoff–ponding model on 200 m grid',
               'Intersect depth grid with buildings, roads, health and rail layers', 'Rank zones by exposure'],
        datasets: ds('terrain', 'density', 'roads', 'health', 'rail'),
        html: '<p><strong>' + rain + ' mm over ' + hours + ' h</strong> (' + r.intensity.toFixed(0) +
          ' mm/h) against a modelled drainage capacity of ' + r.capacity.toFixed(0) + ' mm/h leaves ' +
          r.excess_mm.toFixed(0) + ' mm of excess.</p><ul>' +
          '<li>Standing water over <strong>' + r.areaKm2.toFixed(1) + ' km²</strong>, ' + r.classAreas[3].toFixed(1) + ' km² of it above 0.6 m</li>' +
          '<li><strong>' + r.buildings.toLocaleString('en-IN') + '</strong> simulated structures in affected cells</li>' +
          '<li><strong>' + r.roadKmImpassable.toFixed(1) + ' km</strong> of arterial road classified impassable</li>' +
          '<li><strong>' + r.hospitals.length + '</strong> hospitals and <strong>' + r.stations.length + '</strong> stations in affected cells</li></ul>' +
          '<p>Worst-exposed zones: ' + r.topZones.slice(0, 4).map(z => zoneLink(z.name)).join(', ') + '.</p>',
        chips: [['Flood model', 'sim'], ['Terrain', 'sim'], ['Roads', 'limited']],
        table: { head: ['Zone', 'Share flooded', 'Mean depth'], rows: r.topZones.map(z => [z.name, z.pct.toFixed(0) + '%', z.mean.toFixed(2) + ' m']) },
        action: () => {
          MT.ui.openSim('flood');
          const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input')); } };
          set('fRain', rain); set('fHours', hours);
          MT.ui.runFlood();
        },
        highlight: { points: r.topZones.slice(0, 5).map(z => ({ x: z.x, y: z.y, name: z.name })) }
      };
    }

    /* ---- flood-prone areas (baseline, no scenario) --------------------- */
    if (has('flood prone', 'flood risk', 'waterlog', 'flooding', 'flood areas', 'flood')) {
      const t = sim.zoneTable().map(z => ({
        ...z, score: z.lowPct * 0.7 + (100 - Math.min(100, z.meanElev * 4)) * 0.3
      })).sort((a, b) => b.score - a.score).slice(0, 8);
      MT.state.surface = 'floodrisk'; MT.render.markGround();
      return {
        intent: 'Spatial analysis — baseline flood exposure',
        plan: ['Load synthetic elevation surface', 'Compute share of each zone below 4 m',
               'Blend with mean elevation into an exposure score', 'Render flood-risk surface'],
        datasets: ds('terrain', 'coastline'),
        html: '<p>Ranking the ' + city.zones.length + ' demo zones by <strong>low-lying share</strong> — the share of each zone sitting below 4 m on the synthetic elevation surface — gives this exposure order.</p>' +
          '<p>Highest: ' + t.slice(0, 4).map(z => zoneLink(z.name)).join(', ') + '.</p>' +
          '<p class="ai-note">This is relative exposure from a <strong>synthetic</strong> terrain surface, not a hydraulic flood map. For a scenario-specific answer, run the flood module with a rainfall depth — ask me "what happens if rainfall reaches 200 mm in 6 hours".</p>',
        chips: [['Elevation surface', 'sim'], ['Coastline', 'limited']],
        table: { head: ['Zone', 'Below 4 m', 'Mean elevation'], rows: t.map(z => [z.name, z.lowPct.toFixed(0) + '%', z.meanElev.toFixed(1) + ' m']) },
        highlight: { points: t.slice(0, 6).map(z => ({ x: z.x, y: z.y, name: z.name })) },
        action: () => MT.ui.flyToExtent()
      };
    }

    /* ---- facilities within a radius ------------------------------------ */
    if (has('hospital', 'clinic', 'school', 'fire station', 'police') && has('within', 'near', 'close to', 'around', 'from') &&
        !has('route', 'fastest', 'ambulance', 'emergency', 'how do i get', 'quickest')) {
      const place = findPlace(q);
      if (!place) return notFound(q, 'a place to measure from');
      let km = num(q, 'km', null);
      if (km === null) { const m = num(q, 'm|metres|meters', null); km = m ? m / 1000 : 5; }
      const r = km * 1000;
      const cat = has('fire station') ? 'fire' : has('police') ? 'police' : has('school') ? 'school' : 'hospital';
      const src = { hospital: city.hospitals, fire: city.fire, school: city.schools, police: city.police }[cat];
      const idx = new geo.PointIndex(src, 1200);
      const hits = idx.within(place.x, place.y, r);
      const simulated = cat === 'school' || cat === 'police';
      MT.state.highlight = {
        circles: [{ x: place.x, y: place.y, r }],
        points: hits.slice(0, 40).map(h => ({ x: h.item.x, y: h.item.y, name: h.item.name }))
      };
      MT.render.flyTo({ tx: place.x, ty: place.y, dist: Math.max(6000, r * 3.4), pitch: 1.05 });
      return {
        intent: 'Spatial query — buffer & point-in-polygon',
        plan: ['Geocode "' + place.name + '" → local ENU', 'Buffer by ' + km + ' km',
               'Select ' + cat + ' points within buffer', 'Sort by straight-line distance'],
        datasets: ds(cat === 'hospital' ? 'health' : cat === 'fire' ? 'fire' : 'buildings'),
        html: '<p><strong>' + hits.length + '</strong> ' + cat + (hits.length === 1 ? '' : 's') +
          ' fall within <strong>' + km + ' km</strong> straight-line of ' + place.name + '.</p>' +
          (simulated ? '<p class="ai-note">This point set is <strong>simulated</strong> — no verified register of ' + cat + ' locations is connected. Treat the count as a placeholder.</p>'
                     : '<p class="ai-note">Positions are approximate (±400 m) and the register is not exhaustive. Bed capacity and speciality are not held.</p>') +
          '<p class="ai-note">Distances are straight-line, not road distance. For travel time use the emergency-routing module.</p>',
        chips: [[cat === 'hospital' ? 'Hospitals' : cat === 'fire' ? 'Fire stations' : cat + ' (synthetic)', simulated ? 'sim' : 'limited']],
        table: { head: ['Facility', 'Distance'], rows: hits.slice(0, 12).map(h => [h.item.name, geo.fmtDist(h.d)]) }
      };
    }

    /* ---- metro catchment ----------------------------------------------- */
    if (has('metro') && has('within', 'near', 'close to', 'walking distance', 'catchment', 'access')) {
      let km = num(q, 'km', null);
      if (km === null) { const m = num(q, 'm|metres|meters', null); km = m ? m / 1000 : 1; }
      const r = km * 1000;
      const gx = city.grid;
      let cells = 0, served = 0;
      for (let k = 0; k < gx.w * gx.h; k++) {
        if (!city.land[k]) continue;
        cells++;
        const c = city.cellCentre(k);
        if (city.metroIndex.within(c.x, c.y, r).length) served++;
      }
      const cellA = gx.cell * gx.cell / 1e6;
      const t = sim.zoneTable().slice().sort((a, b) => b.metroPct - a.metroPct);
      MT.state.highlight = { circles: city.metroStations.map(s => ({ x: s.x, y: s.y, r })), fill: 'rgba(63,211,230,0.07)' };
      MT.render.markGround();
      return {
        intent: 'Spatial analysis — multi-buffer coverage',
        plan: ['Select ' + city.metroStations.length + ' metro station points', 'Buffer each by ' + km + ' km',
               'Rasterise the union against the 200 m land grid', 'Aggregate coverage by zone'],
        datasets: ds('rail', 'coastline'),
        html: '<p><strong>' + (served / cells * 100).toFixed(1) + '%</strong> of modelled land area — about <strong>' +
          (served * cellA).toFixed(0) + ' km²</strong> of ' + (cells * cellA).toFixed(0) +
          ' km² — lies within ' + km + ' km of one of the ' + city.metroStations.length + ' metro station records held.</p>' +
          '<p>Best covered: ' + t.slice(0, 3).map(z => zoneLink(z.name)).join(', ') + '. Least: ' +
          t.slice(-3).reverse().map(z => zoneLink(z.name)).join(', ') + '.</p>' +
          '<p class="ai-note">Station positions are approximate and lines under construction are included as alignments. Coverage is a straight-line radius, not a walk-network catchment, so it overstates real access.</p>',
        chips: [['Metro alignments', 'limited']],
        table: { head: ['Zone', 'Within ' + km + ' km of metro'], rows: t.slice(0, 10).map(z => [z.name, z.metroPct.toFixed(0) + '%']) },
        action: () => MT.ui.flyToExtent()
      };
    }

    /* ---- density vs transit -------------------------------------------- */
    if ((has('density', 'dense', 'crowded') && has('transport', 'transit', 'metro', 'station', 'connectivity')) ||
        has('poor public transport', 'poorly served', 'transport gap')) {
      const t = sim.zoneTable()
        .map(z => ({ ...z, gap: z.densityIndex * 100 - z.transitPct * 0.75 }))
        .sort((a, b) => b.gap - a.gap).slice(0, 10);
      MT.state.surface = 'density'; MT.render.markGround();
      MT.state.highlight = { points: t.slice(0, 6).map(z => ({ x: z.x, y: z.y, name: z.name })) };
      return {
        intent: 'Spatial analysis — bivariate gap query',
        plan: ['Load simulated density surface', 'Load 800 m station catchments (metro + suburban rail)',
               'Aggregate both to zone level', 'Rank by density index minus weighted transit share'],
        datasets: ds('density', 'rail', 'population'),
        html: '<p>Crossing the <strong>simulated</strong> density surface with 800 m station catchments produces this gap ranking — dense zones with a small share of land near a station.</p>' +
          '<p>Largest gaps: ' + t.slice(0, 4).map(z => zoneLink(z.name)).join(', ') + '.</p>' +
          '<p class="ai-note">The density input is a modelled surface, not census data, so this ranking shows <strong>where the model thinks the gap is</strong>, not a measured deficit. Bind a census source to make this an evidence-based answer.</p>',
        chips: [['Density surface', 'sim'], ['Rail & metro', 'limited'], ['Census', 'missing']],
        table: { head: ['Zone', 'Density index', 'Land within 800 m of a station'], rows: t.map(z => [z.name, z.densityIndex.toFixed(2), z.transitPct.toFixed(0) + '%']) }
      };
    }

    /* ---- close a road -------------------------------------------------- */
    if (has('close', 'closure', 'shut', 'block') && has('road', 'link', 'highway', 'sea link', 'freeway', 'bridge', 'marg')) {
      const road = MT.ROADS.find(r => norm(q).includes(norm(r.name).split(' ')[0]) && norm(r.name).split(' ')[0].length > 3) ||
                   MT.ROADS.find(r => norm(r.name).split(' ').some(w => w.length > 4 && n.includes(w)));
      if (!road) return notFound(q, 'a corridor in the modelled network');
      const base = sim.traffic({ closed: [] });
      const after = sim.traffic({ closed: [road.id] });
      const rows = after.od.map((o, i) => {
        const b = base.od[i];
        const d = isFinite(o.minutes) && isFinite(b.minutes) ? o.minutes - b.minutes : NaN;
        return [o.from + ' → ' + o.to, b.minutes.toFixed(1) + ' min', isFinite(o.minutes) ? o.minutes.toFixed(1) + ' min' : 'no route',
          isFinite(d) ? (d >= 0 ? '+' : '') + d.toFixed(1) : '—'];
      });
      const worst = after.corridors.filter(c => !c.closed).slice(0, 4);
      return {
        intent: 'Traffic scenario execution — link closure',
        plan: ['Remove ' + road.name + ' from the graph', 'Rebuild gravity demand',
               'Re-assign with BPR volume-delay (4 MSA iterations)', 'Difference against the baseline assignment'],
        datasets: ds('roads', 'density', 'traffic_live'),
        html: '<p>Closing <strong>' + road.name + '</strong> pushes its demand onto the remaining arterial graph.</p>' +
          '<p>Corridors absorbing the diversion: ' + worst.map(c => c.name + ' (V/C ' + c.vc.toFixed(2) + ')').join(', ') + '.</p>' +
          '<p class="ai-note">Duration does not change a static assignment — the model has no time dimension. A 1-hour and a 7-day closure produce the same steady-state loading; what differs in reality is behavioural adaptation, which this model does not represent.</p>',
        chips: [['Traffic model', 'sim'], ['Roads', 'limited'], ['Observed traffic', 'missing']],
        table: { head: ['Journey', 'Baseline', 'With closure', 'Δ'], rows },
        action: () => {
          MT.ui.openSim('traffic');
          const sel = document.getElementById('tRoad'); if (sel) sel.value = road.id;
          MT.ui.runTraffic(road.id);
        }
      };
    }

    /* ---- congestion ---------------------------------------------------- */
    if (has('congest', 'busiest', 'most traffic', 'slowest', 'bottleneck')) {
      const r = MT.state.traffic || sim.traffic({ closed: [] });
      MT.state.traffic = r; MT.render.invalidate();
      return {
        intent: 'Network analysis — corridor loading',
        plan: ['Run static assignment on the arterial graph', 'Compute volume/capacity per link',
               'Aggregate by corridor, length-weighted', 'Rank descending'],
        datasets: ds('roads', 'density', 'traffic_live'),
        html: '<p>Length-weighted volume/capacity across the ' + r.corridors.length + ' modelled corridors. Anything above 1.00 is loaded beyond its modelled capacity.</p>' +
          '<p class="ai-note">These are <strong>model</strong> ratios from a gravity demand matrix, not counts. No observed traffic source is connected, so the ranking shows the structure of the network, not measured congestion.</p>',
        chips: [['Traffic model', 'sim'], ['Observed traffic', 'missing']],
        table: { head: ['Corridor', 'V/C', 'Length'], rows: r.corridors.slice(0, 10).map(c => [c.name, c.vc.toFixed(2), c.km.toFixed(1) + ' km']) }
      };
    }

    /* ---- emergency route ----------------------------------------------- */
    if (has('route', 'fastest way', 'how do i get', 'ambulance', 'emergency')) {
      const place = findPlace(q);
      if (!place) return notFound(q, 'an origin');
      const r = sim.emergencyRoute({ x: place.x, y: place.y }, { avoidFlood: !!MT.state.flood });
      if (!r || !r.ok) return {
        intent: 'Emergency routing', plan: ['Snap origin to graph', 'Least-time Dijkstra', 'HALT — no path'],
        datasets: ds('roads', 'health'), refused: true,
        html: '<p>No route could be found on the modelled arterial network from ' + place.name +
          '. Only ' + MT.ROADS.length + ' corridors are modelled, so parts of the city are not reachable in this graph.</p>',
        chips: [['Roads', 'limited']]
      };
      MT.state.routes = [{ path: r.path, color: '#77E4AE', label: 'Emergency route' }];
      MT.state.highlight = { points: [{ x: place.x, y: place.y, name: place.name }, { x: r.target.x, y: r.target.y, name: r.target.name }] };
      MT.render.flyTo({ tx: (place.x + r.target.x) / 2, ty: (place.y + r.target.y) / 2, dist: Math.max(5000, r.km * 900), pitch: 1.0 });
      return {
        intent: 'Emergency routing — least-time path',
        plan: ['Snap ' + place.name + ' to nearest arterial node', 'Dijkstra over modelled link times',
               (MT.state.flood ? 'Exclude links above 0.30 m modelled flood depth' : 'Use free-flow / assigned times'),
               'Select the nearest of ' + city.hospitals.length + ' hospital records'],
        datasets: ds('roads', 'health', 'terrain'),
        html: '<p>Nearest reachable hospital is <strong>' + r.target.name + '</strong> (' + r.target.area + ').</p><ul>' +
          '<li>Modelled travel time <strong>' + r.minutes.toFixed(1) + ' min</strong> over ' + r.km.toFixed(1) + ' km</li>' +
          '<li>Via ' + r.via.slice(0, 4).join(' → ') + '</li>' +
          (r.throughFlood ? '<li>Every route is cut by flood water — this one crosses ' + r.throughFlood + ' flooded link(s); expect delay</li>' : r.avoidedFlood ? '<li>Links above 0.30 m modelled flood depth were excluded</li>' : '') + '</ul>' +
          '<p class="ai-note">Indicative only. No signal delay, no emergency priority, no live incident data — and the hospital register is approximate and not exhaustive. Never use for dispatch.</p>',
        chips: [['Roads', 'limited'], ['Hospitals', 'limited'], ['Routing', 'sim']]
      };
    }

    /* ---- projects ------------------------------------------------------ */
    if (has('project', 'under construction', 'proposed', 'metro line', 'coastal road', 'redevelopment')) {
      let list = city.projects;
      if (has('metro')) list = list.filter(p => p.type === 'Metro');
      if (has('under construction')) list = list.filter(p => p.status === 'Under Construction');
      if (has('road') && !has('metro')) list = list.filter(p => p.type === 'Road' || p.type === 'Bridge');
      MT.state.highlight = { points: list.map(p => ({ x: p.x, y: p.y, name: p.name })) };
      return {
        intent: 'Register lookup — infrastructure projects',
        plan: ['Load project register', 'Filter by type and status', 'Plot on the twin'],
        datasets: ds('projects'),
        html: '<p><strong>' + list.length + '</strong> matching entries in the project register.</p>' +
          '<p class="ai-note">Compiled from public announcements and reporting, not from an agency feed. Status and dates must be verified with the delivering agency before they are cited.</p>',
        chips: [['Project register', 'limited']],
        table: { head: ['Project', 'Agency', 'Status'], rows: list.map(p => [p.name, p.agency, p.status]) },
        action: () => MT.ui.flyToExtent()
      };
    }

    /* ---- green cover / environment ------------------------------------- */
    if (has('green', 'park', 'open space', 'tree')) {
      const t = sim.zoneTable().slice().sort((a, b) => a.greenPct - b.greenPct);
      MT.state.surface = 'relief'; MT.render.markGround();
      return {
        intent: 'Spatial analysis — land-cover share',
        plan: ['Rasterise green polygons to the 200 m grid', 'Aggregate by zone', 'Rank ascending'],
        datasets: ds('coastline'),
        html: '<p>Share of each zone covered by the mapped green polygons — Sanjay Gandhi National Park, Aarey, the Trombay green belt and the Mahalaxmi belt.</p>' +
          '<p>Lowest: ' + t.slice(0, 4).map(z => zoneLink(z.name)).join(', ') + '.</p>' +
          '<p class="ai-note">Only four large green masses are digitised. Neighbourhood parks, plot-level trees and the mangrove belt are absent, so these shares understate real cover.</p>',
        chips: [['Green polygons', 'limited']],
        table: { head: ['Zone', 'Green cover'], rows: t.slice(0, 10).map(z => [z.name, z.greenPct.toFixed(1) + '%']) }
      };
    }

    /* ---- elevation ----------------------------------------------------- */
    if (has('elevation', 'low lying', 'lowest', 'height above sea', 'altitude', 'terrain')) {
      const t = sim.zoneTable().slice().sort((a, b) => a.meanElev - b.meanElev).slice(0, 10);
      MT.state.surface = 'relief'; MT.render.markGround();
      return {
        intent: 'Terrain analysis',
        plan: ['Sample synthetic elevation surface', 'Aggregate mean and sub-4 m share by zone', 'Rank ascending'],
        datasets: ds('terrain'),
        html: '<p>Mean elevation by zone on the synthetic surface, lowest first.</p>' +
          '<p class="ai-note"><strong>This is not a DEM.</strong> The surface is an analytic construction — coast-distance ramp plus named hill masses plus noise — built so the flood module has something to run against. Replace it with CartoDEM or LiDAR before drawing any real conclusion.</p>',
        chips: [['Elevation surface', 'sim']],
        table: { head: ['Zone', 'Mean elevation', 'Below 4 m'], rows: t.map(z => [z.name, z.meanElev.toFixed(1) + ' m', z.lowPct.toFixed(0) + '%']) }
      };
    }

    /* ---- buildings ----------------------------------------------------- */
    if (has('building', 'tallest', 'skyline', 'floors', 'built up')) {
      const place = findPlace(q);
      const list = place ? city.buildingIndex.within(place.x, place.y, 2000).map(h => h.item) : city.buildings;
      const top = list.slice().sort((a, b) => b.h - a.h).slice(0, 8);
      if (place) MT.render.flyTo({ tx: place.x, ty: place.y, dist: 5000, pitch: 0.72 });
      return {
        intent: 'Attribute query — building stock',
        plan: [place ? 'Buffer "' + place.name + '" by 2 km' : 'Select all modelled structures',
               'Sort by height', 'Return top records'],
        datasets: ds('buildings'),
        html: '<p><strong>' + list.length.toLocaleString('en-IN') + '</strong> structures in scope' +
          (place ? ' within 2 km of ' + place.name : ' across the model') + '.</p>' +
          '<p class="ai-note"><strong>Every building in this twin is generated.</strong> Footprints, heights, floor counts and construction years come from a seeded model, not a cadastre. The counts describe the simulation, not Mumbai.</p>',
        chips: [['Building stock', 'sim']],
        table: { head: ['ID', 'Height', 'Floors', 'Use'], rows: top.map(b => [b.id, b.h.toFixed(0) + ' m', b.floors, b.use]) }
      };
    }

    /* ---- what is here / describe a place -------------------------------- */
    const place = findPlace(q);
    if (place && has('tell me about', 'what is', 'show me', 'go to', 'take me', 'about')) {
      MT.render.flyTo({ tx: place.x, ty: place.y, dist: place.zoom || 5000, pitch: 0.82 });
      const z = city.zoneOf[city.cellIndex(place.x, place.y)];
      const Z = z >= 0 ? sim.zoneTable()[z] : null;
      return {
        intent: 'Place lookup',
        plan: ['Geocode "' + place.name + '"', 'Fly camera', 'Summarise containing analysis zone'],
        datasets: ds('coastline', 'buildings', 'rail'),
        html: '<p>Moved the twin to <strong>' + place.name + '</strong>' + (place.sub ? ' — ' + place.sub : '') + '.</p>' +
          (Z ? '<ul><li>Analysis zone: ' + zoneLink(Z.name) + ' (' + Z.sector + '), ' + Z.areaKm2.toFixed(1) + ' km²</li>' +
            '<li>' + Z.buildings.toLocaleString('en-IN') + ' simulated structures, ' + Z.builtPct.toFixed(0) + '% built-up</li>' +
            '<li>' + Z.transitPct.toFixed(0) + '% of land within 800 m of a station</li>' +
            '<li>Mean elevation ' + Z.meanElev.toFixed(1) + ' m, ' + Z.lowPct.toFixed(0) + '% below 4 m</li>' +
            '<li>' + Z.hospitals + ' hospitals, ' + Z.metro + ' metro and ' + Z.rail + ' rail station records</li></ul>' : ''),
        chips: [['Buildings', 'sim'], ['Rail & metro', 'limited']]
      };
    }

    return notFound(q, null);
  };

  function notFound(q, what) {
    return {
      intent: 'Unresolved',
      plan: ['Classify intent', 'No matching GIS operation'],
      datasets: [],
      refused: true,
      html: '<p>I could not map that to an operation this twin can execute' +
        (what ? ' — I could not resolve ' + what + '.' : '.') +
        '</p><p class="ai-note">Mumbai AI only answers by running a query against the loaded model. It will not compose a plausible-sounding answer from memory. Try one of the example questions, or name a place the twin holds — a locality, road, station, hospital or project.</p>',
      chips: []
    };
  }
})(window.MT);
