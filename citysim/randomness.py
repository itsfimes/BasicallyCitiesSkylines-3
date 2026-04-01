from __future__ import annotations

import random


class SeededRandom:
    def __init__(self, seed: int) -> None:
        self._rng = random.Random(seed)

    def float(self) -> float:
        return self._rng.random()

    def randint(self, min_value: int, max_value: int) -> int:
        return self._rng.randint(min_value, max_value)

    def choice(self, items: list[str]) -> str:
        if not items:
            raise ValueError("Cannot choose from an empty collection")
        return self._rng.choice(items)
