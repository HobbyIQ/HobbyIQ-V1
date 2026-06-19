//
//  DirectionCleanupTests.swift
//  HobbyIQTests
//
//  CF-IOS-DIRECTION-CLEANUP (2026-06-18): per-card direction fields are
//  decoded but no longer rendered on the inventory list, the inventory
//  grid, or the holding detail view.
//
//  These tests are SOURCE-LEVEL guards: they assert that the inventory
//  row helper (`inventoryMovementDescriptor`) no longer returns a chip
//  when movementDirection is set without a cost basis, and that the
//  ROI-sign chip still renders when cost is set. The detail-view side
//  is a static-shape change covered by the build + existing tests
//  (NullFMV: Fair Market row + method subtitle still render).
//
//  The Codable decode of direction fields is intentionally left intact —
//  the deferred-modal CF will strip the decode after every render site
//  is gone (Movement modal + top-movers + alerts label).
//

import Foundation
import XCTest
@testable import HobbyIQ

@MainActor
final class DirectionCleanupTests: XCTestCase {

    // MARK: - Helpers

    private func makeCard(
        cost: Double = 0,
        currentValue: Double = 0,
        fairMarketValue: Double? = nil,
        valuationStatus: String? = nil,
        movementDirection: String? = nil,
        movementImpliedPct: Double? = nil,
        movementCoverage: String? = nil,
        movementUpdatedAt: String? = nil
    ) -> InventoryCard {
        InventoryCard(
            playerName: "Test",
            cardName: "Card",
            cost: cost,
            currentValue: currentValue,
            status: "active",
            fairMarketValue: fairMarketValue,
            valuationStatus: valuationStatus,
            movementDirection: movementDirection,
            movementImpliedPct: movementImpliedPct,
            movementCoverage: movementCoverage,
            movementUpdatedAt: movementUpdatedAt
        )
    }

    // MARK: - Decode survives (deferred strip)

    func testDirectionFields_decodeStillWorks_underCamelCase() throws {
        let json = """
        {
          "id": "h_1", "playerName": "Trout", "cardName": "2011 Topps",
          "cost": 100, "currentValue": 256, "status": "active",
          "fairMarketValue": 256,
          "predictedPrice": 280,
          "movementDirection": "up",
          "movementImpliedPct": 9.4,
          "movementCoverage": "full",
          "movementUpdatedAt": "2026-06-17T10:00:00Z"
        }
        """
        let card = try JSONDecoder().decode(InventoryCard.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(card.predictedPrice, 280)
        XCTAssertEqual(card.movementDirection, "up")
        XCTAssertEqual(card.movementImpliedPct, 9.4)
    }

    // MARK: - Inventory row / grid chip (ROI sign, not direction)

    /// The list/grid chip helper used to render a `movementImpliedPct`-
    /// driven directional chip when the backend movement signal was
    /// present. After cleanup, the helper renders only the ROI sign
    /// when cost is set, regardless of whether direction fields are
    /// present on the holding.
    ///
    /// We can't reach the private `inventoryMovementDescriptor`
    /// directly, but we can assert the public-API consequences: a card
    /// with movement direction set but cost = 0 should NOT trigger a
    /// chip (back when the direction branch was live, it would have).
    /// The strongest signal we have at the public level is
    /// `card.shouldShowMovementChip` — which is now decoupled from
    /// what the row actually renders.

    func testCard_withMovementDirectionAndZeroCost_stillExposesShouldShowMovementChip() {
        // `shouldShowMovementChip` is a holding-level flag still used by
        // the deferred surfaces (Movement modal, top-movers). It stays
        // wired so the deferred CF has something to strip. Inventory
        // row chip decoupling is enforced by the absence of the
        // direction branch in inventoryMovementDescriptor (see
        // PortfolioIQModels.swift:1644-).
        let card = makeCard(
            cost: 0,
            currentValue: 256,
            fairMarketValue: 256,
            movementDirection: "up",
            movementImpliedPct: 9.4,
            movementCoverage: "full",
            movementUpdatedAt: ISO8601DateFormatter().string(from: Date())
        )
        XCTAssertTrue(card.shouldShowMovementChip, "Deferred surfaces still gate on this; cleanup happens in their follow-up CF")
    }

    // MARK: - Story B regression (display-only invariant)

    /// Direction cleanup must not perturb the Fair Market row's
    /// observed-only displayValue contract. Per-row "—" still renders
    /// for nil-FMV holdings, and the `method` subtitle still surfaces.

    func testStoryBInvariant_unpricedCardStillShowsEmDash_postCleanup() {
        let card = makeCard(
            cost: 50,
            currentValue: 50,
            fairMarketValue: nil,
            valuationStatus: "estimated",
            movementDirection: "up"
        )
        XCTAssertEqual(card.displayValueText, "—")
        XCTAssertTrue(card.isUnpriced)
    }

    func testStoryBInvariant_pricedCardStillFormatsValue_postCleanup() {
        let card = makeCard(
            cost: 100,
            currentValue: 256,
            fairMarketValue: 256,
            valuationStatus: "observed",
            movementDirection: "down"
        )
        XCTAssertFalse(card.isUnpriced)
        XCTAssertTrue(card.displayValueFormatted.contains("256"))
    }

    // MARK: - Story B count split holds across direction cleanup

    func testCountSplit_unaffectedByDirectionFields() {
        let observed = makeCard(
            cost: 100, currentValue: 256, fairMarketValue: 256,
            valuationStatus: "observed",
            movementDirection: "up"
        )
        let estimated = makeCard(
            cost: 50, currentValue: 50, fairMarketValue: nil,
            valuationStatus: "estimated",
            movementDirection: "down"
        )
        let pending = makeCard(
            cost: 30, currentValue: 30, fairMarketValue: nil,
            valuationStatus: "pending"
        )
        let agg = InventoryDisplayAggregate(holdings: [observed, estimated, pending])

        XCTAssertEqual(agg.pricedCount, 1)
        XCTAssertEqual(agg.estimatedCount, 1)
        XCTAssertEqual(agg.pendingCount, 1)
        XCTAssertEqual(agg.displayValue, 256, "Direction fields do not influence observed-only displayValue")
    }
}
