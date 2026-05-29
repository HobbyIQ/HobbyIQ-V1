"""CF-FN-COMPS-MIGRATION Sub-2a Path-2 (gamma) — pricing follow-up probe.

The coverage-gap probe showed catalog.search returns hits 48/48 for
failed players. This script confirms whether the gap is in pricing.get
returning empty records on the top hit, AND whether picking a different
top-N hit (via pricing.meta.total_records) would close the gap.

Budget: ~16 pricing.get calls.
"""

from __future__ import annotations

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

from shared.cardsight import get_pricing, search_catalog  # noqa: E402


# Failed players + their hint years for the "{player} {year}" query.
CASES = [
    # (player, hint_year)
    ("Juan Soto", 2018),
    ("Mookie Betts", 2018),
    ("Vladimir Guerrero Jr", 2019),
    ("Bobby Witt Jr", 2022),
    ("Paul Skenes", 2024),
    ("Jackson Holliday", 2024),
    ("Corbin Carroll", 2023),
    ("Gunnar Henderson", 2023),
]


def label(top_hit: dict | None) -> str:
    if not top_hit:
        return "(none)"
    return f"{top_hit.get('year')} {top_hit.get('releaseName')} #{top_hit.get('number')}"


def main() -> int:
    if not os.environ.get("CARDSIGHT_API_KEY"):
        print("[SETUP] missing CARDSIGHT_API_KEY", file=sys.stderr)
        return 2

    print("=== Pricing follow-up: hit[0] vs best-of-top-5 ===\n")
    print(f"{'player':<25}  {'pattern':<30}  {'card':<50}  {'records':>7}")

    for player, year_hint in CASES:
        # Pattern A: current failing — '{player} baseball' top hit pricing
        hits_a = search_catalog(f"{player} baseball", take=5)
        top_a = hits_a[0] if hits_a else None
        records_a = 0
        if top_a and top_a.get("id"):
            pricing_a = get_pricing(str(top_a["id"]))
            records_a = (pricing_a.get("raw") or {}).get("count") or 0
        print(
            f"{player:<25}  {'A: {player} baseball':<30}  "
            f"{label(top_a):<50}  {records_a:>7}"
        )

        # Pattern B: '{player} {year}' top hit pricing
        hits_b = search_catalog(f"{player} {year_hint}", take=5)
        top_b = hits_b[0] if hits_b else None
        records_b = 0
        if top_b and top_b.get("id"):
            pricing_b = get_pricing(str(top_b["id"]))
            records_b = (pricing_b.get("raw") or {}).get("count") or 0
        print(
            f"{player:<25}  {'B: {player} {year}':<30}  "
            f"{label(top_b):<50}  {records_b:>7}"
        )

        # Pattern C: pick best-of-top-5 from baseball query
        best_records = 0
        best_label = "(none had pricing)"
        if hits_a:
            for h in hits_a:
                if not h.get("id"):
                    continue
                p = get_pricing(str(h["id"]))
                cnt = (p.get("raw") or {}).get("count") or 0
                if cnt > best_records:
                    best_records = cnt
                    best_label = label(h)
        print(
            f"{player:<25}  {'C: best-of-top-5 baseball':<30}  "
            f"{best_label:<50}  {best_records:>7}"
        )
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
