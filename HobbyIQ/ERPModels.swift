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

    var isEbaySource: Bool { source?.lowercased() == "ebay" }
}

struct FeeAdjustment: Codable, Hashable, Identifiable {
    var id: String { "\(adjustedAt ?? "")_\(field ?? "")" }
    let field: String?
    let oldValue: Double?
    let newValue: Double?
    let reason: String?
    let adjustedAt: String?
}

// MARK: - Unreconciled List

struct UnreconciledListResponse: Codable {
    let entries: [LedgerEntryForErp]
    let count: Int?
}

// MARK: - Aging Buckets

struct AgingBucketsResponse: Codable {
    let buckets: [AgingBucket]
}

struct AgingBucket: Codable, Identifiable, Hashable {
    var id: String { label }
    let label: String
    let count: Int
    let totalGross: Double?
    let cutoffWarning: Bool?
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
    let entry: LedgerEntryForErp?
    let message: String?
}

// MARK: - Refetch

struct ERPRefetchResponse: Codable {
    let updated: Int?
    let message: String?
}

// MARK: - P&L

struct ERPPnlResponse: Codable {
    let groupBy: String?
    let totals: ERPPnlTotals?
    let groups: [ERPPnlGroup]?
    let includeExpenses: Bool?
}

struct ERPPnlTotals: Codable, Hashable {
    let grossProceeds: Double?
    let totalFees: Double?
    let netProceeds: Double?
    let costBasis: Double?
    let realizedPnL: Double?
    let totalExpenses: Double?
    let netPnL: Double?
    let count: Int?
}

struct ERPPnlGroup: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let grossProceeds: Double?
    let totalFees: Double?
    let netProceeds: Double?
    let costBasis: Double?
    let realizedPnL: Double?
    let totalExpenses: Double?
    let netPnL: Double?
    let count: Int?
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

struct ERPTimeseriesResponse: Codable {
    let granularity: String?
    let points: [ERPTimeseriesPoint]?
}

struct ERPTimeseriesPoint: Codable, Identifiable, Hashable {
    var id: String { period }
    let period: String
    let revenue: Double?
    let cost: Double?
    let pnl: Double?
    let count: Int?
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

struct ERPTradeRecordRequest: Codable {
    let outgoing: [ERPTradeOutgoingItem]
    let incoming: [ERPTradeIncomingItem]
    let cashToMe: Double
    let notes: String?
    let date: String?
}

struct ERPTradeOutgoingItem: Codable, Hashable {
    let holdingId: String
    let fmvAtTrade: Double
    let fmvSource: String
}

struct ERPTradeIncomingItem: Codable, Hashable {
    let cardTitle: String
    let fmvAtTrade: Double
    let fmvSource: String
    let playerName: String?
    let year: String?
    let setName: String?
    let parallel: String?
    let grade: String?
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
