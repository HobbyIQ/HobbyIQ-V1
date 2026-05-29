"""CF-FN-COMPS-MIGRATION Sub-2a Path-2 (gamma) — Cardsight coverage-gap diagnostic.

Read-only probe. For each of 8 representative failed players from the
verification gate run, try ~6 distinct query patterns against
catalog.search to identify whether the 72% coverage gap is:

  Scenario 1: query-strategy-fixable (a pattern works consistently)
  Scenario 2: partial-fix-possible (works for some attribute clusters)
  Scenario 3: catalog data gap (no pattern works regardless)

Probe budget: 8 players x 6 patterns + ~4 sanity probes = ~52 calls.
Bounded by Drew's hard rule (~50-80 max).

Run via:
  cd compiq-functions
  CARDSIGHT_API_KEY=... python scripts/probe_cardsight_coverage_gap.py

Writes structured JSON to scripts/probe_cardsight_coverage_results.json
for inclusion in Section 11 of the design doc.
"""

from __future__ import annotations

import json
import os
import sys
import types
from datetime import datetime
from pathlib import Path

# Match shared/cardsight imports + stub azure for hermetic loading.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if "azure.storage.blob" not in sys.modules:
    stub = types.ModuleType("azure_stub")
    sys.modules["azure"] = stub
    sys.modules["azure.storage"] = stub
    sys.modules["azure.storage.blob"] = stub
    stub.BlobServiceClient = type("BlobServiceClient", (), {})

from shared.cardsight import search_catalog  # noqa: E402


# 8 representative players from the verification gate's coverage gap.
# Pulled from the previous run's 18 no_data/no_match cases — stratified
# across superstar (Soto, Betts, Guerrero Jr), star-rookie/recent
# (Witt Jr, Skenes, Holliday), and mid-tier (Carroll, Henderson).
PROBE_PLAYERS = [
    # (display_name, hint_year_for_query)
    ("Juan Soto", 2018),
    ("Mookie Betts", 2018),
    ("Vladimir Guerrero Jr", 2019),
    ("Bobby Witt Jr", 2022),
    ("Paul Skenes", 2024),
    ("Jackson Holliday", 2024),
    ("Corbin Carroll", 2023),
    ("Gunnar Henderson", 2023),
]

# Sanity-check players that DID return Cardsight data in the gate run.
# Probing these with the same patterns lets us see what a "working"
# response looks like vs the failure modes.
SANITY_PLAYERS = [
    ("Mike Trout", 2011),
    ("Shohei Ohtani", 2018),
    ("Aaron Judge", 2017),
    ("Ronald Acuna Jr", 2018),
]


def normalize_jr(name: str) -> str:
    """Strip 'Jr' / 'Jr.' / 'Sr' / 'Sr.' suffix."""
    parts = name.replace(".", "").split()
    parts = [p for p in parts if p.upper() not in ("JR", "SR")]
    return " ".join(parts)


def probe_player(player: str, year_hint: int) -> dict[str, object]:
    """Run ~6 query patterns against catalog.search and capture results."""
    patterns: list[tuple[str, dict[str, object]]] = [
        # 1. Current failing pattern
        (f"{player} baseball", {}),
        # 2. Bare name
        (player, {}),
        # 3. Bare name + year-as-text
        (f"{player} {year_hint}", {}),
        # 4. Bare name + year-as-typed-param
        (player, {"year": year_hint}),
        # 5. Normalized name (strip Jr/Sr/punct)
        (normalize_jr(player), {}),
        # 6. Normalized name + year-as-typed-param
        (normalize_jr(player), {"year": year_hint}),
    ]

    results: list[dict[str, object]] = []
    for query, opts in patterns:
        try:
            hits = search_catalog(query, **opts)
        except Exception as exc:  # noqa: BLE001
            results.append(
                {
                    "query": query,
                    "opts": opts,
                    "error": str(exc),
                    "hit_count": 0,
                }
            )
            continue

        top_hit_summary: dict[str, object] | None = None
        if hits:
            t = hits[0]
            top_hit_summary = {
                "id": t.get("id"),
                "name": t.get("name"),
                "player": t.get("player"),
                "year": t.get("year"),
                "releaseName": t.get("releaseName"),
                "setName": t.get("setName"),
                "number": t.get("number"),
            }

        # Heuristic: does top hit look like the player we asked for?
        # If top hit's `player` field or `name` field contains all surname
        # tokens from the query, consider it a match.
        usable = False
        if top_hit_summary:
            surname_tokens = [
                t for t in normalize_jr(player).lower().split() if len(t) > 2
            ]
            haystacks = [
                str(top_hit_summary.get("player") or "").lower(),
                str(top_hit_summary.get("name") or "").lower(),
            ]
            haystack = " ".join(haystacks)
            usable = all(tok in haystack for tok in surname_tokens)

        results.append(
            {
                "query": query,
                "opts": opts,
                "hit_count": len(hits),
                "top_hit": top_hit_summary,
                "top_hit_usable": usable,
            }
        )

    return {
        "player": player,
        "year_hint": year_hint,
        "probes": results,
    }


def summarize(per_player: list[dict[str, object]]) -> dict[str, object]:
    """Aggregate: for each query pattern, count how many players got a
    usable top hit."""
    pattern_labels = [
        "{player} baseball",
        "{player}",
        "{player} {year}",
        "{player} + year_param",
        "normalized({player})",
        "normalized({player}) + year_param",
    ]
    pattern_success: list[int] = [0] * len(pattern_labels)
    pattern_hits: list[int] = [0] * len(pattern_labels)
    for p in per_player:
        for i, probe in enumerate(p["probes"]):
            if probe.get("hit_count", 0) > 0:
                pattern_hits[i] += 1
            if probe.get("top_hit_usable"):
                pattern_success[i] += 1
    return {
        "pattern_summary": [
            {
                "label": label,
                "any_hit_players": pattern_hits[i],
                "usable_top_hit_players": pattern_success[i],
                "total_players": len(per_player),
            }
            for i, label in enumerate(pattern_labels)
        ]
    }


def print_player_summary(p: dict[str, object]) -> None:
    name = p["player"]
    print(f"\n--- {name} (year hint {p['year_hint']}) ---")
    for i, probe in enumerate(p["probes"]):
        q = probe["query"]
        opts = probe.get("opts") or {}
        opts_s = f" {opts}" if opts else ""
        cnt = probe.get("hit_count", 0)
        usable = probe.get("top_hit_usable")
        top = probe.get("top_hit") or {}
        marker = "OK" if usable else ("HIT" if cnt > 0 else "  ")
        top_label = ""
        if top:
            top_label = (
                f" -> {top.get('name')!r:<30} "
                f"({top.get('year')} {top.get('releaseName')!r}"
                f" #{top.get('number')})"
            )
        print(f"  [{marker:<3}] n={cnt:>3} q={q!r:<55}{opts_s:<20}{top_label}")


def main() -> int:
    if not os.environ.get("CARDSIGHT_API_KEY"):
        print("[SETUP ERROR] CARDSIGHT_API_KEY not set in env", file=sys.stderr)
        return 2

    print("=== Cardsight coverage-gap diagnostic ===")
    print(f"probe size: {len(PROBE_PLAYERS)} failed + {len(SANITY_PLAYERS)} sanity-check")
    print(f"patterns:   6 per player ({(len(PROBE_PLAYERS) + len(SANITY_PLAYERS)) * 6} calls total)")
    print(f"started at: {datetime.utcnow().isoformat()}Z")

    failed_results: list[dict[str, object]] = []
    print("\n### FAILED PLAYERS (from verification gate) ###")
    for player, year in PROBE_PLAYERS:
        result = probe_player(player, year)
        failed_results.append(result)
        print_player_summary(result)

    sanity_results: list[dict[str, object]] = []
    print("\n\n### SANITY-CHECK PLAYERS (matched in verification gate) ###")
    for player, year in SANITY_PLAYERS:
        result = probe_player(player, year)
        sanity_results.append(result)
        print_player_summary(result)

    print("\n\n=== Pattern-level summary (FAILED player set, n=8) ===")
    failed_summary = summarize(failed_results)
    for entry in failed_summary["pattern_summary"]:
        print(
            f"  {entry['label']:<40} "
            f"any_hit={entry['any_hit_players']}/{entry['total_players']}  "
            f"usable={entry['usable_top_hit_players']}/{entry['total_players']}"
        )

    print("\n=== Pattern-level summary (SANITY player set, n=4) ===")
    sanity_summary = summarize(sanity_results)
    for entry in sanity_summary["pattern_summary"]:
        print(
            f"  {entry['label']:<40} "
            f"any_hit={entry['any_hit_players']}/{entry['total_players']}  "
            f"usable={entry['usable_top_hit_players']}/{entry['total_players']}"
        )

    out_path = Path(__file__).resolve().parent / "probe_cardsight_coverage_results.json"
    out_path.write_text(
        json.dumps(
            {
                "run_at": datetime.utcnow().isoformat() + "Z",
                "failed_players": failed_results,
                "sanity_players": sanity_results,
                "failed_summary": failed_summary,
                "sanity_summary": sanity_summary,
            },
            indent=2,
        )
    )
    print(f"\nfull results written to: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
