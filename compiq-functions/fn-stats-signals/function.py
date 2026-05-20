"""MLB Stats momentum signal collector.

Compares last 5 games vs 30-game baseline for hitters (avg, OPS), last 3
starts vs 15-start baseline for pitchers (ERA). Also watches for career
milestones that trigger a catalyst flag.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

import requests

MLB_BASE = "https://statsapi.mlb.com/api/v1"


def get_player_id(player_name: str) -> Optional[int]:
    try:
        resp = requests.get(
            f"{MLB_BASE}/people/search",
            params={"names": player_name, "sportId": 1},
            timeout=15,
        )
        people = resp.json().get("people", [])
        return people[0]["id"] if people else None
    except Exception:
        return None


def avg_stat(games: list, key: str) -> float:
    vals = [
        g.get("stat", {}).get(key)
        for g in games
        if g.get("stat", {}).get(key) is not None
    ]
    return sum(float(v) for v in vals) / len(vals) if vals else 0.0


def get_stats_signal(player_name: str) -> dict:
    player_id = get_player_id(player_name)
    if not player_id:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "player_not_found",
            "updated_at": datetime.utcnow().isoformat(),
        }

    season = datetime.utcnow().year
    splits: list = []
    group = "hitting"

    for g in ["hitting", "pitching"]:
        try:
            resp = requests.get(
                f"{MLB_BASE}/people/{player_id}/stats",
                params={"stats": "gameLog", "season": season, "group": g},
                timeout=15,
            )
            splits = resp.json().get("stats", [{}])[0].get("splits", [])
        except Exception:
            splits = []
        if splits:
            group = g
            break

    if not splits:
        return {
            "player": player_name,
            "player_id": player_id,
            "multiplier": 1.0,
            "signal": "no_game_log",
            "updated_at": datetime.utcnow().isoformat(),
        }

    if group == "hitting":
        recent_avg = avg_stat(splits[-5:], "avg")
        baseline_avg = avg_stat(splits[-30:], "avg")
        recent_ops = avg_stat(splits[-5:], "ops")
        baseline_ops = avg_stat(splits[-30:], "ops")
        r_avg = recent_avg / baseline_avg if baseline_avg else 1.0
        r_ops = recent_ops / baseline_ops if baseline_ops else 1.0
        momentum = (r_avg + r_ops) / 2
    else:
        era_recent = avg_stat(splits[-3:], "era")
        era_baseline = avg_stat(splits[-15:], "era")
        # lower ERA = better, so invert
        momentum = era_baseline / era_recent if era_recent > 0 else 1.0

    multiplier = round(max(0.90, min(1.30, momentum)), 3)

    # Milestone watch
    milestone: Optional[str] = None
    try:
        career_resp = requests.get(
            f"{MLB_BASE}/people/{player_id}/stats",
            params={"stats": "career", "group": group},
            timeout=15,
        )
        career = career_resp.json().get("stats", [{}])[0].get("splits", [{}])
        if career:
            stat = career[-1].get("stat", {})
            hr = int(stat.get("homeRuns", 0) or 0)
            hits = int(stat.get("hits", 0) or 0)
            if 495 <= hr < 500:
                milestone = f"approaching 500 HR ({hr} career HR)"
            elif 2990 <= hits < 3000:
                milestone = f"approaching 3000 hits ({hits} career hits)"
    except Exception:
        milestone = None

    return {
        "player": player_name,
        "player_id": player_id,
        "stat_group": group,
        "momentum_ratio": round(momentum, 3),
        "multiplier": multiplier,
        "direction": "hot"
        if momentum > 1.05
        else "cold"
        if momentum < 0.95
        else "neutral",
        "milestone": milestone,
        "updated_at": datetime.utcnow().isoformat(),
    }
