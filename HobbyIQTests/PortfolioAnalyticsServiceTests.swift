//
//  PortfolioAnalyticsServiceTests.swift
//  HobbyIQTests
//
//  CF-PORTFOLIO-BREAKDOWN (2026-08-17). Pins the judgements in
//  PortfolioAnalyticsService that would otherwise drift silently — the ones
//  where a plausible-looking change quietly reclassifies someone's portfolio.
//
//  The service is pure, so every case here is a fixture in and a number out.
//

import Foundation
import XCTest
@testable import HobbyIQ

final class PortfolioAnalyticsServiceTests: XCTestCase {

    private let service = PortfolioAnalyticsService()

    // MARK: - Fixtures

    private func card(player: String = "Test Player",
                      name: String = "Base",
                      year: String = "2024",
                      set: String = "Topps Chrome",
                      parallel: String = "Base",
                      grade: String = "",
                      gradeCompany: String? = nil,
                      gradeValue: Double? = nil,
                      cost: Double = 100,
                      value: Double = 200,
                      quantity: Double? = nil,
                      status: String = "owned") -> InventoryCard {
        // Everything past `status` has a default on InventoryCard's init, so
        // the fixture names only what a test actually varies. That keeps these
        // cases readable and stops them breaking when unrelated fields are
        // added to the model.
        InventoryCard(
            playerName: player,
            cardName: name,
            cost: cost,
            currentValue: value,
            status: status,
            year: year,
            setName: set,
            parallel: parallel,
            grade: grade,
            gradeCompany: gradeCompany,
            gradeValue: gradeValue,
            quantity: quantity
        )
    }

    // MARK: - Print-run parsing
    //
    // The whole scarcity spine hangs off text parsing, because InventoryCard
    // has no print-run field. If this regresses, every downstream number moves.

    func testParsesExplicitSerial() {
        XCTAssertEqual(service.parsePrintRun(parallel: "Gold Refractor /50", cardName: ""), 50)
        XCTAssertEqual(service.parsePrintRun(parallel: "Orange", cardName: "Orange Refractor /25"), 25)
        XCTAssertEqual(service.parsePrintRun(parallel: "Red /5", cardName: ""), 5)
        XCTAssertEqual(service.parsePrintRun(parallel: "", cardName: "Superfractor 1/1"), 1)
    }

    func testParsesNamedParallelsWithConventionalRuns() {
        XCTAssertEqual(service.parsePrintRun(parallel: "True Gold", cardName: ""), 50)
        XCTAssertEqual(service.parsePrintRun(parallel: "Black Refractor", cardName: ""), 10)
        XCTAssertEqual(service.parsePrintRun(parallel: "Orange Refractor", cardName: ""), 25)
    }

    /// The load-bearing negative case. An unreadable print run must be nil —
    /// NOT zero and not "unnumbered" — or every terse card silently scores as
    /// non-scarce and the portfolio looks worse than it is.
    func testUnreadablePrintRunIsNilNotZero() {
        XCTAssertNil(service.parsePrintRun(parallel: "Base", cardName: "Base Card"))
        XCTAssertEqual(ScarcityBand.from(printRun: nil), .unknown)
        XCTAssertNotEqual(ScarcityBand.from(printRun: nil), .unnumbered)
    }

    // MARK: - Category assignment

    func testVintageIsAlwaysTrueScarcity() {
        // Supply is fixed regardless of who is on the card.
        XCTAssertEqual(service.category(for: card(year: "1955", set: "Bowman")), .trueScarcity)
    }

    func testLowNumberedCardIsTrueScarcityWhoeverIsOnIt() {
        let c = card(player: "Unknown Guy", parallel: "Black /10")
        XCTAssertEqual(service.category(for: c), .trueScarcity)
    }

    /// A known name must NOT launder an unnumbered high-pop modern card into
    /// Established Greatness via a scarcity claim it does not have.
    func testEstablishedPlayerOnPlainModernIsEstablishedNotScarcity() {
        let c = card(player: "Shohei Ohtani", parallel: "Base", year: "2024")
        XCTAssertEqual(service.category(for: c), .establishedGreatness)
    }

    func testProspectSplitsOnActualScarcity() {
        let scarce = card(player: "Some Prospect", set: "Bowman Chrome Prospects", parallel: "Gold /50")
        let plain = card(player: "Some Prospect", set: "Bowman Chrome Prospects", parallel: "Base")
        XCTAssertEqual(service.category(for: scarce), .eliteProspects)
        XCTAssertEqual(service.category(for: plain), .speculation)
    }

    // MARK: - Allocation maths

    func testAllocationSharesAreValueWeightedNotCountWeighted() {
        // One grail plus many commons is not "mostly commons".
        var cards = [card(player: "Shohei Ohtani", value: 9000)]
        cards += (0..<9).map { _ in card(player: "Filler", set: "Bowman Chrome Prospects", value: 100) }

        let r = service.analyze(cards)
        let established = r.allocations.first { $0.category == .establishedGreatness }!
        XCTAssertEqual(established.currentShare, 0.9, accuracy: 0.01)
        XCTAssertEqual(established.cardCount, 1)
    }

    func testAllocationSharesSumToOne() {
        let cards = [
            card(player: "Shohei Ohtani", value: 500),
            card(year: "1955", value: 300),
            card(set: "Bowman Chrome Prospects", parallel: "Gold /50", value: 150),
            card(set: "Bowman Chrome Prospects", parallel: "Base", value: 50),
        ]
        let total = service.analyze(cards).allocations.reduce(0) { $0 + $1.currentShare }
        XCTAssertEqual(total, 1.0, accuracy: 0.0001)
    }

    func testQuantityMultipliesExposure() {
        // Four copies of a $50 card is $200 of exposure. Treating it as $50
        // understates concentration in exactly the case that matters.
        let r = service.analyze([card(value: 50, quantity: 4)])
        XCTAssertEqual(r.totalValue, 200, accuracy: 0.001)
    }

    func testSoldHoldingsAreExcluded() {
        let r = service.analyze([card(value: 100), card(value: 999, status: "sold")])
        XCTAssertEqual(r.totalValue, 100, accuracy: 0.001)
        XCTAssertEqual(r.cardCount, 1)
    }

    // MARK: - Status bands

    func testAllocationStatusUsesPercentagePointsNotRatio() {
        // 3 points off a 10% target is on target — a ratio test would call it
        // a 30% miss and scream about the smallest bucket forever.
        XCTAssertEqual(AllocationStatus.from(current: 0.13, target: 0.10), .onTarget)
        XCTAssertEqual(AllocationStatus.from(current: 0.25, target: 0.40), .underweight)
        XCTAssertEqual(AllocationStatus.from(current: 0.40, target: 0.40), .onTarget)
    }

    // MARK: - Score

    func testScoreIsBoundedAndComponentsAreWeightedToOne() {
        let cards = [card(player: "Shohei Ohtani", value: 500), card(year: "1955", value: 300)]
        let r = service.analyze(cards)
        XCTAssertTrue((0...100).contains(r.score.value), "score \(r.score.value) out of range")
        let weight = r.score.components.reduce(0) { $0 + $1.weight }
        XCTAssertEqual(weight, 1.0, accuracy: 0.0001)
    }

    func testDiverseScarcePortfolioOutscoresSpeculativeOne() {
        let strong = [
            card(player: "Shohei Ohtani", parallel: "Gold /50", value: 400, gradeCompany: "PSA", gradeValue: 10),
            card(player: "Aaron Judge", year: "1968", value: 300, gradeCompany: "PSA", gradeValue: 8),
            card(player: "Bobby Witt", parallel: "Orange /25", value: 300, gradeCompany: "PSA", gradeValue: 10),
        ]
        let weak = (0..<3).map { i in
            card(player: "Prospect \(i)", set: "Bowman Chrome Prospects", parallel: "Base", value: 333)
        }
        XCTAssertGreaterThan(service.analyze(strong).score.value, service.analyze(weak).score.value)
    }

    // MARK: - Concentration

    func testSinglePlayerConcentrationIsFlagged() {
        var cards = [card(player: "Shohei Ohtani", value: 800)]
        cards += (0..<4).map { i in card(player: "Other \(i)", value: 50) }

        let r = service.analyze(cards)
        let player = r.concentrations.first { $0.dimension == .player }
        XCTAssertEqual(player?.label, "Shohei Ohtani")
        XCTAssertTrue(player?.isWarning == true)
        XCTAssertEqual(player?.share ?? 0, 0.8, accuracy: 0.01)
    }

    // MARK: - Honesty rails

    func testUnknownScarcityShareIsReported() {
        // Two cards with no readable print run: the screen must be able to say
        // the scarcity read is thin rather than render a confident verdict.
        let r = service.analyze([card(parallel: "Base", value: 100), card(parallel: "Base", value: 100)])
        XCTAssertEqual(r.unknownScarcityValueShare, 1.0, accuracy: 0.001)
    }

    func testEmptyPortfolioReturnsEmptyNotCrash() {
        let r = service.analyze([])
        XCTAssertEqual(r.cardCount, 0)
        XCTAssertEqual(r.totalValue, 0)
        XCTAssertTrue(r.allocations.isEmpty)
    }

    func testZeroCostPortfolioDoesNotDivideByZero() {
        let r = service.analyze([card(cost: 0, value: 100)])
        XCTAssertEqual(r.roi, 0, accuracy: 0.001)
        XCTAssertTrue(r.score.value >= 0)
    }
}
