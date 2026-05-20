"""HTTP serve function — called by the MCP server before each prediction.

Returns the aggregated.json blob for the requested player, or 404 if the
pipeline hasn't produced one yet.
"""

from __future__ import annotations

import json
import os

import azure.functions as func
from azure.storage.blob import BlobServiceClient


def main(req: func.HttpRequest) -> func.HttpResponse:
    player_name = req.params.get("player")
    if not player_name:
        return func.HttpResponse(
            json.dumps({"error": "Missing player parameter"}),
            mimetype="application/json",
            status_code=400,
        )

    slug = player_name.lower().strip().replace(" ", "-")
    try:
        client = BlobServiceClient.from_connection_string(
            os.environ["AZURE_BLOB_CONNECTION_STRING"]
        )
        blob = client.get_blob_client(
            container="compiq-signals", blob=f"{slug}/aggregated.json"
        )
        data = json.loads(blob.download_blob().readall())
        return func.HttpResponse(
            json.dumps(data), mimetype="application/json"
        )
    except Exception:
        return func.HttpResponse(
            json.dumps({"error": "No signal data found", "player": player_name}),
            mimetype="application/json",
            status_code=404,
        )
