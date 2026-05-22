"""fn-player-score-refresh
=========================
Nightly batch job (04:00 UTC) that refreshes PlayerIQ scores for every
tracked player by POSTing to the TS backend's internal refresh endpoint.

Backend route:
    POST {COMPIQ_BACKEND_URL}/api/playeriq/refresh
    Header: x-admin-key: {BACKEND_ADMIN_KEY}
    Body:   {"players": ["Mike Trout", "Shohei Ohtani", ...]}

The backend handles all Cosmos writes — this function just kicks the
work off in batches so a single big request doesn't time out.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

import azure.functions as func

from shared import tracked_players

BATCH_SIZE = 10
REQUEST_TIMEOUT = 60.0  # seconds per batch — backend handles MLB Stats + Cosmos


def _post_batch(url: str, admin_key: str, players: list[str]) -> dict:
    body = json.dumps({"players": players}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-admin-key": admin_key,
        },
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return json.loads(resp.read())


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-player-score-refresh timer past due")

    backend_url = os.environ.get("COMPIQ_BACKEND_URL", "").rstrip("/")
    admin_key = os.environ.get("BACKEND_ADMIN_KEY", "").strip()

    if not backend_url or not admin_key:
        logging.error(
            "fn-player-score-refresh missing COMPIQ_BACKEND_URL or BACKEND_ADMIN_KEY"
        )
        return

    refresh_url = f"{backend_url}/api/playeriq/refresh"
    players = tracked_players()
    logging.info(
        "[player-score-refresh] refreshing %d player(s) via %s",
        len(players),
        refresh_url,
    )

    total_ok = 0
    total_failed = 0
    for i in range(0, len(players), BATCH_SIZE):
        batch = players[i : i + BATCH_SIZE]
        try:
            result = _post_batch(refresh_url, admin_key, batch)
            ok = int(result.get("refreshed", 0))
            failed = int(result.get("failed", 0))
            total_ok += ok
            total_failed += failed
            logging.info(
                "[player-score-refresh] batch %d/%d -> %d ok, %d failed",
                (i // BATCH_SIZE) + 1,
                (len(players) + BATCH_SIZE - 1) // BATCH_SIZE,
                ok,
                failed,
            )
            for entry in result.get("results", []):
                if not entry.get("ok"):
                    logging.warning(
                        "[player-score-refresh] %s failed: %s",
                        entry.get("player"),
                        entry.get("error"),
                    )
        except urllib.error.HTTPError as exc:
            logging.exception(
                "[player-score-refresh] HTTP %s on batch %s: %s",
                exc.code,
                batch,
                exc.read()[:500] if hasattr(exc, "read") else "",
            )
            total_failed += len(batch)
        except Exception as exc:  # noqa: BLE001 — never let one batch kill the job
            logging.exception("[player-score-refresh] batch %s failed: %s", batch, exc)
            total_failed += len(batch)

    logging.info(
        "[player-score-refresh] done — %d refreshed, %d failed (of %d total)",
        total_ok,
        total_failed,
        len(players),
    )
