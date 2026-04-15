import unittest

from citysim.factory import build_simulation
from citysim.importer import import_from_json
from citysim.types import Edge, WeatherType
from citysim.types import SimulationEvent


class SimulationTests(unittest.TestCase):
    def test_json_import_loads_external_dataset(self) -> None:
        imported = import_from_json("/home/bea/sync/skola-zapisky/prg/BasicallyCitiesSkylines-3/data/city/default_city.json")
        self.assertGreater(len(imported.graph.nodes), 0)
        self.assertGreater(len(imported.graph.edges), 0)
        self.assertGreater(len(imported.buildings), 0)

    def test_uncertainty_and_weather_increase_travel_time(self) -> None:
        simulation = build_simulation(seed=55, resident_count=10)
        edge = Edge(
            edge_id="probe",
            source="n1",
            target="n2",
            distance_m=5000.0,
            lanes=1,
            base_speed_kph=45.0,
            capacity_per_minute=10,
            blocked=False,
            quality=1.0,
            congestion=0.0,
        )

        clear_minutes = simulation.graph.edge_travel_minutes(edge, WeatherType.CLEAR, uncertainty=0.0)

        edge.quality = 0.7
        stress_minutes = simulation.graph.edge_travel_minutes(edge, WeatherType.STORM, uncertainty=0.25)

        self.assertGreater(stress_minutes, clear_minutes)

    def test_step_produces_metrics(self) -> None:
        simulation = build_simulation(seed=7, resident_count=200)
        metrics = simulation.step()
        self.assertEqual(metrics.sim_time_minute, 1)
        self.assertGreaterEqual(metrics.traffic_density, 0)
        self.assertGreaterEqual(metrics.avg_delay_minutes, 0)

    def test_event_injection_changes_state(self) -> None:
        simulation = build_simulation(seed=7, resident_count=100)
        simulation.inject_event(
            SimulationEvent(
                event_id="manual_closure",
                event_type="road_closure",
                start_minute=0,
                duration_minutes=10,
                payload={"edge_id": "e1"},
            )
        )
        simulation.step()
        self.assertTrue(simulation.graph.edges["e1"].blocked)

    def test_accident_speed_resets_after_expiry(self) -> None:
        simulation = build_simulation(seed=9, resident_count=50)
        baseline = simulation.graph.edges["e2"].base_speed_kph
        simulation.inject_event(
            SimulationEvent(
                event_id="accident_short",
                event_type="accident",
                start_minute=1,
                duration_minutes=1,
                payload={"edge_id": "e2", "extra_load": 20},
            )
        )
        simulation.step(delta_seconds=60.0)
        reduced = simulation.graph.edges["e2"].base_speed_kph
        self.assertLess(reduced, baseline)
        simulation.step(delta_seconds=60.0)
        self.assertAlmostEqual(simulation.graph.edges["e2"].base_speed_kph, baseline)

    def test_reproducible_for_same_seed(self) -> None:
        first = build_simulation(seed=13, resident_count=120)
        second = build_simulation(seed=13, resident_count=120)
        first_metrics = [first.step() for _ in range(5)]
        second_metrics = [second.step() for _ in range(5)]
        self.assertEqual(
            [(item.traffic_density, item.avg_delay_minutes) for item in first_metrics],
            [(item.traffic_density, item.avg_delay_minutes) for item in second_metrics],
        )

    def test_simulation_advances_in_discrete_seconds(self) -> None:
        simulation = build_simulation(seed=31, resident_count=120)
        self.assertEqual(simulation.sim_time_seconds, 0.0)
        self.assertEqual(simulation.minute, 0)

        simulation.step(delta_seconds=1.0)
        self.assertEqual(simulation.sim_time_seconds, 1.0)
        self.assertEqual(simulation.minute, 0)

        simulation.step(delta_seconds=59.0)
        self.assertEqual(simulation.sim_time_seconds, 60.0)
        self.assertEqual(simulation.minute, 1)

    def test_required_task2_events_change_state(self) -> None:
        simulation = build_simulation(seed=41, resident_count=120)

        simulation.inject_event(
            SimulationEvent(
                event_id="closure_now",
                event_type="road_closure",
                start_minute=0,
                duration_minutes=2,
                payload={"edge_id": "e1"},
            )
        )
        simulation.step(delta_seconds=1.0)
        self.assertTrue(simulation.graph.edges["e1"].blocked)

        simulation.inject_event(
            SimulationEvent(
                event_id="concert_now",
                event_type="concert",
                start_minute=0,
                duration_minutes=2,
                payload={"node_id": "n2", "extra_load": 80},
            )
        )
        before_concert = simulation.graph.edges["e2"].congestion + simulation.graph.edges["e6"].congestion
        simulation.step(delta_seconds=1.0)
        after_concert = simulation.graph.edges["e2"].congestion + simulation.graph.edges["e6"].congestion
        self.assertGreater(after_concert, before_concert)

        simulation.inject_event(
            SimulationEvent(
                event_id="weather_now",
                event_type="extreme_weather",
                start_minute=0,
                duration_minutes=2,
                payload={"weather": "storm"},
            )
        )
        simulation.step(delta_seconds=1.0)
        self.assertEqual(simulation.weather.value, "storm")

        simulation.inject_event(
            SimulationEvent(
                event_id="outage_now",
                event_type="outage",
                start_minute=0,
                duration_minutes=2,
                payload={"global_extra_load": 25},
            )
        )
        before_outage = sum(edge.congestion for edge in simulation.graph.edges.values())
        simulation.step(delta_seconds=1.0)
        after_outage = sum(edge.congestion for edge in simulation.graph.edges.values())
        self.assertGreater(after_outage, before_outage)

    def test_residents_have_behavior_profiles_and_activity_updates(self) -> None:
        simulation = build_simulation(seed=21, resident_count=240)
        profiles = {resident.behavior_profile for resident in simulation.residents.values()}
        self.assertIn("worker", profiles)
        self.assertIn("student", profiles)
        self.assertIn("leisure_oriented", profiles)

        for _ in range(4):
            simulation.step(delta_seconds=60.0)

        activities = {resident.current_activity for resident in simulation.residents.values()}
        self.assertTrue(any(activity in {"work", "school", "leisure"} for activity in activities))

    def test_agents_move_and_decide_routes(self) -> None:
        simulation = build_simulation(seed=64, resident_count=180)
        started_moving = False
        active_routes = False

        for _ in range(120):
            simulation.step(delta_seconds=1.0)
            if any(resident.moving_edge_id is not None for resident in simulation.residents.values()):
                started_moving = True
            if any(len(resident.route) > 0 for resident in simulation.residents.values()):
                active_routes = True
            if started_moving and active_routes:
                break

        self.assertTrue(started_moving)
        self.assertTrue(active_routes)

    def test_event_start_minute_is_respected(self) -> None:
        simulation = build_simulation(seed=11, resident_count=80)
        baseline = simulation.graph.edges["e1"].base_speed_kph
        simulation.inject_event(
            SimulationEvent(
                event_id="future_accident",
                event_type="accident",
                start_minute=3,
                duration_minutes=2,
                payload={"edge_id": "e1", "extra_load": 25},
            )
        )

        simulation.step(delta_seconds=1.0)
        self.assertAlmostEqual(simulation.graph.edges["e1"].base_speed_kph, baseline)

        simulation.step(delta_seconds=178.0)
        self.assertAlmostEqual(simulation.graph.edges["e1"].base_speed_kph, baseline)

        simulation.step(delta_seconds=1.0)
        self.assertLess(simulation.graph.edges["e1"].base_speed_kph, baseline)


if __name__ == "__main__":
    unittest.main()
