"""Award / betting odds signal collector.

High award probability is a leading indicator — betting markets move weeks
before awards are announced, and card prices follow.
"""

from __future__ import annotations

import os
from datetime import datetime

import requests

AWARD_MARKETS = [
    "baseball_mlb_award_al_mvp",
    "baseball_mlb_award_nl_mvp",
    "baseball_mlb_award_al_cy_young",
    "baseball_mlb_award_nl_cy_young",
    "baseball_mlb_award_al_roy",
    "baseball_mlb_award_nl_roy",
]


def american_to_prob(odds: int) -> float:
    if odds > 0:
        return 100 / (odds + 100)
    return abs(odds) / (abs(odds) + 100)


def get_odds_signal(player_name: str) -> dict:
    api_key = os.environ.get("ODDS_API_KEY", "")
    if not api_key:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_api_key",
            "updated_at": datetime.utcnow().isoformat(),
        }

    matches: list[dict] = []
    for market in AWARD_MARKETS:
        try:
            resp = requests.get(
                f"https://api.the-odds-api.com/v4/sports/{market}/odds",
                params={
                    "apiKey": api_key,
                    "regions": "us",
                    "markets": "outrights",
                },
                timeout=15,
            )
        except Exception:
            continue
        if resp.status_code != 200:
            continue
        try:
            events = resp.json()
        except Exception:
            continue
        for event in events:
            for bookmaker in event.get("bookmakers", []) or []:
                markets = bookmaker.get("markets", [{}]) or [{}]
                for outcome in markets[0].get("outcomes", []) or []:
                    name = outcome.get("name", "")
                    price = outcome.get("price")
                    if not name or price is None:
                        continue
                    if player_name.lower() in name.lower():
                        matches.append(
                            {
                                "market": market,
                                "price": price,
                                "implied_prob": american_to_prob(int(price)),
                            }
                        )

    if not matches:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_data",
            "updated_at": datetime.utcnow().isoformat(),
        }

    best_prob = max(m["implied_prob"] for m in matches)
    multiplier = round(max(1.0, min(1.40, 1.0 + (best_prob * 0.35))), 3)

    return {
        "player": player_name,
        "best_award_prob": round(best_prob, 3),
        "markets": matches,
        "multiplier": multiplier,
        "signal": "award_contender"
        if best_prob > 0.25
        else "longshot"
        if best_prob > 0.05
        else "none",
        "updated_at": datetime.utcnow().isoformat(),
    }
