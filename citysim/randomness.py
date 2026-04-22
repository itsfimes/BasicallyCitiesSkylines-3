"""Deterministic random wrapper used across simulation setup/runtime.

Centralizing RNG access keeps scenario generation and resident behavior
reproducible for a given seed, which is important for testability and demos.
"""

from __future__ import annotations

import random


class SeededRandom:
    def __init__(self, seed: int) -> None:
        """Initialize deterministic RNG state for a simulation run.

        Used by: citysim.factory.build_simulation* and citysim.simulation mode/
        destination selection so identical seeds produce reproducible behavior.
        """
        self._rng = random.Random(seed)

    def float(self) -> float:
        """Return a deterministic pseudo-random float in [0.0, 1.0).

        Used by: citysim.simulation transport-mode and destination branching.
        """
        return self._rng.random()

    def randint(self, min_value: int, max_value: int) -> int:
        """Return a deterministic integer in the inclusive interval.

        Used by: citysim.factory resident generation and simulation selection
        logic that samples profiles, buildings, and targets.
        """
        return self._rng.randint(min_value, max_value)

    def choice(self, items: list[str]) -> str:
        """Return one deterministic element from a non-empty list.

        Used by: potential feature extensions and helper selection flows where
        list-based sampling is preferred over explicit index draws.
        """
        if not items:
            raise ValueError("Cannot choose from an empty collection")
        return self._rng.choice(items)
