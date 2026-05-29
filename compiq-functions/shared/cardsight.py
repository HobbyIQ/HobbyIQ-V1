"""Cardsight API client — primary sold-data source post-CF-CARDHEDGE-DECOMMISSION-FULL.

This is the Python equivalent of backend/src/services/compiq/cardsight.client.ts
(canonical reference; shipped in CF-PRICE-BY-ID-MIGRATION at commit 5640084).
Built new for CF-FN-COMPS-MIGRATION Sub-2a per Phase 1 finding 10.1 (the
"if it exists" hedge in Drew's earlier framing refuted by filesystem check).

API:   https://api.cardsight.ai/v1
Auth:  X-API-Key from CARDSIGHT_API_KEY env var
Timeout: 20s (matches shared/cardhedge.py for behavioral consistency)
Retry: exponential backoff (1s, 2s, 4s) on 429 + 5xx -- stricter than
       shared/cardhedge.py (no retry) because Cardsight is the sole comp
       source post-migration and defensive retry matters more.
404 handling: notFound sentinel; never raise -- callers fall back gracefully.

Functions exported:
  search_catalog(query, year=None, take=20) -> list of catalog results
  get_pricing(card_id, parallel_id=None)    -> pricing response (raw + graded)
  get_pricing_bulk(card_ids)                -> list of pricing responses (1-100)
  get_card_detail(card_id)                  -> single card detail with parallels[]
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import requests

BASE_URL = "https://api.cardsight.ai/v1"
DEFAULT_TIMEOUT = 20
MAX_RETRIES = 3


class CardsightError(RuntimeError):
    """Raised when Cardsight returns a non-recoverable error after retries."""


class CardsightTimeoutError(CardsightError):
    """Raised when Cardsight request exceeds DEFAULT_TIMEOUT."""


# ─── Structured logging ─────────────────────────────────────────────────────


def _log_event(level: str, event: str, **fields: Any) -> None:
    """Emit a JSON-structured log line. Grep-friendly per the convention
    established by backend/src/services/compiq/cardsight.client.ts."""
    payload = {"event": event, "source": "shared.cardsight", **fields}
    line = json.dumps(payload, default=str)
    if level == "warn":
        logging.warning(line)
    elif level == "info":
        logging.info(line)
    else:
        logging.debug(line)


# ─── Auth ───────────────────────────────────────────────────────────────────


def _api_key() -> str | None:
    return os.environ.get("CARDSIGHT_API_KEY")


def _headers() -> dict[str, str]:
    key = _api_key()
    if not key:
        return {}
    return {"X-API-Key": key, "Content-Type": "application/json"}


# ─── Retry wrapper ──────────────────────────────────────────────────────────


def _request_with_retry(
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> requests.Response:
    """Issue HTTP request with exponential backoff on 429 + 5xx.

    Raises CardsightTimeoutError on timeout.
    Raises CardsightError on non-recoverable 4xx (other than 404).
    Returns Response for 200/404 to let callers handle notFound.
    """
    headers = _headers()
    last_resp: requests.Response | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.request(
                method,
                url,
                headers=headers,
                params=params,
                json=json_body,
                timeout=DEFAULT_TIMEOUT,
            )
        except requests.Timeout as exc:
            _log_event("warn", "timeout", url=url, attempt=attempt, timeout_s=DEFAULT_TIMEOUT)
            raise CardsightTimeoutError(f"Cardsight timeout after {DEFAULT_TIMEOUT}s") from exc
        except requests.RequestException as exc:
            _log_event("warn", "request_exception", url=url, attempt=attempt, error=str(exc))
            raise CardsightError(f"Cardsight request failed: {exc}") from exc

        if resp.status_code == 429 or resp.status_code >= 500:
            last_resp = resp
            if attempt < MAX_RETRIES:
                backoff = 2 ** attempt
                _log_event(
                    "warn",
                    "retry",
                    url=url,
                    status=resp.status_code,
                    attempt=attempt + 1,
                    backoff_s=backoff,
                )
                time.sleep(backoff)
                continue
            break

        return resp

    # Exhausted retries.
    status = last_resp.status_code if last_resp is not None else "unknown"
    _log_event("warn", "retry_exhausted", url=url, status=status)
    raise CardsightError(f"Cardsight retries exhausted (last status={status})")


# ─── Exported functions ─────────────────────────────────────────────────────


def search_catalog(
    query: str,
    year: int | str | None = None,
    take: int = 20,
) -> list[dict[str, Any]]:
    """Search the Cardsight catalog for cards.

    Mirrors backend/src/services/compiq/cardsight.client.ts:searchCatalog.
    Always passes segment=baseball + type=card (non-baseball excluded at API).

    Returns a list of catalog result dicts with keys:
      id, name, number, releaseName, setName, year, player (optional).
    Returns [] when CARDSIGHT_API_KEY is missing, on HTTP errors, or on
    network failure -- callers fall back gracefully.
    """
    if not _api_key():
        _log_event("warn", "api_key_missing", endpoint="search_catalog", query=query)
        return []

    params: dict[str, Any] = {
        "q": query,
        "type": "card",
        "segment": "baseball",
        "take": str(take),
    }
    if year is not None:
        params["year"] = str(year)

    try:
        resp = _request_with_retry("GET", f"{BASE_URL}/catalog/search", params=params)
    except CardsightError as exc:
        _log_event("warn", "search_catalog_failed", query=query, error=str(exc))
        return []

    if not resp.ok:
        _log_event(
            "warn",
            "api_http_error",
            endpoint="search_catalog",
            query=query,
            status=resp.status_code,
        )
        return []

    try:
        body = resp.json()
    except ValueError:
        _log_event("warn", "json_parse_failed", endpoint="search_catalog", query=query)
        return []

    results = body.get("results") if isinstance(body, dict) else None
    return results if isinstance(results, list) else []


def get_pricing(
    card_id: str,
    parallel_id: str | None = None,
) -> dict[str, Any]:
    """Get pricing data (raw + graded sales) for a card.

    Mirrors backend/src/services/compiq/cardsight.client.ts:getPricing.
    Returns {notFound: True, raw: {records: []}, graded: [], meta: {...}}
    sentinel on 404 -- never raises for 404. Callers can branch on the
    notFound key.

    Response shape:
      {
        card: {...catalog result...},
        raw: {count: int, records: [{title, price, date, source, url}]},
        graded: [{company_name, grades: [{grade_value, count, records: [...]}]}],
        meta: {total_records: int, last_sale_date: str | None},
        notFound: bool  # only set when True
      }
    """
    if not _api_key():
        _log_event("warn", "api_key_missing", endpoint="get_pricing", card_id=card_id)
        return _empty_pricing(not_found=True)

    params: dict[str, Any] = {}
    if parallel_id:
        params["parallel_id"] = parallel_id

    try:
        resp = _request_with_retry(
            "GET",
            f"{BASE_URL}/pricing/{requests.utils.quote(card_id, safe='')}",
            params=params or None,
        )
    except CardsightError as exc:
        _log_event("warn", "get_pricing_failed", card_id=card_id, error=str(exc))
        return _empty_pricing()

    if resp.status_code == 404:
        return _empty_pricing(not_found=True)
    if not resp.ok:
        _log_event(
            "warn",
            "api_http_error",
            endpoint="get_pricing",
            card_id=card_id,
            status=resp.status_code,
        )
        return _empty_pricing()

    try:
        body = resp.json()
    except ValueError:
        _log_event("warn", "json_parse_failed", endpoint="get_pricing", card_id=card_id)
        return _empty_pricing()

    return {
        "card": body.get("card"),
        "raw": body.get("raw") or {"count": 0, "records": []},
        "graded": body.get("graded") if isinstance(body.get("graded"), list) else [],
        "meta": body.get("meta") or {"total_records": 0, "last_sale_date": None},
    }


def get_pricing_bulk(card_ids: list[str]) -> list[dict[str, Any]]:
    """Batch pricing for 1-100 cards.

    Returns a list of per-card pricing responses (same shape as
    get_pricing). Returns [] when CARDSIGHT_API_KEY is missing or on
    failure.

    Per CF-CARDSIGHT-PRICING-BULK backlog: unlocks bulk pricing for
    the Python side. Consumed by fn-nightly-comp-prefetch in Sub-2b.
    """
    if not _api_key():
        _log_event("warn", "api_key_missing", endpoint="get_pricing_bulk")
        return []
    if not card_ids:
        return []
    if len(card_ids) > 100:
        _log_event(
            "warn",
            "bulk_request_too_large",
            endpoint="get_pricing_bulk",
            count=len(card_ids),
        )
        return []

    try:
        resp = _request_with_retry(
            "POST",
            f"{BASE_URL}/pricing/bulk",
            json_body={"card_ids": card_ids},
        )
    except CardsightError as exc:
        _log_event("warn", "get_pricing_bulk_failed", count=len(card_ids), error=str(exc))
        return []

    if not resp.ok:
        _log_event(
            "warn",
            "api_http_error",
            endpoint="get_pricing_bulk",
            status=resp.status_code,
        )
        return []

    try:
        body = resp.json()
    except ValueError:
        _log_event("warn", "json_parse_failed", endpoint="get_pricing_bulk")
        return []

    results = body.get("results") if isinstance(body, dict) else None
    return results if isinstance(results, list) else []


def get_card_detail(card_id: str) -> dict[str, Any]:
    """Get card detail (parallels[], attributes[]) for a specific cardId.

    Returns a notFound sentinel on 404 -- never raises for 404.
    Consumed by fn-nightly-comp-prefetch in Sub-2b for variant/parallel
    resolution.

    Response shape:
      {
        id, name, number, releaseName, setName, year,
        parallels: [{id, name, numberedTo?}],
        attributes: [str],
        notFound: bool  # only set when True
      }
    """
    if not _api_key():
        _log_event("warn", "api_key_missing", endpoint="get_card_detail", card_id=card_id)
        return _empty_detail(card_id, not_found=True)

    try:
        resp = _request_with_retry(
            "GET",
            f"{BASE_URL}/catalog/cards/{requests.utils.quote(card_id, safe='')}",
        )
    except CardsightError as exc:
        _log_event("warn", "get_card_detail_failed", card_id=card_id, error=str(exc))
        return _empty_detail(card_id)

    if resp.status_code == 404:
        return _empty_detail(card_id, not_found=True)
    if not resp.ok:
        _log_event(
            "warn",
            "api_http_error",
            endpoint="get_card_detail",
            card_id=card_id,
            status=resp.status_code,
        )
        return _empty_detail(card_id)

    try:
        body = resp.json()
    except ValueError:
        _log_event("warn", "json_parse_failed", endpoint="get_card_detail", card_id=card_id)
        return _empty_detail(card_id)

    # Cardsight returns the year as `releaseYear` (string), NOT `year`.
    # Coerce to int so the interface contract holds. Same fix as the
    # canonical TS reference at cardsight.client.ts:326-329.
    raw_year = body.get("releaseYear") or body.get("year") or 0
    try:
        year = int(raw_year)
    except (TypeError, ValueError):
        year = 0

    return {
        "id": body.get("id") or card_id,
        "name": body.get("name") or "",
        "number": body.get("number") or "",
        "releaseName": body.get("releaseName") or "",
        "setName": body.get("setName") or "",
        "year": year,
        "parallels": body.get("parallels") if isinstance(body.get("parallels"), list) else [],
        "attributes": [
            a for a in (body.get("attributes") or []) if isinstance(a, str)
        ],
    }


# ─── Helpers ────────────────────────────────────────────────────────────────


def _empty_pricing(not_found: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "card": None,
        "raw": {"count": 0, "records": []},
        "graded": [],
        "meta": {"total_records": 0, "last_sale_date": None},
    }
    if not_found:
        payload["notFound"] = True
    return payload


def _empty_detail(card_id: str, not_found: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": card_id,
        "name": "",
        "number": "",
        "releaseName": "",
        "setName": "",
        "year": 0,
        "parallels": [],
        "attributes": [],
    }
    if not_found:
        payload["notFound"] = True
    return payload
