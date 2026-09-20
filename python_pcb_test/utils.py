from __future__ import annotations
from dataclasses import dataclass
import math


@dataclass(slots=True)
class Vector2:
    x: float = 0.0
    y: float = 0.0

    def __add__(self, other: Vector2) -> Vector2:
        return Vector2(self.x + other.x, self.y + other.y)

    def __sub__(self, other: Vector2) -> Vector2:
        return Vector2(self.x - other.x, self.y - other.y)

    def __mul__(self, scalar: float) -> Vector2:
        return Vector2(self.x * scalar, self.y * scalar)

    __rmul__ = __mul__

    def __neg__(self) -> Vector2:
        return Vector2(-self.x, -self.y)

    def __iter__(self):            # lets you do `x, y = v`
        yield self.x
        yield self.y

 