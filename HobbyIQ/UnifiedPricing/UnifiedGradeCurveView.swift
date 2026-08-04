//
//  UnifiedGradeCurveView.swift
//  HobbyIQ
//
//  CF-UNIFIED-PRICING-IOS-REBUILD Session 2 (Drew, 2026-08-04).
//
//  iOS Grade Curve view — per-grade market value + prediction + sparkline
//  behind a tap-to-expand disclosure. Compact by default, sparkline
//  reveals on tap.
//
//  Cross-platform reference: web at
//    apps/web/src/components/GradeCurveView.tsx
//  Same information, different density: web renders every row expanded
//  (desktop real estate), iOS defaults collapsed with disclosure.
//
//  Blueprint: backend/docs/ios-unified-rebuild-blueprint.md — see
//  "Grade-Curve row layout — iOS (compact + tap-to-expand)".
//

import SwiftUI

struct UnifiedGradeCurveView: View {
    let entries: [UnifiedGradeEntry]
    /// Optional per-grade sales-history points that back the sparkline.
    /// Keyed by grade label (e.g. "PSA 9"). Falls back to a synthetic
    /// two-point line from p10/p90 when no series exists.
    let salesHistoryByGrade: [String: [Double]]

    @State private var expandedGrades: Set<String> = []

    init(entries: [UnifiedGradeEntry], salesHistoryByGrade: [String: [Double]] = [:]) {
        self.entries = entries
        self.salesHistoryByGrade = salesHistoryByGrade
    }

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
            headerBlock

            VStack(spacing: HobbyIQTheme.Spacing.small) {
                ForEach(entries) { entry in
                    UnifiedGradeCurveRow(
                        entry: entry,
                        salesHistory: salesHistoryByGrade[entry.grade] ?? [],
                        isExpanded: expandedGrades.contains(entry.grade),
                        onToggle: { toggle(entry.grade) }
                    )
                }
            }
        }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Grade curve")
                .font(HobbyIQTheme.Typography.sectionTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("HobbyIQ's own — one number and one prediction per grade, computed from real sales.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            let totalSales = entries.reduce(0) { $0 + $1.sampleCount }
            if totalSales > 0 {
                Text("\(totalSales) total sales across grades")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, 2)
            }
        }
    }

    private func toggle(_ grade: String) {
        if expandedGrades.contains(grade) {
            expandedGrades.remove(grade)
        } else {
            expandedGrades.insert(grade)
        }
    }
}

// MARK: - Row

private struct UnifiedGradeCurveRow: View {
    let entry: UnifiedGradeEntry
    let salesHistory: [Double]
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Tappable header
            Button(action: onToggle) {
                headerContent
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Divider()
                    .background(HobbyIQTheme.Colors.border)
                    .padding(.horizontal, HobbyIQTheme.Spacing.medium)

                expandedContent
                    .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                    .padding(.top, HobbyIQTheme.Spacing.small)
            }

            Divider()
                .background(HobbyIQTheme.Colors.border)
                .padding(.horizontal, HobbyIQTheme.Spacing.medium)

            confidenceBar
                .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                .padding(.top, HobbyIQTheme.Spacing.small)
                .padding(.bottom, HobbyIQTheme.Spacing.small)
        }
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.4)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Header (collapsed content — always shown)

    private var headerContent: some View {
        HStack(alignment: .top, spacing: HobbyIQTheme.Spacing.medium) {
            gradeLabelColumn
            Spacer(minLength: 0)
            marketValueColumn
            Spacer(minLength: HobbyIQTheme.Spacing.small)
            predictedColumn
            chevron
        }
        .padding(HobbyIQTheme.Spacing.medium)
    }

    private var gradeLabelColumn: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.grade)
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("n=\(entry.sampleCount)")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            sourceBadge
        }
        .frame(width: 78, alignment: .leading)
    }

    private var marketValueColumn: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("MARKET")
                .font(.caption2.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let mv = entry.marketValue, mv > 0 {
                Text(wholeUSDString(mv))
                    .font(HobbyIQTheme.Typography.statSubtle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            } else {
                Text("—")
                    .font(HobbyIQTheme.Typography.statSubtle)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if let pct = entry.trendPctPerWeek, abs(pct) >= 0.5 {
                let dir = UnifiedTrendDirection(rawValue: entry.trendDirection)
                let color: Color = dir == .up
                    ? HobbyIQTheme.Colors.hobbyGreen
                    : dir == .down
                        ? HobbyIQTheme.Colors.danger
                        : HobbyIQTheme.Colors.mutedText
                let displayArrow = dir.arrow
                let magnitude = String(format: "%.1f%%", abs(pct))
                Text(displayArrow.isEmpty ? magnitude : "\(displayArrow) \(magnitude)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(color)
            }
        }
    }

    private var predictedColumn: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("PRED (7D)")
                .font(.caption2.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if entry.hasTrendSignal, let pp = entry.predictedPrice, pp > 0 {
                let deltaColor: Color = {
                    if let mv = entry.marketValue, mv > 0 {
                        let d = ((pp - mv) / mv) * 100
                        if d > 0.5 { return HobbyIQTheme.Colors.hobbyGreen }
                        if d < -0.5 { return HobbyIQTheme.Colors.danger }
                    }
                    return HobbyIQTheme.Colors.mutedText
                }()
                Text(wholeUSDString(pp))
                    .font(HobbyIQTheme.Typography.statSubtle)
                    .foregroundStyle(deltaColor)
                if let mv = entry.marketValue, mv > 0 {
                    let delta = ((pp - mv) / mv) * 100
                    Text(String(format: "%+.1f%%", delta))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(deltaColor)
                }
            } else {
                Text("—")
                    .font(HobbyIQTheme.Typography.statSubtle)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    private var chevron: some View {
        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .padding(.top, 6)
    }

    private var sourceBadge: some View {
        let label = entry.isObserved ? "OBSERVED" : "ESTIMATED"
        let color = entry.isObserved
            ? HobbyIQTheme.Colors.hobbyGreen
            : HobbyIQTheme.Colors.electricBlue
        return Text(label)
            .font(.system(size: 9, weight: .bold))
            .tracking(0.4)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    // MARK: Expanded content — sparkline + ranges

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            UnifiedSparkline(
                points: sparklinePoints,
                color: sparklineColor,
                height: 44
            )

            VStack(alignment: .leading, spacing: 4) {
                if let p10 = entry.p10, let p90 = entry.p90, p10 > 0, p90 > 0 {
                    HStack(spacing: 6) {
                        Text("MARKET RANGE")
                            .font(.caption2.weight(.semibold))
                            .tracking(0.6)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text("p10 \(wholeUSDString(p10)) · p90 \(wholeUSDString(p90))")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let newest = entry.newestSaleDate,
                   let iso = ISO8601DateFormatter().date(from: newest) {
                    let days = Int(Date().timeIntervalSince(iso) / 86400)
                    Text("Newest sale: \(days)d ago")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .padding(.bottom, HobbyIQTheme.Spacing.small)
    }

    private var sparklinePoints: [Double] {
        if !salesHistory.isEmpty { return salesHistory }
        // Synthetic two-point line from p10/p90 when no history was supplied
        if let low = entry.p10, let high = entry.p90 {
            return [low, high]
        }
        return []
    }

    private var sparklineColor: Color {
        let dir = UnifiedTrendDirection(rawValue: entry.trendDirection)
        switch dir {
        case .up: return HobbyIQTheme.Colors.hobbyGreen
        case .down: return HobbyIQTheme.Colors.danger
        case .flat: return HobbyIQTheme.Colors.electricBlue
        }
    }

    // MARK: Confidence bar (always visible)

    private var confidenceBar: some View {
        let confidence = max(0, min(1, entry.confidence))
        let pct = Int((confidence * 100).rounded())
        let barColor: Color = {
            if confidence >= 0.7 { return HobbyIQTheme.Colors.hobbyGreen }
            if confidence >= 0.4 { return HobbyIQTheme.Colors.electricBlue }
            return HobbyIQTheme.Colors.warning
        }()
        return HStack(spacing: 8) {
            Text("Confidence")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .frame(width: 68, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(barColor)
                        .frame(width: geo.size.width * CGFloat(confidence))
                }
            }
            .frame(height: 4)

            Text("\(pct)%")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .frame(width: 34, alignment: .trailing)
        }
    }
}

// MARK: - Preview

#Preview("Ohtani-style curve") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        ScrollView {
            UnifiedGradeCurveView(
                entries: sampleOhtaniCurve,
                salesHistoryByGrade: sampleSalesHistory
            )
            .padding()
        }
    }
}

// MARK: - Preview sample data

private let sampleOhtaniCurve: [UnifiedGradeEntry] = [
    UnifiedGradeEntry(
        grade: "Raw",
        gradeCompany: nil,
        gradeValue: nil,
        weightedMedian: 2326,
        plainMedian: 2300,
        sampleCount: 52,
        p10: 1750,
        p90: 3101,
        newestSaleDate: "2026-08-01T14:00:00Z",
        valueSource: "observed",
        confidence: 1.0,
        marketValue: 2400,
        predictedPrice: 2555,
        trendPctPerWeek: 6.5,
        trendDirection: "up"
    ),
    UnifiedGradeEntry(
        grade: "PSA 10",
        gradeCompany: "PSA",
        gradeValue: 10,
        weightedMedian: 7100,
        plainMedian: 7000,
        sampleCount: 52,
        p10: 5300,
        p90: 7500,
        newestSaleDate: "2026-08-02T10:00:00Z",
        valueSource: "observed",
        confidence: 1.0,
        marketValue: 7100,
        predictedPrice: 6759,
        trendPctPerWeek: -4.8,
        trendDirection: "down"
    ),
    UnifiedGradeEntry(
        grade: "PSA 9",
        gradeCompany: "PSA",
        gradeValue: 9,
        weightedMedian: 2326,
        plainMedian: 2199,
        sampleCount: 74,
        p10: 1725,
        p90: 2500,
        newestSaleDate: "2026-08-04T09:00:00Z",
        valueSource: "observed",
        confidence: 1.0,
        marketValue: 2596,
        predictedPrice: 2743,
        trendPctPerWeek: 5.8,
        trendDirection: "up"
    ),
    UnifiedGradeEntry(
        grade: "PSA 8",
        gradeCompany: "PSA",
        gradeValue: 8,
        weightedMedian: 1673,
        plainMedian: 1500,
        sampleCount: 52,
        p10: 375,
        p90: 1575,
        newestSaleDate: "2026-08-01T00:00:00Z",
        valueSource: "observed",
        confidence: 0.85,
        marketValue: 1673,
        predictedPrice: 1840,
        trendPctPerWeek: 10.0,
        trendDirection: "up"
    ),
]

private let sampleSalesHistory: [String: [Double]] = [
    "Raw": [2100, 2200, 2199, 2299, 2350, 2400, 2500, 2596, 2700],
    "PSA 10": [7500, 7300, 7200, 7150, 7100, 7050, 6900, 6800, 6759],
    "PSA 9": [2100, 2199, 2201, 2199, 2299, 2350, 2400, 2500, 2596, 2700],
    "PSA 8": [900, 1000, 1200, 1400, 1500, 1600, 1673, 1750, 1840],
]
