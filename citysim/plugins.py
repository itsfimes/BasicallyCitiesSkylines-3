"""Scenario plugin contracts for timed simulation events.

CitySimulation calls these plugins once per simulated minute to pull new
events. ScheduledScenario is the default implementation used by the factory.
"""

from __future__ import annotations

from typing import Protocol

from citysim.types import SimulationEvent


class ScenarioPlugin(Protocol):
    name: str

    def produce_events(self, minute: int) -> list[SimulationEvent]:
        """Return events that should become active at the given minute.

        Used by: CitySimulation._ingest_plugin_events in citysim.simulation to
        pull time-based scenario inputs into the main simulation loop.
        """
        ...


class ScheduledScenario:
    def __init__(self, name: str, events: list[SimulationEvent]) -> None:
        """Index static scenario events by start minute for quick lookup.

        Used by: citysim.factory.load_default_scenario to provide the default
        plugin consumed by CitySimulation.
        """
        self.name = name
        self._events_by_minute: dict[int, list[SimulationEvent]] = {}
        for event in events:
            self._events_by_minute.setdefault(event.start_minute, []).append(event)

    def produce_events(self, minute: int) -> list[SimulationEvent]:
        """Return a copy of events scheduled for this minute.

        Used by: CitySimulation plugin ingestion during each simulation step.
        """
        return list(self._events_by_minute.get(minute, []))
