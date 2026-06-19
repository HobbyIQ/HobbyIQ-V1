//
//  NullFMVDisplayTests.swift
//  HobbyIQTests
//
//  Covers the display-only null-FMV rendering rule: when an InventoryCard
//  has no fair-market value (`fairMarketValue == nil`), every value-rendering
//  surface shows "—" instead of the cost-proxy-inflated currentValue, and the
//  hero aggregates exclude unpriced holdings while reporting their count.
//
//  Crucially, these tests also guard the display-only invariant: no helper
//  introduced here mutates `currentValue`, `profitLoss`, or any P/L
//  computation on InventoryCard, ActionIQCard, SellIQPortfolioCard, or
//  ProfitIQCardResult. The cost-proxy fallback inside currentValue stays
//  intact so the −100%-loss guard continues to hold.
//

import Foundation
import XCTest
@testable import HobbyIQ

@MainActor
final class NullFMVDisplayTests: XCTestCase {

    // MARK: - InventoryCard.displayValueText / displayValueFormatted

    private func makeCard(
        fairMarketValue: Double?,
        quantity: Double? = nil,
        cost: Double = 0,
        currentValue: Double = 0
    ) -> InventoryCard {
        InventoryCard(
            playerName: "Test",
            cardName: "Card",
            cost: cost,
            currentValue: currentValue,
            status: "active",
            quantity: quantity,
            fairMarketValue: fairMarketValue
        )
    }

    func testDisplayValueText_nilFMV_returnsEmDash() {
        let card = makeCard(fairMarketValue: nil, currentValue: 50)
        XCTAssertEqual(card.displayValueText, "—")
        XCTAssertEqual(card.displayValueFormatted, "—")
        XCTAssertTrue(card.isUnpriced)
    }

    func testDisplayValueText_qtyOne_returnsFMVAsTotal() {
        let card = makeCard(fairMarketValue: 125, quantity: 1)
        // Locale-robust: NumberFormatter symbol varies by region. Verify the
        // digits are present and "—" is NOT.
        XCTAssertTrue(card.displayValueText.contains("125"))
        XCTAssertNotEqual(card.displayValueText, "—")
        XCTAssertFalse(card.isUnpriced)
    }

    func testDisplayValueText_qtyGreaterThanOne_multipliesFMVByQty() {
        let card = makeCard(fairMarketValue: 50, quantity: 3)
        XCTAssertTrue(card.displayValueText.contains("150"))
    }

    func testDisplayValueText_nilQuantity_treatedAsOne() {
        let card = makeCard(fairMarketValue: 200, quantity: nil)
        XCTAssertTrue(card.displayValueText.contains("200"))
    }

    func testDisplayValueText_zeroFMV_returnsZeroNotEmDash() {
        // FMV == 0 is a genuine market price (the card is worth nothing,
        // not an unknown). It must NOT fall through to "—" or the cost-proxy.
        let card = makeCard(fairMarketValue: 0, quantity: 1, cost: 100, currentValue: 100)
        XCTAssertTrue(card.displayValueText.contains("0"))
        XCTAssertNotEqual(card.displayValueText, "—")
        XCTAssertFalse(card.isUnpriced)
    }

    func testDisplayValueFormatted_centsResolutionForPriced() {
        let card = makeCard(fairMarketValue: 12.5, quantity: 2)
        // Cents formatter produces e.g. "$25.00" — verify the digit prefix
        // rather than the entire locale-dependent string.
        XCTAssertTrue(card.displayValueFormatted.contains("25"))
    }

    // MARK: - Display-only invariant for InventoryCard

    func testDisplayOnlyInvariant_currentValueUnchangedForNilFMV() {
        // A real cost-proxy case: backend sent fairMarketValue: nil but
        // currentValue carries the totalCostBasis fallback so P/L = 0,
        // not −100%. The helper must not mutate currentValue.
        let card = makeCard(fairMarketValue: nil, cost: 80, currentValue: 80)
        XCTAssertEqual(card.currentValue, 80)
        XCTAssertEqual(card.cost, 80)
        XCTAssertEqual(card.profitLoss, 0, "P/L must equal currentValue − cost regardless of FMV nil-ness")
    }

    func testDisplayOnlyInvariant_profitLossUnchangedForPriced() {
        let card = makeCard(fairMarketValue: 150, quantity: 1, cost: 100, currentValue: 150)
        XCTAssertEqual(card.profitLoss, 50)
    }

    // MARK: - InventoryDisplayAggregate

    func testAggregate_excludesUnpricedFromDisplayValue() {
        let priced1 = makeCard(fairMarketValue: 100, quantity: 1, cost: 60, currentValue: 100)
        let priced2 = makeCard(fairMarketValue: 50, quantity: 2, cost: 40, currentValue: 100)  // FMV × qty = 100
        let unpriced = makeCard(fairMarketValue: nil, cost: 30, currentValue: 30)
        let agg = InventoryDisplayAggregate(holdings: [priced1, priced2, unpriced])

        XCTAssertEqual(agg.displayValue, 200, "Unpriced card must not contribute its cost-proxy to the displayed value")
        XCTAssertEqual(agg.pricedCount, 2)
        XCTAssertEqual(agg.unpricedCount, 1)
        XCTAssertEqual(agg.totalCards, 3)
    }

    func testAggregate_displayCostUsesPricedSubsetOnly() {
        // The hero's subtitle line must reconcile arithmetically: displayPL
        // = displayValue − displayCost. Cost from the unpriced card stays
        // out of the displayed cost so the math holds.
        let priced = makeCard(fairMarketValue: 100, cost: 60, currentValue: 100)
        let unpriced = makeCard(fairMarketValue: nil, cost: 30, currentValue: 30)
        let agg = InventoryDisplayAggregate(holdings: [priced, unpriced])

        XCTAssertEqual(agg.displayCost, 60)
        XCTAssertEqual(agg.displayPL, 40, "displayPL = displayValue (100) − displayCost (60)")
    }

    func testAggregate_displayROIComputedFromPricedSubset() {
        let priced = makeCard(fairMarketValue: 200, cost: 100, currentValue: 200)
        let unpriced = makeCard(fairMarketValue: nil, cost: 50, currentValue: 50)
        let agg = InventoryDisplayAggregate(holdings: [priced, unpriced])

        XCTAssertEqual(agg.displayROI, 100, accuracy: 0.001)
    }

    func testAggregate_zeroCostBasis_roiIsZeroNotNaN() {
        let priced = makeCard(fairMarketValue: 100, cost: 0, currentValue: 100)
        let agg = InventoryDisplayAggregate(holdings: [priced])
        XCTAssertEqual(agg.displayROI, 0)
        XCTAssertFalse(agg.displayROI.isNaN)
    }

    func testAggregate_allUnpriced_displayValueIsZero() {
        let unpriced1 = makeCard(fairMarketValue: nil, cost: 30, currentValue: 30)
        let unpriced2 = makeCard(fairMarketValue: nil, cost: 50, currentValue: 50)
        let agg = InventoryDisplayAggregate(holdings: [unpriced1, unpriced2])

        XCTAssertEqual(agg.displayValue, 0)
        XCTAssertEqual(agg.unpricedCount, 2)
        XCTAssertEqual(agg.pricedCount, 0)
    }

    // MARK: - ActionIQCard propagation (Z1)

    func testActionIQCard_nilFMVTotal_returnsEmDash() {
        let card = ActionIQCard(
            cardId: "a1", playerName: "x", cardName: "y",
            cost: 50, currentValue: 50, profitLoss: 0, roi: 0,
            signal: nil, listPrice: nil, minAcceptableOffer: nil,
            quickSalePrice: nil, format: nil, reasoning: nil,
            fairMarketValueTotal: nil
        )
        XCTAssertEqual(card.displayValueFormatted, "—")
        XCTAssertEqual(card.currentValue, 50, "Propagation must not touch currentValue")
    }

    func testActionIQCard_withFMVTotal_returnsFormattedTotal() {
        let card = ActionIQCard(
            cardId: "a1", playerName: "x", cardName: "y",
            cost: 50, currentValue: 200, profitLoss: 150, roi: 300,
            signal: nil, listPrice: nil, minAcceptableOffer: nil,
            quickSalePrice: nil, format: nil, reasoning: nil,
            fairMarketValueTotal: 200
        )
        XCTAssertTrue(card.displayValueFormatted.contains("200"))
        XCTAssertEqual(card.profitLoss, 150, "P/L must be unchanged by propagation")
    }

    // MARK: - SellIQPortfolioCard → ProfitIQCardResult chain (Z1 round-trip)

    private func makeSellIQ(fairMarketValueTotal: Double?) -> SellIQPortfolioCard {
        SellIQPortfolioCard(
            cardId: "s1", userId: "u1", playerName: "x", cardName: "y",
            cost: 50, currentValue: 100, profitLoss: 50, roi: 100,
            signal: "hold", confidence: 0.8,
            listPrice: 100, minAcceptableOffer: 90, quickSalePrice: 85,
            format: "Raw", reasoning: [], lastSellIQAt: "",
            fairMarketValueTotal: fairMarketValueTotal
        )
    }

    func testProfitIQCardResult_nilFMVTotal_returnsEmDash() {
        let result = ProfitIQCardResult(from: makeSellIQ(fairMarketValueTotal: nil))
        XCTAssertEqual(result.displayValueFormatted, "—")
        XCTAssertEqual(result.currentValue, 100, "Propagation must not touch currentValue")
        XCTAssertEqual(result.profitLoss, 50, "P/L must be unchanged by propagation")
    }

    func testProfitIQCardResult_withFMVTotal_returnsFormattedTotal() {
        let result = ProfitIQCardResult(from: makeSellIQ(fairMarketValueTotal: 175))
        XCTAssertTrue(result.displayValueFormatted.contains("175"))
    }

    func testProfitIQCardResult_initFromSellIQ_preservesFairMarketValueTotal() {
        let result = ProfitIQCardResult(from: makeSellIQ(fairMarketValueTotal: 175))
        XCTAssertEqual(result.fairMarketValueTotal, 175)
    }

    func testProfitIQCardResult_asSellIQPortfolioCard_preservesFairMarketValueTotal() {
        // Round-trip: SellIQ → ProfitIQResult → SellIQ. The mirror at
        // ProfitIQModels.asSellIQPortfolioCard must thread the field through,
        // otherwise markSellIQCardSold would lose FMV context after a tap.
        let original = makeSellIQ(fairMarketValueTotal: 175)
        let result = ProfitIQCardResult(from: original)
        let roundTripped = result.asSellIQPortfolioCard

        XCTAssertEqual(roundTripped.fairMarketValueTotal, 175)
    }

    func testProfitIQCardResult_asSellIQPortfolioCard_preservesNilFairMarketValueTotal() {
        let original = makeSellIQ(fairMarketValueTotal: nil)
        let result = ProfitIQCardResult(from: original)
        let roundTripped = result.asSellIQPortfolioCard

        XCTAssertNil(roundTripped.fairMarketValueTotal)
    }
}
