//
//  ERPInventoryAnalyticsView.swift
//  HobbyIQ
//
//  Scope 3 (2026-07-12) surface #7 — Inventory Turnover + Aging.
//  Backed by `GET /api/portfolio/erp/inventory-analytics`.
//

import SwiftUI

struct ERPInventoryAnalyticsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var analytics: InventoryAnalyticsResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                heroCard
                content
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .refreshable { await load() }
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
    }

    // MARK: Hero

    private var heroCard: some View {
        let cost = analytics?.totals?.totalCostBasis ?? 0
        let count = analytics?.totals?.holdingCount ?? 0
        return HIQHeroCard(
            title: "Inventory",
            statusDate: Self.shortDate.string(from: Date()),
            heroValue: cost.portfolioCurrencyText,
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
            meta: {
                if count > 0 {
                    Text(metaText(count: count))
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                }
            }
        )
    }

    private func metaText(count: Int) -> String {
        var parts: [String] = ["\(count) holding\(count == 1 ? "" : "s") at cost"]
        if let avg = analytics?.aging?.avgDaysOnHand {
            parts.append("avg \(avg)d on hand")
        }
        if let median = analytics?.aging?.medianDaysOnHand {
            parts.append("median \(median)d")
        }
        return parts.joined(separator: " · ")
    }

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if isLoading && analytics == nil {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if let errorMessage {
            errorState(errorMessage)
        } else if let analytics {
            agingSection(analytics)
            turnoverSection(analytics)
            oldestSection(analytics)
        } else {
            emptyState
        }
    }

    // MARK: Aging distribution

    private func agingSection(_ data: InventoryAnalyticsResponse) -> some View {
        let buckets = data.aging?.buckets ?? []
        let totalCost = buckets.reduce(0.0) { $0 + $1.costBasis }
        return VStack(alignment: .leading, spacing: 10) {
            HIQSectionHeader("Aging distribution")
            VStack(alignment: .leading, spacing: 10) {
                if buckets.isEmpty {
                    Text("No holdings to age yet.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                } else {
                    ForEach(buckets) { bucket in
                        agingBar(bucket: bucket, totalCost: totalCost)
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

    private func agingBar(bucket: InventoryAnalyticsAgingBucket, totalCost: Double) -> some View {
        let fraction: Double = totalCost > 0 ? min(1.0, max(0.0, bucket.costBasis / totalCost)) : 0
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(bucket.label)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                Text("\(bucket.count) · \(bucket.costBasis.portfolioCurrencyText)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.10))
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(HobbyIQTheme.Gradients.dashboardStroke)
                        .frame(width: geo.size.width * fraction)
                }
            }
            .frame(height: 8)
        }
    }

    // MARK: Turnover

    private func turnoverSection(_ data: InventoryAnalyticsResponse) -> some View {
        let t = data.turnover
        let proxy = t?.turnoverProxy
        let sold = t?.costBasisSold ?? 0
        let current = t?.currentInventoryCost ?? 0
        return VStack(alignment: .leading, spacing: 10) {
            HIQSectionHeader("Turnover")
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .lastTextBaseline) {
                    Text(proxy.map { String(format: "%.2f×", $0) } ?? "—")
                        .font(.title2.weight(.bold).monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                }
                Text("Cost sold in window ÷ current inventory value")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Divider().overlay(Color.white.opacity(0.08))
                HStack(spacing: 12) {
                    metricCell(label: "Sold (window)", value: sold.portfolioCurrencyText)
                    divider
                    metricCell(label: "Inventory value", value: current.portfolioCurrencyText)
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

    private func metricCell(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.08))
            .frame(width: 1, height: 28)
    }

    // MARK: Oldest holdings

    private func oldestSection(_ data: InventoryAnalyticsResponse) -> some View {
        let rows = data.oldestHoldings ?? []
        return VStack(alignment: .leading, spacing: 10) {
            HIQSectionHeader("Oldest holdings")
            if rows.isEmpty {
                Text("No holdings on hand.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(HobbyIQTheme.Spacing.medium)
            } else {
                VStack(spacing: 4) {
                    ForEach(rows.prefix(10)) { row in
                        oldestRow(row)
                    }
                }
                .padding(.vertical, 6)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
        }
    }

    private func oldestRow(_ row: InventoryAnalyticsOldestHolding) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "clock.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .frame(width: 30, height: 30)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(row.playerName ?? "Unknown player")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Text(row.cardTitle ?? "—")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }
            Spacer(minLength: 10)
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(row.daysInInventory)d")
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(row.costBasis.portfolioCurrencyText)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
    }

    // MARK: Empty + Error states

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "square.stack.3d.up.slash")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            Text("No inventory data yet")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Add holdings to see aging and turnover metrics.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text("Couldn't load inventory analytics")
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

    // MARK: Data

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            analytics = try await APIService.shared.fetchInventoryAnalytics()
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}
