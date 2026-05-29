"""CF-FN-COMPS-MIGRATION Sub-2a -- empirical verification gate per D2 + D8.

Compares OLD CardHedge-sourced compsMomentum signal vs NEW Cardsight-sourced
signal (now via the alpha query strategy: best-of-top-5 + year fallback).

Dual gate per Drew's alpha kickoff:
  1. Median absolute deviation <= 10% across players with meaningful data
  2. Coverage: >= 15 of 18 previously-failed players resolve to a
     non-no-data signal

Both must pass for cutover. The dual gate catches the
"both-vendors-default-to-neutral" pattern that the original gate methodology
missed (Phase gamma diagnostic, design doc Section 11).

Run via:
  cd compiq-functions
  CARD_HEDGE_API_KEY=... CARDSIGHT_API_KEY=... python scripts/verify_compsmomentum_migration.py

Exit codes:
  0 = PASS (both gates pass)
  1 = FAIL (one or both gates fail)
  2 = SETUP ERROR (missing API key, etc.)
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import types
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if "azure.storage.blob" not in sys.modules:
    stub = types.ModuleType("azure_stub")
    sys.modules["azure"] = stub
    sys.modules["azure.storage"] = stub
    sys.modules["azure.storage.blob"] = stub
    stub.BlobServiceClient = type("BlobServiceClient", (), {})

# Import after stub. The NEW Cardsight path calls the migrated
# get_comps_signal which encapsulates the alpha query strategy.
sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "fn-cardhedge-comps"),
)
import function as cardsight_fn  # noqa: E402

from shared.cardhedge import build_comps_payload, get_card_sales, search_cards  # noqa: E402


# Per Phase 1 design Section 5.2 + Phase gamma probe sample expansion.
SAMPLE_PLAYERS: list[str] = [
    # Superstars (sanity check -- all 4 matched in original gate)
    "Mike Trout",
    "Shohei Ohtani",
    "Aaron Judge",
    "Ronald Acuna Jr",
    # Borderline-matched in original gate (Bryce Harper matched, Bichette matched)
    "Bryce Harper",
    "Bo Bichette",
    # Previously failed in original gate (18 of 25 sampled players)
    "Juan Soto",
    "Mookie Betts",
    "Vladimir Guerrero Jr",
    "Wander Franco",
    "Bobby Witt Jr",
    "Adley Rutschman",
    "Corbin Carroll",
    "Gunnar Henderson",
    "Paul Skenes",
    "Elly De La Cruz",
    "Jackson Holliday",
    "Jackson Chourio",
    "Roman Anthony",
    "Andrew Painter",
    "Cooper Bonemer",
    "Junior Caminero",
    "James Wood",
    "Jacob Misiorowski",
    # Julio Rodriguez had n=1 in original (marginal, counted as failed)
    "Julio Rodriguez",
]

# Players that returned no_data / no_match / marginal (n < 5) in the
# original gate's Cardsight path. Coverage gate target: >= 15/18 of these
# must now return non-no-data with the alpha query strategy.
PREVIOUSLY_FAILED: set[str] = {
    "Juan Soto",
    "Mookie Betts",
    "Vladimir Guerrero Jr",
    "Wander Franco",
    "Bobby Witt Jr",
    "Adley Rutschman",
    "Corbin Carroll",
    "Gunnar Henderson",
    "Paul Skenes",
    "Elly De La Cruz",
    "Jackson Holliday",
    "Jackson Chourio",
    "Roman Anthony",
    "Andrew Painter",
    "Cooper Bonemer",
    "Junior Caminero",
    "James Wood",
    "Jacob Misiorowski",
    "Julio Rodriguez",
}

# D8 lock: +/-10% for fn-cardhedge-comps.
DEVIATION_THRESHOLD = 0.10
# Drew's alpha kickoff: >= 15 / 18.
COVERAGE_THRESHOLD = 15
# Total previously-failed in the sample (used for the X/18 display).
COVERAGE_DENOMINATOR = 18


# ─── Path implementations ──────────────────────────────────────────────


def compsmomentum_via_cardhedge(player_name: str) -> dict[str, object]:
    """Old path: search_cards + get_card_sales + build_comps_payload."""
    hits = search_cards(f"{player_name} baseball", limit=5)
    if not hits:
        return {"player": player_name, "multiplier": 1.0, "signal": "no_match", "comp_count": 0}
    card_id = str(hits[0].get("id") or hits[0].get("card_id") or "")
    if not card_id:
        return {"player": player_name, "multiplier": 1.0, "signal": "no_id", "comp_count": 0}
    sales = get_card_sales(card_id, limit=25)
    return build_comps_payload(player_name, sales)


def compsmomentum_via_cardsight(player_name: str) -> dict[str, object]:
    """New path: the migrated get_comps_signal with alpha query strategy
    (best-of-top-5 + year fallback)."""
    return cardsight_fn.get_comps_signal(player_name)


# ─── Helpers ───────────────────────────────────────────────────────────


def is_no_data(signal: object) -> bool:
    """True when signal is one of the documented no-coverage values."""
    return str(signal) in {"no_data", "no_match", "no_id"}


def deviation(old_mult: float, new_mult: float) -> float:
    if old_mult <= 0:
        return 0.0 if new_mult == old_mult else 1.0
    return abs(new_mult - old_mult) / old_mult


def main() -> int:
    if not os.environ.get("CARD_HEDGE_API_KEY"):
        print("[SETUP] CARD_HEDGE_API_KEY not set", file=sys.stderr)
        return 2
    if not os.environ.get("CARDSIGHT_API_KEY"):
        print("[SETUP] CARDSIGHT_API_KEY not set", file=sys.stderr)
        return 2

    print("=== CF-FN-COMPS-MIGRATION verification (dual gate) ===")
    print(f"sample size:           {len(SAMPLE_PLAYERS)}")
    print(f"deviation threshold:   +/-{int(DEVIATION_THRESHOLD * 100)}%")
    print(f"coverage threshold:    >= {COVERAGE_THRESHOLD} / {COVERAGE_DENOMINATOR}")
    print(f"new path:              alpha query strategy (best-of-top-5 + year fallback)")
    print(f"started at:            {datetime.utcnow().isoformat()}Z")
    print()

    rows: list[dict[str, object]] = []
    deviations_for_meaningful: list[float] = []  # only players where both paths have data
    coverage_pass_count = 0

    for player in SAMPLE_PLAYERS:
        ch = compsmomentum_via_cardhedge(player)
        cs = compsmomentum_via_cardsight(player)

        ch_mult = float(ch.get("multiplier", 1.0))
        cs_mult = float(cs.get("multiplier", 1.0))
        ch_count = int(ch.get("comp_count", 0))
        cs_count = int(cs.get("comp_count", 0))
        cs_signal = str(cs.get("signal", "unknown"))
        cs_path = str(cs.get("selection_path", "n/a"))

        dev = deviation(ch_mult, cs_mult)
        if not is_no_data(cs_signal) and not is_no_data(ch.get("signal")):
            deviations_for_meaningful.append(dev)

        previously_failed = player in PREVIOUSLY_FAILED
        coverage_pass = previously_failed and not is_no_data(cs_signal) and cs_count >= 5
        if coverage_pass:
            coverage_pass_count += 1

        row = {
            "player": player,
            "previously_failed": previously_failed,
            "ch_multiplier": ch_mult,
            "ch_signal": ch.get("signal"),
            "ch_comp_count": ch_count,
            "cs_multiplier": cs_mult,
            "cs_signal": cs_signal,
            "cs_comp_count": cs_count,
            "cs_selection_path": cs_path,
            "deviation": round(dev, 4),
            "coverage_recovered": coverage_pass,
        }
        rows.append(row)

        prev_mark = "*" if previously_failed else " "
        cov_mark = "REC" if coverage_pass else ("   " if not previously_failed else "---")
        dev_mark = "OK " if dev <= DEVIATION_THRESHOLD else "OUT"
        print(
            f"[{dev_mark}][{cov_mark}]{prev_mark} {player:<25} "
            f"ch={ch_mult:.3f}({ch.get('signal'):<8} n={ch_count:>3})  "
            f"cs={cs_mult:.3f}({cs_signal:<8} n={cs_count:>3} {cs_path[:24]})  "
            f"dev={dev * 100:>6.2f}%"
        )

    print()
    print("=== Aggregate ===")
    if deviations_for_meaningful:
        median_dev = statistics.median(deviations_for_meaningful)
        mean_dev = statistics.mean(deviations_for_meaningful)
        p90_dev = (
            statistics.quantiles(deviations_for_meaningful, n=10)[8]
            if len(deviations_for_meaningful) >= 10
            else max(deviations_for_meaningful)
        )
    else:
        median_dev = mean_dev = p90_dev = 0.0

    print(f"meaningful-data players: {len(deviations_for_meaningful)} / {len(SAMPLE_PLAYERS)}")
    print(f"median deviation:        {median_dev * 100:.2f}%")
    print(f"mean deviation:          {mean_dev * 100:.2f}%")
    print(f"p90 deviation:           {p90_dev * 100:.2f}%")
    print()
    print(f"=== Coverage gate ===")
    print(f"previously-failed recovered: {coverage_pass_count} / {COVERAGE_DENOMINATOR}")
    print()

    deviation_pass = median_dev <= DEVIATION_THRESHOLD
    coverage_pass = coverage_pass_count >= COVERAGE_THRESHOLD

    print(f"=== Dual gate verdict ===")
    print(f"  deviation gate:  {'PASS' if deviation_pass else 'FAIL'} ({median_dev * 100:.2f}% vs <= {DEVIATION_THRESHOLD * 100:.0f}%)")
    print(f"  coverage gate:   {'PASS' if coverage_pass else 'FAIL'} ({coverage_pass_count} vs >= {COVERAGE_THRESHOLD})")
    verdict = "PASS" if (deviation_pass and coverage_pass) else "FAIL"
    print(f"  OVERALL:         {verdict}")

    out_path = Path(__file__).resolve().parent / "verify_compsmomentum_results.json"
    out_path.write_text(
        json.dumps(
            {
                "verdict": verdict,
                "deviation_pass": deviation_pass,
                "coverage_pass": coverage_pass,
                "median_deviation": median_dev,
                "mean_deviation": mean_dev,
                "p90_deviation": p90_dev,
                "deviation_threshold": DEVIATION_THRESHOLD,
                "coverage_threshold": COVERAGE_THRESHOLD,
                "coverage_denominator": COVERAGE_DENOMINATOR,
                "coverage_recovered": coverage_pass_count,
                "meaningful_data_players": len(deviations_for_meaningful),
                "sample_size": len(SAMPLE_PLAYERS),
                "rows": rows,
                "run_at": datetime.utcnow().isoformat() + "Z",
            },
            indent=2,
        )
    )
    print(f"\nfull results: {out_path}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
