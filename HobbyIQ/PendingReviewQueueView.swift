//
//  PendingReviewQueueView.swift
//  HobbyIQ
//
//  Scope 3.5 (backend PRs #383-#388) — the eBay auto-import Review
//  Queue surface. Renders holdings that came in via
//  `POST /erp/purchases/import/ebay` with `status = "pending-review"`
//  and lets the user confirm each row (optionally editing extracted
//  fields) or reject the whole auto-import misfire.
//
//  UX contract (per PR #388 handoff):
//    • Header "Review needed (N)" chip on the inventory home.
//    • List row = photos[0] at 72pt + extracted title + confidence pill
//      (green "eBay-confirmed" for enrichedFromEbay, yellow "Review"
//      for parseConfidence 0.70–0.94).
//    • "Confirm all high-confidence (N)" batch button — one tap
//      approves every `.high` row with no edits.
//    • Single-holding review sheet: extracted fields (editable) LEFT
//      vs `ebayItemAspects` (read-only) RIGHT, plus swipeable
//      `photos[]` gallery, `ebayShortDescription`, and seller line.
//    • Confirm posts ONLY changed fields — unchanged fields must be
//      nil in the request body so the backend's diff signal stays
//      honest.
//

import SwiftUI

// MARK: - Home entry point

struct PendingReviewEntryButton: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(width: 40, height: 40)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("Review needed")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text("\(count)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(HobbyIQTheme.Colors.electricBlue)
                            .clipShape(Capsule(style: .continuous))
                    }
                    Text("Confirm details on your latest eBay purchases.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) holdings need review")
    }
}

// MARK: - Queue list screen

struct PendingReviewQueueView: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var selectedHolding: InventoryCard?
    @State private var isBatchConfirming = false
    @State private var batchToast: String?

    private var highConfidenceCount: Int {
        viewModel.pendingReviewHoldings.filter { $0.reviewConfidenceBucket == .high }.count
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                heroCard

                if let batchToast {
                    toast(batchToast)
                }

                if viewModel.pendingReviewHoldings.isEmpty {
                    emptyState
                } else {
                    if highConfidenceCount > 0 {
                        batchConfirmButton
                    }
                    holdingsList
                }
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .refreshable { await viewModel.fetchPendingReview() }
        .toolbar(.hidden, for: .navigationBar)
        .task { await viewModel.fetchPendingReview() }
        .navigationDestination(item: $selectedHolding) { holding in
            PendingReviewDetailSheet(viewModel: viewModel, holding: holding) {
                Task { await viewModel.fetchPendingReview() }
            }
        }
    }

    // MARK: Hero

    private var heroCard: some View {
        HIQHeroCard(
            title: "Review",
            statusDate: Self.shortDate.string(from: Date()),
            heroValue: "\(viewModel.pendingReviewHoldings.count)",
            titleAlignment: .center,
            leading: {
                Button { dismiss() } label: {
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
                .accessibilityLabel("Back")
            },
            meta: {
                if viewModel.pendingReviewHoldings.isEmpty == false {
                    Text("\(highConfidenceCount) eBay-confirmed · \(viewModel.pendingReviewHoldings.count - highConfidenceCount) need review")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                }
            }
        )
    }

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    // MARK: Batch confirm

    private var batchConfirmButton: some View {
        Button {
            Task {
                isBatchConfirming = true
                let n = await viewModel.batchConfirmHighConfidence()
                isBatchConfirming = false
                batchToast = n > 0
                    ? "Confirmed \(n) high-confidence holding\(n == 1 ? "" : "s")."
                    : "Nothing to confirm."
            }
        } label: {
            HStack(spacing: 8) {
                if isBatchConfirming {
                    ProgressView().tint(HobbyIQTheme.Colors.pureWhite).controlSize(.small)
                } else {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.subheadline.weight(.bold))
                }
                Text(isBatchConfirming
                     ? "Confirming…"
                     : "Confirm all high-confidence (\(highConfidenceCount))")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(HobbyIQTheme.Colors.electricBlue)
            .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isBatchConfirming)
    }

    // MARK: Holdings list

    private var holdingsList: some View {
        VStack(spacing: 8) {
            ForEach(viewModel.pendingReviewHoldings) { holding in
                Button { selectedHolding = holding } label: {
                    PendingReviewRow(holding: holding)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Empty / toast

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.successGreen.opacity(0.8))
            Text("You're all caught up")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Confirmed holdings show up in Inventory and count toward P&L.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func toast(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            Text(text)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.successGreen.opacity(0.14))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

// MARK: - Row

private struct PendingReviewRow: View {
    let holding: InventoryCard

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            thumbnail
            VStack(alignment: .leading, spacing: 4) {
                Text(holding.playerName.isEmpty ? "Unknown player" : holding.playerName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                if let subtitle = subtitle, subtitle.isEmpty == false {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                confidencePill
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(holding.cost.portfolioCurrencyText)
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var subtitle: String? {
        let year = holding.year.trimmingCharacters(in: .whitespaces)
        let set = holding.setName.trimmingCharacters(in: .whitespaces)
        let parallel = holding.parallel.trimmingCharacters(in: .whitespaces)
        let bits = [year, set, parallel].filter { $0.isEmpty == false }
        guard bits.isEmpty == false else { return nil }
        return bits.joined(separator: " · ")
    }

    private var thumbnail: some View {
        let url = holding.preferredThumbnailURL
        return Group {
            if let url, let parsed = URL(string: url) {
                AsyncImage(url: parsed) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit().scaleEffect(0.9)
                    case .empty, .failure:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(width: 54, height: 72)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @ViewBuilder
    private var confidencePill: some View {
        switch holding.reviewConfidenceBucket {
        case .high:
            HStack(spacing: 4) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 9, weight: .bold))
                Text("eBay-confirmed")
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
        case .needs:
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 9, weight: .bold))
                Text("Review")
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
    }
}
