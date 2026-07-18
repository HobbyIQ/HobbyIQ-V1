//
//  CanonicalFmvSheet.swift
//  HobbyIQ
//
//  "Why this price?" transparency sheet (2026-07-18 canonical-FMV
//  migration). Renders the top 2-3 anchor comps + summary + trend so
//  users can see the raw material behind the MARKET VALUE headline.
//
//  Presented from PortfolioHoldingHeroCard when the user taps the
//  MARKET VALUE headline.
//

import SwiftUI

struct CanonicalFmvSheet: View {
    let response: CanonicalFmvResponse
    let cardTitle: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        headlineBlock
                        if let summary = response.provenance?.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
                           summary.isEmpty == false {
                            summaryLine(summary)
                        }
                        if let comps = response.provenance?.comps, comps.isEmpty == false {
                            anchorCompsBlock(comps: Array(comps.prefix(3)))
                        }
                        if let trend = response.provenance?.trendPctPerMonth {
                            trendBlock(trend: trend)
                        }
                        methodChip
                    }
                    .padding(HobbyIQTheme.Spacing.screenPadding)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Why this price?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: - Blocks

    private var headlineBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("MARKET VALUE")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(headlineValue)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                confidenceChip
            }
            if let title = cardTitle, title.isEmpty == false {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(2)
            }
        }
    }

    private var headlineValue: String {
        guard let fmv = response.fmv, fmv > 0 else { return "\u{2014}" }
        return fmv.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }

    @ViewBuilder
    private var confidenceChip: some View {
        if let confidence = response.confidence {
            let pct = Int((confidence * 100).rounded())
            Text("\(pct)% confidence")
                .font(.caption2.weight(.bold))
                .foregroundStyle(confidenceColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(confidenceColor.opacity(0.16))
                .clipShape(Capsule(style: .continuous))
        }
    }

    private var confidenceColor: Color {
        let c = response.confidence ?? 0
        if c >= 0.6 { return HobbyIQTheme.Colors.successGreen }
        if c >= 0.4 { return HobbyIQTheme.Colors.electricBlue }
        return HobbyIQTheme.Colors.warning
    }

    private func summaryLine(_ summary: String) -> some View {
        Text(summary)
            .font(.subheadline)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .fixedSize(horizontal: false, vertical: true)
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func anchorCompsBlock(comps: [CanonicalFmvComp]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ANCHOR COMPS")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            VStack(spacing: 8) {
                ForEach(comps) { comp in
                    compRow(comp)
                }
            }
        }
    }

    private func compRow(_ comp: CanonicalFmvComp) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(comp.price.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0))))
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer(minLength: 0)
                Text(relativeDate(from: comp.soldAt))
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            HStack(spacing: 6) {
                if let source = comp.source, source.isEmpty == false {
                    sourceBadge(source)
                }
                if comp.verifiedByUser == true {
                    Text("verified")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(HobbyIQTheme.Colors.successGreen.opacity(0.14))
                        .clipShape(Capsule(style: .continuous))
                }
                if let parallel = comp.parallel, parallel.isEmpty == false {
                    Text(parallel)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func sourceBadge(_ source: String) -> some View {
        Text(sourceLabel(source))
            .font(.caption2.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
            .clipShape(Capsule(style: .continuous))
    }

    private func sourceLabel(_ raw: String) -> String {
        switch raw {
        case "ebay-user-purchase":  return "eBay purchase"
        case "ebay-browse-ended":   return "eBay listing"
        case "manual-user-entry":   return "Manual"
        case "cardhedge":           return "CardHedge"
        default:
            return raw
                .split(separator: "-")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    private func trendBlock(trend: Double) -> some View {
        let signPrefix = trend >= 0 ? "+" : "\u{2212}"
        let absStr = String(format: "%.1f", abs(trend))
        return HStack(spacing: 8) {
            Image(systemName: trend >= 0 ? "chart.line.uptrend.xyaxis" : "chart.line.downtrend.xyaxis")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(trend >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            VStack(alignment: .leading, spacing: 2) {
                Text("TREND APPLIED")
                    .font(.caption2.weight(.bold))
                    .tracking(0.5)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("\(signPrefix)\(absStr)% per month")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    @ViewBuilder
    private var methodChip: some View {
        HStack(alignment: .firstTextBaseline) {
            if let method = response.methodEnum, let label = methodLabel(method) {
                Text("Basis: \(label)")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
            if let stalenessLabel {
                Text(stalenessLabel)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.75))
            }
        }
    }

    /// "updated Xs/min/h ago" caption when the response is older than a
    /// minute, otherwise nil. Backend caches for 15 min so a >15 min
    /// staleness is a hint that pull-to-refresh would kick a fresh
    /// compute. Never rendered when the timestamp doesn't parse.
    private var stalenessLabel: String? {
        guard let iso = response.computedAt else { return nil }
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = isoFormatter.date(from: iso)
        if date == nil {
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            date = fallback.date(from: iso)
        }
        guard let date, Date().timeIntervalSince(date) >= 60 else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "updated " + formatter.localizedString(for: date, relativeTo: Date())
    }

    /// User-facing labels for the method enum — never surface the raw
    /// slug names ("direct-comp") to end users.
    private func methodLabel(_ method: CanonicalFmvMethod) -> String? {
        switch method {
        case .directComp:       return "recent sales for this exact card"
        case .crossParallel:    return "normalized from sibling parallels"
        case .neighborParallel: return "priced against a sibling card in the set"
        case .familyBaseline:   return "modeled from the product family"
        case .productTier:      return "category-level estimate"
        case .noBasis:          return nil
        }
    }

    private func relativeDate(from iso: String) -> String {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = isoFormatter.date(from: iso)
        if date == nil {
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            date = fallback.date(from: iso)
        }
        guard let date else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
