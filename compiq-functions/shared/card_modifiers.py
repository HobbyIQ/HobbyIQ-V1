"""Card-level deterministic modifiers (M3, M7, M8).

These are pure functions of the card metadata — no network calls, no
caching. They're applied AFTER the aggregated player-signal multiplier and
BEFORE the price floor / comp-volume gating in the MCP pricing layer.

All multipliers obey the global 0.70–1.50 hard cap (the caller clamps).

- M3: Rookie-year timing — fresh rookies trade at a premium, then settle
  toward a year-3 baseline; modest re-acceleration on year-3+ if the
  player is still pre-arbitration value.
- M7: Grade spread — encodes how a single grade tier swings price relative
  to raw / lower grades. Only used when grade is explicitly known.
- M8: Jersey-number iconicity — small premium for collector-magnet numbers
  (DiMaggio 5, Mantle 7, Jeter 2, MJ-23 carryover, Ohtani 17, Trout 27,
  etc.). Capped tightly so it can't dominate other signals.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

# ----- M3: Rookie-year timing ------------------------------------------------

ROOKIE_PREMIUM_YEAR_0 = 1.18  # rookie-year card during rookie season
ROOKIE_PREMIUM_YEAR_1 = 1.10  # the offseason after RC year
ROOKIE_PREMIUM_YEAR_2 = 1.04
ROOKIE_PREMIUM_FLOOR = 1.00


def rookie_year_modifier(
    card_year: int | None,
    is_rookie_card: bool,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not is_rookie_card or not card_year:
        return {"multiplier": 1.0, "signal": "not_rookie", "rookie_age": None}

    now = now or datetime.utcnow()
    age = now.year - int(card_year)
    if age < 0:
        return {"multiplier": 1.0, "signal": "future_card", "rookie_age": age}

    if age == 0:
        mult = ROOKIE_PREMIUM_YEAR_0
        sig = "rookie_year_active"
    elif age == 1:
        mult = ROOKIE_PREMIUM_YEAR_1
        sig = "post_rookie_year"
    elif age == 2:
        mult = ROOKIE_PREMIUM_YEAR_2
        sig = "year_two"
    else:
        mult = ROOKIE_PREMIUM_FLOOR
        sig = "established_rookie"

    return {
        "multiplier": round(mult, 3),
        "signal": sig,
        "rookie_age": age,
    }


# ----- M7: Grade spread ------------------------------------------------------

# Multipliers are RELATIVE to the raw card baseline.
GRADE_MULTIPLIERS = {
    "PSA 10": 1.45,
    "BGS 9.5": 1.40,
    "BGS 10": 1.95,
    "PSA 9": 1.18,
    "BGS 9": 1.15,
    "PSA 8": 1.05,
    "BGS 8": 1.04,
    "PSA 7": 0.98,
    "raw": 1.0,
    "ungraded": 1.0,
}


def grade_spread_modifier(grade: str | None) -> dict[str, Any]:
    if not grade:
        return {"multiplier": 1.0, "signal": "no_grade", "grade": None}
    g = grade.strip()
    mult = GRADE_MULTIPLIERS.get(g)
    if mult is None:
        return {"multiplier": 1.0, "signal": "unknown_grade", "grade": g}
    return {
        "multiplier": round(mult, 3),
        "signal": "graded" if mult != 1.0 else "raw",
        "grade": g,
    }


# ----- M8: Jersey-number iconicity ------------------------------------------

# Tight band — never moves price more than a few percent on its own.
ICONIC_NUMBERS = {
    2: ("Jeter legacy", 1.04),
    5: ("DiMaggio legacy", 1.03),
    7: ("Mantle legacy", 1.05),
    8: ("Ripken legacy", 1.03),
    17: ("Ohtani", 1.04),
    23: ("MJ crossover", 1.05),
    27: ("Trout", 1.04),
    44: ("Aaron legacy", 1.04),
    99: ("crossover novelty", 1.02),
}


def jersey_number_modifier(jersey_number: int | None) -> dict[str, Any]:
    if jersey_number is None:
        return {"multiplier": 1.0, "signal": "no_number", "number": None}
    entry = ICONIC_NUMBERS.get(int(jersey_number))
    if not entry:
        return {
            "multiplier": 1.0,
            "signal": "non_iconic",
            "number": jersey_number,
        }
    label, mult = entry
    return {
        "multiplier": round(mult, 3),
        "signal": f"iconic:{label}",
        "number": jersey_number,
    }


# ----- Combined card-level modifier -----------------------------------------


def combined_card_modifiers(
    *,
    card_year: int | None,
    is_rookie_card: bool,
    grade: str | None,
    jersey_number: int | None,
    print_run: int | None = None,
) -> dict[str, Any]:
    """Multiply M3 + M7 + M8 + print-run modifier, return capped 0.70–1.50.

    Print-run modifier follows the table in copilot-instructions.md.
    """
    rookie = rookie_year_modifier(card_year, is_rookie_card)
    grade_mod = grade_spread_modifier(grade)
    jersey_mod = jersey_number_modifier(jersey_number)

    # Print-run premium (matches copilot-instructions card weights table).
    pr_mult = 1.0
    pr_signal = "no_print_run"
    if print_run:
        if print_run <= 25:
            pr_mult, pr_signal = 1.50, "ultra_low_print_run"
        elif print_run <= 100:
            pr_mult, pr_signal = 1.25, "low_print_run"
        elif print_run <= 250:
            pr_mult, pr_signal = 1.12, "limited_print_run"
        else:
            pr_mult, pr_signal = 1.0, "open_print_run"

    combined = (
        rookie["multiplier"]
        * grade_mod["multiplier"]
        * jersey_mod["multiplier"]
        * pr_mult
    )
    combined = round(max(0.70, min(1.50, combined)), 3)

    return {
        "multiplier": combined,
        "components": {
            "rookie": rookie,
            "grade": grade_mod,
            "jersey": jersey_mod,
            "print_run": {
                "multiplier": pr_mult,
                "signal": pr_signal,
                "value": print_run,
            },
        },
    }
