// PreviewSampleCards.swift
// PortfolioIQ — preview-only sample data.
//
// ⚠️  NEVER inject these into the real ModelContext.
//     Use ONLY in #Preview blocks and dev-mode demo screens.

import Foundation

enum PreviewSampleCards {

    // MARK: - Sample CardItems (in-memory only, NOT persisted)

    static func makeSampleCards() -> [CardItem] {
        [
            {
                let c = CardItem(
                    playerName: "Caden Bodine",
                    isRaw: true,
                    cardTitle: "2024 Bowman Chrome Draft",
                    year: 2024,
                    setName: "Bowman Chrome",
                    cardNumber: "BDC-45",
                    purchasePrice: 12.50,
                    currentValue: 18.00
                )
                return c
            }(),
            {
                let c = CardItem(
                    playerName: "Paul Skenes",
                    isRaw: false,
                    cardTitle: "2023 Bowman Chrome Auto PSA 10",
                    year: 2023,
                    setName: "Bowman Chrome",
                    cardNumber: "BCP-1",
                    parallel: "Refractor",
                    gradingCompany: "PSA",
                    grade: "10",
                    certNumber: "99887766",
                    purchasePrice: 850,
                    currentValue: 1200
                )
                return c
            }(),
            {
                let c = CardItem(
                    playerName: "Victor Wembanyama",
                    isRaw: false,
                    cardTitle: "2023 Prizm Draft Picks Silver",
                    year: 2023,
                    setName: "Prizm Draft Picks",
                    cardNumber: "1",
                    parallel: "Silver",
                    gradingCompany: "BGS",
                    grade: "9.5",
                    certNumber: "0012345678",
                    purchasePrice: 600,
                    currentValue: 900
                )
                return c
            }(),
            {
                let c = CardItem(
                    playerName: "Shohei Ohtani",
                    isRaw: true,
                    cardTitle: "2018 Topps Chrome Rookie",
                    year: 2018,
                    setName: "Topps Chrome",
                    cardNumber: "150",
                    purchasePrice: 75,
                    currentValue: 110
                )
                return c
            }(),
        ]
    }

    // MARK: - Sample SaleRecords (preview only)

    static func makeSampleSaleRecord(costBasis: Double = 75) -> CardSaleRecord {
        CardSaleRecord(
            salePrice: 130,
            saleDate: Calendar.current.date(byAdding: .day, value: -14, to: Date())!,
            fees: 13,
            shippingCost: 5,
            sellingPlatform: "eBay",
            costBasisAtSale: costBasis
        )
    }
}
