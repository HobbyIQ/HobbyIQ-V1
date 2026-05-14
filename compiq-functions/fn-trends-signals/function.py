"""Google Trends signal collector.

Catches search interest spikes before they show up in completed sales. Also
checks related queries for card-buying intent ("buy card", etc).
"""

from __future__ import annotations

from datetime import datetime

from pytrends.request import TrendReq


def get_trends_signal(player_name: str) -> dict:
    try:
        pytrends = TrendReq(hl="en-US", tz=360)
        pytrends.build_payload([player_name], timeframe="now 7-d", geo="US")
        interest = pytrends.interest_over_time()
    except Exception:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "trend": "fetch_failed",
            "updated_at": datetime.utcnow().isoformat(),
        }

    if interest.empty:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "trend": "no_data",
            "updated_at": datetime.utcnow().isoformat(),
        }

    values = interest[player_name].tolist()
    recent_avg = sum(values[-12:]) / 12
    baseline_avg = sum(values) / len(values)
    spike_ratio = recent_avg / baseline_avg if baseline_avg > 0 else 1.0

    buy_intent = False
    try:
        related = pytrends.related_queries()
        rising_queries = related.get(player_name, {}).get("rising", None)
        if rising_queries is not None and not rising_queries.empty:
            buy_intent = any(
                "card" in str(q).lower() or "buy" in str(q).lower()
                for q in rising_queries.get("query", [])
            )
    except Exception:
        buy_intent = False

    multiplier = max(0.90, min(1.20, 1.0 + (spike_ratio - 1.0) * 0.25))
    if buy_intent:
        multiplier = min(1.20, multiplier + 0.05)

    return {
        "player": player_name,
        "spike_ratio": round(spike_ratio, 2),
        "buy_intent_detected": buy_intent,
        "multiplier": round(multiplier, 3),
        "trend": "spiking"
        if spike_ratio > 2.0
        else "rising"
        if spike_ratio > 1.2
        else "stable",
        "updated_at": datetime.utcnow().isoformat(),
    }
