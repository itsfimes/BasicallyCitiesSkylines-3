import unittest

from citysim.factory import build_simulation
from citysim.types import SimulationEvent


class SimulationTests(unittest.TestCase):
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
        simulation.step()
        reduced = simulation.graph.edges["e2"].base_speed_kph
        self.assertLess(reduced, baseline)
        simulation.step()
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


if __name__ == "__main__":
    unittest.main()
