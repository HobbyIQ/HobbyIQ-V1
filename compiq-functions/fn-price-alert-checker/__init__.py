"""fn-price-alert-checker

Timer-triggered function (every 6 hours, "0 0 */6 * * *") that scans every
active price alert, asks the MCP server for the current predicted price for
each card, and triggers a push notification + DB update via the TS backend
whenever an alert's threshold is met.

Pipeline:
  1. GET /api/alerts/internal/all on the TS backend (auth: x-admin-key)
       -> [{ alertId, userId, cardId, playerName, targetPrice, direction, ... }]
  2. For each alert, GET <MCP>/predict/{cardId} (auth: x-functions-key)
       -> { predicted_price_72h, ... }
  3. If direction == "above" and current >= target, OR
        direction == "below" and current <= target:
        POST /api/alerts/internal/trigger { alertId, userId, currentPrice }
        on the TS backend, which sends the APNs push and marks triggered.

Env vars:
  HOBBYIQ_BACKEND_URL    e.g. https://hobbyiq3-...azurewebsites.net
  ALERTS_ADMIN_KEY       must match COMPIQ_ADMIN_KEY / ALERTS_ADMIN_KEY on TS
  COMPIQ_MCP_URL         e.g. https://compiq-mcp.azurewebsites.net
  COMPIQ_MCP_KEY         function key for MCP /predict (optional if open)

Failures of any single alert are logged and skipped — never raise from the
timer; a failed run must not block the next one.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

import azure.functions as func


def _http_json(method: str, url: str, body: dict | None, headers: dict, timeout: int = 30) -> dict | None:
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers = {**headers, "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8")
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                logging.warning("non-json response from %s: %s", url, payload[:200])
                return None
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            detail = ""
        logging.warning("HTTP %s on %s: %s", e.code, url, detail)
        return None
    except urllib.error.URLError as e:
        logging.warning("url error on %s: %s", url, e.reason)
        return None
    except Exception as exc:  # noqa: BLE001
        logging.warning("unexpected error on %s: %s", url, exc)
        return None


def _list_active_alerts(backend_base: str, admin_key: str) -> list[dict]:
    url = backend_base.rstrip("/") + "/api/alerts/internal/all"
    payload = _http_json("GET", url, None, {"x-admin-key": admin_key})
    if not payload or not payload.get("success"):
        return []
    return list(payload.get("alerts") or [])


def _current_price_for(alert: dict, mcp_base: str, mcp_key: str) -> float | None:
    """Return the latest predicted price for the alert's card, or None.

    The MCP server exposes `POST /api/compiq/predict` and accepts the same
    body shape we snapshotted at alert-creation time. We fall back to just
    `playerName` if no richer snapshot is available — the MCP layer requires
    at least playerName + year, so alerts without a year cannot be checked.
    """
    if not mcp_base:
        return None

    snap = alert.get("cardSnapshot") or {}
    player = str(snap.get("playerName") or alert.get("playerName") or "").strip()
    year = snap.get("year")
    if not player or not year:
        return None

    body: dict = {"playerName": player, "year": int(year)}
    if snap.get("setName"):    body["set"] = str(snap["setName"])
    if snap.get("cardNumber"): body["cardNumber"] = str(snap["cardNumber"])
    if snap.get("grade"):      body["grade"] = str(snap["grade"])
    if snap.get("variant"):    body["variant"] = str(snap["variant"])
    if snap.get("printRun") is not None:
        try:
            body["printRun"] = int(snap["printRun"])
        except (TypeError, ValueError):
            pass
    if isinstance(snap.get("isRookie"), bool):
        body["isRookie"] = snap["isRookie"]

    url = mcp_base.rstrip("/") + "/api/compiq/predict"
    headers: dict[str, str] = {}
    if mcp_key:
        headers["x-functions-key"] = mcp_key
    payload = _http_json("POST", url, body, headers, timeout=60)
    if not payload:
        return None

    # The MCP response wraps the prediction under `prediction`, but also
    # exposes `nextSaleEstimate` for legacy iOS callers — prefer the explicit
    # 72h prediction if present.
    pred = payload.get("prediction") or {}
    raw = (
        pred.get("predicted_price_72h")
        or pred.get("predicted_price_7d")
        or payload.get("nextSaleEstimate")
    )
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _should_trigger(direction: str, current: float, target: float) -> bool:
    if direction == "below":
        return current <= target
    # default = "above"
    return current >= target


def _post_trigger(backend_base: str, admin_key: str, alert: dict, current_price: float) -> dict | None:
    url = backend_base.rstrip("/") + "/api/alerts/internal/trigger"
    body = {
        "alertId": alert.get("alertId"),
        "userId": alert.get("userId"),
        "currentPrice": current_price,
    }
    return _http_json("POST", url, body, {"x-admin-key": admin_key}, timeout=30)


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-price-alert-checker timer past due")

    backend_base = os.environ.get("HOBBYIQ_BACKEND_URL", "").strip()
    admin_key = os.environ.get("ALERTS_ADMIN_KEY") or os.environ.get("COMPIQ_ADMIN_KEY") or ""
    mcp_base = os.environ.get("COMPIQ_MCP_URL", "").strip()
    mcp_key = os.environ.get("COMPIQ_MCP_KEY", "").strip()

    if not backend_base:
        logging.error("HOBBYIQ_BACKEND_URL not configured; skipping run")
        return
    if not admin_key:
        logging.error("ALERTS_ADMIN_KEY not configured; skipping run")
        return

    alerts = _list_active_alerts(backend_base, admin_key)
    logging.info("fn-price-alert-checker scanning %d active alerts", len(alerts))

    fired = 0
    skipped_no_price = 0
    for alert in alerts:
        try:
            target = float(alert.get("targetPrice") or 0)
            direction = str(alert.get("direction") or "above")
            if target <= 0:
                continue

            current = _current_price_for(alert, mcp_base, mcp_key)
            if current is None:
                skipped_no_price += 1
                continue

            if _should_trigger(direction, current, target):
                result = _post_trigger(backend_base, admin_key, alert, current)
                if result and result.get("success"):
                    fired += 1
                else:
                    logging.warning("trigger failed for %s: %s", alert.get("alertId"), result)
        except Exception as exc:  # noqa: BLE001 - never fail the timer
            logging.warning("alert %s evaluation error: %s", alert.get("alertId"), exc)

    logging.info(
        "fn-price-alert-checker done fired=%d skipped_no_price=%d total=%d",
        fired, skipped_no_price, len(alerts),
    )
