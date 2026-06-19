//
//  CollectionValueDecodeTests.swift
//  HobbyIQTests
//
//  CF-PHASE-5-COLLECTION-VALUE (2026-06-18): wire decoding + sparse/empty
//  edges for /api/portfolio/value-history.
//
//  Plus the Story B count split — InventoryDisplayAggregate now reports
//  estimatedCount/pendingCount split so the inventory hero can render
//  "N estimated · M pending" instead of the generic "N unpriced".
//  displayValue is unchanged — Story B's observed-only contract held.
//

import Foundation
import XCTest
@testable import HobbyIQ

@MainActor
final class CollectionValueDecodeTests: XCTestCase {

    // MARK: - Helpers

    private func decode(_ json: String) throws -> PortfolioValueHistoryResponse {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(PortfolioValueHistoryResponse.self, from: data)
    }

    private func makeCard(
        fairMarketValue: Double?,
        valuationStatus: String? = nil,
        cost: Double = 0
    ) -> InventoryCard {
        InventoryCard(
            playerName: "Test",
            cardName: "Card",
            cost: cost,
            currentValue: cost,
            status: "active",
            fairMarketValue: fairMarketValue,
            valuationStatus: valuationStatus
        )
    }

    // MARK: - Full payload decode

    func testDecode_fullPayload_succeeds() throws {
        let json = """
        {
          "asOf": "2026-06-18T21:15:32Z",
          "totalDisplayable": 1234.56,
          "rangeLow": 900.0,
          "rangeHigh": 1500.0,
          "observedValue": 900.0,
          "estimatedValue": 334.56,
          "observedCount": 1,
          "estimatedCount": 4,
          "pendingCount": 0,
          "totalCards": 5,
          "change30d": {
            "absolute": 120.5,
            "percent": 10.8,
            "asOfDate": "2026-05-19",
            "rangeWeak": false
          },
          "historySeries": [
            { "date": "2026-05-19", "total": 1100.0 },
            { "date": "2026-06-18", "total": 1234.56 }
          ],
          "topHoldings": [
            { "holdingId": "h_1", "name": "Trout · 2011 Topps", "estValue": 295.0, "source": "observed" },
            { "holdingId": "h_2", "name": "Hartman · 2024 Bowman", "estValue": 95.0, "source": "estimated" }
          ],
          "framing": { "isEstimate": true, "note": "Range reflects comp-sufficiency." }
        }
        """

        let response = try decode(json)
        XCTAssertEqual(response.totalDisplayable, 1234.56, accuracy: 0.001)
        XCTAssertEqual(response.rangeLow, 900.0, accuracy: 0.001)
        XCTAssertEqual(response.rangeHigh, 1500.0, accuracy: 0.001)
        XCTAssertEqual(response.observedCount, 1)
        XCTAssertEqual(response.estimatedCount, 4)
        XCTAssertEqual(response.pendingCount, 0)
        XCTAssertEqual(response.totalCards, 5)
        XCTAssertEqual(response.historySeries.count, 2)
        XCTAssertEqual(response.topHoldings.count, 2)
        XCTAssertTrue(response.framing.isEstimate)
        XCTAssertEqual(response.change30d?.absolute, 120.5)
        XCTAssertEqual(response.change30d?.percent, 10.8)
        XCTAssertFalse(response.change30d?.rangeWeak ?? true)
    }

    // MARK: - Sparse / edge payload decodes

    func testDecode_nullChange30d_decodesNil() throws {
        // Backend returns null for change30d when history is empty.
        let json = """
        {
          "asOf": "2026-06-18T21:15:32Z",
          "totalDisplayable": 256.0,
          "rangeLow": 256.0, "rangeHigh": 256.0,
          "observedValue": 256.0, "estimatedValue": 0,
          "observedCount": 1, "estimatedCount": 0, "pendingCount": 4, "totalCards": 5,
          "change30d": null,
          "historySeries": [],
          "topHoldings": [],
          "framing": { "isEstimate": true, "note": "Range reflects comp-sufficiency." }
        }
        """
        let response = try decode(json)
        XCTAssertNil(response.change30d)
        XCTAssertTrue(response.historySeries.isEmpty)
        XCTAssertTrue(response.topHoldings.isEmpty)
    }

    func testDecode_nullPercent_inChange30d_decodesNil() throws {
        // Backend emits null percent when baseline displayableTotal is 0.
        let json = """
        {
          "asOf": "2026-06-18T21:15:32Z",
          "totalDisplayable": 100, "rangeLow": 100, "rangeHigh": 100,
          "observedValue": 100, "estimatedValue": 0,
          "observedCount": 1, "estimatedCount": 0, "pendingCount": 0, "totalCards": 1,
          "change30d": { "absolute": 100, "percent": null, "asOfDate": "2026-05-19", "rangeWeak": false },
          "historySeries": [{ "date": "2026-05-19", "total": 0 }, { "date": "2026-06-18", "total": 100 }],
          "topHoldings": [],
          "framing": { "isEstimate": true, "note": "..." }
        }
        """
        let response = try decode(json)
        XCTAssertEqual(response.change30d?.absolute, 100)
        XCTAssertNil(response.change30d?.percent)
    }

    func testDecode_rangeWeak_decodesTrue() throws {
        // Backend sets rangeWeak when history < 30 days OR single snapshot.
        let json = """
        {
          "asOf": "2026-06-18T21:15:32Z",
          "totalDisplayable": 100, "rangeLow": 100, "rangeHigh": 100,
          "observedValue": 100, "estimatedValue": 0,
          "observedCount": 1, "estimatedCount": 0, "pendingCount": 0, "totalCards": 1,
          "change30d": { "absolute": 12, "percent": 13.6, "asOfDate": "2026-06-10", "rangeWeak": true },
          "historySeries": [{ "date": "2026-06-10", "total": 88 }, { "date": "2026-06-18", "total": 100 }],
          "topHoldings": [],
          "framing": { "isEstimate": true, "note": "..." }
        }
        """
        let response = try decode(json)
        XCTAssertTrue(response.change30d?.rangeWeak ?? false)
    }

    // MARK: - Top-holding source-flag decode

    func testDecode_topHoldings_bothSourceFlags() throws {
        let json = """
        {
          "asOf": "2026-06-18T21:15:32Z",
          "totalDisplayable": 0, "rangeLow": 0, "rangeHigh": 0,
          "observedValue": 0, "estimatedValue": 0,
          "observedCount": 0, "estimatedCount": 0, "pendingCount": 0, "totalCards": 0,
          "change30d": null,
          "historySeries": [],
          "topHoldings": [
            { "holdingId": "h_a", "name": "A", "estValue": 100, "source": "observed" },
            { "holdingId": "h_b", "name": "B", "estValue": 50, "source": "estimated" }
          ],
          "framing": { "isEstimate": true, "note": "..." }
        }
        """
        let response = try decode(json)
        XCTAssertEqual(response.topHoldings.count, 2)
        XCTAssertTrue(response.topHoldings[0].isObserved)
        XCTAssertFalse(response.topHoldings[0].isEstimated)
        XCTAssertTrue(response.topHoldings[1].isEstimated)
        XCTAssertFalse(response.topHoldings[1].isObserved)
        // SwiftUI identity uses holdingId
        XCTAssertEqual(response.topHoldings[0].id, "h_a")
    }

    func testDecode_unknownSourceValue_doesNotCrash() throws {
        // Forward-compat: backend could add a new bucket value.
        let json = """
        {
          "asOf": "2026-06-18T21:15:32Z",
          "totalDisplayable": 0, "rangeLow": 0, "rangeHigh": 0,
          "observedValue": 0, "estimatedValue": 0,
          "observedCount": 0, "estimatedCount": 0, "pendingCount": 0, "totalCards": 0,
          "change30d": null,
          "historySeries": [],
          "topHoldings": [
            { "holdingId": "h_x", "name": "X", "estValue": 1, "source": "futureBucket" }
          ],
          "framing": { "isEstimate": true, "note": "..." }
        }
        """
        let response = try decode(json)
        XCTAssertEqual(response.topHoldings[0].source, "futureBucket")
        XCTAssertFalse(response.topHoldings[0].isObserved)
        XCTAssertFalse(response.topHoldings[0].isEstimated)
    }

    // MARK: - Story B count split (InventoryDisplayAggregate)

    func testAggregate_splits_estimated_and_pending_counts() {
        let observed = makeCard(fairMarketValue: 256, valuationStatus: "observed", cost: 200)
        let estimated1 = makeCard(fairMarketValue: nil, valuationStatus: "estimated", cost: 50)
        let estimated2 = makeCard(fairMarketValue: nil, valuationStatus: "estimated", cost: 50)
        let pending = makeCard(fairMarketValue: nil, valuationStatus: "pending", cost: 30)
        let agg = InventoryDisplayAggregate(holdings: [observed, estimated1, estimated2, pending])

        XCTAssertEqual(agg.pricedCount, 1)
        XCTAssertEqual(agg.estimatedCount, 2)
        XCTAssertEqual(agg.pendingCount, 1)
        XCTAssertEqual(agg.unpricedCount, 3, "Back-compat alias = estimated + pending")
        XCTAssertEqual(agg.totalCards, 4)
        // Story B held: displayValue is observed-only
        XCTAssertEqual(agg.displayValue, 256, accuracy: 0.001)
    }

    func testAggregate_legacyNilStatus_treatedAsPending() {
        // Pre-Step-1 wire row: valuationStatus = nil, fmv = nil.
        // Backend's computeSnapshotFromHoldings reclassifies these as
        // pending; iOS mirrors so the count split stays consistent.
        let legacy = makeCard(fairMarketValue: nil, valuationStatus: nil, cost: 25)
        let agg = InventoryDisplayAggregate(holdings: [legacy])

        XCTAssertEqual(agg.pendingCount, 1)
        XCTAssertEqual(agg.estimatedCount, 0)
        XCTAssertEqual(agg.unpricedCount, 1)
    }

    func testAggregate_observedNilFMV_treatedAsPending() {
        // Mirrors backend's computeSnapshotFromHoldings:209-224 — observed
        // bucket with no FMV reclassifies as pending.
        let observedNoFMV = makeCard(fairMarketValue: nil, valuationStatus: "observed", cost: 40)
        let agg = InventoryDisplayAggregate(holdings: [observedNoFMV])

        XCTAssertEqual(agg.pendingCount, 1)
        XCTAssertEqual(agg.estimatedCount, 0)
    }

    func testAggregate_unpricedSubtitleSuffix_bothBuckets() {
        let observed = makeCard(fairMarketValue: 100, valuationStatus: "observed")
        let estimated = makeCard(fairMarketValue: nil, valuationStatus: "estimated")
        let pending = makeCard(fairMarketValue: nil, valuationStatus: "pending")
        let agg = InventoryDisplayAggregate(holdings: [observed, estimated, pending])

        XCTAssertEqual(agg.unpricedSubtitleSuffix, " · 1 estimated · 1 pending")
    }

    func testAggregate_unpricedSubtitleSuffix_estimatedOnly() {
        let observed = makeCard(fairMarketValue: 100, valuationStatus: "observed")
        let estimated = makeCard(fairMarketValue: nil, valuationStatus: "estimated")
        let agg = InventoryDisplayAggregate(holdings: [observed, estimated])

        XCTAssertEqual(agg.unpricedSubtitleSuffix, " · 1 estimated")
    }

    func testAggregate_unpricedSubtitleSuffix_pendingOnly() {
        let observed = makeCard(fairMarketValue: 100, valuationStatus: "observed")
        let pending = makeCard(fairMarketValue: nil, valuationStatus: "pending")
        let agg = InventoryDisplayAggregate(holdings: [observed, pending])

        XCTAssertEqual(agg.unpricedSubtitleSuffix, " · 1 pending")
    }

    func testAggregate_unpricedSubtitleSuffix_allPriced_empty() {
        let observed = makeCard(fairMarketValue: 100, valuationStatus: "observed")
        let agg = InventoryDisplayAggregate(holdings: [observed])

        XCTAssertEqual(agg.unpricedSubtitleSuffix, "")
    }

    // MARK: - InventoryCard.valuationStatus decode

    func testInventoryCard_valuationStatus_camelCaseDecodes() throws {
        let json = """
        {
          "id": "h_1", "playerName": "Trout", "cardName": "2011 Topps",
          "cost": 100, "currentValue": 256, "status": "active",
          "fairMarketValue": 256, "valuationStatus": "observed"
        }
        """
        let data = json.data(using: .utf8)!
        let card = try JSONDecoder().decode(InventoryCard.self, from: data)
        XCTAssertEqual(card.valuationStatus, "observed")
    }

    func testInventoryCard_valuationStatus_snakeCaseDecodes() throws {
        let json = """
        {
          "id": "h_2", "player_name": "Hartman", "card_name": "2024 Bowman",
          "cost": 50, "current_value": 50, "status": "active",
          "valuation_status": "estimated"
        }
        """
        let data = json.data(using: .utf8)!
        let card = try JSONDecoder().decode(InventoryCard.self, from: data)
        XCTAssertEqual(card.valuationStatus, "estimated")
        XCTAssertNil(card.fairMarketValue, "Estimated bucket on wire has fmv null")
    }

    func testInventoryCard_valuationStatus_absentDecodesNil() throws {
        // Legacy wire row pre-Step-1: field omitted entirely.
        let json = """
        {
          "id": "h_3", "playerName": "Legacy", "cardName": "Old card",
          "cost": 10, "currentValue": 15, "status": "active",
          "fairMarketValue": 15
        }
        """
        let data = json.data(using: .utf8)!
        let card = try JSONDecoder().decode(InventoryCard.self, from: data)
        XCTAssertNil(card.valuationStatus)
    }

    // MARK: - Display-only invariant (Story B held under count split)

    func testStoryBInvariant_displayValue_unchanged_by_estimatedCards() {
        // The count split must NOT change displayValue. The card's
        // headline includes estimated; the hero's does not.
        let observed = makeCard(fairMarketValue: 256, valuationStatus: "observed", cost: 200)
        let estimated = makeCard(fairMarketValue: nil, valuationStatus: "estimated", cost: 100)
        let agg = InventoryDisplayAggregate(holdings: [observed, estimated])

        XCTAssertEqual(agg.displayValue, 256, "Estimated card must NOT be counted in iOS displayValue")
        XCTAssertEqual(agg.estimatedCount, 1, "But it must be counted in the split")
    }
}
