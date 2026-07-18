//
//  TradeTargetsSheet.swift
//  HobbyIQ
//
//  "Find Deals" sheet — surfaces underpriced eBay listings for cards
//  the user owns (backend PR #551). Watchlist source is picker-only
//  until the backend follow-up resolves watchlist -> cardIds.
//

import SwiftUI
import UIKit

struct TradeTargetsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var selectedSource: TradeTargetSource = .inventory
    @State private var response: TradeTargetsResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        headerBlock

                        sourcePicker

                        if isLoading {
                            loadingState
                        } else if let response, let targets = response.targets, targets.isEmpty == false {
                            LazyVStack(spacing: 12) {
                                ForEach(targets) { target in
                                    TradeTargetRow(target: target)
                                }
                            }
                        } else if errorMessage != nil {
                            errorState
                        } else {
                            emptyState
                        }
                    }
                    .padding(HobbyIQTheme.Spacing.screenPadding)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Find Deals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                await load()
            }
            .onChange(of: selectedSource) { _, _ in
                Task { await load() }
            }
        }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SCAN RESULTS")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(headerLine)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private var headerLine: String {
        guard let response else { return "Scanning…" }
        let scanned = response.cardsScanned ?? 0
        let seen = response.listingsSeen ?? 0
        let hits = response.targets?.count ?? 0
        return "Scanned \(scanned) cards \u{00B7} \(seen) listings seen \u{00B7} \(hits) underpriced"
    }

    private var sourcePicker: some View {
        Picker("Source", selection: $selectedSource) {
            ForEach(TradeTargetSource.allCases) { source in
                Text(source.pickerLabel)
                    .tag(source)
            }
        }
        .pickerStyle(.segmented)
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Scanning eBay listings…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No underpriced listings found today")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Check back after new eBay listings load. Engine may still be warming up on this source.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var errorState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Couldn't scan for deals")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchTradeTargets(source: selectedSource)
        } catch {
            response = nil
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Row

private struct TradeTargetRow: View {
    let target: TradeTarget

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                thumbnail
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(target.playerName ?? "Unknown player")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        discountBadge
                    }
                    if let title = target.cardTitle, title.isEmpty == false {
                        Text(title)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(2)
                    }
                    priceBlock
                }
            }

            if let reason = target.reason, reason.isEmpty == false {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let listingUrl = target.listingUrl,
               let url = URL(string: listingUrl) {
                Button {
                    UIApplication.shared.open(url)
                } label: {
                    HStack(spacing: 6) {
                        Text("View on eBay")
                            .font(.caption.weight(.bold))
                        Image(systemName: "arrow.up.right.square")
                            .font(.caption)
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(confidenceStroke, lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var discountBadge: some View {
        let pctText = target.discountPct.map { String(format: "%.0f%% OFF", $0 * 100) } ?? "DEAL"
        return Text(pctText)
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(HobbyIQTheme.Colors.danger)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(HobbyIQTheme.Colors.danger.opacity(0.16))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.danger.opacity(0.55), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
    }

    @ViewBuilder
    private var priceBlock: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let ask = target.askPrice, ask > 0 {
                Text(formatCurrency(ask))
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if let engine = target.engineValue, engine > 0 {
                Text("vs \(formatCurrency(engine)) engine")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
        }
        HStack(spacing: 6) {
            if let confidence = target.confidence {
                Text(confidence.rawValue)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(confidenceColor)
            }
            if let seller = target.seller {
                let name = seller.username ?? "seller"
                let score = seller.feedbackScore.map { " (\($0))" } ?? ""
                Text("\u{00B7} @\(name)\(score)")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let urlString = target.imageUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
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
            .frame(width: 52, height: 72)
            .background(HobbyIQTheme.Colors.slateGray)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
                .frame(width: 52, height: 72)
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

    private var confidenceColor: Color {
        switch target.confidence {
        case .high:   return HobbyIQTheme.Colors.successGreen
        case .medium: return HobbyIQTheme.Colors.electricBlue
        case .low:    return HobbyIQTheme.Colors.warning
        case .none:   return HobbyIQTheme.Colors.mutedText
        }
    }

    private var confidenceStroke: Color {
        switch target.confidence {
        case .high:   return HobbyIQTheme.Colors.successGreen.opacity(0.55)
        case .low:    return HobbyIQTheme.Colors.warning.opacity(0.45)
        default:      return Color.white.opacity(0.08)
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }
}
