"""Nightly per-card comp prefetch (Card Hedge primary).

Walks the Cosmos `inventory` container, runs Card Hedge identify/search +
recent sales for every card, and persists the comps to:

    compiq-signals/{player-slug}/{card-id}/comps.json

The MCP server reads this file per card so prediction time never hits Card
Hedge live. Also refreshes the 90-day price floor in Cosmos via
`update_floor_from_ebay` (which prefers Card Hedge as its primary source).

Cosmos inventory container is configured via:
    COSMOS_INVENTORY_CONTAINER (default "inventory")

Each inventory doc must minimally expose:
    {"id", "playerName", "year", "set", "cardNumber", "grade", "variant",
     "cardHedgeId" (optional)}
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any

from shared import player_slug, save_blob_json
from shared.cardhedge import get_card_sales, search_cards
from shared.cosmos_floor import update_floor_from_ebay
from shared.ebay_auth import get_ebay_token
from shared.psa_pop import psa_pop_signal

INVENTORY_CONTAINER_NAME = os.environ.get("COSMOS_INVENTORY_CONTAINER", "inventory")


def _inventory_container():
    endpoint = os.environ.get("COSMOS_ENDPOINT")
    key = os.environ.get("COSMOS_KEY")
    if not endpoint or not key:
        return None
    try:
        from azure.cosmos import CosmosClient, PartitionKey  # local import

        client = CosmosClient(endpoint, key)
        db = client.create_database_if_not_exists(
            os.environ.get("COSMOS_DB", "compiq")
        )
        return db.create_container_if_not_exists(
            id=INVENTORY_CONTAINER_NAME,
            partition_key=PartitionKey(path="/playerName"),
        )
    except Exception as exc:  # noqa: BLE001
        logging.warning("Inventory container init failed: %s", exc)
        return None


def _norm_card_number(value: Any) -> str:
    """Normalize a card number for comparison: strip leading '#', upper, no spaces."""
    return str(value or "").strip().lstrip("#").upper().replace(" ", "")


def _norm_variant(value: Any) -> str:
    return str(value or "").strip().lower()


def _hit_id(hit: dict[str, Any]) -> str:
    return str(hit.get("id") or hit.get("card_id") or "")


def _score_hit(
    hit: dict[str, Any],
    *,
    want_number: str,
    want_variant: str,
    want_year: str,
    want_set: str,
) -> int:
    """Higher is better. 0 means unusable."""
    score = 0
    hit_number = _norm_card_number(hit.get("number"))
    if want_number:
        if hit_number == want_number:
            score += 100
        else:
            # Card number was provided but doesn't match — reject outright.
            return 0

    hit_variant = _norm_variant(hit.get("variant"))
    if want_variant:
        if hit_variant == want_variant:
            score += 30
        elif hit_variant == "base":
            score += 5  # weak preference for base over exotic parallels
    else:
        # No variant specified — strongly prefer Base over Superfractor/parallels.
        if hit_variant == "base":
            score += 25

    hit_set = str(hit.get("set") or "").lower()
    if want_year and want_year in hit_set:
        score += 5
    if want_set:
        # Token overlap on set name
        want_tokens = {t for t in want_set.lower().split() if len(t) > 2}
        hit_tokens = {t for t in hit_set.split() if len(t) > 2}
        score += len(want_tokens & hit_tokens)

    return score


def _resolve_card_hedge_id(card: dict[str, Any]) -> str | None:
    cached = card.get("cardHedgeId") or card.get("card_hedge_id")
    if cached:
        return str(cached)

    year = str(card.get("year") or "").strip()
    set_name = str(card.get("set") or "").strip()
    player = str(card.get("playerName") or "").strip()
    card_number = str(card.get("cardNumber") or "").strip()
    variant = str(card.get("variant") or "").strip()

    query = " ".join(p for p in [year, set_name, player, card_number, variant] if p)
    if not query:
        return None

    # Pull a wider net so we can score and pick the right printing. Bowman
    # Chrome cards in particular collide on "Auto" — BAA-LD case-hit auto and
    # CPA-LD 1st prospect auto both surface, and the first hit is often the
    # low-volume one. Score by exact card-number match + variant preference.
    hits = search_cards(query, limit=15)
    if not hits:
        return None

    want_number = _norm_card_number(card_number)
    want_variant = _norm_variant(variant)
    want_year = year
    want_set = set_name

    scored = [
        (
            _score_hit(
                h,
                want_number=want_number,
                want_variant=want_variant,
                want_year=want_year,
                want_set=want_set,
            ),
            h,
        )
        for h in hits
    ]
    scored = [pair for pair in scored if pair[0] > 0]

    if not scored:
        # Card number was specified and nothing matched — refuse rather than
        # locking onto the wrong printing (e.g. BAA-LD vs CPA-LD).
        if want_number:
            logging.warning(
                "Card Hedge: no hit matched card number %s for query %r — skipping",
                want_number,
                query,
            )
            return None
        # No card number given; fall back to top hit.
        return _hit_id(hits[0]) or None

    scored.sort(key=lambda pair: pair[0], reverse=True)

    # If the top two candidates tie on score, break the tie by recent sales
    # volume — the right card is the one people are actually selling.
    top_score = scored[0][0]
    leaders = [h for s, h in scored if s == top_score]
    if len(leaders) > 1:
        best_id: str | None = None
        best_volume = -1
        for h in leaders[:3]:  # cap external calls
            cid = _hit_id(h)
            if not cid:
                continue
            try:
                vol = len(get_card_sales(cid, limit=10))
            except Exception:  # noqa: BLE001
                vol = 0
            if vol > best_volume:
                best_volume = vol
                best_id = cid
        if best_id:
            return best_id

    return _hit_id(scored[0][1]) or None


def _build_card_id(card: dict[str, Any]) -> str:
    return "|".join(
        [
            str(card.get("playerName") or ""),
            str(card.get("year") or ""),
            str(card.get("set") or ""),
            str(card.get("cardNumber") or ""),
            str(card.get("grade") or "raw"),
            str(card.get("variant") or "base"),
        ]
    )


def prefetch_card(card: dict[str, Any], ebay_token: str | None) -> dict[str, Any]:
    player_name = str(card.get("playerName") or "").strip()
    if not player_name:
        return {"status": "skipped_no_player"}

    card_id = _build_card_id(card)
    grade = card.get("grade") or "raw"
    variant = card.get("variant") or "base"

    ch_id = _resolve_card_hedge_id(card)
    sales: list[dict[str, Any]] = []
    if ch_id:
        sales = get_card_sales(
            ch_id,
            grade=grade if grade and grade != "raw" else None,
            limit=25,
        )

    blob_path = f"{player_slug(player_name)}/{card.get('id') or card_id}/comps.json"
    save_blob_json(
        blob_path,
        {
            "card_id": card_id,
            "card_hedge_id": ch_id,
            "player_name": player_name,
            "grade": grade,
            "variant": variant,
            "comps": sales,
            "comp_count": len(sales),
            "updated_at": datetime.utcnow().isoformat(),
        },
    )

    # M2 — PSA pop snapshot (per-card, 7-day TTL handled by overwrite cadence).
    spec_id = card.get("psaSpecId") or card.get("psa_spec_id")
    prior_pop_10 = card.get("priorPop10") or card.get("prior_pop_10")
    pop_payload = psa_pop_signal(spec_id, prior_pop_10=prior_pop_10)
    pop_blob_path = (
        f"{player_slug(player_name)}/{card.get('id') or card_id}/psa_pop.json"
    )
    save_blob_json(pop_blob_path, pop_payload)

    floor_result: dict[str, Any] = {"floor": None, "source": "skipped"}
    if ebay_token:
        try:
            floor_result = update_floor_from_ebay(
                card_id=card_id,
                player_name=player_name,
                grade=grade,
                variant=variant,
                ebay_token=ebay_token,
            )
        except Exception as exc:  # noqa: BLE001
            logging.warning("Floor refresh failed for %s: %s", card_id, exc)

    return {
        "card_id": card_id,
        "card_hedge_id": ch_id,
        "comp_count": len(sales),
        "floor": floor_result.get("floor"),
        "floor_source": floor_result.get("source"),
        "pop_10": pop_payload.get("pop_10"),
        "pop_tier": pop_payload.get("tier"),
        "pop_multiplier": pop_payload.get("multiplier"),
    }


def run_prefetch() -> dict[str, Any]:
    container = _inventory_container()
    if not container:
        logging.warning("Inventory container unavailable — nothing to prefetch")
        return {"processed": 0, "errors": 0}

    try:
        ebay_token = get_ebay_token()
    except Exception as exc:  # noqa: BLE001
        logging.warning("eBay auth failed in nightly prefetch: %s", exc)
        ebay_token = None

    processed = 0
    errors = 0
    try:
        for card in container.read_all_items():
            try:
                prefetch_card(card, ebay_token)
                processed += 1
            except Exception as exc:  # noqa: BLE001
                errors += 1
                logging.exception(
                    "Prefetch failed for card %s: %s", card.get("id"), exc
                )
    except Exception as exc:  # noqa: BLE001
        logging.exception("Inventory enumeration failed: %s", exc)

    logging.info(
        "fn-nightly-comp-prefetch done: processed=%d errors=%d", processed, errors
    )
    return {"processed": processed, "errors": errors}
