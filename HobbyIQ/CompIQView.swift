//
//  CompIQView.swift
//  HobbyIQ
//

import SwiftUI

struct CompIQView: View {
    @StateObject private var viewModel: CompIQViewModel
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var initialQuery: String?
    @State private var searchText = ""
    @State private var didApplyInitialQuery = false
    @State private var navigateToVariants = false
    @State private var navigateToMarketTrends = false
    @State private var navigateToCardSearch = false
    @State private var showBulkEstimate = false

    /// CF-LIVE-SUGGEST (2026-07-06): live-suggest state under the Find
    /// Cards search bar. `liveSuggestions` is the (5–8) list of rich
    /// suggestion rows (thumbnail + player + year/product + parallel).
    /// `suggestTask` is the debounced in-flight fetch — cancelled on
    /// every keystroke so the latest query always wins.
    /// `suppressNextSuggest` breaks the loop after a suggestion tap sets
    /// `searchText` programmatically. `selectedLiveHit` drives the
    /// navigationDestination push to CompIQPricedCardView. `parsePreview`
    /// backs the optional "We understood: year=…" hint line.
    @State private var liveSuggestions: [CompIQVariantHit] = []
    @State private var suggestTask: Task<Void, Never>?
    @State private var suppressNextSuggest: Bool = false
    @State private var selectedLiveHit: CompIQVariantHit?
    @State private var parsePreview: CompIQParsePreviewResponse?
    @State private var parseTask: Task<Void, Never>?

    /// CF-COMPIQ-BACK-ROUTE (2026-07-02): CompIQ is a tab root (not a
    /// pushed/modal view), so `dismiss()` from here has no presenter to
    /// pop and previously crashed / no-op'd on tap. The shell now passes
    /// an `onBack` closure that flips `selectedTab` back to Dashboard —
    /// matching the user's mental model of "I opened CompIQ from
    /// Dashboard, Back returns to Dashboard." Optional so preview /
    /// standalone use falls back to `dismiss()`.
    private let onBack: (() -> Void)?

    @MainActor
    init(
        initialQuery: String? = nil,
        viewModel: CompIQViewModel? = nil,
        onBack: (() -> Void)? = nil
    ) {
        self.initialQuery = initialQuery
        self._viewModel = StateObject(wrappedValue: viewModel ?? CompIQViewModel.shared)
        self.onBack = onBack
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                heroCard
                toolsCard
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
                    if let onBack {
                        onBack()
                    } else {
                        dismiss()
                    }
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
                .environmentObject(sessionViewModel)
        }
        .navigationDestination(isPresented: $navigateToMarketTrends) {
            MarketTrendView()
        }
        .navigationDestination(isPresented: $navigateToCardSearch) {
            CardSearchView()
                .environmentObject(sessionViewModel)
        }
        .navigationDestination(isPresented: $showBulkEstimate) {
            BulkEstimateView()
                .environmentObject(sessionViewModel)
        }
        .navigationDestination(item: $selectedLiveHit) { hit in
            CompIQPricedCardView(hit: hit)
                .environmentObject(sessionViewModel)
        }
        .onDisappear {
            suggestTask?.cancel()
            parseTask?.cancel()
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

    private var toolsCard: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    navigateToMarketTrends = true
                } label: {
                    toolButton(icon: "chart.line.uptrend.xyaxis", title: "Market Trends")
                }
                .buttonStyle(.plain)

                Button {
                    showBulkEstimate = true
                } label: {
                    toolButton(icon: "square.stack.3d.up", title: "Bulk Estimate")
                }
                .buttonStyle(.plain)
            }

            Button {
                navigateToCardSearch = true
            } label: {
                toolButton(icon: "rectangle.stack.badge.magnifyingglass", title: "Card Database Search")
            }
            .buttonStyle(.plain)
        }
    }

    private func toolButton(icon: String, title: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var searchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HobbyIQSearchField(text: $searchText, placeholder: "Dylan Crews - 2025 Bowman Chrome...")
                .onSubmit {
                    submitSearch()
                }
                .onChange(of: searchText) { _, newValue in
                    handleSearchTextChange(newValue)
                }

            if let hint = parsePreview?.displayLine {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            liveSuggestionsDropdown

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

    /// CF-LIVE-SUGGEST (2026-07-06): live-suggest dropdown rendered
    /// directly under the search field. Each row surfaces a thumbnail,
    /// player, year+product, and (when present) parallel + print run.
    /// Tap navigates directly to CompIQPricedCardView for that variant;
    /// Return (submit) is untouched and still lands on the full picker.
    @ViewBuilder
    private var liveSuggestionsDropdown: some View {
        if liveSuggestions.isEmpty == false {
            VStack(spacing: 0) {
                ForEach(Array(liveSuggestions.prefix(8).enumerated()), id: \.offset) { index, hit in
                    Button {
                        applyLiveSuggestion(hit)
                    } label: {
                        liveSuggestionRow(hit)
                    }
                    .buttonStyle(.plain)

                    if index < min(liveSuggestions.count, 8) - 1 {
                        Rectangle()
                            .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                            .frame(height: 1)
                            .padding(.horizontal, 8)
                    }
                }
            }
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func liveSuggestionRow(_ hit: CompIQVariantHit) -> some View {
        HStack(spacing: 12) {
            liveSuggestionThumbnail(hit)

            VStack(alignment: .leading, spacing: 3) {
                Text(hit.player ?? hit.resolvedLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)

                if let meta = liveSuggestionMeta(hit) {
                    Text(meta)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func liveSuggestionThumbnail(_ hit: CompIQVariantHit) -> some View {
        if let urlString = hit.imageUrl, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().aspectRatio(contentMode: .fill)
                default:
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                }
            }
            .frame(width: 34, height: 46)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                .frame(width: 34, height: 46)
                .overlay(
                    Image(systemName: "photo")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                )
        }
    }

    private func liveSuggestionMeta(_ hit: CompIQVariantHit) -> String? {
        var parts: [String] = []
        if let year = hit.year { parts.append(String(year)) }
        if let set = hit.set, set.isEmpty == false { parts.append(set) }
        if let variant = hit.variant, variant.isEmpty == false { parts.append(variant) }
        if let serial = hit.serialNumber, serial.isEmpty == false { parts.append("/\(serial)") }
        let joined = parts.joined(separator: " · ")
        return joined.isEmpty ? nil : joined
    }

    /// Debounced 200ms fetch of `/api/search/cards` for live suggestions
    /// PLUS `/api/compiq/parse-preview` for the "We understood" hint.
    /// Both are advisory — a network error hides the dropdown / line
    /// silently and never blocks the literal submit path. Empty query
    /// (or < 3 chars) clears both.
    private func handleSearchTextChange(_ value: String) {
        if suppressNextSuggest {
            suppressNextSuggest = false
            return
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count < 3 {
            suggestTask?.cancel()
            parseTask?.cancel()
            liveSuggestions = []
            parsePreview = nil
            return
        }
        suggestTask?.cancel()
        suggestTask = Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            do {
                let next = try await APIService.shared.fetchLiveCardSuggestions(q: trimmed)
                if Task.isCancelled { return }
                liveSuggestions = next
            } catch {
                if Task.isCancelled == false {
                    liveSuggestions = []
                }
            }
        }
        parseTask?.cancel()
        parseTask = Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            do {
                let preview = try await APIService.shared.fetchParsePreview(q: trimmed)
                if Task.isCancelled { return }
                parsePreview = preview
            } catch {
                if Task.isCancelled == false {
                    parsePreview = nil
                }
            }
        }
    }

    /// Tapping a live suggestion pushes CompIQPricedCardView directly for
    /// that variant. Clear the dropdown + parse hint so they don't
    /// linger under a search that already resolved. `suppressNextSuggest`
    /// guards the field update from re-triggering the debounce.
    private func applyLiveSuggestion(_ hit: CompIQVariantHit) {
        suppressNextSuggest = true
        suggestTask?.cancel()
        parseTask?.cancel()
        liveSuggestions = []
        parsePreview = nil
        selectedLiveHit = hit
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

#if DEBUG
        if let parsed = viewModel.parsedCard {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Parsed Card (debug)", subtitle: "Fields inferred from your text.")
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
#endif
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
        // CF-UNIFY-SECTION-HEADERS (2026-06-17): delegates to the shared
        // HIQSectionHeader. The CompIQ subtitle keeps showing below the
        // hairlines so the existing helper text ("The current value
        // returned by Azure.", "Plain-English notes from Azure.", etc.)
        // doesn't disappear from the comp page.
        HIQSectionHeader(title, subtitle: subtitle)
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
                statPill(title: "Low", value: result.lowValue > 0 ? result.lowValue.formatted(.currency(code: "USD").precision(.fractionLength(0))) : "—", tint: HobbyIQTheme.Colors.successGreen)
                statPill(title: "High", value: result.highValue > 0 ? result.highValue.formatted(.currency(code: "USD").precision(.fractionLength(0))) : "—", tint: HobbyIQTheme.Colors.danger)
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
                statPill(title: Labels.buyZone, value: result.lowValue > 0 ? result.lowValue.formatted(.currency(code: "USD").precision(.fractionLength(0))) : "—", tint: HobbyIQTheme.Colors.successGreen)
                statPill(title: "Fair", value: result.formattedFairValue, tint: HobbyIQTheme.Colors.electricBlue)
                statPill(title: Labels.sellZone, value: result.highValue > 0 ? result.highValue.formatted(.currency(code: "USD").precision(.fractionLength(0))) : "—", tint: HobbyIQTheme.Colors.danger)
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
            HStack(spacing: 6) {
                Text("Buy Window")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                HIQHelpButton(
                    title: "Buy Window",
                    message: "When this card historically trades near its low for the year. A higher score (70+) means right now is a strong stretch to be buying; lower means waiting tends to pay off."
                )
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

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): broaderTrendRow removed —
    // surfaced result.broaderTrendLabel directly (direction-class read).

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
        .environmentObject(AppSessionViewModel())
        .preferredColorScheme(.dark)
    }
}
