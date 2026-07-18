//
//  GradeWorthyListView.swift
//  HobbyIQ
//
//  Corpus signals (2026-07-17, PR #518): drill-down for the portfolio-home
//  grade-worthy banner. Renders every `grade_now` candidate from
//  `/api/portfolio/grade-worthy-alerts` with the raw card thumbnail,
//  expected gain, target tier + ROI, and a one-tap "Mark as At Grading"
//  CTA that flips the holding's graderStatus.
//

import SwiftUI

struct GradeWorthyListView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

    /// Per-row in-flight state so the CTA disables during the PATCH.
    @State private var markingHoldingId: String?
    /// Holding ids that have already been marked in this session so the
    /// CTA collapses to a "Marked" affordance and doesn't re-fire.
    @State private var markedHoldingIds: Set<String> = []
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let candidates = vm.gradeWorthyAlerts?.candidates, candidates.isEmpty == false {
                    ForEach(candidates) { candidate in
                        candidateRow(candidate)
                    }
                } else {
                    emptyState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Worth Grading")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .alert("Couldn't mark as At Grading", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    // MARK: - Header

    private var header: some View {
        let scanned = vm.gradeWorthyAlerts?.scannedHoldings ?? 0
        let count = vm.gradeWorthyAlerts?.gradeWorthyCount ?? 0
        return VStack(alignment: .leading, spacing: 4) {
            Text("\(count) worth grading")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Scanned \(scanned) holding\(scanned == 1 ? "" : "s") · sorted by expected gain")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Row

    private func candidateRow(_ candidate: GradeAnalysisResponse) -> some View {
        let card = vm.inventoryCards.first(where: { $0.id.uuidString == candidate.holdingId })
        let best = candidate.analysis?.bestTier
        let gain = best?.expectedGain ?? 0
        let roi = best?.expectedRoiPercentString ?? ""
        let tier = best?.graderTier ?? "—"
        let reason = best?.reason ?? candidate.analysis?.reason ?? ""
        let holdingId = candidate.holdingId
        let isMarking = markingHoldingId == holdingId
        let isMarked = markedHoldingIds.contains(holdingId)

        return HStack(alignment: .top, spacing: 12) {
            if let card {
                inventoryRowThumbnail(
                    urlString: card.preferredThumbnailURL,
                    playerName: card.playerName
                )
            } else {
                inventoryRowThumbnail(urlString: nil, playerName: candidate.player ?? "?")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(gradeWorthyRowTitle(candidate))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text("+\(portfolioCurrencyString(gain))")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    Text("·")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(tier)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if roi.isEmpty == false {
                        Text("·")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(roi)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }

                if reason.isEmpty == false {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // PR #547 (2026-07-17): observed failure-rate block.
                // Self-suppresses when the wire field is nil.
                if let failure = candidate.failureRate {
                    failureRateBlock(failure)
                }

                Button {
                    guard let card else { return }
                    Task { await markAsAtGrading(card: card, holdingId: holdingId) }
                } label: {
                    HStack(spacing: 6) {
                        if isMarking {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(HobbyIQTheme.Colors.electricBlue)
                        } else {
                            Image(systemName: isMarked ? "checkmark.seal.fill" : "shippingbox.fill")
                                .font(.caption.weight(.bold))
                        }
                        Text(isMarked ? "Marked At Grading" : "Mark as At Grading")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(isMarked ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 40)
                    .background(
                        isMarked
                            ? HobbyIQTheme.Colors.successGreen.opacity(0.14)
                            : HobbyIQTheme.Colors.electricBlue.opacity(card == nil ? 0.25 : 0.85)
                    )
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isMarking || isMarked || card == nil)
            }
            Spacer(minLength: 0)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - PR #547 Failure-Rate block

    /// FAILURE RATE block — verdict badge top-right, four-row grid, and
    /// verbatim caveat text at the bottom. `insufficient_data` verdict
    /// suppresses the numbers grid and shows only the verdict + caveat.
    @ViewBuilder
    private func failureRateBlock(_ failure: GradeFailureRate) -> some View {
        let verdict = failure.verdict ?? "insufficient_data"
        let showNumbers = verdict != "insufficient_data"
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("FAILURE RATE")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                failureRateVerdictBadge(verdict: verdict)
            }

            if showNumbers {
                VStack(spacing: 4) {
                    failureRateStatRow(
                        label: "Expected net after cost",
                        value: failure.expectedNetValue.map(portfolioCurrencyString) ?? "—"
                    )
                    failureRateStatRow(
                        label: "Chance of top grade",
                        value: pctString(failure.probabilityTopGrade)
                    )
                    failureRateStatRow(
                        label: "Chance of gain vs hold",
                        value: pctString(failure.probabilityGainVsHold)
                    )
                    failureRateStatRow(
                        label: "Chance of loss",
                        value: pctString(failure.probabilityLoss)
                    )
                }
            }

            if let caveat = failure.caveat, caveat.isEmpty == false {
                Text(caveat)
                    .font(.caption2.italic())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.slateGray.opacity(0.35))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                .stroke(failureRateVerdictColor(verdict).opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
    }

    private func failureRateVerdictBadge(verdict: String) -> some View {
        let (label, color) = failureRateVerdictDisplay(verdict)
        return Text(label)
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.16))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(color.opacity(0.55), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
    }

    private func failureRateVerdictDisplay(_ verdict: String) -> (String, Color) {
        switch verdict {
        case "worth_the_gamble":  return ("Worth the gamble", HobbyIQTheme.Colors.successGreen)
        case "risky":             return ("Risky", HobbyIQTheme.Colors.warning)
        case "loss_probable":     return ("Loss probable", HobbyIQTheme.Colors.danger)
        default:                  return ("Need more data", HobbyIQTheme.Colors.mutedText)
        }
    }

    private func failureRateVerdictColor(_ verdict: String) -> Color {
        failureRateVerdictDisplay(verdict).1
    }

    private func failureRateStatRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private func pctString(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.0f%%", value * 100)
    }

    private func gradeWorthyRowTitle(_ candidate: GradeAnalysisResponse) -> String {
        let player = candidate.player?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let number = candidate.cardNumber?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let year = candidate.year.map(String.init) ?? ""
        let parts = [year, player, number].filter { $0.isEmpty == false }
        return parts.isEmpty ? "Holding" : parts.joined(separator: " ")
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("Nothing worth grading right now")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("We rescan on every portfolio open.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
    }

    // MARK: - Mark as At Grading

    /// Corpus signals (2026-07-17): flips the holding's graderStatus to
    /// `.atPsa` — iOS's "at grading" surface. The spec references the
    /// /regrade endpoint, but that endpoint finalizes both gradeCompany
    /// and gradeValue (i.e. records the ACHIEVED grade), which would
    /// misrepresent a card that's merely en-route to a grader. Using
    /// `updateHoldingGraderStatus(status: .atPsa)` is the honest mapping
    /// — same slot the existing detail-sheet menu writes on manual
    /// status change. Target tier is surfaced only in the row's caption,
    /// not persisted; a future backend "target tier" field can pick that
    /// up when it lands.
    private func markAsAtGrading(card: InventoryCard, holdingId: String) async {
        markingHoldingId = holdingId
        defer { markingHoldingId = nil }
        do {
            _ = try await APIService.shared.updateHoldingGraderStatus(
                holdingId: card.id,
                status: .atPsa
            )
            markedHoldingIds.insert(holdingId)
            // Refresh the portfolio so the row's graderStatus caption
            // updates and the banner recomputes on next appear.
            await vm.refresh()
        } catch {
            errorMessage = "Couldn't update this holding right now."
        }
    }
}
