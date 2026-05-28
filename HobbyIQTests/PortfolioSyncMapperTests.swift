//
//  PortfolioSyncMapperTests.swift
//  HobbyIQTests
//

import Foundation
import XCTest
@testable import HobbyIQ

@MainActor
final class PortfolioSyncMapperTests: XCTestCase {

    // MARK: - mapCardItemToHolding

    func testMapCardItemToHoldingMapsAllFields() {
        let card = CardItem(
            playerName: "Roman Anthony",
            isRaw: false,
            cardTitle: "2024 Bowman Chrome",
            year: 2024,
            setName: "Bowman Chrome",
            parallel: "Blue Shimmer",
            isAuto: true,
            gradingCompany: "PSA",
            grade: "10",
            purchasePrice: 85.0,
            currentValue: 120.0,
            status: CardStatus.owned.rawValue,
            notes: "Great card"
        )
        card.photoURLs = ["https://example.com/front.jpg"]
        card.clientId = "test-client-id"

        let holding = PortfolioSyncService.mapCardItemToHolding(card)

        XCTAssertEqual(holding.playerName, "Roman Anthony")
        XCTAssertEqual(holding.cardName, "2024 Bowman Chrome")
        XCTAssertEqual(holding.cost, 85.0)
        XCTAssertEqual(holding.currentValue, 120.0)
        XCTAssertEqual(holding.status, "owned")
        XCTAssertEqual(holding.year, "2024")
        XCTAssertEqual(holding.setName, "Bowman Chrome")
        XCTAssertEqual(holding.parallel, "Blue Shimmer")
        XCTAssertEqual(holding.grade, "10")
        XCTAssertEqual(holding.isAuto, true)
        XCTAssertEqual(holding.notes, "Great card")
        XCTAssertEqual(holding.photos, ["https://example.com/front.jpg"])
        XCTAssertEqual(holding.clientId, "test-client-id")
    }

    func testMapCardItemToHoldingFallsBackToPlayerNameWhenTitleEmpty() {
        let card = CardItem(playerName: "Mike Trout")

        let holding = PortfolioSyncService.mapCardItemToHolding(card)

        XCTAssertEqual(holding.cardName, "Mike Trout")
    }

    func testMapCardItemToHoldingClearsGradeForRawCards() {
        let card = CardItem(playerName: "Test", isRaw: true, grade: "10")

        let holding = PortfolioSyncService.mapCardItemToHolding(card)

        XCTAssertEqual(holding.grade, "")
    }

    func testMapCardItemToHoldingOmitsEmptyPhotos() {
        let card = CardItem(playerName: "Test")

        let holding = PortfolioSyncService.mapCardItemToHolding(card)

        XCTAssertNil(holding.photos)
    }

    // MARK: - mapHoldingToNewCardItem

    func testMapHoldingToNewCardItemMapsAllFields() {
        let holding = InventoryCard(
            playerName: "Max Clark",
            cardName: "2024 Bowman 1st",
            cost: 50.0,
            currentValue: 75.0,
            status: "owned",
            year: "2024",
            setName: "Bowman",
            parallel: "Paper",
            grade: "9",
            notes: "Mint",
            isAuto: false,
            photos: ["https://example.com/img.jpg"],
            clientId: "server-client-id"
        )

        let card = PortfolioSyncService.mapHoldingToNewCardItem(holding)

        XCTAssertEqual(card.playerName, "Max Clark")
        XCTAssertEqual(card.cardTitle, "2024 Bowman 1st")
        XCTAssertEqual(card.purchasePrice, 50.0)
        XCTAssertEqual(card.currentValue, 75.0)
        XCTAssertEqual(card.status, "owned")
        XCTAssertEqual(card.year, 2024)
        XCTAssertEqual(card.setName, "Bowman")
        XCTAssertEqual(card.parallel, "Paper")
        XCTAssertEqual(card.grade, "9")
        XCTAssertFalse(card.isRaw)
        XCTAssertFalse(card.isAuto)
        XCTAssertEqual(card.notes, "Mint")
        XCTAssertEqual(card.photoURLs, ["https://example.com/img.jpg"])
        XCTAssertEqual(card.clientId, "server-client-id")
        XCTAssertEqual(card.serverHoldingId, holding.id.uuidString)
    }

    func testMapHoldingToNewCardItemSetsIsRawWhenGradeEmpty() {
        let holding = InventoryCard(
            playerName: "Test",
            cardName: "Test Card",
            cost: 10.0,
            currentValue: 10.0,
            status: "owned",
            grade: ""
        )

        let card = PortfolioSyncService.mapHoldingToNewCardItem(holding)

        XCTAssertTrue(card.isRaw)
    }

    // MARK: - updateCardItem

    func testUpdateCardItemOverwritesAllFieldsWhenNoPendingSync() {
        let card = CardItem(playerName: "Old Name")
        card.pendingSyncFields = []

        let holding = InventoryCard(
            playerName: "New Name",
            cardName: "New Title",
            cost: 100.0,
            currentValue: 200.0,
            status: "listed",
            year: "2025",
            setName: "Chrome",
            parallel: "Gold",
            grade: "10",
            notes: "Updated",
            isAuto: true,
            photos: ["https://example.com/new.jpg"]
        )

        PortfolioSyncService.updateCardItem(card, from: holding)

        XCTAssertEqual(card.playerName, "New Name")
        XCTAssertEqual(card.cardTitle, "New Title")
        XCTAssertEqual(card.purchasePrice, 100.0)
        XCTAssertEqual(card.currentValue, 200.0)
        XCTAssertEqual(card.status, "listed")
        XCTAssertEqual(card.year, 2025)
        XCTAssertEqual(card.setName, "Chrome")
        XCTAssertEqual(card.parallel, "Gold")
        XCTAssertEqual(card.grade, "10")
        XCTAssertFalse(card.isRaw)
        XCTAssertTrue(card.isAuto)
        XCTAssertEqual(card.notes, "Updated")
        XCTAssertEqual(card.photoURLs, ["https://example.com/new.jpg"])
    }

    func testUpdateCardItemRespectsUserAuthorityPendingSyncFields() {
        let card = CardItem(playerName: "User Name", purchasePrice: 99.0)
        card.notes = "User notes"
        card.photoURLs = ["local.jpg"]
        card.pendingSyncFields = ["playerName", "purchasePrice", "notes", "photoURLs"]

        let holding = InventoryCard(
            playerName: "Server Name",
            cardName: "Server Title",
            cost: 50.0,
            currentValue: 300.0,
            status: "owned",
            notes: "Server notes",
            photos: ["server.jpg"]
        )

        PortfolioSyncService.updateCardItem(card, from: holding)

        // Pending fields should NOT be overwritten
        XCTAssertEqual(card.playerName, "User Name")
        XCTAssertEqual(card.purchasePrice, 99.0)
        XCTAssertEqual(card.notes, "User notes")
        XCTAssertEqual(card.photoURLs, ["local.jpg"])

        // Server-authoritative fields should always be overwritten
        XCTAssertEqual(card.currentValue, 300.0)
        XCTAssertEqual(card.serverHoldingId, holding.id.uuidString)

        // Non-pending fields should be overwritten
        XCTAssertEqual(card.cardTitle, "Server Title")
        XCTAssertEqual(card.status, "owned")
    }

    func testUpdateCardItemAlwaysOverwritesCurrentValue() {
        let card = CardItem(playerName: "Test", currentValue: 50.0)
        card.pendingSyncFields = ["currentValue"] // even if "pending", currentValue is server-authoritative

        let holding = InventoryCard(
            playerName: "Test",
            cardName: "Test",
            cost: 10.0,
            currentValue: 999.0,
            status: "owned"
        )

        PortfolioSyncService.updateCardItem(card, from: holding)

        XCTAssertEqual(card.currentValue, 999.0)
    }

    // MARK: - InventoryCard Decode — Backend Field Name Fallbacks

    func testDecodeBackendPricingFieldNames() throws {
        let json = """
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "playerName": "Shohei Ohtani",
            "cardName": "2024 Topps Chrome",
            "cost": 50.0,
            "currentValue": 120.0,
            "status": "owned",
            "quickSaleValue": 95.0,
            "premiumValue": 150.0,
            "fairMarketValue": 120.0,
            "confidence": 0.87,
            "verdict": "Hold",
            "freshnessStatus": "Live",
            "isAuto": false
        }
        """.data(using: .utf8)!

        let card = try JSONDecoder().decode(InventoryCard.self, from: json)

        XCTAssertEqual(card.lowValue, 95.0, "quickSaleValue should decode as lowValue")
        XCTAssertEqual(card.highValue, 150.0, "premiumValue should decode as highValue")
        XCTAssertEqual(card.confidence, 0.87)
        XCTAssertEqual(card.method, "Hold", "verdict should decode as method")
        XCTAssertEqual(card.summary, "Live", "freshnessStatus should decode as summary")
        XCTAssertEqual(card.currentValue, 120.0)
    }

    func testDecodeCamelCaseFieldNamesStillWork() throws {
        let json = """
        {
            "id": "22222222-2222-2222-2222-222222222222",
            "playerName": "Mike Trout",
            "cardName": "2023 Topps",
            "cost": 10.0,
            "currentValue": 25.0,
            "status": "owned",
            "lowValue": 20.0,
            "highValue": 30.0,
            "confidence": 0.9,
            "method": "CompIQ",
            "summary": "3 comps used",
            "isAuto": false
        }
        """.data(using: .utf8)!

        let card = try JSONDecoder().decode(InventoryCard.self, from: json)

        XCTAssertEqual(card.lowValue, 20.0)
        XCTAssertEqual(card.highValue, 30.0)
        XCTAssertEqual(card.method, "CompIQ")
        XCTAssertEqual(card.summary, "3 comps used")
    }

    func testDecodeCamelCaseTakesPriorityOverBackendKeys() throws {
        let json = """
        {
            "playerName": "Test",
            "cardName": "Test",
            "cost": 0,
            "currentValue": 100,
            "status": "owned",
            "lowValue": 80.0,
            "quickSaleValue": 70.0,
            "highValue": 120.0,
            "premiumValue": 130.0,
            "method": "CompIQ",
            "verdict": "Sell",
            "summary": "Fresh",
            "freshnessStatus": "Live",
            "isAuto": false
        }
        """.data(using: .utf8)!

        let card = try JSONDecoder().decode(InventoryCard.self, from: json)

        XCTAssertEqual(card.lowValue, 80.0, "camelCase lowValue should win over quickSaleValue")
        XCTAssertEqual(card.highValue, 120.0, "camelCase highValue should win over premiumValue")
        XCTAssertEqual(card.method, "CompIQ", "camelCase method should win over verdict")
        XCTAssertEqual(card.summary, "Fresh", "camelCase summary should win over freshnessStatus")
    }

    func testDecodeBackendFieldsNilWhenAbsent() throws {
        let json = """
        {
            "playerName": "Sparse",
            "cardName": "Card",
            "cost": 5.0,
            "currentValue": 10.0,
            "status": "owned",
            "isAuto": false
        }
        """.data(using: .utf8)!

        let card = try JSONDecoder().decode(InventoryCard.self, from: json)

        XCTAssertNil(card.lowValue)
        XCTAssertNil(card.highValue)
        XCTAssertNil(card.confidence)
        XCTAssertNil(card.method)
        XCTAssertNil(card.summary)
    }

    // MARK: - PortfolioLedgerEntry Decode — dismissedAt/dismissedReason

    func testLedgerEntryDecodesDismissFields() throws {
        let json = """
        {
            "id": "ledger-001",
            "playerName": "Test Player",
            "needsReconciliation": true,
            "dismissedAt": "2026-05-27T10:00:00Z",
            "dismissedReason": "Fees confirmed manually"
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(PortfolioLedgerEntry.self, from: json)

        XCTAssertEqual(entry.dismissedAt, "2026-05-27T10:00:00Z")
        XCTAssertEqual(entry.dismissedReason, "Fees confirmed manually")
        XCTAssertEqual(entry.needsReconciliation, true)
    }

    func testLedgerEntryDismissFieldsNilWhenAbsent() throws {
        let json = """
        {
            "id": "ledger-002",
            "playerName": "No Dismiss"
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(PortfolioLedgerEntry.self, from: json)

        XCTAssertNil(entry.dismissedAt)
        XCTAssertNil(entry.dismissedReason)
    }

    // MARK: - LedgerPatchBody Encoding

    func testLedgerPatchBodyEncodesOnlySetFields() throws {
        let body = LedgerPatchBody(
            dismissedAt: .some("2026-05-27T10:00:00Z"),
            dismissedReason: .some("Done")
        )
        let data = try JSONEncoder().encode(body)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(dict["dismissedAt"] as? String, "2026-05-27T10:00:00Z")
        XCTAssertEqual(dict["dismissedReason"] as? String, "Done")
        XCTAssertNil(dict["gradingCost"])
        XCTAssertNil(dict["suppliesCost"])
    }

    func testLedgerPatchBodyEncodesNullForClear() throws {
        let body = LedgerPatchBody(
            dismissedAt: .some(nil),
            dismissedReason: .some(nil)
        )
        let data = try JSONEncoder().encode(body)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertTrue(dict.keys.contains("dismissedAt"))
        XCTAssertTrue(dict["dismissedAt"] is NSNull)
        XCTAssertTrue(dict.keys.contains("dismissedReason"))
        XCTAssertTrue(dict["dismissedReason"] is NSNull)
    }

    func testLedgerPatchBodyOmitsUnsetFields() throws {
        let body = LedgerPatchBody(gradingCost: .some(25.0))
        let data = try JSONEncoder().encode(body)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(dict["gradingCost"] as? Double, 25.0)
        XCTAssertEqual(dict.count, 1, "Only gradingCost should be present")
    }

    func testLedgerPatchResponseDecodes() throws {
        let json = """
        {
            "message": "Entry updated",
            "entry": {
                "id": "ledger-003",
                "playerName": "Test",
                "gradingCost": 25.0,
                "suppliesCost": null,
                "dismissedAt": null,
                "dismissedReason": null
            }
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(LedgerPatchResponse.self, from: json)

        XCTAssertEqual(response.message, "Entry updated")
        XCTAssertEqual(response.entry.id, "ledger-003")
        XCTAssertEqual(response.entry.gradingCost, 25.0)
        XCTAssertNil(response.entry.suppliesCost)
        XCTAssertNil(response.entry.dismissedAt)
    }

    // MARK: - InventoryCard Decode — Prediction + Movement Fields

    func testDecodePredictionAndMovementFields() throws {
        let json = """
        {
            "id": "33333333-3333-3333-3333-333333333333",
            "playerName": "Shohei Ohtani",
            "cardName": "2024 Topps Chrome",
            "cost": 50.0,
            "currentValue": 120.0,
            "status": "owned",
            "isAuto": false,
            "predictedPrice": 135.0,
            "predictedPriceLow": 110.0,
            "predictedPriceHigh": 160.0,
            "predictedPriceMechanism": "CompIQ Regression",
            "predictedPriceUpdatedAt": "2026-05-27T10:00:00Z",
            "fairMarketValue": 120.0,
            "movementDirection": "up",
            "movementComposite": 1.04,
            "movementImpliedPct": 4.0,
            "movementCoverage": "full",
            "movementUpdatedAt": "2026-05-27T09:00:00Z"
        }
        """.data(using: .utf8)!

        let card = try JSONDecoder().decode(InventoryCard.self, from: json)

        XCTAssertEqual(card.predictedPrice, 135.0)
        XCTAssertEqual(card.predictedPriceLow, 110.0)
        XCTAssertEqual(card.predictedPriceHigh, 160.0)
        XCTAssertEqual(card.predictedPriceMechanism, "CompIQ Regression")
        XCTAssertEqual(card.predictedPriceUpdatedAt, "2026-05-27T10:00:00Z")
        XCTAssertEqual(card.fairMarketValue, 120.0)
        XCTAssertEqual(card.movementDirection, "up")
        XCTAssertEqual(card.movementComposite, 1.04)
        XCTAssertEqual(card.movementImpliedPct, 4.0)
        XCTAssertEqual(card.movementCoverage, "full")
        XCTAssertEqual(card.movementUpdatedAt, "2026-05-27T09:00:00Z")
    }

    func testDecodePredictionFieldsNilWhenAbsent() throws {
        let json = """
        {
            "playerName": "Sparse",
            "cardName": "Card",
            "cost": 5.0,
            "currentValue": 10.0,
            "status": "owned",
            "isAuto": false
        }
        """.data(using: .utf8)!

        let card = try JSONDecoder().decode(InventoryCard.self, from: json)

        XCTAssertNil(card.predictedPrice)
        XCTAssertNil(card.predictedPriceLow)
        XCTAssertNil(card.predictedPriceHigh)
        XCTAssertNil(card.predictedPriceMechanism)
        XCTAssertNil(card.predictedPriceUpdatedAt)
        XCTAssertNil(card.fairMarketValue)
        XCTAssertNil(card.movementDirection)
        XCTAssertNil(card.movementComposite)
        XCTAssertNil(card.movementImpliedPct)
        XCTAssertNil(card.movementCoverage)
        XCTAssertNil(card.movementUpdatedAt)
    }

    func testDecodeMovementFieldsBackwardsCompat() throws {
        let json = """
        {
            "id": "44444444-4444-4444-4444-444444444444",
            "playerName": "Mike Trout",
            "cardName": "2021 Topps Chrome",
            "cost": 200.0,
            "currentValue": 175.0,
            "status": "owned",
            "isAuto": false,
            "movementDirection": "down",
            "movementComposite": 0.877,
            "movementImpliedPct": -12.3,
            "movementCoverage": "card_only",
            "movementUpdatedAt": "2026-05-27T08:00:00Z"
        }
        """.data(using: .utf8)!

        let card = try JSONDecoder().decode(InventoryCard.self, from: json)

        XCTAssertEqual(card.movementDirection, "down")
        XCTAssertEqual(card.movementComposite, 0.877)
        XCTAssertEqual(card.movementImpliedPct, -12.3)
        XCTAssertEqual(card.movementCoverage, "card_only")
        XCTAssertNil(card.predictedPrice, "prediction fields should be nil when absent")
        XCTAssertEqual(card.playerName, "Mike Trout")
        XCTAssertEqual(card.currentValue, 175.0)
    }

    // MARK: - CF-AUTOPRICE-GRADE-CANONICAL-MIGRATION
    //
    // Canonical structured grade (gradeCompany + gradeValue as Double)
    // must support both integer PSA grades and decimal BGS/CSG grades.
    // Int? would silently drop the fractional on write AND fail
    // JSONDecode on read for decimal grades.

    func testMapCardItemToHoldingSendsCanonicalPSA10() {
        let card = CardItem(
            playerName: "Mike Trout",
            isRaw: false,
            gradingCompany: "PSA",
            grade: "10"
        )

        let holding = PortfolioSyncService.mapCardItemToHolding(card)

        XCTAssertEqual(holding.gradeCompany, "PSA")
        XCTAssertEqual(holding.gradeValue, 10.0)
        XCTAssertEqual(holding.grade, "10", "legacy display string preserved")
    }

    func testMapCardItemToHoldingSendsCanonicalDecimalBGS95() {
        // CRITICAL: this is the case Int? broke. Double? must preserve 9.5.
        let card = CardItem(
            playerName: "Roman Anthony",
            isRaw: false,
            gradingCompany: "BGS",
            grade: "9.5"
        )

        let holding = PortfolioSyncService.mapCardItemToHolding(card)

        XCTAssertEqual(holding.gradeCompany, "BGS")
        XCTAssertEqual(holding.gradeValue, 9.5, "decimal grade must round-trip without truncation")
        XCTAssertEqual(holding.grade, "9.5")
    }

    func testMapCardItemToHoldingSendsNilCanonicalForRawCards() {
        let card = CardItem(playerName: "Raw Card", isRaw: true)

        let holding = PortfolioSyncService.mapCardItemToHolding(card)

        XCTAssertNil(holding.gradeCompany)
        XCTAssertNil(holding.gradeValue)
        XCTAssertEqual(holding.grade, "", "legacy grade is empty for raw")
    }

    func testMapHoldingToNewCardItemDecodesDecimalGradeValueWithoutCrashing() throws {
        // Backend backfill writes gradeValue: 9.5 (Double) to Cosmos for
        // BGS 9.5 holdings. iOS JSONDecoder must accept the JSON number
        // 9.5 — Int? rejected it with DecodingError.dataCorrupted, breaking
        // sync for any user with a decimal-grade holding.
        let json = """
        {
            "id": "9DFD3000-0000-4000-8000-000000000010",
            "playerName": "Roman Anthony",
            "cardName": "BGS Sample",
            "cost": 100,
            "currentValue": 175,
            "status": "owned",
            "year": "2024",
            "setName": "Bowman Chrome",
            "parallel": "Refractor",
            "grade": "9.5",
            "gradeCompany": "BGS",
            "gradeValue": 9.5
        }
        """.data(using: .utf8)!

        let holding = try JSONDecoder().decode(InventoryCard.self, from: json)
        let card = PortfolioSyncService.mapHoldingToNewCardItem(holding)

        XCTAssertEqual(holding.gradeCompany, "BGS")
        XCTAssertEqual(holding.gradeValue, 9.5)
        XCTAssertEqual(card.gradingCompany, "BGS")
        XCTAssertEqual(card.grade, "9.5", "decimal preserved on display")
        XCTAssertFalse(card.isRaw)
    }

    func testMapHoldingToNewCardItemRendersIntegerDoubleWithoutDotZero() throws {
        // Double 10.0 must display as "10" (matching CardItem.grade
        // legacy String format), not "10.0".
        let json = """
        {
            "id": "9DFD3000-0000-4000-8000-000000000011",
            "playerName": "Mike Trout",
            "cardName": "PSA 10 Sample",
            "cost": 100,
            "currentValue": 200,
            "status": "owned",
            "year": "2021",
            "setName": "Topps Chrome",
            "parallel": "",
            "grade": "10",
            "gradeCompany": "PSA",
            "gradeValue": 10
        }
        """.data(using: .utf8)!

        let holding = try JSONDecoder().decode(InventoryCard.self, from: json)
        let card = PortfolioSyncService.mapHoldingToNewCardItem(holding)

        XCTAssertEqual(card.gradingCompany, "PSA")
        XCTAssertEqual(card.grade, "10", "integer-valued double renders without .0")
    }

    // MARK: - formatGradeValue helper

    func testFormatGradeValueIntegerProducesNoDecimal() {
        XCTAssertEqual(PortfolioSyncService.formatGradeValue(10.0), "10")
        XCTAssertEqual(PortfolioSyncService.formatGradeValue(9.0), "9")
        XCTAssertEqual(PortfolioSyncService.formatGradeValue(1.0), "1")
    }

    func testFormatGradeValueDecimalPreserved() {
        XCTAssertEqual(PortfolioSyncService.formatGradeValue(9.5), "9.5")
        XCTAssertEqual(PortfolioSyncService.formatGradeValue(8.5), "8.5")
    }
}
