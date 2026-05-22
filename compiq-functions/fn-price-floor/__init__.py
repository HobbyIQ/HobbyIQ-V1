"""H6 — Price floor HTTP function.

GET  /api/price-floor?cardId=...
    Returns {"card_id", "floor", "comp_count_90d", "updated_at"} or 404.

POST /api/price-floor
    Body: {"cardId", "playerName", "grade", "variant"}
    Refreshes the floor by pulling 90 days of sold comps from eBay and
    upserting the trimmed minimum to Cosmos. Returns the new floor.

Cards never get a prediction below their stored floor — the MCP server
calls GET before returning the final price and clamps if needed.
"""

from __future__ import annotations

import json
import logging

import azure.functions as func

from shared.cosmos_floor import read_floor, update_floor_from_ebay
from shared.ebay_auth import get_ebay_token


def _json_response(payload: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload), mimetype="application/json", status_code=status
    )


def main(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "GET":
        card_id = req.params.get("cardId")
        if not card_id:
            return _json_response({"error": "Missing cardId"}, 400)
        doc = read_floor(card_id)
        if not doc:
            return _json_response(
                {"error": "No floor stored", "cardId": card_id}, 404
            )
        return _json_response(
            {
                "card_id": doc.get("id"),
                "floor": doc.get("floor"),
                "comp_count_90d": doc.get("comp_count_90d"),
                "player_name": doc.get("player_name"),
                "grade": doc.get("grade"),
                "variant": doc.get("variant"),
                "updated_at": doc.get("updated_at"),
            }
        )

    # POST — refresh
    try:
        body = req.get_json()
    except Exception:
        return _json_response({"error": "Body must be JSON"}, 400)

    card_id = body.get("cardId")
    player_name = body.get("playerName")
    if not card_id or not player_name:
        return _json_response(
            {"error": "cardId and playerName required"}, 400
        )

    grade = body.get("grade") or "raw"
    variant = body.get("variant") or "base"

    try:
        token = get_ebay_token()
    except Exception as exc:  # noqa: BLE001
        logging.exception("eBay auth failed in fn-price-floor: %s", exc)
        return _json_response({"error": "eBay auth failed"}, 502)

    result = update_floor_from_ebay(
        card_id=card_id,
        player_name=player_name,
        grade=grade,
        variant=variant,
        ebay_token=token,
    )
    return _json_response(
        {
            "card_id": card_id,
            "player_name": player_name,
            "grade": grade,
            "variant": variant,
            **result,
        }
    )
