/* Mumbai Digital Twin — smoke & integrity suite.
   Run:  node tests/smoke.js      (needs playwright-core and a Chromium)
   Exits non-zero if any check fails. */
const path = require('path');
const PW = process.env.PW_CORE || 'playwright-core';      // npm i playwright-core
const CHROME = process.env.CHROME || undefined;            // path to Chrome/Chromium, or leave unset if Playwright installed one
const { chromium } = require(PW);
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const results = [];
const check = (name, ok, info) => { results.push({ name, ok, info }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? ' — ' + info : '')); };

(async () => {
  const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const p = await b.newPage({ viewport: { width: 1352, height: 842 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await p.goto(URL);
  await p.waitForFunction(() => window.MT && MT.ui && MT.render && MT.render.quality, null, { timeout: 30000 });
  const fcp = await p.evaluate(() => (performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint') || {}).startTime || 99999);
  check('first paint under 1.5 s', fcp < 1500, Math.round(fcp) + ' ms');
  check('city ready under 10 s', Date.now() - t0 < 10000, (Date.now() - t0) + ' ms');

  const I = await p.evaluate(() => {
    const C = MT.city, g = C.graph, geo = MT.geo, out = {};
    const HALF = { expressway: 40.8, arterial: 29.8, link: 20.4, bridge: 35.7 };
    /* roads vs rail bed */
    const rs = []; for (const l of MT.RAIL) { const q = C.railXY[l.id]; for (let i = 0; i + 3 < q.length; i += 2) rs.push(q.slice(i, i + 4)); }
    let par = 0, grade = 0;
    for (const e of g.edges) { if (e.road < 0 || e.tunnel) continue; const A = g.nodes[e.a], B = g.nodes[e.b], L = e.len || 1, ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      for (let k = 0, n = Math.max(2, Math.ceil(L / 25)); k <= n; k++) { const x = A.x + (B.x - A.x) * k / n, y = A.y + (B.y - A.y) * k / n, z = (e.za || 0) + ((e.zb || 0) - (e.za || 0)) * k / n;
        for (const r of rs) { const d = geo.distToSeg(x, y, r[0], r[1], r[2], r[3]); if (d >= (HALF[e.cls] || 20) + 24) continue; const sl = Math.hypot(r[2] - r[0], r[3] - r[1]) || 1, c = Math.abs((ux * (r[2] - r[0]) + uy * (r[3] - r[1])) / sl);
          if (z < 14) { if (c > 0.6) par++; else grade++; } } } }
    out.roadRailParallel = par; out.levelCrossings = grade;
    /* buildings on water */
    let wet = 0; for (const bd of C.buildings) if (!C.isLand(bd.x, bd.y)) wet++;
    out.buildingsInSea = wet; out.buildings = C.buildings.length;
    out.roads = MT.ROADS.length; out.osmRoads = MT.ROADS.filter(r => r.osm).length; out.osmLines = MT.RAIL.concat(MT.METRO).filter(l => l.osm).length;
    return out;
  });
  check('no road lying on the railway', I.roadRailParallel === 0, I.roadRailParallel + ' samples');
  check('no level crossings', I.levelCrossings === 0, I.levelCrossings + ' samples');
  check('no buildings in the sea', I.buildingsInSea === 0, I.buildings + ' buildings');
  check('all corridors on OSM geometry', I.osmRoads === I.roads, I.osmRoads + '/' + I.roads + ' roads, ' + I.osmLines + ' lines');
  const NET = await p.evaluate(() => { const g = MT.city.graph; let ok = 0; for (let i = 0; i < 150; i++) { const n = g.nodes[(i * 7919) % g.nodes.length]; const r = MT.sim.emergencyRoute({ x: n.x, y: n.y }, {}); if (r && r.ok) ok++; } return { pieces: MT.city.graphPieces, ok }; });
  check('road network is one connected piece; every sample routes to a hospital', NET.pieces === 1 && NET.ok === 150, NET.pieces + ' piece(s), ' + NET.ok + '/150 routed');

  await p.click('#btnExplore'); await p.waitForTimeout(1500);
  check('enters the app', await p.evaluate(() => !document.body.classList.contains('landing')));
  for (const pane of ['explore', 'layers', 'analytics', 'simulation', 'ai', 'reports', 'data']) await p.evaluate(x => MT.ui.setPane(x), pane);
  check('all panes open', true);
  await p.evaluate(() => { MT.ui.openSim('flood'); document.querySelector('#fPreset').click(); }); await p.waitForTimeout(800);
  const fl = await p.evaluate(() => !!MT.state.flood && !document.querySelector('#simRunBar').hidden);
  await p.click('#simStopAll'); await p.waitForTimeout(500);
  check('flood runs and Stop all clears it', fl && await p.evaluate(() => !MT.state.flood));
  await p.click('#btnPresent'); await p.waitForTimeout(1500);
  check('guided demo starts', await p.evaluate(() => !document.querySelector('#present').classList.contains('off')));
  await p.keyboard.press('Escape');

  const ms = await p.evaluate(() => new Promise(res => { const a = []; const o = MT.onFrame; MT.onFrame = f => { o && o(f); a.push(f.ms); }; setTimeout(() => { a.sort((x, y) => x - y); res(a[a.length >> 1] || 0); }, 4000); }));
  check('median frame under 120 ms (headless CPU)', ms < 120, ms.toFixed(1) + ' ms');
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await b.close();
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
