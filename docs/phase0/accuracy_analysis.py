"""
CF-CORPUS-ACCURACY-INSTRUMENT (2026-06-01)

§4.2 + §4.3 corpus-accuracy instrument per prediction_credibility_methodology_2026-05-30.md.

Pulls prediction_log (cross-partition, joinable=true) and portfolio (cross-partition,
ledger UNNEST) directly from Cosmos via DefaultAzureCredential. Computes:

  §4.2  Source A portfolio cohort MAPE (nowcast: most-recent prediction before sale)
        on (holdingId, userId). Stratified by source + fmvMechanism.

  §4.3  Source A portfolio cohort direction hit-rate per window {7d, 30d},
        nearest prediction to (soldAt - horizon) within ±20% tolerance.
        3-class exact match (primary) + 3x3 confusion + 2-class up/down (secondary).
        Closed-window denominator (T + horizon < now).

LOAD-BEARING 0-DATA GRACE: every metric degrades honestly. 0 joined pairs →
"no joined pairs yet (N predictions, M sales)" — NEVER prints NaN or 0.0 as
a result. The point today is the join + math execute end-to-end, not that
a number lands.

Run:
  python docs/phase0/accuracy_analysis.py

Auth:
  DefaultAzureCredential — uses your `az login` token chain. No connection string.
  Requires Cosmos DB Built-in Data Reader role on hobbyiq-comps account.
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

# ─── Configuration ──────────────────────────────────────────────────────────

ENDPOINT = "https://hobbyiq-comps.documents.azure.com:443/"
DATABASE = "hobbyiq"
PREDICTION_CONTAINER = "prediction_log"
PORTFOLIO_CONTAINER = "portfolio"

# Per methodology §4.3.1
WINDOWS_DAYS = [7, 30]
TOLERANCE_PCT = 0.20  # ±20% of horizon → ±1.4d @ 7d, ±6d @ 30d

# Per methodology §4.3 (existing v1)
DIRECTION_BAND_PCT = 5

# RBAC propagation retry — Cosmos data-plane role assignments can take a few
# minutes to take effect after creation.
RBAC_RETRY_MAX_SEC = 360
RBAC_RETRY_WAIT_SEC = 20


# ─── Time helpers ───────────────────────────────────────────────────────────

def parse_iso(s: str) -> datetime:
    """Parse Cosmos ISO 8601 timestamps. Handles 'Z' suffix + naive cases."""
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def to_seconds(td_days: float) -> float:
    return td_days * 86400.0


# ─── Cosmos pulls ───────────────────────────────────────────────────────────

def get_client() -> CosmosClient:
    """Authenticated client via DefaultAzureCredential (uses az login token)."""
    cred = DefaultAzureCredential(exclude_interactive_browser_credential=False)
    return CosmosClient(ENDPOINT, credential=cred)


def pull_predictions(client: CosmosClient) -> list[dict[str, Any]]:
    """
    Pull all joinable=true prediction rows. Cross-partition.

    Joinable filter eliminates the __unresolved__ sentinel rows that have no
    real cardsightCardId — those structurally cannot join to any outcome.
    """
    container = client.get_database_client(DATABASE).get_container_client(PREDICTION_CONTAINER)
    query = "SELECT * FROM c WHERE c.joinable = true"
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def pull_sales(client: CosmosClient) -> list[dict[str, Any]]:
    """
    Pull all ledger entries across all users. Cross-partition + unnest the
    embedded ledger array in each UserDoc. Returns per-sale rows with the
    parent userId attached so the prediction-side join key is complete.
    """
    container = client.get_database_client(DATABASE).get_container_client(PORTFOLIO_CONTAINER)
    query = (
        "SELECT c.userId AS userId, "
        "       l.id AS ledgerId, l.holdingId, l.unitSalePrice, l.soldAt, "
        "       l.source AS saleSource, l.quantitySold, l.grossProceeds, l.netProceeds "
        "FROM c JOIN l IN c.ledger"
    )
    return list(container.query_items(query=query, enable_cross_partition_query=True))


def pull_with_rbac_retry(name: str, fn):
    """Retry the pull on 403/AccessDenied — Cosmos RBAC can take minutes to propagate."""
    deadline = time.monotonic() + RBAC_RETRY_MAX_SEC
    while True:
        try:
            return fn()
        except Exception as e:
            msg = str(e)
            is_rbac = ("403" in msg) or ("Forbidden" in msg) or ("AccessDenied" in msg) \
                      or ("does not have required RBAC permissions" in msg)
            if is_rbac and time.monotonic() < deadline:
                print(f"  [{name}] RBAC 403 — waiting {RBAC_RETRY_WAIT_SEC}s for propagation...")
                time.sleep(RBAC_RETRY_WAIT_SEC)
                continue
            raise


# ─── §4.2 — nowcast MAPE join ───────────────────────────────────────────────

def join_nowcast(
    predictions: list[dict[str, Any]],
    sales: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    §4.2 join — for each portfolio-cohort sale (holdingId+userId+soldAt), attach
    the most-recent prediction with timestamp < soldAt for that same identity.

    Returns list of {sale, prediction} dicts. Sales with no eligible prediction
    are NOT in the result (counted in the coverage gap separately).
    """
    # Group portfolio predictions by (userId, holdingId), sorted by timestamp asc.
    by_holding: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for p in predictions:
        if not p.get("routedFromHolding"):
            continue
        uid = p.get("userId")
        hid = p.get("holdingId")
        if not uid or not hid:
            continue
        if not p.get("timestamp"):
            continue
        by_holding[(uid, hid)].append(p)
    for k in by_holding:
        by_holding[k].sort(key=lambda r: parse_iso(r["timestamp"]))

    joined = []
    for s in sales:
        uid = s.get("userId")
        hid = s.get("holdingId")
        sold_at = s.get("soldAt")
        unit_price = s.get("unitSalePrice")
        if not (uid and hid and sold_at and isinstance(unit_price, (int, float)) and unit_price > 0):
            continue
        candidates = by_holding.get((uid, hid), [])
        if not candidates:
            continue
        sold_dt = parse_iso(sold_at)
        # most-recent BEFORE sale
        prior = [c for c in candidates if parse_iso(c["timestamp"]) < sold_dt]
        if not prior:
            continue
        nowcast = prior[-1]  # largest timestamp < soldAt (list is sorted asc)
        joined.append({"sale": s, "prediction": nowcast})
    return joined


def mape_42(joined: list[dict[str, Any]]) -> dict[str, Any]:
    """
    §4.2 MAPE on the surfacedPrice → unitSalePrice axis, stratified by source +
    fmvMechanism. Returns nested dict; 0-data grace: empty strata report as 'NA'.
    """
    overall = []
    by_source: dict[str, list[float]] = defaultdict(list)
    by_fmv_mech: dict[str, list[float]] = defaultdict(list)

    for pair in joined:
        p = pair["prediction"]
        s = pair["sale"]
        surfaced = p.get("surfacedPrice")
        actual = s.get("unitSalePrice")
        if surfaced is None or actual is None or actual == 0:
            continue
        ape = abs(surfaced - actual) / actual
        overall.append(ape)
        src = p.get("source") or "unknown"
        mech = p.get("fmvMechanism") or "unknown"
        by_source[src].append(ape)
        by_fmv_mech[mech].append(ape)

    def summarize(vals: list[float]) -> Any:
        return {"n": len(vals), "mape": sum(vals) / len(vals)} if vals else "NA"

    return {
        "overall": summarize(overall),
        "by_source": {k: summarize(v) for k, v in by_source.items()} or "NA",
        "by_fmv_mechanism": {k: summarize(v) for k, v in by_fmv_mech.items()} or "NA",
    }


# ─── §4.3 — windowed nearest-(soldAt − horizon) join ────────────────────────

def join_window(
    predictions: list[dict[str, Any]],
    sales: list[dict[str, Any]],
    window_days: int,
    now: datetime,
) -> dict[str, Any]:
    """
    §4.3 windowed join — per (holdingId, userId, soldAt), find the prediction
    nearest to (soldAt − window) within ±TOLERANCE_PCT × window. Compute hit-rate,
    confusion matrix, denominator (closed-window predictions), and coverage.
    """
    tol_sec = to_seconds(window_days * TOLERANCE_PCT)
    horizon_sec = to_seconds(window_days)

    by_holding: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    closed_eligible = 0  # predictions whose horizon has closed (denominator)
    for p in predictions:
        if not p.get("routedFromHolding"):
            continue
        uid = p.get("userId")
        hid = p.get("holdingId")
        ts = p.get("timestamp")
        if not (uid and hid and ts):
            continue
        t = parse_iso(ts)
        if (now - t).total_seconds() > horizon_sec:
            closed_eligible += 1
        by_holding[(uid, hid)].append(p)
    for k in by_holding:
        by_holding[k].sort(key=lambda r: parse_iso(r["timestamp"]))

    joined_pairs = []
    sale_dropped_no_candidate = 0
    sale_skipped_no_holding_match = 0
    for s in sales:
        uid = s.get("userId")
        hid = s.get("holdingId")
        sold_at = s.get("soldAt")
        unit_price = s.get("unitSalePrice")
        if not (uid and hid and sold_at and isinstance(unit_price, (int, float)) and unit_price > 0):
            continue
        candidates = by_holding.get((uid, hid))
        if not candidates:
            sale_skipped_no_holding_match += 1
            continue
        sold_dt = parse_iso(sold_at)
        t_target = sold_dt.timestamp() - horizon_sec
        in_tol = [
            c for c in candidates
            if abs(parse_iso(c["timestamp"]).timestamp() - t_target) <= tol_sec
        ]
        if not in_tol:
            sale_dropped_no_candidate += 1
            continue
        # nearest
        nearest = min(in_tol, key=lambda c: abs(parse_iso(c["timestamp"]).timestamp() - t_target))
        joined_pairs.append({"sale": s, "prediction": nearest})

    # Hit-rate + confusion matrix
    band = DIRECTION_BAND_PCT / 100.0
    classes = ("rising", "falling", "stable")
    confusion = {p: {a: 0 for a in classes} for p in classes}
    hits_3 = 0
    hits_2 = 0
    n_2_eligible = 0
    for pair in joined_pairs:
        p = pair["prediction"]
        s = pair["sale"]
        pd_ = p.get("predictionDirection")
        fmv = p.get("fairMarketValue")
        actual = s.get("unitSalePrice")
        if pd_ not in classes or fmv is None or actual is None or fmv == 0 or actual == 0:
            continue
        if actual > fmv * (1 + band):
            ad = "rising"
        elif actual < fmv * (1 - band):
            ad = "falling"
        else:
            ad = "stable"
        confusion[pd_][ad] += 1
        if pd_ == ad:
            hits_3 += 1
        # 2-class secondary: drop stable on either side
        if pd_ != "stable" and ad != "stable":
            n_2_eligible += 1
            if pd_ == ad:
                hits_2 += 1

    def hr(num: int, den: int) -> Any:
        return {"hits": num, "n": den, "rate": num / den} if den > 0 else "NA"

    n_joined = sum(sum(row.values()) for row in confusion.values())
    return {
        "window_days": window_days,
        "tolerance_days_each_side": window_days * TOLERANCE_PCT,
        "closed_window_predictions": closed_eligible,
        "joined_pairs": len(joined_pairs),
        "joined_pairs_with_valid_fmv_and_price": n_joined,
        "sales_skipped_no_holding_match": sale_skipped_no_holding_match,
        "sales_dropped_no_candidate_in_tolerance": sale_dropped_no_candidate,
        "coverage": (
            {"joined": len(joined_pairs), "closed_eligible": closed_eligible,
             "rate": len(joined_pairs) / closed_eligible}
            if closed_eligible > 0 else "NA"
        ),
        "primary_3class_hit_rate": hr(hits_3, n_joined),
        "confusion_matrix_predicted_x_actual": confusion if n_joined > 0 else "NA",
        "secondary_2class_hit_rate": hr(hits_2, n_2_eligible),
    }


# ─── Cohort profile (always reportable, even at 0 joined pairs) ─────────────

def cohort_profile(
    predictions: list[dict[str, Any]],
    sales: list[dict[str, Any]],
) -> dict[str, Any]:
    by_src: dict[str, int] = defaultdict(int)
    by_rfh: dict[str, int] = defaultdict(int)
    portfolio_predictions_with_full_join_key = 0
    earliest = None
    latest = None
    for p in predictions:
        by_src[p.get("source") or "unknown"] += 1
        by_rfh[str(bool(p.get("routedFromHolding")))] += 1
        if p.get("routedFromHolding") and p.get("userId") and p.get("holdingId"):
            portfolio_predictions_with_full_join_key += 1
        ts = p.get("timestamp")
        if ts:
            t = parse_iso(ts)
            if earliest is None or t < earliest:
                earliest = t
            if latest is None or t > latest:
                latest = t
    return {
        "predictions_joinable_total": len(predictions),
        "predictions_by_source": dict(by_src),
        "predictions_by_routedFromHolding": dict(by_rfh),
        "portfolio_cohort_with_full_join_key (routedFromHolding=true AND userId AND holdingId)":
            portfolio_predictions_with_full_join_key,
        "prediction_timestamp_range_utc": {
            "earliest": earliest.isoformat() if earliest else "NA",
            "latest": latest.isoformat() if latest else "NA",
        },
        "ledger_sales_total_all_users": len(sales),
        "ledger_sales_with_positive_unit_price": sum(
            1 for s in sales if isinstance(s.get("unitSalePrice"), (int, float)) and s["unitSalePrice"] > 0
        ),
    }


# ─── Main ───────────────────────────────────────────────────────────────────

def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    now = datetime.now(tz=timezone.utc)
    print(f"[accuracy_analysis] {now.isoformat()}")
    print(f"  endpoint: {ENDPOINT}")
    print(f"  database: {DATABASE}")
    print(f"  containers: {PREDICTION_CONTAINER}, {PORTFOLIO_CONTAINER}")
    print(f"  auth: DefaultAzureCredential (az login)")
    print()

    client = get_client()

    print("[1/2] Pulling prediction_log (joinable=true)...")
    predictions = pull_with_rbac_retry("predictions", lambda: pull_predictions(client))
    print(f"      {len(predictions)} predictions pulled")

    print("[2/2] Pulling portfolio.ledger[] (UNNEST)...")
    sales = pull_with_rbac_retry("sales", lambda: pull_sales(client))
    print(f"      {len(sales)} ledger entries pulled")
    print()

    profile = cohort_profile(predictions, sales)

    # §4.2 nowcast join
    nowcast_pairs = join_nowcast(predictions, sales)
    mape_result = mape_42(nowcast_pairs)
    mape_result["joined_pairs_total"] = len(nowcast_pairs)

    # §4.3 windowed joins
    window_results = {f"{w}d": join_window(predictions, sales, w, now) for w in WINDOWS_DAYS}

    summary = {
        "methodology_ref": "docs/phase0/prediction_credibility_methodology_2026-05-30.md §4.2 + §4.3",
        "ran_at_utc": now.isoformat(),
        "cohort_profile": profile,
        "§4.2_nowcast_mape": mape_result,
        "§4.3_direction_hitrate_per_window": window_results,
        "0_data_grace_note": (
            "All metrics report 'NA' when their denominator is 0. The point of "
            "today's run is the join + math execute end-to-end against the real "
            "store; with no closed-window predictions or no joined pairs, the "
            "honest answer is 'no result yet,' not '0%'."
        ),
    }

    print("═" * 72)
    print("SUMMARY")
    print("═" * 72)
    print(json.dumps(summary, indent=2, sort_keys=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
