from __future__ import annotations

from typing import Protocol

from citysim.types import SimulationEvent


class ScenarioPlugin(Protocol):
    name: str

    def produce_events(self, minute: int) -> list[SimulationEvent]:
        ...


class ScheduledScenario:
    def __init__(self, name: str, events: list[SimulationEvent]) -> None:
        self.name = name
        self._events_by_minute: dict[int, list[SimulationEvent]] = {}
        for event in events:
            self._events_by_minute.setdefault(event.start_minute, []).append(event)

    def produce_events(self, minute: int) -> list[SimulationEvent]:
        return list(self._events_by_minute.get(minute, []))
