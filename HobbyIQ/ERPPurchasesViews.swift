//
//  ERPPurchasesViews.swift
//  HobbyIQ
//
//  Scope 3 (2026-07-12) — purchases surfaces:
//   • `ERPPurchasesListView`  — full list, pushed from Financials Purchases pill.
//   • `ERPPurchaseDetailView` — per-purchase breakdown + link-holdings action.
//   • `ERPPurchaseAddView`    — manual purchase entry form.
//   • `ERPPurchaseLinkHoldingsView` — multi-select holdings attribution.
//
//  All flows call `/api/portfolio/erp/purchases*` (see APIService). Same
//  theme language as the Financials hub — `HIQHeroCard`, `HIQSectionHeader`,
//  `hiqCardStyle`, and the shared purchase row.
//

import SwiftUI

// MARK: - Sort mode

enum ERPPurchaseSortMode: String, CaseIterable, Identifiable {
    case newest = "Newest first"
    case oldest = "Oldest first"
    case highest = "Highest cost"
    case lowest = "Lowest cost"
    case vendor = "By vendor"
    case byMonth = "By month"

    var id: String { rawValue }
}

// MARK: - Row

/// Compact row used in the Purchases list. Rendered inside a cardNavy
/// container just like `HIQCompactSaleRow`. Purchases don't have card
/// thumbnails (they're orders, not cards), so a themed icon slot stands
/// in for the leading art.
struct ERPPurchaseRow: View {
    let entry: PortfolioPurchaseEntry

    private var subtitle: String {
        if let vendor = entry.vendor, vendor.isEmpty == false { return vendor }
        if entry.source == "ebay" { return "eBay order" }
        return "Manual entry"
    }

    private var body1: String {
        entry.notes ?? subtitle
    }

    private var dateShort: String {
        Self.formatShortDate(from: entry.purchaseDate)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: entry.source == "ebay" ? "bag.fill" : "cart.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .frame(width: 34, height: 34)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(body1)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }

            Spacer(minLength: 12)

            VStack(alignment: .trailing, spacing: 2) {
                Text(entry.totalCost.portfolioCurrencyText)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if dateShort.isEmpty == false {
                    Text(dateShort)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
    }

    static func formatShortDate(from iso: String) -> String {
        for parser in Self.isoParsers {
            if let d = parser.date(from: iso) {
                return Self.shortDate.string(from: d)
            }
        }
        return ""
    }

    private static let isoParsers: [ISO8601DateFormatter] = {
        let a = ISO8601DateFormatter()
        a.formatOptions = [.withInternetDateTime]
        let b = ISO8601DateFormatter()
        b.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return [b, a]
    }()

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()
}

// MARK: - Purchases list

struct ERPPurchasesListView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var purchases: [PortfolioPurchaseEntry] = []
    @State private var totals: PortfolioPurchaseListTotals?
    @State private var sortMode: ERPPurchaseSortMode = .newest
    @State private var sourceFilter: SourceFilter = .all
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showAddSheet = false
    @State private var selectedPurchase: PortfolioPurchaseEntry?

    enum SourceFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case ebay = "eBay"
        case manual = "Manual"
        var id: String { rawValue }
        var wireValue: String? {
            switch self {
            case .all: return nil
            case .ebay: return "ebay"
            case .manual: return "manual"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                heroCard
                sourceFilterRow
                sortRow
                content
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .refreshable { await load() }
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .onChange(of: sourceFilter) { _, _ in Task { await load() } }
        .onReceive(NotificationCenter.default.publisher(for: .portfolioPurchaseRecorded)) { _ in
            Task { await load() }
        }
        .navigationDestination(item: $selectedPurchase) { purchase in
            ERPPurchaseDetailView(purchase: purchase) { updated in
                if let idx = purchases.firstIndex(where: { $0.id == updated.id }) {
                    purchases[idx] = updated
                }
            }
        }
        .sheet(isPresented: $showAddSheet) {
            ERPPurchaseAddView { newPurchase in
                purchases.insert(newPurchase, at: 0)
                Task { await load() }
            }
        }
    }

    // MARK: Hero

    private var heroCard: some View {
        let total = totals?.totalCost ?? purchases.reduce(0.0) { $0 + $1.totalCost }
        let count = totals?.count ?? purchases.count
        return HIQHeroCard(
            title: "Purchases",
            statusDate: Self.shortDate.string(from: Date()),
            heroValue: total.portfolioCurrencyText,
            titleAlignment: .center,
            leading: {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .frame(width: 36, height: 36)
                        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to Financials")
            },
            trailing: {
                Button {
                    showAddSheet = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .frame(width: 36, height: 36)
                        .background(HobbyIQTheme.Colors.electricBlue)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add manual purchase")
            },
            meta: {
                if count > 0 {
                    Text("\(count) purchase\(count == 1 ? "" : "s")\(subtotalMetaSuffix)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                }
            }
        )
    }

    private var subtotalMetaSuffix: String {
        guard let t = totals else { return "" }
        var parts: [String] = []
        if let sub = t.subtotal { parts.append("subtotal \(sub.portfolioCurrencyText)") }
        if let tax = t.tax, tax > 0.005 { parts.append("tax \(tax.portfolioCurrencyText)") }
        if let ship = t.shipping, ship > 0.005 { parts.append("ship \(ship.portfolioCurrencyText)") }
        return parts.isEmpty ? "" : " · " + parts.joined(separator: " · ")
    }

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    // MARK: Source filter

    private var sourceFilterRow: some View {
        HStack(spacing: 0) {
            ForEach(SourceFilter.allCases) { f in
                Button {
                    sourceFilter = f
                } label: {
                    Text(f.rawValue)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(sourceFilter == f ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(sourceFilter == f ? HobbyIQTheme.Colors.electricBlue.opacity(0.25) : Color.clear)
                        .clipShape(Capsule(style: .continuous))
                        .contentShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Show \(f.rawValue) purchases")
            }
        }
        .padding(3)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(Capsule(style: .continuous))
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    // MARK: Sort row

    private var sortRow: some View {
        HStack {
            Text("\(purchases.count) purchase\(purchases.count == 1 ? "" : "s")")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Menu {
                Picker("Sort by", selection: $sortMode) {
                    ForEach(ERPPurchaseSortMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(sortMode.rawValue)
                        .font(.caption.weight(.semibold))
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1)
                )
                .clipShape(Capsule(style: .continuous))
            }
            .accessibilityLabel("Sort purchases")
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if isLoading && purchases.isEmpty {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if let errorMessage {
            errorState(errorMessage)
        } else if purchases.isEmpty {
            emptyState
        } else if sortMode == .byMonth {
            monthGroupedList
        } else {
            flatList
        }
    }

    private var flatList: some View {
        VStack(spacing: 4) {
            ForEach(sortedPurchases) { entry in
                Button { selectedPurchase = entry } label: {
                    ERPPurchaseRow(entry: entry)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 6)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var monthGroupedList: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(monthGroups) { group in
                VStack(alignment: .leading, spacing: 10) {
                    HIQSectionHeader(group.key)
                    VStack(spacing: 4) {
                        ForEach(group.entries) { entry in
                            Button { selectedPurchase = entry } label: {
                                ERPPurchaseRow(entry: entry)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "bag.badge.questionmark")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            Text("No purchases yet")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Sync eBay from Integrations, or add a manual purchase to start tracking cost basis.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

            Button {
                showAddSheet = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus.circle.fill")
                        .font(.subheadline.weight(.bold))
                    Text("Add purchase")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text("Couldn't load purchases")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Sorting

    private var sortedPurchases: [PortfolioPurchaseEntry] {
        switch sortMode {
        case .newest:  return purchases.sorted { $0.purchaseDate > $1.purchaseDate }
        case .oldest:  return purchases.sorted { $0.purchaseDate < $1.purchaseDate }
        case .highest: return purchases.sorted { $0.totalCost > $1.totalCost }
        case .lowest:  return purchases.sorted { $0.totalCost < $1.totalCost }
        case .vendor:
            return purchases.sorted {
                ($0.vendor ?? "").localizedCaseInsensitiveCompare($1.vendor ?? "") == .orderedAscending
            }
        case .byMonth: return purchases
        }
    }

    private struct MonthGroup: Identifiable {
        let key: String
        let sortKey: String
        let entries: [PortfolioPurchaseEntry]
        var id: String { sortKey }
    }

    private var monthGroups: [MonthGroup] {
        let bucketed = Dictionary(grouping: purchases) { monthKey(for: $0.purchaseDate) }
        return bucketed
            .map { pair in
                MonthGroup(
                    key: monthLabel(sortKey: pair.key),
                    sortKey: pair.key,
                    entries: pair.value.sorted { $0.purchaseDate > $1.purchaseDate }
                )
            }
            .sorted { $0.sortKey > $1.sortKey }
    }

    private func monthKey(for iso: String) -> String {
        for parser in [Self.isoWithFractional, Self.isoStandard] {
            if let d = parser.date(from: iso) {
                return Self.monthSortKeyFormatter.string(from: d)
            }
        }
        return "unknown"
    }

    private func monthLabel(sortKey: String) -> String {
        if sortKey == "unknown" { return "Undated" }
        if let d = Self.monthSortKeyFormatter.date(from: sortKey) {
            return Self.monthDisplayFormatter.string(from: d)
        }
        return sortKey
    }

    private static let isoStandard: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let isoWithFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let monthSortKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM"
        return f
    }()

    private static let monthDisplayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMMM yyyy"
        return f
    }()

    // MARK: Data

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchPurchases(source: sourceFilter.wireValue)
            purchases = response.purchases ?? []
            totals = response.totals
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Purchase Detail

struct ERPPurchaseDetailView: View {
    let purchase: PortfolioPurchaseEntry
    let onUpdated: (PortfolioPurchaseEntry) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var currentPurchase: PortfolioPurchaseEntry
    @State private var showLinkHoldings = false

    init(purchase: PortfolioPurchaseEntry, onUpdated: @escaping (PortfolioPurchaseEntry) -> Void) {
        self.purchase = purchase
        self.onUpdated = onUpdated
        self._currentPurchase = State(initialValue: purchase)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerCard
                breakdownCard
                holdingsCard
                if let notes = currentPurchase.notes, notes.isEmpty == false {
                    notesCard(notes)
                }
                if let orderId = currentPurchase.ebayOrderId {
                    metadataCard(orderId: orderId, txId: currentPurchase.ebayTransactionId)
                }
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Purchase")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .navigationDestination(isPresented: $showLinkHoldings) {
            ERPPurchaseLinkHoldingsView(purchase: currentPurchase) { updated in
                currentPurchase = updated
                onUpdated(updated)
            }
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: currentPurchase.source == "ebay" ? "bag.fill" : "cart.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(width: 40, height: 40)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(currentPurchase.vendor ?? (currentPurchase.source == "ebay" ? "eBay order" : "Manual purchase"))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(ERPPurchaseRow.formatShortDate(from: currentPurchase.purchaseDate))
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer()
            }

            Text(currentPurchase.totalCost.portfolioCurrencyText)
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private var breakdownCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HIQSectionHeader("Breakdown")
            VStack(spacing: 0) {
                breakdownRow("Subtotal", value: currentPurchase.subtotal)
                divider
                breakdownRow("Tax", value: currentPurchase.tax)
                divider
                breakdownRow("Shipping", value: currentPurchase.shipping)
                divider
                breakdownRow("Other fees", value: currentPurchase.otherFees)
                divider
                breakdownRow("Total", value: currentPurchase.totalCost, bold: true)
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func breakdownRow(_ label: String, value: Double, bold: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(bold ? .subheadline.weight(.bold) : .subheadline)
                .foregroundStyle(bold ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value.portfolioCurrencyText)
                .font(bold ? .subheadline.weight(.bold).monospacedDigit() : .subheadline.monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.vertical, 6)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 1)
    }

    private var holdingsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                HIQSectionHeader("Linked holdings")
                Spacer()
            }
            let holdingIds = currentPurchase.holdingIds
            VStack(alignment: .leading, spacing: 8) {
                if holdingIds.isEmpty {
                    Text("This purchase isn't linked to any holdings yet.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("\(holdingIds.count) holding\(holdingIds.count == 1 ? "" : "s") linked")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                Button {
                    showLinkHoldings = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "link")
                            .font(.caption.weight(.semibold))
                        Text(holdingIds.isEmpty ? "Link this purchase to holdings" : "Manage linked holdings")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func notesCard(_ notes: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HIQSectionHeader("Notes")
            Text(notes)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
                .padding(HobbyIQTheme.Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func metadataCard(orderId: String, txId: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HIQSectionHeader("eBay reference")
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Order ID").font(.caption).foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(orderId).font(.caption.monospacedDigit()).foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                if let txId {
                    HStack {
                        Text("Transaction").font(.caption).foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                        Text(txId).font(.caption.monospacedDigit()).foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
                if let invoice = currentPurchase.invoiceRef, invoice.isEmpty == false {
                    HStack {
                        Text("Invoice").font(.caption).foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                        Text(invoice).font(.caption.monospacedDigit()).foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }
}

// MARK: - Manual purchase entry form

struct ERPPurchaseAddView: View {
    let onCreated: (PortfolioPurchaseEntry) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var purchaseDate: Date = Date()
    @State private var subtotalText: String = ""
    @State private var taxText: String = ""
    @State private var shippingText: String = ""
    @State private var otherFeesText: String = ""
    @State private var vendor: String = ""
    @State private var notes: String = ""
    @State private var invoiceRef: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var subtotal: Double { Double(subtotalText.trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var tax: Double { Double(taxText.trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var shipping: Double { Double(shippingText.trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var otherFees: Double { Double(otherFeesText.trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var computedTotal: Double { subtotal + tax + shipping + otherFees }

    private var canSave: Bool {
        subtotal > 0 && isSaving == false
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    dateField
                    amountsCard
                    metaCard
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    saveButton
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, 16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Add purchase")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
    }

    private var dateField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Purchase date")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.1)
            DatePicker("", selection: $purchaseDate, in: ...Date(), displayedComponents: .date)
                .datePickerStyle(.compact)
                .labelsHidden()
                .tint(HobbyIQTheme.Colors.electricBlue)
        }
    }

    private var amountsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            currencyField(label: "Subtotal (required)", text: $subtotalText, required: true)
            currencyField(label: "Tax", text: $taxText)
            currencyField(label: "Shipping", text: $shippingText)
            currencyField(label: "Other fees", text: $otherFeesText)

            HStack {
                Text("Total")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                Text(computedTotal.portfolioCurrencyText)
                    .font(.title3.weight(.bold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func currencyField(label: String, text: Binding<String>, required: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            HStack(spacing: 6) {
                Text("$")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                TextField(required ? "0.00" : "0.00 (optional)", text: text)
                    .keyboardType(.decimalPad)
                    .font(.body.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.white.opacity(0.1), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private var metaCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            textField(label: "Vendor", text: $vendor, placeholder: "eBay, LCS, show, etc.")
            textField(label: "Invoice / reference", text: $invoiceRef, placeholder: "Optional")
            VStack(alignment: .leading, spacing: 4) {
                Text("Notes")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                TextField("What did you buy?", text: $notes, axis: .vertical)
                    .lineLimit(2...5)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(HobbyIQTheme.Colors.cardNavy)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Color.white.opacity(0.1), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func textField(label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            TextField(placeholder, text: text)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            HStack(spacing: 8) {
                if isSaving {
                    ProgressView().tint(HobbyIQTheme.Colors.pureWhite).controlSize(.small)
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.subheadline.weight(.bold))
                }
                Text(isSaving ? "Saving…" : "Save purchase")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(canSave ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.electricBlue.opacity(0.4))
            .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(canSave == false)
    }

    private func save() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }

        let request = PortfolioPurchaseCreateRequest(
            purchaseDate: ISO8601DateFormatter().string(from: purchaseDate),
            source: "manual",
            subtotal: subtotal,
            tax: tax > 0 ? tax : nil,
            shipping: shipping > 0 ? shipping : nil,
            otherFees: otherFees > 0 ? otherFees : nil,
            holdingIds: nil,
            vendor: vendor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : vendor,
            invoiceRef: invoiceRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : invoiceRef,
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes
        )

        do {
            let response = try await APIService.shared.createPurchase(request)
            if let created = response.purchase {
                onCreated(created)
                NotificationCenter.default.post(name: .portfolioPurchaseRecorded, object: nil)
                dismiss()
            } else {
                errorMessage = "Backend didn't return the created purchase. Try again."
            }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Link-holdings attribution UI

/// Multi-select holdings picker. Loads the user's inventory via
/// `LocalPortfolioProvider` so the picker works offline too; on save,
/// PATCH the union of selection into the purchase.
struct ERPPurchaseLinkHoldingsView: View {
    let purchase: PortfolioPurchaseEntry
    let onUpdated: (PortfolioPurchaseEntry) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var searchText: String = ""
    @State private var allHoldings: [InventoryCard] = []
    @State private var selectedIds: Set<String> = []
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            searchField
            content
            saveBar
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Link holdings")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task {
            selectedIds = Set(purchase.holdingIds)
            await loadHoldings()
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            TextField("Search by player or card", text: $searchText)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(Capsule(style: .continuous))
        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
        .padding(.top, 16)
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            Spacer()
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Spacer()
        } else if filteredHoldings.isEmpty {
            Spacer()
            VStack(spacing: 6) {
                Image(systemName: "square.stack.3d.up.slash")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text(searchText.isEmpty ? "No holdings yet" : "No matches")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .padding(.vertical, 48)
            Spacer()
        } else {
            List {
                ForEach(filteredHoldings, id: \.id) { holding in
                    row(for: holding)
                        .listRowBackground(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                        .listRowSeparatorTint(Color.white.opacity(0.08))
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .padding(.top, 8)
        }
    }

    private func row(for holding: InventoryCard) -> some View {
        let id = holding.id.uuidString
        let isSelected = selectedIds.contains(id)
        return Button {
            if isSelected { selectedIds.remove(id) } else { selectedIds.insert(id) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(isSelected ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText.opacity(0.7))
                VStack(alignment: .leading, spacing: 2) {
                    Text(holding.playerName.isEmpty ? "Unknown player" : holding.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(1)
                    Text(holding.cardName.isEmpty ? "—" : holding.cardName)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(holding.cost.portfolioCurrencyText)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
    }

    private var saveBar: some View {
        VStack(spacing: 6) {
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
            Button {
                Task { await save() }
            } label: {
                HStack(spacing: 8) {
                    if isSaving {
                        ProgressView().tint(HobbyIQTheme.Colors.pureWhite).controlSize(.small)
                    } else {
                        Image(systemName: "link")
                            .font(.subheadline.weight(.bold))
                    }
                    Text(isSaving ? "Saving…" : "Link \(selectedIds.count) holding\(selectedIds.count == 1 ? "" : "s")")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(selectedIds.isEmpty ? HobbyIQTheme.Colors.electricBlue.opacity(0.4) : HobbyIQTheme.Colors.electricBlue)
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(selectedIds.isEmpty || isSaving)
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
        .padding(.vertical, 12)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.8))
    }

    private var filteredHoldings: [InventoryCard] {
        let q = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.isEmpty == false else { return allHoldings }
        return allHoldings.filter {
            $0.playerName.lowercased().contains(q) || $0.cardName.lowercased().contains(q)
        }
    }

    private func loadHoldings() async {
        isLoading = true
        defer { isLoading = false }
        allHoldings = await LocalPortfolioProvider.shared.getInventory()
    }

    private func save() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        do {
            let response = try await APIService.shared.linkPurchaseHoldings(
                purchaseId: purchase.id,
                holdingIds: Array(selectedIds)
            )
            if let updated = response.purchase {
                onUpdated(updated)
                dismiss()
            } else {
                errorMessage = "Backend didn't return the updated purchase. Try again."
            }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}
