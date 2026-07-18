//
//  OutcomeAttributionViews.swift
//  HobbyIQ
//
//  Two surfaces:
//   1. SaleOutcomeBadge — rendered on LedgerEntryDetailSheet when the
//      sale has a verdict in the last 60 days. Suppresses for
//      no_verdict outcomeClass.
//   2. EngineHitRatePill — counter under the total portfolio value on
//      Portfolio landing. Hidden until >= 5 verdicts logged.
//

import SwiftUI

// MARK: - Sale outcome badge

struct SaleOutcomeBadge: View {
    let soldEntryId: String

    @State private var outcome: SaleOutcomeResponse?
    @State private var loaded = false

    var body: some View {
        Group {
            if let outcome, let outcomeClass = outcome.outcomeClass, outcomeClass != .noVerdict {
                badge(for: outcome, outcomeClass: outcomeClass)
            } else {
                EmptyView()
            }
        }
        .task(id: soldEntryId) {
            guard loaded == false else { return }
            await load()
            loaded = true
        }
    }

    @ViewBuilder
    private func badge(for outcome: SaleOutcomeResponse, outcomeClass: SaleOutcomeClass) -> some View {
        let (glyph, color) = display(for: outcomeClass)
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: glyph)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(color)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(headline(for: outcomeClass, outcome: outcome))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
                if let subline = subline(for: outcomeClass, outcome: outcome) {
                    Text(subline)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(color.opacity(0.35), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func display(for outcomeClass: SaleOutcomeClass) -> (String, Color) {
        switch outcomeClass {
        case .verdictHit:  return ("checkmark.seal.fill", HobbyIQTheme.Colors.successGreen)
        case .verdictMiss: return ("chart.line.downtrend.xyaxis", HobbyIQTheme.Colors.mutedText)
        case .holdSold:    return ("info.circle", HobbyIQTheme.Colors.mutedText)
        case .noVerdict:   return ("questionmark.circle", HobbyIQTheme.Colors.mutedText)
        }
    }

    private func headline(for outcomeClass: SaleOutcomeClass, outcome: SaleOutcomeResponse) -> String {
        let verdict = outcome.verdictAtSaleTime ?? "verdict"
        let days = outcome.daysSinceVerdict.map { "\($0) day\($0 == 1 ? "" : "s")" } ?? "recent"
        switch outcomeClass {
        case .verdictHit:
            return "Called it \u{2014} \(verdict) verdict from \(days) ago hit within tolerance"
        case .verdictMiss:
            return "Sold below target"
        case .holdSold:
            return "Engine said HOLD; you saw something we didn't"
        case .noVerdict:
            return ""
        }
    }

    private func subline(for outcomeClass: SaleOutcomeClass, outcome: SaleOutcomeResponse) -> String? {
        switch outcomeClass {
        case .verdictMiss:
            guard let target = outcome.priceTargetAtSnapshot, target > 0 else { return nil }
            let targetStr = target.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
            if let actual = outcome.actualSalePrice, actual > 0 {
                let actualStr = actual.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
                return "Engine said \(targetStr), actual \(actualStr)"
            }
            return "Engine target: \(targetStr)"
        default:
            return nil
        }
    }

    private func load() async {
        do {
            outcome = try await APIService.shared.fetchSaleOutcome(soldEntryId: soldEntryId)
        } catch {
            outcome = nil
        }
    }
}

// MARK: - Engine hit rate pill (Portfolio landing)

struct EngineHitRatePill: View {
    @State private var summary: OutcomesSummaryResponse?
    @State private var loaded = false

    var body: some View {
        Group {
            if let summary, let total = summary.totalVerdicts, total >= 5, let top = topRollup(from: summary) {
                pill(summary: summary, rollup: top)
            } else {
                EmptyView()
            }
        }
        .task {
            guard loaded == false else { return }
            await load()
            loaded = true
        }
    }

    private func pill(summary: OutcomesSummaryResponse, rollup: OutcomeVerdictRollup) -> some View {
        let window = summary.windowDays ?? 30
        let calls = rollup.calls ?? 0
        let hits = rollup.hits ?? 0
        let hitRate = rollup.hitRate.map { Int(($0 * 100).rounded()) } ?? 0
        let verdictLabel = displayLabel(rollup.verdict)
        return VStack(alignment: .leading, spacing: 2) {
            Text("Engine hit rate \u{00B7} Last \(window) days")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.4)
            Text("\(calls) \(verdictLabel) call\(calls == 1 ? "" : "s") \u{2192} \(hits) hits (\(hitRate)%)")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.32), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    /// Highest-volume verdict rollup, preferring the SELL_NOW class when
    /// call counts are close (its hit rate is the most user-visible one).
    private func topRollup(from summary: OutcomesSummaryResponse) -> OutcomeVerdictRollup? {
        guard let all = summary.perVerdictHitRate, all.isEmpty == false else { return nil }
        if let sellNow = all.first(where: { $0.verdict == "SELL_NOW" }),
           (sellNow.calls ?? 0) >= 3 {
            return sellNow
        }
        return all.max(by: { ($0.calls ?? 0) < ($1.calls ?? 0) })
    }

    private func displayLabel(_ raw: String?) -> String {
        switch raw {
        case "SELL_NOW":    return "SELL NOW"
        case "GRADE_UP":    return "GRADE UP"
        case "LIST_HIGHER": return "LIST HIGHER"
        case "WAIT_TO_LIST": return "WAIT"
        case "HOLD":        return "HOLD"
        default:            return "verdict"
        }
    }

    private func load() async {
        do {
            summary = try await APIService.shared.fetchOutcomesSummary()
        } catch {
            summary = nil
        }
    }
}
