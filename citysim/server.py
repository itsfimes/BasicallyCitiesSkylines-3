from __future__ import annotations

import asyncio
import logging
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
    if value in ALLOWED_EVENT_TYPES:
        return value  # type: ignore[return-value]
    raise ValueError(f"Unsupported event_type: {value}")


class SimulationRuntime:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.simulation = build_simulation(seed=42, resident_count=2500)
        self.running = True
        self.tick_seconds = 1.0
        self._subscribers: list[asyncio.Queue[dict[str, Any]]] = []

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        with suppress(ValueError):
            self._subscribers.remove(queue)

    async def broadcast(self, data: dict[str, Any]) -> None:
        dead: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(queue)
        for queue in dead:
            self.unsubscribe(queue)

    async def reset(self, seed: int, resident_count: int) -> None:
        async with self.lock:
            self.simulation = build_simulation(seed=seed, resident_count=resident_count)
        logger.info("Simulation reset: seed=%d, residents=%d", seed, resident_count)

    async def step(self, count: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
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
        async with self.lock:
            if not self.running:
                return False
            self.simulation.step(delta_seconds=self.tick_seconds)
        state = self.snapshot()
        await self.broadcast({"type": "tick", "state": state})
        return True

    def snapshot(self) -> dict[str, Any]:
        return self.simulation.snapshot()

    def snapshot_summary(self) -> dict[str, Any]:
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
        log = list(self.simulation.event_log)
        return log[offset : offset + limit]

    def runtime_status(self) -> dict[str, Any]:
        speed_multiplier = round(max(0.1, 1.0 / max(0.05, self.tick_seconds)), 3)
        return {
            "running": self.running,
            "tick_seconds": self.tick_seconds,
            "speed_multiplier": speed_multiplier,
        }

    async def force_step(self, count: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
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
        async with self.lock:
            if running is not None:
                self.running = bool(running)
            if speed_multiplier is not None:
                safe_speed = max(0.25, min(20.0, float(speed_multiplier)))
                self.tick_seconds = max(0.05, 1.0 / safe_speed)
            speed_multiplier_value = round(max(0.1, 1.0 / max(0.05, self.tick_seconds)), 3)
            return {
                "running": self.running,
                "tick_seconds": self.tick_seconds,
                "speed_multiplier": speed_multiplier_value,
            }

    async def import_osm_bbox(
        self, south: float, west: float, north: float, east: float, seed: int, resident_count: int
    ) -> None:
        imported = import_osm_overpass_bbox(south=south, west=west, north=north, east=east)
        async with self.lock:
            self.simulation = build_simulation_from_import(imported, seed=seed, resident_count=resident_count)
        logger.info("OSM import complete: bbox(%.4f,%.4f,%.4f,%.4f)", south, west, north, east)


runtime = SimulationRuntime()


def validate_event_payload(payload: dict[str, Any]) -> None:
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
    return {"status": "ok"}


@app.get("/api/state")
async def get_state():
    return {"state": runtime.snapshot()}


@app.get("/api/state/summary")
async def get_state_summary():
    return {"state": runtime.snapshot_summary()}


@app.get("/api/residents")
async def get_residents(
    limit: int = Query(default=100, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
):
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
    return {"logs": runtime.replay_log(limit=limit, offset=offset)}


@app.get("/api/runtime")
async def get_runtime():
    return {"runtime": runtime.runtime_status()}


@app.post("/api/reset")
async def reset_simulation(payload: ResetPayload):
    await runtime.reset(seed=payload.seed, resident_count=payload.resident_count)
    return {"status": "reset", "seed": payload.seed, "resident_count": payload.resident_count}


@app.post("/api/step")
async def step_simulation(payload: StepPayload):
    if runtime.running:
        raise HTTPException(status_code=409, detail="Manual stepping is disabled while live mode is running")
    metrics, state = await runtime.force_step(count=payload.count)
    return {"status": "ok", "metrics": metrics, "state": state}


@app.post("/api/event")
async def inject_event(payload: EventPayload):
    data = payload.model_dump()
    validate_event_payload(data)
    await runtime.inject_event(data)
    return {"status": "event_injected", "event_id": payload.event_id}


@app.post("/api/runtime")
async def configure_runtime(payload: RuntimePayload):
    status = await runtime.configure_runtime(
        running=payload.running,
        speed_multiplier=payload.speed_multiplier,
    )
    return {"status": "runtime_updated", "runtime": status}


@app.post("/api/import/osm-bbox")
async def import_osm_bbox(payload: OsmImportPayload):
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
    try:
        while True:
            await asyncio.sleep(runtime.tick_seconds)
            await runtime.advance_background_tick()
    except asyncio.CancelledError:
        pass


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def run() -> None:
    setup_logging()
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


if __name__ == "__main__":
    run()
