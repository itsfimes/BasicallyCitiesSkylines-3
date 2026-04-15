# Design Choices and Trade-offs

This document explains the main design decisions made for the assignment and why each decision was chosen.

## 1) Simulation model: discrete-time, second-based

### Decision
Use a discrete simulation with **1-second ticks** in the runtime loop, while preserving minute-based event semantics (`start_minute`, `duration_minutes`) for scenario authoring.

### Why
- Predictable and reproducible behavior is easier with fixed timesteps.
- Real-time visualization feels live when simulation advances every second.
- Existing scenario files remain readable and practical with minute-level event schedules.

### Trade-off
- A fully continuous physics-style model could be smoother for movement, but is more complex and harder to keep deterministic.

## 2) Agent-based intelligence (Task 4 path)

### Decision
Implement intelligence through an **agent-based model** instead of traffic-light optimization or ML prediction.

### Why
- Assignment accepts one of the options; agent-based behavior is the most direct fit to "residents with different behaviors".
- This project already had resident entities; extending them was lower-risk and more maintainable.

### Trade-off
- No predictive ML layer is included.
- Routing is shortest-path based; it does not yet include strategic agent learning.

## 3) Resident behavior profiles

### Decision
Add resident behavior profiles (`worker`, `student`, `leisure_oriented`) and profile-specific daily target patterns.

### Why
- Satisfies the requirement for differentiated resident behavior (work/school/leisure).
- Keeps behavior explicit and testable.

### Trade-off
- Behavior remains schedule-driven rather than probabilistic/adaptive.

## 4) Real data and external import

### Decision
Support two ingestion paths:
- JSON dataset import (`import_from_json`)
- OpenStreetMap import via Overpass API (`import_osm_overpass_bbox`)

### Why
- Covers assignment requirement for real/open data and external dataset import.
- JSON path enables deterministic local datasets; OSM path enables real-world topologies.

### Trade-off
- Overpass API introduces network dependency and possible rate/timeout limitations.

## 5) Uncertainty and realism model

### Decision
Travel time combines weather factor, quality penalty, congestion factor, and uncertainty factor.

### Why
- Gives explainable realism knobs instead of opaque heuristics.
- Easy to reason about in tests and scenario analysis.

### Trade-off
- Macro-level realism is good, but micro-level driving behavior is simplified.

## 6) Events model

### Decision
Implement required events in core engine:
- accident
- road_closure
- concert
- extreme_weather
- outage (additional stress event)

With strict start-time gating (`start_minute`) and duration expiry.

### Why
- Required by assignment and needed for what-if scenarios.
- API and plugin scheduling both feed the same event processing path.

### Trade-off
- Event interactions are rule-based and deterministic, not stochastic incident propagation.

## 7) Backend architecture

### Decision
Use Python stdlib HTTP server with a shared runtime object guarded by a lock.

### Why
- Zero external framework dependency.
- Simple deployment and straightforward API surface for this project scope.

### Trade-off
- Not as feature-rich as FastAPI/ASGI stack for larger production systems.

## 8) API design

### Decision
Expose explicit control/state endpoints:
- `GET /health`
- `GET /api/state`
- `GET /api/logs`
- `GET /api/runtime`
- `POST /api/reset`
- `POST /api/event`
- `POST /api/runtime`
- `POST /api/step` (manual force-step path; guarded while live mode is running)

### Why
- Keeps frontend simple and supports external automation.
- Enables reproducible scripts and scenario testing tools.

### Trade-off
- Manual step endpoint is retained for tooling compatibility even though UI is live-first.

## 9) Frontend visualization approach

### Decision
Use a lightweight **3D scene** (Three.js) + metric dashboard.

### Why
- Satisfies visualization requirement and gives intuitive network-state perception.
- Metric cards directly expose assignment KPIs: density, delay, emissions, energy.

### Trade-off
- Three.js client rendering can become expensive if object churn is not controlled.

## 10) Performance strategy for live UI

### Decision
Reduce per-refresh churn by:
- caching/reusing road and vehicle materials
- upserting road meshes by `edge_id`
- reusing vehicle meshes by stable keys
- reducing full-group clears
- weather rebuild only on actual weather-type change

### Why
- Prevents UI freezes during polling.
- Improves smoothness while keeping backend-authoritative state.

### Trade-off
- More bookkeeping maps in frontend state.

## 11) Vehicle motion consistency

### Decision
Use backend-provided movement fields (`moving_total_seconds`, `moving_remaining_seconds`) and interpolate between snapshots.

### Why
- Reduces teleporting artifacts and keeps render aligned with server truth.

### Trade-off
- Cross-edge transitions are still simplified and may show minor visual pops under extreme load.

## 12) Reproducibility and logging

### Decision
Keep deterministic seed-based generation and append simulation event/metric log every tick.

### Why
- Supports replay, comparison, and decision-audit workflows.

### Trade-off
- Determinism can mask some real-world randomness unless explicitly injected via uncertainty parameters.

## 13) Testing strategy

### Decision
Use focused unit tests for assignment-critical behaviors:
- reproducibility by seed
- event effects
- event start-time gating
- second-based progression
- data import
- uncertainty/weather effects
- agent behavior/profile activity updates

### Why
- Keeps acceptance criteria executable and protects against regressions.

### Trade-off
- Browser-level rendering performance is not fully covered by automated tests.
