# CitySim Architecture and Trade-offs

## Chosen simulation model

The system uses a discrete-time simulation with second-based ticks.

Reasoning:
- Traffic and event systems use second-level progression while preserving minute-level scenario semantics.
- Deterministic reproducibility is easier than in wall-clock continuous simulation.
- It supports scenario replay and comparison for decision-making.

## Core architecture

Layers:
1. Data/import layer (`citysim/importer.py`) for JSON and OpenStreetMap Overpass input.
2. Simulation core (`citysim/simulation.py`, `citysim/graph.py`) with agent-based residents and route decisions.
3. Scenario/plugin layer (`citysim/plugins.py`) for reusable event packs.
4. API/runtime layer (`citysim/server.py`) for control, stepping, event injection, and replay logs.
5. Frontend layer (`frontend/*`) for visualization and dashboard metrics.

## City model and realism

- Graph model: intersections as nodes, roads as directed edges.
- Buildings: work, school, leisure, home capacities.
- Residents are autonomous agents selecting destinations and routes.
- Multi-modal mobility: car, public transport, bike, walk.
- Uncertainty model: weather and uncertainty factor increase travel time stochastically/structurally.

## Event model

Supported events:
- Traffic accident
- Road closure
- Concert/festival
- Extreme weather
- Infrastructure outage

All events can be scenario-driven (plugin schedule) or injected via API.

## Scalability and modularity

- Designed for thousands of agents with compact in-memory structures.
- Plugin interface allows adding scenarios without editing core engine.
- API control enables external integration with optimizers/decision tools.

## Logging and reproducibility

- Seeded random generation for deterministic runs.
- Tick-level event/metric log for replay and auditability.
- Reset API supports deterministic reruns with same seed and population size.

## Trade-offs

- Chose pure Python stdlib HTTP server instead of external frameworks to keep setup dependency-free.
- Uses Overpass API directly for OSM extraction; suitable for small/medium regions and prototyping.
- Current visualization is 2D SVG for transparency and debugging over visual polish.

## Hidden challenges encountered and handled

- Route feasibility under closures: model handles unreachable targets with delay accumulation.
- Data uncertainty: represented via edge quality + weather + uncertainty multipliers.
- Mixed events interactions: event precedence handled per tick with reset/apply order.
