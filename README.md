# BasicallyCitiesSkylines-3

Python-first city simulation platform for real-time scenario testing.

## Features

- Agent-based residents (work/school/leisure/home behavior)
- Multi-modal transport (car, public transport, bike, pedestrian)
- Real-time discrete simulation (minute ticks)
- Scenario events: accident, road closure, concert, extreme weather, outage
- OSM import (Overpass API) and JSON dataset import
- REST API for external tools and scenario automation
- Reproducible runs via deterministic seeds
- 2D dashboard visualization (traffic, delay, emissions, energy)

## Project structure

- `citysim/` backend and simulation core (Python)
- `frontend/` 2D dashboard (HTML/CSS/JS)
- `data/` city and scenario datasets
- `docs/` architecture notes and demo guide
- `tests/` simulation tests

## Run

Terminal A:

```bash
python3 run_backend.py
```

Terminal B:

```bash
python3 run_frontend.py
```

Open `http://localhost:8080`.

## API

- `GET /health`
- `GET /api/state`
- `GET /api/logs`
- `POST /api/reset` with `{ "seed": 42, "resident_count": 2500 }`
- `POST /api/step` with `{ "count": 10 }`
- `POST /api/event` with event payload

## Data import

- JSON import through `citysim/importer.py::import_from_json`
- OSM Overpass import through `citysim/importer.py::import_osm_overpass_bbox`

## Demo scenario

See `docs/demo_scenario.md`.
