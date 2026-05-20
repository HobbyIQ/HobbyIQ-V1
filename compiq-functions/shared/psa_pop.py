"""M2 — PSA pop report tracking.

Population scarcity matters: a card with 50 PSA-10s is a different asset
than one with 5,000. We hit PSA's public pop-report API when a token is
available; otherwise we fall through to a neutral multiplier so prediction
never blocks on this signal.

Pop tiers (PSA 10 only — that's the grade collectors price off):
    pop ≤ 25       → 1.30  (true scarcity premium)
    pop ≤ 100      → 1.18
    pop ≤ 500      → 1.08
    pop ≤ 2,000    → 1.00  (neutral — typical modern)
    pop ≤ 10,000   → 0.94
    pop > 10,000   → 0.88  (mass-produced, supply pressure)

If pop has GROWN >25% in the last 30 days, add a `pop_inflating` flag and
shave another 0.97x — the print run is being filled out and supply is
accelerating.

Cache TTL: 7 days (pop reports update slowly).
Blob path: compiq-signals/{player-slug}/{card-id}/psa_pop.json
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any

import requests

PSA_API_BASE = "https://api.psacard.com/publicapi/v1"
DEFAULT_TIMEOUT = 15


def _headers() -> dict[str, str] | None:
    token = os.environ.get("PSA_API_TOKEN")
    if not token:
        return None
    return {"Authorization": f"Bearer {token}"}


def _tier_for_pop(pop_10: int) -> tuple[float, str]:
    if pop_10 <= 25:
        return 1.30, "ultra_scarce"
    if pop_10 <= 100:
        return 1.18, "very_scarce"
    if pop_10 <= 500:
        return 1.08, "scarce"
    if pop_10 <= 2000:
        return 1.00, "typical"
    if pop_10 <= 10000:
        return 0.94, "abundant"
    return 0.88, "mass_produced"


def fetch_psa_pop(spec_id: str) -> dict[str, Any] | None:
    """GET PSA pop counts by spec id (PSA's internal card identifier).

    Returns None when no token is configured or PSA returns an error so
    the caller can fall through to neutral.
    """
    headers = _headers()
    if not headers:
        return None
    try:
        resp = requests.get(
            f"{PSA_API_BASE}/pop/GetPSASpecPopulation/{spec_id}",
            headers=headers,
            timeout=DEFAULT_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        logging.warning("PSA pop fetch failed for %s: %s", spec_id, exc)
        return None
    if not resp.ok:
        return None
    body = resp.json() or {}
    pse = body.get("PSASpecPopulation") or body
    return {
        "pop_10": int(pse.get("PSA10", 0) or 0),
        "pop_9": int(pse.get("PSA9", 0) or 0),
        "pop_total": int(pse.get("Total", 0) or 0),
        "spec_id": spec_id,
    }


def psa_pop_signal(
    spec_id: str | None,
    *,
    prior_pop_10: int | None = None,
) -> dict[str, Any]:
    """Return a multiplier + payload for the given PSA spec id.

    `prior_pop_10` is the cached pop count from 30 days ago — supply it to
    detect population inflation. If unavailable, pass None.
    """
    now = datetime.utcnow().isoformat()
    if not spec_id:
        return {
            "multiplier": 1.0,
            "signal": "no_spec_id",
            "tier": None,
            "pop_10": None,
            "updated_at": now,
        }

    fetched = fetch_psa_pop(spec_id)
    if not fetched:
        return {
            "multiplier": 1.0,
            "signal": "pop_unavailable",
            "tier": None,
            "pop_10": None,
            "spec_id": spec_id,
            "updated_at": now,
        }

    pop_10 = fetched["pop_10"]
    base_mult, tier = _tier_for_pop(pop_10)

    inflating = False
    if prior_pop_10 and pop_10 > prior_pop_10 * 1.25:
        base_mult *= 0.97
        inflating = True

    return {
        "multiplier": round(max(0.80, min(1.35, base_mult)), 3),
        "signal": "pop_inflating" if inflating else f"pop:{tier}",
        "tier": tier,
        "pop_10": pop_10,
        "pop_9": fetched["pop_9"],
        "pop_total": fetched["pop_total"],
        "spec_id": spec_id,
        "inflating": inflating,
        "updated_at": now,
    }
