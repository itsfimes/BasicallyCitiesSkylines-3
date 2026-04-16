from __future__ import annotations

import heapq
from dataclasses import dataclass, field

from citysim.types import Edge, Node, WeatherType

BPR_ALPHA = 0.15
BPR_BETA = 4.0


@dataclass(slots=True)
class PathCacheEntry:
    path: list[str]
    tick: int
    weather: WeatherType
    uncertainty_bucket: int


@dataclass(slots=True)
class CityGraph:
    nodes: dict[str, Node]
    edges: dict[str, Edge]
    adjacency: dict[str, list[str]]
    path_cache: dict[tuple[str, str], PathCacheEntry] = field(default_factory=dict)
    cache_generation: int = 0
    path_cache_ttl: int = 120

    def neighbors(self, node_id: str) -> list[Edge]:
        edge_ids = self.adjacency.get(node_id, [])
        return [self.edges[edge_id] for edge_id in edge_ids]

    def edge_travel_minutes(self, edge: Edge, weather: WeatherType, uncertainty: float) -> int:
        if edge.blocked:
            return 10**9
        weather_factor = {
            WeatherType.CLEAR: 1.0,
            WeatherType.RAIN: 1.15,
            WeatherType.STORM: 1.35,
            WeatherType.SNOW: 1.5,
        }[weather]
        quality_penalty = 1.0 + max(0.0, 1.0 - edge.quality)
        congestion_ratio = edge.congestion / max(1, edge.capacity_per_minute)
        congestion_factor = 1.0 + BPR_ALPHA * congestion_ratio**BPR_BETA
        uncertainty_factor = 1.0 + max(0.0, uncertainty)
        speed_kph = max(
            5.0,
            edge.base_speed_kph / (weather_factor * quality_penalty * congestion_factor * uncertainty_factor),
        )
        travel_hours = (edge.distance_m / 1000.0) / speed_kph
        minutes = max(1, int(travel_hours * 60.0))
        return minutes

    def invalidate_path_cache(self) -> None:
        self.cache_generation += 1
        self.path_cache.clear()

    def shortest_path(
        self,
        source_id: str,
        target_id: str,
        weather: WeatherType,
        uncertainty: float,
        tick: int = 0,
    ) -> list[str]:
        if source_id == target_id:
            return []

        uncertainty_bucket = int(uncertainty * 20)
        cache_key = (source_id, target_id)
        cached = self.path_cache.get(cache_key)
        if (
            cached is not None
            and cached.tick + self.path_cache_ttl >= tick
            and cached.weather == weather
            and cached.uncertainty_bucket == uncertainty_bucket
        ):
            return cached.path

        path = self._dijkstra(source_id, target_id, weather, uncertainty)

        self.path_cache[cache_key] = PathCacheEntry(
            path=path,
            tick=tick,
            weather=weather,
            uncertainty_bucket=uncertainty_bucket,
        )
        return path

    def _dijkstra(
        self,
        source_id: str,
        target_id: str,
        weather: WeatherType,
        uncertainty: float,
    ) -> list[str]:
        distances: dict[str, int] = {source_id: 0}
        previous_edge: dict[str, str] = {}
        queue: list[tuple[int, str]] = [(0, source_id)]
        visited: set[str] = set()

        while queue:
            current_distance, current_node = heapq.heappop(queue)
            if current_node in visited:
                continue
            visited.add(current_node)
            if current_node == target_id:
                break
            for edge in self.neighbors(current_node):
                step_cost = self.edge_travel_minutes(edge, weather, uncertainty)
                if step_cost >= 10**9:
                    continue
                candidate = current_distance + step_cost
                if candidate < distances.get(edge.target, 10**9):
                    distances[edge.target] = candidate
                    previous_edge[edge.target] = edge.edge_id
                    heapq.heappush(queue, (candidate, edge.target))

        if target_id not in previous_edge:
            return []

        path_edges: list[str] = []
        cursor = target_id
        while cursor != source_id:
            edge_id = previous_edge[cursor]
            path_edges.append(edge_id)
            cursor = self.edges[edge_id].source
        path_edges.reverse()
        return path_edges
