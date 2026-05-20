"""M6 — Pack release calendar overlay.

Major Topps / Bowman set drops pull collector attention (and dollars) toward
new wax. Older set singles soften slightly in the 7 days after a high-profile
release; conversely, the 7 days BEFORE a hyped release see a small lift on
flagship rookies as buyers pre-position.

Hard-coded release schedule — update each season as Topps publishes dates.
"""

from __future__ import annotations

from datetime import date
from typing import Any

# (release_name, release_date, magnitude). magnitude in {"flagship", "premium", "minor"}.
PACK_RELEASES: list[tuple[str, date, str]] = [
    # 2026
    ("2026 Topps Series 1", date(2026, 2, 11), "flagship"),
    ("2026 Bowman", date(2026, 4, 22), "premium"),
    ("2026 Topps Series 2", date(2026, 6, 10), "flagship"),
    ("2026 Topps Chrome", date(2026, 8, 12), "premium"),
    ("2026 Bowman Draft", date(2026, 12, 9), "premium"),
    ("2026 Topps Update", date(2026, 10, 14), "flagship"),
    # 2027
    ("2027 Topps Series 1", date(2027, 2, 10), "flagship"),
]


def _magnitude_pre(mag: str) -> float:
    return {"flagship": 1.04, "premium": 1.06, "minor": 1.02}.get(mag, 1.0)


def _magnitude_post(mag: str) -> float:
    return {"flagship": 0.96, "premium": 0.94, "minor": 0.99}.get(mag, 1.0)


def get_pack_release_signal(today: date | None = None) -> dict[str, Any]:
    """Multiplier based on proximity to upcoming pack releases.

    Pre-release window: 7 days, linear ramp toward release.
    Release day + 1 day after: peak hype.
    Post-release softening: 7 days, linear decay back to neutral.
    """
    today = today or date.today()

    nearest_pre: tuple[str, date, str, int] | None = None
    nearest_post: tuple[str, date, str, int] | None = None

    for name, release, mag in PACK_RELEASES:
        delta = (release - today).days
        if 0 <= delta <= 7:
            if nearest_pre is None or delta < nearest_pre[3]:
                nearest_pre = (name, release, mag, delta)
        elif -7 <= delta < 0:
            if nearest_post is None or abs(delta) < abs(nearest_post[3]):
                nearest_post = (name, release, mag, delta)
        elif delta == 0:
            return {
                "release_phase": "release_day",
                "release_name": name,
                "release_date": release.isoformat(),
                "days_to_release": 0,
                "release_multiplier": _magnitude_pre(mag),
            }

    if nearest_pre:
        name, release, mag, delta = nearest_pre
        peak = _magnitude_pre(mag)
        # Linear ramp: 7 days out → 1.0, 0 days out → peak.
        progress = (7 - delta) / 7
        mult = round(1.0 + (peak - 1.0) * progress, 3)
        return {
            "release_phase": "pre_release",
            "release_name": name,
            "release_date": release.isoformat(),
            "days_to_release": delta,
            "release_multiplier": mult,
        }

    if nearest_post:
        name, release, mag, delta = nearest_post
        trough = _magnitude_post(mag)
        days_after = abs(delta)
        progress = (7 - days_after) / 7  # 1 day after → near full softening
        mult = round(1.0 + (trough - 1.0) * progress, 3)
        return {
            "release_phase": "post_release",
            "release_name": name,
            "release_date": release.isoformat(),
            "days_to_release": delta,
            "release_multiplier": mult,
        }

    return {
        "release_phase": "neutral",
        "release_name": None,
        "release_date": None,
        "days_to_release": None,
        "release_multiplier": 1.0,
    }
