"""Unit tests for shared/cardsight.py — CF-FN-COMPS-MIGRATION Sub-2a.

Uses stdlib unittest + unittest.mock (no new dependencies). Mocks
the `requests.request` boundary so tests run hermetic against
api.cardsight.ai.

Run via:
  cd compiq-functions && python -m unittest discover -s tests -p 'test_*.py'
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

import requests

# shared/__init__.py imports azure.storage.blob at module load, which is a
# deploy dependency that isn't installed for local test runs. Stub it before
# importing the cardsight module so tests are hermetic.
if "azure.storage.blob" not in sys.modules:
    azure_stub = MagicMock()
    sys.modules["azure"] = azure_stub
    sys.modules["azure.storage"] = azure_stub
    sys.modules["azure.storage.blob"] = azure_stub

from shared import cardsight  # noqa: E402  -- import after azure stub above


def _make_response(status_code: int, json_body: object | None = None) -> MagicMock:
    """Build a requests.Response-like mock with status_code + .json()."""
    resp = MagicMock(spec=requests.Response)
    resp.status_code = status_code
    resp.ok = 200 <= status_code < 400
    if json_body is None:
        resp.json.side_effect = ValueError("no json body")
    else:
        resp.json.return_value = json_body
    return resp


class CardsightAuthMissingTests(unittest.TestCase):
    """When CARDSIGHT_API_KEY env var is missing, every function returns a
    safe fallback without making any HTTP call. Mirrors the
    shared/cardhedge.py `[]`-on-failure convention."""

    def setUp(self) -> None:
        self._env_backup = os.environ.pop("CARDSIGHT_API_KEY", None)

    def tearDown(self) -> None:
        if self._env_backup is not None:
            os.environ["CARDSIGHT_API_KEY"] = self._env_backup

    @patch("shared.cardsight.requests.request")
    def test_search_catalog_returns_empty(self, mock_req: MagicMock) -> None:
        result = cardsight.search_catalog("Mike Trout")
        self.assertEqual(result, [])
        mock_req.assert_not_called()

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_returns_notfound_sentinel(self, mock_req: MagicMock) -> None:
        result = cardsight.get_pricing("some-uuid")
        self.assertTrue(result.get("notFound"))
        self.assertEqual(result["raw"], {"count": 0, "records": []})
        self.assertEqual(result["graded"], [])
        mock_req.assert_not_called()

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_bulk_returns_empty(self, mock_req: MagicMock) -> None:
        result = cardsight.get_pricing_bulk(["a", "b"])
        self.assertEqual(result, [])
        mock_req.assert_not_called()

    @patch("shared.cardsight.requests.request")
    def test_get_card_detail_returns_notfound(self, mock_req: MagicMock) -> None:
        result = cardsight.get_card_detail("some-uuid")
        self.assertTrue(result.get("notFound"))
        self.assertEqual(result["id"], "some-uuid")
        mock_req.assert_not_called()


class CardsightWithKeyTests(unittest.TestCase):
    """Auth env var is set; tests assert on the request shape Cardsight
    sees and on response parsing."""

    def setUp(self) -> None:
        os.environ["CARDSIGHT_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        os.environ.pop("CARDSIGHT_API_KEY", None)

    # ── search_catalog ──────────────────────────────────────────────────

    @patch("shared.cardsight.requests.request")
    def test_search_catalog_happy_path(self, mock_req: MagicMock) -> None:
        body = {
            "results": [
                {
                    "id": "abc-1",
                    "name": "Mike Trout",
                    "number": "US175",
                    "releaseName": "Topps Update",
                    "setName": "Base Set",
                    "year": 2011,
                    "player": "Mike Trout",
                }
            ]
        }
        mock_req.return_value = _make_response(200, body)
        result = cardsight.search_catalog("Mike Trout", year=2011, take=5)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "abc-1")
        call = mock_req.call_args
        self.assertEqual(call.args[0], "GET")
        self.assertIn("/catalog/search", call.args[1])
        params = call.kwargs["params"]
        self.assertEqual(params["q"], "Mike Trout")
        self.assertEqual(params["segment"], "baseball")
        self.assertEqual(params["type"], "card")
        self.assertEqual(params["take"], "5")
        self.assertEqual(params["year"], "2011")
        # Auth header propagated.
        self.assertEqual(call.kwargs["headers"]["X-API-Key"], "test-key")

    @patch("shared.cardsight.requests.request")
    def test_search_catalog_no_results_key_returns_empty(
        self, mock_req: MagicMock
    ) -> None:
        mock_req.return_value = _make_response(200, {"meta": "no results key"})
        self.assertEqual(cardsight.search_catalog("foo"), [])

    @patch("shared.cardsight.requests.request")
    def test_search_catalog_404_returns_empty(self, mock_req: MagicMock) -> None:
        mock_req.return_value = _make_response(404, {"error": "not found"})
        self.assertEqual(cardsight.search_catalog("foo"), [])

    @patch("shared.cardsight.requests.request")
    def test_search_catalog_500_retries_then_returns_empty(
        self, mock_req: MagicMock
    ) -> None:
        mock_req.return_value = _make_response(500, {"error": "internal"})
        with patch("shared.cardsight.time.sleep") as mock_sleep:
            result = cardsight.search_catalog("foo")
        self.assertEqual(result, [])
        # MAX_RETRIES = 3 -> 4 total attempts (initial + 3 retries).
        self.assertEqual(mock_req.call_count, 4)
        # Backoff: 1s, 2s, 4s.
        self.assertEqual(
            [call.args[0] for call in mock_sleep.call_args_list],
            [1, 2, 4],
        )

    @patch("shared.cardsight.requests.request")
    def test_search_catalog_timeout_returns_empty(self, mock_req: MagicMock) -> None:
        mock_req.side_effect = requests.Timeout("connection timed out")
        result = cardsight.search_catalog("foo")
        self.assertEqual(result, [])

    # ── get_pricing ─────────────────────────────────────────────────────

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_happy_path(self, mock_req: MagicMock) -> None:
        body = {
            "card": {"id": "abc-1", "name": "Mike Trout"},
            "raw": {
                "count": 14,
                "records": [
                    {
                        "title": "2011 Topps Update Mike Trout US175",
                        "price": 349.99,
                        "date": "2026-05-24T00:00:00Z",
                        "source": "ebay",
                        "url": None,
                    }
                ],
            },
            "graded": [
                {
                    "company_name": "PSA",
                    "grades": [{"grade_value": "10", "count": 0, "records": []}],
                }
            ],
            "meta": {"total_records": 14, "last_sale_date": "2026-05-24"},
        }
        mock_req.return_value = _make_response(200, body)
        result = cardsight.get_pricing("abc-1")

        self.assertEqual(result["card"]["id"], "abc-1")
        self.assertEqual(result["raw"]["count"], 14)
        self.assertEqual(len(result["raw"]["records"]), 1)
        self.assertEqual(result["graded"][0]["company_name"], "PSA")
        self.assertNotIn("notFound", result)

        call = mock_req.call_args
        self.assertEqual(call.args[0], "GET")
        self.assertIn("/pricing/abc-1", call.args[1])
        # No parallel_id -> params is None.
        self.assertIsNone(call.kwargs.get("params"))

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_with_parallel_id_passes_param(
        self, mock_req: MagicMock
    ) -> None:
        mock_req.return_value = _make_response(200, {"raw": {"count": 0, "records": []}})
        cardsight.get_pricing("abc-1", parallel_id="parallel-uuid-here")
        call = mock_req.call_args
        self.assertEqual(call.kwargs["params"], {"parallel_id": "parallel-uuid-here"})

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_404_returns_notfound_sentinel(
        self, mock_req: MagicMock
    ) -> None:
        mock_req.return_value = _make_response(404, {})
        result = cardsight.get_pricing("missing-uuid")
        self.assertTrue(result.get("notFound"))
        self.assertEqual(result["raw"], {"count": 0, "records": []})

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_missing_fields_normalizes(self, mock_req: MagicMock) -> None:
        mock_req.return_value = _make_response(200, {"card": {"id": "x"}})
        result = cardsight.get_pricing("x")
        self.assertEqual(result["raw"], {"count": 0, "records": []})
        self.assertEqual(result["graded"], [])
        self.assertEqual(result["meta"], {"total_records": 0, "last_sale_date": None})

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_url_encodes_card_id(self, mock_req: MagicMock) -> None:
        mock_req.return_value = _make_response(200, {})
        cardsight.get_pricing("uuid with spaces/slash")
        call = mock_req.call_args
        self.assertIn("uuid%20with%20spaces%2Fslash", call.args[1])

    # ── get_pricing_bulk ────────────────────────────────────────────────

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_bulk_empty_list_returns_empty(
        self, mock_req: MagicMock
    ) -> None:
        self.assertEqual(cardsight.get_pricing_bulk([]), [])
        mock_req.assert_not_called()

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_bulk_too_large_returns_empty(
        self, mock_req: MagicMock
    ) -> None:
        oversized = [f"id-{i}" for i in range(101)]
        self.assertEqual(cardsight.get_pricing_bulk(oversized), [])
        mock_req.assert_not_called()

    @patch("shared.cardsight.requests.request")
    def test_get_pricing_bulk_happy_path(self, mock_req: MagicMock) -> None:
        body = {
            "results": [
                {"card": {"id": "a"}, "raw": {"count": 1, "records": []}, "graded": [], "meta": {}},
                {"card": {"id": "b"}, "raw": {"count": 2, "records": []}, "graded": [], "meta": {}},
            ]
        }
        mock_req.return_value = _make_response(200, body)
        result = cardsight.get_pricing_bulk(["a", "b"])
        self.assertEqual(len(result), 2)
        call = mock_req.call_args
        self.assertEqual(call.args[0], "POST")
        self.assertIn("/pricing/bulk", call.args[1])
        self.assertEqual(call.kwargs["json"], {"card_ids": ["a", "b"]})

    # ── get_card_detail ─────────────────────────────────────────────────

    @patch("shared.cardsight.requests.request")
    def test_get_card_detail_happy_path_coerces_release_year(
        self, mock_req: MagicMock
    ) -> None:
        body = {
            "id": "abc",
            "name": "Mike Trout",
            "number": "US175",
            "releaseName": "Topps Update",
            "setName": "Base Set",
            "releaseYear": "2011",  # String per Cardsight's actual response
            "parallels": [{"id": "p1", "name": "Refractor"}],
            "attributes": ["RC", "Future HOF"],
        }
        mock_req.return_value = _make_response(200, body)
        result = cardsight.get_card_detail("abc")
        self.assertEqual(result["year"], 2011)  # Coerced to int
        self.assertEqual(result["parallels"][0]["name"], "Refractor")
        self.assertEqual(result["attributes"], ["RC", "Future HOF"])

    @patch("shared.cardsight.requests.request")
    def test_get_card_detail_404_returns_notfound(self, mock_req: MagicMock) -> None:
        mock_req.return_value = _make_response(404, {})
        result = cardsight.get_card_detail("missing")
        self.assertTrue(result.get("notFound"))
        self.assertEqual(result["id"], "missing")

    @patch("shared.cardsight.requests.request")
    def test_get_card_detail_filters_non_string_attributes(
        self, mock_req: MagicMock
    ) -> None:
        body = {
            "id": "x",
            "attributes": ["RC", None, 123, "auto"],  # mixed types
        }
        mock_req.return_value = _make_response(200, body)
        result = cardsight.get_card_detail("x")
        self.assertEqual(result["attributes"], ["RC", "auto"])


class CardsightRetrySuccessTests(unittest.TestCase):
    """Verify the retry path recovers when transient errors clear."""

    def setUp(self) -> None:
        os.environ["CARDSIGHT_API_KEY"] = "test-key"

    def tearDown(self) -> None:
        os.environ.pop("CARDSIGHT_API_KEY", None)

    @patch("shared.cardsight.requests.request")
    def test_429_then_200_recovers(self, mock_req: MagicMock) -> None:
        body = {"results": [{"id": "ok"}]}
        mock_req.side_effect = [
            _make_response(429, {"retry_after": 1}),
            _make_response(200, body),
        ]
        with patch("shared.cardsight.time.sleep") as mock_sleep:
            result = cardsight.search_catalog("foo")
        self.assertEqual(len(result), 1)
        self.assertEqual(mock_req.call_count, 2)
        self.assertEqual(mock_sleep.call_args.args[0], 1)  # First backoff

    @patch("shared.cardsight.requests.request")
    def test_500_then_500_then_200_recovers(self, mock_req: MagicMock) -> None:
        body = {"results": [{"id": "ok"}]}
        mock_req.side_effect = [
            _make_response(500, {}),
            _make_response(500, {}),
            _make_response(200, body),
        ]
        with patch("shared.cardsight.time.sleep"):
            result = cardsight.search_catalog("foo")
        self.assertEqual(len(result), 1)
        self.assertEqual(mock_req.call_count, 3)


class CardsightStructuredLogTests(unittest.TestCase):
    """The structured-JSON log shape matches the TS client convention so
    grep-friendly telemetry queries work across both clients."""

    def setUp(self) -> None:
        os.environ.pop("CARDSIGHT_API_KEY", None)

    def test_log_event_produces_json_with_required_fields(self) -> None:
        with self.assertLogs(level="WARNING") as captured:
            cardsight._log_event(
                "warn", "test_event", endpoint="search_catalog", query="foo"
            )
        self.assertEqual(len(captured.records), 1)
        msg = captured.records[0].getMessage()
        payload = json.loads(msg)
        self.assertEqual(payload["event"], "test_event")
        self.assertEqual(payload["source"], "shared.cardsight")
        self.assertEqual(payload["endpoint"], "search_catalog")
        self.assertEqual(payload["query"], "foo")


if __name__ == "__main__":
    unittest.main()
