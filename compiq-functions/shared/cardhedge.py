"""Card Hedge AI client — primary sold-data source.

Card Hedge is the authoritative comp source. We never call it live at
prediction time; instead, fn-cardhedge-comps prefetches sold data nightly
and writes it to blob, and fn-nightly-comp-prefetch refreshes per-card
inventory comps. The MCP server reads cached comps from blob only.

API: https://api.cardhedger.com/v1
Auth: X-API-Key: $CARD_HEDGE_API_KEY
Prices come back as strings in DOLLARS (e.g. "850" or "45.99"). We coerce
to float and never divide by 100.

Cache TTLs (enforced by the timer functions, not here):
- comps:       12 hours
- market price: 6 hours
- card identity: 7 days
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests

BASE_URL = "https://api.cardhedger.com/v1"
DEFAULT_TIMEOUT = 20
MIN_IDENTITY_CONFIDENCE = 0.80


class CardHedgeError(RuntimeError):
    """Raised when Card Hedge returns a non-OK response or invalid payload."""


def _headers() -> dict[str, str]:
    key = os.environ.get("CARD_HEDGE_API_KEY")
    if not key:
        raise CardHedgeError("CARD_HEDGE_API_KEY not configured")
    return {
        "X-API-Key": key,
        "Content-Type": "application/json",
    }


def _to_float(value: Any) -> float:
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return 0.0


def search_cards(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """POST /cards/card-search — find cards by free-text query, baseball only.

    Response shape: {pages, count, cards: [{card_id, player, set, number,
    variant, prices: [{grade, price}], ...}]}.
    """
    try:
        resp = requests.post(
            f"{BASE_URL}/cards/card-search",
            headers=_headers(),
            json={
                "search": query,
                "category": "Baseball",
                "page": 1,
                "page_size": max(1, min(limit, 50)),
            },
            timeout=DEFAULT_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        logging.warning("Card Hedge search failed for '%s': %s", query, exc)
        return []
    if not resp.ok:
        logging.warning(
            "Card Hedge search %s returned %s: %s",
            query,
            resp.status_code,
            resp.text[:200],
        )
        return []
    cards = resp.json().get("cards", []) or []
    return cards[:limit]


def get_card_sales(
    card_id: str,
    grade: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """POST /cards/comps — recent sold comps with raw prices.

    Returns a list of `{price, date, grade, source, title, url}` dicts
    with prices in DOLLARS (already). Returns [] on any failure so callers
    can fall back gracefully.

    `grade` is REQUIRED by the live API (the OpenAPI spec marks it optional
    but the server rejects requests without it). We default to "Raw" so the
    nightly per-player refresh always succeeds; callers that care about a
    specific slab grade pass it explicitly.
    """
    body: dict[str, Any] = {
        "card_id": card_id,
        "count": limit,
        "grade": grade or "Raw",
        "include_raw_prices": True,
    }
    try:
        resp = requests.post(
            f"{BASE_URL}/cards/comps",
            headers=_headers(),
            json=body,
            timeout=DEFAULT_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        logging.warning("Card Hedge comps fetch failed for %s: %s", card_id, exc)
        return []
    if not resp.ok:
        logging.warning(
            "Card Hedge comps %s returned %s: %s",
            card_id,
            resp.status_code,
            resp.text[:200],
        )
        return []

    raw = resp.json().get("raw_prices", []) or []
    return [
        {
            "price": _to_float(s.get("price")),
            "date": s.get("sale_date"),
            "grade": s.get("grade") or grade or "Raw",
            "source": s.get("price_source") or "card_hedge",
            "sale_type": s.get("sale_type"),
            "title": s.get("title"),
            "url": s.get("sale_url"),
        }
        for s in raw
        if s.get("price") is not None
    ]


def identify_card(query: str, category: str = "Baseball") -> dict[str, Any] | None:
    """POST /cards/card-match — AI-powered text matching.

    Returns the match doc when confidence ≥ 0.80, otherwise None. The 0.80
    floor is non-negotiable: a low-confidence match poisons every downstream
    signal lookup keyed off the resulting card_id.
    """
    if not query:
        return None
    try:
        resp = requests.post(
            f"{BASE_URL}/cards/card-match",
            headers=_headers(),
            json={"query": query, "category": category},
            timeout=DEFAULT_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        logging.warning("Card Hedge match failed: %s", exc)
        return None
    if not resp.ok:
        return None
    body = resp.json() or {}
    confidence = float(body.get("confidence", 0) or 0)
    if confidence < MIN_IDENTITY_CONFIDENCE:
        return None
    return body


def build_comps_payload(
    player_name: str, sales: list[dict[str, Any]]
) -> dict[str, Any]:
    """Reduce a list of sales into a per-player Card Hedge signal payload.

    The aggregator reads `multiplier` and `signal` like every other source.
    Velocity heuristic: rate of price change across the most recent 7 vs
    prior 7 sales. Capped at 0.85–1.20.
    """
    prices = [s["price"] for s in sales if s.get("price")]
    if not prices:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_data",
            "comp_count": 0,
            "median_price": 0.0,
            "recent_avg": 0.0,
            "prior_avg": 0.0,
        }

    sorted_prices = sorted(prices)
    median = sorted_prices[len(sorted_prices) // 2]

    recent = prices[: min(7, len(prices))]
    prior = prices[len(recent) : len(recent) + min(7, max(0, len(prices) - len(recent)))]
    recent_avg = sum(recent) / len(recent)
    prior_avg = sum(prior) / len(prior) if prior else recent_avg

    if prior_avg <= 0:
        ratio = 1.0
    else:
        ratio = recent_avg / prior_avg
    multiplier = max(0.85, min(1.20, ratio))

    if multiplier > 1.08:
        signal = "rising"
    elif multiplier < 0.93:
        signal = "falling"
    else:
        signal = "stable"

    return {
        "player": player_name,
        "multiplier": round(multiplier, 3),
        "signal": signal,
        "comp_count": len(prices),
        "median_price": round(median, 2),
        "recent_avg": round(recent_avg, 2),
        "prior_avg": round(prior_avg, 2),
    }
