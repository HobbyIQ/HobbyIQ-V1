// CardItem.swift
// PortfolioIQ — real local card model backed by SwiftData.
// Mock/preview data lives in PreviewSampleCards.swift only.

import Foundation
import SwiftData

// MARK: - CardItem (SwiftData @Model)

@Model
final class CardItem {

    // MARK: Required fields
    var playerName: String      // at minimum a name is required
    var isRaw: Bool             // true = raw, false = graded

    // MARK: Card details (all optional)
    var cardTitle: String       // custom title; defaults to playerName if blank
    var year: Int?
    var setName: String
    var cardNumber: String
    var parallel: String
    var serialNumber: String    // e.g. "47/99"
    var isAuto: Bool            // true = autograph

    // MARK: Grading (populated only when !isRaw)
    var gradingCompany: String  // "PSA", "BGS", "SGC", "CGC", etc.
    var grade: String           // "10", "9.5", "9", etc.
    var certNumber: String

    // MARK: Financial
    var purchasePrice: Double
    var currentValue: Double

    // MARK: Status
    var status: String          // CardStatus.rawValue

    // MARK: Notes
    var notes: String

    // MARK: Photos — auto-resolved from playerName/year/set/cardNumber
    // and any user-attached images. Stored as URL strings (remote https URLs
    // for resolved images, file:// URLs for local user uploads).
    // Additive default = [] keeps SwiftData migration safe for existing rows.
    var photoURLs: [String] = []

    // MARK: eBay listing — populated by ListingComposerView after publish.
    // Additive defaults keep SwiftData migration safe for existing rows.
    var ebayListingId: String = ""
    var ebayListingURL: String = ""
    var ebayListingStatus: String = ""   // "" | "listed" | "sold" | "ended"

    // MARK: Timestamps
    var createdAt: Date
    var updatedAt: Date

    // MARK: Sale info — populated when status is .sold
    @Relationship(deleteRule: .cascade)
    var saleRecord: CardSaleRecord?

    // MARK: Init
    init(
        playerName: String,
        isRaw: Bool = true,
        cardTitle: String = "",
        year: Int? = nil,
        setName: String = "",
        cardNumber: String = "",
        parallel: String = "",
        serialNumber: String = "",
        isAuto: Bool = false,
        gradingCompany: String = "",
        grade: String = "",
        certNumber: String = "",
        purchasePrice: Double = 0,
        currentValue: Double = 0,
        status: String = CardStatus.owned.rawValue,
        notes: String = ""
    ) {
        self.playerName     = playerName
        self.isRaw          = isRaw
        self.cardTitle      = cardTitle
        self.year           = year
        self.setName        = setName
        self.cardNumber     = cardNumber
        self.parallel       = parallel
        self.serialNumber   = serialNumber
        self.isAuto         = isAuto
        self.gradingCompany = gradingCompany
        self.grade          = grade
        self.certNumber     = certNumber
        self.purchasePrice  = purchasePrice
        self.currentValue   = currentValue > 0 ? currentValue : purchasePrice
        self.status         = status
        self.notes          = notes
        self.createdAt      = Date()
        self.updatedAt      = Date()
    }

    // MARK: Computed helpers

    /// Title shown in lists; falls back to playerName when cardTitle is blank.
    var displayTitle: String {
        cardTitle.isEmpty ? playerName : cardTitle
    }

    /// Short descriptor line: "2022 • Bowman Chrome • #BCP-101 • Auto"
    var shortDescription: String {
        var parts: [String] = []
        if let y = year { parts.append(String(y)) }
        if !setName.isEmpty { parts.append(setName) }
        if !cardNumber.isEmpty { parts.append("#\(cardNumber)") }
        if !parallel.isEmpty { parts.append(parallel) }
        if isAuto { parts.append("Auto") }
        return parts.isEmpty ? (isRaw ? "Raw" : gradingCompany + " " + grade) : parts.joined(separator: " • ")
    }

    var cardStatus: CardStatus {
        get { CardStatus(rawValue: status) ?? .owned }
        set { status = newValue.rawValue; updatedAt = Date() }
    }

    var gainLoss: Double { currentValue - purchasePrice }
    var gainLossPct: Double {
        guard purchasePrice > 0 else { return 0 }
        return (gainLoss / purchasePrice) * 100
    }
    var isSold: Bool { cardStatus == .sold }
}
