"""Shared helpers for CompIQ Azure Functions.

- Tracked-player list (env-driven, falls back to a small default)
- Blob upload/download wrappers using AZURE_BLOB_CONNECTION_STRING
- Player slug normalization (used in blob keys + cache lookups)
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from azure.storage.blob import BlobServiceClient

CONTAINER = "compiq-signals"

_DEFAULT_PLAYERS = [
    "Mike Trout",
    "Shohei Ohtani",
    "Aaron Judge",
    "Ronald Acuna Jr",
    "Juan Soto",
]


def tracked_players() -> list[str]:
    """List of player names this pipeline should refresh on each timer tick."""
    raw = os.environ.get("COMPIQ_TRACKED_PLAYERS", "").strip()
    if not raw:
        return list(_DEFAULT_PLAYERS)
    players = [p.strip() for p in raw.split(",") if p.strip()]
    return players or list(_DEFAULT_PLAYERS)


def player_slug(player_name: str) -> str:
    return player_name.lower().strip().replace(" ", "-")


def _client() -> BlobServiceClient:
    conn = os.environ["AZURE_BLOB_CONNECTION_STRING"]
    return BlobServiceClient.from_connection_string(conn)


def _ensure_container(client: BlobServiceClient) -> None:
    try:
        client.create_container(CONTAINER)
    except Exception:
        # Already exists or insufficient perms — ignore. Upload will surface real errors.
        pass


def save_signal(player_name: str, signal_type: str, data: dict[str, Any]) -> None:
    """Persist a signal payload to compiq-signals/<slug>/<signal_type>.json."""
    client = _client()
    _ensure_container(client)
    blob = client.get_blob_client(
        container=CONTAINER,
        blob=f"{player_slug(player_name)}/{signal_type}.json",
    )
    blob.upload_blob(json.dumps(data), overwrite=True)


def load_signal(player_name: str, signal_type: str) -> dict[str, Any]:
    """Load a signal payload, or return a neutral fallback when missing/unreadable."""
    try:
        client = _client()
        blob = client.get_blob_client(
            container=CONTAINER,
            blob=f"{player_slug(player_name)}/{signal_type}.json",
        )
        return json.loads(blob.download_blob().readall())
    except Exception as exc:  # noqa: BLE001 — partial signal is better than none
        logging.warning(
            "load_signal fallback for %s/%s: %s", player_name, signal_type, exc
        )
        return {"multiplier": 1.0, "signal": "unavailable"}


def load_blob_json(blob_path: str, default: Any = None) -> Any:
    """Load arbitrary JSON blob from compiq-signals/<blob_path>.

    Returns `default` when the blob is missing or unreadable. Used for
    auxiliary state like BIN price rolling history (H5).
    """
    try:
        client = _client()
        blob = client.get_blob_client(container=CONTAINER, blob=blob_path)
        return json.loads(blob.download_blob().readall())
    except Exception:
        return default


def save_blob_json(blob_path: str, data: Any) -> None:
    """Persist arbitrary JSON to compiq-signals/<blob_path>."""
    client = _client()
    _ensure_container(client)
    blob = client.get_blob_client(container=CONTAINER, blob=blob_path)
    blob.upload_blob(json.dumps(data), overwrite=True)


# ─── CF-PLAYER-IN-SET-HISTORY (2026-06-09) — per-(player, set) helpers ──────
#
# Path layout:
#   compiq-signals/playerInSet/<player-slug>/<set-slug>.json
#       Current-night snapshot (overwrite). Same shape as
#       compsMomentum.json + `set`, `year`, `cards_scanned`, `computed_at`.
#
#   compiq-signals/playerInSet/<player-slug>/<set-slug>.history.json
#       Append-only list of nightly entries. The accrual IS the moat.
#       Each entry is a thin slice — { computed_at, multiplier, signal,
#       comp_count, median_price }. Full snapshot lives at the .json
#       above; history keeps just what's needed to chart the trend.


def set_slug(set_name: str) -> str:
    """Normalize a set / release name into a blob-path-safe slug."""
    s = (set_name or "").lower().strip()
    # Replace anything non-alnum with a single dash; collapse repeats.
    out: list[str] = []
    prev_dash = False
    for ch in s:
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        else:
            if not prev_dash:
                out.append("-")
                prev_dash = True
    return "".join(out).strip("-") or "unknown"


def save_signal_with_set(
    player_name: str, signal_type: str, set_slug_str: str, data: dict[str, Any]
) -> None:
    """Persist a per-(player, set) signal payload to
    compiq-signals/<signal_type>/<player-slug>/<set-slug>.json (overwrite).
    """
    client = _client()
    _ensure_container(client)
    path = f"{signal_type}/{player_slug(player_name)}/{set_slug_str}.json"
    blob = client.get_blob_client(container=CONTAINER, blob=path)
    blob.upload_blob(json.dumps(data), overwrite=True)


def save_signal_history(
    player_name: str, signal_type: str, set_slug_str: str, entry: dict[str, Any]
) -> None:
    """Append a single history entry to
    compiq-signals/<signal_type>/<player-slug>/<set-slug>.history.json.

    Reads existing list (if any), appends, writes back with
    overwrite=True. NEVER overwrites prior entries — the whole point is
    accrual. Missing or unreadable history is treated as empty (the
    file gets created on the first successful append).
    """
    client = _client()
    _ensure_container(client)
    path = f"{signal_type}/{player_slug(player_name)}/{set_slug_str}.history.json"
    blob = client.get_blob_client(container=CONTAINER, blob=path)

    existing: list[dict[str, Any]] = []
    try:
        raw = blob.download_blob().readall()
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            existing = parsed
    except Exception:
        # Missing blob or parse error → start fresh. The write below
        # creates / overwrites with the appended list.
        existing = []

    existing.append(entry)
    blob.upload_blob(json.dumps(existing), overwrite=True)


def run_for_all_players(
    signal_type: str,
    fetch_fn,
    *,
    extra_log: str | None = None,
) -> None:
    """Run a signal collector across all tracked players, never blowing up the
    whole timer when one player fails — that single player just falls back to
    the neutral multiplier on read."""
    players = tracked_players()
    logging.info(
        "[%s] refreshing %d player(s)%s",
        signal_type,
        len(players),
        f" — {extra_log}" if extra_log else "",
    )
    for name in players:
        try:
            payload = fetch_fn(name)
            save_signal(name, signal_type, payload)
            logging.info(
                "[%s] %s -> %.3fx (%s)",
                signal_type,
                name,
                float(payload.get("multiplier", 1.0)),
                payload.get("signal") or payload.get("trend") or payload.get("sentiment") or "ok",
            )
        except Exception as exc:  # noqa: BLE001
            logging.exception("[%s] %s failed: %s", signal_type, name, exc)
