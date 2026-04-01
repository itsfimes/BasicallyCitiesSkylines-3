from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


TransportMode = Literal["car", "public_transport", "bike", "walk"]
ActivityType = Literal["work", "school", "leisure", "home"]
EventType = Literal["accident", "road_closure", "concert", "extreme_weather", "outage"]


class WeatherType(str, Enum):
    CLEAR = "clear"
    RAIN = "rain"
    STORM = "storm"
    SNOW = "snow"


@dataclass(slots=True)
class Node:
    node_id: str
    x: float
    y: float


@dataclass(slots=True)
class Edge:
    edge_id: str
    source: str
    target: str
    distance_m: float
    lanes: int
    base_speed_kph: float
    capacity_per_minute: int
    blocked: bool = False
    quality: float = 1.0
    congestion: int = 0


@dataclass(slots=True)
class Building:
    building_id: str
    node_id: str
    kind: ActivityType
    capacity: int


@dataclass(slots=True)
class Resident:
    resident_id: str
    home_building_id: str
    daily_targets: list[str]
    current_node_id: str
    mode: TransportMode
    current_activity: ActivityType = "home"
    route: list[str] = field(default_factory=list)
    route_index: int = 0
    delayed_minutes: int = 0
    moving_edge_id: str | None = None
    moving_remaining_minutes: int = 0
    moving_total_minutes: int = 0
    tick_distance_m: float = 0.0


@dataclass(slots=True)
class SimulationEvent:
    event_id: str
    event_type: EventType
    start_minute: int
    duration_minutes: int
    payload: dict[str, object]


@dataclass(slots=True)
class SimulationMetrics:
    sim_time_minute: int
    traffic_density: float
    avg_delay_minutes: float
    emissions_kg_co2: float
    energy_kwh: float
