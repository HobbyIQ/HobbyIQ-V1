"""H6 -- Price floor detection (Cosmos DB).

Each card (id keyed by `card_id` = e.g. "{player}|{year}|{set}|{cardNumber}|{grade}|{variant}")
has a 90-day minimum sold price stored in Cosmos. The pricing engine never
predicts below this floor.

History:
- Original primary data source: Card Hedge AI. eBay was the fallback.
- CF-CARDHEDGE-HARD-CUTOVER (2026-05-30): CardHedge subscription cancelled.
  update_floor_from_ebay is stubbed to a no-op. `read_floor` and
  `apply_price_floor` are preserved verbatim -- they only read existing
  Cosmos entries (vendor-agnostic) and stay load-bearing for the prediction
  engine's floor-enforcement path.

Future Cardsight Function (former Sub-2b scope) should restore
update_floor_from_ebay with Cardsight-primary (shared/cardsight.py
get_pricing) + eBay fallback path. Preserves the same Cosmos floor
container contract.

Cosmos config (env vars):
    COSMOS_ENDPOINT         account endpoint URL
    COSMOS_KEY              primary key
    COSMOS_DB               default "compiq"
    COSMOS_FLOOR_CONTAINER  default "price_floors"
"""

from __future__ import annotations

import logging
import os
from typing import Any

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
    """Return the stored floor doc, or None when absent/unreachable.

    Vendor-agnostic read path -- preserved verbatim through CF-CARDHEDGE-
    HARD-CUTOVER. Reads only; the floor value was written by whichever
    primary source was active at write time (CardHedge historically, then
    eBay fallback). Future Cardsight-sourced writes land in the same
    Cosmos doc shape.
    """
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
    """STUBBED per CF-CARDHEDGE-HARD-CUTOVER.

    Original implementation:
      Primary: Card Hedge (search_cards + get_card_sales, 90-day window,
        trim bottom 5%, min as floor).
      Fallback: eBay sold listings (Buy/Browse API with soldDateRange).
      Persist: upsert to Cosmos `price_floors` container.

    Stubbed because CardHedge is dead. eBay fallback path is also retired
    here to avoid partial-functionality confusion (the fallback was
    eBay-only when CH returned empty; now CH is always empty, so
    "fallback" would effectively become "primary" -- a substantive code
    change that belongs in the greenfield Cardsight Function rather than
    a hard-cutover stub).

    Returns the same shape the prior implementation returned so the
    Functions that call this (fn-price-floor HTTP route, future Cardsight
    nightly prefetch) can rely on the contract without crashing.
    """
    logging.info(
        "cosmos_floor.update_floor_from_ebay: stubbed (CF-CARDHEDGE-HARD-CUTOVER) "
        "card_id=%s",
        card_id,
    )
    return {"floor": None, "source": "stubbed", "comp_count": 0}


def apply_price_floor(predicted_price: float, card_id: str) -> dict[str, Any]:
    """Final-step floor enforcement before returning any prediction.

    Vendor-agnostic enforcement path -- preserved verbatim through
    CF-CARDHEDGE-HARD-CUTOVER. Reads existing Cosmos floor docs and
    clamps the prediction if below floor.

    Behavior with empty floor container (post-cutover, before greenfield
    Cardsight writes resume): read_floor returns None, no clamp applied,
    predicted_price passes through unchanged. Safe degradation.
    """
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
