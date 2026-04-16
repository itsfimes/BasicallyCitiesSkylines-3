# AGENTS.md

## Project: BasicallyCitiesSkylines-3

Python-first city simulation platform with a Three.js 3D dashboard.

## Commands

### Backend
- **Run server:** `.venv/bin/python run_backend.py`
- **Run tests:** `.venv/bin/python -m pytest tests/ -v`
- **Lint:** `.venv/bin/ruff check citysim/ tests/`
- **Format:** `.venv/bin/ruff format citysim/ tests/`

### Frontend
- **Dev server:** `cd frontend && npm run dev` (serves on :8080, proxies API to :8000)
- **Build:** `cd frontend && npm run build`
- **Preview:** `cd frontend && npm run preview`

### Both
- **Run both:** `.venv/bin/python run_both.py` (multiprocessing, backend :8000, frontend :8080)

## Architecture

### Backend (`citysim/`)
- `types.py` — Data types (Node, Edge, Building, Resident, etc.), Literal type aliases
- `graph.py` — CityGraph with Dijkstra shortest path + BPR congestion model + path cache
- `simulation.py` — Core simulation engine (agent-based, schedule-driven routing, traffic lights, weather)
- `server.py` — FastAPI REST + WebSocket server with async runtime
- `factory.py` — Builds simulation from JSON data, generates residents
- `importer.py` — JSON import + OSM Overpass API import with POI buildings
- `plugins.py` — ScenarioPlugin protocol + ScheduledScenario
- `randomness.py` — Seeded RNG wrapper for reproducibility

### Frontend (`frontend/src/`)
- `main.ts` — Entry point, wires everything together
- `api.ts` — API client with WebSocket reconnection
- `scene.ts` — Three.js 3D city visualization
- `minimap.ts` — 2D Canvas mini-map
- `sparkline.ts` — SVG sparkline charts for metrics
- `toast.ts` — Toast notification system
- `utils.ts` — Formatting and DOM helpers

### Key API Endpoints
- `GET /api/state` — Full simulation state
- `GET /api/state/summary` — Lightweight state (no resident list)
- `GET /api/residents?limit=100&offset=0` — Paginated residents
- `GET /api/logs?limit=200&offset=0` — Paginated event log
- `POST /api/event` — Inject an event
- `POST /api/runtime` — Configure live mode (running, speed)
- `POST /api/reset` — Reset simulation
- `WS /ws/state` — WebSocket for real-time tick updates

## Code Style
- Python: ruff (line-length 120, py311 target)
- TypeScript: strict, no comments unless requested
- No emojis in code
