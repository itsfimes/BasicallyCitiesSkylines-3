"""FastAPI runtime wrapper for the simulation core.

This module exposes REST endpoints and a WebSocket stream for live state
updates. SimulationRuntime serializes access to CitySimulation, runs the
background ticking loop, and broadcasts snapshots to connected clients.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager, suppress
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from citysim.factory import build_simulation, build_simulation_from_import
from citysim.importer import import_osm_overpass_bbox
from citysim.types import EventType, SimulationEvent

logger = logging.getLogger("citysim.server")

ALLOWED_EVENT_TYPES = {"accident", "road_closure", "concert", "extreme_weather", "outage"}


class ResetPayload(BaseModel):
    seed: int = Field(default=42, ge=0)
    resident_count: int = Field(default=2500, ge=1, le=50000)


class StepPayload(BaseModel):
    count: int = Field(default=1, ge=1, le=500)


class EventPayload(BaseModel):
    event_id: str
    event_type: str
    duration_minutes: int = Field(ge=1, le=1440)
    payload: dict[str, Any] = Field(default_factory=dict)


class RuntimePayload(BaseModel):
    running: bool | None = None
    speed_multiplier: float | None = Field(default=None, ge=0.25, le=20.0)


class OsmImportPayload(BaseModel):
    south: float
    west: float
    north: float
    east: float
    seed: int = Field(default=42, ge=0)
    resident_count: int = Field(default=1500, ge=1, le=50000)


def parse_event_type(value: str) -> EventType:
    """Validate and narrow raw event type to supported literal union.

    Used by: SimulationRuntime.inject_event and request validation paths before
    constructing SimulationEvent objects.
    """
    if value in ALLOWED_EVENT_TYPES:
        return value  # type: ignore[return-value]
    raise ValueError(f"Unsupported event_type: {value}")


class SimulationRuntime:
    def __init__(self) -> None:
        """Create runtime wrapper around active simulation instance.

        Used by: module-level singleton `runtime` consumed by all API/WS routes
        and the background ticking loop.
        """
        self.lock = asyncio.Lock()
        self.simulation = build_simulation(seed=42, resident_count=2500)
        self.running = True
        self.tick_seconds = 1.0
        self._subscribers: list[asyncio.Queue[dict[str, Any]]] = []
        self._run_id = 1
        self._tick_id = 0
        self._last_tick_mono: float | None = None

    def _speed_multiplier(self) -> float:
        return round(max(0.1, 1.0 / max(0.05, self.tick_seconds)), 3)

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        """Register a websocket subscriber queue for tick broadcasts.

        Used by: websocket_state endpoint when clients connect to /ws/state.
        """
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        """Remove a subscriber queue from broadcast fanout.

        Used by: websocket connection teardown and backpressure cleanup logic.
        """
        with suppress(ValueError):
            self._subscribers.remove(queue)

    async def broadcast(self, data: dict[str, Any]) -> None:
        """Push a payload to all subscriber queues without blocking.

        Used by: advance_background_tick after each live simulation step.
        """
        dead: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(queue)
        for queue in dead:
            self.unsubscribe(queue)

    async def reset(self, seed: int, resident_count: int) -> None:
        """Rebuild simulation with requested seed and population size.

        Used by: POST /api/reset handler in this module.
        """
        async with self.lock:
            self.simulation = build_simulation(seed=seed, resident_count=resident_count)
            self._run_id += 1
            self._tick_id = 0
            self._last_tick_mono = None
        logger.info("Simulation reset: seed=%d, residents=%d", seed, resident_count)

    async def step(self, count: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Run manual ticks only when live mode is paused.

        Used by: legacy/manual stepping flows; primary API path uses force_step.
        """
        metrics: list[dict[str, Any]] = []
        async with self.lock:
            if self.running:
                raise RuntimeError("Manual stepping is disabled while live mode is running")
            for _ in range(count):
                current = self.simulation.step(delta_seconds=1.0)
                metrics.append(
                    {
                        "sim_time_minute": current.sim_time_minute,
                        "traffic_density": current.traffic_density,
                        "avg_delay_minutes": current.avg_delay_minutes,
                        "emissions_kg_co2": current.emissions_kg_co2,
                        "energy_kwh": current.energy_kwh,
                    }
                )
            state = self.simulation.snapshot()
        return metrics, state

    async def advance_background_tick(self) -> bool:
        """Advance one live tick and broadcast resulting snapshot.

        Used by: background_tick_loop while runtime is in live-running mode.
        """
        async with self.lock:
            if not self.running:
                self._last_tick_mono = None
                return False
            now = time.perf_counter()
            if self._last_tick_mono is None:
                wall_delta_seconds = self.tick_seconds
            else:
                wall_delta_seconds = max(0.0, now - self._last_tick_mono)
            self._last_tick_mono = now
            speed_multiplier = self._speed_multiplier()
            sim_delta_seconds = max(0.05, wall_delta_seconds * speed_multiplier)
            self.simulation.step(delta_seconds=sim_delta_seconds)
            state = self.simulation.snapshot()
            self._tick_id += 1
            tick_payload = {
                "type": "tick",
                "state": state,
                "run_id": self._run_id,
                "tick_id": self._tick_id,
                "timing": {
                    "sim_time_seconds": state.get("sim_time_seconds"),
                    "sim_delta_seconds": round(sim_delta_seconds, 3),
                    "speed_multiplier": speed_multiplier,
                },
            }
        await self.broadcast(tick_payload)
        return True

    def snapshot(self) -> dict[str, Any]:
        """Return full state snapshot of active simulation.

        Used by: /api/state responses and websocket tick envelopes.
        """
        return self.simulation.snapshot()

    def snapshot_summary(self) -> dict[str, Any]:
        """Return lightweight state payload without full resident list.

        Used by: /api/state/summary endpoint for lower-bandwidth UI refreshes.
        """
        sim = self.simulation
        return {
            "minute": sim.minute,
            "sim_time_seconds": round(sim.sim_time_seconds, 3),
            "seed": sim.seed,
            "weather": sim.weather.value,
            "active_events": [
                {
                    "event_id": event.event_id,
                    "event_type": event.event_type,
                    "start_minute": event.start_minute,
                    "duration_minutes": event.duration_minutes,
                    "payload": event.payload,
                }
                for event in sim.active_events
            ],
            "graph": {
                "nodes": [
                    {"node_id": node.node_id, "x": node.x, "y": node.y}
                    for node in sim.graph.nodes.values()
                ],
                "edges": [
                    {
                        "edge_id": edge.edge_id,
                        "source": edge.source,
                        "target": edge.target,
                        "distance_m": edge.distance_m,
                        "blocked": edge.blocked,
                        "congestion": edge.congestion,
                    }
                    for edge in sim.graph.edges.values()
                ],
            },
            "last_metrics": {
                "sim_time_minute": sim.last_metrics.sim_time_minute,
                "traffic_density": sim.last_metrics.traffic_density,
                "avg_delay_minutes": sim.last_metrics.avg_delay_minutes,
                "emissions_kg_co2": sim.last_metrics.emissions_kg_co2,
                "energy_kwh": sim.last_metrics.energy_kwh,
            }
            if sim.last_metrics is not None
            else None,
            "resident_summary": {
                "total": len(sim.residents),
                "moving": sum(1 for r in sim.residents.values() if r.moving_edge_id is not None),
                "delayed": sum(1 for r in sim.residents.values() if r.delayed_minutes > 0),
            },
        }

    async def inject_event(self, payload: dict[str, Any]) -> None:
        """Create and inject a validated simulation event from request payload.

        Used by: POST /api/event handler after validate_event_payload checks.
        """
        event_type_raw = str(payload["event_type"])
        if event_type_raw not in ALLOWED_EVENT_TYPES:
            raise ValueError(f"Unsupported event_type: {event_type_raw}")
        event_type = parse_event_type(event_type_raw)
        async with self.lock:
            start_minute_raw = payload.get("start_minute")
            if start_minute_raw is None:
                start_minute = int(self.simulation.sim_time_seconds // 60)
            else:
                start_minute = int(start_minute_raw)
            event = SimulationEvent(
                event_id=str(payload["event_id"]),
                event_type=event_type,
                start_minute=start_minute,
                duration_minutes=int(payload["duration_minutes"]),
                payload=dict(payload.get("payload", {})),
            )
            self.simulation.inject_event(event)
        logger.info("Event injected: %s (%s) at minute %d", event.event_id, event.event_type, start_minute)

    def replay_log(self, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        """Return paginated simulation event-log entries.

        Used by: GET /api/logs endpoint in this module.
        """
        log = list(self.simulation.event_log)
        return log[offset : offset + limit]

    def runtime_status(self) -> dict[str, Any]:
        """Expose live-mode flags and effective tick-speed settings.

        Used by: GET /api/runtime and control synchronization in frontend/main.
        """
        speed_multiplier = self._speed_multiplier()
        return {
            "running": self.running,
            "tick_seconds": self.tick_seconds,
            "speed_multiplier": speed_multiplier,
            "run_id": self._run_id,
            "tick_id": self._tick_id,
        }

    async def force_step(self, count: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Run explicit simulation steps regardless of live-running flag.

        Used by: POST /api/step handler after route-level live-mode guard.
        """
        metrics: list[dict[str, Any]] = []
        async with self.lock:
            for _ in range(count):
                current = self.simulation.step(delta_seconds=1.0)
                metrics.append(
                    {
                        "sim_time_minute": current.sim_time_minute,
                        "traffic_density": current.traffic_density,
                        "avg_delay_minutes": current.avg_delay_minutes,
                        "emissions_kg_co2": current.emissions_kg_co2,
                        "energy_kwh": current.energy_kwh,
                    }
                )
            state = self.simulation.snapshot()
        return metrics, state

    async def configure_runtime(
        self, running: bool | None = None, speed_multiplier: float | None = None
    ) -> dict[str, Any]:
        """Update runtime live/pacing settings and return normalized status.

        Used by: POST /api/runtime and frontend live control synchronization.
        """
        async with self.lock:
            if running is not None:
                self.running = bool(running)
                self._last_tick_mono = None
            if speed_multiplier is not None:
                safe_speed = max(0.25, min(20.0, float(speed_multiplier)))
                self.tick_seconds = max(0.05, 1.0 / safe_speed)
                self._last_tick_mono = None
            speed_multiplier_value = self._speed_multiplier()
            return {
                "running": self.running,
                "tick_seconds": self.tick_seconds,
                "speed_multiplier": speed_multiplier_value,
                "run_id": self._run_id,
                "tick_id": self._tick_id,
            }

    async def import_osm_bbox(
        self, south: float, west: float, north: float, east: float, seed: int, resident_count: int
    ) -> None:
        """Import OSM bbox data and swap current simulation instance.

        Used by: POST /api/import/osm-bbox endpoint for dynamic map loading.
        """
        imported = import_osm_overpass_bbox(south=south, west=west, north=north, east=east)
        async with self.lock:
            self.simulation = build_simulation_from_import(imported, seed=seed, resident_count=resident_count)
            self._run_id += 1
            self._tick_id = 0
            self._last_tick_mono = None
        logger.info("OSM import complete: bbox(%.4f,%.4f,%.4f,%.4f)", south, west, north, east)


runtime = SimulationRuntime()


def validate_event_payload(payload: dict[str, Any]) -> None:
    """Validate endpoint event payload against required fields per event type.

    Used by: POST /api/event handler before delegating to runtime injection.
    """
    required = {"event_id", "event_type", "duration_minutes"}
    missing = sorted(required - set(payload.keys()))
    if missing:
        raise ValueError(f"Missing required event fields: {', '.join(missing)}")
    event_type_raw = str(payload["event_type"])
    if event_type_raw not in ALLOWED_EVENT_TYPES:
        raise ValueError(f"Unsupported event_type: {event_type_raw}")
    event_payload = payload.get("payload", {})
    if not isinstance(event_payload, dict):
        raise ValueError("payload must be an object")
    if event_type_raw in {"accident", "road_closure"} and "edge_id" not in event_payload:
        raise ValueError(f"payload.edge_id is required for {event_type_raw}")
    if event_type_raw == "concert" and "node_id" not in event_payload:
        raise ValueError("payload.node_id is required for concert")
    if event_type_raw == "extreme_weather" and "weather" not in event_payload:
        raise ValueError("payload.weather is required for extreme_weather")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage server startup/shutdown hooks around background ticking task.

    Used by: FastAPI app initialization to run and cancel background_tick_loop.
    """
    task = asyncio.create_task(background_tick_loop())
    logger.info("CitySim server starting")
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    logger.info("CitySim server stopped")


app = FastAPI(title="CitySim API", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health():
    """Return basic liveness probe response.

    Used by: monitoring, readiness checks, and developer smoke tests.
    """
    return {"status": "ok"}


@app.get("/api/state")
async def get_state():
    """Serve full simulation snapshot payload.

    Used by: frontend initial refresh and periodic pull fallback.
    """
    state = runtime.snapshot()
    rt = runtime.runtime_status()
    return {
        "state": state,
        "run_id": rt["run_id"],
        "tick_id": rt["tick_id"],
        "timing": {
            "sim_time_seconds": state.get("sim_time_seconds"),
            "sim_delta_seconds": None,
            "speed_multiplier": rt["speed_multiplier"],
        },
    }


@app.get("/api/state/summary")
async def get_state_summary():
    """Serve compact simulation snapshot without resident list.

    Used by: clients needing high-level city state at lower payload cost.
    """
    return {"state": runtime.snapshot_summary()}


@app.get("/api/residents")
async def get_residents(
    limit: int = Query(default=100, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
):
    """Serve paginated resident movement/activity state entries.

    Used by: frontend and tooling that inspect agent-level details.
    """
    sim = runtime.simulation
    residents = list(sim.residents.values())
    page = residents[offset : offset + limit]
    return {
        "total": len(residents),
        "limit": limit,
        "offset": offset,
        "residents": [
            {
                "resident_id": r.resident_id,
                "current_node_id": r.current_node_id,
                "mode": r.mode,
                "behavior_profile": r.behavior_profile,
                "activity": r.current_activity,
                "delayed_minutes": r.delayed_minutes,
                "moving_edge_id": r.moving_edge_id,
                "moving_total_seconds": round(r.moving_total_seconds, 3),
                "moving_remaining_seconds": round(max(0.0, r.moving_remaining_seconds), 3),
            }
            for r in page
        ],
    }


@app.get("/api/logs")
async def get_logs(
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    """Serve paginated historical tick/event log entries.

    Used by: debugging and timeline inspection workflows.
    """
    return {"logs": runtime.replay_log(limit=limit, offset=offset)}


@app.get("/api/runtime")
async def get_runtime():
    """Return current runtime live/pacing configuration.

    Used by: frontend startup synchronization of live control widgets.
    """
    return {"runtime": runtime.runtime_status()}


@app.post("/api/reset")
async def reset_simulation(payload: ResetPayload):
    """Reset simulation instance with provided seed and population size.

    Used by: dashboard reset action and automation scenarios.
    """
    await runtime.reset(seed=payload.seed, resident_count=payload.resident_count)
    return {"status": "reset", "seed": payload.seed, "resident_count": payload.resident_count}


@app.post("/api/step")
async def step_simulation(payload: StepPayload):
    """Run explicit manual simulation steps while live mode is paused.

    Used by: step-based experimentation and testing workflows.
    """
    if runtime.running:
        raise HTTPException(status_code=409, detail="Manual stepping is disabled while live mode is running")
    metrics, state = await runtime.force_step(count=payload.count)
    return {"status": "ok", "metrics": metrics, "state": state}


@app.post("/api/event")
async def inject_event(payload: EventPayload):
    """Validate and inject a runtime event into active simulation.

    Used by: dashboard incident form and automated scenario scripts.
    """
    data = payload.model_dump()
    validate_event_payload(data)
    await runtime.inject_event(data)
    return {"status": "event_injected", "event_id": payload.event_id}


@app.post("/api/runtime")
async def configure_runtime(payload: RuntimePayload):
    """Toggle live mode and/or adjust simulation speed multiplier.

    Used by: frontend live controls for pause/resume and speed changes.
    """
    status = await runtime.configure_runtime(
        running=payload.running,
        speed_multiplier=payload.speed_multiplier,
    )
    return {"status": "runtime_updated", "runtime": status}


@app.post("/api/import/osm-bbox")
async def import_osm_bbox(payload: OsmImportPayload):
    """Import OSM region and replace current simulation topology.

    Used by: external tooling and operators loading custom map regions.
    """
    await runtime.import_osm_bbox(
        south=payload.south,
        west=payload.west,
        north=payload.north,
        east=payload.east,
        seed=payload.seed,
        resident_count=payload.resident_count,
    )
    return {"status": "imported_osm_bbox"}


@app.websocket("/ws/state")
async def websocket_state(websocket: WebSocket):
    """Stream live tick snapshots and keepalive pings to connected clients.

    Used by: frontend realtime updates in frontend/src/api.ts connectWebSocket.
    """
    await websocket.accept()
    queue = runtime.subscribe()
    try:
        while True:
            try:
                data = await asyncio.wait_for(queue.get(), timeout=30.0)
                await websocket.send_json(data)
            except TimeoutError:
                await websocket.send_json({"type": "ping"})
    except (WebSocketDisconnect, ConnectionError):
        pass
    finally:
        runtime.unsubscribe(queue)


async def background_tick_loop() -> None:
    """Continuously advance runtime at configured tick interval.

    Used by: lifespan-managed background task as the live simulation driver.
    """
    try:
        while True:
            await asyncio.sleep(runtime.tick_seconds)
            await runtime.advance_background_tick()
    except asyncio.CancelledError:
        pass


def setup_logging() -> None:
    """Configure process-wide logging defaults for backend services.

    Used by: run() before launching uvicorn server process.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def run() -> None:
    """Start the FastAPI app with uvicorn on the backend port.

    Used by: run_backend.py and direct module execution.
    """
    setup_logging()
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


if __name__ == "__main__":
    run()
