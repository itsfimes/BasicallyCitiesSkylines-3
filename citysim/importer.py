from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from citysim.graph import CityGraph
from citysim.types import Building, Edge, Node


@dataclass(slots=True)
class ImportedCityData:
    graph: CityGraph
    buildings: dict[str, Building]


def import_from_json(path: str) -> ImportedCityData:
    with open(path, encoding="utf-8") as file:
        payload = json.load(file)

    nodes: dict[str, Node] = {}
    for item in payload["nodes"]:
        node = Node(node_id=item["node_id"], x=float(item["x"]), y=float(item["y"]))
        nodes[node.node_id] = node

    edges: dict[str, Edge] = {}
    adjacency: dict[str, list[str]] = {}
    for item in payload["edges"]:
        edge = Edge(
            edge_id=item["edge_id"],
            source=item["source"],
            target=item["target"],
            distance_m=float(item["distance_m"]),
            lanes=int(item["lanes"]),
            base_speed_kph=float(item["base_speed_kph"]),
            capacity_per_minute=int(item["capacity_per_minute"]),
            quality=float(item.get("quality", 1.0)),
        )
        edges[edge.edge_id] = edge
        adjacency.setdefault(edge.source, []).append(edge.edge_id)

    buildings: dict[str, Building] = {}
    for item in payload["buildings"]:
        building = Building(
            building_id=item["building_id"],
            node_id=item["node_id"],
            kind=item["kind"],
            capacity=int(item["capacity"]),
        )
        buildings[building.building_id] = building

    return ImportedCityData(graph=CityGraph(nodes=nodes, edges=edges, adjacency=adjacency), buildings=buildings)


def import_osm_overpass_bbox(south: float, west: float, north: float, east: float) -> ImportedCityData:
    overpass_query = f"""
    [out:json][timeout:25];
    (
      way["highway"]({south},{west},{north},{east});
      way["building"]({south},{west},{north},{east});
      node["amenity"~"school|university|kindergarten"]({south},{west},{north},{east});
      node["amenity"~"restaurant|cafe|pub|bar|cinema|theatre"]({south},{west},{north},{east});
      node["office"]({south},{west},{north},{east});
      node["shop"]({south},{west},{north},{east});
    );
    (._;>;);
    out body;
    """
    encoded = urllib.parse.urlencode({"data": overpass_query}).encode("utf-8")
    request = urllib.request.Request("https://overpass-api.de/api/interpreter", data=encoded, method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:
        payload_raw = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload_raw, dict):
        raise ValueError("Overpass response is not a JSON object")
    payload: dict[str, Any] = payload_raw

    nodes: dict[str, Node] = {}
    ways: list[dict[str, Any]] = []
    for element in payload.get("elements", []):
        if not isinstance(element, dict):
            continue
        if element.get("type") == "node":
            node_id = str(element["id"])
            nodes[node_id] = Node(node_id=node_id, x=float(element["lon"]), y=float(element["lat"]))
        if element.get("type") == "way":
            ways.append(element)

    edges: dict[str, Edge] = {}
    adjacency: dict[str, list[str]] = {}
    edge_counter = 0
    for way in ways:
        tags = way.get("tags", {})
        node_refs = [str(item) for item in way.get("nodes", [])]
        if len(node_refs) < 2:
            continue
        max_speed = _parse_osm_speed(tags.get("maxspeed", "50"))
        lanes = int(str(tags.get("lanes", "1")).split(";")[0])
        quality = _infer_quality(tags)
        oneway = str(tags.get("oneway", "no")) in {"yes", "1", "true"}
        for first, second in zip(node_refs, node_refs[1:], strict=False):
            if first not in nodes or second not in nodes:
                continue
            distance = _approx_distance_m(nodes[first], nodes[second])
            edge_id = f"e_{edge_counter}"
            edge_counter += 1
            edge = Edge(
                edge_id=edge_id,
                source=first,
                target=second,
                distance_m=distance,
                lanes=max(1, lanes),
                base_speed_kph=max_speed,
                capacity_per_minute=max(2, lanes * 10),
                quality=quality,
            )
            edges[edge_id] = edge
            adjacency.setdefault(first, []).append(edge_id)
            if not oneway:
                reverse_id = f"e_{edge_counter}"
                edge_counter += 1
                reverse = Edge(
                    edge_id=reverse_id,
                    source=second,
                    target=first,
                    distance_m=distance,
                    lanes=max(1, lanes),
                    base_speed_kph=max_speed,
                    capacity_per_minute=max(2, lanes * 10),
                    quality=quality,
                )
                edges[reverse_id] = reverse
                adjacency.setdefault(second, []).append(reverse_id)

    poi_buildings = _extract_poi_buildings(payload.get("elements", []), nodes)
    synthetic_buildings = _synthetic_buildings_from_nodes(nodes)
    merged: dict[str, Building] = {}
    merged.update(synthetic_buildings)
    merged.update(poi_buildings)

    return ImportedCityData(graph=CityGraph(nodes=nodes, edges=edges, adjacency=adjacency), buildings=merged)


def _parse_osm_speed(maxspeed: object) -> float:
    speed_text = str(maxspeed)
    digits = "".join(ch for ch in speed_text if ch.isdigit())
    if not digits:
        return 50.0
    parsed = float(digits)
    if "mph" in speed_text.lower():
        return parsed * 1.60934
    return parsed


def _infer_quality(tags: object) -> float:
    if not isinstance(tags, dict):
        return 1.0
    highway = str(tags.get("highway", ""))
    if highway in {"motorway", "trunk", "primary"}:
        return 0.95
    if highway in {"secondary", "tertiary"}:
        return 0.85
    return 0.75


def _approx_distance_m(first: Node, second: Node) -> float:
    lat_scale = 111_320.0
    mean_lat = (first.y + second.y) / 2.0
    lon_scale = 111_320.0 * max(0.1, math.cos(math.radians(mean_lat)))
    dx = (second.x - first.x) * lon_scale
    dy = (second.y - first.y) * lat_scale
    return max(5.0, (dx * dx + dy * dy) ** 0.5)


def _synthetic_buildings_from_nodes(nodes: dict[str, Node]) -> dict[str, Building]:
    buildings: dict[str, Building] = {}
    node_ids = list(nodes.keys())
    if not node_ids:
        return buildings
    for index, node_id in enumerate(node_ids[: max(10, len(node_ids) // 20)]):
        if index % 3 == 0:
            kind = "work"
            capacity = 400
        elif index % 3 == 1:
            kind = "school"
            capacity = 250
        else:
            kind = "leisure"
            capacity = 300
        building_id = f"b_{index}"
        buildings[building_id] = Building(building_id=building_id, node_id=node_id, kind=kind, capacity=capacity)
    home_building_id = f"b_{len(buildings)}"
    buildings[home_building_id] = Building(
        building_id=home_building_id,
        node_id=node_ids[-1],
        kind="home",
        capacity=1000,
    )
    return buildings


AMENITY_TO_KIND: dict[str, str] = {
    "school": "school",
    "university": "school",
    "kindergarten": "school",
    "restaurant": "leisure",
    "cafe": "leisure",
    "pub": "leisure",
    "bar": "leisure",
    "cinema": "leisure",
    "theatre": "leisure",
}

OFFICE_KEYWORDS = {"office", "government", "company"}


def _extract_poi_buildings(elements: list[dict[str, Any]], nodes: dict[str, Node]) -> dict[str, Building]:
    buildings: dict[str, Building] = {}
    counter = 0
    for element in elements:
        if not isinstance(element, dict):
            continue
        if element.get("type") != "node":
            continue
        tags = element.get("tags", {})
        if not tags:
            continue

        node_id = str(element.get("id", ""))
        if node_id not in nodes:
            continue

        kind: str | None = None
        amenity = str(tags.get("amenity", ""))
        if amenity in AMENITY_TO_KIND:
            kind = AMENITY_TO_KIND[amenity]
        elif tags.get("office") or tags.get("shop"):
            kind = "work"

        if kind is None:
            continue

        building_id = f"b_poi_{counter}"
        counter += 1
        buildings[building_id] = Building(
            building_id=building_id,
            node_id=node_id,
            kind=kind,
            capacity={"school": 300, "work": 200, "leisure": 150}.get(kind, 200),
        )

    return buildings
