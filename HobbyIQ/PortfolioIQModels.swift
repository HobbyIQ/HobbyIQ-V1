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

// MARK: - Shared Detail Sheet Components

struct PortfolioHoldingDetailSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let card: InventoryCard
    let onUpdated: () -> Void
    /// CF-BACK-NAV-FIX (2026-07-06): the floating back chevron previously
    /// called `@Environment(\.dismiss)`. Under `.navigationDestination(item:)`
    /// on a tab-root NavigationStack, `dismiss()` was popping past the tab
    /// root — user landed on Dashboard instead of the inventory list. When
    /// the parent supplies `onBack`, we call it (parent clears the
    /// `item` binding, which pops one level cleanly). Optional to keep
    /// previews / older callers working via `dismiss()` fallback.
    let onBack: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @ObservedObject private var ebayStore = EBayOAuthCoordinator.shared
    @State private var showingEditSheet = false
    // PR #441 (2026-07-14): manual "Verify Card" sheet trigger. The
    // auto-open path lands once backend adds `verificationStatus`.
    @State private var showingVerifyCardSheet = false
    @State private var showingSoldSheet = false
    @State private var showingEbayListingSheet = false
    @State private var showingRemoveModal = false
    // CF-IOS-DIRECTION-SWEEP (2026-06-18): re-added after CompIQ
    // direction strip. PortfolioCompIQBridgeView destination is now
    // comp-only (zones + confidence; no predictedPrice / trendIQ /
    // broaderTrend / buyWindow). Routes the Pricing Context "View
    // comp analysis" footer button.
    @State private var showingCompIQAnalysis = false
    @State private var lastEbayListingResponse: PortfolioEbayListingResponse?
    @State private var localError: String?
    /// CF-IOS-GRADER-STATUS-UI (2026-06-28): mirrors `card.graderStatus`
    /// for the dropdown's optimistic UI. Seeded in init from the holding;
    /// PATCH commits update it (and the row stays correct because the
    /// inventory list refreshes on `onUpdated`).
    @State private var selectedStatus: GraderStatus
    /// CF-HOLDING-REFERENCE-DATA (2026-07-06): collapsed by default so
    /// the primary read (hero → recommendation → pricing → actionability)
    /// stays clean. Users who need year/set/parallel/grade/purchase/etc.
    /// tap to expand.
    @State private var referenceDataExpanded = false
    /// CF-HOLDING-DETAIL-V2 (2026-07-06): panel entries fetched from
    /// /api/compiq/card-panel/:cardId on task. Feeds the PREDICTED
    /// (30d) block AND the Grading Scenario section — all scenario
    /// projections read from the SAME payload, no extra API call
    /// per scenario grade. Empty when the fetch failed, cardId is
    /// nil, or the holding hasn't been resolved to a catalog card
    /// yet.
    @State private var panelEntries: [CardPanelGradeEntry] = []
    /// CF-HOLDING-DETAIL-V2 (2026-07-06): Grading Scenario is
    /// collapsed by default. Section only renders for raw holdings
    /// with a successful panel fetch.
    @State private var gradingScenarioExpanded = false
    /// Local scenario state — MUST NOT leak into the canonical
    /// surfaces. Tapping a scenario grade updates ONLY the
    /// scenario result rows.
    @State private var scenarioGradeKey: String = "psa|10"
    @State private var gradingCostText: String = "25"
    /// CF-HOLDING-DETAIL-V2 (2026-07-06): Mark-as-Graded sheet gate.
    @State private var showingMarkAsGradedSheet = false
    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): last-3 flips
    /// for this holding's player. Empty until the /verdict-history call
    /// resolves; strip suppresses entirely when zero flips exist so the
    /// value block sits at the top for uneventful players.
    @State private var recentFlips: [VerdictFlip] = []
    /// Corpus signals (2026-07-17, PR #517/#519): matched-cohort trend
    /// for this holding's player, feeding the Player Momentum block below
    /// the hero. Loaded on task; nil hides the block cleanly.
    @State private var playerTrend: PlayerTrendResponse?
    /// Controls the stratified raw/graded split disclosure inside the
    /// Player Momentum block. Collapsed by default.
    @State private var playerTrendExpanded: Bool = false
    /// Corpus signals (2026-07-17, PR #518): per-holding grade-worthy
    /// analysis for the Grade Analysis block. Only fetched for raw
    /// holdings; response's `overallRecommendation` gates rendering.
    @State private var gradeAnalysis: GradeAnalysisResponse?
    /// Local in-flight + success state for the "Mark as At Grading" CTA
    /// on the Grade Analysis block. Prevents double-fire and collapses
    /// the button to a "Marked" affordance on success.
    @State private var isMarkingAtGrading: Bool = false
    @State private var didMarkAtGrading: Bool = false
    /// Phase 1.4 (2026-07-17, PR #524): observed family multipliers for
    /// the "Grader Premium Curve" block. Hidden entirely when tiers < 2
    /// or all rows are low-confidence. Populated on task with the
    /// holding's setName as the family key.
    @State private var familyMultipliers: FamilyMultipliersResponse?
    // Phase 2.5 timing-forecast state removed (2026-07-17) — dedicated
    // block killed to consolidate with PREDICTED (7d), which draws from
    // the same math after backend PR #543.
    /// Phase 3.10 (2026-07-17, PR #525): observed grader outcome
    /// distribution for the "What could actually happen?" expandable
    /// inside the Grade Analysis block. Lazy — fetched only when the
    /// disclosure is expanded so we don't spend the rate-limit budget
    /// on cards no one drills into.
    @State private var graderOutcomes: GraderOutcomesResponse?
    @State private var graderOutcomesExpanded: Bool = false
    /// Batch 2 (2026-07-17, PR #538): observed parallel-tier ladder for
    /// the holding's (player, year, cardSet) bucket. Hidden when the
    /// backend suppressed (thin base pool).
    @State private var parallelLadder: ParallelLadderResponse?
    /// Batch 2 (2026-07-17, PR #531): parallels the user does NOT own in
    /// this bucket. Hidden when the bucket has zero missing entries.
    @State private var missingParallels: MissingParallelsBucketResponse?

    init(
        viewModel: PortfolioIQViewModel,
        card: InventoryCard,
        onUpdated: @escaping () -> Void,
        onBack: (() -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.card = card
        self.onUpdated = onUpdated
        self.onBack = onBack
        _selectedStatus = State(initialValue: card.graderStatus)
    }

    private var graderStatusRow: some View {
        HStack {
            Text("Status")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            Menu {
                ForEach(GraderStatus.allCases) { status in
                    Button {
                        let previous = selectedStatus
                        selectedStatus = status
                        Task { await commitStatusChange(status, previous: previous) }
                    } label: {
                        HStack {
                            Text(status.displayLabel)
                            if selectedStatus == status {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(selectedStatus.displayLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(selectedStatus.tintColor)
                    Image(systemName: "chevron.down")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .padding(.vertical, 6)
    }

    /// CF-HOLDING-DETAIL-REFRESH (2026-07-06): action recommendation
    /// tile — a dedicated card between the hero and the pricing/detail
    /// grids so a seller opens the holding and sees "SELL NOW · reasoning"
    /// / "LIST · $target · reasoning" front-and-center. Same
    /// ActionBadgeStyle used everywhere else, so the tint/icon/fill
    /// treatment is uniform across the app.
    @ViewBuilder
    private func holdingActionRecommendationCard(rec: CardPanelGradeEntry.ActionRecommendation) -> some View {
        let style = ActionBadgeStyle(verdict: rec.verdict, urgency: rec.urgency)
        let headline: String = {
            switch rec.verdict {
            case .sellNow:
                if let d = rec.expectedDeltaPct {
                    let absStr = d >= 10 ? String(format: "%.0f%%", abs(d)) : String(format: "%.1f%%", abs(d))
                    return "Sell now — trend points down \(absStr)"
                }
                return "Sell now"
            case .hold:
                if let d = rec.expectedDeltaPct {
                    let absStr = d >= 10 ? String(format: "%.0f%%", abs(d)) : String(format: "%.1f%%", abs(d))
                    return "Hold — trend points up \(absStr)"
                }
                return "Hold"
            case .list:
                if let t = rec.targetPrice, t > 0 {
                    return "List at \(t.currencyStringNoCents)"
                }
                return "List"
            case .insufficientData:
                return "Not enough data"
            }
        }()
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Image(systemName: style.icon)
                        .font(.caption.weight(.bold))
                    Text(style.label)
                        .font(.caption.weight(.bold))
                        .tracking(0.5)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .foregroundStyle(style.foreground)
                .background(style.background)
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(style.tint, lineWidth: style.strokeWidth)
                )
                .clipShape(Capsule(style: .continuous))
                Text(headline)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(style.tint)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            if let reasoning = rec.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines),
               reasoning.isEmpty == false {
                Text(reasoning)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            LinearGradient(
                colors: [Color(hex: 0x141821), Color(hex: 0x1A1F2E)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(style.tint.opacity(0.25), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    /// CF-HOLDING-DETAIL-V2 (2026-07-06): reuses the SAME normalized
    /// grade-key mapping the comp card uses
    /// (`GradePillPanel.normalizedKey`), so "PSA 9" on a holding
    /// resolves to the exact same panel entry the comp card would
    /// resolve for PSA 9. No forked mapping.
    private var holdingGradeKey: String {
        if let company = card.gradeCompany?.trimmingCharacters(in: .whitespaces),
           let value = card.gradeValue,
           company.isEmpty == false {
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return GradePillPanel.normalizedKey(grade: valueStr, grader: company)
        }
        return "raw"
    }

    private var isRawHolding: Bool { holdingGradeKey == "raw" }

    /// Panel entry that matches the holding's locked grade. Nil when
    /// the panel hasn't loaded, the fetch failed, or the panel returned
    /// no entry for this grade (thin data).
    private func lockedGradeEntry() -> CardPanelGradeEntry? {
        guard panelEntries.isEmpty == false else { return nil }
        return panelEntries.first { entry in
            GradePillPanel.normalizedKey(grade: entry.grade, grader: entry.grader) == holdingGradeKey
        }
    }

    private func entryForKey(_ key: String) -> CardPanelGradeEntry? {
        panelEntries.first { entry in
            GradePillPanel.normalizedKey(grade: entry.grade, grader: entry.grader) == key
        }
    }

    /// Value the hero renders. Prefers the panel entry ONLY when it's
    /// observed with a non-zero sample count — otherwise
    /// `vm.resolvedMarketValue(for:)` wins so the hero stays aligned
    /// with the inventory row and doesn't downgrade to a thin
    /// synthesized estimate. Multiplies by qty to match the row's
    /// scaling contract.
    private func heroLivePanelValue() -> Double? {
        let qty = max(1.0, card.quantity ?? 1.0)
        if let entry = lockedGradeEntry(),
           entry.valueSource == .observed,
           (entry.sampleCount ?? 0) > 0,
           let value = entry.resolvedMarketValue, value > 0 {
            return value * qty
        }
        let resolved = viewModel.resolvedMarketValue(for: card)
        return resolved > 0 ? resolved : nil
    }

    /// Fires on `.task { }` and again on holding change. Silent
    /// degradation on failure — no error banner, no spinner. The
    /// PREDICTED block + Grading Scenario section simply don't render.
    ///
    /// 2026-07-15: fresh `/card-panel` entries push into
    /// `viewModel.livePanelEntries` ONLY when they carry observed
    /// data. Thin `valueSource == .estimated` responses (Cardsight
    /// synthesized from the multiplier ladder because zero direct
    /// comps existed) can be strictly worse than the holding's
    /// stored `fairMarketValue` — writing them into the shared
    /// cache would silently downgrade the inventory row from the
    /// backend's authoritative FMV to a thin estimate. Detail hero
    /// applies the same gate at its fallback site.
    private func fetchPanelIfPossible() async {
        guard let cardId = card.cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
              cardId.isEmpty == false else {
            panelEntries = []
            return
        }
        do {
            let response = try await APIService.shared.fetchCardPanel(cardId: cardId)
            let entries = response.gradeCurve?.entries ?? []
            panelEntries = entries
            let hasObserved = entries.contains { entry in
                entry.valueSource == .observed && (entry.sampleCount ?? 0) > 0
            }
            if hasObserved {
                viewModel.writeLivePanelEntries(cardId: cardId, entries: entries)
            }
        } catch {
            panelEntries = []
        }
    }

    // MARK: - Corpus signals (2026-07-17)

    /// PR #517/#519: fetch matched-cohort momentum for this holding's
    /// player. Populates the Player Momentum block; silent failure
    /// hides it.
    private func loadPlayerTrend() async {
        // Reuse the portfolio-list cache when it already has a fresh
        // entry (12h window) — avoids a duplicate fetch on detail-open.
        if let cached = viewModel.playerTrend(for: card) {
            playerTrend = cached
            return
        }
        do {
            playerTrend = try await APIService.shared.fetchPlayerTrend(player: card.playerName)
        } catch {
            playerTrend = nil
        }
    }

    /// PR #518: per-holding grade-worthy analysis. Only fires for raw
    /// holdings (already-graded cards return `insufficient_data` from
    /// the backend anyway, but skipping the request saves rate-limit
    /// budget). Silent failure hides the block.
    private func loadGradeAnalysis() async {
        guard isRawHolding else { return }
        do {
            gradeAnalysis = try await APIService.shared.fetchGradeAnalysis(holdingId: card.id.uuidString)
        } catch {
            gradeAnalysis = nil
        }
    }

    /// Returns the loaded analysis when its `overallRecommendation` is
    /// one of the two rendering states. `not_worth` / `insufficient_data`
    /// / nil all return nil so the block hides entirely.
    private func gradeAnalysisIfActionable() -> GradeAnalysisResponse? {
        guard let analysis = gradeAnalysis else { return nil }
        let recommendation = analysis.analysis?.overallRecommendation?.lowercased() ?? ""
        switch recommendation {
        case "grade_now", "grade_worthy_but_wait":
            return analysis
        default:
            return nil
        }
    }

    // Phase 2.5 loadTimingForecast + timingForecastIfRenderable removed
    // 2026-07-17 — the standalone forecast block is dropped in favor of
    // the existing PREDICTED (7d) tile which now sources the same
    // matched-cohort rate (backend PR #543).

    /// Phase 3.10 (2026-07-17, PR #525): lazy fetch of grader outcomes
    /// on Grade Analysis expandable expand. Deduped so a rapid collapse/
    /// expand cycle doesn't re-fire.
    private func loadGraderOutcomesIfNeeded() async {
        guard graderOutcomes == nil else { return }
        let key = resolvedFamilyKey()
        guard key.isEmpty == false else { return }
        do {
            graderOutcomes = try await APIService.shared.fetchGraderOutcomes(family: key)
        } catch {
            graderOutcomes = nil
        }
    }

    /// Batch 2 (2026-07-17, PR #538): fetch observed parallel-ladder for
    /// the holding's bucket. Silent failure hides the block.
    private func loadParallelLadder() async {
        let bucket = parallelLadderBucketKey()
        guard bucket.isRenderable else { return }
        do {
            parallelLadder = try await APIService.shared.fetchParallelLadder(
                player: bucket.player, year: bucket.year, cardSet: bucket.cardSet
            )
        } catch {
            parallelLadder = nil
        }
    }

    /// Batch 2 (2026-07-17, PR #531): fetch missing parallels for the
    /// holding's bucket. Silent failure hides the block.
    private func loadMissingParallels() async {
        let bucket = parallelLadderBucketKey()
        guard bucket.isRenderable else { return }
        do {
            missingParallels = try await APIService.shared.fetchMissingParallels(
                player: bucket.player, year: bucket.year, cardSet: bucket.cardSet
            )
        } catch {
            missingParallels = nil
        }
    }

    /// (player, year, cardSet) tuple used for both parallel-ladder and
    /// missing-parallels lookups. Backend's setName slug is idempotent so
    /// we pass whatever the holding carries.
    private struct BucketKey {
        let player: String
        let year: Int
        let cardSet: String
        var isRenderable: Bool {
            player.isEmpty == false && year > 0 && cardSet.isEmpty == false
        }
    }

    private func parallelLadderBucketKey() -> BucketKey {
        let player = card.playerName.trimmingCharacters(in: .whitespaces)
        let year = Int(card.year.trimmingCharacters(in: .whitespaces)) ?? 0
        let cardSet = card.setName.trimmingCharacters(in: .whitespaces)
        return BucketKey(player: player, year: year, cardSet: cardSet)
    }

    /// Returns the ladder bucket when at least two rungs render usefully
    /// (Base + at least one non-Base) and the backend didn't suppress.
    private func renderableParallelLadder() -> ParallelLadderBucket? {
        guard let bucket = parallelLadder?.bucket else { return nil }
        if let reason = bucket.suppressedReason?.trimmingCharacters(in: .whitespaces),
           reason.isEmpty == false {
            return nil
        }
        guard let ladder = bucket.ladder, ladder.count >= 2 else { return nil }
        return bucket
    }

    /// Returns the missing-parallels bundle when it has ≥ 1 entry.
    private func renderableMissingParallels() -> MissingParallelsBundle? {
        guard let bundle = missingParallels?.bucket,
              let missing = bundle.missingParallels,
              missing.isEmpty == false else { return nil }
        return bundle
    }

    /// Phase 1.4 (2026-07-17, PR #524): fetch observed grader multipliers
    /// for this holding's family. Silent failure hides the block. Family
    /// key is best-effort — grade-analysis diagnostics carries a
    /// backend-computed one when it's a raw holding; otherwise use
    /// `card.setName` and let backend slug it.
    private func loadFamilyMultipliers() async {
        let key = resolvedFamilyKey()
        guard key.isEmpty == false else { return }
        do {
            familyMultipliers = try await APIService.shared.fetchFamilyMultipliers(family: key)
        } catch {
            familyMultipliers = nil
        }
    }

    /// Prefer backend-computed familyKey from grade-analysis when present;
    /// fall back to `card.setName`. Backend accepts either shape.
    private func resolvedFamilyKey() -> String {
        if let key = gradeAnalysis?.diagnostics?.familyKey?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           key.isEmpty == false {
            return key
        }
        return card.setName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Filter to renderable tiers per spec (high or medium confidence
    /// only, multiplier > 1). Returns nil to hide the whole block when
    /// fewer than 2 rows qualify.
    private func familyMultipliersIfRenderable() -> FamilyMultipliersResponse? {
        guard let response = familyMultipliers,
              let tiers = response.tiers else { return nil }
        let renderable = tiers.filter { tier in
            let conf = tier.confidence?.lowercased() ?? ""
            let mult = tier.multiplier ?? 0
            return (conf == "high" || conf == "medium") && mult > 1.0
        }
        if renderable.count < 2 { return nil }
        return FamilyMultipliersResponse(familyKey: response.familyKey, tiers: renderable)
    }

    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): fetch the
    /// 90-day verdict history for this holding's player and keep the
    /// last 3 flips for the detail-sheet strip. Silent failure — an
    /// unavailable Cosmos read hides the strip; no error banner.
    private func loadVerdictHistory() async {
        let name = card.playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.isEmpty == false else {
            recentFlips = []
            return
        }
        do {
            let response = try await APIService.shared.fetchVerdictHistory(player: name, days: 90)
            // Backend returns oldest→newest; iOS wants newest-first, up to 3.
            let flips = (response.flips ?? []).reversed()
            recentFlips = Array(flips.prefix(3))
        } catch {
            recentFlips = []
        }
    }

    /// P0.7: horizontal chip strip rendering the last-3 flips as
    /// `SELL ← HOLD 3d` style entries, newest-first. Reuses `VerdictStyle`
    /// labels so terminology matches everywhere else the app says a verdict.
    private func verdictHistoryStrip(flips: [VerdictFlip]) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(flips.enumerated()), id: \.element.id) { index, flip in
                let toLabel = VerdictStyle.from(flip.to).label
                let fromLabel = VerdictStyle.from(flip.from).label
                let age = formatFlipAge(daysSince: flip.daysSince) ?? ""
                let toColor = VerdictStyle.from(flip.to).color

                HStack(spacing: 4) {
                    Text(toLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(toColor)
                    Text("←")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(fromLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    if age.isEmpty == false {
                        Text(age)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.8))
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                .overlay(
                    Capsule()
                        .stroke(toColor.opacity(0.35), lineWidth: 1)
                )
                .clipShape(Capsule())

                if index < flips.count - 1 {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Corpus signals: Player Momentum block (2026-07-17)

    /// Matched-cohort player momentum surface. Top row shows the raw
    /// direction glyph + % + velocity, subline reports the qualifying
    /// cards agreement ratio. Tap chevron expands the stratified split
    /// (raw vs graded) so users can see whether the market is currently
    /// rewarding grading on this player specifically.
    ///
    /// Never surfaces raw `servedFrom` or `flags` — those inform copy
    /// (sparse subline) but never render literally.
    @ViewBuilder
    private func playerMomentumBlock(trend: PlayerTrendResponse) -> some View {
        let direction = trend.direction?.lowercased() ?? ""
        let renderable = direction == "up" || direction == "down"
        if renderable, let pct = trend.momentumPercentString {
            VStack(alignment: .leading, spacing: 10) {
                Text("PLAYER MOMENTUM")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(card.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    PlayerTrendArrow(trend: trend, style: .detail)
                    if let velocity = trend.velocityPerWeek {
                        Text("\(Int(velocity.rounded()))/wk")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 2)
                .padding(.bottom, 2)
                .padding(.leading, 2)
                .padding(.trailing, 2)

                if let qualifying = trend.qualifyingCards,
                   let pool = trend.cardsInPool, pool > 0 {
                    Text("\(qualifying) of \(pool) cards agree")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                if trend.hasFlag("sparse") {
                    Text("Limited data — signal may be noisy.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                } else if trend.hasFlag("one_card_dominant") {
                    Text("1 card is >50% of volume — check breakdown.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                } else if trend.hasFlag("wide_ratio_dispersion") {
                    Text("Cards moving in different directions.")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                }

                // Stratified split disclosure — only shown when the
                // stratified sub-objects are present (PR #519+ deploys).
                if trend.raw != nil || trend.graded != nil {
                    playerMomentumStratifiedRow(trend: trend, ignore: pct)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    /// Collapsible raw vs graded split. When `graded.momentum > raw.momentum`,
    /// annotate the graded row with "market rewards grading now" — this
    /// is the actionable insight that drives a "consider grading this raw
    /// card" nudge.
    @ViewBuilder
    private func playerMomentumStratifiedRow(trend: PlayerTrendResponse, ignore: String) -> some View {
        DisclosureGroup(isExpanded: $playerTrendExpanded) {
            VStack(alignment: .leading, spacing: 6) {
                if let raw = trend.raw {
                    stratumRow(label: "Raw", stratum: raw, annotation: nil)
                }
                if let graded = trend.graded {
                    let rewardsGrading: Bool = {
                        guard let rawM = trend.raw?.momentum,
                              let gradedM = graded.momentum else { return false }
                        return gradedM > rawM
                    }()
                    stratumRow(
                        label: "Graded",
                        stratum: graded,
                        annotation: rewardsGrading ? "market rewards grading now" : nil
                    )
                }
            }
            .padding(.top, 6)
        } label: {
            Text("Raw vs graded split")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
        .tint(HobbyIQTheme.Colors.electricBlue)
    }

    @ViewBuilder
    private func stratumRow(label: String, stratum: PlayerTrendStratum, annotation: String?) -> some View {
        let direction = stratum.direction?.lowercased() ?? ""
        let glyph: String? = {
            switch direction {
            case "up": return "\u{25B2}"
            case "down": return "\u{25BC}"
            default: return nil
            }
        }()
        let color: Color = {
            switch direction {
            case "up": return HobbyIQTheme.Colors.successGreen
            case "down": return HobbyIQTheme.Colors.danger
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()
        HStack(spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .frame(width: 60, alignment: .leading)
            if let glyph {
                Text(glyph)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(color)
            }
            if let pct = stratum.momentumPercentString {
                Text(pct)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
            }
            if let annotation {
                Text("← \(annotation)")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen.opacity(0.85))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 0)
        }
    }

    // Timing Forecast block removed 2026-07-17. PREDICTED (7d) on the
    // hero tile now sources the same matched-cohort math via backend
    // PR #543 — two competing forecasts on the same page was hurting
    // trust in the number. `TimingForecastResponse` and
    // `APIService.fetchTimingForecast` are still available for a
    // future non-holding-detail surface.

    // MARK: - Phase 1.4: Grader Premium Curve block (2026-07-17)

    /// Observed grader-premium curve for the holding's product family.
    /// Shows the top tiers' multipliers ("PSA 10 pays 5.4× Raw") with a
    /// caption exposing the sample counts so users can sanity-check the
    /// signal ("47 PSA 10s / 340 raw comps"). Filters + hides logic lives
    /// in `familyMultipliersIfRenderable()`.
    @ViewBuilder
    private func graderPremiumCurveBlock(multipliers: FamilyMultipliersResponse) -> some View {
        let tiers = multipliers.tiers ?? []
        let familyLabel = friendlyFamilyLabel(multipliers.familyKey)
        // Sum sample counts for the caption. Highest-count tier drives
        // the "N graded / M raw" phrasing — the biggest signal.
        let topTier = tiers.max(by: { ($0.nGraded ?? 0) < ($1.nGraded ?? 0) })

        VStack(alignment: .leading, spacing: 10) {
            Text("GRADER PREMIUM CURVE")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            if familyLabel.isEmpty == false {
                Text(familyLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            VStack(spacing: 8) {
                ForEach(tiers) { tier in
                    graderPremiumRow(tier: tier)
                }
            }

            if let topTier,
               let nGraded = topTier.nGraded,
               let nRaw = topTier.nRaw,
               (nGraded + nRaw) > 0 {
                Text("Based on observed sales (\(nGraded) \(topTier.graderTier)s / \(nRaw) raw comps in past 90 days).")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func graderPremiumRow(tier: FamilyMultiplierTier) -> some View {
        HStack(spacing: 8) {
            Text("\u{25B2}")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            Text(tier.graderTier)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(width: 96, alignment: .leading)
            Text("pays")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let mult = tier.multiplier {
                Text(String(format: "%.1f\u{00D7}", mult))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            }
            Text("Raw")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
    }

    /// Turn a slug or human string into a display-ready label
    /// ("bowman_chrome_baseball" → "Bowman Chrome Baseball").
    private func friendlyFamilyLabel(_ key: String?) -> String {
        guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines),
              key.isEmpty == false else { return "" }
        // If key is already title-cased (has spaces), pass through.
        if key.contains(" ") { return key }
        // Slug: split on underscore, capitalize each word.
        return key
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    // MARK: - Batch 2: Parallel Ladder block (2026-07-17, PR #538)

    /// Observed parallel-tier ladder for the holding's (player, year,
    /// cardSet) bucket. Renders each rung's multiplier + print run + n.
    /// Backend suppression (thin base pool) hides the block entirely
    /// via `renderableParallelLadder()`.
    @ViewBuilder
    private func parallelLadderBlock(bucket: ParallelLadderBucket) -> some View {
        let ladder = bucket.ladder ?? []
        // Sort ASC by multiplier so Base (1.0) always leads.
        let sorted = ladder.sorted { ($0.multiplier ?? 0) < ($1.multiplier ?? 0) }
        let confidence = bucket.confidence?.lowercased() ?? ""
        let strokeColor: Color = {
            switch confidence {
            case "high": return HobbyIQTheme.Colors.successGreen
            case "medium": return HobbyIQTheme.Colors.electricBlue
            case "low": return HobbyIQTheme.Colors.warning
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()

        VStack(alignment: .leading, spacing: 10) {
            Text("PARALLEL LADDER")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("Observed multipliers vs Base for this set")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))

            VStack(spacing: 6) {
                ForEach(sorted) { rung in
                    parallelLadderRow(rung: rung)
                }
            }

            if let base = bucket.baseMedianPrice, base > 0 {
                Text("Base median: \(portfolioCurrencyString(base))")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(strokeColor.opacity(0.4), lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func parallelLadderRow(rung: ParallelLadderRung) -> some View {
        let isBase = (rung.multiplier ?? 0) <= 1.0
        HStack(spacing: 8) {
            Text(rung.variant)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: 140, alignment: .leading)
                .lineLimit(1)
                .truncationMode(.tail)
            if let printRun = rung.printRun, printRun > 0 {
                Text("/\(printRun)")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
            if let mult = rung.multiplier {
                Text(String(format: "%.1f\u{00D7}", mult))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(isBase ? HobbyIQTheme.Colors.mutedText : HobbyIQTheme.Colors.successGreen)
            }
            if let n = rung.n, n > 0 {
                Text("n=\(n)")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.75))
            }
        }
    }

    // MARK: - Batch 2: Missing Parallels block (2026-07-17, PR #531)

    /// Parallels in the holding's bucket that the user doesn't own.
    /// Section header adapts to entry count per spec: 1-3 = "Complete
    /// the Set", 4-10 = "Round out your set", 11+ = "N parallels missing".
    @ViewBuilder
    private func missingParallelsBlock(bundle: MissingParallelsBundle) -> some View {
        let entries = (bundle.missingParallels ?? []).sorted {
            ($0.medianPrice ?? 0) > ($1.medianPrice ?? 0)
        }
        let title: String = {
            let count = entries.count
            if count >= 11 { return "\(count) parallels missing" }
            if count >= 4 { return "Round out your set" }
            return "Complete the Set"
        }()
        let bucketLabel: String = {
            let parts = [
                bundle.year.map(String.init),
                bundle.player,
                bundle.cardSet
            ]
                .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
                .filter { $0.isEmpty == false }
            return parts.joined(separator: " ")
        }()

        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if bucketLabel.isEmpty == false {
                Text(bucketLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if let owned = bundle.ownedVariants, owned.isEmpty == false {
                Text("You own: \(owned.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(2)
            }
            Divider().overlay(HobbyIQTheme.Colors.steelGray.opacity(0.35))
            VStack(spacing: 8) {
                ForEach(entries.prefix(10)) { entry in
                    missingParallelRow(entry)
                }
            }
            if entries.count > 10 {
                Text("+ \(entries.count - 10) more")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func missingParallelRow(_ entry: MissingParallelEntry) -> some View {
        let hot = (entry.medianPrice ?? 0) > 500
        HStack(spacing: 8) {
            Text("\u{00B7}")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(entry.variant ?? "—")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
            if let number = entry.number?.trimmingCharacters(in: .whitespaces),
               number.isEmpty == false {
                Text(number)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
            if let median = entry.medianPrice, median > 0 {
                Text(portfolioCurrencyString(median))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if hot {
                Text("\u{1F525}")
                    .font(.caption)
            }
        }
    }

    // MARK: - Corpus signals: Grade Analysis block (2026-07-17)

    /// Per-holding grade-worthy read. Two visual states:
    ///   - `grade_now` — 💎 GRADE NOW headline, forest-green ROI, primary CTA
    ///   - `grade_worthy_but_wait` — ⚠️ headline, muted treatment, reason
    ///     copy explains why to wait
    /// `not_worth` and `insufficient_data` never reach this builder (the
    /// call site filters them via `gradeAnalysisIfActionable()`).
    @ViewBuilder
    private func gradeAnalysisBlock(analysis: GradeAnalysisResponse) -> some View {
        let recommendation = analysis.analysis?.overallRecommendation?.lowercased() ?? ""
        let isWait = recommendation == "grade_worthy_but_wait"
        let bestTier = analysis.analysis?.bestTier

        VStack(alignment: .leading, spacing: 12) {
            Text("GRADE ANALYSIS")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            HStack(spacing: 8) {
                Text(isWait ? "\u{26A0}\u{FE0F}" : "\u{1F48E}")
                    .font(.title2)
                Text(isWait ? "Worth grading — but wait" : "GRADE NOW")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(isWait ? HobbyIQTheme.Colors.warning : HobbyIQTheme.Colors.successGreen)
                Spacer(minLength: 0)
                // Small ? info tap. Uses accessibilityHint so the copy
                // reads out for VoiceOver; on tap we don't push a full
                // modal — the same string surfaces as an accessibility
                // announcement, matching the spec's "info toggle" intent.
                Image(systemName: "questionmark.circle")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .accessibilityLabel("About grade analysis")
                    .accessibilityHint("Assumes best-case grade result. Actual outcome depends on card condition.")
            }

            if let tier = bestTier {
                if let median = tier.gradedMedianPrice, median > 0 {
                    let sample = tier.gradedSampleSize ?? 0
                    Text("\(tier.graderTier) avg: \(portfolioCurrencyString(median)) (n=\(sample))")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                if let gain = tier.expectedGain, gain > 0 {
                    let cost = tier.gradingCostAssumed ?? 0
                    Text("After \(portfolioCurrencyString(cost)) grading: +\(portfolioCurrencyString(gain)) gain")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                }
                if let roi = tier.expectedRoiPercentString {
                    Text("\(roi) on cost basis")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }

            // "Also worth: BGS 9.5 (+$310)" — second-best tier when it
            // exists and is meaningful (>= $50 expected gain per the spec's
            // grade_now threshold).
            if let alt = alternateGradeTier(analysis) {
                let gainString = alt.expectedGain.map { "+\(portfolioCurrencyString($0))" } ?? ""
                Text("Also worth: \(alt.graderTier) \(gainString)")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            // Phase 3.10 (2026-07-17, PR #525): observed grader outcome
            // distribution — probability-weighted EV expandable. Lazy
            // fetch fires on first expand.
            graderOutcomesDisclosure(analysis: analysis)

            if isWait {
                Text("Player momentum is down. Waiting could add 25%+ to expected gain.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                gradeAnalysisMarkButton
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(
                    (isWait ? HobbyIQTheme.Colors.warning : HobbyIQTheme.Colors.successGreen).opacity(0.4),
                    lineWidth: 1.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var gradeAnalysisMarkButton: some View {
        Button {
            Task { await markAsAtGradingFromDetail() }
        } label: {
            HStack(spacing: 6) {
                if isMarkingAtGrading {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(HobbyIQTheme.Colors.pureWhite)
                } else {
                    Image(systemName: didMarkAtGrading ? "checkmark.seal.fill" : "shippingbox.fill")
                        .font(.caption.weight(.bold))
                }
                Text(didMarkAtGrading ? "Marked At Grading" : "Mark as At Grading")
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
                didMarkAtGrading
                    ? HobbyIQTheme.Colors.successGreen.opacity(0.7)
                    : HobbyIQTheme.Colors.electricBlue
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(isMarkingAtGrading || didMarkAtGrading)
    }

    /// Phase 3.10 (2026-07-17, PR #525): "What could actually happen?"
    /// disclosure inside the Grade Analysis block. Rendered as a
    /// tri-state ExpandableGroup — collapsed, loading (fetch in flight),
    /// or expanded with the observed distribution.
    ///
    /// The caveat "Based on market OUTCOMES, not a submission guarantee."
    /// is REQUIRED verbatim per the spec — the endpoint's `caveat` field
    /// is the source of truth and we render it as-is.
    @ViewBuilder
    private func graderOutcomesDisclosure(analysis: GradeAnalysisResponse) -> some View {
        DisclosureGroup(isExpanded: Binding(
            get: { graderOutcomesExpanded },
            set: { newValue in
                graderOutcomesExpanded = newValue
                if newValue {
                    Task { await loadGraderOutcomesIfNeeded() }
                }
            }
        )) {
            graderOutcomesContent(analysis: analysis)
                .padding(.top, 8)
        } label: {
            Text("What could actually happen?")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
        .tint(HobbyIQTheme.Colors.electricBlue)
    }

    @ViewBuilder
    private func graderOutcomesContent(analysis: GradeAnalysisResponse) -> some View {
        if let response = graderOutcomes,
           let graders = response.graders, graders.isEmpty == false {
            // Pick the grader matching the best tier's grader (e.g. "PSA")
            // — fallback to the first grader in the response.
            let bestGraderPrefix = analysis.analysis?.bestTier?.graderTier
                .split(separator: " ").first.map(String.init) ?? ""
            let target = graders.first { $0.grader.uppercased() == bestGraderPrefix.uppercased() }
                ?? graders.first
            if let grader = target {
                graderOutcomeDistributionView(grader: grader, response: response, analysis: analysis)
            }
        } else if graderOutcomesExpanded {
            // Fetch in flight or no data.
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini).tint(HobbyIQTheme.Colors.electricBlue)
                Text("Loading distribution…")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func graderOutcomeDistributionView(
        grader: GraderOutcomeDistribution,
        response: GraderOutcomesResponse,
        analysis: GradeAnalysisResponse
    ) -> some View {
        let familyLabel = friendlyFamilyLabel(response.familyKey)
        // Compute probability-weighted expected value client-side:
        // Σ (tierShare × tierMedianPrice) using the medians from
        // grade-analysis.allTiers. When a tier's median isn't in the
        // analysis, skip it — the EV is a directional signal, not a firm
        // number.
        let mediansByTier: [String: Double] = {
            var dict: [String: Double] = [:]
            for tier in analysis.analysis?.allTiers ?? [] {
                if let median = tier.gradedMedianPrice, median > 0 {
                    dict[tier.graderTier] = median
                }
            }
            return dict
        }()
        let expected: Double = {
            var sum = 0.0
            for (tier, share) in grader.tierShares ?? [:] {
                if let median = mediansByTier[tier] {
                    sum += share * median
                }
            }
            return sum
        }()

        VStack(alignment: .leading, spacing: 8) {
            Text("For \"\(familyLabel)\" cards submitted to \(grader.grader), past sales show:")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 4) {
                ForEach(grader.sortedTierShares, id: \.tier) { entry in
                    graderOutcomeRow(tier: entry.tier, share: entry.share, medians: mediansByTier)
                }
            }

            if expected > 0 {
                Text("Probability-weighted expected: \(portfolioCurrencyString(expected))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.top, 2)
            }

            // REQUIRED verbatim caveat — render the backend's copy when
            // present, fall back to the spec's default.
            let caveat = response.caveat?.trimmingCharacters(in: .whitespaces)
                ?? "Based on market OUTCOMES, not a submission guarantee."
            HStack(alignment: .top, spacing: 4) {
                Text("\u{26A0}\u{FE0F}")
                    .font(.caption2)
                Text(caveat)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 4)
        }
    }

    @ViewBuilder
    private func graderOutcomeRow(tier: String, share: Double, medians: [String: Double]) -> some View {
        HStack(spacing: 6) {
            Text(tier)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(width: 80, alignment: .leading)
            Text("=")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("\(Int((share * 100).rounded()))%")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(width: 44, alignment: .leading)
            if let median = medians[tier], median > 0 {
                Text("(\(portfolioCurrencyString(median)) avg)")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
        }
    }

    /// Second-best tier by expectedGain when it clears a meaningful bar
    /// (>= $50, same threshold backend uses for grade_now).
    private func alternateGradeTier(_ analysis: GradeAnalysisResponse) -> GradeAnalysisTier? {
        let bestId = analysis.analysis?.bestTier?.id
        let alts = (analysis.analysis?.allTiers ?? [])
            .filter { $0.id != bestId && ($0.expectedGain ?? 0) >= 50 }
        return alts.first
    }

    /// Corpus signals (2026-07-17): same graderStatus flip as the
    /// portfolio-home banner's list view uses. Deviates from the spec's
    /// literal "call /regrade" instruction — /regrade finalizes the
    /// achieved grade, whereas "At Grading" is a queue status.
    private func markAsAtGradingFromDetail() async {
        isMarkingAtGrading = true
        defer { isMarkingAtGrading = false }
        do {
            _ = try await APIService.shared.updateHoldingGraderStatus(
                holdingId: card.id,
                status: .atPsa
            )
            didMarkAtGrading = true
            selectedStatus = .atPsa
            onUpdated()
        } catch {
            localError = "Couldn't mark this holding as At Grading."
        }
    }

    // MARK: - PREDICTED block (CF-HOLDING-DETAIL-V2; horizon per entry, see CF-PREDICTION-HORIZON-7D)

    /// Same composition as the comp card's predictedBlock — panel
    /// entry is the ONLY source. `predictedPriceAt30d`,
    /// `predictedPricePct`, `predictedPriceRangeLow/High`,
    /// `confidenceScore` all read as-shipped; nothing predictive is
    /// computed on device. Adds a holding-specific "vs your cost"
    /// row underneath. Label horizon is driven by
    /// `entry.predictedHorizonDays` (7 today, per backend PR #301).
    @ViewBuilder
    private func holdingPredictedBlock(entry: CardPanelGradeEntry, predicted: Double) -> some View {
        let confidence = entry.confidenceScore ?? 0
        let isEstimated = entry.valueSource == .estimated
        let dampen = confidence < 0.4 || isEstimated
        let primaryColor: Color = dampen ? HobbyIQTheme.Colors.mutedText : HobbyIQTheme.Colors.pureWhite
        let deltaPct = entry.predictedPricePct
        let horizon = entry.predictedHorizonDays ?? 7
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("PREDICTED (\(horizon)d)")
                    .font(.caption2.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                HStack(spacing: 6) {
                    Text(predicted.currencyStringNoCents)
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(primaryColor)
                    if let delta = deltaPct {
                        let up = delta >= 0
                        Image(systemName: up ? "arrow.up" : "arrow.down")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                        Text(Self.pctString(abs(delta)))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                    }
                }
            }
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 6) {
                    Text("Confidence:")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    confidenceDots(score: confidence, cappedByEstimated: isEstimated)
                }
                Spacer()
                if let low = entry.predictedPriceRangeLow, low > 0,
                   let high = entry.predictedPriceRangeHigh, high > 0 {
                    Text("\(low.currencyStringNoCents) – \(high.currencyStringNoCents)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            // "vs your cost" — subtraction of two backend numbers,
            // which is the ONE permitted piece of client-side
            // arithmetic per the v2 spec.
            if card.cost > 0 {
                let netDollars = predicted - card.cost
                let netPct = (netDollars / card.cost) * 100
                let up = netDollars >= 0
                HStack(alignment: .firstTextBaseline) {
                    Text("vs your cost")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(portfolioCurrencyString(netDollars))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                    Text("· \(Self.pctString(abs(netPct)))")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                }
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

    private static func pctString(_ pct: Double) -> String {
        if abs(pct) >= 10 { return String(format: "%.0f%%", pct) }
        return String(format: "%.1f%%", pct)
    }

    /// 5-dot confidence rail — same thresholds + cap-at-2-on-estimated
    /// rule as the comp card's version.
    private func confidenceDots(score: Double, cappedByEstimated: Bool) -> some View {
        let base: Int
        switch score {
        case 0.85...:      base = 5
        case 0.65..<0.85:  base = 4
        case 0.45..<0.65:  base = 3
        case 0.25..<0.45:  base = 2
        default:           base = 1
        }
        let filled = cappedByEstimated ? min(base, 2) : base
        return HStack(spacing: 2) {
            ForEach(0..<5, id: \.self) { i in
                Circle()
                    .fill(i < filled ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.steelGray.opacity(0.4))
                    .frame(width: 7, height: 7)
            }
        }
    }

    // MARK: - Grading Scenario (CF-HOLDING-DETAIL-V2)

    /// Canonical set of scenario target grades. Raw is intentionally
    /// omitted (a raw holding is already raw — the scenario is "what
    /// if I grade this"). Order matches the comp card's canonical pill
    /// order for visual continuity.
    private static let scenarioGrades: [(label: String, key: String)] = [
        ("PSA 10",  "psa|10"),
        ("PSA 9",   "psa|9"),
        ("BGS 10",  "bgs|10"),
        ("BGS 9.5", "bgs|9.5"),
        ("BGS 9",   "bgs|9"),
        ("SGC 10",  "sgc|10"),
        ("SGC 9",   "sgc|9"),
        ("CGC 10",  "cgc|10"),
        ("CGC 9",   "cgc|9")
    ]

    private var scenarioCostValue: Double {
        Double(gradingCostText.trimmingCharacters(in: .whitespaces)) ?? 0
    }

    private var gradingScenarioCard: some View {
        CollapsiblePortfolioContextCard(
            title: "Grading Scenario",
            icon: "checkmark.seal",
            isExpanded: $gradingScenarioExpanded
        ) {
            VStack(alignment: .leading, spacing: 14) {
                Text("What if you graded this? Pick a target grade, add the grading cost, and see the projected net — from today's comps for that grade. Doesn't affect your holding.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)

                // Target-grade selector — visual reuse of GradePillPanel
                // pill styling, bound to LOCAL scenarioGradeKey. Taps
                // never touch the page's canonical grade.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Self.scenarioGrades, id: \.key) { pair in
                            scenarioPill(label: pair.label, key: pair.key)
                        }
                    }
                    .padding(.horizontal, 4)
                }

                HStack {
                    Text("Grading cost")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    HStack(spacing: 2) {
                        Text("$")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        TextField("25", text: $gradingCostText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 60)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                    .clipShape(Capsule(style: .continuous))
                }

                scenarioResultRows

                Text("Scenario only — based on current comps for the selected grade. Doesn't affect your holding.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func scenarioPill(label: String, key: String) -> some View {
        let entry = entryForKey(key)
        let hasData = entry?.resolvedMarketValue != nil
        let isSelected = scenarioGradeKey == key
        Button {
            scenarioGradeKey = key
        } label: {
            Text(label)
                .font(.caption.weight(.bold))
                .foregroundStyle(hasData ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    Capsule(style: .continuous)
                        .fill(isSelected ? HobbyIQTheme.Colors.electricBlue.opacity(0.22) : HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                )
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(
                            isSelected
                                ? AnyShapeStyle(HobbyIQTheme.Colors.electricBlue)
                                : AnyShapeStyle(
                                    LinearGradient(
                                        colors: [
                                            HobbyIQTheme.Colors.electricBlue.opacity(hasData ? 0.6 : 0.25),
                                            HobbyIQTheme.Colors.hobbyGreen.opacity(hasData ? 0.6 : 0.25)
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                ),
                            lineWidth: isSelected ? 1.5 : 1
                        )
                )
                .opacity(hasData ? 1 : 0.55)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var scenarioResultRows: some View {
        let entry = entryForKey(scenarioGradeKey)
        let projected: Double? = entry?.resolvedMarketValue
        let gradingCost = scenarioCostValue
        let marketValueToday: Double? = {
            if let v = card.fairMarketValue, v > 0 { return v }
            if card.currentValue > 0 { return card.currentValue }
            return nil
        }()
        VStack(alignment: .leading, spacing: 8) {
            scenarioRow(
                label: "Projected value",
                trailing: projected.map { portfolioCurrencyString($0) } ?? "No data"
            )
            scenarioRow(
                label: "Grading cost",
                trailing: gradingCost > 0 ? "− \(portfolioCurrencyString(gradingCost))" : "—"
            )
            Rectangle()
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                .frame(height: 1)
            if let projected {
                let net = projected - gradingCost
                scenarioRow(label: "Net if graded", trailing: portfolioCurrencyString(net), tint: net >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                if card.cost > 0 {
                    let netVsCost = projected - gradingCost - card.cost
                    scenarioRow(
                        label: "Net P/L vs your cost",
                        trailing: portfolioCurrencyString(netVsCost),
                        tint: netVsCost >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
                    )
                }
                if let mv = marketValueToday {
                    let delta = projected - mv
                    scenarioRow(
                        label: "vs raw today",
                        trailing: portfolioCurrencyString(delta),
                        tint: delta >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
                    )
                }
            }
        }
    }

    private func scenarioRow(label: String, trailing: String, tint: Color = .white) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(trailing)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(tint)
        }
    }

    // MARK: - Mark as Graded (CF-HOLDING-REGRADE, backend PR #294)

    /// Fires the atomic POST /api/portfolio/holdings/:id/regrade
    /// endpoint. Backend rolls `gradingCost` into totalCostBasis,
    /// updates grade + cert, re-runs autoPriceHolding for the new
    /// grade, and returns the fresh holding wire shape (with the
    /// recomputed actionRecommendation). iOS surfaces the local
    /// error banner on 400/404; the parent view's `onUpdated`
    /// callback triggers an inventory refresh so the detail view
    /// rebinds against the returned holding.
    private func markAsGraded(
        gradeCompany: String,
        gradeValue: Double,
        certNumber: String?,
        gradingCost: Double?,
        gradingTierId: String?
    ) async {
        do {
            _ = try await APIService.shared.regradeHolding(
                holdingId: card.id,
                gradeCompany: gradeCompany,
                gradeValue: gradeValue,
                certNumber: certNumber,
                gradingCost: gradingCost,
                gradingTierId: gradingTierId
            )
            localError = nil
            onUpdated()
        } catch let error as APIServiceError {
            switch error {
            case .httpError(let status, let body) where status == 400:
                // CF-GRADING-TIERS (2026-07-06): backend returns
                // typed error codes for the two tier-specific 400s.
                // Sniff the body for the code so we can surface the
                // right hint. Everything else falls back to the
                // generic grade-required copy.
                if body.contains("TIER_REQUIRES_EXPLICIT_COST") {
                    localError = "Enter the amount you paid — Premium 2+ pricing varies by card value."
                } else if body.contains("UNKNOWN_GRADING_TIER") {
                    localError = "That grading tier is no longer available. Pick another or use \"Other → Enter custom cost\"."
                } else {
                    localError = "Grade and grade value are required."
                }
            case .httpError(let status, _) where status == 404:
                localError = "Holding not found — refresh your inventory."
            default:
                localError = "Couldn't save the grade change: \(APIService.errorMessage(from: error))"
            }
        } catch {
            localError = "Couldn't save the grade change: \(APIService.errorMessage(from: error))"
        }
    }

    private func commitStatusChange(_ newStatus: GraderStatus, previous: GraderStatus) async {
        do {
            _ = try await APIService.shared.updateHoldingGraderStatus(holdingId: card.id, status: newStatus)
            onUpdated()
        } catch {
            // Roll back the optimistic UI and surface the failure inline.
            selectedStatus = previous
            localError = "Could not update status: \(APIService.errorMessage(from: error))"
        }
    }


    var body: some View {
        // CF-TABBAR-PERSISTENT (2026-06-27): pushed onto the InventoryIQ
        // NavigationStack instead of presented as a sheet so the bottom
        // tab bar stays visible.
        // CF-FLOATING-BACK (2026-07-04): dropped the native nav title
        // bar (redundant with the hero card below) and use a floating
        // back chevron overlay so content stays flush against the top.
        ZStack(alignment: .topLeading) {
            HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // P0.7 (2026-07-16, verdict-history-flip-surfaces.md):
                        // last-3 verdict flips as chips, above the value
                        // block. Suppresses entirely when the player has
                        // no flips in the 90-day window.
                        if recentFlips.isEmpty == false {
                            verdictHistoryStrip(flips: recentFlips)
                        }

                        PortfolioHoldingHeroCard(
                            card: card,
                            // 2026-07-15: only trust the panel's
                            // resolved value when it's OBSERVED with
                            // real comps behind it. Estimated / thin
                            // entries can be strictly worse than the
                            // holding's stored FMV (which was priced
                            // through autoPriceHolding, potentially
                            // with a better source like CH's proxy or
                            // Cardsight rescue). Falling through to
                            // `vm.resolvedMarketValue(for: card)`
                            // keeps the hero in lock-step with what
                            // the inventory row is displaying.
                            livePanelValue: heroLivePanelValue()
                        ) {
                            showingEditSheet = true
                        }

                        // CF-HOLDING-DETAIL-V2 (2026-07-06): PREDICTED
                        // 2026-07-17: PREDICTED (7d/30d) tile pulled from
                        // the holding detail completely. Backend was
                        // sending 30d on the horizon which duplicated
                        // the sparkline under MARKET VALUE. `holdingPredictedBlock`
                        // + `lockedGradeEntry` are still available for
                        // future re-surface on a different tab.
                        // if let entry = lockedGradeEntry(),
                        //    let predicted = entry.predictedPriceAt30d, predicted > 0 {
                        //     holdingPredictedBlock(entry: entry, predicted: predicted)
                        // }

                        // Corpus signals (2026-07-17, PR #517/#519):
                        // matched-cohort Player Momentum block below the
                        // FMV. Self-suppresses when the trend fetch
                        // fails or direction is flat/unknown.
                        if let trend = playerTrend {
                            playerMomentumBlock(trend: trend)
                        }

                        // Corpus signals (2026-07-17, PR #518): per-holding
                        // Grade Analysis.
                        // 2026-07-17: pulled from holding detail per Drew.
                        // Block code + loader kept so we can re-surface on
                        // a different tab. Grade-worthy still shows on the
                        // portfolio-home banner + list.
                        // if let analysis = gradeAnalysisIfActionable() {
                        //     gradeAnalysisBlock(analysis: analysis)
                        // }

                        // Phase 1.4 (2026-07-17, PR #524): observed grader
                        // premium curve — "PSA 10 pays 5.4× raw" per family.
                        // Self-suppresses when tiers.length < 2 or all rows
                        // are low-confidence.
                        if let multipliers = familyMultipliersIfRenderable() {
                            graderPremiumCurveBlock(multipliers: multipliers)
                        }

                        // Batch 2 (2026-07-17, PR #538): observed parallel
                        // premium ladder — "Refractor 2.8×, Gold /50 5.2×".
                        // 2026-07-17: pulled from card detail per Drew.
                        // Block code + loader kept in place for the follow-up
                        // when we find the right surface (probably a
                        // standalone drill-down, not inline on the holding).
                        // if let bucket = renderableParallelLadder() {
                        //     parallelLadderBlock(bucket: bucket)
                        // }

                        // Batch 2 (2026-07-17, PR #531): parallels in this
                        // bucket the user doesn't own — set-completion nudge.
                        // Hidden when the bundle has zero entries.
                        if let bundle = renderableMissingParallels() {
                            missingParallelsBlock(bundle: bundle)
                        }

                        // PREDICTED (7d) moved up under the hero
                        // 2026-07-17. Grading Scenario stays here — it's
                        // a raw-only branch that reads the same panel
                        // payload but pushes a bigger disclosure UI.
                        if isRawHolding, panelEntries.isEmpty == false {
                            gradingScenarioCard
                        }

                        // CF-IOS-DIRECTION-CLEANUP (2026-06-18): direction
                        // sites pruned. Removed Predicted Price, Predicted
                        // Range, Verdict (statusChipText reads the backend
                        // action recommendation — direction-class). Movement
                        // Signal card entirely removed; backtest established
                        // direction is at-chance. Fair Market row's `method`
                        // subtitle is comp-status (from the null-FMV PR) and
                        // stays.
                        PortfolioContextCard(title: "Pricing Context") {
                            // 2026-07-17: Fair Market row dropped — the
                            // hero's MARKET VALUE already carries it.
                            // Anchor / Estimated / Why-this-estimate stays
                            // (that's provenance, not a duplicate number).
                            if card.valuationStatus == "estimated" {
                                HStack {
                                    Spacer(minLength: 0)
                                    Text("Estimated")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                                        .clipShape(Capsule(style: .continuous))
                                }
                            }
                            if let anchor = card.nearestGradedAnchor {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Source")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                        .textCase(.uppercase)
                                        .tracking(0.4)
                                    Rectangle()
                                        .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                                        .frame(height: 1)
                                    Text("\(anchor.grade) sold for \(portfolioCurrencyString(anchor.price))")
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                    Text("\(anchor.longAge) · \(anchor.compCountPhrase) · \(anchor.confidenceBand) confidence")
                                        .font(.caption)
                                        .foregroundStyle(anchor.tintColor)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 4)
                            }
                            if card.valuationStatus == "estimated",
                               let basis = card.estimateBasis,
                               basis.isEmpty == false {
                                DisclosureGroup("Why this estimate") {
                                    Text(basis)
                                        .font(.caption)
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                        .multilineTextAlignment(.leading)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .font(.subheadline.weight(.medium))
                                .tint(HobbyIQTheme.Colors.electricBlue)
                            }
                            // 2026-07-17: Quick Sale + Suggested List
                            // side-by-side (was stacked). Reads compact
                            // and leaves room for the sparkline above.
                            HStack(alignment: .top, spacing: 12) {
                                pricingContextTile(
                                    label: "Quick Sale",
                                    value: card.lowValue.map { portfolioCurrencyString($0) } ?? "—"
                                )
                                pricingContextTile(
                                    label: "Suggested List",
                                    value: card.highValue.map { portfolioCurrencyString($0) } ?? "—"
                                )
                            }

                            // 2026-07-17: View CompIQ is now a text link,
                            // not a full-width pill — de-emphasized so the
                            // primary CTA at the bottom of the page carries
                            // more visual weight.
                            Button {
                                showingCompIQAnalysis = true
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "doc.text.magnifyingglass")
                                        .font(.caption2.weight(.semibold))
                                    Text("View CompIQ analysis")
                                        .font(.caption.weight(.semibold))
                                    Image(systemName: "chevron.right")
                                        .font(.caption2.weight(.bold))
                                }
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 4)
                        }

                        CollapsiblePortfolioContextCard(
                            title: "Reference Data",
                            icon: "doc.text.magnifyingglass",
                            isExpanded: $referenceDataExpanded
                        ) {
                            detailRow(title: "Purchase Price", value: card.costFormatted)
                            detailRow(title: "Profit / Loss", value: card.profitFormatted, valueColor: card.profitLoss >= 0 ? .green : .red)
                            detailRow(title: Labels.roi, value: card.roiFormatted, valueColor: card.profitLoss >= 0 ? .green : .red)
                            detailRow(title: "Purchase Date", value: card.purchaseDateFormatted)
                            detailRow(title: "Purchase Location", value: card.purchasePlatformText)
                            detailRow(title: "Year", value: card.displayYear.isEmpty ? "—" : card.displayYear)
                            detailRow(title: "Set", value: card.displaySet.isEmpty ? "—" : card.displaySet)
                            detailRow(title: "Parallel", value: card.parallel.isEmpty ? "—" : card.parallel)
                            detailRow(title: "Grade", value: card.grade.isEmpty ? "—" : card.grade)
                            detailRow(
                                title: "Cert #",
                                value: (card.certNumber?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 } ?? "—"
                            )
                            detailRow(title: "Auto", value: card.isAuto ? "Yes" : "No")
                            graderStatusRow
                            detailRow(title: "Quantity", value: card.quantity.map { String(format: "%.0f", $0) } ?? "—")
                            detailRow(title: "Notes", value: card.notes?.isEmpty == false ? card.notes! : "—")
                            detailRow(title: Labels.confidence, value: card.confidence.map { String(format: "%.0f%%", $0 * 100) } ?? "—")
                            detailRow(title: "Method", value: card.method?.isEmpty == false ? card.method! : "—")
                            detailRow(title: "Summary", value: card.summary?.isEmpty == false ? card.summary! : "—")
                        }

                        if let lastEbayListingResponse {
                            PortfolioContextCard(title: "Latest eBay Result") {
                                detailRow(title: "Listing ID", value: lastEbayListingResponse.listingId ?? "—")
                                detailRow(title: "URL", value: lastEbayListingResponse.listingURL ?? "—")
                                detailRow(title: "Status", value: lastEbayListingResponse.status ?? "—")
                                detailRow(title: "Message", value: lastEbayListingResponse.message ?? "—")
                            }
                        }

                        // CF-HOLDING-DETAIL-REFRESH (2026-07-06): Photos
                        // section moved out of the primary read path.
                        // The old placement (right under the hero)
                        // made the view feel like an edit form; users
                        // scrolling for pricing/context saw a big
                        // add-a-photo panel first. Now it lives near
                        // the bottom next to the destructive actions,
                        // where a user going into "edit mode" would
                        // naturally look.
                        PortfolioDetailPhotosCard(viewModel: viewModel, card: card, onUpdated: onUpdated)

                        // Scope 3 (2026-07-12): held-expenses (grading,
                        // supplies, insurance, storage, etc). Backend
                        // rolls each POST into totalCostBasis and returns
                        // the fresh value — the card refreshes itself
                        // on save so the "current cost basis" row
                        // upstream reflects the delta immediately.
                        HoldingHeldExpensesCard(
                            holdingId: card.id.uuidString,
                            seedHolding: card,
                            onCostBasisChanged: { _ in
                                onUpdated()
                            },
                            onExpenseAdded: {
                                // Refresh the inventory upstream, then
                                // pop this sheet so the user sees the
                                // updated cost basis on the row.
                                onUpdated()
                                if let onBack {
                                    onBack()
                                } else {
                                    dismiss()
                                }
                            }
                        )

                        // CF-EBAY-BROWSE-ENRICHMENT (backend PR #383):
                        // eBay Item Specifics + seller footer for
                        // auto-imported holdings. Both self-suppress
                        // when the underlying wire fields are nil.
                        HoldingEbayEnrichmentSection(card: card)

                        // CF-SOLD-COMPS (backend PR #386): recent comps
                        // for this exact grade/set/parallel filter set.
                        // 2026-07-17: filter loosened to drop the
                        // exact-parallel gate + feed cardNumber so
                        // sibling variants surface as comps.
                        SoldCompsSection(card: card)
                            .padding(.horizontal, 16)

                        // 2026-07-17: reserves layout space for the
                        // future eBay active-listings-by-card feed.
                        // Replaces with real data when the backend endpoint
                        // ships.
                        ActiveEbayListingsPlaceholder()
                            .padding(.horizontal, 16)

                        if let localError {
                            Text(localError)
                                .font(.footnote)
                                .foregroundStyle(Color.red)
                        }

                        // 2026-07-17: consolidated action stack —
                        // primary "List on eBay" pill + a 3-icon
                        // secondary row (Verify Card / Mark as Graded /
                        // Mark Sold) so the actionable CTA carries more
                        // visual weight than the housekeeping actions.
                        // Remove from Portfolio stays at the bottom as a
                        // destructive text button.
                        VStack(spacing: 12) {
                            if ebayStore.connectionState != .connected {
                                Button {
                                    localError = nil
                                    ebayStore.startConnect()
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: ebayStore.isConnecting ? "hourglass" : "person.crop.circle.badge.checkmark")
                                        Text(ebayStore.isConnecting ? "Connecting..." : "Connect eBay")
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(ebayStore.isConnecting)
                            }

                            // Primary CTA — the actionable one.
                            Button {
                                showingEbayListingSheet = true
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "cart.badge.plus")
                                    Text(ebayStore.connectionState == .connected ? "List on eBay" : "Open eBay Draft")
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(ebayStore.isConnecting)

                            // Secondary row — 3 icon buttons per spec
                            // (Verify Card / Mark as Graded / Mark Sold),
                            // ordered left-to-right. Mark as Graded is
                            // raw-only; when the holding is already
                            // graded we still render the row with a
                            // muted placeholder so the layout doesn't
                            // reflow.
                            HStack(alignment: .top, spacing: 8) {
                                holdingSecondaryAction(
                                    icon: "checkmark.circle.badge.questionmark",
                                    caption: "Verify Card"
                                ) { showingVerifyCardSheet = true }

                                if isRawHolding {
                                    holdingSecondaryAction(
                                        icon: "checkmark.seal",
                                        caption: "Mark as Graded"
                                    ) { showingMarkAsGradedSheet = true }
                                } else {
                                    holdingSecondaryPlaceholder()
                                }

                                holdingSecondaryAction(
                                    icon: "dollarsign.circle",
                                    caption: "Mark Sold"
                                ) { showingSoldSheet = true }
                            }

                            Button(role: .destructive) {
                                showingRemoveModal = true
                            } label: {
                                Text("Remove from Portfolio")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .tint(.red)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 20)
                }
                .navigationBarBackButtonHidden(true)
                .toolbar(.hidden, for: .navigationBar)
                .task { await fetchPanelIfPossible() }
                .task { await loadVerdictHistory() }
                .task { await loadPlayerTrend() }
                .task { await loadGradeAnalysis() }
                .task { await loadFamilyMultipliers() }
                .task { await loadParallelLadder() }
                .task { await loadMissingParallels() }
                .task {
                    // P1 (2026-07-16, iOS delta): first meaningful use —
                    // opening a holding detail. Ask for push permission
                    // here (once, guarded by UserDefaults) per Apple HIG.
                    await PushNotificationManager.shared.askIfFirstMeaningfulUse()
                }
                .navigationDestination(isPresented: $showingMarkAsGradedSheet) {
                    MarkAsGradedSheet(card: card) { gradeCompany, gradeValue, certNumber, gradingCost, gradingTierId in
                        Task {
                            await markAsGraded(
                                gradeCompany: gradeCompany,
                                gradeValue: gradeValue,
                                certNumber: certNumber,
                                gradingCost: gradingCost,
                                gradingTierId: gradingTierId
                            )
                        }
                    }
                }
                .navigationDestination(isPresented: $showingSoldSheet) {
                    PortfolioHoldingSoldSheet(viewModel: viewModel, card: card) {
                        onUpdated()
                        dismiss()
                    }
                }
                .navigationDestination(isPresented: $showingEditSheet) {
                    AddPortfolioCardView(viewModel: AddPortfolioCardViewModel(existingCard: card)) {
                        // Pull the freshly-saved holding out of
                        // LocalPortfolioProvider (which `save()` patches
                        // atomically) into `vm.inventoryCards` so the
                        // list reflects the edit before we pop back.
                        // Intentionally does NOT trigger the parent's
                        // `onUpdated()` refresh — the backend PATCH
                        // returns before the read replica catches up,
                        // so an immediate `/portfolio` fetch would
                        // overwrite the fresh local edit with stale
                        // data. Next natural refresh reconciles.
                        Task { await viewModel.applyLocalHoldingsUpdate() }
                        dismiss()
                    }
                }
                .navigationDestination(isPresented: $showingEbayListingSheet) {
                    EbayListingDraftView(viewModel: viewModel, card: card) {
                        lastEbayListingResponse = $0
                        onUpdated()
                    }
                }
                .sheet(isPresented: $showingVerifyCardSheet) {
                    VerifyCardSheet(holding: card) {
                        // Confirmed → refresh so the newly-priced
                        // holding + any cardId change materializes on
                        // detail + inventory.
                        onUpdated()
                    }
                }
                .navigationDestination(isPresented: $showingCompIQAnalysis) {
                    PortfolioCompIQBridgeView(holding: card, sessionViewModel: sessionViewModel)
                        .environmentObject(sessionViewModel)
                }

                if showingRemoveModal {
                    CenteredRemoveConfirmationModal(
                        title: "Remove this card?",
                        message: "This will remove the holding from your portfolio.",
                        confirmTitle: "Remove",
                        isConfirming: viewModel.isLoading,
                        onCancel: {
                            showingRemoveModal = false
                        },
                        onConfirm: {
                            showingRemoveModal = false
                            Task {
                                let didRemove = await viewModel.removeHolding(card)
                                if didRemove {
                                    onUpdated()
                                    dismiss()
                                } else {
                                    localError = viewModel.errorMessage ?? "Could not remove that card."
                                }
                            }
                        }
                    )
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    .zIndex(10)
                }

                // CF-FLOATING-BACK (2026-07-04): persistent back chevron.
                Button {
                    if let onBack {
                        onBack()
                    } else {
                        dismiss()
                    }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(HobbyIQTheme.Colors.cardNavy.opacity(0.9)))
                        .overlay(Circle().stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1))
                        .shadow(color: .black.opacity(0.4), radius: 8, x: 0, y: 4)
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
                .padding(.leading, 12)
                .accessibilityLabel("Back")
                .zIndex(11)
            }
        .task {
            await ebayStore.refreshConnectionStatus()
        }
        .onChange(of: ebayStore.lastErrorMessage) { _, newValue in
            if let newValue {
                localError = newValue
            }
        }
    }
}

/// CF-HOLDING-HERO-REDESIGN (2026-07-06): mirror the CompIQ comp-card
/// hero on the holding detail view. Centered player name, flat single-
/// line identity, centered card hero image, big MARKET VALUE headline,
/// compact PP/PL chip row. Edit lives as a floating pill top-right
/// instead of taking a corner of the top row.
struct PortfolioHoldingHeroCard: View {
    let card: InventoryCard
    /// CF-INVENTORY-COMPCARD-MATCH (2026-07-08): optional override for
    /// the MARKET VALUE headline. Callers that have a live panel-entry
    /// value (same source the comp card uses) pass it here so the
    /// two surfaces render the same number. Nil = fall back to the
    /// holding's cached `fairMarketValue` chain.
    var livePanelValue: Double? = nil
    let onEdit: () -> Void

    /// 2026-07-17: 3-month weekly price-history for the sparkline under
    /// MARKET VALUE. Nil until the first fetch; empty on thin data.
    @State private var sparklinePoints: [PriceHistoryBucketPoint]?

    /// Flat identity line: "{year} {set-no-year-no-category} [variant] [Auto] {number}"
    /// (same rule the comp-card header uses). Strips a leading year
    /// from the set name when it duplicates `card.year` (backend often
    /// ships setName as "2006 Bowman Draft Picks & Prospects Baseball",
    /// which would otherwise render as "2006 2006 Bowman Draft…").
    /// Strips " Baseball" / " Basketball" / " Football" / " Pokemon"
    /// off the set, drops literal "Base" variant, appends " Auto" when
    /// the holding is auto.
    private var flatIdentityLine: String? {
        let year = card.year.trimmingCharacters(in: .whitespaces)
        var parts: [String] = []
        if year.isEmpty == false { parts.append(year) }
        let cleanedSet = Self.stripCategorySuffix(
            Self.stripLeadingYear(from: card.setName.trimmingCharacters(in: .whitespaces), year: year)
        )
        if cleanedSet.isEmpty == false { parts.append(cleanedSet) }
        let variant = card.parallel.trimmingCharacters(in: .whitespaces)
        if variant.isEmpty == false, variant.lowercased() != "base" {
            parts.append(variant)
        }
        if card.isAuto { parts.append("Auto") }
        let joined = parts.joined(separator: " ")
        return joined.isEmpty ? nil : joined
    }

    private static let categorySuffixes: [String] = [
        " Baseball", " Basketball", " Football", " Pokemon", " Hockey", " Soccer"
    ]

    private static func stripCategorySuffix(_ raw: String) -> String {
        for s in categorySuffixes where raw.lowercased().hasSuffix(s.lowercased()) {
            return String(raw.dropLast(s.count)).trimmingCharacters(in: .whitespaces)
        }
        return raw
    }

    /// Drop a leading 4-digit year token from `setName` when it matches
    /// `year` — prevents "2006 2006 Bowman…" duplication. Only strips
    /// when the token is followed by whitespace or the set is exactly
    /// the year itself.
    static func stripLeadingYear(from setName: String, year: String) -> String {
        guard year.isEmpty == false else { return setName }
        let trimmed = setName.trimmingCharacters(in: .whitespaces)
        if trimmed == year { return "" }
        let prefix = "\(year) "
        if trimmed.hasPrefix(prefix) {
            return String(trimmed.dropFirst(prefix.count))
        }
        return trimmed
    }

    /// Holding hero image — delegates to `card.preferredThumbnailURL`
    /// (PR #383 priority: `photos[0] → ebayImageUrl → imageFrontUrl →
    /// catalogImageUrl`). eBay-auto rows show the Browse photo; manual
    /// holdings still fall through to the user's uploaded photo since
    /// `photos[]` and `ebayImageUrl` are nil there.
    private var heroImageUrlString: String? {
        card.preferredThumbnailURL?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 14) {
                VStack(alignment: .center, spacing: 4) {
                    Text(card.playerName.isEmpty ? card.fullDisplayName : card.playerName)
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)

                    if let details = flatIdentityLine {
                        Text(details)
                            .font(.system(size: 14))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 36) // clear the Edit pill overlay
                .frame(maxWidth: .infinity)

                heroImage
                    .frame(maxWidth: 193)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                // CF-HOLDING-GRADE-CHIP (2026-07-06, v2): static
                // grade chip locks the page to the holding's grade.
                // Raw shows "Raw"; graded shows "PSA 9" / "BGS 9.5"
                // / etc. Non-interactive — the whole detail view
                // (MARKET VALUE, PREDICTED, action badge, scenario)
                // is scoped to this one grade.
                gradeChip

                marketValueBlock
            }
            .padding(18)
            .frame(maxWidth: .infinity)
            .background(
                LinearGradient(
                    colors: [Color(hex: 0x141821), Color(hex: 0x1A1F2E)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [HobbyIQTheme.Colors.electricBlue.opacity(0.25), Color.white.opacity(0.06)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1.2
                    )
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))

            editPill
                .padding(.top, 10)
                .padding(.trailing, 10)
        }
    }

    /// Card hero — same treatment as the comp-card hero (scaledToFit +
    /// scaleEffect(0.85) inside a maxWidth-constrained frame). Falls
    /// through to a neutral card-shape placeholder when no URL is on
    /// hand.
    @ViewBuilder
    private var heroImage: some View {
        if let urlString = heroImageUrlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty, .failure:
                    heroImagePlaceholder
                @unknown default:
                    heroImagePlaceholder
                }
            }
        } else {
            heroImagePlaceholder
        }
    }

    private var heroImagePlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.25))
            Image(systemName: "rectangle.portrait")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
        }
        .aspectRatio(0.72, contentMode: .fit)
    }

    /// MARKET VALUE headline — canonical comp-card "Market value $X" +
    /// gradient text + electric-blue glow.
    /// CF-INVENTORY-COMPCARD-MATCH (2026-07-08): source order aligns
    /// with the comp card. First try the live panel entry for this
    /// holding's grade — `resolvedMarketValue` is the exact same
    /// fallback chain the comp card uses (`trendAdjustedValue →
    /// value → weightedMedianPrice → plainMedianPrice`), so the
    /// inventory detail and the comp card render the same number.
    /// Only if the panel hasn't loaded yet (or has no entry for this
    /// grade) do we degrade to the holding's cached
    /// `fairMarketValue` → `currentValue` → `estimatedValue`.
    private var marketValueBlock: some View {
        let value: Double? = {
            if let live = livePanelValue, live > 0 { return live }
            if let v = card.fairMarketValue, v > 0 { return v }
            if card.currentValue > 0 { return card.currentValue }
            if let v = card.estimatedValue, v > 0 { return v }
            return nil
        }()
        return VStack(spacing: 8) {
            Text("MARKET VALUE")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let value {
                Text(wholeUSDString(value))
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 14, x: 0, y: 0)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                // 2026-07-17: 30-day sparkline directly under the price.
                // Fetches on task from /price-history (window=3m, bucket=weekly).
                // Hidden entirely when < 2 usable points arrive.
                heroSparkline
            } else {
                Text("Not enough data yet")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .task(id: card.cardId ?? "") { await loadHeroSparkline() }
    }

    /// Compact chart-only sparkline — no axes, no grid, 44pt height.
    /// Self-suppresses on thin data (< 2 points with median > 0).
    @ViewBuilder
    private var heroSparkline: some View {
        let usable = (sparklinePoints ?? []).filter {
            $0.parsedDate != nil && ($0.medianPrice ?? 0) > 0
        }
        if usable.count >= 2 {
            Chart {
                ForEach(usable) { point in
                    if let date = point.parsedDate,
                       let median = point.medianPrice {
                        LineMark(
                            x: .value("Date", date),
                            y: .value("Price", median)
                        )
                        .interpolationMethod(.monotone)
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartPlotStyle { plot in
                plot.background(Color.clear).border(Color.clear, width: 0)
            }
            .frame(height: 44)
            .padding(.horizontal, 4)
            .padding(.top, 2)
        }
    }

    private func loadHeroSparkline() async {
        let id = card.cardId?.trimmingCharacters(in: .whitespaces) ?? ""
        guard id.isEmpty == false else { return }
        do {
            let response = try await APIService.shared.fetchPriceHistory(
                cardId: id,
                window: PriceHistoryWindow.threeMonths.rawValue,
                bucket: PriceHistoryBucket.weekly.rawValue
            )
            sparklinePoints = response.points
        } catch {
            sparklinePoints = nil
        }
    }

    /// The holding's locked grade as a display label — "Raw" for
    /// ungraded holdings, "PSA 10" / "BGS 9.5" / etc. for graded.
    /// Composed from `(gradeCompany, gradeValue)` when both present,
    /// falls back to the wire's `grade` string when they're not.
    private var gradeChipLabel: String {
        if let company = card.gradeCompany?.trimmingCharacters(in: .whitespaces),
           let value = card.gradeValue,
           company.isEmpty == false {
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return "\(company) \(valueStr)"
        }
        let trimmed = card.grade.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "Raw" : trimmed
    }

    /// Same visual as a GradePillPanel pill in the selected state —
    /// electric-blue accent, gradient stroke, filled background — but
    /// non-interactive.
    private var gradeChip: some View {
        Text(gradeChipLabel)
            .font(.caption.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.22))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [
                                HobbyIQTheme.Colors.electricBlue,
                                HobbyIQTheme.Colors.hobbyGreen.opacity(0.7)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        ),
                        lineWidth: 1.5
                    )
            )
            .clipShape(Capsule(style: .continuous))
    }

    private var editPill: some View {
        Button(action: onEdit) {
            HStack(spacing: 4) {
                Image(systemName: "pencil")
                    .font(.caption2.weight(.bold))
                Text("Edit")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.85))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
    }
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

// MARK: - Shared Inventory Card Components

struct PortfolioCardRow: View {
    let card: InventoryCard
    /// Fully-resolved market value for THIS holding (already scaled by
    /// quantity). Callers compute it via
    /// `PortfolioIQViewModel.resolvedMarketValue(for:)` so the row,
    /// grid, detail hero, header total, and sort all read the same
    /// number. When nil (e.g. previews), the row falls back to the
    /// legacy per-field chain inside `inventoryRightColumn`.
    var resolvedValue: Double? = nil
    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): most recent
    /// flip within the last 14 days for this holding's player. Renders
    /// as a 6pt colored dot in the leading padding. Nil when no fresh
    /// flip exists; the row looks identical to before.
    var latestFlip: VerdictFlip? = nil
    /// Corpus signals (2026-07-17): matched-cohort player-level momentum
    /// for this row. Renders as an ▲/▼/► glyph + `+X%` string next to
    /// the player name. Flag-aware treatment (sparse = gray, dominant
    /// or dispersion = subline) applied via `PlayerTrendArrow`.
    var playerTrend: PlayerTrendResponse? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                inventoryRowThumbnail(
                    urlString: card.preferredThumbnailURL,
                    playerName: card.playerName
                )

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(card.playerName)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        // Corpus signals (2026-07-17): matched-cohort
                        // momentum arrow. Self-suppresses when the trend
                        // is unloaded / flat / directionless.
                        if let trend = playerTrend {
                            PlayerTrendArrow(trend: trend, style: .compact)
                        }
                    }

                    // 2026-07-17: consolidated metadata line —
                    // "2026 Bowman · Orange Shimmer Refractor · Raw".
                    // Set string strips trailing " Baseball" / etc. and
                    // gets titlecased on wire read; grade tier condensed
                    // to short form ("Raw" / "PSA 10").
                    if let meta = inventoryMetadataLine(for: card) {
                        Text(meta)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    // Grader status kept as its own line — surfaces "At PSA"
                    // vs "Available", which is different signal from the
                    // metadata identity above.
                    if card.graderStatus != .available {
                        HStack(spacing: 4) {
                            Text("Status:")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(card.graderStatus.displayLabel)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(card.graderStatus.tintColor)
                        }
                    }

                    // 2026-07-17: dropped the standalone grade pill (grade
                    // is already in the metadata line) and the "via eBay"
                    // chip (it appeared on all rows, so no signal).
                    // Black Label / Needs Review / Listed chips stay —
                    // those ARE conditional signal.
                    HStack(spacing: 6) {
                        if card.isBlackLabel == true {
                            inventoryBlackLabelChip()
                        }
                        if card.showsNeedsReviewPill {
                            inventoryReviewPill()
                        }
                        if card.isListedOnEbay {
                            inventoryListedChip(price: card.listingPrice)
                        }
                    }

                    if let rec = card.actionRecommendation,
                       rec.verdict != .insufficientData {
                        inventoryActionBadge(rec: rec)
                    }
                }

                Spacer(minLength: 8)

                inventoryRightColumn(card: card, resolvedValue: resolvedValue)
            }

            // CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): LiveMarket headline
            // + model line + lean badge. Self-suppresses when all three
            // blocks are absent (legacy holdings, or non-LiveMarket cards).
            LiveMarketModelSignalView(
                lastSalePrice: card.lastSaleSurface?.price,
                lastSaleCompCount: card.lastSaleSurface?.compCount,
                modelExpectation: card.modelExpectation,
                modelSignal: card.modelSignal
            )
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 64)
        // P0.7 (2026-07-16, verdict-history-flip-surfaces.md): 6pt
        // freshness dot in the row's leading gutter. Color reflects the
        // NEW verdict (post-flip); opacity fades over 14 days; hidden past
        // day 14. Sits in the padding, not over card art.
        .overlay(alignment: .leading) {
            if let flip = latestFlip, let opacity = flip.dotOpacity {
                Circle()
                    .fill(verdictFlipDotColor(for: flip.to))
                    .frame(width: 6, height: 6)
                    .opacity(opacity)
                    .padding(.leading, 3)
                    .accessibilityLabel("Recent \(flip.to ?? "verdict") flip")
            }
        }
    }
}

/// P0.7 (2026-07-16): dot color mapping per verdict-history-flip-surfaces.md.
/// Green for bull-side, red for bear-side, gray for neutral / unknown.
/// Kept separate from `VerdictStyle.color` because that helper's palette
/// uses opacity-modulated hues (bull vs strong_bull tinting) that read
/// poorly at 6pt.
private func verdictFlipDotColor(for verdict: String?) -> Color {
    switch verdict?.lowercased() {
    case "bull", "strong_bull", "supply_tight":
        return .green
    case "bear", "soft", "weak", "oversupply":
        return .red
    default:
        return .gray
    }
}

/// Corpus signals (2026-07-17): matched-cohort player-level momentum
/// glyph + optional % text. Renders as ▲ (green) / ▼ (red) / omitted
/// (flat) per the corpus-signals prompt. Compact style is for inline use
/// next to the player name on inventory rows; detail style adds a
/// larger typographic treatment for the card-detail Player Momentum block.
///
/// Flags-aware treatment:
///   - "sparse" → glyph dimmed to 40% opacity with a system-image
///     info tooltip surface (accessibility hint).
///   - Any other flag → normal glyph (subline copy handled by caller).
///
/// The whole view self-suppresses when direction is `"flat"` / nil /
/// unknown — the row reads cleaner with no signal than with a "─".
struct PlayerTrendArrow: View {
    let trend: PlayerTrendResponse
    let style: Style

    enum Style {
        /// Inline chip: 10pt glyph + 11pt caption text next to player name.
        case compact
        /// Full-size: 22pt glyph + 15pt semibold caption for card detail.
        case detail
    }

    var body: some View {
        let direction = trend.direction?.lowercased() ?? ""
        let color: Color = {
            switch direction {
            case "up": return HobbyIQTheme.Colors.successGreen
            case "down": return HobbyIQTheme.Colors.danger
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()
        let glyph: String? = {
            switch direction {
            case "up": return "\u{25B2}"
            case "down": return "\u{25BC}"
            default: return nil
            }
        }()

        if let glyph, let pct = trend.momentumPercentString {
            let sparse = trend.hasFlag("sparse")
            HStack(spacing: 3) {
                Text(glyph)
                    .font(style == .detail ? .system(size: 22, weight: .bold) : .caption.weight(.bold))
                    .foregroundStyle(color)
                Text(pct)
                    .font(style == .detail ? .system(size: 15, weight: .semibold) : .caption.weight(.semibold))
                    .foregroundStyle(color)
            }
            .opacity(sparse ? 0.4 : 1.0)
            .accessibilityLabel(sparse ? "\(pct) player momentum, limited data" : "\(pct) player momentum")
        }
    }
}

struct PortfolioCardGridCard: View {
    let card: InventoryCard
    /// Same canonical `resolvedMarketValue(for:)` output the list row
    /// takes; keeps grid and row in sync.
    var resolvedValue: Double? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            inventoryGridThumbnail(
                urlString: card.preferredThumbnailURL,
                playerName: card.playerName
            )

            VStack(alignment: .leading, spacing: 4) {
                Text(card.playerName)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)

                // 2026-07-17: single consolidated metadata line (same as
                // the row layout). Grade tier is baked in — no separate pill.
                if let meta = inventoryMetadataLine(for: card) {
                    Text(meta)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }

                if card.graderStatus != .available {
                    HStack(spacing: 3) {
                        Text("Status:")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(card.graderStatus.displayLabel)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(card.graderStatus.tintColor)
                            .lineLimit(1)
                    }
                }

                // 2026-07-17: dropped the grade pill (in metadata line)
                // and the via-eBay chip (universal → no signal).
                HStack(spacing: 4) {
                    if card.showsNeedsReviewPill {
                        inventoryReviewPill()
                    }
                    if card.isListedOnEbay {
                        inventoryListedChip(price: card.listingPrice)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)

            Spacer(minLength: 6)

            let value: Double = {
                if let resolvedValue, resolvedValue > 0 { return resolvedValue }
                let qty = max(1.0, card.quantity ?? 1.0)
                if let v = card.fairMarketValue, v > 0 { return v * qty }
                if card.currentValue > 0 { return card.currentValue }
                if let v = card.estimatedValue, v > 0 { return v * qty }
                if let best = card.bestKnownMarketValue { return best.perUnit * qty }
                return 0
            }()

            // 2026-07-17: dropped MARKET VALUE caption from grid tile.
            Text(value > 0 ? inventoryWholeDollarString(value) : "—")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(value > 0 ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
    }
}

// MARK: - Inventory row helpers (private to the inventory rows above)

/// Composes the muted secondary line: "Year · Set". Falls back to the legacy
/// cardName when neither structured field is present so we never render a
/// blank line in legacy data.
// MARK: - CF-IOS-MODEL-SIGNAL-RENDER list-cell preview (2026-06-26)

#Preview("PortfolioCardRow · Hartman sell (model-signal on list)") {
    let card = InventoryCard(
        playerName: "Eric Hartman",
        cardName: "Green Shimmer Refractor /99 Auto",
        cost: 0,
        currentValue: 450,
        status: "active",
        year: "2026",
        setName: "Bowman",
        parallel: "Green Shimmer Refractor",
        grade: "",
        isAuto: true,
        lastSaleSurface: LiveMarketLastSaleSurface(price: 450, date: "2026-06-20T12:00:00Z", compCount: 1),
        modelExpectation: LiveMarketModelExpectation(
            value: 262, range: [250, 273], multiplier: 3.20, multiplierRange: [3.05, 3.33],
            basis: "prices_by_card_honest", n: 11, baseAutoMedian: 82, baseAutoCount: 69
        ),
        modelSignal: LiveMarketModelSignal(
            lean: "sell", deltaPct: 72, expectation: 262, effectiveMultiplier: 3.20
        )
    )
    return VStack(spacing: 12) {
        Text("List row — Hartman Green Shimmer /99 Auto (sell signal)")
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        PortfolioCardRow(card: card)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
    .padding()
    .background(HobbyIQTheme.Colors.appBackground)
    .preferredColorScheme(.dark)
}

/// 2026-07-17: single-line row metadata — "2026 Bowman · Orange Shimmer
/// Refractor · Raw". Strips trailing " Baseball" / etc. off the set,
/// titlecases when it's all-lowercase (backend feed hygiene follow-up),
/// and dedupes when the set already leads with the year.
private func inventoryMetadataLine(for card: InventoryCard) -> String? {
    var parts: [String] = []
    let year = card.year.trimmingCharacters(in: .whitespacesAndNewlines)
    var setName = PortfolioHoldingHeroCard.stripLeadingYear(
        from: card.setName.trimmingCharacters(in: .whitespacesAndNewlines),
        year: year
    )
    // Strip trailing category from set name — reads cleaner.
    for suffix in [" Baseball", " Basketball", " Football", " Pokemon", " Hockey", " Soccer"] {
        if setName.lowercased().hasSuffix(suffix.lowercased()) {
            setName = String(setName.dropLast(suffix.count)).trimmingCharacters(in: .whitespaces)
            break
        }
    }
    // Titlecase when the whole string is lowercase — backend feed
    // sometimes ships lowercased set strings and it looks like a bug.
    // TODO(2026-07-17): backend follow-up to canonicalize on the wire.
    if setName.isEmpty == false, setName == setName.lowercased() {
        setName = setName.capitalized(with: .current)
    }

    if year.isEmpty == false, setName.isEmpty == false {
        parts.append("\(year) \(setName)")
    } else if year.isEmpty == false {
        parts.append(year)
    } else if setName.isEmpty == false {
        parts.append(setName)
    }

    var parallel = card.parallel.trimmingCharacters(in: .whitespacesAndNewlines)
    if parallel.lowercased() == "base" { parallel = "" }
    if card.isAuto, parallel.isEmpty == false {
        parts.append("\(parallel) Auto")
    } else if card.isAuto {
        parts.append("Auto")
    } else if parallel.isEmpty == false {
        parts.append(parallel)
    }

    // Grade tier — "Raw" for ungraded, condensed grade string otherwise.
    let gradeShort: String = {
        if let company = card.gradeCompany?.trimmingCharacters(in: .whitespaces),
           company.isEmpty == false,
           let value = card.gradeValue {
            let v = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return "\(company) \(v)"
        }
        let raw = card.grade.trimmingCharacters(in: .whitespaces)
        return raw.isEmpty ? "Raw" : raw
    }()
    parts.append(gradeShort)

    let line = parts.joined(separator: " · ")
    return line.isEmpty ? nil : line
}

private func inventoryCardSubtitle(for card: InventoryCard) -> String? {
    // Mirror the detail view's cardSubtitle (PortfolioIQModels.swift:1078-1085)
    // so the list/grid row also surfaces parallel + Auto. Pre-CF the list
    // showed only year + setName, which made the CPA-EHA Blue X-Fractor
    // auto holding indistinguishable from the BCP-102 non-auto with the
    // same year and set. Each part is trimmed; empty parts are dropped.
    var parts: [String] = []
    let year = card.year.trimmingCharacters(in: .whitespacesAndNewlines)
    if !year.isEmpty { parts.append(year) }
    // Strip a leading year from setName when it duplicates `card.year`
    // — backend often ships setName as "2006 Bowman Draft Picks &
    // Prospects", which combined with the year prefix would render as
    // "2006 · 2006 Bowman Draft…".
    let rawSet = card.setName.trimmingCharacters(in: .whitespacesAndNewlines)
    let setName = PortfolioHoldingHeroCard.stripLeadingYear(from: rawSet, year: year)
    if !setName.isEmpty { parts.append(setName) }
    let parallel = card.parallel.trimmingCharacters(in: .whitespacesAndNewlines)
    if !parallel.isEmpty { parts.append(parallel) }
    if card.isAuto { parts.append("Auto") }

    if parts.isEmpty {
        let fallback = card.cardName.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty ? nil : fallback
    }
    return parts.joined(separator: " · ")
}

/// CF-IOS-INVENTORY-ROW-SECONDARY (2026-06-27): compact secondary detail
/// line under the year/set subtitle — grade label first, then parallel /
/// variant. Each segment trimmed and dropped when empty so a legacy row
/// missing one or both never renders a dangling " · ". InventoryCard
/// has no structured serial-number field — the serial is typically baked
/// into the `parallel` text (e.g. "Refractor /99"), so it surfaces
/// automatically through the parallel segment.
private func inventoryCardSecondaryDetailLine(for card: InventoryCard) -> String? {
    let segments = [card.grade, card.parallel]
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    guard segments.isEmpty == false else { return nil }
    return segments.joined(separator: " · ")
}

/// Single grade pill — sentence-case label, soft surface, neutral by default.
@ViewBuilder
private func inventoryGradePill(text: String) -> some View {
    Text(text)
        .font(.caption2.weight(.medium))
        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
        .clipShape(Capsule(style: .continuous))
}

/// P0.3 (2026-07-16): BGS 10 Black Label / Pristine chip. Rendered
/// next to the grade pill when the holding's `isBlackLabel == true`.
/// Distinct high-contrast black + gold treatment so the ~9× premium
/// tier reads at a glance without competing with the grade pill.
@ViewBuilder
private func inventoryBlackLabelChip() -> some View {
    HStack(spacing: 4) {
        Image(systemName: "star.fill")
            .font(.system(size: 9, weight: .bold))
        Text("Black Label")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(Color(hex: 0xE5B64A))
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(Color.black.opacity(0.55))
    .overlay(
        Capsule(style: .continuous)
            .stroke(Color(hex: 0xE5B64A).opacity(0.55), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

/// CF-EBAY-BROWSE-ENRICHMENT (backend PR #383): compact "via eBay" chip
/// on rows where the holding was Browse-enriched. Signals structured
/// data provenance so users don't second-guess the auto-created row.
@ViewBuilder
private func inventoryEbayChip() -> some View {
    HStack(spacing: 4) {
        Image(systemName: "checkmark.seal.fill")
            .font(.system(size: 9, weight: .bold))
        Text("via eBay")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
    .overlay(
        Capsule(style: .continuous)
            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

/// CF-EBAY-RELIST (backend PR #388): "Listed on eBay — $X" chip on
/// rows whose holding was published. Rendered next to the grade pill
/// so users can eyeball which holdings are live sale-side.
@ViewBuilder
private func inventoryListedChip(price: Double?) -> some View {
    HStack(spacing: 4) {
        Image(systemName: "tag.fill")
            .font(.system(size: 9, weight: .bold))
        Text(priceLabel(price))
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(HobbyIQTheme.Colors.successGreen.opacity(0.14))
    .overlay(
        Capsule(style: .continuous)
            .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.35), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

private func priceLabel(_ price: Double?) -> String {
    if let p = price, p > 0 { return "Listed \(p.portfolioCurrencyText)" }
    return "Listed on eBay"
}

/// CF-EBAY-BROWSE-ENRICHMENT (backend PR #383): "Needs review" nudge on
/// title-parsed rows (parseConfidence 0.70–0.94) so the user knows to
/// confirm player/set/grade before trusting the row. Suppressed when
/// `enrichedFromEbay == true` — those are already confirmed.
@ViewBuilder
private func inventoryReviewPill() -> some View {
    HStack(spacing: 4) {
        Image(systemName: "exclamationmark.circle.fill")
            .font(.system(size: 9, weight: .bold))
        Text("Needs review")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(HobbyIQTheme.Colors.warning)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(HobbyIQTheme.Colors.warning.opacity(0.14))
    .overlay(
        Capsule(style: .continuous)
            .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

/// CF-ACTION-BADGES (2026-07-06, backend §1): per-holding verdict badge
/// rendered under the grade pill in the inventory row. Uses the shared
/// `ActionBadgeStyle` so the color / icon / fill treatment matches the
/// comp-card action block and the portfolio movers badge.
@ViewBuilder
func inventoryActionBadge(rec: CardPanelGradeEntry.ActionRecommendation) -> some View {
    let style = ActionBadgeStyle(verdict: rec.verdict, urgency: rec.urgency)
    HStack(spacing: 4) {
        Image(systemName: style.icon)
            .font(.system(size: 9, weight: .bold))
        Text(style.label)
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.5)
        if rec.verdict == .list, let t = rec.targetPrice, t > 0 {
            Text("· \(t.currencyStringNoCents)")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
        }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .foregroundStyle(style.foreground)
    .background(style.background)
    .overlay(
        Capsule(style: .continuous)
            .stroke(style.tint, lineWidth: style.strokeWidth)
    )
    .clipShape(Capsule(style: .continuous))
}

/// Row right column — the canonical resolved market value for the
/// holding under a "MARKET VALUE" caption. Legacy per-field fallbacks
/// (fmv → estimated → best-known) are handled inside
/// `resolvedValue`'s producer on the ViewModel, so the row itself is
/// a single-value display and never disagrees with header/sort/detail.
@ViewBuilder
private func inventoryRightColumn(card: InventoryCard, resolvedValue: Double? = nil) -> some View {
    let value: Double = {
        if let resolvedValue, resolvedValue > 0 { return resolvedValue }
        let qty = max(1.0, card.quantity ?? 1.0)
        if let v = card.fairMarketValue, v > 0 { return v * qty }
        if card.currentValue > 0 { return card.currentValue }
        if let v = card.estimatedValue, v > 0 { return v * qty }
        if let best = card.bestKnownMarketValue { return best.perUnit * qty }
        return 0
    }()

    // 2026-07-17: dropped the "MARKET VALUE" caption per row — the
    // column position + weight make it read as the price. Bumped the
    // number to .headline.bold so it carries the visual weight the
    // label used to add.
    VStack(alignment: .trailing, spacing: 3) {
        if value > 0 {
            Text(inventoryWholeDollarString(value))
                .font(.headline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .monospacedDigit()
        } else {
            Text("—")
                .font(.headline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .monospacedDigit()
        }

        // P0.6 (2026-07-16) per nearest-graded-anchor-rendering.md:
        // when the backend rescued the estimate via the grade-ladder
        // fallback, surface a compact "based on PSA 9 · $1,325 · 8 mo
        // ago" caption tinted by the anchor's confidence band. Wire
        // field is omitted for healthy-priced holdings so the caption
        // self-suppresses on the common path.
        if let anchor = card.nearestGradedAnchor {
            Text("based on \(anchor.grade) · \(portfolioCurrencyString(anchor.price)) · \(anchor.shortAge)")
                .font(.caption2)
                .foregroundStyle(anchor.tintColor)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }
}

/// CF-MARKET-VALUE-EVERYWHERE (2026-07-12): human-readable subtitle for
/// the fallback value source shown when observed FMV / live cache /
/// estimated are all absent. Keeps the row honest about how the
/// number was derived.
private func bestKnownSourceLabel(_ source: InventoryCard.MarketValueSource) -> String {
    switch source {
    case .fmv: return "Market"
    case .current: return "Estimated"
    case .estimated: return "Estimated"
    case .midpoint: return "Range midpoint"
    case .atCost: return "At cost"
    }
}

/// Whole-dollar currency for inventory rows + header ("$5,903" — no cents).
/// Uses NumberFormatter so locale grouping survives. Internal so the
/// InventoryIQView header reads its total value through the same helper.
func inventoryWholeDollarString(_ value: Double) -> String {
    inventoryWholeDollarFormatter.string(from: NSNumber(value: value)) ?? "$0"
}

private let inventoryWholeDollarFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.maximumFractionDigits = 0
    formatter.minimumFractionDigits = 0
    return formatter
}()

/// Row thumbnail: 42pt-wide rounded tile. Shows the player's initials on
/// a slate-gray tile when there is no image OR the AsyncImage fails —
/// never the legacy "broken photo" SF Symbol.
///
/// CF-CARD-IMAGE-NO-DISTORT (2026-07-03): scaledToFit + maxWidth-only so
/// the LiveMarket CDN's 754×1028 (aspect 0.733) renders at its natural
/// aspect. The old 42×56 fixed frame forced 0.75, stretching cards.
func inventoryRowThumbnail(urlString: String?, playerName: String) -> some View {
    // CF-INVENTORY-THUMB-COMP-CARD-PARITY (2026-07-05): mirrors the
    // comp-card hero exactly —
    //   `image.resizable().scaledToFit().scaleEffect(0.85)`
    // for the 15% inner breathing margin, `.frame(width:height:)` at
    // the outer Group for row-height stability, and a single
    // `.clipShape` applied to the container so every branch (image,
    // AsyncImage placeholder, initials tile) picks up the same
    // rounded-rect crop.
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty, .failure:
                    inventoryInitialsTile(playerName: playerName, fontSize: 14)
                @unknown default:
                    inventoryInitialsTile(playerName: playerName, fontSize: 14)
                }
            }
        } else {
            inventoryInitialsTile(playerName: playerName, fontSize: 14)
        }
    }
    .frame(width: 42, height: 56)
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
}

/// Grid thumbnail: full-width × 90pt tile with the same initials fallback.
/// CF-CARD-IMAGE-NO-DISTORT (2026-07-03): scaledToFit inside the tile so
/// non-standard aspects letterbox instead of stretching. Container size
/// preserved for LazyVGrid uniformity.
private func inventoryGridThumbnail(urlString: String?, playerName: String) -> some View {
    // CF-INVENTORY-THUMB-COMP-CARD-PARITY (2026-07-05): mirrors the
    // comp-card hero — `.scaledToFit().scaleEffect(0.85)` inside the
    // 90pt-tall tile so non-standard aspects letterbox with the same
    // 15% breathing margin the hero uses. `.clipShape` at the
    // container level matches the hero's rounded-rect crop.
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty, .failure:
                    inventoryInitialsTile(playerName: playerName, fontSize: 22)
                @unknown default:
                    inventoryInitialsTile(playerName: playerName, fontSize: 22)
                }
            }
        } else {
            inventoryInitialsTile(playerName: playerName, fontSize: 22)
        }
    }
    .frame(maxWidth: .infinity)
    .frame(height: 90)
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
}

/// CF-PLACEHOLDER-CARD (2026-07-04): generic card-shape placeholder for
/// inventory rows without an uploaded photo. Renders a subtle rounded
/// rectangle with a photo glyph, matching how the CDN-thumbnail placeholder
/// looks — no more colored initials tiles.
private func inventoryInitialsTile(playerName: String, fontSize: CGFloat) -> some View {
    // 2026-07-17: monogram fallback — never render a blank / photo-glyph
    // placeholder. Player initials on an electric-blue-tinted card shape
    // read as "we know who this is, we just don't have art yet" instead
    // of "this looks broken".
    let initials = inventoryInitials(from: playerName)
    return ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        HobbyIQTheme.Colors.electricBlue.opacity(0.28),
                        HobbyIQTheme.Colors.electricBlue.opacity(0.12)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.45), lineWidth: 1)
        Text(initials)
            .font(.system(size: fontSize, weight: .bold, design: .rounded))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

/// Up to two initials from the first two whitespace-separated words.
/// Empty input falls back to "?" so the tile is never blank.
private func inventoryInitials(from name: String) -> String {
    let words = name
        .split(whereSeparator: { $0.isWhitespace })
        .prefix(2)
    let letters = words.compactMap { $0.first }
    if letters.isEmpty { return "?" }
    return letters.map { String($0).uppercased() }.joined()
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
