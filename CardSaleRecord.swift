// CardSaleRecord.swift
// PortfolioIQ — sale record stored when a card is marked sold.
// One-to-one with CardItem via @Relationship(inverse: \CardItem.saleRecord).

import Foundation
import SwiftData

@Model
final class CardSaleRecord {

    var salePrice: Double
    var saleDate: Date
    var fees: Double
    var shippingCost: Double
    var sellingPlatform: String    // "eBay", "Whatnot", "PWCC", etc.
    var createdAt: Date

    // Stored at save time so history is immutable even if card cost changes
    var costBasisAtSale: Double
    var netProceeds: Double        // salePrice - fees - shippingCost
    var netProfit: Double          // netProceeds - costBasisAtSale
    var roi: Double                // percentage

    init(
        salePrice: Double,
        saleDate: Date = Date(),
        fees: Double = 0,
        shippingCost: Double = 0,
        sellingPlatform: String = "",
        costBasisAtSale: Double
    ) {
        self.salePrice        = salePrice
        self.saleDate         = saleDate
        self.fees             = fees
        self.shippingCost     = shippingCost
        self.sellingPlatform  = sellingPlatform
        self.costBasisAtSale  = costBasisAtSale
        self.netProceeds      = salePrice - fees - shippingCost
        self.netProfit        = self.netProceeds - costBasisAtSale
        self.roi              = costBasisAtSale > 0 ? (self.netProfit / costBasisAtSale) * 100 : 0
        self.createdAt        = Date()
    }
}
