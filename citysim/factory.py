from __future__ import annotations

import json
from pathlib import Path

from citysim.graph import CityGraph
from citysim.importer import ImportedCityData, import_from_json
from citysim.plugins import ScheduledScenario
from citysim.randomness import SeededRandom
from citysim.simulation import CitySimulation
from citysim.types import Building, Edge, Node, Resident, SimulationEvent, TransportMode


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def load_default_city(seed: int) -> ImportedCityData:
    _ = seed
    return import_from_json(str(DATA_DIR / "city" / "default_city.json"))


def load_default_scenario() -> ScheduledScenario:
    with (DATA_DIR / "scenarios" / "traffic_collapse_concert.json").open("r", encoding="utf-8") as file:
        payload = json.load(file)
    events: list[SimulationEvent] = []
    for item in payload["events"]:
        events.append(
            SimulationEvent(
                event_id=item["event_id"],
                event_type=item["event_type"],
                start_minute=int(item["start_minute"]),
                duration_minutes=int(item["duration_minutes"]),
                payload=dict(item["payload"]),
            )
        )
    return ScheduledScenario(name=payload["scenario_name"], events=events)


def build_simulation(seed: int = 42, resident_count: int = 2000) -> CitySimulation:
    imported = load_default_city(seed)
    rng = SeededRandom(seed)
    residents = generate_residents(imported.graph, imported.buildings, resident_count, rng)
    scenario = load_default_scenario()
    return CitySimulation(
        graph=imported.graph,
        buildings=imported.buildings,
        residents=residents,
        rng=rng,
        scenario_plugins=[scenario],
        seed=seed,
    )


def build_simulation_from_import(imported: ImportedCityData, seed: int = 42, resident_count: int = 2000) -> CitySimulation:
    rng = SeededRandom(seed)
    residents = generate_residents(imported.graph, imported.buildings, resident_count, rng)
    scenario = load_default_scenario()
    return CitySimulation(
        graph=imported.graph,
        buildings=imported.buildings,
        residents=residents,
        rng=rng,
        scenario_plugins=[scenario],
        seed=seed,
    )


def generate_residents(
    graph: CityGraph,
    buildings: dict[str, Building],
    resident_count: int,
    rng: SeededRandom,
) -> dict[str, Resident]:
    home_buildings = [building for building in buildings.values() if building.kind == "home"]
    work_buildings = [building for building in buildings.values() if building.kind in {"work", "school", "leisure"}]
    if not home_buildings or not work_buildings:
        fallback_node = next(iter(graph.nodes.values())).node_id
        home_building = Building(building_id="home_fallback", node_id=fallback_node, kind="home", capacity=resident_count)
        work_building = Building(building_id="work_fallback", node_id=fallback_node, kind="work", capacity=resident_count)
        home_buildings = [home_building]
        work_buildings = [work_building]

    residents: dict[str, Resident] = {}
    modes: list[TransportMode] = ["car", "public_transport", "bike", "walk"]
    for index in range(resident_count):
        home = home_buildings[rng.randint(0, len(home_buildings) - 1)]
        work = work_buildings[rng.randint(0, len(work_buildings) - 1)]
        leisure = work_buildings[rng.randint(0, len(work_buildings) - 1)]
        mode = modes[rng.randint(0, len(modes) - 1)]
        resident_id = f"r_{index}"
        residents[resident_id] = Resident(
            resident_id=resident_id,
            home_building_id=home.building_id,
            daily_targets=[work.building_id, leisure.building_id, home.building_id],
            current_node_id=home.node_id,
            mode=mode,
        )
    return residents


def build_toy_city() -> ImportedCityData:
    nodes = {
        "n1": Node("n1", 14.4200, 50.0870),
        "n2": Node("n2", 14.4250, 50.0875),
        "n3": Node("n3", 14.4300, 50.0880),
        "n4": Node("n4", 14.4280, 50.0845),
        "n5": Node("n5", 14.4220, 50.0840),
    }
    edges = {
        "e1": Edge("e1", "n1", "n2", 420.0, 2, 45.0, 30),
        "e2": Edge("e2", "n2", "n3", 380.0, 2, 50.0, 30),
        "e3": Edge("e3", "n3", "n4", 520.0, 2, 40.0, 25),
        "e4": Edge("e4", "n4", "n5", 460.0, 1, 35.0, 18),
        "e5": Edge("e5", "n5", "n1", 410.0, 1, 35.0, 18),
        "e6": Edge("e6", "n2", "n5", 650.0, 1, 30.0, 15),
        "e7": Edge("e7", "n5", "n2", 650.0, 1, 30.0, 15),
    }
    adjacency = {
        "n1": ["e1"],
        "n2": ["e2", "e6"],
        "n3": ["e3"],
        "n4": ["e4"],
        "n5": ["e5", "e7"],
    }
    buildings = {
        "b_home": Building("b_home", "n1", "home", 2000),
        "b_work": Building("b_work", "n3", "work", 1500),
        "b_school": Building("b_school", "n4", "school", 700),
        "b_leisure": Building("b_leisure", "n2", "leisure", 900),
    }
    return ImportedCityData(graph=CityGraph(nodes=nodes, edges=edges, adjacency=adjacency), buildings=buildings)
