//
//  GradeLadderSection.swift
//  HobbyIQ
//
//  "Same card in other grades" section on Card Detail — empirical
//  PSA/BGS/SGC/CGC ratios from the canonical-FMV response's
//  `gradeLadder` field. Backend owns the numbers; iOS never derives
//  ratios locally.
//

import SwiftUI

/// Signals a temporarily-selected ladder tier back to the parent so
/// the parent can swap its FMV headline. Passing nil clears the swap.
typealias GradeLadderSelectionHandler = (GradeLadderTier?) -> Void

struct GradeLadderSection: View {
    let ladder: GradeLadder
    /// Grader key that the user's holding is currently scoped to.
    /// Matched (case-insensitively) against `tier.grader` to draw
    /// the accent ring on the "you hold this" cell.
    let currentGraderLabel: String
    /// Grader key of the tier the parent has currently "what-if"-swapped
    /// the headline to. Nil = no swap active.
    let selectedGraderLabel: String?
    let onSelectTier: GradeLadderSelectionHandler

    private let columns: [GridItem] = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10)
    ]

    var body: some View {
        if let tiers = ladder.tiers, tiers.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                Text("Same card in other grades")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("Empirical PSA/BGS/SGC/CGC ratios from CardHedge's last 365 days.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(tiers) { tier in
                        tierCell(tier)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        } else {
            EmptyView()
        }
    }

    private func tierCell(_ tier: GradeLadderTier) -> some View {
        let isCurrent = tier.grader.caseInsensitiveCompare(currentGraderLabel) == .orderedSame
        let isSelected = selectedGraderLabel.map { tier.grader.caseInsensitiveCompare($0) == .orderedSame } ?? false
        return Button {
            // Tap the current tier when it's the active swap = revert.
            if isSelected {
                onSelectTier(nil)
            } else {
                onSelectTier(tier)
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(tier.grader)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer(minLength: 0)
                    if isCurrent {
                        Text("YOU HOLD")
                            .font(.system(size: 8, weight: .bold))
                            .tracking(0.5)
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                }
                Text(fmvString(for: tier))
                    .font(.system(size: 18, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let ratio = tier.medianRatio, ratio > 0 {
                    Text(String(format: "\u{00D7}%.2f", ratio))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.slateGray.opacity(isSelected ? 0.55 : 0.3))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(cellStroke(isCurrent: isCurrent, isSelected: isSelected), lineWidth: isCurrent || isSelected ? 1.4 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func cellStroke(isCurrent: Bool, isSelected: Bool) -> Color {
        if isSelected { return HobbyIQTheme.Colors.electricBlue }
        if isCurrent  { return HobbyIQTheme.Colors.electricBlue.opacity(0.55) }
        return Color.white.opacity(0.06)
    }

    private func fmvString(for tier: GradeLadderTier) -> String {
        guard let fmv = tier.fmv, fmv > 0 else { return "\u{2014}" }
        return fmv.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }
}
