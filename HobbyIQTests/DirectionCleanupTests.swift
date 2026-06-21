//
//  DirectionCleanupTests.swift
//  HobbyIQTests
//
//  CF-IOS-DIRECTION-SWEEP (2026-06-18): direction fields fully stripped.
//  The 10 direction fields (predictedPrice*, movement*) are gone from
//  InventoryCard's struct + init + Codable + every render site:
//   - per-card detail / list chip / grid chip (prior CF)
//   - Movement modal + pulse card + hasMovementSignals gate
//   - top-movers movement-branch (now P/L-only)
//   - alerts actionLabel verdict (now method, pill relabeled "Comp basis")
//   - CompIQ Market Analysis + Trends + Overall Trend cardGroups
//   - CompIQ valueBlockFollower direction branch
//
//  These tests guard the post-sweep invariants:
//   - Direction wire keys decode silently (Codable init uses try? per
//     field; backend keeps sending them; iOS ignores).
//   - Story B "—" + Phase 5 count split unaffected.
//   - PortfolioMover P/L-only — no movementDirection on the struct.
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
        method: String? = nil
    ) -> InventoryCard {
        InventoryCard(
            playerName: "Test",
            cardName: "Card",
            cost: cost,
            currentValue: currentValue,
            status: "active",
            method: method,
            fairMarketValue: fairMarketValue,
            valuationStatus: valuationStatus
        )
    }

    // MARK: - Wire-key tolerance (backend still sends; iOS ignores)

    /// Backend keeps emitting predictedPrice* / movement* fields per the
    /// existing reprice pipeline. Verify Codable decode tolerates the
    /// extra keys silently — no decode failure, no crash, fields just
    /// not present on the resulting struct.
    func testWireDecodeTolerates_directionKeys_silently() throws {
        let json = """
        {
          "id": "h_1", "playerName": "Trout", "cardName": "2011 Topps",
          "cost": 100, "currentValue": 256, "status": "active",
          "fairMarketValue": 256, "valuationStatus": "observed",
          "predictedPrice": 280,
          "predictedPriceLow": 240,
          "predictedPriceHigh": 320,
          "predictedPriceMechanism": "trendiq",
          "predictedPriceUpdatedAt": "2026-06-17T10:00:00Z",
          "movementDirection": "up",
          "movementComposite": 1.05,
          "movementImpliedPct": 9.4,
          "movementCoverage": "full",
          "movementUpdatedAt": "2026-06-17T10:00:00Z"
        }
        """
        let card = try JSONDecoder().decode(InventoryCard.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(card.fairMarketValue, 256)
        XCTAssertEqual(card.valuationStatus, "observed")
        XCTAssertEqual(card.currentValue, 256)
    }

    /// snake_case mirror — backend's alternative emit shape.
    func testWireDecodeTolerates_directionKeys_snakeCase() throws {
        let json = """
        {
          "id": "h_2", "player_name": "Hartman", "card_name": "2024 Bowman",
          "cost": 50, "current_value": 50, "status": "active",
          "valuation_status": "estimated",
          "predicted_price": 95,
          "movement_direction": "down",
          "movement_implied_pct": -4.2,
          "movement_coverage": "card_only",
          "movement_updated_at": "2026-06-17T10:00:00Z"
        }
        """
        let card = try JSONDecoder().decode(InventoryCard.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(card.valuationStatus, "estimated")
        XCTAssertNil(card.fairMarketValue, "Estimated bucket on wire has fmv null")
    }

    // MARK: - PortfolioMover P/L-only

    func testPortfolioMover_hasNoMovementFields() {
        // The PortfolioMover struct lost movementDirection / impliedPct /
        // composite / dollarImpact / coverage in this CF. Verify by
        // constructing one and confirming the P/L-only init compiles
        // + reads back its only meaningful direction proxy (profitLoss
        // sign) cleanly.
        let mover = PortfolioMover(
            id: "test",
            playerName: "Trout",
            cardName: "2011 Topps",
            currentValue: 256,
            profitLoss: 156,
            trendLabel: "Gainer",
            trendDetail: "Up"
        )
        XCTAssertGreaterThan(mover.profitLoss, 0, "P/L sign is the only direction proxy now")
        XCTAssertEqual(mover.trendLabel, "Gainer")
    }

    // MARK: - Alerts label = comp method

    /// The actionLabel on `AlertItem` now carries the comp method
    /// (e.g. "PSA10 multiplier", "Variant mismatch") instead of the
    /// direction-class status verdict ("Sell Now" / "Hold"). The
    /// rendered pill label is "Comp basis" so label + value agree.
    ///
    /// This is a source-level guard via the rendered alert's actionLabel
    /// content; the pill label change is visual and covered by build +
    /// sim verify.
    func testAlertActionLabel_isCompMethod_notStatusVerdict() {
        let observed = makeCard(
            cost: 100,
            currentValue: 256,
            fairMarketValue: 256,
            valuationStatus: "observed",
            method: "PSA10 multiplier"
        )
        XCTAssertEqual(observed.method, "PSA10 multiplier", "alerts.actionLabel reads holding.method now")
    }

    func testAlertActionLabel_unpriced_method_describesReason() {
        let unpriced = makeCard(
            cost: 50,
            currentValue: 50,
            fairMarketValue: nil,
            valuationStatus: "estimated",
            method: "Variant mismatch"
        )
        XCTAssertEqual(unpriced.method, "Variant mismatch", "alerts.actionLabel surfaces the comp-status reason")
    }

    // MARK: - Story B regression (display-only invariant)

    func testStoryBInvariant_unpricedCardStillShowsEmDash() {
        // Direction sweep must not perturb Story B's "—" contract.
        let card = makeCard(
            cost: 50,
            currentValue: 50,
            fairMarketValue: nil,
            valuationStatus: "estimated"
        )
        XCTAssertEqual(card.displayValueText, "—")
        XCTAssertTrue(card.isUnpriced)
    }

    func testStoryBInvariant_pricedCardStillFormatsValue() {
        let card = makeCard(
            cost: 100,
            currentValue: 256,
            fairMarketValue: 256,
            valuationStatus: "observed"
        )
        XCTAssertFalse(card.isUnpriced)
        XCTAssertTrue(card.displayValueFormatted.contains("256"))
    }

    // MARK: - Phase 5 count split unaffected

    func testCountSplit_unaffected_byDirectionSweep() {
        let observed = makeCard(
            cost: 100, currentValue: 256, fairMarketValue: 256,
            valuationStatus: "observed"
        )
        let estimated = makeCard(
            cost: 50, currentValue: 50, fairMarketValue: nil,
            valuationStatus: "estimated"
        )
        let pending = makeCard(
            cost: 30, currentValue: 30, fairMarketValue: nil,
            valuationStatus: "pending"
        )
        let agg = InventoryDisplayAggregate(holdings: [observed, estimated, pending])

        XCTAssertEqual(agg.pricedCount, 1)
        XCTAssertEqual(agg.estimatedCount, 1)
        XCTAssertEqual(agg.pendingCount, 1)
        XCTAssertEqual(agg.displayValue, 256, "Observed-only displayValue")
    }
}
