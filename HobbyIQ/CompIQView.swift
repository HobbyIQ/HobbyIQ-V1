//
//  CompIQView.swift
//  HobbyIQ
//

import SwiftUI

struct CompIQView: View {
    @StateObject private var viewModel: CompIQViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var initialQuery: String?
    @State private var searchText = ""
    @State private var didApplyInitialQuery = false
    @State private var navigateToVariants = false

    @MainActor
    init(initialQuery: String? = nil, viewModel: CompIQViewModel? = nil) {
        self.initialQuery = initialQuery
        self._viewModel = StateObject(wrappedValue: viewModel ?? CompIQViewModel.shared)
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                heroCard
                searchCard
                readyCard
                resultSection
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Back")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
            }
        }
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationDestination(isPresented: $navigateToVariants) {
            CompIQVariantPickerView(initialQuery: searchText.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        .onAppear { applyInitialQueryIfNeeded() }
        .onChange(of: initialQuery) { _, _ in
            didApplyInitialQuery = false
            applyInitialQueryIfNeeded()
        }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CompIQ")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            Text(HobbyIQTheme.heroSubtitle)
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.18), radius: 18, x: 0, y: 10)
    }

    private var searchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HobbyIQSearchField(text: $searchText, placeholder: "Dylan Crews - 2025 Bowman Chrome...")
                .onSubmit {
                    submitSearch()
                }

            Text("Search the card, verify the exact variant, and let the backend do the pricing work.")
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            HIQPrimaryButton(title: "Find Cards", systemImage: "magnifyingglass") {
                submitSearch()
            }
            .opacity(searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.6 : 1)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func submitSearch() {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }
        navigateToVariants = true
    }

    private var readyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ready when you are")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Enter a card and tap Run CompIQ for a live estimate.")
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    @ViewBuilder
    private var resultSection: some View {
        if let errorMessage = viewModel.errorMessage {
            errorBanner(message: errorMessage)
        }

        if viewModel.isLoading {
            loadingCard
        }

        if let result = viewModel.result {
            VStack(alignment: .leading, spacing: 14) {
                sectionHeader(title: Labels.liveEstimate, subtitle: "The current value returned by Azure.")
                estimateCard(result)
                sellingGuidanceSection(result)
                verdictRow(result)
                variantWarningRow(result)
                zonesCard(result)
                buyWindowRow(result)
                summaryCard(result)
                explanationCard(result)
                broaderTrendRow(result)
                exitStrategyRow(result)
                freshnessRow(result)

                HStack(spacing: 12) {
                    HIQSecondaryButton(title: viewModel.isLoadingInsight ? "Loading..." : "Insight", systemImage: "wand.and.stars") {
                        Task { await viewModel.loadInsight() }
                    }
                    .opacity(viewModel.isLoadingInsight ? 0.75 : 1)
                    .disabled(viewModel.isLoadingInsight)

                    HIQSecondaryButton(title: viewModel.isLoadingListing ? "Listing..." : "Listing", systemImage: "square.and.pencil") {
                        Task { await viewModel.loadListing(platform: "eBay") }
                    }
                    .opacity(viewModel.isLoadingListing ? 0.75 : 1)
                    .disabled(viewModel.isLoadingListing)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }

        if let insight = viewModel.insight {
            infoCard(title: "Insight", body: insight)
        }

        if let title = viewModel.listingTitle {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Listing Copy", subtitle: "Generated listing text for your platform.")
                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let listingDescription = viewModel.listingDescription {
                    Text(listingDescription)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }

        if let parsed = viewModel.parsedCard {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Parsed Card", subtitle: "Fields inferred from your text.")
                Text(parsed.playerName ?? "Unknown player")
                    .font(.headline.bold())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text([parsed.cardName, parsed.parallel, parsed.grade].compactMap { $0 }.joined(separator: " • "))
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
    }

    private func runSearch() async {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }

        await viewModel.parseFromText(trimmed)

        if viewModel.playerName.isEmpty {
            viewModel.playerName = trimmed
        }
        if viewModel.cardName.isEmpty {
            viewModel.cardName = trimmed
        }
        if viewModel.cost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            viewModel.cost = "1"
        }

        await viewModel.runEstimate()
    }

    private func applyInitialQueryIfNeeded() {
        guard didApplyInitialQuery == false else { return }
        didApplyInitialQuery = true

        guard let query = initialQuery?.trimmingCharacters(in: .whitespacesAndNewlines), query.isEmpty == false else {
            return
        }

        searchText = query
        navigateToVariants = true
    }

    private func sectionHeader(title: String, subtitle: String) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                Rectangle()
                    .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                    .frame(height: 1)

                Text(title.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.2)
                    .fixedSize()

                Rectangle()
                    .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                    .frame(height: 1)
            }

            Text(subtitle)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
    }

    private var loadingCard: some View {
        HStack(spacing: 12) {
            ProgressView()
                .tint(HobbyIQTheme.Colors.electricBlue)
            Text("CompIQ is working...")
                .font(HobbyIQTheme.Typography.bodyEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func errorBanner(message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.danger)
            Text(message)
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.danger.opacity(0.25))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.danger.opacity(0.3), lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func infoCard(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader(title: title, subtitle: "Generated from the live CompIQ routes.")
            Text(body)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func statPill(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.bold())
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.03))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func estimateCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(Labels.fairValue)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(result.formattedFairValue)
                        .font(HobbyIQTheme.Typography.hero)
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text(Labels.confidence)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(result.confidence.formatted(.percent.precision(.fractionLength(0))))
                        .font(.headline.bold())
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }

            HStack(spacing: 12) {
                statPill(title: "Low", value: result.lowValue > 0 ? result.lowValue.formatted(.currency(code: "USD")) : "—", tint: HobbyIQTheme.Colors.successGreen)
                statPill(title: "High", value: result.highValue > 0 ? result.highValue.formatted(.currency(code: "USD")) : "—", tint: HobbyIQTheme.Colors.danger)
            }

            Text(result.summary)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func zonesCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "HobbyIQ Zones", subtitle: "Quick buy / hold / sell guide rails.")
            HStack(spacing: 12) {
                statPill(title: Labels.buyZone, value: result.lowValue > 0 ? result.lowValue.formatted(.currency(code: "USD")) : "—", tint: HobbyIQTheme.Colors.successGreen)
                statPill(title: "Fair", value: result.formattedFairValue, tint: HobbyIQTheme.Colors.electricBlue)
                statPill(title: Labels.sellZone, value: result.highValue > 0 ? result.highValue.formatted(.currency(code: "USD")) : "—", tint: HobbyIQTheme.Colors.danger)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func summaryCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "What We Know", subtitle: "The short version.")
            Text(result.method.isEmpty ? "Unknown method" : result.method)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(result.explanation.isEmpty ? "No summary provided." : result.explanation)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func explanationCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: Labels.howWeCompedIt, subtitle: "Plain-English notes from Azure.")

            if result.explanationLines.isEmpty {
                Text("No explanation was returned for this estimate.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(result.explanationLines, id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(HobbyIQTheme.Colors.electricBlue)
                                .frame(width: 6, height: 6)
                                .padding(.top, 7)
                            Text(line)
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    @ViewBuilder
    private func verdictRow(_ result: CompIQEstimateResult) -> some View {
        if let verdict = result.verdict, verdict.isEmpty == false {
            HStack(spacing: 8) {
                Text(verdict)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let action = result.action, action.isEmpty == false, action != verdict {
                    Text(action)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(verdictActionColor(action))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(verdictActionColor(action).opacity(0.15))
                        .clipShape(Capsule())
                }
                Spacer()
                if let deal = result.dealScore {
                    Text("Deal \(String(format: "%.0f", deal))")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
    }

    @ViewBuilder
    private func variantWarningRow(_ result: CompIQEstimateResult) -> some View {
        if let warning = result.variantWarning, warning.isEmpty == false {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                    .font(.caption)
                Text(warning)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private func buyWindowRow(_ result: CompIQEstimateResult) -> some View {
        if let label = result.buyWindowLabel {
            HStack {
                Text("Buy Window")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(label)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let score = result.buyWindowScore {
                    Text(String(format: "%.0f", score))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(score >= 70 ? HobbyIQTheme.Colors.successGreen : score >= 40 ? HobbyIQTheme.Colors.warning : HobbyIQTheme.Colors.danger)
                }
            }
        }
    }

    @ViewBuilder
    private func broaderTrendRow(_ result: CompIQEstimateResult) -> some View {
        if let label = result.broaderTrendLabel, label.isEmpty == false {
            HStack {
                Text("Broader Trend")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(label)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
        }
    }

    @ViewBuilder
    private func exitStrategyRow(_ result: CompIQEstimateResult) -> some View {
        if let method = result.exitRecommendation {
            HStack {
                Text("Exit Strategy")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(method)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if let days = result.exitDaysToSell {
                        Text("~\(days)d to sell")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func freshnessRow(_ result: CompIQEstimateResult) -> some View {
        if let status = result.freshnessStatus, status.isEmpty == false {
            HStack {
                Text("Freshness")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(status.capitalized)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(freshnessStatusColor(status))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(freshnessStatusColor(status).opacity(0.15))
                    .clipShape(Capsule())
            }
        }
    }

    private func verdictActionColor(_ action: String) -> Color {
        let lower = action.lowercased()
        if lower.contains("buy") { return HobbyIQTheme.Colors.successGreen }
        if lower.contains("sell") { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.warning
    }

    private func freshnessStatusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "fresh": return HobbyIQTheme.Colors.successGreen
        case "stale": return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.mutedText
        }
    }

    // MARK: - Selling Guidance

    @ViewBuilder
    private func sellingGuidanceSection(_ result: CompIQEstimateResult) -> some View {
        if let guidance = result.sellingGuidance {
            VStack(alignment: .leading, spacing: 12) {
                sectionHeader(title: "Selling Guidance", subtitle: "Actionable sell-side pricing.")

                platformPill(guidance.recommendedPlatform)

                if guidance.fair != nil {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let range = guidance.sellRange {
                            guidanceRow(label: "Sell Range", value: "\(formatCurrency(range.low)) – \(formatCurrency(range.high))")
                        }
                        if let v = guidance.quickSale {
                            guidanceRow(label: "Quick Sale", value: formatCurrency(v), subtitle: "Closes within 48h")
                        }
                        if let v = guidance.fair {
                            guidanceRow(label: "Fair Price", value: formatCurrency(v), subtitle: "Balanced FMV")
                        }
                        if let v = guidance.ebayListingPrice {
                            guidanceRow(label: "eBay BIN Price", value: formatCurrency(v), subtitle: "List at this sticker")
                        }
                        if let v = guidance.bestOfferFloor {
                            guidanceRow(label: "Best Offer Floor", value: formatCurrency(v), subtitle: "Auto-decline below")
                        }
                        if let v = guidance.auctionStartPrice {
                            guidanceRow(label: "Auction Start", value: formatCurrency(v), subtitle: "No-reserve opener")
                        }
                        if let v = guidance.breakEven {
                            guidanceRow(label: "Break-even", value: formatCurrency(v), subtitle: "Gross needed to net fair")
                        }
                    }
                } else if let firstNote = guidance.notes.first {
                    Text(firstNote)
                        .font(.footnote)
                        .foregroundStyle(.gray)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if guidance.fair != nil {
                    ForEach(guidance.notes, id: \.self) { note in
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(.gray)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
    }

    private func platformPill(_ platform: String) -> some View {
        Text(platform.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.caption.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(platformColor(platform).opacity(0.25))
            .overlay(
                Capsule().stroke(platformColor(platform).opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(Capsule())
    }

    private func platformColor(_ platform: String) -> Color {
        switch platform.lowercased() {
        case "auction": return .blue
        case "buy_it_now": return HobbyIQTheme.Colors.successGreen
        case "best_offer": return .orange
        default: return .gray
        }
    }

    private func guidanceRow(label: String, value: String, subtitle: String? = nil) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                }
            }
            Spacer()
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.vertical, 6)
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        formatter.roundingMode = .halfUp
        return formatter.string(from: NSNumber(value: value)) ?? "$\(String(format: "%.2f", value))"
    }

    #Preview {
        NavigationStack {
            CompIQView()
        }
        .preferredColorScheme(.dark)
    }
}
