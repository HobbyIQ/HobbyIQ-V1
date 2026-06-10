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

import logging
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


# ─── CF-PLAYER-IN-SET-HISTORY (2026-06-09) — per-(player, set) extension ────
#
# The existing per-player tick (run_for_all_players) writes one signal
# per tracked player. That's too coarse — Trout 2024 Topps Chrome and
# Trout 2024 Topps Update share zero driving forces but the blob
# blended them into one number.
#
# This extension walks a usage-seeded queue of (player, set) tuples
# written by the backend's /price-by-id route (CF-PLAYER-IN-SET-HISTORY
# PART 1). Coverage scales with what users actually price — not just
# the 5-player tracked-list default.
#
# CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): tuple identity is
# (player, release, year). The literal Cardsight subset name "Base Set"
# collides across products (every release's main subset is "Base Set"),
# so the prior `<set-slug>` key blended 2024 Bowman Draft + 2024 Topps
# Series 1 Griffin into one corrupted history. Storage path now keys
# by `<year>-<release-slug>` which is unique per edition.
#
# Path layout (compiq-signals/):
#   _seed/player-set-queue.json
#       Append-only list written by the backend. Each entry:
#         { player, release, year, seenAt }
#       seenAt drives the nightly's oldest-first drain.
#
#   playerInSet/<player-slug>/<year>-<release-slug>.json
#       Latest snapshot (overwrite each night).
#
#   playerInSet/<player-slug>/<year>-<release-slug>.history.json
#       Append-only list of nightly entries. The accrual IS the moat.

from shared import (
    load_blob_json,
    save_blob_json,
    save_signal_with_set,
    save_signal_history,
    set_slug,
)
from shared.cardsight import get_pricing, search_catalog  # noqa: F811 — already imported above

QUEUE_BLOB_PATH = "_seed/player-set-queue.json"

# Bound per-night work. The backend seed can grow with usage; without
# a cap a long backlog of unique tuples would push the nightly past
# its function-execution budget. Process the oldest MAX_PER_NIGHT
# first; the rest stays in the queue for tomorrow.
MAX_PER_NIGHT = 50

# How many catalog hits per (player, set) query to fan out for pricing.
# Mirrors the existing TOP_N for consistency.
PIS_TOP_N = TOP_N  # 5


def _tuple_key(entry: dict[str, Any]) -> tuple[str, str, Any]:
    # CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): key on release, not on
    # the literal subset name. Falls back to legacy `set` only if a
    # carry-over entry from the prior schema is still in flight; the
    # backend no longer writes those.
    release = (entry.get("release") or entry.get("set") or "").lower().strip()
    return (
        (entry.get("player") or "").lower().strip(),
        release,
        entry.get("year"),
    )


def _aggregate_sales_for_query(
    query: str,
) -> tuple[dict[str, list[dict[str, Any]]], int]:
    """Search catalog for `query`, fan out pricing across the top-K
    matches, and return a PER-CARD sales dict (cardId -> raw + graded
    sales for that card). Returns (per_card_sales, cards_scanned).

    CF-PLAYER-IN-SET-PER-CARD-DIRECTION (2026-06-10): keep the per-card
    grouping so the downstream signal compute can do per-card recent-vs-
    prior ratios. The prior "flatten all sales into one list" path
    surfaced composition (cheap base vs expensive auto in recent
    window) as price direction — mix, not movement.

    Grade-agnostic per card: each card's bucket flattens raw + every
    graded tier (so the per-card recent/prior reflects the card's broad
    direction, not a single-grade slice). Per-card pricing is already
    cached by the cardsight client at the 6h cs:pricing layer, so the
    fan-out cost is bounded.
    """
    per_card_sales: dict[str, list[dict[str, Any]]] = {}
    candidates = search_catalog(query, take=PIS_TOP_N) or []
    cards_scanned = 0
    for c in candidates[:PIS_TOP_N]:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        pricing = get_pricing(cid)
        if not pricing:
            continue
        card_sales: list[dict[str, Any]] = []
        raw_records = (pricing.get("raw") or {}).get("records") or []
        card_sales.extend(raw_records)
        for co in pricing.get("graded") or []:
            for g in co.get("grades") or []:
                grade_records = g.get("records") or []
                card_sales.extend(grade_records)
        if card_sales:
            per_card_sales[cid] = card_sales
        cards_scanned += 1
    return per_card_sales, cards_scanned


# ─── Per-card momentum compute ─────────────────────────────────────────
#
# CF-PLAYER-IN-SET-PER-CARD-DIRECTION (2026-06-10): aggregate the
# release's direction from PER-CARD ratios rather than pooled
# recent-vs-prior averages. Cards without ≥MIN_PER_WINDOW samples in
# BOTH windows are EXCLUDED — never fabricate direction from one
# window. Mirrors the live backend's fetchPlayerInSetMomentum.

PIS_WINDOW_SIZE = 7
PIS_MIN_PER_WINDOW = 3
PIS_MIN_QUALIFYING_CARDS = 2
PIS_MULTIPLIER_LO = 0.85
PIS_MULTIPLIER_HI = 1.20
PIS_RISING_THRESHOLD = 1.08
PIS_FALLING_THRESHOLD = 0.93


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    if n % 2 == 0:
        return (s[n // 2 - 1] + s[n // 2]) / 2.0
    return s[n // 2]


def _per_card_ratio(card_sales: list[dict[str, Any]]) -> dict[str, Any] | None:
    """For a single card's sales list, return its recent-vs-prior
    median ratio + window stats. None when the card doesn't have
    ≥MIN_PER_WINDOW samples in BOTH windows."""

    def _parse_date(s: Any) -> float:
        if not isinstance(s, str) or not s:
            return 0.0
        try:
            # Cardsight dates are ISO-ish (e.g. "2025-09-12" or with time);
            # take the date prefix and rely on lex sort by ISO date.
            return float(datetime.fromisoformat(s.replace("Z", "+00:00").split("T")[0]).timestamp())
        except Exception:  # noqa: BLE001
            return 0.0

    dated = [
        (s, _parse_date(s.get("date")))
        for s in card_sales
        if isinstance(s.get("price"), (int, float))
        and s["price"] > 0
        and s.get("date")
    ]
    if not dated:
        return None
    dated.sort(key=lambda t: t[1], reverse=True)  # desc by date
    prices = [float(s["price"]) for s, _ in dated]
    recent = prices[: min(PIS_WINDOW_SIZE, len(prices))]
    prior = prices[
        len(recent) : len(recent) + min(PIS_WINDOW_SIZE, max(0, len(prices) - len(recent)))
    ]
    if len(recent) < PIS_MIN_PER_WINDOW or len(prior) < PIS_MIN_PER_WINDOW:
        return None
    recent_median = _median(recent)
    prior_median = _median(prior)
    if prior_median <= 0:
        return None
    return {
        "ratio": recent_median / prior_median,
        "recent_median": recent_median,
        "prior_median": prior_median,
        "recent_n": len(recent),
        "prior_n": len(prior),
    }


def _build_per_card_payload(
    player: str, per_card_sales: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    """Build a compsMomentum-shaped payload from per-card sales using the
    per-card median-ratio aggregation. Same output keys as the legacy
    build_comps_payload (multiplier, signal, comp_count, median_price)
    so the signal-aggregator contract is preserved, plus per-card
    breakdown surfaced under `per_card_ratios`."""

    # Pool totals (still surfaced for context, but NOT the direction input)
    all_prices: list[float] = []
    for sales in per_card_sales.values():
        for s in sales:
            p = s.get("price")
            if isinstance(p, (int, float)) and p > 0:
                all_prices.append(float(p))
    pool_size = len(all_prices)
    pool_median = _median(all_prices) if all_prices else 0.0

    per_card_ratios: list[dict[str, Any]] = []
    for card_id, sales in per_card_sales.items():
        r = _per_card_ratio(sales)
        if r is None:
            continue
        per_card_ratios.append(
            {
                "card_id": card_id,
                "ratio": round(r["ratio"], 3),
                "recent_median": round(r["recent_median"], 2),
                "prior_median": round(r["prior_median"], 2),
                "recent_n": r["recent_n"],
                "prior_n": r["prior_n"],
            }
        )

    if len(per_card_ratios) < PIS_MIN_QUALIFYING_CARDS:
        # Honest no-direction: not enough cards with both windows
        # populated. Aggregator reads multiplier=1.0 (neutral).
        return {
            "player": player,
            "multiplier": 1.0,
            "signal": "no_direction",
            "comp_count": pool_size,
            "median_price": round(pool_median, 2),
            "qualifying_cards": len(per_card_ratios),
            "cards_in_pool": len(per_card_sales),
            "per_card_ratios": per_card_ratios,
            "aggregated_ratio": 1.0,
        }

    # Median of per-card ratios → robust to one card dominating volume
    # and immune to mix-skew (cheap-base-skewed recent window can't pull
    # the release signal without each card's OWN sales moving).
    aggregated = _median([p["ratio"] for p in per_card_ratios])
    multiplier = max(PIS_MULTIPLIER_LO, min(PIS_MULTIPLIER_HI, aggregated))
    if multiplier > PIS_RISING_THRESHOLD:
        signal = "rising"
    elif multiplier < PIS_FALLING_THRESHOLD:
        signal = "falling"
    else:
        signal = "stable"

    return {
        "player": player,
        "multiplier": round(multiplier, 3),
        "signal": signal,
        "comp_count": pool_size,
        "median_price": round(pool_median, 2),
        "qualifying_cards": len(per_card_ratios),
        "cards_in_pool": len(per_card_sales),
        "per_card_ratios": per_card_ratios,
        "aggregated_ratio": round(aggregated, 3),
    }


def compute_and_persist_player_in_set(
    player: str, release: str, year: int
) -> dict[str, Any] | None:
    """Compute the per-(player, release, year) momentum snapshot and persist:
       - Overwrites playerInSet/<player>/<year>-<release-slug>.json.
       - APPENDS a thin entry to playerInSet/<player>/<year>-<release-slug>.history.json.

    Returns the snapshot payload, or None when compute couldn't proceed
    (empty catalog match, no sales). Callers should treat None as a
    no-op for this tuple — the queue entry has been processed and
    won't be retried tonight.

    CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): the storage key is
    `<year>-<release-slug>` — release is the product line (e.g.
    "Bowman Draft", "Topps Update"), NOT the Cardsight subset name
    "Base Set" which collides across products.
    """
    # Query includes year + release so Cardsight catalog search lands
    # on the right edition. "<player> Base Set" returns garbage;
    # "2024 Bowman Draft Konnor Griffin" lands on the right cards.
    query = f"{year} {release} {player}"
    per_card_sales, cards_scanned = _aggregate_sales_for_query(query)
    if not per_card_sales:
        logging.info(
            "[playerInSet] %s / %s %d — no sales aggregated (cards_scanned=%d); skipping snapshot",
            player,
            release,
            year,
            cards_scanned,
        )
        return None

    # CF-PLAYER-IN-SET-PER-CARD-DIRECTION (2026-06-10): aggregate via
    # per-card recent-vs-prior median ratio, NOT pooled averages.
    # Cards without enough sales in both windows are EXCLUDED so a
    # cheap-base-skewed recent week can't masquerade as direction.
    payload = _build_per_card_payload(player, per_card_sales)
    payload.update(
        {
            "release": release,
            "year": year,
            "cards_scanned": cards_scanned,
            "computed_at": datetime.utcnow().isoformat(),
        }
    )

    slug = f"{year}-{set_slug(release)}"
    save_signal_with_set(player, "playerInSet", slug, payload)

    history_entry = {
        "computed_at": payload["computed_at"],
        "multiplier": payload.get("multiplier"),
        "signal": payload.get("signal"),
        "comp_count": payload.get("comp_count", 0),
        "median_price": payload.get("median_price", 0.0),
    }
    save_signal_history(player, "playerInSet", slug, history_entry)

    logging.info(
        "[playerInSet] %s / %s %d -> %.3fx %s (cards_scanned=%d, comps=%d, median=%.2f)",
        player,
        release,
        year,
        float(payload.get("multiplier", 1.0)),
        payload.get("signal") or "ok",
        cards_scanned,
        payload.get("comp_count", 0),
        float(payload.get("median_price", 0.0)),
    )
    return payload


def process_player_set_queue() -> None:
    """Walk the usage-seeded queue and compute per-(player, set)
    snapshots + history appends. Oldest-first drain; cap at
    MAX_PER_NIGHT; carry the rest to tomorrow.

    A throw on a single tuple does NOT halt the run — that tuple stays
    in the carried-forward queue for retry. Successful tuples are
    removed from the queue.
    """
    raw = load_blob_json(QUEUE_BLOB_PATH, default=[]) or []
    queue: list[dict[str, Any]] = raw if isinstance(raw, list) else []
    if not queue:
        logging.info("[playerInSet] queue is empty — nothing to drain")
        return

    # Dedupe defensively (the backend uses an in-process Set + an
    # existing-keys check before append, but a cross-instance race
    # could leak a dup. Keep the first occurrence's seenAt.)
    seen_keys: set[tuple[str, str, Any]] = set()
    deduped: list[dict[str, Any]] = []
    for entry in queue:
        k = _tuple_key(entry)
        if k in seen_keys:
            continue
        seen_keys.add(k)
        deduped.append(entry)

    # Oldest-first drain.
    deduped.sort(key=lambda x: x.get("seenAt") or "")
    to_process = deduped[:MAX_PER_NIGHT]
    carry_forward = deduped[MAX_PER_NIGHT:]

    logging.info(
        "[playerInSet] queue size=%d processing=%d carrying=%d",
        len(deduped),
        len(to_process),
        len(carry_forward),
    )

    succeeded_keys: set[tuple[str, str, Any]] = set()
    for entry in to_process:
        player = (entry.get("player") or "").strip()
        # CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): prefer release;
        # tolerate the legacy `set` field for carry-over entries written
        # by the prior schema (the backend no longer writes those).
        release = (entry.get("release") or entry.get("set") or "").strip()
        year = entry.get("year")
        # Year is REQUIRED: the storage key is <year>-<release-slug>,
        # and without year the snapshot/history paths collide across
        # editions. Drop yearless entries — they are malformed.
        if not player or not release or not isinstance(year, int) or year <= 0:
            logging.info(
                "[playerInSet] dropping malformed queue entry: player=%r release=%r year=%r",
                player,
                release,
                year,
            )
            succeeded_keys.add(_tuple_key(entry))
            continue
        try:
            compute_and_persist_player_in_set(player, release, year)
            succeeded_keys.add(_tuple_key(entry))
        except Exception as exc:  # noqa: BLE001
            logging.warning(
                "[playerInSet] compute failed for %s / %s %d (will retry): %s",
                player,
                release,
                year,
                exc,
            )
            # Leave succeeded_keys without this tuple → carries forward.

    # Build the new queue: anything that wasn't processed-and-succeeded
    # stays. The original queue (raw, not deduped) is the source of
    # truth so we don't drop valid entries that were duplicates of
    # successfully-processed ones.
    new_queue: list[dict[str, Any]] = []
    seen_in_new: set[tuple[str, str, Any]] = set()
    # Add carry_forward first (older first — preserves seenAt order
    # for tomorrow's drain).
    for entry in carry_forward:
        k = _tuple_key(entry)
        if k in seen_in_new:
            continue
        seen_in_new.add(k)
        new_queue.append(entry)
    # Add any failed entries from to_process.
    for entry in to_process:
        k = _tuple_key(entry)
        if k in succeeded_keys:
            continue
        if k in seen_in_new:
            continue
        seen_in_new.add(k)
        new_queue.append(entry)

    save_blob_json(QUEUE_BLOB_PATH, new_queue)
    logging.info(
        "[playerInSet] queue drained — wrote %d entries back (succeeded=%d, carried=%d)",
        len(new_queue),
        len(succeeded_keys),
        len(carry_forward),
    )
