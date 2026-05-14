"""M10 — YouTube mention tracking.

Searches YouTube for recent uploads mentioning a player + "card", counts
results in the last 7 days vs the prior 21 days, and emits a multiplier on
the same 0.85–1.20 scale as Reddit/Trends. Hobby content creators (PWCC
breaks, Sports Card Investor, etc.) tend to lead Reddit chatter by 2–3
days, which makes this a useful early-warning signal.

Requires `YOUTUBE_API_KEY` in app settings (Google Cloud → YouTube Data
API v3 → API key, free quota 10k units/day).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta
from typing import Any

import requests

API_BASE = "https://www.googleapis.com/youtube/v3/search"


def _count_uploads(query: str, after_iso: str, before_iso: str) -> int:
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        raise RuntimeError("YOUTUBE_API_KEY not set")
    try:
        resp = requests.get(
            API_BASE,
            params={
                "key": key,
                "q": query,
                "type": "video",
                "part": "id",
                "maxResults": 50,
                "publishedAfter": after_iso,
                "publishedBefore": before_iso,
            },
            timeout=15,
        )
    except Exception as exc:  # noqa: BLE001
        logging.warning("YouTube fetch failed for %s: %s", query, exc)
        return 0
    if not resp.ok:
        return 0
    body = resp.json() or {}
    # Use pageInfo.totalResults when available (capped at 1M but accurate
    # for our magnitude check); fall back to the page item count.
    total = body.get("pageInfo", {}).get("totalResults")
    if isinstance(total, int):
        return total
    return len(body.get("items", []))


def get_youtube_signal(player_name: str) -> dict[str, Any]:
    now = datetime.utcnow()
    query = f"{player_name} card"

    recent_start = (now - timedelta(days=7)).isoformat("T") + "Z"
    prior_start = (now - timedelta(days=28)).isoformat("T") + "Z"
    midpoint = (now - timedelta(days=7)).isoformat("T") + "Z"
    now_iso = now.isoformat("T") + "Z"

    try:
        recent = _count_uploads(query, recent_start, now_iso)
        prior = _count_uploads(query, prior_start, midpoint)
    except RuntimeError:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_api_key",
            "updated_at": now.isoformat(),
        }
    except Exception as exc:  # noqa: BLE001
        logging.warning("YouTube signal failure for %s: %s", player_name, exc)
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "fetch_failed",
            "updated_at": now.isoformat(),
        }

    # Normalize prior to a 7-day baseline (was 21-day window).
    prior_baseline = max(prior / 3.0, 1.0)
    ratio = recent / prior_baseline if prior_baseline else 1.0

    if ratio >= 2.0:
        mult, sig = 1.20, "spiking"
    elif ratio >= 1.4:
        mult, sig = 1.10, "rising"
    elif ratio <= 0.5:
        mult, sig = 0.90, "fading"
    elif ratio <= 0.75:
        mult, sig = 0.95, "softening"
    else:
        mult, sig = 1.0, "stable"

    return {
        "player": player_name,
        "multiplier": round(mult, 3),
        "signal": sig,
        "recent_uploads_7d": recent,
        "prior_uploads_21d": prior,
        "ratio": round(ratio, 3),
        "updated_at": now.isoformat(),
    }
