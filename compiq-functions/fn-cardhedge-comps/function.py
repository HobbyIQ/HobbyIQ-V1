"""Per-player compsMomentum signal prefetch — Cardsight-backed.

Runs nightly at 02:00 UTC. For each tracked player:
  1. catalog.search("{player} baseball", take=5) -> 5 candidate cardIds
  2. For each candidate: pricing.get(cardId) -> record count
  3. Pick best-of-top-5 by pricing volume (raw.count, descending)
  4. If all 5 have zero pricing records: secondary search with
     "{player} {current_year}" -> repeat best-of-top-5
  5. Reduce winning candidate's raw.records -> compsMomentum signal
     via build_comps_payload (pure helper, vendor-agnostic)
  6. Persist to compiq-signals/{slug}/compsMomentum.json

Signal aggregator contract preserved verbatim (multiplier, signal,
comp_count, median_price, recent_avg, prior_avg).

History:
- CF-CARDHEDGE-SIGNAL-RENAME (2026-05-25, design at 80e9971):
  signal output name decoupled from CardHedge brand to compsMomentum.
- CF-FN-COMPS-MIGRATION Sub-2a (2026-05-30): data source migrated
  CardHedge -> Cardsight. Naming source-neutral (get_comps_signal).
  Initial naive hits[0] selection passed +/-10% deviation gate at
  8.76% median but had 72% coverage gap -- both vendors defaulted
  to neutral 1.0 for 18/25 sampled players (Phase gamma diagnostic
  in design doc Section 11).
- CF-FN-COMPS-MIGRATION Sub-2a (alpha) (2026-05-30): best-of-top-5
  by pricing volume + {player} {year} fallback. Addresses
  Cardsight's catalog.search relevance ranking surfacing niche-
  product cards (Leaf Press Pass, Panini Stars & Stripes) ahead
  of canonical cards (Bowman RC, Panini Absolute) which have
  zero pricing records.

Empirical finding (2026-05-30 probe_pricing_bulk.py):
Cardsight's POST /v1/pricing/bulk returns 404 Not Found. The
CF-CARDSIGHT-PRICING-BULK backlog item is empirically refuted.
This function uses per-card pricing.get loops instead. Cost:
1 catalog.search + 5 pricing.get per player = 6 calls/player;
25 players nightly = 150 calls -- well within Cardsight rate
limits.

Function directory name (fn-cardhedge-comps) deferred per
CF-CARDHEDGE-NAMING-CLEANUP -- preserves schedule + deploy identity
during cutover.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from shared.cardhedge import build_comps_payload  # pure helper, vendor-agnostic
from shared.cardsight import get_pricing, search_catalog

# Top-N candidates to volume-rank per search. Empirically: top 5 is
# sufficient to find the canonical card for the player set probed
# (Section 11.4 of CF-FN-COMPS-MIGRATION Phase 1 doc). Increasing
# beyond 5 raises API call cost without empirical coverage gain
# observed in Phase gamma.
TOP_N = 5


def _records_count(pricing: dict[str, Any] | None) -> int:
    """Total raw record count from a pricing.get response."""
    if not pricing:
        return 0
    raw = pricing.get("raw") or {}
    return int(raw.get("count") or 0)


def _best_by_pricing_volume(
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Volume-rank candidates via per-card pricing.get, return the winner.

    Returns (None, None) when no candidate has a valid id or when all
    pricing.get calls return zero records. Caller distinguishes these
    cases via _records_count(pricing) == 0.
    """
    if not candidates:
        return None, None

    best_hit: dict[str, Any] | None = None
    best_pricing: dict[str, Any] | None = None
    best_count = -1

    for c in candidates[:TOP_N]:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        pricing = get_pricing(cid)
        count = _records_count(pricing)
        if count > best_count:
            best_hit = c
            best_pricing = pricing
            best_count = count

    return best_hit, best_pricing


def get_comps_signal(player_name: str) -> dict[str, Any]:
    """Build per-player compsMomentum payload from Cardsight pricing data."""
    # Primary search: "{player} baseball" (preserves prior query string
    # for behavioral parity at the catalog-search boundary; selection
    # logic differs).
    primary = search_catalog(f"{player_name} baseball", take=TOP_N)
    if not primary:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_match",
            "comp_count": 0,
            "updated_at": datetime.utcnow().isoformat(),
        }

    best_hit, best_pricing = _best_by_pricing_volume(primary)
    selection_path = "primary_best_of_top_5"

    # Fallback: when all top-5 from primary search have zero records,
    # try "{player} {current_year}" -- empirically (Section 11.4) this
    # surfaces flagship-product cards (Bowman, Topps Chrome) for active
    # players whose primary search top-5 are all niche products.
    if best_pricing is None or _records_count(best_pricing) == 0:
        current_year = datetime.utcnow().year
        year_candidates = search_catalog(f"{player_name} {current_year}", take=TOP_N)
        if year_candidates:
            year_hit, year_pricing = _best_by_pricing_volume(year_candidates)
            if year_pricing is not None and _records_count(year_pricing) > 0:
                best_hit = year_hit
                best_pricing = year_pricing
                selection_path = "year_fallback_best_of_top_5"

    # No usable pricing found in either pass.
    if best_hit is None or best_pricing is None or _records_count(best_pricing) == 0:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_data",
            "comp_count": 0,
            "updated_at": datetime.utcnow().isoformat(),
        }

    card_id = str(best_hit.get("id") or "")
    if not card_id:
        # Defensive: winning hit had no id (shouldn't reach here per
        # the loop above, but preserve the prior signal taxonomy).
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "no_id",
            "comp_count": 0,
            "updated_at": datetime.utcnow().isoformat(),
        }

    raw_records = (best_pricing.get("raw") or {}).get("records") or []
    sales = raw_records[:25]

    payload = build_comps_payload(player_name, sales)
    payload.update(
        {
            "cardsight_card_id": card_id,
            "cardsight_card_name": best_hit.get("name") or "",
            "cardsight_release_name": best_hit.get("releaseName") or "",
            "cardsight_year": best_hit.get("year"),
            "selection_path": selection_path,
            "raw_sales": sales,
            "updated_at": datetime.utcnow().isoformat(),
        }
    )
    return payload
