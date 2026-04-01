from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from citysim.graph import CityGraph
from citysim.plugins import ScenarioPlugin
from citysim.randomness import SeededRandom
from citysim.types import Building, Resident, SimulationEvent, SimulationMetrics, WeatherType


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


@dataclass(slots=True)
class CitySimulation:
    graph: CityGraph
    buildings: dict[str, Building]
    residents: dict[str, Resident]
    rng: SeededRandom
    scenario_plugins: list[ScenarioPlugin]
    seed: int
    minute: int = 0
    weather: WeatherType = WeatherType.CLEAR
    uncertainty_level: float = 0.05
    active_events: list[SimulationEvent] = None  # type: ignore[assignment]
    event_log: list[dict[str, object]] = None  # type: ignore[assignment]
    base_speed_kph_by_edge: dict[str, float] = None  # type: ignore[assignment]
    edge_speed_factor_by_edge: dict[str, float] = None  # type: ignore[assignment]
    last_metrics: SimulationMetrics | None = None

    def __post_init__(self) -> None:
        self.active_events = []
        self.event_log = []
        self.base_speed_kph_by_edge = {edge_id: edge.base_speed_kph for edge_id, edge in self.graph.edges.items()}
        self.edge_speed_factor_by_edge = {edge_id: 1.0 for edge_id in self.graph.edges}

    def step(self) -> SimulationMetrics:
        self.minute += 1
        self._expire_events()
        self._ingest_plugin_events()
        self._apply_edge_resets()
        self._apply_active_events()
        self._advance_residents()
        metrics = self._compute_metrics()
        self.last_metrics = metrics
        self.event_log.append(
            {
                "minute": self.minute,
                "weather": self.weather.value,
                "metrics": {
                    "traffic_density": metrics.traffic_density,
                    "avg_delay_minutes": metrics.avg_delay_minutes,
                    "emissions_kg_co2": metrics.emissions_kg_co2,
                    "energy_kwh": metrics.energy_kwh,
                },
            }
        )
        return metrics

    def inject_event(self, event: SimulationEvent) -> None:
        self.active_events.append(event)

    def snapshot(self) -> dict[str, object]:
        return {
            "minute": self.minute,
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
                    "activity": resident.current_activity,
                    "delayed_minutes": resident.delayed_minutes,
                    "moving_edge_id": resident.moving_edge_id,
                    "moving_remaining_minutes": resident.moving_remaining_minutes,
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
        }

    def _expire_events(self) -> None:
        still_active: list[SimulationEvent] = []
        for event in self.active_events:
            if self.minute < event.start_minute + event.duration_minutes:
                still_active.append(event)
        self.active_events = still_active

    def _ingest_plugin_events(self) -> None:
        for plugin in self.scenario_plugins:
            self.active_events.extend(plugin.produce_events(self.minute))

    def _apply_edge_resets(self) -> None:
        for edge in self.graph.edges.values():
            edge.blocked = False
            edge.congestion = max(0, int(edge.congestion * 0.4))
            edge.base_speed_kph = self.base_speed_kph_by_edge.get(edge.edge_id, edge.base_speed_kph)
            self.edge_speed_factor_by_edge[edge.edge_id] = 1.0

    def _apply_active_events(self) -> None:
        self.weather = WeatherType.CLEAR
        weather_active = False
        for event in self.active_events:
            if event.event_type == "road_closure":
                edge_id = str(event.payload.get("edge_id", ""))
                edge = self.graph.edges.get(edge_id)
                if edge is not None:
                    edge.blocked = True
            elif event.event_type == "accident":
                edge_id = str(event.payload.get("edge_id", ""))
                edge = self.graph.edges.get(edge_id)
                if edge is not None:
                    edge.congestion += _as_int(event.payload.get("extra_load", 40), 40)
                    self.edge_speed_factor_by_edge[edge_id] = min(self.edge_speed_factor_by_edge.get(edge_id, 1.0), 0.7)
            elif event.event_type == "concert":
                target_node = str(event.payload.get("node_id", ""))
                if target_node:
                    for edge in self.graph.neighbors(target_node):
                        edge.congestion += _as_int(event.payload.get("extra_load", 60), 60)
            elif event.event_type == "extreme_weather":
                weather_value = str(event.payload.get("weather", "storm"))
                if weather_value in WeatherType._value2member_map_:
                    self.weather = WeatherType(weather_value)
                weather_active = True
            elif event.event_type == "outage":
                for edge in self.graph.edges.values():
                    edge.congestion += _as_int(event.payload.get("global_extra_load", 15), 15)

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
            self.uncertainty_level = max(0.05, self.uncertainty_level * 0.95)

    def _advance_residents(self) -> None:
        building_ids = list(self.buildings.keys())
        if not building_ids:
            return
        for resident in self.residents.values():
            if resident.moving_remaining_minutes > 0:
                if resident.moving_edge_id is not None and resident.moving_total_minutes > 0:
                    edge = self.graph.edges[resident.moving_edge_id]
                    resident.tick_distance_m = edge.distance_m / resident.moving_total_minutes
                else:
                    resident.tick_distance_m = 0.0
                resident.moving_remaining_minutes -= 1
                if resident.moving_remaining_minutes <= 0:
                    if resident.route and resident.route_index < len(resident.route):
                        edge = self.graph.edges[resident.route[resident.route_index]]
                        resident.current_node_id = edge.target
                        resident.route_index += 1
                    resident.moving_edge_id = None
                    resident.moving_total_minutes = 0
                continue

            if resident.route_index >= len(resident.route):
                destination_id = self._choose_destination(resident)
                destination = self.buildings.get(destination_id)
                if destination is None:
                    resident.delayed_minutes += 1
                    continue
                resident.route = self.graph.shortest_path(
                    source_id=resident.current_node_id,
                    target_id=destination.node_id,
                    weather=self.weather,
                    uncertainty=self.uncertainty_level,
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
            edge.congestion += 1
            resident.moving_edge_id = edge_id
            resident.moving_total_minutes = travel_minutes
            resident.moving_remaining_minutes = max(1, travel_minutes - 1)
            resident.tick_distance_m = edge.distance_m / max(1, travel_minutes)

    def _choose_destination(self, resident: Resident) -> str:
        if resident.daily_targets:
            minute_mod = self.minute % len(resident.daily_targets)
            return resident.daily_targets[minute_mod]
        building_ids = list(self.buildings.keys())
        return building_ids[self.rng.randint(0, len(building_ids) - 1)]

    def _compute_metrics(self) -> SimulationMetrics:
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
            sim_time_minute=self.minute,
            traffic_density=round(traffic_density, 3),
            avg_delay_minutes=round(avg_delay, 3),
            emissions_kg_co2=round(emissions, 3),
            energy_kwh=round(energy, 3),
        )
