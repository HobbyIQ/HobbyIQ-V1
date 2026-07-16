//
//  ERPModels.swift
//  HobbyIQ
//

import Foundation

// MARK: - Ledger Entry (ERP-enriched)

struct LedgerEntryForErp: Codable, Identifiable, Hashable {
    let id: String
    let userId: String?
    let holdingId: String?
    let playerName: String?
    let cardName: String?
    /// CF-PR-E-IOS-PHASE-1B (2026-06-16): backend's `PortfolioLedgerEntry`
    /// emits `cardTitle` on the wire (never `cardName`) —
    /// portfolioStore.service.ts:335. Decoding into `cardName` always
    /// resolves to nil. Prefer `cardTitle` for display; legacy `cardName`
    /// stays for tolerance.
    let cardTitle: String?
    let year: String?
    let setName: String?
    let parallel: String?
    let grade: String?

    let salePrice: Double?
    let grossProceeds: Double?
    let netProceeds: Double?
    let netPayout: Double?
    let costBasisSold: Double?
    let realizedProfitLoss: Double?
    let realizedProfitLossPct: Double?

    let finalValueFee: Double?
    let paymentProcessingFee: Double?
    let promotedListingFee: Double?
    let adFee: Double?
    let otherFees: Double?
    let actualShippingCost: Double?
    let totalGranularFees: Double?

    let source: String?
    let ebayOrderId: String?
    let ebayItemId: String?
    let soldAt: String?
    let createdAt: String?
    let updatedAt: String?
    let reconciledAt: String?
    let needsReconciliation: Bool?
    let dismissedAt: String?
    let dismissedReason: String?

    let fees: Double?
    let tax: Double?
    let shipping: Double?
    let gradingCost: Double?
    let suppliesCost: Double?

    let feeAdjustments: [FeeAdjustment]?
    let tradeId: String?
    let tradeRole: String?

    // MARK: - CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16)
    //
    // Axis-2 server markers + display fields. Populated by GET
    // /unreconciled (via enrichEntryForClient) AND by the save-costs +
    // override mutation responses. Nil on PATCH /ledger and on legacy
    // entries that predate the two-axis layer — decoders tolerate
    // absence so a single LedgerEntryForErp type covers all three
    // response shapes.
    let userCostsProvidedAt: String?
    let userCostsProvidedBy: String?
    /// `ReconciledVia` raw: "ebay_finances" | "manual_override" | "manual_entry"
    let feeSource: String?
    let missingFields: [String]?
    /// `CostsStatus` raw: "needs_action" | "saved_pending_fees"
    let costsStatus: String?

    var isEbaySource: Bool { source?.lowercased() == "ebay" }

    /// Strongly-typed view over the server-derived display bucket. Nil
    /// when the response shape didn't include it (PATCH /ledger,
    /// pre-CF-PR-E entries).
    var costsStatusEnum: CostsStatus? {
        guard let raw = costsStatus else { return nil }
        return CostsStatus(rawValue: raw)
    }

    /// True iff the server still lists granular fee fields as missing.
    /// Drives the "provisional — fees pending" label on the realized-gain
    /// section in the reconcile detail view.
    var hasPendingFees: Bool {
        (missingFields ?? []).isEmpty == false
    }

    /// Prefer `cardTitle` (the real wire field); fall back to `cardName`
    /// (decoder-tolerance) when present. Nil when neither has content.
    var displayCardTitle: String? {
        if let t = cardTitle?.trimmingCharacters(in: .whitespaces), !t.isEmpty { return t }
        if let n = cardName?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
        return nil
    }
}

/// CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16): server-derived display
/// bucket for an unreconciled eBay entry. Finalized entries leave the
/// /unreconciled list entirely — they never carry a costsStatus the UI
/// renders. Keyed off `costsStatus` raw from `enrichEntryForClient`.
enum CostsStatus: String {
    case needsAction = "needs_action"
    case savedPendingFees = "saved_pending_fees"
}

// MARK: - Fee Adjustment audit row (CF-PR-E-FEE-ADJUSTMENT-RESHAPE, 2026-06-17)
//
// Reshape to match backend's `LedgerFeeAdjustment` wire (portfolioStore.
// service.ts:481-521). Pre-CF iOS expected a flat `{ field, oldValue,
// newValue, reason, adjustedAt }` that never matched the wire — backend
// always emitted nested `priorValues` / `newValues` blocks per adjustment,
// so the audit trail in ERPOverrideSheet rendered "unknown" rows with
// no values. Server is the source of truth; this matches it exactly.

struct FeeAdjustment: Codable, Hashable, Identifiable {
    var id: String { adjustmentId }
    let adjustmentId: String
    let adjustedAt: String
    let adjustedBy: String
    let reason: String
    let priorValues: FeeAdjustmentValues
    let newValues: FeeAdjustmentValues
}

/// One snapshot of the fee + cost block — used for both priorValues
/// (pre-mutation state) and newValues (post-mutation state). All
/// fields optional: backend emits `number | null` for each fee field,
/// and the cost-side fields (gradingCost/suppliesCost/userCostsProvidedAt)
/// only appear on save-costs adjustments. needsReconciliation +
/// reconciledVia are decoded for completeness but unread by the audit
/// renderer today.
struct FeeAdjustmentValues: Codable, Hashable {
    let finalValueFee: Double?
    let paymentProcessingFee: Double?
    let promotedListingFee: Double?
    let adFee: Double?
    let otherFees: Double?
    let netPayout: Double?
    let actualShippingCost: Double?
    let gradingCost: Double?
    let suppliesCost: Double?
    let userCostsProvidedAt: String?
    let needsReconciliation: Bool?
    let reconciledVia: String?
}

extension FeeAdjustment {
    /// One row's worth of "this field moved" data. `prior == nil` AND
    /// `new` non-nil means a value was filled where there was nothing
    /// before (e.g. eBay Finances enrichment landing); a non-nil `prior`
    /// with `new == nil` means a value was cleared back to "unknown."
    struct ChangedField: Identifiable, Hashable {
        var id: String { label }
        let label: String
        let prior: Double?
        let new: Double?
    }

    /// The audit row enumerates only the fields that actually moved
    /// between priorValues and newValues. Order matches the audit
    /// renderer's preferred reading order: granular fees first, then
    /// net payout, then shipping, then cost-axis fields.
    var changedFields: [ChangedField] {
        let pairs: [(String, Double?, Double?)] = [
            ("Final Value Fee",     priorValues.finalValueFee,        newValues.finalValueFee),
            ("Payment Processing",  priorValues.paymentProcessingFee, newValues.paymentProcessingFee),
            ("Promoted Listing",    priorValues.promotedListingFee,   newValues.promotedListingFee),
            ("Ad Fee",              priorValues.adFee,                newValues.adFee),
            ("Other Fees",          priorValues.otherFees,            newValues.otherFees),
            ("Net Payout",          priorValues.netPayout,            newValues.netPayout),
            ("Actual Shipping",     priorValues.actualShippingCost,   newValues.actualShippingCost),
            ("Grading Cost",        priorValues.gradingCost,          newValues.gradingCost),
            ("Supplies Cost",       priorValues.suppliesCost,         newValues.suppliesCost),
        ]
        return pairs.compactMap { (label, prior, new) in
            FeeAdjustment.didChange(prior: prior, new: new)
                ? ChangedField(label: label, prior: prior, new: new)
                : nil
        }
    }

    /// nil ↔ value transitions count as a change (the audit row
    /// surfaces "—  →  $12.34" when eBay Finances first populates a
    /// previously-null fee field). nil ↔ nil = no change. Otherwise
    /// strict numeric inequality.
    fileprivate static func didChange(prior: Double?, new: Double?) -> Bool {
        switch (prior, new) {
        case (nil, nil):                       return false
        case (nil, _), (_, nil):               return true
        case let (.some(p), .some(n)):         return p != n
        }
    }
}

// MARK: - Unreconciled List

/// CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16): backend wire is
/// `{ success, entries, counts: { unreconciledTotal, dismissedHidden } }`.
/// Legacy `count` top-level field stays here as decoder-tolerant — it's
/// always nil on the current wire and never set by any caller; consumers
/// prefer `counts?.unreconciledTotal` and fall back to `entries.count`.
struct UnreconciledListResponse: Codable {
    let success: Bool?
    let entries: [LedgerEntryForErp]
    let count: Int?
    let counts: UnreconciledCounts?
}

struct UnreconciledCounts: Codable, Hashable {
    let unreconciledTotal: Int
    let dismissedHidden: Int
}

// MARK: - Aging Buckets

struct AgingBucketsResponse: Codable {
    let buckets: [AgingBucket]
}

/// CF-PR-E-IOS-PHASE-1B (2026-06-16): wire shape per erpAgingOverride.service.ts
/// L25-32 is `{ bucket: "0-7d" | "8-30d" | "31-60d" | ">60d", count, entryIds,
/// cutoffWarning? }`. Pre-Phase-1b iOS expected `label` (non-optional) and a
/// `totalGross` field that never existed — first-row decode failure surfaced
/// as a red banner on the new inbox. `entryIds` is decoded but unread today.
struct AgingBucket: Codable, Identifiable, Hashable {
    var id: String { bucket }
    let bucket: String
    let count: Int
    let entryIds: [String]?
    let cutoffWarning: Bool?

    /// Human-readable bucket label rendered in the aging section.
    var displayLabel: String {
        switch bucket {
        case "0-7d":   return "0–7 days"
        case "8-30d":  return "8–30 days"
        case "31-60d": return "31–60 days"
        case ">60d":   return ">60 days"
        default:       return bucket
        }
    }
}

// MARK: - Manual Override

struct ERPOverrideRequest: Codable {
    let reason: String
    let fees: ERPOverrideFees
}

struct ERPOverrideFees: Codable {
    var netPayout: Double?
    var finalValueFee: Double?
    var paymentProcessingFee: Double?
    var promotedListingFee: Double?
    var adFee: Double?
    var otherFees: Double?
    var actualShippingCost: Double?
}

struct ERPOverrideResponse: Codable {
    let success: Bool?
    let entry: LedgerEntryForErp?
    let adjustment: FeeAdjustment?
    let message: String?
    let error: String?
    let code: String?
}

// MARK: - Save Costs (CF-PR-E-TWO-AXIS-RECONCILIATION, 2026-06-16)

/// POST body for `/api/portfolio/erp/unreconciled/:id/save-costs`. Either
/// or both fields required; non-negative or null; 0 allowed (raw card).
struct ERPSaveCostsRequest: Codable {
    var gradingCost: Double?
    var suppliesCost: Double?
}

/// Response shape mirrors `/override` — server-enriched entry carries
/// `costsStatus` + `missingFields` so the client never re-derives display
/// state. 409 (`ALREADY_FINALIZED`) flows through `APIServiceError.httpError`
/// and is rendered as a calm info banner, not red.
struct ERPSaveCostsResponse: Codable {
    let success: Bool?
    let entry: LedgerEntryForErp?
    let adjustment: FeeAdjustment?
    let error: String?
    let code: String?
}

// MARK: - Ledger Patch (PATCH /api/portfolio/ledger/:id)

/// CF-PR-E-TWO-AXIS-RECONCILIATION: the dismiss ("Quiet for now") path
/// rides the existing ledger-patch route. Backend whitelist accepts
/// `dismissedAt`, `dismissedReason`, `gradingCost`, `suppliesCost`, plus
/// the sales-tracking descriptive fields. Response is the legacy shape
/// `{ message, entry }` — no `success` flag, entry is NOT server-enriched
/// (no `costsStatus` / `missingFields`).
struct LedgerDismissRequest: Codable {
    let dismissedAt: String
    let dismissedReason: String?
}

struct LedgerEntryUpdateResponse: Codable {
    let message: String?
    let entry: LedgerEntryForErp?
}

// MARK: - Refetch

struct ERPRefetchResponse: Codable {
    let updated: Int?
    let message: String?
}

// MARK: - P&L

// CF-ERP-PNL-DECODE-2026-07-11: backend wire keys are `feesTotal`,
// `costBasisSold`, `realizedProfitLoss`, `entryCount`, and each group is
// `{key, label, totals: {…}}` with the same nested shape. The prior iOS
// structs used flat `totalFees` / `costBasis` / `realizedPnL` / `count`
// keys and expected group totals flat on the group — every optional
// silently decoded to nil, so the Financials hero rendered "—" and the
// P&L tile said "No sales yet" even after a successful manual sale.
struct ERPPnlResponse: Decodable {
    let groupBy: String?
    let totals: ERPPnlTotals?
    let groups: [ERPPnlGroup]?
    let includeExpenses: Bool?
    // Scope 3 (2026-07-12): backend PR #380 added purchase-side + margin
    // metrics to the same envelope. `cogs` is nil until the user has any
    // purchases; `operatingExpenses` / `trueNet` were already on the wire
    // but silently dropped by the previous iOS decoder.
    let cogs: PnLCogs?
    let operatingExpenses: Double?
    let trueNet: Double?
}

struct ERPPnlTotals: Decodable, Hashable {
    let grossProceeds: Double?
    let totalFees: Double?
    let netProceeds: Double?
    let costBasis: Double?
    let realizedPnL: Double?
    let totalExpenses: Double?
    let netPnL: Double?
    let count: Int?

    private enum CodingKeys: String, CodingKey {
        case grossProceeds
        case totalFees = "feesTotal"
        case netProceeds
        case costBasis = "costBasisSold"
        case realizedPnL = "realizedProfitLoss"
        case totalExpenses
        case netPnL
        case count = "entryCount"
    }
}

struct ERPPnlGroup: Decodable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let label: String?
    let grossProceeds: Double?
    let totalFees: Double?
    let netProceeds: Double?
    let costBasis: Double?
    let realizedPnL: Double?
    let totalExpenses: Double?
    let netPnL: Double?
    let count: Int?

    private enum CodingKeys: String, CodingKey {
        case key, label, totals
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        let t = try container.decodeIfPresent(ERPPnlTotals.self, forKey: .totals)
        grossProceeds = t?.grossProceeds
        totalFees = t?.totalFees
        netProceeds = t?.netProceeds
        costBasis = t?.costBasis
        realizedPnL = t?.realizedPnL
        totalExpenses = t?.totalExpenses
        netPnL = t?.netPnL
        count = t?.count
    }
}

// MARK: - Analytics

struct ERPAnalyticsResponse: Codable {
    let groupBy: String?
    let groups: [ERPAnalyticsGroup]?
}

struct ERPAnalyticsGroup: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let margin: Double?
    let roi: Double?
    let sellThrough: Double?
    let avgDaysToSell: Double?
    let count: Int?
    let totalRevenue: Double?
    let totalCost: Double?
}

// MARK: - Timeseries

// CF-ERP-PNL-DECODE-2026-07-11: wire uses `bucket` (not `granularity`),
// and each point uses `bucket` / `totalGross` / `totalCost` / `totalRealized`
// / `entryCount`. Prior struct had a non-optional `period: String` on the
// wrong key, so the first point decode threw `keyNotFound(.period)` — which
// took down the whole `try await (p, t, u)` tuple in `loadAll`, silently
// discarding the (working) P&L data alongside it.
struct ERPTimeseriesResponse: Decodable {
    let granularity: String?
    let points: [ERPTimeseriesPoint]?

    private enum CodingKeys: String, CodingKey {
        case granularity = "bucket"
        case points
    }
}

struct ERPTimeseriesPoint: Decodable, Identifiable, Hashable {
    var id: String { period }
    let period: String
    let revenue: Double?
    let cost: Double?
    let pnl: Double?
    let count: Int?

    private enum CodingKeys: String, CodingKey {
        case period = "bucket"
        case revenue = "totalGross"
        case cost = "totalCost"
        case pnl = "totalRealized"
        case count = "entryCount"
    }
}

// MARK: - Valuation

struct ERPValuationResponse: Codable {
    let holdings: [ERPValuationHolding]?
    let totalCost: Double?
    let totalCurrentValue: Double?
    let totalUnrealizedPnL: Double?
}

struct ERPValuationHolding: Codable, Identifiable, Hashable {
    var id: String { holdingId }
    let holdingId: String
    let playerName: String?
    let cardName: String?
    let cost: Double?
    let currentValue: Double?
    let unrealizedPnL: Double?
    let freshness: String?
    let fullPosition: Bool?
}

// MARK: - Expenses

enum ERPExpenseCategory: String, Codable, CaseIterable, Identifiable {
    case storeSubscription = "store_subscription"
    case showBooth = "show_booth"
    case showAdmission = "show_admission"
    case mileage
    case supplies
    case shippingSupplies = "shipping_supplies"
    case gradingFees = "grading_fees"
    case software
    case hobbyiqSubscription = "hobbyiq_subscription"
    case travel
    case meals
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .storeSubscription: return "Store Subscription"
        case .showBooth: return "Show Booth"
        case .showAdmission: return "Show Admission"
        case .mileage: return "Mileage"
        case .supplies: return "Supplies"
        case .shippingSupplies: return "Shipping Supplies"
        case .gradingFees: return "Grading Fees"
        case .software: return "Software"
        case .hobbyiqSubscription: return "HobbyIQ Subscription"
        case .travel: return "Travel"
        case .meals: return "Meals"
        case .other: return "Other"
        }
    }

    var requiresNote: Bool { self == .other }
}

struct ERPExpenseEntry: Codable, Identifiable, Hashable {
    let id: String
    let category: String?
    let amount: Double?
    let description: String?
    let categoryNote: String?
    let date: String?
    let createdAt: String?
    let updatedAt: String?

    var categoryEnum: ERPExpenseCategory? {
        guard let category else { return nil }
        return ERPExpenseCategory(rawValue: category)
    }
}

struct ERPExpenseListResponse: Codable {
    let expenses: [ERPExpenseEntry]?
    let count: Int?
}

struct ERPExpenseCreateRequest: Codable {
    let category: String
    let amount: Double
    let description: String?
    let categoryNote: String?
    let date: String?
}

struct ERPExpenseUpdateRequest: Codable {
    let category: String?
    let amount: Double?
    let description: String?
    let categoryNote: String?
    let date: String?
}

struct ERPExpenseResponse: Codable {
    let expense: ERPExpenseEntry?
    let message: String?
}

struct ERPExpenseDeleteResponse: Codable {
    let message: String?
}

struct ERPExpenseReportResponse: Codable {
    let groupBy: String?
    let groups: [ERPExpenseReportGroup]?
    let total: Double?
}

struct ERPExpenseReportGroup: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let total: Double?
    let count: Int?
}

// MARK: - Trades

/// CF-ERP-TRADE-WIRE (2026-07-11): wire keys must match the backend
/// handler (`portfolioiq.erp.routes.ts:717 POST /trades`):
///   - `tradeDate` (backend reads `body.tradeDate`, not `date`)
///   - `note` (backend reads `body.note`, not `notes`)
///   - `salesChannel` / `saleLocation` / `cashPaymentMethod` / `counterparty`
///     go through the shared `parseSalesTrackingFields` validator.
/// The previous names (`notes`, `date`) silently dropped both fields
/// server-side on every submitted trade.
struct ERPTradeRecordRequest: Codable {
    let outgoing: [ERPTradeOutgoingItem]
    let incoming: [ERPTradeIncomingItem]
    let cashToMe: Double
    let note: String?
    let tradeDate: String?
    let salesChannel: String?
    let saleLocation: String?
    let cashPaymentMethod: String?
    let counterparty: String?

    init(
        outgoing: [ERPTradeOutgoingItem],
        incoming: [ERPTradeIncomingItem] = [],
        cashToMe: Double,
        note: String? = nil,
        tradeDate: String? = nil,
        salesChannel: String? = nil,
        saleLocation: String? = nil,
        cashPaymentMethod: String? = nil,
        counterparty: String? = nil
    ) {
        self.outgoing = outgoing
        self.incoming = incoming
        self.cashToMe = cashToMe
        self.note = note
        self.tradeDate = tradeDate
        self.salesChannel = salesChannel
        self.saleLocation = saleLocation
        self.cashPaymentMethod = cashPaymentMethod
        self.counterparty = counterparty
    }
}

struct ERPTradeOutgoingItem: Codable, Hashable {
    let holdingId: String
    let fmvAtTrade: Double
    let fmvSource: String
}

/// CF-ERP-TRADE-WIRE (2026-07-11): backend expects `cardYear: number` (Int),
/// not `year: String`. Old shape decoded server-side as undefined.
struct ERPTradeIncomingItem: Codable, Hashable {
    let cardTitle: String
    let fmvAtTrade: Double
    let fmvSource: String
    let playerName: String?
    let cardYear: Int?
    let setName: String?
    let parallel: String?
    let grade: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let cardId: String?
}

struct ERPTradeTransaction: Codable, Identifiable, Hashable {
    let id: String
    let date: String?
    let cashToMe: Double?
    let notes: String?
    let createdAt: String?
    let outgoing: [ERPTradeOutgoingRecord]?
    let incoming: [ERPTradeIncomingRecord]?
    let totals: ERPTradeTotals?
}

struct ERPTradeOutgoingRecord: Codable, Identifiable, Hashable {
    var id: String { holdingId ?? UUID().uuidString }
    let holdingId: String?
    let playerName: String?
    let cardName: String?
    let fmvAtTrade: Double?
    let fmvSource: String?
    let costBasis: Double?
    let proceedsAllocated: Double?
    let realizedGL: Double?
}

struct ERPTradeIncomingRecord: Codable, Identifiable, Hashable {
    var id: String { holdingId ?? UUID().uuidString }
    let holdingId: String?
    let cardTitle: String?
    let fmvAtTrade: Double?
    let fmvSource: String?
    let newCostBasis: Double?
}

struct ERPTradeTotals: Codable, Hashable {
    let totalFmvOut: Double?
    let totalFmvIn: Double?
    let cashToMe: Double?
    let realizedGainLoss: Double?
    let balanceCheck: Double?
}

struct ERPTradeRecordResponse: Codable {
    let trade: ERPTradeTransaction?
    let message: String?
}

struct ERPTradeListResponse: Codable {
    let trades: [ERPTradeTransaction]?
    let count: Int?
}

// MARK: - Tax Filings

struct ERPTaxFilingsResponse: Codable {
    let year: Int?
    let rails: [ERPTaxFilingRail]?
}

struct ERPTaxFilingRail: Codable, Identifiable, Hashable {
    var id: String { rail }
    let rail: String
    let reportedGross1099K: Double?
    let computedGross: Double?
    let delta: Double?
    let transactionCount: Int?
}

struct ERPTaxFilingUpdateRequest: Codable {
    let reportedGross1099K: Double
}

struct ERPTaxFilingUpdateResponse: Codable {
    let rail: ERPTaxFilingRail?
    let message: String?
}

// MARK: - Accounting Export

struct ERPAccountingExportRow: Codable, Identifiable, Hashable {
    var id: String { "\(date ?? "")_\(description ?? "")_\(amount ?? 0)" }
    let date: String?
    let description: String?
    let amount: Double?
    let category: String?
    let type: String?
    let reference: String?
}

struct ERPAccountingExportResponse: Codable {
    let rows: [ERPAccountingExportRow]?
    let format: String?
}

// MARK: - Tax Export

struct ERPTaxExportRow: Codable, Identifiable, Hashable {
    var id: String { "\(saleDate ?? "")_\(description ?? "")_\(proceeds ?? 0)" }
    let saleDate: String?
    let description: String?
    let proceeds: Double?
    let costBasis: Double?
    let gainLoss: Double?
    let holdingPeriod: String?
    let rail: String?
}

struct ERPTaxExportResponse: Codable {
    let rows: [ERPTaxExportRow]?
    let year: Int?
    let format: String?
}

// MARK: - Universal mutation envelope (backend PR #395)
//
// Every inventory mutation route now returns the fully-persisted
// holding inline — iOS can drop the "PATCH then GET" refetch pattern.
// The envelope carries both the top-level `holding` field and an
// `entry.holding` field; the resolved value is `entry.holding ??
// holding`. `HoldingMutationEntry` also flows through the existing
// `LedgerEntryUpdateResponse` shape so backend can double-key it.
struct HoldingMutationEntry: Codable {
    let holding: InventoryCard?
}

// MARK: - Scope 3: Purchases / Held Expenses / COGS / Inventory Analytics
//
// Wire shapes shipped by backend PRs #377-#381 (2026-07-12). All money
// fields are Double; all endpoints hang off `/api/portfolio/erp/*` and
// `/api/portfolio/holdings/:id/expenses`.

// MARK: Purchases

struct PortfolioPurchaseEntry: Codable, Identifiable, Hashable {
    let id: String
    let userId: String?
    let purchaseDate: String        // ISO
    let source: String              // "manual" | "ebay"
    let subtotal: Double
    let tax: Double
    let shipping: Double
    let otherFees: Double
    let totalCost: Double
    let holdingIds: [String]
    let vendor: String?
    let invoiceRef: String?
    let notes: String?
    let ebayOrderId: String?
    let ebayTransactionId: String?
    let createdAt: String?
    let updatedAt: String?
}

struct PortfolioPurchaseListTotals: Codable, Hashable {
    let totalCost: Double?
    let count: Int?
    let subtotal: Double?
    let tax: Double?
    let shipping: Double?
    let otherFees: Double?
}

struct PortfolioPurchaseListResponse: Codable {
    let success: Bool?
    let source: String?
    let purchases: [PortfolioPurchaseEntry]?
    let totals: PortfolioPurchaseListTotals?
}

struct PortfolioPurchaseCreateRequest: Codable {
    let purchaseDate: String
    let source: String          // "manual"
    let subtotal: Double
    let tax: Double?
    let shipping: Double?
    let otherFees: Double?
    let holdingIds: [String]?
    let vendor: String?
    let invoiceRef: String?
    let notes: String?
}

struct PortfolioPurchaseCreateResponse: Codable {
    let success: Bool?
    let purchase: PortfolioPurchaseEntry?
    let replay: Bool?
}

struct PortfolioPurchaseLinkHoldingsRequest: Codable {
    let holdingIds: [String]
}

struct PortfolioPurchaseLinkHoldingsResponse: Codable {
    let success: Bool?
    let purchase: PortfolioPurchaseEntry?
}

// MARK: eBay import summary

struct EbayImportSummary: Codable {
    let success: Bool?
    let daysWindow: Int?
    let fetched: Int?
    let imported: Int?
    let replayHits: Int?
    let skipped: Int?
    let errors: Int?
    let totalCost: Double?
    let ebayTotalReported: Int?
    let entries: [PortfolioPurchaseEntry]?
    let error: String?          // populated on 400 (e.g. days > 90)
}

// MARK: Held expenses (per-holding)

struct HoldingHeldExpense: Codable, Identifiable, Hashable {
    let id: String
    let kind: String            // "grading" | "supplies" | "shipping_to_grader" | "insurance" | "storage" | "other"
    let amount: Double
    let incurredAt: String?
    let createdAt: String?
    let notes: String?
    let invoiceRef: String?
}

/// Structured kinds that iOS surfaces in the "add expense" picker.
/// Backend accepts any of these strings for `kind`; the picker maps
/// display labels to wire values and back.
enum HoldingHeldExpenseKind: String, CaseIterable, Identifiable, Codable {
    case grading
    case supplies
    case shippingToGrader = "shipping_to_grader"
    case insurance
    case storage
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .grading: return "Grading"
        case .supplies: return "Supplies"
        case .shippingToGrader: return "Shipping to grader"
        case .insurance: return "Insurance"
        case .storage: return "Storage"
        case .other: return "Other"
        }
    }

    var iconName: String {
        switch self {
        case .grading: return "checkmark.seal.fill"
        case .supplies: return "shippingbox.fill"
        case .shippingToGrader: return "shippingbox.and.arrow.backward.fill"
        case .insurance: return "shield.lefthalf.filled"
        case .storage: return "archivebox.fill"
        case .other: return "square.grid.2x2.fill"
        }
    }
}

struct HoldingHeldExpenseCreateRequest: Codable {
    let kind: String
    let amount: Double
    let incurredAt: String?
    let notes: String?
    let invoiceRef: String?
}

struct HoldingHeldExpenseCreateResponse: Codable {
    let success: Bool?
    let expense: HoldingHeldExpense?
    /// CF-UNIVERSAL-MUTATION-ENVELOPE (backend PR #395): full persisted
    /// holding — carries `heldExpenses[]` and the rolled-in cost basis.
    /// Prefer this over the light-weight `id + totalCostBasis` shape
    /// backend also emits under the same key (decoder tries both).
    let holding: InventoryCard?
    let entry: HoldingMutationEntry?
    let newTotalCostBasis: Double?

    /// Resolves the freshest holding representation from the response —
    /// prefers `entry.holding`, then top-level `holding`.
    var updatedHolding: InventoryCard? {
        entry?.holding ?? holding
    }
}

struct HoldingHeldExpenseListResponse: Codable {
    let success: Bool?
    let expenses: [HoldingHeldExpense]?
    let total: Double?
}

struct HoldingHeldExpenseDeleteResponse: Codable {
    let success: Bool?
    let newTotalCostBasis: Double?
    /// CF-UNIVERSAL-MUTATION-ENVELOPE (backend PR #395).
    let holding: InventoryCard?
    let entry: HoldingMutationEntry?
    var updatedHolding: InventoryCard? { entry?.holding ?? holding }
}

// MARK: COGS (attached to /erp/pnl responses)

struct PnLCogs: Codable, Hashable {
    let purchaseSpend: Double?
    let purchaseCount: Int?
    let purchaseSubtotal: Double?
    let purchaseTax: Double?
    let purchaseShipping: Double?
    let purchaseOtherFees: Double?
    let inventoryOnHandCost: Double?
    let inventoryOnHandCount: Int?
    let cashFlow: Double?
    let grossMarginPct: Double?
}

// MARK: Inventory analytics

struct InventoryAnalyticsResponse: Codable {
    let asOf: String?
    let totals: InventoryAnalyticsTotals?
    let aging: InventoryAnalyticsAging?
    let oldestHoldings: [InventoryAnalyticsOldestHolding]?
    let turnover: InventoryAnalyticsTurnover?
}

struct InventoryAnalyticsTotals: Codable, Hashable {
    let holdingCount: Int?
    let totalCostBasis: Double?
}

struct InventoryAnalyticsAging: Codable {
    let buckets: [InventoryAnalyticsAgingBucket]?
    let avgDaysOnHand: Int?
    let medianDaysOnHand: Int?
}

struct InventoryAnalyticsAgingBucket: Codable, Identifiable, Hashable {
    var id: String { label }
    let label: String
    let minDays: Int
    let maxDays: Double?    // wire can send Infinity for the tail bucket; keep Double so unbounded decodes safely
    let count: Int
    let costBasis: Double
}

struct InventoryAnalyticsOldestHolding: Codable, Identifiable, Hashable {
    var id: String { holdingId }
    let holdingId: String
    let playerName: String?
    let cardTitle: String?
    let daysInInventory: Int
    let costBasis: Double
    let addedAt: String?
}

struct InventoryAnalyticsTurnover: Codable, Hashable {
    let windowFrom: String?
    let windowTo: String?
    let costBasisSold: Double?
    let currentInventoryCost: Double?
    let turnoverProxy: Double?
}

// MARK: - Scope 3.5: eBay auto-import Review Queue (backend PRs #383-#388)
//
// Confirm request MUST omit fields the user didn't touch. Each property
// is Optional; the caller populates only what it changed. Backend uses
// this as the diff signal to update `correctionCount`.

struct HoldingConfirmRequest: Codable {
    var playerName: String?
    var cardYear: Int?
    var setName: String?
    var parallel: String?
    var cardNumber: String?
    var gradeCompany: String?
    var gradeValue: Double?
    var isAuto: Bool?
    var team: String?
    var sport: String?
    var cardId: String?

    /// Convenience factory — returns nil for every unedited field so the
    /// wire body only carries the diff. Call sites build one of these
    /// per confirmation.
    static let empty = HoldingConfirmRequest()
}

struct HoldingConfirmResponse: Codable {
    let status: String?           // "confirmed"
    let holding: InventoryCard?
    let correctionCount: Int?
}

struct HoldingRejectResponse: Codable {
    let status: String?           // "rejected"
    let unlinkedPurchaseId: String?
}

// MARK: - CF-CARDID-SUGGEST (backend PR #389)

/// CF-PROGRESSIVE-BUCKETS (backend PR #393): body accepts an optional
/// `force` flag to recompute suggestions even for rows that already
/// have one. Used by pull-to-refresh on the review queue.
struct HoldingSuggestionGenerateRequest: Codable {
    let force: Bool
}

/// Response envelope for `POST /erp/holdings/generate-suggestions`.
/// Fields are advisory — iOS just re-fetches the queue after the call
/// completes and reads the freshly-populated `suggestedCardId` on each
/// row. `noCandidates` (PR #393) tracks rows the classifier couldn't
/// score.
struct HoldingSuggestionGenerateResponse: Codable {
    let success: Bool?
    let processed: Int?
    let suggested: Int?
    let noCandidates: Int?
    let skipped: Int?
    let errors: Int?
}

// MARK: - CF-RECONCILE-FINALIZE (backend PR #390)

/// Body for `POST /erp/unreconciled/:id/finalize`. `reason` is a
/// free-text audit label; `netPayout` is optional (server falls back
/// to `grossProceeds` when omitted).
struct ERPFinalizeRequest: Codable {
    let reason: String
    let netPayout: Double?
}

struct ERPFinalizeAdjustment: Codable, Hashable {
    let reason: String?
    let delta: Double?
    let adjustmentId: String?
    let adjustedAt: String?
}

/// Response mirrors `/save-costs` / `/override` — server-enriched
/// `entry` carries the fresh `costsStatus` / `feesStatus` /
/// `reconciledVia` / `missingFields`. iOS re-applies via the shared
/// `applyUpdatedEntry` path.
struct ERPFinalizeResponse: Codable {
    let success: Bool?
    let entry: LedgerEntryForErp?
    let adjustment: ERPFinalizeAdjustment?
    /// 409 (`ALREADY_FINALIZED`) and 400 (`NOT_EBAY_ENTRY`) flow through
    /// `APIServiceError.httpError` on the transport layer, but the
    /// backend also mirrors the code into the body for defensive
    /// parsing.
    let error: String?
    let code: String?
}

// MARK: - Scope 3.5: Sold-Comps for card detail (backend PR #386)

struct SoldCompsResponse: Codable {
    let count: Int?
    let comps: [SoldComp]?
    let stats: SoldCompsStats?
}

struct SoldCompsStats: Codable, Hashable {
    let minPrice: Double?
    let maxPrice: Double?
    let medianPrice: Double?
    let meanPrice: Double?
}

struct SoldComp: Codable, Identifiable, Hashable {
    /// Backend does not guarantee a stable `id` on comp rows. Derive one
    /// from the sold-at timestamp + price when the row is missing an
    /// explicit id so `ForEach` diffing behaves.
    var id: String {
        if let explicit = explicitId, explicit.isEmpty == false { return explicit }
        return "\(soldAt ?? "?")|\(unitSalePrice ?? 0)|\(matchScore ?? 0)"
    }
    private let explicitId: String?
    let unitSalePrice: Double?
    let soldAt: String?
    let aspects: [String: String]?
    let matchScore: Double?
    let daysSinceSold: Int?
    let ebayImageUrl: String?

    private enum CodingKeys: String, CodingKey {
        case explicitId = "id"
        case unitSalePrice
        case soldAt
        case aspects
        case matchScore
        case daysSinceSold
        case ebayImageUrl
    }
}
