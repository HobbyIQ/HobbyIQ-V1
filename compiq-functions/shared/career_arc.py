"""M4 + M5 — Career-arc multipliers.

Both signals are computed per-player from a curated registry, not via a
live API (no public free feed exposes contract-year status or projected
HOF-ballot dates with reliable accuracy). The registry is a Python dict
keyed by lowercase player name; update it as players retire / sign.

M4 — HOF ballot countdown:
    Retired players become eligible 5 calendar years after final season.
    Ballot anticipation lifts cards in the ~12 months before first ballot.
    First-ballot announcement window adds catalyst flag.

M5 — Contract year:
    Players in the final guaranteed year of a deal get a 1.04–1.10 lift
    that decays as the season progresses (early-season tailwind, late
    season noise from FA rumors).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

# ----- Static registries (update as needed) ---------------------------------

# `final_season` = last MLB season played (year, int). Eligibility = +5.
RETIRED_PLAYERS: dict[str, dict[str, Any]] = {
    # Active examples — leave commented until they retire:
    # "albert pujols": {"final_season": 2022},
    # "miguel cabrera": {"final_season": 2023},
}

# Contract-year players — "walk year". Year is the final guaranteed season.
CONTRACT_YEAR_PLAYERS: dict[str, int] = {
    # Format: "lowercase player name": final_guaranteed_season
    # Examples (verify each offseason):
    # "kyle tucker": 2025,
}


def _key(player_name: str) -> str:
    return (player_name or "").strip().lower()


# ----- M4: HOF ballot countdown ---------------------------------------------


def hof_ballot_signal(
    player_name: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.utcnow()
    entry = RETIRED_PLAYERS.get(_key(player_name))
    if not entry:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "active_or_unknown",
            "first_ballot_year": None,
            "days_to_ballot": None,
        }

    first_ballot_year = int(entry["final_season"]) + 5
    # Ballot results are announced in late January.
    ballot_date = datetime(first_ballot_year, 1, 25)
    days_to = (ballot_date - now).days

    if days_to < -180:
        # Long after first ballot — no countdown effect.
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "post_first_ballot",
            "first_ballot_year": first_ballot_year,
            "days_to_ballot": days_to,
        }

    if -30 <= days_to <= 30:
        mult, sig = 1.15, "first_ballot_window"
    elif 30 < days_to <= 180:
        mult, sig = 1.08, "ballot_anticipation"
    elif 180 < days_to <= 365:
        mult, sig = 1.04, "pre_ballot_year"
    elif days_to > 365:
        mult, sig = 1.02, "retired_eligible_soon"
    else:  # -180 < days_to < -30
        mult, sig = 1.05, "post_ballot_glow"

    return {
        "player": player_name,
        "multiplier": round(mult, 3),
        "signal": sig,
        "first_ballot_year": first_ballot_year,
        "days_to_ballot": days_to,
    }


# ----- M5: Contract year effect ---------------------------------------------


def contract_year_signal(
    player_name: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.utcnow()
    final_year = CONTRACT_YEAR_PLAYERS.get(_key(player_name))
    if not final_year or final_year != now.year:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "not_contract_year",
            "season_phase": None,
        }

    # MLB regular season ~ Apr–early Oct. Use month buckets.
    month = now.month
    if month <= 3:
        mult, phase = 1.10, "preseason_walk_year"
    elif month <= 6:
        mult, phase = 1.07, "early_walk_year"
    elif month <= 8:
        mult, phase = 1.04, "mid_walk_year"
    else:
        mult, phase = 1.02, "late_walk_year"

    return {
        "player": player_name,
        "multiplier": round(mult, 3),
        "signal": "contract_year",
        "season_phase": phase,
        "final_guaranteed_season": final_year,
    }


# ----- Combined --------------------------------------------------------------


def career_arc_signal(
    player_name: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    hof = hof_ballot_signal(player_name, now=now)
    contract = contract_year_signal(player_name, now=now)
    combined = round(hof["multiplier"] * contract["multiplier"], 3)
    flags: list[str] = []
    if hof["signal"] not in {"active_or_unknown", "post_first_ballot"}:
        flags.append(f"hof:{hof['signal']}")
    if contract["signal"] == "contract_year":
        flags.append(f"contract:{contract['season_phase']}")
    return {
        "player": player_name,
        "multiplier": max(0.85, min(1.25, combined)),
        "signal_flags": flags,
        "hof": hof,
        "contract": contract,
    }
