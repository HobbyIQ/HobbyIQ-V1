"""Per-card 90-day comp prefetch & Cosmos floor writer (H6 re-arm).

Runs nightly at 02:30 UTC. For each demo target card:
  1. HTTP GET hobbyiq3 `/api/compiq/comps-by-player`.
  2. Filter response.comps to the last 90 days.
  3. If >=5 comps, drop bottom 5% and take the minimum of the remainder.
  4. Upsert to Cosmos `price_floors` keyed by the composite cardId the
     MCP layer builds at H6-check time:
       {player}|{year}|{set}|{cardNumber}|{grade}|{variant}

Data source note: `/comps-by-player` currently calls Cardsight directly
(predates the CH-first router seam shipped 2026-06-25). The trades it
returns are still real sold-listing data, so the floor (a "lowest real
sale we saw" guard) is valid regardless of source label. When Phase 2
moves `/comps-by-player` onto the CH-first router, the floors written
here will transparently become CH-sourced with no change to this file.

Why HTTP-to-backend instead of calling vendors directly from Python:
- The backend already owns the client + caching + identity logic.
- One source of truth for "what counts as a comp"; no Python/TS drift.
- Function failure on a single card is isolated and retried tomorrow.

Phase 1 scope: hardcoded 10 demo cards x ["raw", "PSA 10"]. Future
phases can extend by walking a Cosmos inventory container, but Phase 1
only re-arms H6 for what we actively demo.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import requests

from shared.cosmos_floor import upsert_floor

# Mirrors backend/src/services/compiq/compsByPlayer.service.ts
# CACHE_WARM_TARGETS, extended with cardNumber so the composite Cosmos key
# matches what MCP builds at prediction time.
_TARGETS: list[dict[str, Any]] = [
    {"player": "Mike Trout",       "year": 2011, "set": "Topps Update",        "cardNumber": "US175"},
    {"player": "Aaron Judge",      "year": 2017, "set": "Topps Update",        "cardNumber": "US189"},
    {"player": "Cody Bellinger",   "year": 2017, "set": "Topps Update",        "cardNumber": "US186"},
    {"player": "Shohei Ohtani",    "year": 2018, "set": "Topps Update",        "cardNumber": "US1"},
    {"player": "Ronald Acuna Jr",  "year": 2018, "set": "Topps Update",        "cardNumber": "US250"},
    {"player": "Juan Soto",        "year": 2018, "set": "Topps Update",        "cardNumber": "US300"},
    {"player": "Gleyber Torres",   "year": 2018, "set": "Topps Update",        "cardNumber": "US150"},
    {"player": "Bobby Witt Jr",    "year": 2022, "set": "Topps Chrome Update", "cardNumber": "USC150"},
    {"player": "Paul Skenes",      "year": 2024, "set": "Topps Chrome Update", "cardNumber": "USC1"},
    {"player": "Caleb Bonemer",    "year": 2024, "set": "Bowman Draft Chrome", "cardNumber": "BDC-150"},
]

# Per-card grade x variant fan-out. Variant stays "base" for Phase 1.
_GRADES: list[tuple[str | None, str | None, str]] = [
    # (gradeCompany, gradeValue, grade-label-used-in-cosmos-id)
    (None, None, "raw"),
    ("PSA", "10", "PSA 10"),
]
_VARIANT = "base"

_MIN_COMPS_FOR_FLOOR = 5    # below this, floor is too noisy to trust
_TRIM_BOTTOM_PCT = 0.05     # drop bottom 5% before taking min
_WINDOW_DAYS = 90
_BACKEND_TIMEOUT_SEC = 30


def _build_cosmos_id(
    player: str, year: int, set_name: str, card_number: str, grade: str, variant: str
) -> str:
    """Mirror mcp-server/pricing.ts cardId composition exactly."""
    parts = [player, str(year), set_name, card_number, grade, variant]
    return "|".join(p.strip() for p in parts)


def _fetch_comps(
    backend_url: str,
    target: dict[str, Any],
    grade_company: str | None,
    grade_value: str | None,
) -> list[dict[str, Any]] | None:
    """GET /api/compiq/comps-by-player. Returns comps list or None on failure."""
    params: dict[str, str] = {
        "playerName": target["player"],
        "product": target["set"],
        "cardYear": str(target["year"]),
    }
    if grade_company:
        params["gradeCompany"] = grade_company
    if grade_value:
        params["gradeValue"] = grade_value

    url = f"{backend_url.rstrip('/')}/api/compiq/comps-by-player?{urlencode(params)}"
    try:
        resp = requests.get(url, timeout=_BACKEND_TIMEOUT_SEC)
        if resp.status_code != 200:
            logging.warning(
                "comps-by-player non-200: status=%s url=%s body=%s",
                resp.status_code, url, resp.text[:200],
            )
            return None
        data = resp.json()
        comps = data.get("comps") or []
        if not isinstance(comps, list):
            return None
        return comps
    except Exception as exc:  # noqa: BLE001
        logging.warning("comps-by-player fetch failed url=%s err=%s", url, exc)
        return None


def _compute_floor(comps: list[dict[str, Any]]) -> tuple[float | None, int]:
    """Return (floor, comp_count_in_window).

    Floor = min of prices after trimming the bottom 5% within the 90-day
    window. None when fewer than _MIN_COMPS_FOR_FLOOR valid in-window comps.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=_WINDOW_DAYS)
    in_window: list[float] = []
    for c in comps:
        price = c.get("price")
        date_str = c.get("date") or ""
        if not isinstance(price, (int, float)) or price <= 0:
            continue
        if not date_str:
            continue
        try:
            iso = date_str.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except Exception:  # noqa: BLE001
            continue
        if dt < cutoff:
            continue
        in_window.append(float(price))

    count = len(in_window)
    if count < _MIN_COMPS_FOR_FLOOR:
        return None, count

    in_window.sort()
    drop = max(0, int(round(count * _TRIM_BOTTOM_PCT)))
    trimmed = in_window[drop:]
    if not trimmed:
        return None, count
    return float(min(trimmed)), count


def run_prefetch() -> dict[str, Any]:
    """Walk demo targets, compute 90-day floors, upsert to Cosmos.

    Per-card failures are counted but never abort the run.
    """
    backend_url = os.environ.get("HOBBYIQ_BACKEND_URL")
    if not backend_url:
        logging.error(
            "fn-nightly-comp-prefetch: HOBBYIQ_BACKEND_URL not configured; "
            "cannot fetch comps. Skipping run."
        )
        return {"processed": 0, "errors": 1, "skipped": "no_backend_url"}

    processed = 0
    floors_written = 0
    insufficient = 0
    errors = 0
    details: list[dict[str, Any]] = []

    for target in _TARGETS:
        for grade_company, grade_value, grade_label in _GRADES:
            processed += 1
            comps = _fetch_comps(backend_url, target, grade_company, grade_value)
            if comps is None:
                errors += 1
                details.append({"player": target["player"], "grade": grade_label, "result": "fetch_failed"})
                continue

            floor, count = _compute_floor(comps)
            if floor is None:
                insufficient += 1
                details.append({
                    "player": target["player"],
                    "grade": grade_label,
                    "result": "insufficient_comps",
                    "count": count,
                })
                continue

            cosmos_id = _build_cosmos_id(
                target["player"], target["year"], target["set"],
                target["cardNumber"], grade_label, _VARIANT,
            )
            result = upsert_floor(
                card_id=cosmos_id,
                floor=floor,
                comp_count_90d=count,
                player_name=target["player"],
                grade=grade_label,
                variant=_VARIANT,
                source="comps-by-player",
            )
            if result.get("persisted"):
                floors_written += 1
                details.append({
                    "player": target["player"],
                    "grade": grade_label,
                    "result": "upserted",
                    "floor": floor,
                    "count": count,
                })
            else:
                errors += 1
                details.append({
                    "player": target["player"],
                    "grade": grade_label,
                    "result": "upsert_failed",
                    "floor": floor,
                })

    summary = {
        "processed": processed,
        "floors_written": floors_written,
        "insufficient": insufficient,
        "errors": errors,
        "details": details,
    }
    logging.info("fn-nightly-comp-prefetch summary: %s", summary)
    return summary
