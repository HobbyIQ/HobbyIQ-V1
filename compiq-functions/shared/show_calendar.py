"""H8 — Card show calendar.

Prices spike 2 weeks before major shows as dealers build inventory, then
soften in the week after as supply floods back. Hard-coded calendar; update
annually as new shows are announced.
"""

from __future__ import annotations

from datetime import date
from typing import Any

# (show_name, start, end, magnitude). magnitude in {"major", "regional"}.
CARD_SHOWS: list[tuple[str, date, date, str]] = [
    # 2026
    ("National Sports Collectors Convention", date(2026, 7, 29), date(2026, 8, 2), "major"),
    ("Fanatics Fest", date(2026, 8, 14), date(2026, 8, 16), "major"),
    ("Sport Card & Memorabilia Expo Toronto", date(2026, 11, 6), date(2026, 11, 8), "regional"),
    ("Las Vegas Card Show", date(2026, 3, 14), date(2026, 3, 16), "regional"),
    ("Atlanta Sports Card Show", date(2026, 4, 11), date(2026, 4, 12), "regional"),
    ("Dallas Card Show", date(2026, 5, 9), date(2026, 5, 10), "regional"),
    ("Chicagoland Sports Card Expo", date(2026, 6, 6), date(2026, 6, 7), "regional"),
    # 2027
    ("National Sports Collectors Convention", date(2027, 7, 28), date(2027, 8, 1), "major"),
]

# Multiplier targets at peak (1 day before / during show).
_MAJOR_PRE = 1.15
_MAJOR_POST = 0.95
_REG_PRE = 1.07
_REG_POST = 0.97


def get_show_calendar_signal(today: date | None = None) -> dict[str, Any]:
    """Multiplier based on proximity to upcoming card shows.

    Pre-show window: 14 days, scaled linearly with proximity.
    During show: full multiplier.
    Post-show window: 7 days of mild softening.
    Otherwise: neutral 1.0.
    """
    today = today or date.today()

    for show_name, start, end, magnitude in CARD_SHOWS:
        days_to_start = (start - today).days
        days_since_end = (today - end).days

        pre_target = _MAJOR_PRE if magnitude == "major" else _REG_PRE
        post_target = _MAJOR_POST if magnitude == "major" else _REG_POST

        if start <= today <= end:
            return {
                "show_name": show_name,
                "show_phase": "during",
                "show_multiplier": round(pre_target, 3),
                "show_magnitude": magnitude,
                "days_to_show": 0,
            }

        if 0 < days_to_start <= 14:
            scale = (14 - days_to_start + 1) / 14
            scaled = 1.0 + ((pre_target - 1.0) * scale)
            return {
                "show_name": show_name,
                "show_phase": "pre_show",
                "show_multiplier": round(scaled, 3),
                "show_magnitude": magnitude,
                "days_to_show": days_to_start,
            }

        if 0 < days_since_end <= 7:
            return {
                "show_name": show_name,
                "show_phase": "post_show",
                "show_multiplier": round(post_target, 3),
                "show_magnitude": magnitude,
                "days_since_show": days_since_end,
            }

    return {
        "show_name": None,
        "show_phase": "none",
        "show_multiplier": 1.0,
        "show_magnitude": None,
        "days_to_show": None,
    }
