
/* Apply: matched corridors and lines take their OpenStreetMap geometry; the
   rest keep the generalised alignment. Stations move onto the real track. */
(function () {
  const O = MT.OSM;
  for (const r of MT.ROADS) if (O.roads[r.id]) { r.path = O.roads[r.id]; r.osm = true; }
  for (const l of MT.RAIL.concat(MT.METRO)) {
    const m = O.rail[l.id]; if (!m) continue;
    l.osmPath = m.path; l.osmStops = m.stops; l.osm = true; l.offset = 0;
    l.stations.forEach((s, k) => { s.lon = m.stations[k][0]; s.lat = m.stations[k][1]; });
  }
  const nR = MT.ROADS.filter(r => r.osm).length, nL = MT.RAIL.concat(MT.METRO).filter(l => l.osm).length;
  const d = id => MT.DATASETS.find(x => x.id === id);
  Object.assign(d('roads'), { name: 'Arterial road network', source: 'OpenStreetMap — ' + nR + ' of ' + MT.ROADS.length + ' corridors map-matched by road name; the rest generalised',
    owner: '© OpenStreetMap contributors', license: 'ODbL 1.0', updated: '2026-09-30', version: '0.2',
    accuracy: 'Matched corridors follow OSM centrelines (drawn wider than life for legibility; eased up to ~40 m off parallel railways). Unmatched corridors ±300 m' });
  Object.assign(d('rail'), { source: 'OpenStreetMap — ' + nL + ' of ' + MT.RAIL.concat(MT.METRO).length + ' lines map-matched onto OSM track; stations snapped to the track',
    owner: '© OpenStreetMap contributors', license: 'ODbL 1.0', updated: '2026-09-30', version: '0.2',
    accuracy: 'Matched lines follow OSM track geometry. Station points snapped to the nearest track (±50–400 m from the platform centre). Unmatched lines schematic' });
})();
