from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from citysim.graph import CityGraph
from citysim.plugins import ScenarioPlugin
from citysim.randomness import SeededRandom
from citysim.types import (
    ActivityType,
    Building,
    Resident,
    SimulationEvent,
    SimulationMetrics,
    TransportMode,
    WeatherType,
)

logger = logging.getLogger("citysim.simulation")

MODE_EMISSIONS_KG_PER_KM = {
    "car": 0.21,
    "public_transport": 0.08,
    "bike": 0.0,
    "walk": 0.0,
}

MODE_ENERGY_KWH_PER_KM = {
    "car": 0.18,
    "public_transport": 0.12,
    "bike": 0.01,
    "walk": 0.0,
}

MODE_MAX_DISTANCE_KM = {
    "walk": 2.0,
    "bike": 8.0,
    "public_transport": 30.0,
    "car": 100.0,
}

BEHAVIOR_SCHEDULES: dict[str, dict[int, ActivityType]] = {
    "worker": {
        0: "home",
        1: "home",
        2: "home",
        3: "home",
        4: "home",
        5: "home",
        6: "home",
        7: "work",
        8: "work",
        9: "work",
        10: "work",
        11: "work",
        12: "work",
        13: "work",
        14: "work",
        15: "work",
        16: "work",
        17: "leisure",
        18: "leisure",
        19: "home",
        20: "home",
        21: "home",
        22: "home",
        23: "home",
    },
    "student": {
        0: "home",
        1: "home",
        2: "home",
        3: "home",
        4: "home",
        5: "home",
        6: "home",
        7: "school",
        8: "school",
        9: "school",
        10: "school",
        11: "school",
        12: "school",
        13: "school",
        14: "school",
        15: "school",
        16: "leisure",
        17: "leisure",
        18: "leisure",
        19: "home",
        20: "home",
        21: "home",
        22: "home",
        23: "home",
    },
    "leisure_oriented": {
        0: "home",
        1: "home",
        2: "home",
        3: "home",
        4: "home",
        5: "home",
        6: "home",
        7: "home",
        8: "leisure",
        9: "leisure",
        10: "leisure",
        11: "work",
        12: "work",
        13: "leisure",
        14: "leisure",
        15: "leisure",
        16: "leisure",
        17: "leisure",
        18: "leisure",
        19: "leisure",
        20: "home",
        21: "home",
        22: "home",
        23: "home",
    },
}


@dataclass(slots=True)
class TrafficLight:
    node_id: str
    phase_seconds: int = 60
    green_ratio: float = 0.5
    offset_seconds: int = 0

    def is_green(self, sim_time_seconds: float, edge_source: str) -> bool:
        cycle_position = (sim_time_seconds + self.offset_seconds) % self.phase_seconds
        green_seconds = self.phase_seconds * self.green_ratio
        return cycle_position < green_seconds


def _as_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def choose_transport_mode(
    distance_m: float,
    weather: WeatherType,
    edge_congestion: float,
    available_modes: list[TransportMode],
    rng: SeededRandom,
) -> TransportMode:
    distance_km = distance_m / 1000.0
    candidates = list(available_modes)
    candidates = [m for m in candidates if distance_km <= MODE_MAX_DISTANCE_KM[m]]

    if weather in (WeatherType.RAIN, WeatherType.STORM, WeatherType.SNOW):
        candidates = [m for m in candidates if m != "bike"]
        if weather == WeatherType.STORM:
            candidates = [m for m in candidates if m != "walk"]

    if edge_congestion > 15 and "public_transport" in candidates and rng.float() < 0.3:
        return "public_transport"

    if not candidates:
        candidates = list(available_modes)

    weights: dict[TransportMode, float] = {}
    for mode in candidates:
        w = 1.0
        if mode == "walk" and distance_km < 1.0:
            w = 3.0
        elif mode == "bike" and distance_km < 3.0:
            w = 2.5
        elif mode == "public_transport" and distance_km > 2.0 or mode == "car" and distance_km > 5.0:
            w = 2.0
        weights[mode] = w

    total = sum(weights.values())
    roll = rng.float() * total
    cumulative = 0.0
    for mode in candidates:
        cumulative += weights[mode]
        if roll <= cumulative:
            return mode
    return candidates[-1]


@dataclass(slots=True)
class CitySimulation:
    graph: CityGraph
    buildings: dict[str, Building]
    residents: dict[str, Resident]
    rng: SeededRandom
    scenario_plugins: list[ScenarioPlugin]
    seed: int
    minute: int = 0
    sim_time_seconds: float = 0.0
    weather: WeatherType = WeatherType.CLEAR
    uncertainty_level: float = 0.05
    active_events: list[SimulationEvent] = field(default_factory=list)
    event_log: list[dict[str, object]] = field(default_factory=list)
    base_speed_kph_by_edge: dict[str, float] = field(default_factory=dict)
    edge_speed_factor_by_edge: dict[str, float] = field(default_factory=dict)
    last_plugin_minute: int = -1
    last_metrics: SimulationMetrics | None = None
    traffic_lights: dict[str, TrafficLight] = field(default_factory=dict)
    metrics_history: list[SimulationMetrics] = field(default_factory=list)
    max_metrics_history: int = 300

    def __post_init__(self) -> None:
        self.base_speed_kph_by_edge = {edge_id: edge.base_speed_kph for edge_id, edge in self.graph.edges.items()}
        self.edge_speed_factor_by_edge = {edge_id: 1.0 for edge_id in self.graph.edges}
        for node_id in self.graph.nodes:
            if len(self.graph.adjacency.get(node_id, [])) >= 2:
                self.traffic_lights[node_id] = TrafficLight(
                    node_id=node_id,
                    phase_seconds=60,
                    green_ratio=0.5,
                    offset_seconds=hash(node_id) % 60,
                )

    def step(self, delta_seconds: float = 60.0) -> SimulationMetrics:
        safe_delta_seconds = max(0.05, float(delta_seconds))
        self.sim_time_seconds += safe_delta_seconds
        self.minute = int(self.sim_time_seconds // 60)
        self._expire_events()
        self._ingest_plugin_events()
        self._apply_edge_resets(safe_delta_seconds)
        self._apply_active_events(safe_delta_seconds)
        self._advance_residents(safe_delta_seconds)
        metrics = self._compute_metrics(safe_delta_seconds)
        self.last_metrics = metrics
        self.metrics_history.append(metrics)
        if len(self.metrics_history) > self.max_metrics_history:
            self.metrics_history = self.metrics_history[-self.max_metrics_history:]
        self.event_log.append(
            {
                "minute": self.minute,
                "sim_time_seconds": round(self.sim_time_seconds, 3),
                "weather": self.weather.value,
                "metrics": {
                    "traffic_density": metrics.traffic_density,
                    "avg_delay_minutes": metrics.avg_delay_minutes,
                    "emissions_kg_co2": metrics.emissions_kg_co2,
                    "energy_kwh": metrics.energy_kwh,
                },
            }
        )
        if len(self.event_log) > 10000:
            self.event_log = self.event_log[-5000:]
        return metrics

    def inject_event(self, event: SimulationEvent) -> None:
        self.active_events.append(event)
        self.graph.invalidate_path_cache()

    def snapshot(self) -> dict[str, object]:
        return {
            "minute": self.minute,
            "sim_time_seconds": round(self.sim_time_seconds, 3),
            "seed": self.seed,
            "weather": self.weather.value,
            "active_events": [
                {
                    "event_id": event.event_id,
                    "event_type": event.event_type,
                    "start_minute": event.start_minute,
                    "duration_minutes": event.duration_minutes,
                    "payload": event.payload,
                }
                for event in self.active_events
            ],
            "residents": [
                {
                    "resident_id": resident.resident_id,
                    "current_node_id": resident.current_node_id,
                    "mode": resident.mode,
                    "behavior_profile": resident.behavior_profile,
                    "activity": resident.current_activity,
                    "delayed_minutes": resident.delayed_minutes,
                    "moving_edge_id": resident.moving_edge_id,
                    "moving_total_seconds": round(resident.moving_total_seconds, 3),
                    "moving_remaining_seconds": round(max(0.0, resident.moving_remaining_seconds), 3),
                    "moving_total_minutes": round(resident.moving_total_seconds / 60.0, 3),
                    "moving_remaining_minutes": round(max(0.0, resident.moving_remaining_seconds) / 60.0, 3),
                }
                for resident in self.residents.values()
            ],
            "graph": {
                "nodes": [
                    {"node_id": node.node_id, "x": node.x, "y": node.y}
                    for node in self.graph.nodes.values()
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
                    for edge in self.graph.edges.values()
                ],
            },
            "last_metrics": {
                "sim_time_minute": self.last_metrics.sim_time_minute,
                "traffic_density": self.last_metrics.traffic_density,
                "avg_delay_minutes": self.last_metrics.avg_delay_minutes,
                "emissions_kg_co2": self.last_metrics.emissions_kg_co2,
                "energy_kwh": self.last_metrics.energy_kwh,
            }
            if self.last_metrics is not None
            else None,
            "metrics_history": [
                {
                    "sim_time_minute": m.sim_time_minute,
                    "traffic_density": m.traffic_density,
                    "avg_delay_minutes": m.avg_delay_minutes,
                    "emissions_kg_co2": m.emissions_kg_co2,
                    "energy_kwh": m.energy_kwh,
                }
                for m in self.metrics_history[-60:]
            ],
        }

    def _hour_of_day(self) -> int:
        return int((self.minute // 60) % 24)

    def _desired_activity(self, resident: Resident) -> ActivityType:
        schedule = BEHAVIOR_SCHEDULES.get(resident.behavior_profile, BEHAVIOR_SCHEDULES["worker"])
        return schedule.get(self._hour_of_day(), "home")

    def _expire_events(self) -> None:
        still_active: list[SimulationEvent] = []
        for event in self.active_events:
            start_seconds = float(event.start_minute) * 60.0
            end_seconds = start_seconds + float(event.duration_minutes) * 60.0
            if self.sim_time_seconds < end_seconds:
                still_active.append(event)
            else:
                self.graph.invalidate_path_cache()
        self.active_events = still_active

    def _ingest_plugin_events(self) -> None:
        if self.minute == self.last_plugin_minute:
            return
        for plugin in self.scenario_plugins:
            new_events = plugin.produce_events(self.minute)
            if new_events:
                self.active_events.extend(new_events)
                self.graph.invalidate_path_cache()
        self.last_plugin_minute = self.minute

    def _apply_edge_resets(self, delta_seconds: float) -> None:
        decay_factor = max(0.75, min(0.995, 1.0 - delta_seconds * 0.015))
        for edge in self.graph.edges.values():
            edge.blocked = False
            edge.congestion = max(0.0, edge.congestion * decay_factor)
            edge.base_speed_kph = self.base_speed_kph_by_edge.get(edge.edge_id, edge.base_speed_kph)
            self.edge_speed_factor_by_edge[edge.edge_id] = 1.0

    def _apply_active_events(self, delta_seconds: float) -> None:
        self.weather = WeatherType.CLEAR
        weather_active = False
        minute_scale = max(0.05, delta_seconds / 60.0)
        for event in self.active_events:
            start_seconds = float(event.start_minute) * 60.0
            if self.sim_time_seconds < start_seconds:
                continue
            if event.event_type == "road_closure":
                edge_id = str(event.payload.get("edge_id", ""))
                edge = self.graph.edges.get(edge_id)
                if edge is not None:
                    edge.blocked = True
            elif event.event_type == "accident":
                edge_id = str(event.payload.get("edge_id", ""))
                edge = self.graph.edges.get(edge_id)
                if edge is not None:
                    edge.congestion += _as_int(event.payload.get("extra_load", 40), 40) * minute_scale
                    self.edge_speed_factor_by_edge[edge_id] = min(self.edge_speed_factor_by_edge.get(edge_id, 1.0), 0.7)
            elif event.event_type == "concert":
                target_node = str(event.payload.get("node_id", ""))
                if target_node:
                    for edge in self.graph.neighbors(target_node):
                        edge.congestion += _as_int(event.payload.get("extra_load", 60), 60) * minute_scale
            elif event.event_type == "extreme_weather":
                weather_value = str(event.payload.get("weather", "storm"))
                if weather_value in WeatherType._value2member_map_:
                    self.weather = WeatherType(weather_value)
                weather_active = True
            elif event.event_type == "outage":
                for edge in self.graph.edges.values():
                    edge.congestion += _as_int(event.payload.get("global_extra_load", 15), 15) * minute_scale

        for edge_id, speed_factor in self.edge_speed_factor_by_edge.items():
            edge = self.graph.edges.get(edge_id)
            if edge is None:
                continue
            base_speed = self.base_speed_kph_by_edge.get(edge_id, edge.base_speed_kph)
            edge.base_speed_kph = max(8.0, base_speed * speed_factor)

        if weather_active:
            self.uncertainty_level = {
                WeatherType.CLEAR: 0.05,
                WeatherType.RAIN: 0.1,
                WeatherType.STORM: 0.2,
                WeatherType.SNOW: 0.25,
            }[self.weather]
        else:
            self.uncertainty_level = max(0.05, self.uncertainty_level * (1.0 - min(0.08, delta_seconds * 0.01)))

    def _traffic_light_delay(self, edge: Any, resident: Resident) -> float:
        light = self.traffic_lights.get(edge.source)
        if light is None:
            return 0.0
        if not light.is_green(self.sim_time_seconds, edge.source):
            cycle_pos = (self.sim_time_seconds + light.offset_seconds) % light.phase_seconds
            remaining = light.phase_seconds - cycle_pos
            return min(remaining, light.phase_seconds * (1.0 - light.green_ratio))
        return 0.0

    def _advance_residents(self, delta_seconds: float) -> None:
        building_ids = list(self.buildings.keys())
        if not building_ids:
            return
        for resident in self.residents.values():
            if resident.moving_remaining_seconds > 0:
                if resident.moving_edge_id is not None and resident.moving_total_seconds > 0:
                    edge = self.graph.edges[resident.moving_edge_id]
                    speed_m_per_s = edge.distance_m / resident.moving_total_seconds
                    resident.tick_distance_m = speed_m_per_s * delta_seconds
                else:
                    resident.tick_distance_m = 0.0
                if not resident.route:
                    resident.current_activity = "home"
                else:
                    target_idx = min(resident.route_index, max(0, len(resident.daily_targets) - 1))
                    target_activity = self._activity_for_target(resident.daily_targets[target_idx])
                    resident.current_activity = target_activity
                resident.moving_remaining_seconds -= delta_seconds
                if resident.moving_remaining_seconds <= 0:
                    if resident.route and resident.route_index < len(resident.route):
                        edge = self.graph.edges[resident.route[resident.route_index]]
                        resident.current_node_id = edge.target
                        resident.route_index += 1
                    if resident.route_index <= 0:
                        resident.current_activity = "home"
                    else:
                        target_index = min(resident.route_index - 1, max(0, len(resident.daily_targets) - 1))
                        resident.current_activity = self._activity_for_target(resident.daily_targets[target_index])
                    resident.moving_edge_id = None
                    resident.moving_total_seconds = 0.0
                    resident.moving_remaining_seconds = 0.0
                continue

            if resident.route_index >= len(resident.route):
                desired = self._desired_activity(resident)
                destination_id = self._choose_destination_for_activity(resident, desired)
                destination = self.buildings.get(destination_id)
                if destination is None:
                    resident.delayed_minutes += 1
                    continue
                resident.route = self.graph.shortest_path(
                    source_id=resident.current_node_id,
                    target_id=destination.node_id,
                    weather=self.weather,
                    uncertainty=self.uncertainty_level,
                    tick=self.minute,
                )
                resident.route_index = 0
                if not resident.route:
                    resident.delayed_minutes += 1
                    continue

            edge_id = resident.route[resident.route_index]
            edge = self.graph.edges[edge_id]
            travel_minutes = self.graph.edge_travel_minutes(edge, self.weather, self.uncertainty_level)
            if travel_minutes >= 10**9:
                resident.delayed_minutes += 1
                resident.route = []
                resident.route_index = 0
                continue
            light_delay = self._traffic_light_delay(edge, resident)
            edge.congestion += max(0.1, delta_seconds / 60.0)
            resident.moving_edge_id = edge_id
            travel_seconds = max(1.0, float(travel_minutes) * 60.0 + light_delay)
            resident.moving_total_seconds = travel_seconds
            resident.moving_remaining_seconds = travel_seconds
            resident.tick_distance_m = (edge.distance_m / travel_seconds) * delta_seconds

    def _choose_destination_for_activity(self, resident: Resident, desired_activity: ActivityType) -> str:
        activity = desired_activity
        if desired_activity == "home" and self.rng.float() < 0.08:
            other = ["work", "school", "leisure"]
            activity = other[self.rng.randint(0, len(other) - 1)]
        candidates = [
            bid for bid, b in self.buildings.items()
            if b.kind == activity and bid != resident.home_building_id
        ]
        if (activity == "home" or desired_activity == "home") and self.rng.float() < 0.85:
            return resident.home_building_id
        if not candidates:
            candidates = [
                bid for bid, b in self.buildings.items()
                if b.kind == "leisure"
            ]
        if not candidates:
            candidates = list(self.buildings.keys())
        return candidates[self.rng.randint(0, len(candidates) - 1)]

    def _choose_destination(self, resident: Resident) -> str:
        desired = self._desired_activity(resident)
        return self._choose_destination_for_activity(resident, desired)

    def _activity_for_target(self, building_id: str) -> ActivityType:
        building = self.buildings.get(building_id)
        if building is None:
            return "home"
        return building.kind

    def _compute_metrics(self, delta_seconds: float) -> SimulationMetrics:
        if self.graph.edges:
            traffic_density = sum(edge.congestion for edge in self.graph.edges.values()) / len(self.graph.edges)
        else:
            traffic_density = 0.0

        if self.residents:
            avg_delay = sum(resident.delayed_minutes for resident in self.residents.values()) / len(self.residents)
        else:
            avg_delay = 0.0

        emissions = 0.0
        energy = 0.0
        for resident in self.residents.values():
            if resident.moving_edge_id is None or resident.tick_distance_m <= 0:
                continue
            distance_km = resident.tick_distance_m / 1000.0
            emissions += distance_km * MODE_EMISSIONS_KG_PER_KM[resident.mode]
            energy += distance_km * MODE_ENERGY_KWH_PER_KM[resident.mode]

        return SimulationMetrics(
            sim_time_minute=round(self.sim_time_seconds / 60.0, 3),
            traffic_density=round(traffic_density, 3),
            avg_delay_minutes=round(avg_delay, 3),
            emissions_kg_co2=round(emissions * max(1.0, 60.0 / max(0.05, delta_seconds)), 3),
            energy_kwh=round(energy * max(1.0, 60.0 / max(0.05, delta_seconds)), 3),
        )
