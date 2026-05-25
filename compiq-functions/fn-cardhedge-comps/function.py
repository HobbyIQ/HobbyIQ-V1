"""Per-player comp-momentum prefetch — primary sold-data source.

Runs nightly at 02:00 UTC. For each tracked player:
  1. POST /cards/search → top hit's `id` becomes the canonical card_id.
  2. GET /cards/{id}/sales → most recent 25 sold comps (newest first).
  3. Reduce to a comps-momentum signal payload (multiplier, median price,
     recent_7_avg / prior_7_avg ratio) and persist to
     compiq-signals/{slug}/compsMomentum.json.

CF-CARDHEDGE-SIGNAL-RENAME (2026-05-25, design at 80e9971): signal output
name is `compsMomentum` (decoupled from the CardHedge data-source brand).
Source function file name (`fn-cardhedge-comps`) deferred — name still
reflects the underlying CardHedge API consumed by `shared.cardhedge`.

Cache TTL: comps 12 hours, market price 6 hours. The aggregator reads only
the cached JSON — never call Card Hedge live at prediction time.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from shared.cardhedge import build_comps_payload, get_card_sales, search_cards


def get_cardhedge_signal(player_name: str) -> dict[str, Any]:
    hits = search_cards(f"{player_name} baseball", limit=5)
    if not hits:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_match",
            "comp_count": 0,
            "updated_at": datetime.utcnow().isoformat(),
        }

    card_id = str(hits[0].get("id") or hits[0].get("card_id") or "")
    if not card_id:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_id",
            "comp_count": 0,
            "updated_at": datetime.utcnow().isoformat(),
        }

    sales = get_card_sales(card_id, limit=25)
    payload = build_comps_payload(player_name, sales)
    payload.update(
        {
            "card_hedge_id": card_id,
            "card_hedge_title": hits[0].get("title") or hits[0].get("name"),
            "raw_sales": sales,
            "updated_at": datetime.utcnow().isoformat(),
        }
    )
    return payload
