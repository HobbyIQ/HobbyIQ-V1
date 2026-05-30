"""Unit tests for fn-comps-momentum -- CF-COMPSMOMENTUM-GREENFIELD-CARDSIGHT.

Ported from 1fa9124's tests/test_fn_cardhedge_comps.py with the path
shift (`fn-comps-momentum` instead of `fn-cardhedge-comps`) and the
build_comps_payload import dropped (helper is now inlined in
fn-comps-momentum/function.py per D-build_comps_payload option (i)
from CF-CARDHEDGE-HARD-CUTOVER).

Mocks shared.cardsight at the module boundary so tests are hermetic.
Covers:
  - Best-of-top-5 selection picks the candidate with highest pricing volume
  - Year-fallback path triggers when all primary top-5 have zero records
  - "no_match" / "no_data" signal taxonomy preserved per signal aggregator
    contract (compsMomentum_rising / compsMomentum_falling /
    compsMomentum_no_data flags in fn-signal-aggregator)
  - selection_path metadata captured for telemetry
  - Inlined build_comps_payload edge cases (no_data for empty list,
    rising/falling threshold at 1.08/0.93)

Run via:
  cd compiq-functions && python -m unittest discover -s tests -p 'test_*.py'
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

# Stub azure modules so shared/__init__.py loads without azure-storage-blob
# installed locally. Same pattern as test_cardsight.py.
if "azure.storage.blob" not in sys.modules:
    stub = types.ModuleType("azure_stub")
    sys.modules["azure"] = stub
    sys.modules["azure.storage"] = stub
    sys.modules["azure.storage.blob"] = stub
    stub.BlobServiceClient = type("BlobServiceClient", (), {})

# Importing the function under test requires the fn-comps-momentum
# directory to be on sys.path -- it has a dash in the name so we add it
# explicitly rather than relying on package imports.
import os

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "fn-comps-momentum"),
)

import function as fn_module  # noqa: E402


# ─── Fixtures ───────────────────────────────────────────────────────────


def _make_hit(card_id: str, name: str = "Test Player", year: int = 2024,
              release_name: str = "Bowman") -> dict:
    return {
        "id": card_id,
        "name": name,
        "year": year,
        "releaseName": release_name,
        "setName": "Base Set",
        "number": "1",
    }


def _make_pricing(record_count: int) -> dict:
    """Build a pricing.get response with N raw records (enough volume to
    drive a meaningful build_comps_payload result when N >= 14)."""
    records = [
        {"title": "fixture", "price": 100 + i, "date": "2026-05-01", "source": "ebay", "url": None}
        for i in range(record_count)
    ]
    return {
        "card": {"id": "x", "name": "fixture"},
        "raw": {"count": record_count, "records": records},
        "graded": [],
        "meta": {"total_records": record_count, "last_sale_date": "2026-05-01"},
    }


def _empty_pricing() -> dict:
    return {
        "card": None,
        "raw": {"count": 0, "records": []},
        "graded": [],
        "meta": {"total_records": 0, "last_sale_date": None},
    }


# ─── Tests: query strategy ──────────────────────────────────────────────


class GetCompsSignalTests(unittest.TestCase):

    @patch("function.search_catalog")
    @patch("function.get_pricing")
    def test_best_of_top_5_picks_highest_volume_candidate(
        self, mock_pricing, mock_search
    ):
        """Top-1 has 0 records, top-3 has 50 records; top-3 must win
        and its cardId+name must be in the payload."""
        mock_search.return_value = [
            _make_hit("hit-1", "Top hit niche"),
            _make_hit("hit-2"),
            _make_hit("hit-3", "Winning canonical", year=2022, release_name="Bowman Chrome"),
            _make_hit("hit-4"),
            _make_hit("hit-5"),
        ]
        mock_pricing.side_effect = [
            _make_pricing(0),   # hit-1
            _make_pricing(10),  # hit-2
            _make_pricing(50),  # hit-3 (winner)
            _make_pricing(5),   # hit-4
            _make_pricing(0),   # hit-5
        ]

        result = fn_module.get_comps_signal("Test Player")

        self.assertEqual(result["cardsight_card_id"], "hit-3")
        self.assertEqual(result["cardsight_card_name"], "Winning canonical")
        self.assertEqual(result["cardsight_release_name"], "Bowman Chrome")
        self.assertEqual(result["selection_path"], "primary_best_of_top_5")
        self.assertGreater(result["comp_count"], 0)
        self.assertNotIn(result["signal"], ("no_data", "no_match", "no_id"))

    @patch("function.search_catalog")
    @patch("function.get_pricing")
    def test_year_fallback_when_all_top_5_zero(
        self, mock_pricing, mock_search
    ):
        """All 5 primary candidates have zero pricing; year fallback
        finds a candidate with real records and wins."""
        primary_hits = [_make_hit(f"primary-{i}") for i in range(5)]
        year_hits = [
            _make_hit("year-1"),
            _make_hit("year-2", "Year winner", year=2024, release_name="Bowman"),
            _make_hit("year-3"),
            _make_hit("year-4"),
            _make_hit("year-5"),
        ]
        mock_search.side_effect = [primary_hits, year_hits]
        mock_pricing.side_effect = [
            # Primary top-5: all zero
            _empty_pricing(), _empty_pricing(), _empty_pricing(),
            _empty_pricing(), _empty_pricing(),
            # Year top-5: hit-2 wins with 30 records
            _empty_pricing(),
            _make_pricing(30),
            _empty_pricing(),
            _empty_pricing(),
            _empty_pricing(),
        ]

        result = fn_module.get_comps_signal("Test Player")

        self.assertEqual(result["cardsight_card_id"], "year-2")
        self.assertEqual(result["cardsight_card_name"], "Year winner")
        self.assertEqual(result["selection_path"], "year_fallback_best_of_top_5")
        self.assertGreater(result["comp_count"], 0)

        primary_call_arg = mock_search.call_args_list[0].args[0]
        year_call_arg = mock_search.call_args_list[1].args[0]
        self.assertEqual(primary_call_arg, "Test Player baseball")
        self.assertTrue(year_call_arg.startswith("Test Player "))
        year_suffix = year_call_arg.split()[-1]
        self.assertTrue(year_suffix.isdigit() and len(year_suffix) == 4)

    @patch("function.search_catalog")
    @patch("function.get_pricing")
    def test_no_data_signal_when_both_passes_empty(
        self, mock_pricing, mock_search
    ):
        """Primary top-5 zero AND year fallback top-5 also zero ->
        signal taxonomy returns 'no_data' for signal aggregator's
        compsMomentum_no_data flag."""
        primary_hits = [_make_hit(f"primary-{i}") for i in range(5)]
        year_hits = [_make_hit(f"year-{i}") for i in range(5)]
        mock_search.side_effect = [primary_hits, year_hits]
        mock_pricing.side_effect = [_empty_pricing()] * 10  # 5 primary + 5 year

        result = fn_module.get_comps_signal("Test Player")

        self.assertEqual(result["signal"], "no_data")
        self.assertEqual(result["multiplier"], 1.0)
        self.assertEqual(result["comp_count"], 0)
        self.assertNotIn("cardsight_card_id", result)

    @patch("function.search_catalog")
    @patch("function.get_pricing")
    def test_no_match_when_primary_search_returns_no_hits(
        self, mock_pricing, mock_search
    ):
        """No primary catalog hits -> 'no_match' signal (consistent with
        the pre-alpha behavior; signal aggregator flag is
        compsMomentum_no_data)."""
        mock_search.return_value = []
        result = fn_module.get_comps_signal("Unknown Player")

        self.assertEqual(result["signal"], "no_match")
        self.assertEqual(result["multiplier"], 1.0)
        mock_pricing.assert_not_called()

    @patch("function.search_catalog")
    @patch("function.get_pricing")
    def test_only_first_hit_has_records_winner_is_first_hit(
        self, mock_pricing, mock_search
    ):
        """Edge case: top-1 has 30 records, all others zero. Top-1
        wins (no over-engineering)."""
        mock_search.return_value = [_make_hit(f"hit-{i}") for i in range(5)]
        mock_pricing.side_effect = [
            _make_pricing(30),   # hit-0 wins
            _make_pricing(0),
            _make_pricing(0),
            _make_pricing(0),
            _make_pricing(0),
        ]
        result = fn_module.get_comps_signal("Test Player")
        self.assertEqual(result["cardsight_card_id"], "hit-0")
        self.assertEqual(result["selection_path"], "primary_best_of_top_5")

    @patch("function.search_catalog")
    @patch("function.get_pricing")
    def test_year_fallback_skipped_when_primary_wins(
        self, mock_pricing, mock_search
    ):
        """If primary search produces a winning candidate, year fallback
        is NOT called (don't waste API budget)."""
        mock_search.return_value = [_make_hit("primary-winner")]
        mock_pricing.side_effect = [_make_pricing(40)]

        fn_module.get_comps_signal("Test Player")

        self.assertEqual(mock_search.call_count, 1)
        self.assertEqual(
            mock_search.call_args.args[0], "Test Player baseball"
        )

    @patch("function.search_catalog")
    @patch("function.get_pricing")
    def test_payload_preserves_signal_aggregator_contract(
        self, mock_pricing, mock_search
    ):
        """Output payload must include the fields that fn-signal-aggregator
        consumes: multiplier (clamped 0.85-1.20), signal (one of the
        documented values), comp_count."""
        mock_search.return_value = [_make_hit("hit-0")]
        mock_pricing.side_effect = [_make_pricing(20)]

        result = fn_module.get_comps_signal("Test Player")

        self.assertIn("multiplier", result)
        self.assertIn("signal", result)
        self.assertIn("comp_count", result)
        self.assertGreaterEqual(result["multiplier"], 0.85)
        self.assertLessEqual(result["multiplier"], 1.20)
        self.assertIn(
            result["signal"],
            {"rising", "stable", "falling", "no_data", "no_match", "no_id"},
        )
        self.assertIn("cardsight_card_id", result)
        self.assertIn("updated_at", result)
        self.assertIn("selection_path", result)


# ─── Tests: inlined build_comps_payload edge cases ──────────────────────


class InlinedBuildCompsPayloadTests(unittest.TestCase):
    """Direct tests for the inlined build_comps_payload helper. The
    helper used to live in shared/cardhedge.py (deleted at 10ad39d);
    now inlined into fn-comps-momentum/function.py per
    D-build_comps_payload option (i) lock. These tests exercise it
    directly rather than only via get_comps_signal so the no-data and
    threshold-edge behaviors are pinned independently."""

    def test_empty_sales_returns_no_data_with_neutral_multiplier(self):
        """Empty list (or all-no-price records) -> signal 'no_data' +
        multiplier 1.0 + comp_count 0. The signal aggregator reads
        this as compsMomentum_no_data flag (graceful degradation)."""
        result = fn_module.build_comps_payload("Test", [])
        self.assertEqual(result["signal"], "no_data")
        self.assertEqual(result["multiplier"], 1.0)
        self.assertEqual(result["comp_count"], 0)
        self.assertEqual(result["median_price"], 0.0)

    def test_records_without_price_field_treated_as_no_data(self):
        """Records that lack a `price` key (or have falsy price) are
        filtered out. If the result is empty, signal is no_data."""
        sales = [{"date": "2026-01-01"}, {"price": None}, {"price": 0}]
        result = fn_module.build_comps_payload("Test", sales)
        self.assertEqual(result["signal"], "no_data")
        self.assertEqual(result["comp_count"], 0)

    def test_rising_signal_when_recent_avg_exceeds_threshold(self):
        """recent_7_avg / prior_7_avg > 1.08 -> signal 'rising'.
        Construct prices so prior=100 and recent=120 -> ratio 1.20 ->
        clamped to 1.20 -> 'rising'."""
        # build_comps_payload reads `recent = prices[:7]` and
        # `prior = prices[7:14]`, so put the rising window FIRST.
        prices = [120] * 7 + [100] * 7
        sales = [{"price": p, "date": "2026-01-01"} for p in prices]
        result = fn_module.build_comps_payload("Test", sales)
        self.assertEqual(result["signal"], "rising")
        self.assertEqual(result["recent_avg"], 120.0)
        self.assertEqual(result["prior_avg"], 100.0)
        # Ratio is 1.20; multiplier clamped at 1.20.
        self.assertEqual(result["multiplier"], 1.20)

    def test_falling_signal_when_recent_avg_below_threshold(self):
        """recent_7_avg / prior_7_avg < 0.93 -> signal 'falling'.
        Put recent=85 and prior=100 -> ratio 0.85 -> clamped to 0.85 ->
        'falling'."""
        prices = [85] * 7 + [100] * 7
        sales = [{"price": p, "date": "2026-01-01"} for p in prices]
        result = fn_module.build_comps_payload("Test", sales)
        self.assertEqual(result["signal"], "falling")
        self.assertEqual(result["recent_avg"], 85.0)
        self.assertEqual(result["prior_avg"], 100.0)
        self.assertEqual(result["multiplier"], 0.85)


if __name__ == "__main__":
    unittest.main()
