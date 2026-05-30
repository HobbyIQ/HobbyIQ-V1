"""Per-player compsMomentum signal prefetch -- Cardsight-backed (greenfield).

CF-COMPSMOMENTUM-GREENFIELD-CARDSIGHT (2026-05-30). Greenfield successor
to the deleted `fn-cardhedge-comps`; signal-payload contract preserved
verbatim. The signal aggregator at
`fn-signal-aggregator/function.py:18-26` reads this signal at weight 0.20
via `.get("multiplier", 1.0)` + `.get("signal")` per the
[[compsmomentum-weight-lock]] memory anchor (weight permanent; harm-
diagnosis fixes go to methodology/flag/segment paths).

Runs nightly at 02:00 UTC. For each tracked player:
  1. catalog.search("{player} baseball", take=5) -> 5 candidate cardIds
  2. For each candidate: pricing.get(cardId) -> record count
  3. Pick best-of-top-5 by pricing volume (raw.count, descending)
  4. If all 5 have zero pricing records: secondary search with
     "{player} {current_year}" -> repeat best-of-top-5
  5. Reduce winning candidate's raw.records -> compsMomentum signal
     via build_comps_payload (inlined helper below)
  6. Persist via save_signal(player_name, "compsMomentum", payload)

Query strategy is the alpha'-final pattern from 1fa9124 (Sub-2a
strategic pause). The cross-vendor canonical-card-divergence gate from
1fa9124 is intentionally absent here: Path A confirmed CardHedge gone,
no cross-vendor comparison possible or needed. Verification gates run
out-of-band (Phase 2.5 of this CF) measured Cardsight signal quality
on its own terms.

Empirical finding preserved from 1fa9124 (probe_pricing_bulk.py):
Cardsight POST /v1/pricing/bulk returns 404. CF-CARDSIGHT-PRICING-BULK
backlog item REFUTED. Per-card pricing.get loops at ~6 calls/player are
the working pattern. 25 players nightly = ~150 Cardsight calls, well
within rate limits.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from shared.cardsight import get_pricing, search_catalog

# Top-N candidates to volume-rank per search. Top-5 is sufficient to
# find the canonical card for the production player set per 1fa9124
# Section 11.4 (CF-FN-COMPS-MIGRATION Phase 1 doc). Increasing beyond
# 5 raises API call cost without empirical coverage gain.
TOP_N = 5


# ─── Inlined build_comps_payload (D-build_comps_payload option (i)) ──────────
#
# Preserved verbatim from 10ad39d (CF-CARDHEDGE-HARD-CUTOVER) commit
# body. Originally lived in the deleted `shared/cardhedge.py`. Per the
# hard-cutover D-disposition (i) lock, inline rather than reviving
# shared/cardhedge.py or creating a new shared/comps_payload.py --
# single source of truth at the only consumer.


def build_comps_payload(
    player_name: str, sales: list[dict[str, Any]]
) -> dict[str, Any]:
    """Reduce a list of sales into a per-player compsMomentum signal payload.

    Vendor-agnostic. The aggregator reads `multiplier` and `signal` like
    every other source. Velocity heuristic: rate of price change across
    the most recent 7 vs prior 7 sales. Multiplier capped at 0.85-1.20
    (the aggregator further clamps the blended result to 0.70-1.50).

    Signal taxonomy:
      no_data -> empty prices list (returned with multiplier=1.0)
      rising  -> multiplier > 1.08
      falling -> multiplier < 0.93
      stable  -> otherwise

    Output shape consumed by fn-signal-aggregator at:
      WEIGHTS["compsMomentum"] : 0.20
      signals["compsMomentum"].get("multiplier", 1.0)
      signals["compsMomentum"].get("signal")  # rising/falling/stable/no_data
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


# ─── Query strategy helpers (alpha'-final from 1fa9124) ──────────────────────


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
    # try "{player} {current_year}" -- empirically (1fa9124 Section 11.4)
    # this surfaces flagship-product cards (Bowman, Topps Chrome) for
    # active players whose primary search top-5 are all niche products.
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
