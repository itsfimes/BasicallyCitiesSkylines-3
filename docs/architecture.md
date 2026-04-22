# BasicallyCitiesSkylines-3 Architecture

This document describes how the backend simulation engine and frontend dashboard
work together, where each module fits, and how data flows through the system.

## 1) System Overview

The project has two runtime halves:

- **Backend (Python / FastAPI)** in `citysim/`
  - Owns domain model, graph routing, simulation ticks, event handling, and API/WS endpoints.
- **Frontend (TypeScript / Vite + Three.js)** in `frontend/src/`
  - Owns UI controls, state application, 3D scene rendering, mini-map, and KPI sparklines.

Development entrypoints:

- `run_backend.py` → starts backend API server (`citysim.server.run`).
- `run_frontend.py` → starts Vite frontend dev server.
- `run_both.py` → runs both processes and coordinates shutdown.

## 2) Backend Architecture (`citysim/`)

### 2.1 Domain and Core Types

- `types.py`
  - Canonical dataclasses and literal unions (`Node`, `Edge`, `Building`, `Resident`, `SimulationEvent`, `SimulationMetrics`).
  - Shared contracts used by importer, factory, graph, simulation, and server snapshot serialization.

### 2.2 Routing and Network Cost Model

- `graph.py`
  - `CityGraph` provides:
    - neighbor lookup,
    - edge travel-time estimation (weather + quality + congestion + uncertainty),
    - Dijkstra shortest path,
    - path cache with TTL + invalidation.
  - Simulation uses this for agent route planning and movement timing.

### 2.3 Simulation Engine

- `simulation.py`
  - `CitySimulation.step()` is the central tick pipeline:
    1. advance sim clock,
    2. expire old events,
    3. ingest plugin-produced events,
    4. reset/decay transient edge effects,
    5. apply active event effects,
    6. move residents / replan routes,
    7. compute metrics,
    8. append event and metrics history.
  - `snapshot()` serializes complete state consumed by API and frontend.

### 2.4 Scenario Plugin Layer

- `plugins.py`
  - `ScenarioPlugin` protocol defines `produce_events(minute)`.
  - `ScheduledScenario` indexes static events by minute and emits them during simulation.

### 2.5 Import and Factory Layer

- `importer.py`
  - `import_from_json(path)` for repository city datasets.
  - `import_osm_overpass_bbox(...)` for Overpass API ingestion and normalization.
  - Internal helpers derive speed/quality/distance and synthesize POI/fallback buildings.

- `factory.py`
  - Loads default city + default scenario.
  - Generates resident population with seeded randomness.
  - Builds simulation from default data or imported map data.

- `randomness.py`
  - `SeededRandom` wraps deterministic RNG operations used by factory and simulation decision logic.

### 2.6 API and Runtime Layer

- `server.py`
  - `SimulationRuntime` wraps one active `CitySimulation` with:
    - concurrency lock for mutation safety,
    - live/paused runtime state,
    - subscriber queues for websocket fanout,
    - operations for reset, step, event injection, runtime config, OSM import.
  - FastAPI endpoints expose state, logs, runtime control, event injection, and import.
  - `/ws/state` streams live tick snapshots.
  - `background_tick_loop()` advances simulation while live mode is enabled.

## 3) Frontend Architecture (`frontend/src/`)

### 3.1 Application Orchestration

- `main.ts`
  - Wires DOM controls, event form, runtime controls, and status/toast feedback.
  - Handles both state pull (`GET /api/state`) and websocket push (`tick` messages).
  - Maintains interpolation anchors for smooth animation between snapshots.
  - Applies snapshots to:
    - overview counters,
    - active events panel,
    - mini-map,
    - sparkline history,
    - Three.js scene.

### 3.2 Transport Layer

- `api.ts`
  - REST helper (`request`) with JSON handling.
  - WebSocket lifecycle with reconnect backoff.
  - Listener registration API consumed by `main.ts`.

### 3.3 Visualization Layers

- `scene.ts`
  - Initializes Three.js scene/camera/lights/controls.
  - Projects graph coordinates to scene space.
  - Upserts road/vehicle/alert/weather meshes from snapshot data.
  - Uses interpolation alpha from `main.ts` for per-frame vehicle smoothing.

- `minimap.ts`
  - Renders a compact 2D view of nodes/edges/movement density on canvas.

- `sparkline.ts`
  - Draws rolling KPI trend charts used in dashboard metric cards.

### 3.4 UI Utilities

- `toast.ts` provides transient notification UX.
- `utils.ts` centralizes formatting and DOM helper functions.

## 4) End-to-End Data Flow

### 4.1 Live Tick Flow (Primary)

1. `background_tick_loop()` in backend sleeps by runtime tick interval.
2. Runtime calls `CitySimulation.step(delta_seconds=...)`.
3. Backend snapshots state and broadcasts `{"type": "tick", "state": ...}` to websocket subscribers.
4. `api.ts` receives websocket message and forwards parsed payload to listeners.
5. `main.ts` validates staleness, updates interpolation anchors, applies state.
6. `scene.ts` and `minimap.ts` render new world state; sparkline history updates.

### 4.2 Request/Response Flow (Control + Fallback)

1. User action in UI triggers REST call (reset, runtime change, event injection).
2. Backend validates payload and mutates runtime/simulation.
3. Frontend refreshes `/api/state` and applies latest snapshot.

## 5) Concurrency, Consistency, and Determinism

- Backend mutation paths are serialized with `asyncio.Lock` in `SimulationRuntime`.
- Route cache is invalidated on event changes to avoid stale paths.
- Seeded RNG keeps simulation behavior reproducible for identical seed/input.
- Frontend ignores stale snapshots by comparing `sim_time_seconds` against last applied time.

## 6) Key Extension Points

- Add new scenario source:
  - Implement `ScenarioPlugin` in `plugins.py`, register in `factory.py`.
- Add new event behavior:
  - Extend event payload validation in `server.py` and event effects in `simulation.py`.
- Tune routing realism:
  - Update edge-cost model in `graph.py`.
- Change visualization behavior:
  - Adjust scene update/animation logic in `scene.ts`, orchestration in `main.ts`.

## 7) Operational Notes

- Backend API port: `8000`.
- Frontend dev port: `8080`.
- WebSocket endpoint: `/ws/state`.
- Most frontend visuals rely on `state.graph`, `state.residents`, `state.active_events`, and `state.last_metrics` from backend snapshots.
