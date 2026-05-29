"""Quick empirical probe of pricing.bulk — verifies endpoint + response shape
before committing to (alpha) implementation that depends on it.
"""
from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if "azure.storage.blob" not in sys.modules:
    stub = types.ModuleType("azure_stub")
    sys.modules["azure"] = stub
    sys.modules["azure.storage"] = stub
    sys.modules["azure.storage.blob"] = stub
    stub.BlobServiceClient = type("BlobServiceClient", (), {})

import requests  # noqa: E402

from shared.cardsight import BASE_URL, _headers, get_pricing, search_catalog  # noqa: E402

if not os.environ.get("CARDSIGHT_API_KEY"):
    print("missing CARDSIGHT_API_KEY", file=sys.stderr)
    sys.exit(2)

# Get 5 Juan Soto catalog hits.
hits = search_catalog("Juan Soto baseball", take=5)
print(f"Got {len(hits)} hits")
card_ids = [str(h.get("id")) for h in hits if h.get("id")][:5]
print(f"Card IDs to bulk-price: {card_ids}")
print()

# Raw probe of /pricing/bulk to see actual API behavior.
print("--- Raw POST /pricing/bulk ---")
try:
    resp = requests.post(
        f"{BASE_URL}/pricing/bulk",
        headers=_headers(),
        json={"card_ids": card_ids},
        timeout=20,
    )
    print(f"status: {resp.status_code}")
    print(f"response shape (first 500 chars):")
    print(resp.text[:500])
except Exception as exc:  # noqa: BLE001
    print(f"error: {exc}")

print()
print("--- Compare: per-card pricing.get x 5 (control) ---")
for cid in card_ids:
    p = get_pricing(cid)
    raw_count = (p.get("raw") or {}).get("count") or 0
    found = "yes" if not p.get("notFound") else "404"
    print(f"  {cid:<40} raw.count={raw_count:<5} found={found}")
