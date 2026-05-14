"""H6 — Price floor detection (Cosmos DB).

Each card (id keyed by `card_id` = e.g. "{player}|{year}|{set}|{cardNumber}|{grade}|{variant}")
has a 90-day minimum sold price stored in Cosmos. The pricing engine never
predicts below this floor.

Primary data source: Card Hedge AI (`shared.cardhedge`). eBay is the
fallback when Card Hedge has no comps for the card.

Cosmos config (env vars):
    COSMOS_ENDPOINT         account endpoint URL
    COSMOS_KEY              primary key
    COSMOS_DB               default "compiq"
    COSMOS_FLOOR_CONTAINER  default "price_floors"
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta
from typing import Any

import requests

from shared.cardhedge import get_card_sales, search_cards

DB_NAME = os.environ.get("COSMOS_DB", "compiq")
CONTAINER_NAME = os.environ.get("COSMOS_FLOOR_CONTAINER", "price_floors")


def _container():
    """Return Cosmos container client, or None when not configured."""
    endpoint = os.environ.get("COSMOS_ENDPOINT")
    key = os.environ.get("COSMOS_KEY")
    if not endpoint or not key:
        return None
    try:
        from azure.cosmos import CosmosClient, PartitionKey  # local import: optional dep at runtime

        client = CosmosClient(endpoint, key)
        db = client.create_database_if_not_exists(DB_NAME)
        return db.create_container_if_not_exists(
            id=CONTAINER_NAME,
            partition_key=PartitionKey(path="/id"),
        )
    except Exception as exc:  # noqa: BLE001
        logging.warning("Cosmos container init failed: %s", exc)
        return None


def read_floor(card_id: str) -> dict[str, Any] | None:
    """Return the stored floor doc, or None when absent/unreachable."""
    container = _container()
    if not container:
        return None
    try:
        return container.read_item(item=card_id, partition_key=card_id)
    except Exception:
        return None


def update_floor_from_ebay(
    card_id: str,
    player_name: str,
    grade: str,
    variant: str,
    ebay_token: str,
) -> dict[str, Any]:
    """Refresh the 90-day price floor for a card.

    Card Hedge is the primary source; eBay is the fallback. Trims the bottom
    5% as outliers, takes the min of what remains, and upserts to Cosmos.

    Returns {"floor": float|None, "source": "card_hedge"|"ebay"|"cached"|"no_data"}.
    """
    container = _container()

    sold_prices: list[float] = []
    source = "no_data"

    # ---- Primary: Card Hedge ----
    try:
        hits = search_cards(f"{player_name} {variant} baseball card", limit=3)
        if hits:
            ch_id = str(hits[0].get("id") or hits[0].get("card_id") or "")
            if ch_id:
                ch_sales = get_card_sales(
                    ch_id, grade=grade if grade and grade != "raw" else None, limit=200
                )
                cutoff = datetime.utcnow() - timedelta(days=90)
                for s in ch_sales:
                    price = float(s.get("price") or 0)
                    if price <= 0:
                        continue
                    sold_at = s.get("date")
                    try:
                        if sold_at and datetime.fromisoformat(
                            sold_at.replace("Z", "+00:00")
                        ).replace(tzinfo=None) < cutoff:
                            continue
                    except Exception:
                        pass
                    sold_prices.append(price)
                if sold_prices:
                    source = "card_hedge"
    except Exception as exc:  # noqa: BLE001
        logging.warning("Card Hedge floor fetch failed for %s: %s", card_id, exc)

    # ---- Fallback: eBay sold listings ----
    if not sold_prices:
        end = datetime.utcnow()
        start = end - timedelta(days=90)
        query_term = " ".join(
            p for p in [player_name, grade, variant, "baseball card"] if p
        ).strip()
        try:
            resp = requests.get(
                "https://api.ebay.com/buy/browse/v1/item_summary/search",
                headers={"Authorization": f"Bearer {ebay_token}"},
                params={
                    "q": query_term,
                    "category_ids": "212",
                    "filter": (
                        f"buyingOptions:{{FIXED_PRICE}},"
                        f"soldDateRange:[{start.strftime('%Y-%m-%dT%H:%M:%SZ')}"
                        f"..{end.strftime('%Y-%m-%dT%H:%M:%SZ')}]"
                    ),
                    "limit": 200,
                },
                timeout=20,
            )
            items = resp.json().get("itemSummaries", []) if resp.ok else []
        except Exception:
            items = []

        sold_prices = [
            float(i["price"]["value"])
            for i in items
            if isinstance(i.get("price"), dict) and "value" in i["price"]
        ]
        if sold_prices:
            source = "ebay"

    if not sold_prices:
        cached = read_floor(card_id) if container else None
        if cached:
            return {"floor": cached.get("floor"), "source": "cached"}
        return {"floor": None, "source": "no_data"}

    sold_prices.sort()
    trim = max(1, int(len(sold_prices) * 0.05))
    trimmed = sold_prices[trim:] or sold_prices
    floor = round(min(trimmed), 2)

    doc = {
        "id": card_id,
        "player_name": player_name,
        "grade": grade,
        "variant": variant,
        "floor": floor,
        "comp_count_90d": len(sold_prices),
        "source": source,
        "updated_at": datetime.utcnow().isoformat(),
    }
    if container:
        try:
            container.upsert_item(doc)
        except Exception as exc:  # noqa: BLE001
            logging.warning("Cosmos upsert failed for %s: %s", card_id, exc)

    return {
        "floor": floor,
        "source": source,
        "comp_count": len(sold_prices),
    }


def apply_price_floor(predicted_price: float, card_id: str) -> dict[str, Any]:
    """Final-step floor enforcement before returning any prediction."""
    doc = read_floor(card_id)
    floor = doc.get("floor") if doc else None
    if floor is not None and predicted_price < floor:
        return {
            "final_price": float(floor),
            "floor_applied": True,
            "floor_value": float(floor),
            "original_prediction": float(predicted_price),
        }
    return {
        "final_price": float(predicted_price),
        "floor_applied": False,
        "floor_value": float(floor) if floor is not None else None,
        "original_prediction": float(predicted_price),
    }
