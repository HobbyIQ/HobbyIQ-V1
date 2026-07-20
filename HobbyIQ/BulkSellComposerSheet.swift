//
//  BulkSellComposerSheet.swift
//  HobbyIQ
//
//  Presented when the user picks >= 2 cards from Inventory multi-select
//  and taps "Compare X cards" (backend PR #549). Shows the recommended
//  strategy, per-card net delta, and the assumptions used by the math.
//

import SwiftUI

struct BulkSellComposerSheet: View {
    let holdingIds: [String]
    /// Map from holdingId -> InventoryCard so we can pull thumbnails
    /// / player names. Passed in from InventoryIQView which owns the
    /// portfolioVM.
    let cardLookup: [String: InventoryCard]

    @Environment(\.dismiss) private var dismiss
    @State private var response: BulkSellResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if isLoading {
                            loadingState
                        } else if let response {
                            summaryHeader(response: response)
                            perCardBlock(response: response)
                            assumptionsBlock(response: response)
                        } else if let errorMessage {
                            errorState(errorMessage)
                        }
                    }
                    .padding(HobbyIQTheme.Spacing.screenPadding)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Bulk Sell Compare")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            response = try await APIService.shared.postBulkSellComposer(holdingIds: holdingIds)
        } catch {
            response = nil
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    // MARK: - Summary

    @ViewBuilder
    private func summaryHeader(response: BulkSellResponse) -> some View {
        let totals = response.totals
        let recommendation = recommendedLabel(totals?.recommendedStrategy)
        VStack(alignment: .leading, spacing: 8) {
            Text("RECOMMENDED")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(recommendation)
                .font(.title3.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            HStack(alignment: .firstTextBaseline, spacing: 12) {
                summaryNet(
                    label: "Projected net",
                    value: totals?.combinedNet,
                    tint: HobbyIQTheme.Colors.successGreen
                )
                summaryNet(
                    label: "Bundle would net",
                    value: totals?.bundleStrategyNet,
                    tint: HobbyIQTheme.Colors.mutedText
                )
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.4)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func summaryNet(label: String, value: Double?, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(currency(value))
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(tint)
        }
    }

    private func recommendedLabel(_ strategy: BulkSellTotalStrategy?) -> String {
        switch strategy {
        case .allIndividual: return "List individually"
        case .allBundle:     return "Bundle the batch"
        case .mixed:         return "Mixed \u{2014} best of both"
        case .none:          return "\u{2014}"
        }
    }

    // MARK: - Per-card

    @ViewBuilder
    private func perCardBlock(response: BulkSellResponse) -> some View {
        let candidates = response.candidates ?? []
        VStack(alignment: .leading, spacing: 8) {
            Text("PER-CARD")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            LazyVStack(spacing: 10) {
                ForEach(candidates) { candidate in
                    // 2026-07-20 (spec §Trigger points): each row
                    // is a NavigationLink into ListingReviewView
                    // for that specific holding. Replaces the
                    // one-tap sell from earlier iterations.
                    NavigationLink {
                        ListingReviewView(holdingId: candidate.holdingId)
                    } label: {
                        BulkSellCandidateRow(candidate: candidate, card: cardLookup[candidate.holdingId])
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: - Assumptions

    @ViewBuilder
    private func assumptionsBlock(response: BulkSellResponse) -> some View {
        if let assumptions = response.assumptions {
            VStack(alignment: .leading, spacing: 4) {
                Text("ASSUMPTIONS")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text(assumptionsLine(assumptions))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func assumptionsLine(_ a: BulkSellAssumptions) -> String {
        var parts: [String] = []
        if let fee = a.ebayFeePct { parts.append("eBay fee \(Int((fee * 100).rounded()))%") }
        if let discount = a.bundleDiscountPct { parts.append("Bundle discount \(Int((discount * 100).rounded()))%") }
        if let ship = a.perCardShippingCost { parts.append("\(currency(ship))/card shipping") }
        if let bundleShip = a.bundleShippingCost { parts.append("Bundle shipping \(currency(bundleShip))") }
        return parts.joined(separator: " \u{00B7} ")
    }

    // MARK: - Common states

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Computing bundle vs individual math…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
    }

    private func errorState(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Couldn't run the composer")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func currency(_ value: Double?) -> String {
        guard let value else { return "\u{2014}" }
        return value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }
}

// MARK: - Row

private struct BulkSellCandidateRow: View {
    let candidate: BulkSellCandidate
    let card: InventoryCard?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            thumbnail
            VStack(alignment: .leading, spacing: 4) {
                Text(candidate.playerName ?? card?.playerName ?? "Unknown")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                if let title = candidate.cardTitle {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                priceLines
            }
            Spacer(minLength: 0)
            strategyChip
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(strategyColor.opacity(0.32), lineWidth: 1.1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private var priceLines: some View {
        if let solo = candidate.individualNetProceeds {
            Text("Solo: \(formatCurrency(solo))")
                .font(.caption.monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        if let bundle = candidate.bundleShareOfNet {
            Text("In bundle: \(formatCurrency(bundle))")
                .font(.caption.monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private var strategyChip: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(strategyLabel)
                .font(.caption2.weight(.bold))
                .tracking(0.4)
                .foregroundStyle(strategyColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(strategyColor.opacity(0.16))
                .clipShape(Capsule(style: .continuous))
            if let delta = candidate.netDelta, delta != 0 {
                Text(deltaText(delta))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(delta >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }
        }
    }

    private var strategyLabel: String {
        switch candidate.strategy {
        case .listIndividually:     return "List solo"
        case .addToBundle:          return "Bundle"
        case .skipMissingPredicted: return "No target yet"
        case .none:                 return "—"
        }
    }

    private var strategyColor: Color {
        switch candidate.strategy {
        case .listIndividually:     return HobbyIQTheme.Colors.successGreen
        case .addToBundle:          return HobbyIQTheme.Colors.electricBlue
        case .skipMissingPredicted: return HobbyIQTheme.Colors.mutedText
        case .none:                 return HobbyIQTheme.Colors.mutedText
        }
    }

    private func deltaText(_ delta: Double) -> String {
        let sign = delta >= 0 ? "+" : "\u{2212}"
        return sign + formatCurrency(abs(delta))
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let urlString = card?.preferredThumbnailURL?.trimmingCharacters(in: .whitespacesAndNewlines),
           urlString.isEmpty == false,
           let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .empty, .failure:
                    thumbnailPlaceholder
                @unknown default:
                    thumbnailPlaceholder
                }
            }
            .frame(width: 44, height: 60)
            .background(HobbyIQTheme.Colors.slateGray)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
                .frame(width: 44, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    private var thumbnailPlaceholder: some View {
        ZStack {
            HobbyIQTheme.Colors.slateGray
            Image(systemName: "rectangle.on.rectangle")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }
}
