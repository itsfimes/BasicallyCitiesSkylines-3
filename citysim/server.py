from __future__ import annotations

import json
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from citysim.factory import build_simulation, build_simulation_from_import
from citysim.importer import import_osm_overpass_bbox
from citysim.types import EventType, SimulationEvent


ALLOWED_EVENT_TYPES = {"accident", "road_closure", "concert", "extreme_weather", "outage"}


def parse_event_type(value: str) -> EventType:
    if value == "accident":
        return "accident"
    if value == "road_closure":
        return "road_closure"
    if value == "concert":
        return "concert"
    if value == "extreme_weather":
        return "extreme_weather"
    if value == "outage":
        return "outage"
    raise ValueError(f"Unsupported event_type: {value}")


class SimulationRuntime:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.simulation = build_simulation(seed=42, resident_count=2500)
        self.running = True
        self.tick_seconds = 1.0

    def reset(self, seed: int, resident_count: int) -> None:
        with self.lock:
            self.simulation = build_simulation(seed=seed, resident_count=resident_count)

    def step(self, count: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        metrics: list[dict[str, Any]] = []
        with self.lock:
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

    def advance_background_tick(self) -> bool:
        with self.lock:
            if not self.running:
                return False
            self.simulation.step(delta_seconds=1.0)
            return True

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return self.simulation.snapshot()

    def inject_event(self, payload: dict[str, Any]) -> None:
        event_type_raw = str(payload["event_type"])
        if event_type_raw not in ALLOWED_EVENT_TYPES:
            raise ValueError(f"Unsupported event_type: {event_type_raw}")
        event_type = parse_event_type(event_type_raw)
        with self.lock:
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

    def replay_log(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.simulation.event_log)

    def runtime_status(self) -> dict[str, Any]:
        with self.lock:
            speed_multiplier = round(max(0.1, 1.0 / max(0.05, self.tick_seconds)), 3)
            return {
                "running": self.running,
                "tick_seconds": self.tick_seconds,
                "speed_multiplier": speed_multiplier,
            }

    def force_step(self, count: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        metrics: list[dict[str, Any]] = []
        with self.lock:
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

    def configure_runtime(self, running: bool | None = None, speed_multiplier: float | None = None) -> dict[str, Any]:
        with self.lock:
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

    def import_osm_bbox(self, south: float, west: float, north: float, east: float, seed: int, resident_count: int) -> None:
        imported = import_osm_overpass_bbox(south=south, west=west, north=north, east=east)
        with self.lock:
            self.simulation = build_simulation_from_import(imported, seed=seed, resident_count=resident_count)


runtime = SimulationRuntime()


class CitySimHandler(BaseHTTPRequestHandler):
    def _send(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSON: {error.msg}") from error
        if not isinstance(data, dict):
            raise ValueError("Invalid JSON payload")
        return data

    def _send_error_json(self, status: int, message: str) -> None:
        self._send({"error": message}, status=status)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send({"status": "ok"})
            return
        if self.path == "/api/state":
            self._send({"state": runtime.snapshot()})
            return
        if self.path == "/api/logs":
            self._send({"logs": runtime.replay_log()})
            return
        if self.path == "/api/runtime":
            self._send({"runtime": runtime.runtime_status()})
            return
        self._send({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/api/reset":
                payload = self._read_json()
                seed = int(payload.get("seed", 42))
                residents = int(payload.get("resident_count", 2500))
                runtime.reset(seed=seed, resident_count=residents)
                self._send({"status": "reset", "seed": seed, "resident_count": residents})
                return
            if self.path == "/api/step":
                payload = self._read_json()
                count = int(payload.get("count", 1))
                count = max(1, min(500, count))
                if runtime.runtime_status()["running"]:
                    raise RuntimeError("Manual stepping is disabled while live mode is running")
                metrics, state = runtime.force_step(count=count)
                self._send({"status": "ok", "metrics": metrics, "state": state})
                return
            if self.path == "/api/event":
                payload = self._read_json()
                validate_event_payload(payload)
                runtime.inject_event(payload)
                self._send({"status": "event_injected", "event_id": payload.get("event_id")})
                return
            if self.path == "/api/runtime":
                payload = self._read_json()
                running_value = payload.get("running")
                speed_value = payload.get("speed_multiplier")
                if running_value is not None and not isinstance(running_value, bool):
                    raise ValueError("running must be a boolean")
                running = running_value if isinstance(running_value, bool) else None
                speed_multiplier = float(speed_value) if speed_value is not None else None
                status = runtime.configure_runtime(running=running, speed_multiplier=speed_multiplier)
                self._send({"status": "runtime_updated", "runtime": status})
                return
            if self.path == "/api/import/osm-bbox":
                payload = self._read_json()
                runtime.import_osm_bbox(
                    south=float(payload["south"]),
                    west=float(payload["west"]),
                    north=float(payload["north"]),
                    east=float(payload["east"]),
                    seed=int(payload.get("seed", 42)),
                    resident_count=int(payload.get("resident_count", 1500)),
                )
                self._send({"status": "imported_osm_bbox"})
                return
            self._send({"error": "not_found"}, status=HTTPStatus.NOT_FOUND)
        except (ValueError, KeyError, RuntimeError) as error:
            status = HTTPStatus.CONFLICT if isinstance(error, RuntimeError) else HTTPStatus.BAD_REQUEST
            self._send_error_json(status=status, message=str(error))


def _background_loop() -> None:
    while True:
        time.sleep(runtime.tick_seconds)
        runtime.advance_background_tick()


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


def create_app() -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("0.0.0.0", 8000), CitySimHandler)


def run() -> None:
    thread = threading.Thread(target=_background_loop, daemon=True)
    thread.start()
    server = create_app()
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
