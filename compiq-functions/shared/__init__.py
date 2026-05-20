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
