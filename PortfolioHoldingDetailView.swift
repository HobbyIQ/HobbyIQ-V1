import SwiftUI

struct PortfolioHoldingDetailView: View {
    @Binding var holding: PortfolioHolding
    var onEdit: (() -> Void)? = nil
    var onRefresh: (() -> Void)? = nil
    var onSell: (() -> Void)? = nil
    var onDelete: (() -> Void)? = nil
    @Environment(\.dismiss) var dismiss

    @State private var gradedEstimate: CardEstimateResponse? = nil
    @State private var isLoadingGraded = false
    @State private var gradedError: String? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HoldingDetailHeader(holding: holding, onEdit: onEdit, onRefresh: onRefresh)
                PositionSummarySection(holding: holding)
                ProfitViewSection(holding: holding)
                RecommendationSection(holding: holding)
                MarketActivitySection(holding: holding)
                ExitPlanSection(holding: holding)
                WhyThisMattersSection(holding: holding)
                // What if graded?
                let isRaw = holding.gradingCompany.lowercased() == "raw" || holding.gradingCompany.trimmingCharacters(in: .whitespaces).isEmpty
                if isRaw {
                    WhatIfGradedSection(
                        holding: holding,
                        estimate: gradedEstimate,
                        isLoading: isLoadingGraded,
                        error: gradedError,
                        onEstimate: { await runGradedEstimate() }
                    )
                }
                if let notes = holding.notes, !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader(title: "Notes")
                        Text(notes)
                            .font(.subheadline)
                            .foregroundColor(Color(.systemGray2))
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.secondarySystemBackground).opacity(0.65))
                            .cornerRadius(14)
                    }
                }
                Spacer(minLength: 20)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(holding.playerName)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Done") { dismiss() }
            }
            ToolbarItemGroup(placement: .navigationBarLeading) {
                if let onSell {
                    Button("Sell") {
                        onSell()
                        dismiss()
                    }
                }
                if let onDelete {
                    Button("Delete", role: .destructive) {
                        onDelete()
                        dismiss()
                    }
                }
            }
        }
    }

    private func runGradedEstimate() async {
        isLoadingGraded = true
        gradedError = nil
        gradedEstimate = nil
        do {
            let req = CardEstimateRequest(
                playerName: holding.playerName,
                cardYear: holding.cardYear > 0 ? holding.cardYear : nil,
                product: holding.product.isEmpty ? nil : holding.product,
                parallel: holding.parallel.flatMap { $0.isEmpty ? nil : $0 },
                isAuto: holding.isAuto ? true : nil,
                gradeCompany: "PSA",
                gradeValue: 10
            )
            gradedEstimate = try await APIService.shared.estimateCardDirect(request: req)
        } catch {
            gradedError = "Could not fetch estimate."
        }
        isLoadingGraded = false
    }
}

// MARK: - Detail Header
struct HoldingDetailHeader: View {
    let holding: PortfolioHolding
    var onEdit: (() -> Void)? = nil
    var onRefresh: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Title row + action buttons
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(holding.cardTitle)
                        .font(.title3.weight(.bold))
                        .foregroundColor(.white)
                    Text("\(holding.cardYear) \(holding.brand)")
                        .font(.subheadline)
                        .foregroundColor(Color(.systemGray2))
                }
                Spacer()
                HStack(spacing: 14) {
                    Button(action: { onRefresh?() }) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(.blue)
                    }
                    Button(action: { onEdit?() }) {
                        Image(systemName: "pencil")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(.blue)
                    }
                }
            }

            // Value row
            HStack(alignment: .lastTextBaseline, spacing: 6) {
                Text("$\(holding.currentValue, specifier: "%.0f")")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundColor(.green)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(holding.totalProfitLoss >= 0 ? "+" : "")$\(holding.totalProfitLoss, specifier: "%.0f")")
                        .font(.headline)
                        .foregroundColor(holding.totalProfitLoss >= 0 ? .green : .red)
                    Text("\(holding.totalProfitLossPct, specifier: "%.1f")% ROI")
                        .font(.caption)
                        .foregroundColor(Color(.systemGray2))
                }
            }

            // Badges row
            HStack(spacing: 8) {
                StatusPill(text: holding.recommendation, color: .blue)
                if let trend = trendIcon(for: holding.trend) {
                    Label(trend.label, systemImage: trend.icon)
                        .font(.caption2)
                        .foregroundColor(trend.color)
                }
                FreshnessBadge(status: holding.freshnessStatus, lastUpdated: holding.lastUpdated)
                Spacer()
            }

            // Comp pool count
            if let comps = holding.compsUsed, comps > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "chart.bar.doc.horizontal")
                        .font(.caption2)
                        .foregroundColor(.blue)
                    Text("Based on \(comps) comp\(comps == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundColor(Color(.systemGray2))
                }
            }

            // Parallel detection warning
            if let detected = holding.parallelDetected,
               !detected.isEmpty,
               let userParallel = holding.parallel,
               detected.lowercased() != userParallel.lowercased() {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundColor(.yellow)
                    Text("Priced as \(detected) — your "\(userParallel)" wasn't found in comps")
                        .font(.caption)
                        .foregroundColor(.yellow)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.yellow.opacity(0.08))
                .cornerRadius(8)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground).opacity(0.65))
        .cornerRadius(16)
    }

    func trendIcon(for trend: PortfolioTrend) -> (icon: String, label: String, color: Color)? {
        switch trend {
        case .rising: return ("arrow.up.right", "Rising", .green)
        case .stable: return ("arrow.right", "Stable", .gray)
        case .falling: return ("arrow.down.right", "Falling", .red)
        }
    }
}

// MARK: - Section Headers
struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundColor(Color(.systemGray2))
            .tracking(1)
            .padding(.top, 4)
    }
}

// MARK: - Card Container helper
private struct DetailCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground).opacity(0.65))
            .cornerRadius(14)
    }
}

// MARK: - Row helper
private struct InfoRow: View {
    let label: String
    let value: String
    var valueColor: Color = Color(.systemGray)
    var body: some View {
        HStack {
            Text(label)
                .foregroundColor(Color(.systemGray2))
            Spacer()
            Text(value)
                .foregroundColor(valueColor)
        }
        .font(.subheadline)
    }
}

// MARK: - Position Summary
struct PositionSummarySection: View {
    let holding: PortfolioHolding
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Position Summary")
            DetailCard {
                VStack(spacing: 10) {
                    InfoRow(label: "Quantity", value: "\(holding.quantity)")
                    InfoRow(label: "Avg Buy Price", value: "$\(holding.purchasePrice, specifier: "%.2f")")
                    InfoRow(label: "Total Cost Basis", value: "$\(holding.totalCostBasis, specifier: "%.0f")")
                    InfoRow(label: "Est. Current Value", value: "$\(holding.currentValue, specifier: "%.0f")", valueColor: .green)
                    InfoRow(label: "Est. Net After Fees", value: "$\(holding.netEstimatedValue ?? holding.currentValue, specifier: "%.0f")")
                }
            }
        }
    }
}

// MARK: - Profit View
struct ProfitViewSection: View {
    let holding: PortfolioHolding
    var body: some View {
        let pl = holding.totalProfitLoss
        let net = holding.netEstimatedValue ?? pl
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Profit View")
            DetailCard {
                VStack(spacing: 10) {
                    InfoRow(label: "Gross Gain/Loss", value: "\(pl >= 0 ? "+" : "")$\(pl, specifier: "%.0f")", valueColor: pl >= 0 ? .green : .red)
                    InfoRow(label: "Net Gain/Loss", value: "\(net >= 0 ? "+" : "")$\(net, specifier: "%.0f")", valueColor: net >= 0 ? .green : .red)
                    InfoRow(label: "ROI", value: "\(holding.totalProfitLossPct, specifier: "%.1f")%", valueColor: pl >= 0 ? .green : .red)
                }
            }
        }
    }
}

// MARK: - Recommendation
struct RecommendationSection: View {
    let holding: PortfolioHolding
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Recommendation")
            DetailCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        Text(holding.recommendation)
                            .font(.headline)
                            .foregroundColor(.blue)
                        Spacer()
                        // Urgency badge
                        VStack(spacing: 1) {
                            Text("\(holding.sellUrgency)")
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundColor(holding.sellUrgencyColor)
                            Text(holding.sellUrgencyLabel)
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundColor(holding.sellUrgencyColor.opacity(0.8))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(holding.sellUrgencyColor.opacity(0.12))
                        .cornerRadius(8)
                    }
                    if !holding.verdict.isEmpty {
                        Text(holding.verdict)
                            .font(.subheadline)
                            .foregroundColor(Color(.systemGray2))
                    }
                    // Confidence meter (rSquared 0.0–1.0)
                    if let conf = holding.confidence, conf > 0 {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text("Model Confidence")
                                    .font(.caption)
                                    .foregroundColor(Color(.systemGray2))
                                Spacer()
                                Text("\(Int(conf * 100))%")
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(conf >= 0.75 ? .green : conf >= 0.5 ? .yellow : .orange)
                            }
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(Color(.systemGray5)).frame(height: 6)
                                    Capsule()
                                        .fill(conf >= 0.75 ? Color.green : conf >= 0.5 ? Color.yellow : Color.orange)
                                        .frame(width: geo.size.width * min(conf, 1.0), height: 6)
                                }
                            }
                            .frame(height: 6)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Market Activity
struct MarketActivitySection: View {
    let holding: PortfolioHolding
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Market Activity")
            DetailCard {
                VStack(spacing: 10) {
                    InfoRow(label: "Market Speed", value: holding.marketSpeed)
                    InfoRow(label: "Market Pressure", value: holding.marketPressure)
                    InfoRow(label: "Trend", value: holding.trend.rawValue.capitalized,
                            valueColor: holding.trend == .rising ? .green : holding.trend == .falling ? .red : Color(.systemGray))
                    InfoRow(label: "Risk Level", value: holding.riskLevel.rawValue.capitalized,
                            valueColor: holding.riskLevel == .high ? .red : Color(.systemGray))
                    if let days = holding.expectedDaysToSell {
                        InfoRow(label: "Expected Days to Sell", value: "~\(days) days",
                                valueColor: days <= 7 ? .red : days <= 21 ? .orange : Color(.systemGray))
                    }
                }
            }
        }
    }
}

// MARK: - Exit Plan
struct ExitPlanSection: View {
    let holding: PortfolioHolding
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Exit Plan")
            DetailCard {
                VStack(alignment: .leading, spacing: 10) {
                    InfoRow(label: "Best Way to Sell", value: "Auction / BIN")
                    if let days = holding.expectedDaysToSell {
                        InfoRow(label: "Time to Sell", value: "~\(days) days")
                    }
                    InfoRow(label: "Timing",
                            value: holding.trend == .rising ? "Market is strong — hold or sell high" :
                                   holding.trend == .falling ? "Consider selling soon" : "Market is stable")
                }
            }
        }
    }
}

// MARK: - Why This Matters
struct WhyThisMattersSection: View {
    let holding: PortfolioHolding
    var body: some View {
        if !holding.explanationBullets.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Why This Matters")
                DetailCard {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(holding.explanationBullets, id: \.self) { bullet in
                            HStack(alignment: .top, spacing: 8) {
                                Circle()
                                    .fill(Color.blue)
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 6)
                                Text(bullet)
                                    .font(.subheadline)
                                    .foregroundColor(Color(.systemGray2))
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - What If Graded?
struct WhatIfGradedSection: View {
    let holding: PortfolioHolding
    let estimate: CardEstimateResponse?
    let isLoading: Bool
    let error: String?
    let onEstimate: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "What if Graded PSA 10?")
            DetailCard {
                if let est = estimate, let fmv = est.fairMarketValue {
                    let delta = fmv - holding.currentValue
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("PSA 10 Est. FMV")
                                .font(.caption)
                                .foregroundColor(Color(.systemGray2))
                            Text("$\(fmv, specifier: "%.0f")")
                                .font(.title3.weight(.bold))
                                .foregroundColor(.green)
                            if let rec = est.recommendation {
                                Text(rec)
                                    .font(.caption2)
                                    .foregroundColor(Color(.systemGray2))
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text("vs Raw")
                                .font(.caption)
                                .foregroundColor(Color(.systemGray2))
                            Text("\(delta >= 0 ? "+" : "")$\(delta, specifier: "%.0f")")
                                .font(.title3.weight(.bold))
                                .foregroundColor(delta >= 0 ? .green : .red)
                        }
                    }
                } else if isLoading {
                    HStack(spacing: 10) {
                        ProgressView().tint(.blue)
                        Text("Fetching PSA 10 estimate…")
                            .font(.subheadline)
                            .foregroundColor(Color(.systemGray2))
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("See how much your raw card could be worth graded PSA 10.")
                            .font(.caption)
                            .foregroundColor(Color(.systemGray2))
                        Button(action: { Task { await onEstimate() } }) {
                            Label("Estimate PSA 10 Value", systemImage: "sparkle.magnifyingglass")
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(.white)
                                .padding(.vertical, 9)
                                .frame(maxWidth: .infinity)
                                .background(Color.blue)
                                .cornerRadius(10)
                        }
                        if let err = error {
                            Text(err).font(.caption).foregroundColor(.red)
                        }
                    }
                }
            }
        }
    }
}

struct PortfolioHoldingDetailView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioHoldingDetailView(holding: .constant(PortfolioHolding.mockHoldings[0]))
            .preferredColorScheme(.dark)
    }
}
