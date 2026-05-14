import SwiftUI

struct PortfolioHoldingDetailView: View {
    @Binding var holding: PortfolioHolding
    var onEdit: (() -> Void)? = nil
    var onRefresh: (() -> Void)? = nil
    var onSell: (() -> Void)? = nil
    var onDelete: (() -> Void)? = nil
    @Environment(\.dismiss) var dismiss
    @EnvironmentObject private var router: AppRouter

    @State private var gradedEstimate: CardEstimateResponse? = nil
    @State private var isLoadingGraded = false
    @State private var gradedError: String? = nil

    // Grade premium state
    @State private var gradePremium: CompIQGradePremiumResponse? = nil
    @State private var gradePremiumLoading = false
    @State private var gradePremiumError: String? = nil

    // Sell window state
    @State private var sellWindow: CompIQSellWindowResponse? = nil
    @State private var sellWindowLoading = false
    @State private var sellWindowError: String? = nil

    // eBay listing state
    @State private var showEbayDraft = false
    @StateObject private var ebayStore = EbayAccountStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HoldingDetailHeader(holding: holding, onEdit: onEdit, onRefresh: onRefresh)
                priceThisNowBar
                listOnEbayBar
                PositionSummarySection(holding: holding)
                ProfitViewSection(holding: holding)
                RecommendationSection(holding: holding)
                MarketActivitySection(holding: holding)
                ExitPlanSection(holding: holding)
                WhyThisMattersSection(holding: holding)
                // Sell window
                sellWindowSection
                // What if graded?
                let isRaw = holding.gradingCompany.lowercased() == "raw" || holding.gradingCompany.trimmingCharacters(in: .whitespaces).isEmpty
                if isRaw {
                    gradePremiumSection
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
                if let forecast = holding.forecast {
                    ForecastSection(forecast: forecast)
                }
                Spacer(minLength: 20)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(holding.playerName)
        .onAppear { Task { await loadSellWindow() } }
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

    // MARK: — Price This Now bar

    private var priceThisNowBar: some View {
        Button {
            let query = [
                holding.playerName,
                holding.cardYear > 0 ? String(holding.cardYear) : nil,
                holding.product.isEmpty ? nil : holding.product,
                holding.parallel.flatMap { $0.isEmpty ? nil : $0 },
                holding.gradingCompany.lowercased() == "raw" ? nil : "\(holding.gradingCompany) \(holding.grade)",
                holding.isAuto ? "Auto" : nil
            ].compactMap { $0 }.joined(separator: " ")
            dismiss()
            router.jumpToDashboard(query: query, mode: .price)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "sparkle").font(.system(size: 13, weight: .semibold))
                Text("Price This Now").font(.system(size: 14, weight: .semibold))
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 11)).foregroundColor(.blue.opacity(0.7))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.blue.opacity(0.10))
            .foregroundColor(.blue)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.blue.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(PlainButtonStyle())
    }

    // MARK: — List on eBay bar

    private var listOnEbayBar: some View {
        Button { showEbayDraft = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "cart.fill").font(.system(size: 13, weight: .semibold))
                Text("List on eBay").font(.system(size: 14, weight: .semibold))
                if ebayStore.isConnected {
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 11)).foregroundColor(.green.opacity(0.7))
                } else {
                    Text("· Connect first").font(.system(size: 11)).foregroundColor(.orange.opacity(0.8))
                    Spacer()
                    Image(systemName: "link.badge.plus").font(.system(size: 11)).foregroundColor(.orange.opacity(0.7))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.green.opacity(0.10))
            .foregroundColor(.green)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.green.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(PlainButtonStyle())
        .sheet(isPresented: $showEbayDraft) {
            EbayListingDraftView(holding: holding) { listingUrl, listingPrice in
                if let url = listingUrl {
                    holding.listingUrl = url
                    holding.listingPrice = listingPrice
                }
            }
        }
        .task { await ebayStore.refresh() }
    }

    // MARK: — Sell Window section (auto-loaded on appear)

    private var sellWindowSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Sell Window")
            if sellWindowLoading {
                HStack {
                    ProgressView().tint(.gray)
                    Text("Checking seasonal signals…").font(.caption).foregroundColor(.gray)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if let sw = sellWindow {
                let color: Color = sw.inWindowNow ? .green : .orange
                let icon = sw.inWindowNow ? "checkmark.seal.fill" : "clock.fill"
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: icon).foregroundColor(color).font(.system(size: 16))
                        Text(sw.inWindowNow ? "In Sell Window Now" : "Next Window in \(sw.monthsUntilNext)mo")
                            .font(.subheadline.weight(.semibold)).foregroundColor(color)
                    }
                    if let active = sw.activeWindow {
                        Text(active.label).font(.caption.weight(.semibold)).foregroundColor(.white.opacity(0.85))
                        Text(active.reason).font(.caption).foregroundColor(.gray)
                    } else if let next = sw.nextWindow {
                        Text(next.label).font(.caption.weight(.semibold)).foregroundColor(.white.opacity(0.85))
                        Text(next.reason).font(.caption).foregroundColor(.gray)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(color.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(color.opacity(0.2), lineWidth: 1))
            } else if let err = sellWindowError {
                Text(err).font(.caption).foregroundColor(.red)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                EmptyView()
            }
        }
    }

    private func loadSellWindow() async {
        guard sellWindow == nil else { return }
        sellWindowLoading = true
        defer { sellWindowLoading = false }
        do {
            let req = CompIQSellWindowRequest(
                playerName: holding.playerName,
                cardYear: holding.cardYear > 0 ? holding.cardYear : nil,
                isRookie: holding.isRookie ? true : nil,
                sport: holding.sport
            )
            sellWindow = try await APIService.shared.fetchSellWindow(request: req)
        } catch {
            sellWindowError = "Could not load sell window."
        }
    }

    // MARK: — Grade Premium section (raw cards only)

    private var gradePremiumSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Grade Premium (PSA 10)")
            if gradePremiumLoading {
                HStack {
                    ProgressView().tint(.gray)
                    Text("Calculating premium…").font(.caption).foregroundColor(.gray)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if let gp = gradePremium {
                let color: Color = gp.worthGrading ? .green : .orange
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 16) {
                        gradePremiumTile(label: "Raw FMV", value: gp.rawFmv, color: .gray)
                        Image(systemName: "arrow.right").foregroundColor(.gray)
                        gradePremiumTile(label: "PSA 10", value: gp.psa10Fmv, color: .white)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("+\(gp.premiumDollars.currencyFormatted)")
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundColor(color)
                            Text("+\(String(format: "%.0f", gp.premiumPct))%")
                                .font(.caption.weight(.semibold))
                                .foregroundColor(color.opacity(0.8))
                        }
                    }
                    HStack(spacing: 6) {
                        Image(systemName: gp.worthGrading ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                            .foregroundColor(color).font(.system(size: 12))
                        Text(gp.verdict).font(.caption).foregroundColor(.gray)
                    }
                }
                .padding(14)
                .background(color.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(color.opacity(0.18), lineWidth: 1))
            } else {
                Button {
                    Task { await runGradePremium() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "rosette").font(.system(size: 13))
                        Text("Does PSA 10 pencil out?")
                            .font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 11)).foregroundColor(.purple.opacity(0.7))
                    }
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .background(Color.purple.opacity(0.10))
                    .foregroundColor(.purple)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.purple.opacity(0.25), lineWidth: 1))
                }
                .buttonStyle(PlainButtonStyle())
                if let err = gradePremiumError {
                    Text(err).font(.caption).foregroundColor(.red).padding(.top, 4)
                }
            }
        }
    }

    private func gradePremiumTile(label: String, value: Double, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.caption2).foregroundColor(.gray)
            Text(value.currencyFormatted).font(.system(size: 14, weight: .semibold)).foregroundColor(color)
        }
    }

    private func runGradePremium() async {
        gradePremiumLoading = true
        gradePremiumError = nil
        defer { gradePremiumLoading = false }
        do {
            let req = CompIQGradePremiumRequest(
                playerName: holding.playerName,
                cardYear: holding.cardYear > 0 ? holding.cardYear : nil,
                product: holding.product.isEmpty ? nil : holding.product,
                parallel: holding.parallel.flatMap { $0.isEmpty ? nil : $0 },
                isAuto: holding.isAuto ? true : nil
            )
            gradePremium = try await APIService.shared.fetchGradePremium(request: req)
        } catch {
            gradePremiumError = "Could not fetch grade premium."
        }
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

// MARK: - Forecast Section
struct ForecastSection: View {
    let forecast: PriceForecast

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Price Forecast")
            VStack(spacing: 10) {
                // Confidence header
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Model Confidence")
                            .font(.caption)
                            .foregroundColor(Color(.systemGray2))
                        Text(forecast.volatilityRating + " Volatility · " + forecast.liquidityRating + " Liquidity")
                            .font(.caption2)
                            .foregroundColor(Color(.systemGray3))
                    }
                    Spacer()
                    Text("\(Int(forecast.modelConfidence * 100))%")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundColor(confidenceColor)
                }
                .padding(.horizontal, 14)
                .padding(.top, 12)

                // Confidence bar
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(.systemGray5)).frame(height: 5)
                        Capsule()
                            .fill(confidenceColor)
                            .frame(width: geo.size.width * min(forecast.modelConfidence, 1.0), height: 5)
                    }
                }
                .frame(height: 5)
                .padding(.horizontal, 14)

                Divider().background(Color(.systemGray6))

                // Forecast tiles
                HStack(spacing: 0) {
                    forecastTile(label: "30 Day",  value: forecast.forecast30Day)
                    Divider().frame(width: 1, height: 44).background(Color(.systemGray5))
                    forecastTile(label: "90 Day",  value: forecast.forecast90Day)
                    Divider().frame(width: 1, height: 44).background(Color(.systemGray5))
                    forecastTile(label: "12 Month", value: forecast.forecast12Month)
                }
                .padding(.horizontal, 14)

                Divider().background(Color(.systemGray6))

                // Range
                HStack(spacing: 0) {
                    rangeTile(label: "Low", value: forecast.lowEstimate, color: .red)
                    Divider().frame(width: 1, height: 36).background(Color(.systemGray5))
                    rangeTile(label: "Expected", value: forecast.forecast90Day, color: .white)
                    Divider().frame(width: 1, height: 36).background(Color(.systemGray5))
                    rangeTile(label: "High", value: forecast.highEstimate, color: .green)
                }
                .padding(.horizontal, 14)

                // Summary
                if !forecast.reasoningSummary.isEmpty {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "brain.head.profile")
                            .font(.caption)
                            .foregroundColor(.blue)
                        Text(forecast.reasoningSummary)
                            .font(.caption)
                            .foregroundColor(Color(.systemGray2))
                    }
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
                }
            }
            .background(Color(.secondarySystemBackground).opacity(0.65))
            .cornerRadius(14)
        }
    }

    private var confidenceColor: Color {
        forecast.modelConfidence >= 0.75 ? .green : forecast.modelConfidence >= 0.50 ? .yellow : .orange
    }

    private func forecastTile(label: String, value: Double) -> some View {
        VStack(spacing: 3) {
            Text("$\(Int(value))")
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundColor(.white)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func rangeTile(label: String, value: Double, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("$\(Int(value))")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundColor(color)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}

// MARK: - Previews
struct PortfolioHoldingDetailView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioHoldingDetailView(holding: .constant(PortfolioHolding.mockHoldings[0]))
            .preferredColorScheme(.dark)
    }
}