//
//  PortfolioSyncMapperTests.swift
//  HobbyIQTests
//

import Foundation
import XCTest
@testable import HobbyIQ

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
}
