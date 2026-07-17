//
//  DailyIQView.swift
//  HobbyIQ
//

import SwiftUI

@MainActor
struct DailyIQView: View {
    private let userId: String
    @ObservedObject private var service: DailyIQService
    @State private var selectedDate: Date
    @State private var watchlistQuery = ""
    @State private var trackedWatchlist: [DailyWatchlistEntry] = []
    @State private var watchedPlayerNames: Set<String> = []
    @State private var isSyncingWatchlist = false
    @State private var playerIQName: String?
    @State private var searchResults: [PlayerSearchResult] = []
    @State private var isSearching = false
    @State private var topWatched: [WatchPlayerResult] = []
    @State private var suggestions: [WatchlistSuggestion] = []
    @State private var fullBrief: DailyIQFullBriefResponse?
    @State private var isLoadingBrief = false
    @State private var showUpgradePaywall = false
    @State private var marketSignals: DailyIQMarketSignalsResponse?
    @State private var isLoadingMarketSignals = false
    @State private var myPlayers: DailyIQMyPlayersResponse?
    @State private var isLoadingMyPlayers = false
    @State private var dailySegment: DailyIQSegment = .myPlayers
    @State private var marketTab: DailyIQMarketTab = .allMarket
    @State private var drillPlayer: DailyIQMyPlayerEntry?
    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): active explainer popover
    /// key. Non-nil = sheet is up. Populated by section-header info
    /// buttons.
    @State private var explainerPopoverKey: String?

    // PR #425 (2026-07-13): watchlist-derived buy candidates — players
    // on the user's watchlist whose supply/demand verdict is bullish.
    // Loaded on task; nil / empty response suppresses the section.
    @State private var buyCandidates: WatchlistBullCandidatesResponse?
    /// Phase 3.7 (2026-07-17, PR #529): top players by momentum × velocity.
    /// Shows top 5 in the tile with a "See top 25 →" tap to expand.
    @State private var hotRightNow: HotRightNowResponse?
    /// Gate the drill-down push from the "See top 25" button.
    @State private var showHotRightNowFullList = false
    /// Batch 2 (2026-07-17): sell-now radar candidates + drill-down state.
    @State private var sellNowRadar: SellNowRadarResponse?
    @State private var showSellNowRadar = false
    /// Batch 2 (2026-07-17): notable sales (top-dollar recent) + drill-down.
    @State private var notableSales: NotableSalesResponse?
    @State private var showNotableSales = false
    /// Batch 2 (2026-07-17): sub-raw discovery drill-down gate.
    @State private var showSubRawDiscovery = false
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

    @MainActor
    init(userId: String = "", service: DailyIQService? = nil) {
        self.userId = userId
        self._service = ObservedObject(wrappedValue: service ?? .shared)
        self._selectedDate = State(initialValue: Date())
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 16) {
                heroCard

                if let message = service.errorMessage {
                    backendStatusBanner(
                        title: "DailyIQ sync issue",
                        message: message,
                        systemImage: "wifi.exclamationmark"
                    )
                }

                // PR #425 (2026-07-13): Buy Candidates — watchlisted
                // players trending bullish. Self-suppresses when the
                // response is nil / no candidates.
                buyCandidatesSection

                // Phase 3.7 (2026-07-17, PR #529): Hot Right Now — top
                // players by momentum × velocity from the corpus.
                // Self-suppresses when the response is nil / thin.
                hotRightNowSection

                // Batch 2 (2026-07-17, PR #539): Sell-Now Radar banner.
                sellNowRadarBanner
                // Batch 2 (2026-07-17): Value Hunter banner — always
                // renders when we're showing DailyIQ.
                valueHunterBanner
                // Batch 2 (2026-07-17, PR #539): Notable sales banner.
                notableSalesBanner

                // CF-DAILYIQ-TWO-SEGMENTS (2026-07-01): DailyIQ splits
                // into two selectable segments — "Your Players" (personal
                // matched-cohort momentum) and "Market Trends" (hobby-
                // wide discover). Both Investor-gated. Card Movers and
                // the watchlist were removed in prior CFs.
                dailySegmentControl

                switch dailySegment {
                case .myPlayers:
                    yourPlayersSection
                        .lockedOverlay(
                            feature: GatedFeature.dailyIQBriefs,
                            subscriptionManager: sessionViewModel.subscriptionManager
                        ) {
                            showUpgradePaywall = true
                        }
                case .discover:
                    marketSignalsSection
                        .lockedOverlay(
                            feature: GatedFeature.dailyIQBriefs,
                            subscriptionManager: sessionViewModel.subscriptionManager
                        ) {
                            showUpgradePaywall = true
                        }
                }
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(HobbyIQBackground())
        .toolbar(.hidden, for: .navigationBar)
        .task {
            // CF-DAILYIQ-PARALLEL-LOAD (2026-07-02): fan out the four
            // independent DailyIQ fetches in parallel via `async let`.
            // Previously they ran sequentially, so cold load = sum of
            // all four endpoint latencies. Now = max(endpoint).
            async let refresh: Void = refreshDailyIQ(for: nil)
            async let brief: Void = loadFullBrief()
            async let signals: Void = loadMarketSignals()
            async let mine: Void = loadMyPlayers()
            async let candidates: Void = loadBuyCandidates()
            async let hot: Void = loadHotRightNow()
            async let sellNow: Void = loadSellNowRadar()
            async let notable: Void = loadNotableSales()
            _ = await (refresh, brief, signals, mine, candidates, hot, sellNow, notable)
            // P1 (2026-07-16, iOS delta): first meaningful use of the
            // app — checking DailyIQ. Ask for push permission here (once)
            // per Apple HIG so the affordance is connected to the value.
            await PushNotificationManager.shared.askIfFirstMeaningfulUse()
        }
        .onChange(of: selectedDate) { _, newValue in
            Task { await refreshDailyIQ(for: newValue) }
        }
        // CF-MARKET-TRENDS-REFRESH (2026-07-04): pull-to-refresh now
        // clears the session-scoped caches for the Market Trends +
        // My Players sections and refetches them alongside the brief.
        .refreshable {
            marketSignals = nil
            myPlayers = nil
            buyCandidates = nil
            async let refresh: Void = refreshDailyIQ(for: selectedDate)
            async let signals: Void = loadMarketSignals()
            async let mine: Void = loadMyPlayers()
            async let candidates: Void = loadBuyCandidates()
            _ = await (refresh, signals, mine, candidates)
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(sessionViewModel: sessionViewModel)
        }
        // CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): explainer sheet
        // shows the copy previously repeated inline under every
        // section header. Bound to `explainerPopoverKey` — a section's
        // `info.circle` tap sets the key, which drives the sheet.
        .sheet(isPresented: Binding(
            get: { explainerPopoverKey != nil },
            set: { if !$0 { explainerPopoverKey = nil } }
        )) {
            explainerSheet
        }
        .fullScreenCover(isPresented: Binding(
            get: { playerIQName != nil },
            set: { if !$0 { playerIQName = nil } }
        )) {
            if let name = playerIQName {
                PlayerIQView(initialQuery: name)
                    .preferredColorScheme(.dark)
            }
        }
        // CF-PAGES-NOT-SHEETS (2026-07-04): drill-into-cohort now pushes
        // as a page (tab bar persistent, swipe-back, native back).
        .navigationDestination(item: $drillPlayer) { entry in
            OwnedCardsInCohortSheet(entry: entry)
        }
    }

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Title row with date picker
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("DailyIQ")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    Text("Daily market movers & momentum \(Labels.signals)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                Spacer()

                DatePicker("", selection: $selectedDate, displayedComponents: .date)
                    .datePickerStyle(.compact)
                    .labelsHidden()
                    .tint(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
                    )
                    .clipShape(Capsule(style: .continuous))
            }

            // CF-DAILYIQ-DROP-WATCHLIST (2026-07-01): hero count line
            // removed. The trend-first subtitle above ("Daily market
            // movers & momentum signals") is now the only descriptor —
            // player watching total would read as an orphan metric
            // now that the watchlist section is gone.
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 4)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.1), radius: 20, x: 0, y: 10)
    }

    // CF-DAILYIQ-TREND-FIRST (2026-07-01): segmentControl removed. The
    // Watchlist / MLB / MiLB / Brief tabs are gone; DailyIQ now renders
    // Market Signals + Card Movers + Watchlist as a single trend-first
    // scroll. See body for the new layout.

private var watchlistCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Search + Add bar
            HStack(spacing: 10) {
                HobbyIQSearchField(text: $watchlistQuery, placeholder: "Search player and add to watchlist...")
                    .onSubmit {
                        Task { await searchPlayers(query: watchlistQuery) }
                    }
                    .frame(maxWidth: .infinity)

                Button {
                    Task { await searchPlayers(query: watchlistQuery) }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                            .font(.system(size: 12, weight: .bold))
                        Text("Add")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                }
                .buttonStyle(.plain)
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))

            // Search results (from POST watchlist/search, gated collector+)
            if isSearching {
                HStack(spacing: 8) {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Searching…")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
                .padding(.vertical, 8)
            }

            if !searchResults.isEmpty {
                VStack(spacing: 6) {
                    ForEach(searchResults) { result in
                        Button {
                            Task { await addFromSearchResult(result) }
                        } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(result.playerName)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                    HStack(spacing: 6) {
                                        if let team = result.teamName {
                                            Text(team)
                                                .font(.caption.weight(.medium))
                                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                        }
                                        if let pos = result.positionName ?? result.position {
                                            Text(pos)
                                                .font(.caption.weight(.medium))
                                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                        }
                                        if result.active == true {
                                            Text("Active")
                                                .font(.system(size: 9, weight: .bold))
                                                .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                                                .padding(.horizontal, 5)
                                                .padding(.vertical, 2)
                                                .background(HobbyIQTheme.Colors.hobbyGreen.opacity(0.15))
                                                .clipShape(Capsule())
                                        }
                                    }
                                }
                                Spacer()
                                Image(systemName: "plus.circle.fill")
                                    .font(.system(size: 18))
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(HobbyIQTheme.Colors.cardNavy)
                            .overlay(
                                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.2), lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            // Top Watched (ungated)
            if !topWatched.isEmpty {
                dailySectionHeader("TOP WATCHED")
                LazyVStack(spacing: 8) {
                    ForEach(topWatched.prefix(10), id: \.id) { entry in
                        Button {
                            playerIQName = entry.playerName
                        } label: {
                            DailyWatchlistRow(
                                entry: DailyWatchlistEntry(result: entry),
                                onRemove: { Task { await removeWatchlistEntry(DailyWatchlistEntry(result: entry)) } }
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            // Watchlist entries — the user's own tracked players come BEFORE
            // Suggestions so the surface they curated is what they see first.
            if trackedWatchlist.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "eye")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text("Add players to track their daily and season lines here.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            } else {
                dailySectionHeader("YOUR WATCHLIST")
                LazyVStack(spacing: 10) {
                    ForEach(trackedWatchlist) { entry in
                        Button {
                            playerIQName = entry.playerName
                        } label: {
                            DailyWatchlistRow(entry: entry) { Task { await removeWatchlistEntry(entry) } }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            // Suggested Players (ungated)
            if !suggestions.isEmpty {
                dailySectionHeader("SUGGESTED FOR YOU")
                LazyVStack(spacing: 6) {
                    ForEach(suggestions) { sug in
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(sug.playerName)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                let subtitleParts = [sug.teamName, sug.level].compactMap { $0 }
                                if subtitleParts.isEmpty == false {
                                    Text(subtitleParts.joined(separator: " · "))
                                        .font(.caption)
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                }
                            }
                            Spacer()
                            if let position = sug.position, position.isEmpty == false {
                                Text(position)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            }
                            Button {
                                Task { await addWatchlistEntry(from: sug) }
                            } label: {
                                Image(systemName: "plus.circle")
                                    .font(.system(size: 16))
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(HobbyIQTheme.Colors.cardNavy)
                        .overlay(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                                .stroke(Color.white.opacity(0.08), lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                    }
                }
            }
        }
    }

    // MARK: - Card Movers (formerly briefCard, CF-DAILYIQ-TREND-FIRST 2026-07-01)

    /// CF-DAILYIQ-TREND-FIRST (2026-07-01): the card-level movers block
    /// hoisted out of the retired `briefCard`. Section header + freshness
    /// pill + Risers / Fallers / Breakouts + graceful empty state. Fetch
    /// (`loadFullBrief`) is now driven by the top-level `.task` alongside
    /// the other DailyIQ loads.
    private var cardMoversSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "chart.bar.xaxis")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("CARD MOVERS")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.6)
                Spacer()
                if let freshness = fullBrief?.meta?.dataFreshness {
                    Text(freshness)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                        .clipShape(Capsule())
                }
            }
            .padding(.top, 4)

            if isLoadingBrief && fullBrief == nil {
                HStack(spacing: 10) {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Loading movers…")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
                .padding(.vertical, 10)
            } else if let brief = fullBrief {
                briefMoverSection(title: "Risers", movers: brief.risers ?? [], color: HobbyIQTheme.Colors.hobbyGreen, icon: "arrow.up.right")
                briefMoverSection(title: "Fallers", movers: brief.fallers ?? [], color: HobbyIQTheme.Colors.danger, icon: "arrow.down.right")
                briefMoverSection(title: "Breakouts", movers: brief.breakouts ?? [], color: HobbyIQTheme.Colors.electricBlue, icon: "star.fill")
            } else {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "newspaper")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text("No mover data available yet.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer(minLength: 0)
                }
                .padding(10)
                .background(HobbyIQTheme.Colors.mutedText.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }

    // MARK: - Market Signals (CF-DAILYIQ-MARKET-PLAYERS, 2026-07-01)

    /// Top-level tab-scoped section: four matched-cohort momentum
    /// lists — Trending Up (lagging, prices rising), Cooling Off
    /// (lagging, prices falling), Most Traded (30d volume), Supply
    /// Squeeze (leading: prices rising + listings drying up).
    /// Rendered on every DailyIQ segment (not nested inside `.brief`)
    /// so the signals are visible regardless of which player-stats
    /// segment the user is on. Investor-gated at the callsite via
    /// `.lockedOverlay(feature: .dailyIQBriefs)`. Empty state renders
    /// before the backend job populates.
    @ViewBuilder
    private var marketSignalsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("MARKET SIGNALS")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.6)
                Spacer()
            }
            .padding(.top, 4)

            if isLoadingMarketSignals && marketSignals == nil {
                HStack(spacing: 10) {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Loading market signals…")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
                .padding(.vertical, 10)
            } else if let signals = marketSignals {
                if signals.generatedAt == nil {
                    marketSignalsEmptyState(note: signals.note)
                } else {
                    // CF-BOWMAN-2YR-LISTS (2026-07-02, PR #247): sub-tab
                    // between the full matched-cohort universe and the
                    // Bowman-set 2yr subset. Segment styled subtly so
                    // it reads as a filter on the Market Signals card,
                    // not a peer of the top-level "Your Players /
                    // Market Trends" segment.
                    Picker("", selection: $marketTab) {
                        ForEach(DailyIQMarketTab.allCases) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.top, 2)

                    switch marketTab {
                    case .allMarket:
                        marketPlayerSection(
                            title: "Trending Up",
                            subtitle: marketSectionSubtitle(from: signals.trending?.first?.latestWeekStart),
                            entries: signals.trending ?? [],
                            color: HobbyIQTheme.Colors.hobbyGreen,
                            icon: "arrow.up.right",
                            signal: .positive
                        )
                        marketPlayerSection(
                            title: "Cooling Off",
                            subtitle: marketSectionSubtitle(from: signals.fading?.first?.latestWeekStart),
                            entries: signals.fading ?? [],
                            color: HobbyIQTheme.Colors.danger,
                            icon: "arrow.down.right",
                            signal: .negative
                        )
                        marketVolumeSection(
                            title: "Most Traded (30d)",
                            entries: signals.topVolume30d ?? []
                        )
                        marketSupplySection(
                            title: "Supply Squeeze",
                            entries: signals.supplyDryLeadingUp ?? []
                        )
                    case .bowman2y:
                        marketVolumeSection(
                            title: "Bowman 2Y — Top Volume (30d)",
                            entries: signals.bowman2yrTopVolume30d ?? []
                        )
                        marketPlayerSection(
                            title: "Bowman 2Y — Top Momentum",
                            subtitle: marketSectionSubtitle(from: signals.bowman2yrTopMomentum?.first?.latestWeekStart),
                            entries: signals.bowman2yrTopMomentum ?? [],
                            color: HobbyIQTheme.Colors.electricBlue,
                            icon: "sparkles",
                            signal: .positive
                        )
                        if (signals.bowman2yrTopVolume30d?.isEmpty ?? true)
                            && (signals.bowman2yrTopMomentum?.isEmpty ?? true) {
                            marketSignalsEmptyState(note: "Bowman 2Y lists populating — check back after the next cohort cycle.")
                        }
                    }

                    if let updatedFooter = marketUpdatedFooter(from: signals.generatedAt) {
                        Text(updatedFooter)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .padding(.top, 4)
                    }
                }
            }
        }
    }

    private func marketSignalsEmptyState(note: String?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "hourglass")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(note?.isEmpty == false
                 ? note!
                 : "Market signals populating overnight — check back tomorrow.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(HobbyIQTheme.Colors.mutedText.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func marketPlayerSection(
        title: String,
        subtitle: String?,
        entries: [DailyIQMarketPlayerEntry],
        color: Color,
        icon: String,
        signal: HIQSignal
    ) -> some View {
        Group {
            if entries.isEmpty == false {
                dailyIQSectionCard {
                    marketSubsectionHeader(
                        title: title,
                        subtitle: subtitle,
                        icon: icon,
                        color: color,
                        count: entries.count,
                        badge: nil,
                        explainerKey: "market-players"
                    )
                    VStack(spacing: 8) {
                        ForEach(entries.prefix(20)) { entry in
                            Button {
                                playerIQName = entry.player
                            } label: {
                                marketPlayerRow(entry: entry, signal: signal)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): row is now its own faint
    /// tinted card (via `hiqSignalTint(_:)`) with a leading monogram
    /// avatar, trimmed metadata (dropped the redundant "this week" /
    /// "week of X" — the section header carries the week), and an
    /// `HIQBadge` trailing pill instead of a bare percent.
    private func marketPlayerRow(
        entry: DailyIQMarketPlayerEntry,
        signal: HIQSignal
    ) -> some View {
        HStack(alignment: .center, spacing: 10) {
            HIQAvatar(from: entry.player)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.player)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                let metaParts: [String] = {
                    var parts: [String] = []
                    if let size = entry.cohortSize, size > 0 { parts.append("\(size) cards") }
                    if let active = entry.latestWeekActiveCards, active > 0 { parts.append("\(active) sold") }
                    return parts
                }()
                if metaParts.isEmpty == false {
                    Text(metaParts.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            Spacer(minLength: 8)
            if let pct = signedPercent(from: entry.medianRatio) {
                HIQBadge(text: pct, signal: signal)
            }
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .hiqSignalTint(signal)
    }

    private func marketVolumeSection(
        title: String,
        entries: [DailyIQMarketVolumeEntry]
    ) -> some View {
        Group {
            if entries.isEmpty == false {
                dailyIQSectionCard {
                    marketSubsectionHeader(
                        title: title,
                        subtitle: nil,
                        icon: "chart.bar.fill",
                        color: HobbyIQTheme.Colors.electricBlue,
                        count: entries.count,
                        badge: nil,
                        explainerKey: "market-volume"
                    )
                    VStack(spacing: 8) {
                        ForEach(entries.prefix(20)) { entry in
                            Button {
                                playerIQName = entry.player
                            } label: {
                                HStack(alignment: .center, spacing: 10) {
                                    HIQAvatar(from: entry.player)
                                    Text(entry.player)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                    Spacer(minLength: 8)
                                    if let sales = entry.totalSales30d {
                                        HIQBadge(
                                            text: compactSalesText(sales),
                                            signal: .neutral,
                                            systemImage: "cart"
                                        )
                                    }
                                    Image(systemName: "chevron.right")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                                .hiqSignalTint(.neutral)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): compact number formatting
    /// so a badge shows "81.3K" instead of "81,340" — keeps large
    /// numbers from blowing out the trailing pill on narrow rows. The
    /// "sales" noun lives in the section header ("Most Traded"), so
    /// the pill text stays terse.
    private func compactSalesText(_ count: Int) -> String {
        if count >= 1000 {
            let thousands = Double(count) / 1000.0
            if thousands >= 100 {
                return String(format: "%.0fK", thousands)
            }
            return String(format: "%.1fK", thousands)
        }
        return count.formatted(.number)
    }

    private func marketSupplySection(
        title: String,
        entries: [DailyIQMarketSupplyEntry]
    ) -> some View {
        Group {
            if entries.isEmpty == false {
                dailyIQSectionCard {
                    marketSubsectionHeader(
                        title: title,
                        subtitle: nil,
                        icon: "arrow.triangle.merge",
                        color: HobbyIQTheme.Colors.hobbyGreen,
                        count: entries.count,
                        badge: "LEADING",
                        explainerKey: "market-supply"
                    )
                    VStack(spacing: 8) {
                        ForEach(entries.prefix(20)) { entry in
                            Button {
                                playerIQName = entry.player
                            } label: {
                                HStack(alignment: .center, spacing: 10) {
                                    HIQAvatar(from: entry.player)
                                    Text(entry.player)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                    Spacer(minLength: 8)
                                    if let supplyText = supplyChangeText(from: entry.volumeRatio) {
                                        HIQBadge(
                                            text: supplyText,
                                            signal: .positive,
                                            systemImage: "arrow.down.right"
                                        )
                                    }
                                    Image(systemName: "chevron.right")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                                .hiqSignalTint(.positive)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): elevated subsection header.
    /// Icon in a colored rounded-square chip, title in bold subheadline,
    /// count as a tinted pill on the trailing edge. `explainerKey` adds
    /// an `info.circle` tap-target that shows a popover with the copy —
    /// dedupes the inline explainer paragraphs we used to render under
    /// every section header.
    private func marketSubsectionHeader(
        title: String,
        subtitle: String?,
        icon: String,
        color: Color,
        count: Int,
        badge: String?,
        explainerKey: String? = nil
    ) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 32, height: 32)
                .background(color.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if let badge {
                        Text(badge)
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                            .clipShape(Capsule())
                    }
                    if let explainerKey, explainerCopy(for: explainerKey) != nil {
                        Button {
                            explainerPopoverKey = explainerKey
                        } label: {
                            Image(systemName: "info.circle")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            Spacer()
            Text("\(count)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(color.opacity(0.14))
                .clipShape(Capsule())
        }
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): sheet body for section
    /// explainers. Reads the copy for the active `explainerPopoverKey`.
    @ViewBuilder
    private var explainerSheet: some View {
        if let key = explainerPopoverKey, let copy = explainerCopy(for: key) {
            VStack(alignment: .leading, spacing: 12) {
                Text(copy.title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(copy.body)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
            .background(HobbyIQBackground().ignoresSafeArea())
            .presentationDetents([.fraction(0.28)])
            .presentationDragIndicator(.visible)
        }
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): explainer copy keyed by
    /// section id. Preserves the original inline captions we used to
    /// render under every section — surfaced now on tap only.
    private func explainerCopy(for key: String) -> (title: String, body: String)? {
        switch key {
        case "market-players":
            return ("Cohort momentum",
                    "Median week-over-window price change across each player's matched card cohort. Positive = prices trending up, negative = prices cooling.")
        case "market-volume":
            return ("Trailing 30-day volume",
                    "Total cohort sales over the trailing 30 days — a raw liquidity signal. Higher volume = deeper market, more comparable data.")
        case "market-supply":
            return ("Leading indicator",
                    "Rising price with fewer listings. Supply drying up before demand cools is a leading buy signal.")
        case "your-players":
            return ("Your holdings, ranked",
                    "Each player you own, sorted by holding count. Trend arrow reads from the matched-cohort median (or momentum ratio when cohort match is still populating).")
        default:
            return nil
        }
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): now delegates to the
    /// shared `hiqGroupCard()` modifier in `DesignSystem/HIQCardStyles.swift`
    /// so DailyIQ sections read with the exact same rounded-container
    /// gradient border used by the card detail screen — same corner
    /// radius (xLarge), stroke, shadow. Nothing invented locally.
    @ViewBuilder
    private func dailyIQSectionCard<Content: View>(
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqGroupCard()
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-06): compact circular rank
    /// badge shown at the leading edge of each market row.
    private func rankBadge(_ rank: Int, tint: Color) -> some View {
        Text("\(rank)")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(tint)
            .frame(width: 22, height: 22)
            .background(tint.opacity(0.14))
            .clipShape(Circle())
    }

    /// CF-DAILYIQ-VISUAL-REFRESH (2026-07-06): tabular-numeric pill used
    /// for the trailing value on market rows (percent moves, sale counts,
    /// supply drops). Tinted background matches the section's tint.
    private func valuePill(_ text: String, tint: Color, systemImage: String? = nil) -> some View {
        HStack(spacing: 3) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2.weight(.bold))
            }
            Text(text)
                .font(.caption.weight(.bold).monospacedDigit())
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tint.opacity(0.14))
        .clipShape(Capsule())
    }

    /// medianRatio (raw ratio centered on 1.0) → "+36%" / "-21%".
    /// Returns nil on missing / flat (±1%) ratios so the pill hides.
    private func signedPercent(from ratio: Double?) -> String? {
        guard let ratio, ratio > 0 else { return nil }
        let pct = (ratio - 1.0) * 100
        guard abs(pct) >= 1.0 else { return nil }
        let sign = pct >= 0 ? "+" : ""
        return "\(sign)\(Int(pct.rounded()))%"
    }

    /// volumeRatio < 1.0 → supply drying up. Rendered as "-28%" (the
    /// pill lives inside the "Supply Squeeze" section, so the "supply"
    /// noun is already implicit — keep the pill terse). Values >= 1.0
    /// suppress the pill — Supply Squeeze rows are always drying supply.
    private func supplyChangeText(from ratio: Double?) -> String? {
        guard let ratio, ratio > 0, ratio < 1.0 else { return nil }
        let pct = Int(((1.0 - ratio) * 100).rounded())
        return "-\(pct)%"
    }

    /// "Week of Jun 22" subtitle parsed from latestWeekStart (ISO date).
    private func marketSectionSubtitle(from isoDate: String?) -> String? {
        guard let isoDate else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withFullDate]
        guard let date = iso.date(from: isoDate) else { return nil }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return "Week of \(df.string(from: date))"
    }

    /// "Updated 6h ago" from an ISO8601 generatedAt timestamp.
    private func marketUpdatedFooter(from generatedAt: String?) -> String? {
        guard let generatedAt else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: generatedAt) ?? {
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return plain.date(from: generatedAt)
        }()
        guard let date else { return nil }
        let rf = RelativeDateTimeFormatter()
        rf.unitsStyle = .abbreviated
        return "Updated \(rf.localizedString(for: date, relativeTo: Date()))"
    }

    private func briefMoverSection(title: String, movers: [DailyBriefMover], color: Color, icon: String) -> some View {
        Group {
            if !movers.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: icon)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(color)
                        Text(title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                        Text("\(movers.count)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(color)
                    }

                    ForEach(movers) { mover in
                        Button {
                            playerIQName = mover.playerName
                        } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(mover.playerName)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                    HStack(spacing: 6) {
                                        if let team = mover.team {
                                            Text(team)
                                                .font(.caption2.weight(.medium))
                                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                        }
                                        if let level = mover.level {
                                            Text(level)
                                                .font(.caption2.weight(.medium))
                                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                        }
                                    }
                                }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 2) {
                                    if let pct = mover.pctChange {
                                        Text(String(format: "%+.1f%%", pct))
                                            .font(.subheadline.weight(.bold).monospacedDigit())
                                            .foregroundStyle(color)
                                    }
                                    if let reason = mover.reason {
                                        Text(reason)
                                            .font(.caption2)
                                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                            .lineLimit(1)
                                    }
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(HobbyIQTheme.Colors.cardNavy)
                            .overlay(
                                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                                    .stroke(color.opacity(0.2), lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - Search / Top / Suggest Methods

    private func searchPlayers(query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            searchResults = []
            if !trimmed.isEmpty { await addWatchlistEntry(from: trimmed) }
            return
        }

        guard sessionViewModel.subscriptionManager.has(GatedFeature.watchlist) else {
            service.errorMessage = "Upgrade to Collector+ to search and add players to your watchlist."
            return
        }

        isSearching = true
        searchResults = []
        defer { isSearching = false }

        do {
            let response = try await APIService.shared.watchlistSearch(query: trimmed)
            searchResults = response.results ?? []
            if searchResults.isEmpty {
                await addWatchlistEntry(from: trimmed)
            }
        } catch {
            await addWatchlistEntry(from: trimmed)
        }
    }

    private func addFromSearchResult(_ result: PlayerSearchResult) async {
        searchResults = []
        watchlistQuery = ""
        await addWatchlistEntry(from: result.playerName)
    }

    private func loadTopAndSuggest() async {
        if let response = try? await APIService.shared.watchlistTop() {
            topWatched = response.entries ?? []
        }
        if let response = try? await APIService.shared.watchlistSuggest() {
            suggestions = response.suggestions ?? []
        }
    }

    private func loadFullBrief() async {
        guard fullBrief == nil else { return }
        isLoadingBrief = true
        defer { isLoadingBrief = false }

        do {
            fullBrief = try await APIService.shared.fetchFullBrief()
        } catch {
            fullBrief = nil
        }
    }

    // PR #425 (2026-07-13): pull watchlisted players trending bull.
    // Silent fall-through on failure keeps the surface hidden rather
    // than surfacing a broken card.
    private func loadBuyCandidates() async {
        do {
            let response = try await APIService.shared.fetchWatchlistBullCandidates()
            await MainActor.run { buyCandidates = response }
        } catch {
            // Nil keeps the section hidden.
        }
    }

    /// Buy Candidates section — watchlisted players whose supply/demand
    /// verdict is bullish, ranked by listings slope. Tap → open the
    /// PlayerIQ full-screen for that player (same navigation the
    /// suggestions row uses). Hidden when the response is nil or
    /// carries zero candidates.
    // MARK: - Phase 3.7: Hot Right Now (2026-07-17, PR #529)

    /// Top 5 players by hotScore. Tap "See top 25" pushes a full-list
    /// view. Self-suppresses when the response is nil or players is empty.
    @ViewBuilder
    private var hotRightNowSection: some View {
        if let response = hotRightNow,
           let players = response.players, players.isEmpty == false {
            let top5 = Array(players.prefix(5))
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Text("\u{1F525}")
                        .font(.title3)
                    Text("Hot Right Now")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                }
                VStack(spacing: 8) {
                    ForEach(Array(top5.enumerated()), id: \.element.id) { idx, player in
                        hotPlayerRow(index: idx + 1, player: player)
                    }
                }
                if players.count > 5 {
                    Button {
                        showHotRightNowFullList = true
                    } label: {
                        HStack(spacing: 4) {
                            Text("See top \(min(players.count, 25))")
                                .font(.caption.weight(.bold))
                            Image(systemName: "arrow.right")
                                .font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .navigationDestination(isPresented: $showHotRightNowFullList) {
                HotRightNowListView(response: response)
                    .environmentObject(sessionViewModel)
            }
        }
    }

    @ViewBuilder
    private func hotPlayerRow(index: Int, player: HotPlayer) -> some View {
        let direction = player.direction?.lowercased() ?? ""
        let color: Color = {
            switch direction {
            case "up": return HobbyIQTheme.Colors.successGreen
            case "down": return HobbyIQTheme.Colors.danger
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()
        let glyph: String = {
            switch direction {
            case "up": return "\u{25B2}"
            case "down": return "\u{25BC}"
            default: return "\u{2500}"
            }
        }()
        let sparse = player.hasFlag("sparse") || player.hasFlag("wide_ratio_dispersion")

        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text("\(index).")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(width: 24, alignment: .leading)
                Text(player.player ?? "—")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(glyph)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(color)
                if let pct = player.momentumPercentString {
                    Text(pct)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(color)
                }
                if let velocity = player.velocityPerWeek {
                    Text("\(Int(velocity.rounded()))/wk")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            if let qualifying = player.qualifyingCards,
               let pool = player.cardsInPool, pool > 0 {
                Text("\(qualifying) of \(pool) cards agree")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .padding(.leading, 32)
            }
        }
        .opacity(sparse ? 0.55 : 1.0)
    }

    private func loadHotRightNow() async {
        do {
            hotRightNow = try await APIService.shared.fetchHotRightNow(limit: 25)
        } catch {
            // Best-effort — tile hides on failure.
        }
    }

    // MARK: - Batch 2: Sell-Now Radar / Value Hunter / Notable Sales banners

    /// Compact banner surfaced when the sell-now radar returns candidates.
    /// Tap opens `SellNowRadarListView`. Hidden on zero.
    @ViewBuilder
    private var sellNowRadarBanner: some View {
        if let response = sellNowRadar,
           let count = response.count, count > 0,
           let top = response.candidates?.first {
            NavigationLink {
                SellNowRadarListView(response: response)
            } label: {
                bannerContent(
                    glyph: "\u{1F6A8}",
                    title: "\(count) card\(count == 1 ? "" : "s") to sell now",
                    subtitle: sellRadarBannerSubtitle(top),
                    accent: HobbyIQTheme.Colors.danger
                )
            }
            .buttonStyle(.plain)
            .navigationDestination(isPresented: $showSellNowRadar) {
                SellNowRadarListView(response: response)
            }
        }
    }

    private func sellRadarBannerSubtitle(_ top: SellRadarCandidate) -> String {
        let player = top.player ?? "your holding"
        if let mult = top.velocityMultiple {
            return "Top: \(player) — \(String(format: "%.1f", mult))× baseline velocity"
        }
        return "Top: \(player)"
    }

    /// Value Hunter tile — always visible entry to Sub-Raw Discovery.
    /// Doesn't gate on a preload since the drill-down does its own fetch.
    @ViewBuilder
    private var valueHunterBanner: some View {
        NavigationLink {
            SubRawDiscoveryListView()
        } label: {
            bannerContent(
                glyph: "\u{1F50E}",
                title: "Value Hunter",
                subtitle: "Raw cards trading below their PSA 10 potential",
                accent: HobbyIQTheme.Colors.electricBlue
            )
        }
        .buttonStyle(.plain)
        .navigationDestination(isPresented: $showSubRawDiscovery) {
            SubRawDiscoveryListView()
        }
    }

    /// Notable-sales banner — top-dollar recent sales. Hidden when empty.
    @ViewBuilder
    private var notableSalesBanner: some View {
        if let response = notableSales,
           let sales = response.sales, sales.isEmpty == false,
           let top = sales.first {
            NavigationLink {
                NotableSalesListView(response: response)
            } label: {
                bannerContent(
                    glyph: "\u{1F3C6}",
                    title: "Notable sales",
                    subtitle: notableSaleBannerSubtitle(top),
                    accent: HobbyIQTheme.Colors.warning
                )
            }
            .buttonStyle(.plain)
            .navigationDestination(isPresented: $showNotableSales) {
                NotableSalesListView(response: response)
            }
        }
    }

    private func notableSaleBannerSubtitle(_ sale: NotableSale) -> String {
        let price = sale.price.map(portfolioCurrencyString) ?? "—"
        let identity = [sale.year.map(String.init), sale.player]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { $0.isEmpty == false }
            .joined(separator: " ")
        return identity.isEmpty ? "Top: \(price)" : "Top: \(price) — \(identity)"
    }

    @ViewBuilder
    private func bannerContent(glyph: String, title: String, subtitle: String, accent: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(glyph).font(.title2)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 4) {
                    Text("Open")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(accent)
                    Image(systemName: "arrow.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(accent)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(accent.opacity(0.4), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func loadSellNowRadar() async {
        do { sellNowRadar = try await APIService.shared.fetchSellNowRadar() } catch { }
    }

    private func loadNotableSales() async {
        do { notableSales = try await APIService.shared.fetchNotableSales(limit: 20) } catch { }
    }

    @ViewBuilder
    private var buyCandidatesSection: some View {
        if let candidates = buyCandidates?.candidates, candidates.isEmpty == false {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Buy Candidates")
                        .font(.caption.weight(.bold))
                        .tracking(0.8)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
                Text("\(candidates.count) watchlisted \(candidates.count == 1 ? "player" : "players") trending bull:")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                VStack(spacing: 8) {
                    ForEach(candidates.prefix(6)) { candidate in
                        buyCandidateRow(candidate: candidate)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func buyCandidateRow(candidate: WatchlistBullCandidatesResponse.Candidate) -> some View {
        let style = VerdictStyle.from(candidate.verdict)
        let slope = formatSlopePerMonth(candidate.listingsSlopePerMonthPct)
        return Button {
            if let name = candidate.playerName, name.isEmpty == false {
                playerIQName = name
            }
        } label: {
            HStack(spacing: 10) {
                Text(style.emoji).font(.system(size: 16))
                Text(candidate.playerName ?? "—")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer(minLength: 6)
                if let slope {
                    Text("Listings \(slope)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(style.color)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// CF-DAILYIQ-MARKET-PLAYERS (2026-07-01): fetches matched-cohort
    /// momentum lists once per tab visit. Session-scoped cache — the
    /// backend job runs at most once per day so re-fetching on every
    /// re-render is wasteful. Empty payload (generatedAt nil) is a
    /// valid state, NOT an error.
    private func loadMarketSignals() async {
        guard marketSignals == nil else { return }
        isLoadingMarketSignals = true
        defer { isLoadingMarketSignals = false }

        do {
            marketSignals = try await APIService.shared.fetchMarketSignals()
        } catch {
            marketSignals = nil
        }
    }

    /// CF-DAILYIQ-MY-PLAYERS (2026-07-01): personal cohort momentum for
    /// the user's holdings. Same session-scoped cache pattern as
    /// `loadMarketSignals`. Failure is quiet — the view surfaces an
    /// empty state, not an error UI.
    private func loadMyPlayers() async {
        guard myPlayers == nil else { return }
        isLoadingMyPlayers = true
        defer { isLoadingMyPlayers = false }

        do {
            myPlayers = try await APIService.shared.fetchMyPlayersMarket()
        } catch {
            myPlayers = nil
        }
    }

    // MARK: - Segment control (CF-DAILYIQ-TWO-SEGMENTS, 2026-07-01)

    private var dailySegmentControl: some View {
        HStack(spacing: 6) {
            ForEach(DailyIQSegment.allCases) { segment in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        dailySegment = segment
                    }
                } label: {
                    Text(segment.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(dailySegment == segment ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background {
                            if dailySegment == segment {
                                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.pill, style: .continuous)
                                    .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.2))
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(Capsule(style: .continuous))
    }

    // MARK: - Your Players section (CF-DAILYIQ-MY-PLAYERS, 2026-07-01)

    /// Personal matched-cohort momentum. Rows are pre-sorted DESC by
    /// holdingCount server-side. Each row shows the player's aggregate
    /// %-change badge from `matchedCohort.medianRatio` and drills to a
    /// sheet listing the user's owned cards in that cohort. Rows with
    /// null matchedCohort fall back to `momentumRatio` / `supplyTrend`
    /// so the view degrades gracefully in the first-day production
    /// window (many players have no cohort match yet).
    @ViewBuilder
    private var yourPlayersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "person.crop.rectangle.stack.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("YOUR PLAYERS")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.6)
                Spacer()
            }
            .padding(.top, 4)

            if isLoadingMyPlayers && myPlayers == nil {
                HStack(spacing: 10) {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Loading your players…")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
                .padding(.vertical, 10)
            } else if let response = myPlayers {
                let entries = response.myPlayers ?? []
                if entries.isEmpty {
                    myPlayersEmptyState
                } else {
                    // CF-DAILYIQ-MY-PLAYERS-UP-DOWN (2026-07-02): split
                    // CF-YOUR-PLAYERS-UNIFIED (2026-07-07): dropped the
                    // Trending Up / Trending Down partition. Now renders
                    // one card, sorted DESC by resolved trend ratio
                    // (highest gain on top, biggest loss at the bottom).
                    // Per-row direction still reads via the row's own
                    // signal (positive/negative/neutral) — badge color
                    // + subtle row tint.
                    myPlayersUnifiedSection(entries: sortedMyPlayers(entries))
                    if let updatedFooter = marketUpdatedFooter(from: response.generatedAt) {
                        Text(updatedFooter)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .padding(.top, 4)
                    }
                }
            }
        }
    }

    private func trendRatio(for entry: DailyIQMyPlayerEntry) -> Double? {
        if let cohort = entry.matchedCohort, let r = cohort.medianRatio { return r }
        return entry.momentumRatio
    }

    /// CF-YOUR-PLAYERS-UNIFIED (2026-07-07): single sorted list, high
    /// to low by resolved trend ratio. Entries with no ratio drop to
    /// the bottom so the user still sees every player they own.
    private func sortedMyPlayers(_ entries: [DailyIQMyPlayerEntry]) -> [DailyIQMyPlayerEntry] {
        entries.sorted { lhs, rhs in
            switch (trendRatio(for: lhs), trendRatio(for: rhs)) {
            case let (l?, r?):  return l > r
            case (_?, nil):     return true
            case (nil, _?):     return false
            case (nil, nil):    return false
            }
        }
    }

    /// CF-YOUR-PLAYERS-UNIFIED (2026-07-07): pick a per-row signal
    /// (used for tint + badge color) from the same resolved ratio the
    /// sort consults. Nil ratio → neutral.
    private func signalForMyPlayer(_ entry: DailyIQMyPlayerEntry) -> HIQSignal {
        guard let r = trendRatio(for: entry) else { return .neutral }
        return r >= 1.0 ? .positive : .negative
    }

    /// CF-YOUR-PLAYERS-UNIFIED (2026-07-07): one section listing every
    /// player the user owns, sorted DESC by trend ratio (biggest gain
    /// on top, biggest loss at the bottom). Per-row direction still
    /// reads through the row's own signal (positive / negative /
    /// neutral) — badge color + subtle row tint.
    @ViewBuilder
    private func myPlayersUnifiedSection(entries: [DailyIQMyPlayerEntry]) -> some View {
        dailyIQSectionCard {
            marketSubsectionHeader(
                title: "Ranked",
                subtitle: nil,
                icon: "person.crop.rectangle.stack.fill",
                color: HobbyIQTheme.Colors.electricBlue,
                count: entries.count,
                badge: nil,
                explainerKey: "your-players"
            )
            VStack(spacing: 8) {
                ForEach(entries) { entry in
                    let signal = signalForMyPlayer(entry)
                    Button {
                        if entry.ownedCardsInCohort?.isEmpty == false {
                            drillPlayer = entry
                        }
                    } label: {
                        myPlayerRow(entry, signal: signal)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var myPlayersEmptyState: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "square.stack.3d.up")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("Add holdings to see your personal trends.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(HobbyIQTheme.Colors.mutedText.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func myPlayerRow(_ entry: DailyIQMyPlayerEntry, signal: HIQSignal) -> some View {
        HStack(alignment: .center, spacing: 10) {
            HIQAvatar(from: entry.player)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.player)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                let metaParts: [String] = {
                    var parts: [String] = []
                    if let count = entry.holdingCount, count > 0 {
                        parts.append(count == 1 ? "1 holding" : "\(count) holdings")
                    }
                    if let cohort = entry.matchedCohort,
                       let size = cohort.cohortSize, size > 0 {
                        parts.append("\(size) cards")
                    }
                    return parts
                }()
                if metaParts.isEmpty == false {
                    Text(metaParts.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            Spacer(minLength: 8)
            myPlayerTrendBadge(entry)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .hiqSignalTint(signal)
    }

    /// CF-DAILYIQ-BADGE-CONSISTENCY (2026-07-06): badge must lock to the
    /// SAME resolved ratio the partition uses (`trendRatio(for:)`) so a
    /// player never lands in "Trending Down" while showing a green up
    /// arrow. Previously the badge could fall back from a subthreshold
    /// cohort ratio (e.g. -0.4%, hidden by `signedPercent`'s ±1% floor)
    /// to `momentumRatio`, which is a different signal in a different
    /// direction — that's the "leaking wrong players" symptom.
    @ViewBuilder
    private func myPlayerTrendBadge(_ entry: DailyIQMyPlayerEntry) -> some View {
        let cohortRatioPresent = entry.matchedCohort?.medianRatio != nil
        if let ratio = trendRatio(for: entry) {
            let isUp = ratio >= 1.0
            let tint = isUp ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.danger
            let opacity = cohortRatioPresent ? 1.0 : 0.75
            if let pct = signedPercent(from: ratio) {
                HStack(spacing: 3) {
                    Image(systemName: isUp ? "arrow.up" : "arrow.down")
                        .font(.caption2.weight(.bold))
                    Text(pct)
                        .font(.caption.weight(.bold))
                        .monospacedDigit()
                }
                .foregroundStyle(tint.opacity(opacity))
            } else {
                // Ratio present but within ±1% — surface the direction
                // (matching the partition) without a fake percent value.
                HStack(spacing: 3) {
                    Image(systemName: isUp ? "arrow.up" : "arrow.down")
                        .font(.caption2.weight(.bold))
                    Text("Flat")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(tint.opacity(opacity * 0.75))
            }
        } else {
            Text("Trend data updating…")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    // CF-DAILYIQ-TREND-FIRST (2026-07-01): milbPlayers / mlbPlayers /
    // currentPlayers retained as internal utilities. Not rendered on
    // the DailyIQ tab anymore (the MLB / MiLB segments were removed);
    // still used by `addWatchlistEntry(from:)` +
    // `watchlistMutationMetadata(for:)` to enrich a name-only watch
    // add with team / level / position when the user's date already
    // has the player's box-score row in memory. Data continues to
    // populate via `refreshDailyIQ` which hits the same /api/dailyiq
    // endpoint the watchlist flow already needs.
    private var milbPlayers: [DailyPlayerStat] {
        Array(service.brief?.topMiLB.prefix(50) ?? [])
    }

    private var mlbPlayers: [DailyPlayerStat] {
        Array(service.brief?.topMLB.prefix(50) ?? [])
    }

    private var currentPlayers: [DailyPlayerStat] {
        milbPlayers + mlbPlayers
    }

    /// CF-DAILYIQ-TREND-FIRST (2026-07-01): hero card subtitle. With
    /// player-stats segments retired, the count line now surfaces just
    /// the watching total. Kept the count line rather than deleting so
    /// the hero doesn't visually collapse.
    private var heroSubtitleText: String {
        let count = trackedWatchlist.count
        return count == 1 ? "1 player on your watchlist" : "\(count) players on your watchlist"
    }

    private func backendStatusBanner(title: String, message: String, systemImage: String = "arrow.triangle.2.circlepath") -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.warning)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.3), lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func addWatchlistEntry(from stat: DailyPlayerStat) async {
        isSyncingWatchlist = true
        defer { isSyncingWatchlist = false }

        guard let backendWatchlist = await service.addWatchlistEntry(
            userId: userId,
            playerId: stat.playerId,
            playerName: stat.playerName,
            team: stat.team,
            level: stat.level,
            position: stat.position,
            referenceDate: selectedDate
        ) else {
            return
        }

        syncWatchlistState(from: backendWatchlist)
        watchlistQuery = ""
        await refreshDailyIQ(for: selectedDate)
    }

    private func addWatchlistEntry(from rawValue: String) async {
        let query = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.isEmpty == false else { return }

        let resolvedStat = currentPlayers.first(where: {
            $0.playerName.caseInsensitiveCompare(query) == .orderedSame ||
            $0.playerName.localizedCaseInsensitiveContains(query) ||
            query.localizedCaseInsensitiveContains($0.playerName)
        })

        if let resolvedStat {
            await addWatchlistEntry(from: resolvedStat)
            return
        }

        // Fallback for manual search — use playerName as playerId
        isSyncingWatchlist = true
        defer { isSyncingWatchlist = false }

        guard let backendWatchlist = await service.addWatchlistEntry(
            userId: userId,
            playerId: query,
            playerName: query,
            referenceDate: selectedDate
        ) else {
            return
        }

        syncWatchlistState(from: backendWatchlist)
        watchlistQuery = ""
        await refreshDailyIQ(for: selectedDate)
    }

    /// Add a watchlist entry from a backend-provided suggestion. The suggestion
    /// carries a real `playerId` from the dispatcher so we pass it through —
    /// the prior name-only path forced the backend into fuzzy-match-by-name,
    /// which often failed (404) and made the save silently not stick.
    private func addWatchlistEntry(from sug: WatchlistSuggestion) async {
        isSyncingWatchlist = true
        defer { isSyncingWatchlist = false }

        guard let backendWatchlist = await service.addWatchlistEntry(
            userId: userId,
            playerId: sug.playerId ?? sug.playerName,
            playerName: sug.playerName,
            team: sug.teamName,
            level: sug.level,
            position: sug.position,
            referenceDate: selectedDate
        ) else {
            return
        }

        syncWatchlistState(from: backendWatchlist)
        watchlistQuery = ""
        await refreshDailyIQ(for: selectedDate)
    }

    private func removeWatchlistEntry(_ entry: DailyWatchlistEntry) async {
        isSyncingWatchlist = true
        defer { isSyncingWatchlist = false }

        let metadata = watchlistMutationMetadata(for: entry)
        guard let backendWatchlist = await service.removeWatchlistEntry(
            userId: userId,
            playerId: entry.playerId,
            playerName: entry.playerName,
            team: metadata.team,
            level: metadata.level,
            position: metadata.position,
            referenceDate: selectedDate
        ) else {
            return
        }

        syncWatchlistState(from: backendWatchlist)
        await refreshDailyIQ(for: selectedDate)
    }

    private func toggleWatch(for stat: DailyPlayerStat) async {
        if watchedPlayerNames.contains(stat.playerName) {
            let entry = trackedWatchlist.first { $0.playerName.caseInsensitiveCompare(stat.playerName) == .orderedSame }
                ?? DailyWatchlistEntry(
                    playerId: stat.playerId,
                    playerName: stat.playerName,
                    teamLeague: "\(stat.team) • \(stat.level)",
                    dailyStats: stat.todayLine,
                    seasonStats: stat.seasonLine,
                    trend: stat.trendBadgeText
                )
            await removeWatchlistEntry(entry)
        } else {
            await addWatchlistEntry(from: stat)
        }
    }

    private func syncWatchlistState(from backendWatchlist: [WatchPlayerResult]) {
        let entries = backendWatchlist.map(DailyWatchlistEntry.init(result:))
        trackedWatchlist = entries
        watchedPlayerNames = Set(entries.map(\.playerName))
    }

    private func watchlistMutationMetadata(for entry: DailyWatchlistEntry) -> (team: String?, level: String?, position: String?) {
        if let stat = currentPlayers.first(where: { $0.playerName.caseInsensitiveCompare(entry.playerName) == .orderedSame }) {
            return (stat.team, stat.level, stat.position)
        }

        let team = entry.teamName.isEmpty ? nil : entry.teamName
        let level = entry.level.isEmpty ? nil : entry.level
        let position = entry.position.isEmpty ? nil : entry.position
        if team != nil || level != nil || position != nil {
            return (team, level, position)
        }

        let parts = entry.teamLeague.split(separator: "•").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let fallbackTeam = parts.first
        let fallbackLevel = parts.count > 1 ? String(parts[1]) : nil
        return (fallbackTeam, fallbackLevel, nil)
    }

    private func refreshDailyIQ(for date: Date?) async {
        async let refreshTask: Void = service.refreshAll(userId: userId, referenceDate: date)
        async let watchlistTask = service.refreshWatchlist(userId: userId, referenceDate: date)

        _ = await refreshTask
        if let backendWatchlist = await watchlistTask {
            syncWatchlistState(from: backendWatchlist)
        }

        // Sync the date picker to match the date the backend actually returned
        if let briefDate = service.brief?.date,
           let parsed = DailyIQService.parseAPIDate(briefDate) {
            if Calendar.current.isDate(parsed, inSameDayAs: selectedDate) == false {
                selectedDate = parsed
            }
        }
    }
}

// CF-UNIFY-SECTION-HEADERS (2026-06-17): delegates to the shared
// HIQSectionHeader.
private func dailySectionHeader(_ title: String) -> some View {
    HIQSectionHeader(title)
}

private struct DailyPlayerRoleSection: View {
    let title: String
    let players: [DailyPlayerStat]
    let isTracked: (DailyPlayerStat) -> Bool
    let onToggleWatch: (DailyPlayerStat) -> Void
    let onSelectPlayer: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
            HIQSectionHeader(title)

            LazyVStack(spacing: HobbyIQTheme.Spacing.medium) {
                ForEach(players.prefix(50)) { stat in
                    Button {
                        onSelectPlayer(stat.playerName)
                    } label: {
                        DailyPlayerStatRow(
                            stat: stat,
                            isTracked: isTracked(stat),
                            onToggleWatch: { onToggleWatch(stat) }
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct FlowChipsView<Item: Hashable>: View {
    let title: String
    let items: [Item]
    let action: (Item) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HIQSectionHeader(title)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(items, id: \.self) { item in
                        Button {
                            action(item)
                        } label: {
                            Text(String(describing: item))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.16))
                                .overlay(
                                    Capsule(style: .continuous)
                                        .stroke(HobbyIQTheme.Colors.steelGray, lineWidth: 1.2)
                                )
                                .clipShape(Capsule(style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

// CF-DAILYIQ-TWO-SEGMENTS (2026-07-01): 2-option segment control.
// Replaces the 4-option DailySegment enum (Watchlist / MLB / MiLB /
// Brief) that was removed in the trend-first sweep.
enum DailyIQSegment: String, CaseIterable, Identifiable {
    case myPlayers = "Your Players"
    case discover = "Market Trends"

    var id: String { rawValue }
    var title: String { rawValue }
}

// CF-BOWMAN-2YR-LISTS (2026-07-02, PR #247): sub-tab for the Market
// Signals card. `.allMarket` renders the full matched-cohort lists
// (Trending / Fading / Most Traded / Supply Squeeze). `.bowman2y`
// renders the Bowman-set 2yr subset (Top Volume + Top Momentum),
// which populates after the matched-cohort widening cycle warms.
enum DailyIQMarketTab: String, CaseIterable, Identifiable {
    case allMarket = "All Market"
    case bowman2y = "Bowman 2Y"

    var id: String { rawValue }
}

// MARK: - Owned Cards In Cohort drill-down sheet
// (CF-DAILYIQ-MY-PLAYERS, 2026-07-01)

/// Presented from a "Your Players" row tap. Lists the user's owned
/// cards inside that player's matched cohort with per-card ratio +
/// latest / prior median price + quantity. Resolves cardId → the
/// stored InventoryCard for a friendly display title when the user
/// still holds it; falls back to a truncated cardId ("Card #ABCD1234")
/// when the local cache doesn't have the row.
private struct OwnedCardsInCohortSheet: View {
    let entry: DailyIQMyPlayerEntry
    @Environment(\.dismiss) private var dismiss
    @State private var localInventory: [InventoryCard] = []

    var body: some View {
        // CF-PAGES-NOT-SHEETS (2026-07-04): pushed page, no inner
        // NavigationStack. Native back replaces the Done toolbar.
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header

                let cards = entry.ownedCardsInCohort ?? []
                if cards.isEmpty {
                    emptyState
                } else {
                    ForEach(cards) { card in
                        row(card)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
        }
        .background(HobbyIQBackground())
        .navigationTitle(entry.player)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            localInventory = await LocalPortfolioProvider.shared.getInventory()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("OWNED IN COHORT")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let cohort = entry.matchedCohort,
               let size = cohort.cohortSize, size > 0 {
                Text("You own \((entry.ownedCardsInCohort ?? []).count) of \(size) cards in this cohort")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    private var emptyState: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "square.stack.3d.up")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("Your holdings for this player haven't been matched into the cohort yet — try again after the next daily cycle.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(HobbyIQTheme.Colors.mutedText.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func row(_ card: DailyIQOwnedCardInCohort) -> some View {
        let title = resolvedCardTitle(for: card.cardId)
        let ratio = card.ratio ?? 1.0
        let isUp = ratio >= 1.0
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(2)
                    if let qty = card.quantity, qty > 0 {
                        Text(qty == 1 ? "You own 1" : "You own \(qty)")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer(minLength: 8)
                if let pct = pctFromRatio(card.ratio) {
                    HStack(spacing: 3) {
                        Image(systemName: isUp ? "arrow.up" : "arrow.down")
                            .font(.caption2.weight(.bold))
                        Text(pct)
                            .font(.caption.weight(.bold))
                            .monospacedDigit()
                    }
                    .foregroundStyle(isUp ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.danger)
                }
            }

            HStack(spacing: 14) {
                if let latest = card.latestWeekMedianPrice {
                    priceCell(label: "Latest", price: latest, count: card.latestWeekSaleCount)
                }
                if let prior = card.priorWindowMedianPrice {
                    priceCell(label: "Prior", price: prior, count: card.priorWindowSaleCount)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func priceCell(label: String, price: Double, count: Int?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption2.weight(.bold))
                .tracking(0.4)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(price.currencyStringNoCents)
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let count, count > 0 {
                Text(count == 1 ? "1 sale" : "\(count) sales")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    /// Resolves cardId → the local InventoryCard's display title.
    /// Falls back to `Card #ABCD1234` when the user no longer holds
    /// the card or the local cache hasn't hydrated yet.
    private func resolvedCardTitle(for cardId: String) -> String {
        if let match = localInventory.first(where: { $0.cardId == cardId }) {
            let stored = match.cardName.trimmingCharacters(in: .whitespacesAndNewlines)
            if stored.isEmpty == false { return stored }
        }
        let prefix = cardId.replacingOccurrences(of: "-", with: "").prefix(8).uppercased()
        return "Card #\(prefix)"
    }

    private func pctFromRatio(_ ratio: Double?) -> String? {
        guard let ratio, ratio > 0 else { return nil }
        let pct = (ratio - 1.0) * 100
        guard abs(pct) >= 1.0 else { return nil }
        let sign = pct >= 0 ? "+" : ""
        return "\(sign)\(Int(pct.rounded()))%"
    }
}

private struct DailyPlayerStatRow: View {
    let stat: DailyPlayerStat
    let isTracked: Bool
    let onToggleWatch: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Row 1: Full name + watch button
            HStack(alignment: .center, spacing: 8) {
                Text(stat.playerName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                Spacer(minLength: 4)

                Button(action: onToggleWatch) {
                    Text(isTracked ? "Watchlist ✓" : "Watchlist +")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(isTracked ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
                .disabled(isTracked)
            }

            // Row 2: Team details
            Text(stat.identityLine)
                .font(.caption.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            // Row 3: Daily stats + highlight badges
            HStack(spacing: 6) {
                Text(stat.headlineStatLine)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                ForEach(stat.highlightBadges, id: \.label) { badge in
                    Text(badge.label)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(badge.color.foreground)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(badge.color.background)
                        .clipShape(Capsule(style: .continuous))
                }
            }

            // Row 4: Season stats
            HStack(spacing: 0) {
                if !stat.opponent.isEmpty {
                    Text("vs \(stat.opponent)")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                    Text("  ·  ")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                }

                Text(stat.seasonContextLine)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

}

private struct DailyWatchlistRow: View {
    let entry: DailyWatchlistEntry
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Row 1: Full name + remove button
            HStack(alignment: .center, spacing: 8) {
                Text(entry.playerName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                Spacer(minLength: 4)

                Button(action: onRemove) {
                    Image(systemName: "minus")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .frame(width: 24, height: 24)
                        .background(HobbyIQTheme.Colors.danger.opacity(0.25))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }

            // Row 2: Team details
            Text(entry.teamLeague)
                .font(.caption.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            // Row 3: Daily stats + flag chips
            if !entry.headlineStatLine.isEmpty {
                HStack(spacing: 6) {
                    Text(entry.headlineStatLine)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    ForEach(entry.flagChips, id: \.self) { chip in
                        Text(chip)
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.15))
                            .clipShape(Capsule(style: .continuous))
                    }
                }
            } else if !entry.dailyStats.isEmpty {
                Text(entry.dailyStats)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            // Row 4: Season stats
            HStack(spacing: 0) {
                if !entry.opponent.isEmpty {
                    Text("vs \(entry.opponent)")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                    Text("  ·  ")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                }

                if !entry.seasonContextLine.isEmpty {
                    Text(entry.seasonContextLine)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                } else {
                    Text(entry.seasonStats)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }

            // No-game message if the player didn't play
            if !entry.played, let msg = entry.noGameMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption2.italic())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}















#Preview {
    NavigationStack {
        DailyIQView()
    }
}
