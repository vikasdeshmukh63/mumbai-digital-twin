# Mumbai Digital Twin — developer notes

A single-page 3D twin of the Mumbai Metropolitan Region, drawn on a 2D canvas with a hand-written perspective renderer. No build step, no framework.

## Run
Open `index.html` in a browser (or publish the folder as-is). The landing page paints first; `js/*` load in order after the first frame (see the inline loader at the end of `index.html`).

## Files
| File | Role |
|---|---|
| `js/data.js` | Reference data: coastline, roads, rail/metro lines + stations, landmarks, circles, datasets & provenance |
| `js/osm.js` | **Generated.** Road/rail geometry map-matched from OpenStreetMap (ODbL), plus OSM tunnels & bridges. Applies itself to `MT.ROADS`/`MT.RAIL`/`MT.METRO` |
| `js/geo.js` | Projection (lon/lat ↔ metres) and geometry helpers |
| `js/city.js` | Builds the model: land/water grid, road graph, flyovers/bridges/tunnels, rail heights, buildings, stations, platforms |
| `js/render.js` | Camera, projection and all drawing (painter's algorithm); adaptive quality; frame fault guard |
| `js/motion.js` | Vehicles, trains, aircraft, ships |
| `js/sim.js` | Flood, traffic assignment, emergency routing, building impact, reports |
| `js/ai.js` | Mumbai AI (rule-based planner over the loaded model) |
| `js/ui.js` | Panels, simulation centre, guided demo, landing, mini-map |
| `css/app.css` | All styles (later blocks override earlier ones) |

## Tests
```
node tests/smoke.js
```
Checks first paint, load time, road/rail overlaps, level crossings, buildings in water, OSM coverage, app entry, all panes, flood + Stop all, guided demo, frame time and page errors. Exit code is non-zero on failure.

## Regenerating `js/osm.js`
Export main roads and rail for the MMR from Overpass as GeoJSON, then run the matcher (kept outside the repo during development) to regenerate `js/osm.js`. The data is © OpenStreetMap contributors (ODbL); keep the on-map attribution.

## Data honesty
Buildings, terrain, density, traffic and all movement are **simulated**. Road and rail geometry is from OpenStreetMap. Nothing claims to be a live feed; keep the provenance labels when adding data.

## Regenerate road & rail geometry (tools/)
```
node tools/osm-match.js path/to/overpass-export.geojson js/osm.js
```
The Overpass query used: `way["railway"~"^(rail|subway|light_rail|monorail)$"]` and `way["highway"~"^(motorway|trunk|primary|secondary)$"]` within bbox `18.85,72.75,19.50,73.30`, `out geom;`, exported as GeoJSON.

## Run locally
Serve the folder (e.g. `npx serve .` or `python3 -m http.server`) and open http://localhost:… — or open `index.html` directly in Chrome/Edge.
