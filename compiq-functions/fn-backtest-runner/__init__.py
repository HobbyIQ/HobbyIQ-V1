"""Phase C nightly backtest runner.

Calls the MCP server's admin backtest endpoint once per day so that any
prediction older than 7 days that hasn't been scored yet gets scored against
the actual sale data that has since landed in the comp cache.

Schedule: 03:30 UTC daily (after fn-cardhedge-comps and fn-nightly-comp-prefetch
have refreshed the comp cache for the day).

Required app settings:
    COMPIQ_MCP_URL       e.g. https://compiq-mcp.azurewebsites.net
    COMPIQ_ADMIN_KEY     same value set on the MCP server

The runner is fire-and-forget. Errors are logged but do NOT raise — a backtest
miss must never page anyone.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

import azure.functions as func


def _post_run(min_age_days: int = 7, limit: int = 200) -> dict:
    base = (os.environ.get("COMPIQ_MCP_URL") or "").rstrip("/")
    key = os.environ.get("COMPIQ_ADMIN_KEY") or ""
    if not base:
        return {"ok": False, "reason": "COMPIQ_MCP_URL not configured"}
    if not key:
        return {"ok": False, "reason": "COMPIQ_ADMIN_KEY not configured"}

    url = f"{base}/api/compiq/admin/backtest/run"
    body = json.dumps({"minAgeDays": min_age_days, "limit": limit}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-admin-key": key,
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read().decode("utf-8")
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                return {"ok": True, "raw": payload[:500]}
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            detail = ""
        return {"ok": False, "status": e.code, "reason": detail or str(e)}
    except urllib.error.URLError as e:
        return {"ok": False, "reason": f"url_error: {e.reason}"}
    except Exception as e:  # noqa: BLE001 - never fail the timer
        return {"ok": False, "reason": f"unexpected: {e}"}


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-backtest-runner timer past due")

    result = _post_run(min_age_days=7, limit=200)
    if result.get("ok"):
        scored = result.get("scored")
        logging.info("fn-backtest-runner ok scored=%s", scored)
    else:
        logging.warning("fn-backtest-runner failed: %s", result.get("reason"))
