"""M9 — Playoff roster date awareness.

Cards of players on active playoff rosters get a sustained lift across the
postseason window, with bigger swings for World Series participants. We
don't pull active rosters live (MLB Stats API is reliable but the call is
heavy and the multiplier is coarse). Instead we use a static postseason
calendar plus a per-player team affiliation registry, and check whether
the player's team is in any active playoff window.

Update PLAYOFF_WINDOWS each October. PLAYER_TEAMS as roster moves happen.
"""

from __future__ import annotations

from datetime import date
from typing import Any

# (window_label, start, end, magnitude)
# Magnitude: "wildcard", "division", "championship", "world_series".
PLAYOFF_WINDOWS: list[tuple[str, date, date, str]] = [
    # 2026 (placeholder — update once MLB publishes actual dates)
    ("WC 2026", date(2026, 9, 30), date(2026, 10, 2), "wildcard"),
    ("ALDS/NLDS 2026", date(2026, 10, 4), date(2026, 10, 13), "division"),
    ("ALCS/NLCS 2026", date(2026, 10, 14), date(2026, 10, 25), "championship"),
    ("World Series 2026", date(2026, 10, 28), date(2026, 11, 6), "world_series"),
]

# Registry of player → team code. Update with roster moves.
PLAYER_TEAMS: dict[str, str] = {
    # "shohei ohtani": "LAD",
    # "aaron judge": "NYY",
    # "mike trout": "LAA",
}

# Teams in each year's playoffs (update Sep–Oct as bracket settles).
# Year-keyed so historical lookups stay accurate.
PLAYOFF_TEAMS_BY_YEAR: dict[int, set[str]] = {
    # 2026: {"LAD", "ATL", "PHI", "MIL", "HOU", "BAL", "NYY", "MIN"},
}

MAGNITUDE_MULT = {
    "wildcard": 1.06,
    "division": 1.10,
    "championship": 1.15,
    "world_series": 1.22,
}


def _key(player_name: str) -> str:
    return (player_name or "").strip().lower()


def get_playoff_signal(
    player_name: str,
    *,
    today: date | None = None,
) -> dict[str, Any]:
    today = today or date.today()
    team = PLAYER_TEAMS.get(_key(player_name))
    if not team:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_team_registry",
            "team": None,
            "window": None,
        }

    in_playoffs = team in PLAYOFF_TEAMS_BY_YEAR.get(today.year, set())
    if not in_playoffs:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "team_eliminated_or_unknown",
            "team": team,
            "window": None,
        }

    for label, start, end, mag in PLAYOFF_WINDOWS:
        if start <= today <= end:
            return {
                "player": player_name,
                "multiplier": MAGNITUDE_MULT.get(mag, 1.0),
                "signal": f"playoff_active:{mag}",
                "team": team,
                "window": label,
            }
        if 0 < (start - today).days <= 7:
            # Pre-window pop as roster announcements firm up.
            return {
                "player": player_name,
                "multiplier": round(1.0 + (MAGNITUDE_MULT.get(mag, 1.0) - 1.0) * 0.5, 3),
                "signal": f"playoff_imminent:{mag}",
                "team": team,
                "window": label,
            }

    return {
        "player": player_name,
        "multiplier": 1.0,
        "signal": "between_rounds",
        "team": team,
        "window": None,
    }
