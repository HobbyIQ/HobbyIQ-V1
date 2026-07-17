//
//  PortfolioIQModels.swift
//  HobbyIQ
//

import Combine
import Foundation
import SwiftUI
import Charts

typealias PortfolioPeriodStats = SummaryPeriod

struct PortfolioAccountSnapshot: Codable, Hashable {
    let userId: String
    let totalCards: Int
    let totalValue: Double
    let totalCost: Double
    let totalProfitLoss: Double
    let roi: Double
    let generatedAt: String

    var generatedAtFormatted: String {
        portfolioDisplayDate(from: generatedAt)
    }
}

struct PortfolioCardDetail: Codable, Identifiable, Hashable {
    let id: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let purchasePlatform: String?
    let notes: String?
    let lastPricedAt: String?
    let signal: String?
    let format: String?
    let sellReason: String?

    var signalColor: Color {
        portfolioSignalColor(signal, fallback: .gray)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }

    var currentValueFormatted: String {
        portfolioCurrencyString(currentValue)
    }
}

struct PortfolioBestSellCard: Codable, Identifiable, Hashable {
    let id: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let signal: String?
    let format: String?
    let recommendation: String

    var signalColor: Color {
        portfolioSignalColor(signal, fallback: .blue)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }
}

struct PortfolioHeroSummary: Hashable {
    let totalCards: Int
    let totalValue: Double
    let costBasis: Double
    let unrealizedPnL: Double
    let roi: Double
    let lastRefreshText: String
}

// Display-only hero aggregate computed from the holdings array at render
// time. Excludes unpriced holdings (`fairMarketValue == nil`) from the
// displayed dollar figures and reports them as a separate count. Used by
// the InventoryIQ header subtitle and the PortfolioIQ hero VStack so the
// "$X · +Y · Z% ROI" line stays arithmetically honest — the top number,
// the P/L, and the cost-basis subtitle are all reaggregated against the
// priced subset so they reconcile.
//
// Does NOT replace `PortfolioHeroSummary.totalValue`/`unrealizedPnL`/`roi`,
// which keep their cost-proxy-inclusive sums for non-hero consumers
// (DailyIQ rollups, account snapshot, exports, etc.). The seven producer
// sums at PortfolioIQViewModel:681/:755-756, DashboardService:56,
// AppSupport:547, APIService:644, CompatibilityShims:2699/:3027 are
// unchanged so P/L logic and the −100%-loss guard hold.
struct InventoryDisplayAggregate {
    let displayValue: Double
    let displayCost: Double
    let displayPL: Double
    let displayROI: Double
    let totalCards: Int
    let pricedCount: Int
    let unpricedCount: Int
    // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): split the unpriced bucket
    // so the hero subtitle can read "N estimated · M pending" instead of
    // the generic "N unpriced". `displayValue` is unchanged — still
    // observed-only — so Story B's display-only invariant holds. The
    // collection-value card is the surface that includes the estimated
    // bucket in its headline; this split makes the hero's exclusion
    // transparent rather than reframing the aggregate.
    let estimatedCount: Int
    let pendingCount: Int
    // Estimated-inclusive totals: observed FMV × qty for priced cards plus
    // `estimatedValue` × qty for cards flagged `valuationStatus ==
    // "estimated"`. Powers the PortfolioIQ hero so users see the FMV of
    // their whole collection (observed + model-estimated), not just the
    // subset with a live comp. Observed-only `displayValue` is preserved
    // above so Story B callers keep their invariant.
    let displayValueIncludingEstimated: Double
    let displayCostIncludingEstimated: Double
    let displayPLIncludingEstimated: Double
    let displayROIIncludingEstimated: Double

    init(holdings: [InventoryCard]) {
        var value = 0.0
        var cost = 0.0
        var valueIncEst = 0.0
        var costIncEst = 0.0
        var priced = 0
        var estimated = 0
        var pending = 0
        for card in holdings {
            let qty = max(1.0, card.quantity ?? 1.0)
            if let fmv = card.fairMarketValue {
                value += fmv * qty
                cost += card.cost
                valueIncEst += fmv * qty
                costIncEst += card.cost
                priced += 1
            } else if card.valuationStatus == "estimated" {
                if let est = card.estimatedValue, est > 0 {
                    valueIncEst += est * qty
                    costIncEst += card.cost
                }
                estimated += 1
            } else {
                // "pending", "observed" with nil fmv (backend reclassifies
                // these as pending in computeSnapshotFromHoldings), or a
                // legacy/null wire row that pre-dates Step 1 — all bucket
                // as pending so the four-bucket arithmetic stays clean:
                // priced + estimated + pending = totalCards.
                pending += 1
            }
        }
        self.displayValue = value
        self.displayCost = cost
        self.displayPL = value - cost
        self.displayROI = cost > 0 ? ((value - cost) / cost) * 100 : 0
        self.displayValueIncludingEstimated = valueIncEst
        self.displayCostIncludingEstimated = costIncEst
        self.displayPLIncludingEstimated = valueIncEst - costIncEst
        self.displayROIIncludingEstimated = costIncEst > 0
            ? ((valueIncEst - costIncEst) / costIncEst) * 100
            : 0
        self.totalCards = holdings.count
        self.pricedCount = priced
        self.estimatedCount = estimated
        self.pendingCount = pending
        self.unpricedCount = estimated + pending
    }

    /// Subtitle suffix used by the InventoryIQ + PortfolioIQ heroes. Splits
    /// when both buckets are present so the user sees the why behind the
    /// excluded count. Empty when nothing is unpriced.
    var unpricedSubtitleSuffix: String {
        switch (estimatedCount, pendingCount) {
        case (0, 0):
            return ""
        case (let e, 0):
            return " · \(e) estimated"
        case (0, let p):
            return " · \(p) pending"
        case (let e, let p):
            return " · \(e) estimated · \(p) pending"
        }
    }
}

enum PortfolioPriorityActionKind: String, Hashable {
    case sellWatch
    case highRisk
    case stalePricing
}

struct PortfolioPriorityAction: Identifiable, Hashable {
    let id: String
    let kind: PortfolioPriorityActionKind
    let title: String
    let subtitle: String
    let detail: String
    let cardCount: Int
}

struct PortfolioMover: Identifiable, Hashable {
    // CF-IOS-DIRECTION-SWEEP (2026-06-18): PortfolioMover stripped to
    // P/L-only. The prior shape carried movementDirection / impliedPct /
    // composite / dollarImpact / coverage to feed the now-removed
    // movement-branch sort + render. profitLoss + trendLabel /
    // trendDetail are sufficient under the P/L-always ranking.
    let id: String
    let playerName: String
    let cardName: String
    let currentValue: Double
    let profitLoss: Double
    let trendLabel: String
    let trendDetail: String
    /// CF-PORTFOLIO-MOVER-THUMB (2026-07-05): resolved image URL for the
    /// mover row's thumbnail. Populated from the source holding's
    /// `imageFrontUrl ?? catalogImageUrl` so the portfolio Top Movers
    /// list finally shows card art alongside player/name/PL.
    let imageUrl: String?
    /// CF-ACTION-BADGES (2026-07-06, backend §1): per-holding seller
    /// verdict passed through from the source InventoryCard.
    let actionRecommendation: CardPanelGradeEntry.ActionRecommendation?

    init(
        id: String,
        playerName: String,
        cardName: String,
        currentValue: Double,
        profitLoss: Double,
        trendLabel: String,
        trendDetail: String,
        imageUrl: String? = nil,
        actionRecommendation: CardPanelGradeEntry.ActionRecommendation? = nil
    ) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.currentValue = currentValue
        self.profitLoss = profitLoss
        self.trendLabel = trendLabel
        self.trendDetail = trendDetail
        self.imageUrl = imageUrl
        self.actionRecommendation = actionRecommendation
    }
}



// MARK: - Ledger Response Envelope

struct PortfolioLedgerResponse: Codable {
    let userId: String?
    let count: Int?
    let totals: PortfolioLedgerTotals?
    let entries: [PortfolioLedgerEntry]?
}

struct PortfolioLedgerTotals: Codable, Hashable {
    let realizedProfitLoss: Double?
    let grossProceeds: Double?
    let netProceeds: Double?
    let costBasisSold: Double?
}

// MARK: - Ledger Entry

struct PortfolioLedgerEntry: Identifiable, Hashable, Codable {
    let id: String
    let playerName: String
    let cardTitle: String?
    let quantitySold: Int?
    let unitSalePrice: Double?
    let grossProceeds: Double?
    let fees: Double?
    let tax: Double?
    let shipping: Double?
    let netProceeds: Double?
    let costBasisSold: Double?
    let realizedProfitLoss: Double?
    let realizedProfitLossPct: Double?
    let soldAt: String?
    let notes: String?

    let source: String?
    let ebayOrderId: String?
    let needsReconciliation: Bool?

    let finalValueFee: Double?
    let paymentProcessingFee: Double?
    let promotedListingFee: Double?
    let adFee: Double?
    let otherFees: Double?
    let netPayout: Double?
    let actualShippingCost: Double?
    let suppliesCost: Double?
    let gradingCost: Double?
    let dismissedAt: String?
    let dismissedReason: String?

    // CF-EBAY-BROWSE-ENRICHMENT (backend PRs #384/#385): sale-side
    // ledger entries carry the same Browse-enriched fields as
    // holdings. `ebaySoldImages[]` is the SELL-side listing photo
    // gallery (a sold-comp preview of what future buyers will see).
    let enrichedFromEbay: Bool?
    let ebayItemAspects: [String: String]?
    let ebayImageUrl: String?
    let ebaySoldImages: [String]?
    let ebayShortDescription: String?
    let ebayCategoryPath: String?
    let ebaySellerUsername: String?

    private let _dateTextOverride: String?

    var cardName: String { cardTitle ?? "" }
    var salePrice: Double { unitSalePrice ?? grossProceeds ?? 0 }
    var profit: Double { realizedProfitLoss ?? 0 }
    var isEbaySource: Bool { source == "ebay" }

    var dateText: String {
        if let override = _dateTextOverride { return override }
        guard let soldAt, !soldAt.isEmpty else { return "" }
        let fmtFrac = ISO8601DateFormatter()
        fmtFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmtStd = ISO8601DateFormatter()
        fmtStd.formatOptions = [.withInternetDateTime]
        guard let date = fmtFrac.date(from: soldAt) ?? fmtStd.date(from: soldAt) else {
            return soldAt
        }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    var totalGranularFees: Double? {
        let known: [Double] = [finalValueFee, paymentProcessingFee, promotedListingFee, adFee, otherFees, actualShippingCost].compactMap { $0 }
        return known.isEmpty ? nil : known.reduce(0, +)
    }

    var hasAnyNullFee: Bool {
        guard isEbaySource else { return false }
        return finalValueFee == nil || paymentProcessingFee == nil
    }

    init(fromSale sale: Sale, index: Int) {
        self.id = "ledger-\(index)-\(sale.id.uuidString)"
        self.playerName = sale.playerName
        self.cardTitle = sale.cardName
        self.unitSalePrice = sale.salePrice
        self.grossProceeds = sale.salePrice
        self.fees = sale.fees
        self.realizedProfitLoss = sale.profit
        self._dateTextOverride = sale.saleDateFormatted
        self.quantitySold = nil
        self.tax = nil
        self.shipping = nil
        self.netProceeds = nil
        self.costBasisSold = nil
        self.realizedProfitLossPct = nil
        self.soldAt = nil
        self.notes = nil
        self.source = nil
        self.ebayOrderId = nil
        self.needsReconciliation = nil
        self.finalValueFee = nil
        self.paymentProcessingFee = nil
        self.promotedListingFee = nil
        self.adFee = nil
        self.otherFees = nil
        self.netPayout = nil
        self.actualShippingCost = nil
        self.suppliesCost = nil
        self.gradingCost = nil
        self.dismissedAt = nil
        self.dismissedReason = nil
        self.enrichedFromEbay = nil
        self.ebayItemAspects = nil
        self.ebayImageUrl = nil
        self.ebaySoldImages = nil
        self.ebayShortDescription = nil
        self.ebayCategoryPath = nil
        self.ebaySellerUsername = nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, playerName, cardTitle, quantitySold, unitSalePrice
        case grossProceeds, fees, tax, shipping, netProceeds
        case costBasisSold, realizedProfitLoss, realizedProfitLossPct
        case soldAt, notes, source, ebayOrderId, needsReconciliation
        case finalValueFee, paymentProcessingFee, promotedListingFee
        case adFee, otherFees, netPayout, actualShippingCost
        case suppliesCost, gradingCost
        case dismissedAt, dismissedReason
        // CF-EBAY-BROWSE-ENRICHMENT (backend PRs #384/#385)
        case enrichedFromEbay, ebayItemAspects, ebayImageUrl, ebaySoldImages
        case ebayShortDescription, ebayCategoryPath, ebaySellerUsername
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        playerName = (try? c.decodeIfPresent(String.self, forKey: .playerName)) ?? ""
        cardTitle = try? c.decodeIfPresent(String.self, forKey: .cardTitle)
        quantitySold = try? c.decodeIfPresent(Int.self, forKey: .quantitySold)
        unitSalePrice = try? c.decodeIfPresent(Double.self, forKey: .unitSalePrice)
        grossProceeds = try? c.decodeIfPresent(Double.self, forKey: .grossProceeds)
        fees = try? c.decodeIfPresent(Double.self, forKey: .fees)
        tax = try? c.decodeIfPresent(Double.self, forKey: .tax)
        shipping = try? c.decodeIfPresent(Double.self, forKey: .shipping)
        netProceeds = try? c.decodeIfPresent(Double.self, forKey: .netProceeds)
        costBasisSold = try? c.decodeIfPresent(Double.self, forKey: .costBasisSold)
        realizedProfitLoss = try? c.decodeIfPresent(Double.self, forKey: .realizedProfitLoss)
        realizedProfitLossPct = try? c.decodeIfPresent(Double.self, forKey: .realizedProfitLossPct)
        soldAt = try? c.decodeIfPresent(String.self, forKey: .soldAt)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        ebayOrderId = try? c.decodeIfPresent(String.self, forKey: .ebayOrderId)
        needsReconciliation = try? c.decodeIfPresent(Bool.self, forKey: .needsReconciliation)
        finalValueFee = try? c.decodeIfPresent(Double.self, forKey: .finalValueFee)
        paymentProcessingFee = try? c.decodeIfPresent(Double.self, forKey: .paymentProcessingFee)
        promotedListingFee = try? c.decodeIfPresent(Double.self, forKey: .promotedListingFee)
        adFee = try? c.decodeIfPresent(Double.self, forKey: .adFee)
        otherFees = try? c.decodeIfPresent(Double.self, forKey: .otherFees)
        netPayout = try? c.decodeIfPresent(Double.self, forKey: .netPayout)
        actualShippingCost = try? c.decodeIfPresent(Double.self, forKey: .actualShippingCost)
        suppliesCost = try? c.decodeIfPresent(Double.self, forKey: .suppliesCost)
        gradingCost = try? c.decodeIfPresent(Double.self, forKey: .gradingCost)
        dismissedAt = try? c.decodeIfPresent(String.self, forKey: .dismissedAt)
        dismissedReason = try? c.decodeIfPresent(String.self, forKey: .dismissedReason)
        enrichedFromEbay = try? c.decodeIfPresent(Bool.self, forKey: .enrichedFromEbay)
        ebayItemAspects = try? c.decodeIfPresent([String: String].self, forKey: .ebayItemAspects)
        ebayImageUrl = try? c.decodeIfPresent(String.self, forKey: .ebayImageUrl)
        ebaySoldImages = try? c.decodeIfPresent([String].self, forKey: .ebaySoldImages)
        ebayShortDescription = try? c.decodeIfPresent(String.self, forKey: .ebayShortDescription)
        ebayCategoryPath = try? c.decodeIfPresent(String.self, forKey: .ebayCategoryPath)
        ebaySellerUsername = try? c.decodeIfPresent(String.self, forKey: .ebaySellerUsername)
        _dateTextOverride = nil
    }
}

// MARK: - Ledger PATCH

struct LedgerPatchBody: Encodable {
    var gradingCost: Double??
    var suppliesCost: Double??
    var dismissedAt: String??
    var dismissedReason: String??

    private enum CodingKeys: String, CodingKey {
        case gradingCost, suppliesCost, dismissedAt, dismissedReason
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let v = gradingCost { try container.encode(v, forKey: .gradingCost) }
        if let v = suppliesCost { try container.encode(v, forKey: .suppliesCost) }
        if let v = dismissedAt { try container.encode(v, forKey: .dismissedAt) }
        if let v = dismissedReason { try container.encode(v, forKey: .dismissedReason) }
    }
}

struct LedgerPatchResponse: Decodable {
    let message: String
    let entry: PortfolioLedgerEntry
}

/// CF-IOS-NEAREST-GRADED-ANCHOR-UI-V2 (2026-06-30): view-layer helpers on
/// the wire struct. Kept in the view file (per Q3) so the Codable struct
/// stays pure wire data. `shortAge` powers the row's compact "8 mo ago"
/// caption; `longAge` powers the detail sheet's "8 months ago". Tint and
/// band labels drive the confidence-tier styling.
extension NearestGradedAnchor {
    var tintColor: Color {
        if confidence >= 0.5 { return HobbyIQTheme.Colors.mutedText }
        if confidence >= 0.3 { return .orange }
        return .red
    }

    /// "solid" / "rough" / "ballpark" — one-word confidence band label used
    /// in the detail-sheet Source subsection ("… · ballpark confidence").
    var confidenceBand: String {
        if confidence >= 0.5 { return "solid" }
        if confidence >= 0.3 { return "rough" }
        return "ballpark"
    }

    /// Compact form for the inventory row. Per CF: <30 → "N days ago",
    /// <365 → "N mo ago" (floor(days/30)), >=365 → "Y yr ago".
    /// `daysOld == 0` short-circuits to "today" so 0/1 both read
    /// naturally.
    var shortAge: String {
        if daysOld <= 0 { return "today" }
        if daysOld < 30 { return "\(daysOld) days ago" }
        if daysOld < 365 { return "\(daysOld / 30) mo ago" }
        return "\(daysOld / 365) yr ago"
    }

    /// Long form for the detail-sheet Source line. Same buckets as
    /// `shortAge` but uses "months"/"years" for legibility in a full
    /// sentence context.
    var longAge: String {
        if daysOld <= 0 { return "today" }
        if daysOld < 30 { return "\(daysOld) days ago" }
        if daysOld < 365 {
            let months = daysOld / 30
            return months == 1 ? "1 month ago" : "\(months) months ago"
        }
        let years = daysOld / 365
        return years == 1 ? "1 year ago" : "\(years) years ago"
    }

    /// Comp-count phrase for the Source subsection. 1 → "1 comp",
    /// N>1 → "N comps".
    var compCountPhrase: String {
        sampleSize == 1 ? "1 comp" : "\(sampleSize) comps"
    }
}

extension InventoryCard {
    /// Composed display title for the detail page. Prefers the stored
    /// `cardName` when populated; otherwise composes from year + setName +
    /// playerName + parallel so legacy holdings (added before iOS sent
    /// `cardTitle` on the wire) still surface a readable heading.
    var fullDisplayName: String {
        let stored = cardName.trimmingCharacters(in: .whitespacesAndNewlines)
        if stored.isEmpty == false { return stored }
        let parts: [String] = [year, setName, playerName, parallel]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }
        if parts.isEmpty { return playerName.isEmpty ? "Card Details" : playerName }
        return parts.joined(separator: " ")
    }

    /// Year for the Card Details row. Returns the stored `year` when
    /// populated; otherwise extracts the first 4-digit year from
    /// `cardName` ("2026 Bowman Baseball Eric Hartman …" → "2026") so
    /// holdings whose structured `year` field never landed still surface
    /// the year on the detail page.
    var displayYear: String {
        let stored = year.trimmingCharacters(in: .whitespacesAndNewlines)
        if stored.isEmpty == false { return stored }
        let title = cardName.trimmingCharacters(in: .whitespacesAndNewlines)
        if let match = title.range(of: #"(?:19|20)\d{2}"#, options: .regularExpression) {
            return String(title[match])
        }
        return ""
    }

    /// Set name for the Card Details row. Returns the stored `setName`
    /// when populated; otherwise derives "everything between the year and
    /// the player name" from `cardName`. Conservative: if the player name
    /// isn't found inside the title (or the title lacks a year), returns
    /// empty so the row shows "—" instead of a misleading slice.
    var displaySet: String {
        let stored = setName.trimmingCharacters(in: .whitespacesAndNewlines)
        if stored.isEmpty == false { return stored }
        let title = cardName.trimmingCharacters(in: .whitespacesAndNewlines)
        let player = playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard title.isEmpty == false, player.isEmpty == false else { return "" }
        guard let yearRange = title.range(of: #"(?:19|20)\d{2}"#, options: .regularExpression) else { return "" }
        guard let playerRange = title.range(of: player, options: [.caseInsensitive]),
              playerRange.lowerBound > yearRange.upperBound else { return "" }
        let between = title[yearRange.upperBound..<playerRange.lowerBound]
        return between.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var costFormatted: String {
        portfolioCurrencyString(cost)
    }

    var currentValueFormatted: String {
        portfolioCurrencyString(currentValue)
    }

    // Display-only value text matching `currentValue`'s TOTAL magnitude
    // (FMV × quantity). Returns "—" when `fairMarketValue` is nil so the row
    // does not render a cost-proxy dollar number for unpriced holdings.
    // `currentValue` and every P/L derivation are untouched so the
    // −100%-loss guard inside `currentValue`'s cost-proxy fallback still
    // holds. `fairMarketValue == 0` is a genuine price and renders as "$0".
    var displayValueText: String {
        guard let fmv = fairMarketValue else { return "—" }
        let qty = max(1.0, quantity ?? 1.0)
        return inventoryWholeDollarString(fmv * qty)
    }

    /// CF-MARKET-VALUE-EVERYWHERE (2026-07-12): resolves a market value
    /// for the inventory row using the same fall-through the comp card
    /// uses, so no row ever renders "—". Priority mirrors the backend's
    /// no-null-pricing contract: observed FMV → active `currentValue`
    /// → ladder-fallback `estimatedValue` → low/high midpoint → cost.
    /// The `source` lets the view render a subtle qualifier ("Estimated",
    /// "At cost") so the user knows how firm the number is.
    enum MarketValueSource {
        case fmv
        case current
        case estimated
        case midpoint
        case atCost
    }

    var bestKnownMarketValue: (perUnit: Double, source: MarketValueSource)? {
        if let v = fairMarketValue, v > 0 { return (v, .fmv) }
        if currentValue > 0 {
            let perUnit = currentValue / max(1.0, quantity ?? 1.0)
            return (perUnit, .current)
        }
        if let v = estimatedValue, v > 0 { return (v, .estimated) }
        if let lo = lowValue, let hi = highValue, lo > 0 || hi > 0 {
            return ((max(0, lo) + max(0, hi)) / 2, .midpoint)
        }
        if cost > 0 {
            return (cost / max(1.0, quantity ?? 1.0), .atCost)
        }
        return nil
    }

    var displayValueFormatted: String {
        guard let fmv = fairMarketValue else { return "—" }
        let qty = max(1.0, quantity ?? 1.0)
        return portfolioCurrencyString(fmv * qty)
    }

    /// CF-IOS-NEAREST-GRADED-ANCHOR-UI (2026-06-29): variant of
    /// `displayValueFormatted` that falls back to `estimatedValue` with a
    /// leading tilde when fairMarketValue is absent. Used by the Card
    /// Details "Fair Market" row so ladder-rescued holdings show their
    /// number instead of `—`.
    var fairMarketValueDisplay: String {
        if let fmv = fairMarketValue {
            let qty = max(1.0, quantity ?? 1.0)
            return portfolioCurrencyString(fmv * qty)
        }
        if let estimated = estimatedValue, estimated > 0 {
            let qty = max(1.0, quantity ?? 1.0)
            return "~" + portfolioCurrencyString(estimated * qty)
        }
        return "—"
    }

    var isUnpriced: Bool { fairMarketValue == nil }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(cost > 0 ? (profitLoss / cost) * 100 : 0)
    }

    var purchaseDateFormatted: String {
        portfolioDisplayDate(from: purchaseDate ?? "")
    }

    var purchasePlatformText: String {
        guard let purchasePlatform else { return "—" }
        let trimmed = purchasePlatform.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "—" : trimmed
    }

    var statusChipText: String {
        let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Active"
        }
        return trimmed
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    var gradeChipText: String {
        let trimmed = grade.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Raw" : trimmed
    }

    var trendChipText: String {
        switch profitLoss {
        case ..<0:
            return "Down"
        case 0:
            return "Flat"
        default:
            return "Up"
        }
    }

    var freshnessChipText: String {
        if let confidence {
            switch confidence {
            case 0.8...:
                return "Fresh"
            case 0.6..<0.8:
                return "Review"
            default:
                return Labels.stale
            }
        }

        if method?.isEmpty == false || summary?.isEmpty == false {
            return "Synced"
        }

        return Labels.stale
    }

    var dailyTrendBadgeText: String? {
        switch profitLoss {
        case ..<0:
            return "DailyIQ Watch"
        case 0:
            return nil
        default:
            return "DailyIQ Trend"
        }
    }

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): movementIsStale,
    // movementIsExpired, shouldShowMovementChip, movementChipText,
    // movementChipColor, dollarImpact, predictedPriceFormatted,
    // movementCoverageLabel all removed — every consumer was a
    // direction render site stripped in this same CF.

    var fairMarketValueFormatted: String? {
        fairMarketValue.map { portfolioCurrencyString($0) }
    }

    var costBasisImpactFormatted: String {
        portfolioCurrencyString(cost)
    }

    var profitPercentFormatted: String {
        portfolioSignedPercentString(cost > 0 ? (profitLoss / cost) * 100 : 0)
    }

    var expectedDaysToSellText: String {
        switch status.lowercased() {
        case "sell_now", "sell now", "sell":
            return "1-7 days"
        case "watch":
            return "7-14 days"
        case "hold":
            return "14-30 days"
        default:
            if profitLoss < 0 {
                return "7-14 days"
            }
            return "14-21 days"
        }
    }

    var actionabilityBullets: [String] {
        var bullets: [String] = []

        if let summary, summary.isEmpty == false {
            bullets.append(summary)
        }

        if let method, method.isEmpty == false {
            bullets.append("Method: \(method)")
        }

        if let notes, notes.isEmpty == false {
            bullets.append(notes)
        }

        if bullets.isEmpty {
            bullets.append("No extra explanation provided yet.")
        }

        return bullets
    }
}

extension PortfolioInventorySummary {
    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(totalProfitLoss)
    }

    var totalValueFormatted: String {
        portfolioCurrencyString(totalCurrentValue)
    }

    var totalCostFormatted: String {
        portfolioCurrencyString(totalCost)
    }
}

extension SummaryPeriod {
    var netProfitFormatted: String {
        portfolioSignedCurrencyString(netProfit ?? totalProfit)
    }

    var marginFormatted: String {
        Labels.marginFormatted(margin)
    }

    var totalSoldFormatted: String {
        portfolioCurrencyString(totalSold)
    }

    var totalExpensesFormatted: String {
        portfolioCurrencyString(totalExpenses ?? 0)
    }

    var currentValueFormatted: String {
        portfolioCurrencyString(totalSold + (netProfit ?? totalProfit))
    }
}

extension Sale {
    var saleDateFormatted: String {
        date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    var salePriceFormatted: String {
        portfolioCurrencyString(salePrice)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profit)
    }
}

extension Double {
    var portfolioCurrencyText: String {
        formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
    }

    var portfolioSignedCurrencyText: String {
        let amount = abs(self).formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
        return self >= 0 ? "+\(amount)" : "-\(amount)"
    }

    var portfolioSignedPercentText: String {
        String(format: "%+.1f%%", self)
    }
}

private func portfolioSignedCurrencyString(_ value: Double) -> String {
    let amount = portfolioCurrencyString(abs(value))
    return value >= 0 ? "+\(amount)" : "-\(amount)"
}

private func portfolioSignedPercentString(_ value: Double) -> String {
    String(format: "%+.1f%%", value)
}

private func portfolioDisplayDate(from rawValue: String) -> String {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
        return "—"
    }

    let date = portfolioParseDate(trimmed) ?? .distantPast
    guard date != .distantPast else {
        return trimmed
    }

    return date.formatted(.dateTime.month(.abbreviated).day())
}

private func portfolioParseISO(_ rawValue: String) -> Date? {
    portfolioParseDate(rawValue)
}

private func portfolioParseDate(_ rawValue: String) -> Date? {
    let parser = ISO8601DateFormatter()
    if let date = parser.date(from: rawValue) {
        return date
    }

    let fractionalParser = ISO8601DateFormatter()
    fractionalParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractionalParser.date(from: rawValue) {
        return date
    }

    let dateOnlyFormatter = DateFormatter()
    dateOnlyFormatter.locale = Locale(identifier: "en_US_POSIX")
    dateOnlyFormatter.dateFormat = "yyyy-MM-dd"
    return dateOnlyFormatter.date(from: rawValue)
}

// MARK: - Shared Enums

enum PortfolioInventoryMode: String, CaseIterable, Identifiable {
    case rows = "Rows"
    case grid = "Grid"

    var id: String { rawValue }
    var title: String { rawValue }
}

enum PortfolioInventoryFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case gainers = "Gainers"
    case losers = "Losers"
    case sellWatch = "Sell Watch"
    case stale = "Stale"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "All"
        case .gainers: return Labels.gainers
        case .losers: return Labels.losers
        case .sellWatch: return Labels.sellWatch
        case .stale: return Labels.stale
        }
    }
}

enum PortfolioInventorySort: String, CaseIterable, Identifiable {
    case valueHighToLow = "Value: High to Low"
    case valueLowToHigh = "Value: Low to High"
    case nameAZ = "Name: A–Z"
    case nameZA = "Name: Z–A"
    case profitHighToLow = "Profit: High to Low"
    case profitLowToHigh = "Profit: Low to High"

    var id: String { rawValue }
    var title: String { rawValue }
}

// MARK: - Shared View Modifiers

struct PortfolioSectionShellModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.18), radius: 18, x: 0, y: 10)
    }
}

struct PortfolioCardSurfaceModifier: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(12)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.88))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

extension View {
    func portfolioSectionShell() -> some View {
        modifier(PortfolioSectionShellModifier())
    }

    func portfolioCardSurface(cornerRadius: CGFloat = HobbyIQTheme.Radius.large) -> some View {
        modifier(PortfolioCardSurfaceModifier(cornerRadius: cornerRadius))
    }
}

// MARK: - Shared Helper Functions

/// 2026-07-17: secondary-action icon-and-caption tile used in the
/// consolidated CTA strip on the holding detail. Icon-primary treatment
/// with 11pt caption below so the button reads as secondary vs the
/// full-width primary List-on-eBay pill above it.
func holdingSecondaryAction(icon: String, caption: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.title3.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .frame(width: 40, height: 40)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                .clipShape(Circle())
            Text(caption)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
}

/// Muted placeholder in the secondary CTA row when Mark-as-Graded
/// doesn't apply (already-graded holding). Keeps the 3-column layout
/// so the surrounding buttons don't shift.
func holdingSecondaryPlaceholder() -> some View {
    VStack(spacing: 6) {
        Circle()
            .fill(HobbyIQTheme.Colors.steelGray.opacity(0.15))
            .frame(width: 40, height: 40)
        Text(" ")
            .font(.system(size: 11, weight: .semibold))
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 4)
}

/// 2026-07-17: 2-column tile used inside Pricing Context for the
/// Quick Sale + Suggested List pair (previously stacked detailRows).
func pricingContextTile(label: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
        Text(label.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(0.6)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        Text(value)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(HobbyIQTheme.Spacing.small)
    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
    .overlay(
        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
            .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
}

func detailRow(title: String, value: String, valueColor: Color = .white, subtitle: String? = nil) -> some View {
    HStack(alignment: .top, spacing: 12) {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .frame(width: 120, alignment: .leading)

        VStack(alignment: .trailing, spacing: 2) {
            Text(value)
                .font(.caption.weight(.medium))
                .foregroundStyle(valueColor)
                .multilineTextAlignment(.trailing)
            if let subtitle, subtitle.isEmpty == false {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .multilineTextAlignment(.trailing)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(.vertical, 2)
}

func portfolioSignalBadgeText(_ rawValue: String?) -> String {
    let trimmed = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard trimmed.isEmpty == false else {
        return "N/A"
    }

    return trimmed
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .uppercased()
}

func portfolioCurrencyString(_ value: Double) -> String {
    value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
}



struct PortfolioContextCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.2)

            VStack(alignment: .leading, spacing: 10, content: content)
        }
        .padding(16)
        .background(Color(hex: 0x141821))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

/// CF-HOLDING-REFERENCE-DATA (2026-07-06): collapsible variant of
/// PortfolioContextCard for the "Reference Data" block on the holding
/// detail view. Header is a tappable row with a chevron; the row body
/// stays mounted (SwiftUI animates height) but content only renders
/// when expanded so the initial paint isn't dominated by field lists.
struct CollapsiblePortfolioContextCard<Content: View>: View {
    let title: String
    let icon: String
    @Binding var isExpanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text(title.uppercased())
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(1.2)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 10, content: content)
            }
        }
        .padding(16)
        .background(Color(hex: 0x141821))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

/// CF-GRADING-TIERS (2026-07-06, backend PR #300): session-scoped
/// cache for the /api/portfolio/grading-tiers catalog. The list only
/// changes on backend redeploys, so we fetch once per cold start and
/// hold it in memory. `load()` is a no-op if we already have data.
@MainActor
final class GradingTierCatalog: ObservableObject {
    static let shared = GradingTierCatalog()

    @Published private(set) var tiers: [GradingTier] = []
    @Published private(set) var isLoading = false
    @Published private(set) var lastErrorMessage: String?

    private var hasLoaded = false

    private init() {}

    /// Fetches the catalog on first call. Subsequent calls are no-ops
    /// unless `force` is true (used for pull-to-refresh in future).
    func load(force: Bool = false) async {
        if hasLoaded && !force && !tiers.isEmpty { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchGradingTiers()
            tiers = response.tiers
            hasLoaded = true
            lastErrorMessage = nil
        } catch {
            lastErrorMessage = APIService.errorMessage(from: error)
        }
    }

    /// Local lookup — returns the cached tier for a given id, or nil.
    func tier(withId id: String) -> GradingTier? {
        tiers.first(where: { $0.id == id })
    }
}

/// CF-HOLDING-DETAIL-V2 (2026-07-06): Mark as Graded conversion sheet.
/// CF-GRADING-TIERS (2026-07-06, backend PR #300): tier dropdown.
/// Collects grading company, grade value, cert number, and grading
/// cost — cost is either pre-filled from a selected tier's
/// `pricePerCard` or typed manually via the "Other" escape hatch.
/// On save, invokes onCommit with the parsed values (including the
/// selected tier id, if any).
struct MarkAsGradedSheet: View {
    let card: InventoryCard
    /// (gradeCompany, gradeValue, certNumber, gradingCost, gradingTierId).
    /// certNumber is trimmed non-empty or nil. gradingCost is positive-only
    /// or nil. gradingTierId is the id from the tier catalog when the user
    /// picked a tier, or nil when they used the "Other → Enter custom cost"
    /// path.
    let onCommit: (
        _ gradeCompany: String,
        _ gradeValue: Double,
        _ certNumber: String?,
        _ gradingCost: Double?,
        _ gradingTierId: String?
    ) -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var tierCatalog = GradingTierCatalog.shared

    @State private var selectedCompany: String = "PSA"
    @State private var selectedValue: Double = 10
    @State private var certNumberText: String = ""
    @State private var gradingCostText: String = ""
    /// CF-GRADING-TIERS (2026-07-06): the selected catalog tier, or nil
    /// for the "Other → Enter custom cost" path.
    @State private var selectedTier: GradingTier?
    /// The user manually typed something into the cost field after a
    /// tier was pre-selected. Kept so we know to send both `gradingTierId`
    /// AND `gradingCost` (mixed case — backend logs the tier but uses the
    /// override).
    @State private var costManuallyOverridden = false
    @State private var showingTierPicker = false
    @State private var inlineError: String?
    @FocusState private var costFieldFocused: Bool

    private static let companies = ["PSA", "SGC", "BGS", "CGC"]
    private static let values: [Double] = [10, 9.5, 9, 8.5, 8, 7]

    var body: some View {
        Form {
            Section("Grading company") {
                Picker("Company", selection: $selectedCompany) {
                    ForEach(Self.companies, id: \.self) { c in
                        Text(c).tag(c)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Grade") {
                Picker("Grade", selection: $selectedValue) {
                    ForEach(Self.values, id: \.self) { v in
                        Text(v.truncatingRemainder(dividingBy: 1) == 0
                             ? String(format: "%.0f", v)
                             : String(format: "%.1f", v))
                            .tag(v)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Cert number") {
                TextField("Optional — e.g. 12345678", text: $certNumberText)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
            }

            Section("Grading cost") {
                // CF-GRADING-TIERS chip: appears above the input when a
                // tier is selected. Tap to reopen the picker.
                if let tier = selectedTier {
                    Button {
                        showingTierPicker = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.caption.weight(.semibold))
                            Text(tierChipText(tier))
                                .font(.caption.weight(.semibold))
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }

                HStack {
                    Text("$")
                    TextField(costFieldPlaceholder, text: $gradingCostText)
                        .keyboardType(.decimalPad)
                        .focused($costFieldFocused)
                        .onChange(of: gradingCostText) { _, newValue in
                            // If a tier is selected and the user edits
                            // the cost away from the tier's pricePerCard,
                            // we're in the override case.
                            if let tier = selectedTier,
                               let tierPrice = tier.pricePerCard {
                                let entered = Double(newValue.trimmingCharacters(in: .whitespaces)) ?? 0
                                costManuallyOverridden = entered > 0 && entered != tierPrice
                            } else if selectedTier?.pricePerCard == nil && newValue.isEmpty == false {
                                // Quote-tier: any value is an override.
                                costManuallyOverridden = true
                            }
                        }
                }

                Button {
                    costFieldFocused = false
                    showingTierPicker = true
                } label: {
                    HStack {
                        Image(systemName: "list.bullet.rectangle")
                            .font(.caption.weight(.semibold))
                        Text(selectedTier == nil ? "Choose grading tier" : "Change grading tier")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)

                if let inlineError {
                    Text(inlineError)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                }
            }

            Section {
                Text("Grading cost rolls into your total cost basis. Per-unit purchase price is unchanged.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Mark as Graded")
        .task {
            await tierCatalog.load()
        }
        .navigationDestination(isPresented: $showingTierPicker) {
            GradingTierPickerView(
                tiers: tierCatalog.tiers,
                isLoading: tierCatalog.isLoading,
                errorMessage: tierCatalog.lastErrorMessage,
                selectedTierId: selectedTier?.id,
                onSelect: { tier in
                    applyTierSelection(tier)
                    showingTierPicker = false
                },
                onOtherSelected: {
                    applyOtherSelection()
                    showingTierPicker = false
                },
                onRetry: {
                    Task { await tierCatalog.load(force: true) }
                }
            )
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    handleSaveTap()
                }
            }
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
    }

    // MARK: - Save flow

    private func handleSaveTap() {
        let trimmedCert = certNumberText.trimmingCharacters(in: .whitespaces)
        let cert: String? = trimmedCert.isEmpty ? nil : trimmedCert
        let parsedCost = Double(gradingCostText.trimmingCharacters(in: .whitespaces)) ?? 0

        // Quote-based tier (Premium 2+): explicit cost required.
        if let tier = selectedTier, tier.pricePerCard == nil, parsedCost <= 0 {
            inlineError = "Enter the amount you paid"
            costFieldFocused = true
            return
        }
        inlineError = nil

        // Wire-shape decision: match backend contract.
        //  - tier selected, cost matches tier price → send tierId only
        //  - tier selected, cost overridden → send BOTH (backend uses cost, logs tier)
        //  - no tier ("Other" path) → send cost only
        let sendTierId: String?
        let sendCost: Double?
        if let tier = selectedTier {
            sendTierId = tier.id
            if costManuallyOverridden {
                sendCost = parsedCost > 0 ? parsedCost : nil
            } else if tier.pricePerCard == nil {
                // Quote tier — must send cost.
                sendCost = parsedCost > 0 ? parsedCost : nil
            } else {
                sendCost = nil
            }
        } else {
            sendTierId = nil
            sendCost = parsedCost > 0 ? parsedCost : nil
        }

        onCommit(selectedCompany, selectedValue, cert, sendCost, sendTierId)
        dismiss()
    }

    // MARK: - Tier picker callbacks

    private func applyTierSelection(_ tier: GradingTier) {
        selectedTier = tier
        costManuallyOverridden = false
        if let price = tier.pricePerCard {
            gradingCostText = formatCost(price)
        } else {
            // Quote-based tier — clear the field and focus it so the
            // user knows to type an amount.
            gradingCostText = ""
            DispatchQueue.main.async {
                costFieldFocused = true
            }
        }
        inlineError = nil
    }

    private func applyOtherSelection() {
        selectedTier = nil
        costManuallyOverridden = false
        gradingCostText = ""
        inlineError = nil
        DispatchQueue.main.async {
            costFieldFocused = true
        }
    }

    // MARK: - Helpers

    private var costFieldPlaceholder: String {
        if let tier = selectedTier, tier.pricePerCard == nil {
            return "Enter amount"
        }
        return "0.00"
    }

    private func tierChipText(_ tier: GradingTier) -> String {
        let priceFragment: String
        if let price = tier.pricePerCard {
            priceFragment = "$\(formatCost(price))"
        } else {
            priceFragment = "Quote"
        }
        return "\(tier.grader) \(tier.name) · \(priceFragment) · \(tier.turnaround)"
    }

    private func formatCost(_ value: Double) -> String {
        if value.truncatingRemainder(dividingBy: 1) == 0 {
            return String(format: "%.0f", value)
        }
        return String(format: "%.2f", value)
    }
}

/// CF-GRADING-TIERS (2026-07-06, backend PR #300): picker for the
/// grading-tier dropdown pushed by MarkAsGradedSheet. Renders the
/// catalog partitioned into "Currently accepting" (active tiers),
/// "Paused (for historical entries)" (inactive tiers, muted), and a
/// final "Other → Enter custom cost" escape hatch.
struct GradingTierPickerView: View {
    let tiers: [GradingTier]
    let isLoading: Bool
    let errorMessage: String?
    let selectedTierId: String?
    let onSelect: (GradingTier) -> Void
    let onOtherSelected: () -> Void
    let onRetry: () -> Void

    @Environment(\.dismiss) private var dismiss

    private var activeTiers: [GradingTier] {
        tiers.filter { $0.active }
    }

    private var pausedTiers: [GradingTier] {
        tiers.filter { !$0.active }
    }

    var body: some View {
        List {
            if isLoading && tiers.isEmpty {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(HobbyIQTheme.Colors.electricBlue)
                        Text("Loading grading tiers…")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    .padding(.vertical, 4)
                }
            } else if let errorMessage, tiers.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Couldn't load grading tiers.")
                            .font(.subheadline.weight(.semibold))
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Button("Retry", action: onRetry)
                            .font(.caption.weight(.semibold))
                    }
                }
            }

            if !activeTiers.isEmpty {
                Section("Currently accepting") {
                    ForEach(activeTiers) { tier in
                        tierRow(tier)
                    }
                }
            }

            if !pausedTiers.isEmpty {
                Section("Paused (for historical entries)") {
                    ForEach(pausedTiers) { tier in
                        tierRow(tier)
                    }
                }
            }

            Section("Other") {
                Button {
                    onOtherSelected()
                } label: {
                    HStack {
                        Image(systemName: "pencil.circle")
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Enter custom cost")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                            Text("Bulk / promo rate, or a tier not listed here")
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                        Spacer()
                        if selectedTierId == nil {
                            Image(systemName: "checkmark")
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle("Grading Tier")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
    }

    // MARK: - Row rendering

    @ViewBuilder
    private func tierRow(_ tier: GradingTier) -> some View {
        Button {
            onSelect(tier)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(tier.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    if let note = tier.note, note.isEmpty == false {
                        Text(note)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(priceString(for: tier))
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.primary)
                    Text(tier.turnaround)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                if selectedTierId == tier.id {
                    Image(systemName: "checkmark")
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
            .opacity(tier.active ? 1.0 : 0.6)
        }
        .buttonStyle(.plain)
    }

    private func priceString(for tier: GradingTier) -> String {
        guard let price = tier.pricePerCard else { return "Quote" }
        if price.truncatingRemainder(dividingBy: 1) == 0 {
            return "$\(Int(price))"
        }
        return String(format: "$%.2f", price)
    }
}

/// CF-SELL-TRACKING (2026-07-11): closed-enum values the backend
/// validates against (portfolioStore.service.ts:657-664). Order matches
/// the picker menu order iOS presents to the user.
enum SellChannelOption: String, CaseIterable, Identifiable, Hashable {
    case unspecified = ""
    case ebay
    case whatnot
    case comc
    case myslabs
    case goldin
    case pwcc
    case instagram
    case facebook
    case cardShow = "card_show"
    case inPerson = "in_person"
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .unspecified: return "Not specified"
        case .ebay:        return "eBay"
        case .whatnot:     return "Whatnot"
        case .comc:        return "COMC"
        case .myslabs:     return "MySlabs"
        case .goldin:      return "Goldin"
        case .pwcc:        return "PWCC"
        case .instagram:   return "Instagram"
        case .facebook:    return "Facebook"
        case .cardShow:    return "Card Show"
        case .inPerson:    return "In Person"
        case .other:       return "Other…"
        }
    }
}

enum SellPaymentMethodOption: String, CaseIterable, Identifiable, Hashable {
    case unspecified = ""
    case ebayManaged = "ebay_managed"
    case paypal
    case venmo
    case zelle
    case cash
    case check
    case cashapp
    case trade
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .unspecified: return "Not specified"
        case .ebayManaged: return "eBay Managed"
        case .paypal:      return "PayPal"
        case .venmo:       return "Venmo"
        case .zelle:       return "Zelle"
        case .cash:        return "Cash"
        case .check:       return "Check"
        case .cashapp:     return "Cash App"
        case .trade:       return "Trade"
        case .other:       return "Other…"
        }
    }
}

struct PortfolioHoldingSoldSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let card: InventoryCard
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var salePriceText: String
    @State private var feesText = "0"
    @State private var saleDate = Date()
    @State private var channel: SellChannelOption = .unspecified
    @State private var channelNote = ""
    @State private var paymentMethod: SellPaymentMethodOption = .unspecified
    @State private var paymentNote = ""
    @State private var venue = ""
    @State private var city = ""
    @State private var state = ""
    @State private var notes = ""
    @State private var localError: String?
    @State private var isSaving = false
    // PR #425 (2026-07-13): trend-anchored recommendations power the
    // "Sold For" picker so users can accept the engine's suggested /
    // aggressive / quick-sale price with one tap. Nil / no cardId →
    // fallback text-only field.
    @State private var listPriceRecommendations: ListPriceRecommendations?
    @State private var selectedSoldOption: SoldPriceOption = .custom

    enum SoldPriceOption: String, CaseIterable, Identifiable {
        case suggested, aggressive, quickSale, custom
        var id: String { rawValue }
    }

    init(viewModel: PortfolioIQViewModel, card: InventoryCard, onSaved: @escaping () -> Void) {
        self.viewModel = viewModel
        self.card = card
        self.onSaved = onSaved
        _salePriceText = State(initialValue: String(format: "%.2f", card.currentValue))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Mark Sold")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)

                Text("\(card.playerName) - \(card.cardName)")
                    .font(.subheadline)
                    .foregroundStyle(Color(hex: 0x9CA3AF))

                if let recs = listPriceRecommendations,
                   (recs.suggested ?? 0) > 0 || (recs.aggressive ?? 0) > 0 || (recs.quickSale ?? 0) > 0 {
                    soldPricePicker(recommendations: recs)
                } else {
                    soldField(title: "Sold For", text: $salePriceText, keyboard: .decimalPad)
                }
                soldField(title: "Fees", text: $feesText, keyboard: .decimalPad)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Sale Date")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)

                    DatePicker("", selection: $saleDate, displayedComponents: .date)
                        .datePickerStyle(.graphical)
                        .tint(Color(hex: 0x3B82F6))
                        .padding(12)
                        .background(Color(hex: 0x1A1D24))
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }

                channelSection
                paymentSection
                locationSection

                VStack(alignment: .leading, spacing: 8) {
                    Text("Notes")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    TextField("Optional", text: $notes, axis: .vertical)
                        .lineLimit(2...4)
                        .textInputAutocapitalization(.sentences)
                        .padding(14)
                        .background(Color(hex: 0x1A1D24))
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(Color.white.opacity(0.08), lineWidth: 2)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .foregroundStyle(.white)
                }

                soldPreview

                if let localError {
                    Text(localError)
                        .font(.footnote)
                        .foregroundStyle(Color.red)
                }

                Button(isSaving ? "Saving…" : "Save Sold") {
                    Task { await submitSale() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSaving)
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Mark Sold")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task { await loadListPriceRecommendations() }
    }

    // PR #425 (2026-07-13): fetch trend-anchored recommendations once
    // on task. Silent fall-through on failure or missing cardId keeps
    // the legacy text-field UX in place.
    private func loadListPriceRecommendations() async {
        guard let cardId = card.cardId?.trimmingCharacters(in: .whitespaces),
              cardId.isEmpty == false else { return }
        do {
            let response = try await APIService.shared.priceByCardId(
                cardId: cardId,
                query: nil,
                gradeCompany: card.gradeCompany,
                gradeValue: card.gradeValue,
                parallelId: nil,
                parallelName: card.parallel.isEmpty ? nil : card.parallel,
                isBlackLabel: card.isBlackLabel
            )
            await MainActor.run {
                listPriceRecommendations = response.listPriceRecommendations
            }
        } catch {
            // Silent fall-through
        }
    }

    @ViewBuilder
    private func soldPricePicker(recommendations: ListPriceRecommendations) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sold For")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            soldPriceRow(
                option: .suggested,
                title: "Suggested",
                price: recommendations.suggested,
                rationale: recommendations.rationale?.suggestedBasis ?? "Predicted next 30d"
            )
            soldPriceRow(
                option: .aggressive,
                title: "Aggressive",
                price: recommendations.aggressive,
                rationale: recommendations.rationale?.aggressiveBasis ?? "Top of prediction range"
            )
            soldPriceRow(
                option: .quickSale,
                title: "Quick Sale",
                price: recommendations.quickSale,
                rationale: recommendations.rationale?.quickSaleBasis ?? "10% below market value"
            )

            Button {
                selectedSoldOption = .custom
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: selectedSoldOption == .custom ? "largecircle.fill.circle" : "circle")
                        .font(.system(size: 18))
                        .foregroundStyle(selectedSoldOption == .custom ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText)
                    Text("Custom")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if selectedSoldOption == .custom {
                TextField("Enter price", text: $salePriceText)
                    .keyboardType(.decimalPad)
                    .foregroundStyle(.white)
                    .padding(14)
                    .background(Color(hex: 0x1A1D24))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 2)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
    }

    private func soldPriceRow(option: SoldPriceOption, title: String, price: Double?, rationale: String) -> some View {
        Button {
            selectedSoldOption = option
            if let price, price > 0 {
                salePriceText = String(format: "%.2f", price)
            }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: selectedSoldOption == option ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(selectedSoldOption == option ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Spacer(minLength: 6)
                        Text(price.map { $0.formatted(.currency(code: "USD").precision(.fractionLength(0))) } ?? "—")
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    Text(rationale)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Sections

    private var channelSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sales Channel")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
            Menu {
                ForEach(SellChannelOption.allCases) { opt in
                    Button(opt.displayName) { channel = opt }
                }
            } label: {
                pickerLabel(text: channel.displayName)
            }
            if channel == .other {
                TextField("Channel note (required)", text: $channelNote)
                    .textInputAutocapitalization(.sentences)
                    .padding(14)
                    .background(Color(hex: 0x1A1D24))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 2)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .foregroundStyle(.white)
            }
        }
    }

    private var paymentSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Payment Method")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
            Menu {
                ForEach(SellPaymentMethodOption.allCases) { opt in
                    Button(opt.displayName) { paymentMethod = opt }
                }
            } label: {
                pickerLabel(text: paymentMethod.displayName)
            }
            if paymentMethod == .other {
                TextField("Payment note (required)", text: $paymentNote)
                    .textInputAutocapitalization(.sentences)
                    .padding(14)
                    .background(Color(hex: 0x1A1D24))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 2)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .foregroundStyle(.white)
            }
        }
    }

    private var locationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sale Location")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
            soldField(title: "Venue", text: $venue)
            HStack(spacing: 10) {
                soldField(title: "City", text: $city)
                    .frame(maxWidth: .infinity)
                soldField(title: "State", text: $state)
                    .frame(width: 110)
            }
        }
    }

    private func pickerLabel(text: String) -> some View {
        HStack {
            Text(text)
                .foregroundStyle(.white)
            Spacer()
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(hex: 0x9CA3AF))
        }
        .padding(14)
        .background(Color(hex: 0x1A1D24))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 2)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    // MARK: - Submit

    private func submitSale() async {
        guard let salePrice = Double(salePriceText.trimmingCharacters(in: .whitespacesAndNewlines)), salePrice > 0 else {
            localError = "Add a sale price."
            return
        }
        // Client-side pre-check for the two `other → note required` invariants
        // the backend enforces (portfolioStore.service.ts:709, 724). Catching
        // it here keeps the round-trip and gives a clearer message next to
        // the specific field.
        if channel == .other && channelNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            localError = "Add a channel note when Channel is Other."
            return
        }
        if paymentMethod == .other && paymentNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            localError = "Add a payment note when Payment Method is Other."
            return
        }

        let trimmedState = state.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if trimmedState.count > 2 {
            localError = "State must be a 2-letter US code."
            return
        }

        let fees = Double(feesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let trimmedVenue = venue.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCity = city.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedChannelNote = channelNote.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPaymentNote = paymentNote.trimmingCharacters(in: .whitespacesAndNewlines)

        let location = PortfolioIQSaleLocation(
            venue: trimmedVenue.isEmpty ? nil : trimmedVenue,
            city: trimmedCity.isEmpty ? nil : trimmedCity,
            state: trimmedState.isEmpty ? nil : trimmedState
        )

        localError = nil
        isSaving = true
        defer { isSaving = false }

        let didSave = await viewModel.markHoldingSold(
            card,
            salePrice: salePrice,
            fees: fees,
            date: saleDate,
            notes: trimmedNotes.isEmpty ? nil : trimmedNotes,
            salesChannel: channel == .unspecified ? nil : channel.rawValue,
            channelNote: trimmedChannelNote.isEmpty ? nil : trimmedChannelNote,
            paymentMethod: paymentMethod == .unspecified ? nil : paymentMethod.rawValue,
            paymentNote: trimmedPaymentNote.isEmpty ? nil : trimmedPaymentNote,
            saleLocation: location.isEmpty ? nil : location
        )
        if didSave {
            onSaved()
            dismiss()
        } else {
            localError = viewModel.errorMessage ?? "Could not save sale. Try again."
        }
    }

    private func soldField(title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            TextField(title, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.words)
                .padding(14)
                .background(Color(hex: 0x1A1D24))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 2)
                )
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .foregroundStyle(.white)
        }
    }

    private var soldPreview: some View {
        let soldFor = Double(salePriceText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let fees = Double(feesText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
        let profit = soldFor > 0 ? soldFor - card.cost - fees : 0
        let margin = soldFor > 0 ? profit / soldFor : 0

        return VStack(alignment: .leading, spacing: 10) {
            Text("Profit")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            Text(profit.portfolioSignedCurrencyText)
                .font(.headline.weight(.bold))
                .foregroundStyle(profit >= 0 ? Color(hex: 0x4ADE80) : .red)

            Text("Margin")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            Text(margin.portfolioSignedPercentText)
                .font(.headline.weight(.bold))
                .foregroundStyle(profit >= 0 ? Color(hex: 0x4ADE80) : .red)
        }
        .padding(12)
        .background(Color(hex: 0x1A1D24))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct CenteredRemoveConfirmationModal: View {
    let title: String
    let message: String
    let confirmTitle: String
    let isConfirming: Bool
    let onCancel: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.62)
                .ignoresSafeArea()
                .onTapGesture(perform: onCancel)

            VStack(spacing: 14) {
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Color(hex: 0xC7CEDB))
                    .multilineTextAlignment(.center)

                HStack(spacing: 12) {
                    Button("Cancel", action: onCancel)
                        .buttonStyle(PortfolioSecondaryButtonStyle())

                    Button(confirmTitle, action: onConfirm)
                        .buttonStyle(PortfolioDestructiveButtonStyle())
                        .disabled(isConfirming)
                }
            }
            .padding(20)
            .frame(maxWidth: 320)
            .background(Color(hex: 0x171B24))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2)
            )
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.35), radius: 22, x: 0, y: 12)
            .padding(.horizontal, 24)
        }
    }
}

struct PortfolioSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color(hex: 0x3B82F6).opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: Color(hex: 0x3B82F6).opacity(0.22), radius: 10, x: 0, y: 6)
            .opacity(configuration.isPressed ? 0.95 : 1)
    }
}

struct PortfolioDestructiveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color(hex: 0x3B82F6).opacity(configuration.isPressed ? 0.82 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: Color(hex: 0x3B82F6).opacity(0.22), radius: 10, x: 0, y: 6)
            .opacity(configuration.isPressed ? 0.95 : 1)
    }
}


// MARK: - Card Thumbnails

// CF-CARD-IMAGE-NO-DISTORT (2026-07-03): scaledToFit + maxWidth-only so
// LiveMarket CDN images (754×1028, aspect 0.733) render at their natural
// aspect. The old 40×56 fixed frame forced 0.714, stretching cards.
func cardThumbnail(urlString: String?) -> some View {
    // CF-CARD-THUMB-COMP-CARD-PARITY (2026-07-05): same structure as
    // the comp-card hero — `.scaledToFit().scaleEffect(0.85)` inside
    // a fixed 40×56 card-aspect container, single `.clipShape` at
    // the outer Group so every branch shares the rounded crop.
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty:
                    thumbnailPlaceholder
                case .failure:
                    thumbnailPlaceholder
                @unknown default:
                    thumbnailPlaceholder
                }
            }
        } else {
            thumbnailPlaceholder
        }
    }
    .frame(width: 40, height: 56)
    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
}

// CF-CARD-IMAGE-NO-DISTORT (2026-07-03): scaledToFit inside the tile so
// non-standard aspects letterbox instead of stretching. Container size
// preserved for LazyVGrid uniformity.
func gridThumbnail(urlString: String?) -> some View {
    // CF-GRID-THUMB-COMP-CARD-PARITY (2026-07-05): mirrors the
    // comp-card hero — `.scaledToFit().scaleEffect(0.85)` inside the
    // 80pt-tall tile so non-standard aspects letterbox with the same
    // 15% breathing margin. `.clipShape` at the container level
    // matches the hero's rounded-rect crop instead of the raw
    // `.clipped()` rectangle.
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty:
                    gridThumbnailPlaceholder
                case .failure:
                    gridThumbnailPlaceholder
                @unknown default:
                    gridThumbnailPlaceholder
                }
            }
        } else {
            gridThumbnailPlaceholder
        }
    }
    .frame(maxWidth: .infinity)
    .frame(height: 80)
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
}

private var thumbnailPlaceholder: some View {
    ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(HobbyIQTheme.Colors.slateGray)
        Image(systemName: "photo")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }
}

private var gridThumbnailPlaceholder: some View {
    ZStack {
        Rectangle()
            .fill(HobbyIQTheme.Colors.slateGray)
        Image(systemName: "photo.on.rectangle")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }
}

// CF-IOS-DIRECTION-SWEEP (2026-06-18): PortfolioInventoryChips struct
// removed — was dead code (no instantiation in the iOS source) and
// rendered statusChipText as a "Verdict" pill (direction-class).

struct PortfolioChip: View {
    let label: String
    let tint: Color

    var body: some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tint.opacity(0.12))
            .clipShape(Capsule(style: .continuous))
    }
}

private func portfolioSignalColor(_ rawValue: String?, fallback: Color) -> Color {
    guard let rawValue else {
        return fallback
    }

    let normalized = rawValue
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "-", with: "_")
        .replacingOccurrences(of: " ", with: "_")

    switch normalized {
    case "strong_sell", "sell_now", "sellnow", "sell":
        return .red
    case "hold":
        return Color(hex: 0x3B82F6)
    case "strong_hold":
        return .green
    default:
        return fallback
    }
}
