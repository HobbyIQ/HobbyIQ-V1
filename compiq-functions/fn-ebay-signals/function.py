"""eBay signal collector.

Tracks active listing watch counts and sold velocity. Rising watchers +
accelerating sold count = strong buy-side demand.

H5: BIN price drop tracking. Compares today's average BIN listed price to
the 14-day rolling average per player. Sellers dropping BIN prices signals
demand softening 3-5 days before completed comps reflect it.

H7: Sell-through rate. sold_7d / (sold_7d + active_listings). Low rate is a
genuine weak-demand signal even when prices look stable.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import requests

from shared import load_blob_json, player_slug, save_blob_json
from shared.ebay_auth import get_ebay_token

EBAY_CATEGORY_SPORTS_CARDS = "212"


def get_sold_count(
    player_name: str, token: str, days_back: int, days_end: int = 0
) -> int:
    end = datetime.utcnow() - timedelta(days=days_end)
    start = end - timedelta(days=days_back)
    resp = requests.get(
        "https://api.ebay.com/buy/browse/v1/item_summary/search",
        headers={"Authorization": f"Bearer {token}"},
        params={
            "q": f"{player_name} baseball card",
            "category_ids": EBAY_CATEGORY_SPORTS_CARDS,
            "filter": (
                f"buyingOptions:{{FIXED_PRICE}},"
                f"soldDateRange:[{start.strftime('%Y-%m-%dT%H:%M:%SZ')}"
                f"..{end.strftime('%Y-%m-%dT%H:%M:%SZ')}]"
            ),
            "limit": 200,
        },
        timeout=20,
    )
    if not resp.ok:
        return 0
    return resp.json().get("total", 0)


def _fetch_active_bin_items(player_name: str, token: str) -> list[dict[str, Any]]:
    """Active fixed-price listings — used for both BIN drop and sell-through."""
    try:
        resp = requests.get(
            "https://api.ebay.com/buy/browse/v1/item_summary/search",
            headers={"Authorization": f"Bearer {token}"},
            params={
                "q": f"{player_name} baseball card",
                "category_ids": EBAY_CATEGORY_SPORTS_CARDS,
                "filter": "buyingOptions:{FIXED_PRICE}",
                "limit": 200,
            },
            timeout=20,
        )
    except Exception:
        return []
    if not resp.ok:
        return []
    return resp.json().get("itemSummaries", []) or []


def get_bin_price_drop_signal(
    player_name: str, active_items: list[dict[str, Any]]
) -> dict[str, Any]:
    """H5 — compare today's avg BIN to the 14-day rolling avg stored in blob."""
    prices_today = [
        float(i["price"]["value"])
        for i in active_items
        if isinstance(i.get("price"), dict) and "value" in i["price"]
    ]
    if not prices_today:
        return {
            "bin_multiplier": 1.0,
            "bin_signal": "no_data",
            "bin_drop_pct": 0.0,
            "current_avg_bin": 0.0,
            "rolling_avg_bin": 0.0,
        }

    current_avg_bin = round(sum(prices_today) / len(prices_today), 2)
    blob_path = f"{player_slug(player_name)}/bin_history.json"
    history = load_blob_json(blob_path, default={"daily_avg_bins": []}) or {}
    daily = list(history.get("daily_avg_bins", []))

    today_str = datetime.utcnow().strftime("%Y-%m-%d")
    # Replace today's entry if we already wrote one earlier in the day.
    daily = [d for d in daily if d.get("date") != today_str]
    daily.append({"date": today_str, "avg_bin": current_avg_bin})
    daily = daily[-14:]
    save_blob_json(blob_path, {"daily_avg_bins": daily})

    if len(daily) < 3:
        return {
            "bin_multiplier": 1.0,
            "bin_signal": "insufficient_history",
            "bin_drop_pct": 0.0,
            "current_avg_bin": current_avg_bin,
            "rolling_avg_bin": current_avg_bin,
        }

    prior = daily[:-1]
    rolling_avg = sum(p["avg_bin"] for p in prior) / len(prior)
    drop_pct = (
        ((current_avg_bin - rolling_avg) / rolling_avg) * 100
        if rolling_avg > 0
        else 0.0
    )

    if drop_pct < -10:
        bin_mult, bin_sig = 0.88, "sellers_dropping_fast"
    elif drop_pct < -5:
        bin_mult, bin_sig = 0.93, "sellers_dropping"
    elif drop_pct > 10:
        bin_mult, bin_sig = 1.10, "sellers_raising"
    elif drop_pct > 5:
        bin_mult, bin_sig = 1.05, "sellers_holding_firm"
    else:
        bin_mult, bin_sig = 1.0, "stable"

    return {
        "bin_multiplier": round(bin_mult, 3),
        "bin_signal": bin_sig,
        "bin_drop_pct": round(drop_pct, 2),
        "current_avg_bin": current_avg_bin,
        "rolling_avg_bin": round(rolling_avg, 2),
    }


def get_sell_through_rate(
    player_name: str,
    token: str,
    active_count: int,
) -> dict[str, Any]:
    """H7 — sold_7d / (sold_7d + active_listings) as a sell-through proxy.

    The eBay Browse API doesn't expose expired listings, so we use the
    active inventory count as the supply proxy (same approach the spec calls
    for). Below ~35% = weak demand even when ASKs look stable.
    """
    sold_7d = get_sold_count(player_name, token, days_back=7)
    total = sold_7d + max(0, active_count)
    rate = sold_7d / total if total > 0 else 0.5

    if rate >= 0.70:
        mult, sig = 1.12, "high_demand"
    elif rate >= 0.50:
        mult, sig = 1.04, "healthy"
    elif rate >= 0.35:
        mult, sig = 0.97, "soft"
    else:
        mult, sig = 0.88, "weak_demand"

    return {
        "sell_through_rate": round(rate, 3),
        "sold_7d": sold_7d,
        "active_listings": active_count,
        "str_multiplier": round(mult, 3),
        "str_signal": sig,
    }


def get_ebay_signal(player_name: str) -> dict:
    try:
        token = get_ebay_token()
    except Exception:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "auth_failed",
            "updated_at": datetime.utcnow().isoformat(),
        }

    try:
        active = requests.get(
            "https://api.ebay.com/buy/browse/v1/item_summary/search",
            headers={"Authorization": f"Bearer {token}"},
            params={
                "q": f"{player_name} baseball card",
                "category_ids": EBAY_CATEGORY_SPORTS_CARDS,
                "filter": "buyingOptions:{AUCTION}",
                "limit": 50,
            },
            timeout=20,
        ).json()
    except Exception:
        active = {"itemSummaries": []}

    items = active.get("itemSummaries", []) or []
    total_watchers = sum(i.get("watchCount", 0) or 0 for i in items)
    avg_watchers = total_watchers / len(items) if items else 0

    sold_recent = get_sold_count(player_name, token, days_back=7)
    sold_prior = get_sold_count(player_name, token, days_back=7, days_end=7)
    velocity_ratio = sold_recent / sold_prior if sold_prior > 0 else 1.0

    watcher_score = min(1.20, 1.0 + (avg_watchers / 100) * 0.15)
    velocity_score = max(0.85, min(1.25, velocity_ratio))
    base_multiplier = max(
        0.80, min(1.25, watcher_score * 0.4 + velocity_score * 0.6)
    )

    # H5 + H7 — compute on the BIN side.
    bin_items = _fetch_active_bin_items(player_name, token)
    bin_data = get_bin_price_drop_signal(player_name, bin_items)
    str_data = get_sell_through_rate(player_name, token, len(bin_items))

    # Blend: 60% watchers/velocity, 25% BIN trend, 15% sell-through.
    blended = (
        base_multiplier * 0.60
        + bin_data["bin_multiplier"] * 0.25
        + str_data["str_multiplier"] * 0.15
    )
    multiplier = round(max(0.80, min(1.25, blended)), 3)

    return {
        "player": player_name,
        "avg_watchers": round(avg_watchers, 1),
        "sold_recent_7d": sold_recent,
        "sold_prior_7d": sold_prior,
        "velocity_ratio": round(velocity_ratio, 2),
        "multiplier": multiplier,
        "signal": "hot"
        if multiplier > 1.10
        else "cold"
        if multiplier < 0.92
        else "neutral",
        # H5 fields
        "bin_signal": bin_data["bin_signal"],
        "bin_drop_pct": bin_data["bin_drop_pct"],
        "current_avg_bin": bin_data["current_avg_bin"],
        "rolling_avg_bin": bin_data["rolling_avg_bin"],
        # H7 fields
        "sell_through_rate": str_data["sell_through_rate"],
        "str_signal": str_data["str_signal"],
        "active_listings": str_data["active_listings"],
        "updated_at": datetime.utcnow().isoformat(),
    }
