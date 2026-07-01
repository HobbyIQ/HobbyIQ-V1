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

                if isSyncingWatchlist {
                    backendStatusBanner(
                        title: "Updating watchlist…",
                        message: "Pushing the change to the backend and refreshing DailyIQ."
                    )
                }
                if let message = service.errorMessage {
                    backendStatusBanner(
                        title: "DailyIQ sync issue",
                        message: message,
                        systemImage: "wifi.exclamationmark"
                    )
                }

                // CF-DAILYIQ-TREND-FIRST (2026-07-01): Rebuilt DailyIQ as a
                // trend-first newsfeed. Player-stats segments (MLB / MiLB
                // box scores) removed; Market Signals + card movers +
                // watchlist stack in one scroll. Investor-tier gate on
                // Market Signals + Card Movers matches the prior briefCard
                // gate (both surface the same `dailyIQBriefs` content
                // category).
                marketSignalsSection
                    .lockedOverlay(
                        feature: GatedFeature.dailyIQBriefs,
                        subscriptionManager: sessionViewModel.subscriptionManager
                    ) {
                        showUpgradePaywall = true
                    }

                cardMoversSection
                    .lockedOverlay(
                        feature: GatedFeature.dailyIQBriefs,
                        subscriptionManager: sessionViewModel.subscriptionManager
                    ) {
                        showUpgradePaywall = true
                    }

                watchlistCard
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .background(HobbyIQBackground())
        .toolbar(.hidden, for: .navigationBar)
        .task {
            await refreshDailyIQ(for: nil)
            await loadTopAndSuggest()
            await loadFullBrief()
            await loadMarketSignals()
        }
        .onChange(of: selectedDate) { _, newValue in
            Task { await refreshDailyIQ(for: newValue) }
        }
        .refreshable {
            await refreshDailyIQ(for: selectedDate)
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(sessionViewModel: sessionViewModel)
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

            // CF-DAILYIQ-TREND-FIRST (2026-07-01): count line now
            // surfaces trend-relevant totals only. MLB / MiLB counts
            // dropped with the player-stats segments.
            Text(heroSubtitleText)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
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
                    marketPlayerSection(
                        title: "Trending Up",
                        subtitle: marketSectionSubtitle(from: signals.trending?.first?.latestWeekStart),
                        entries: signals.trending ?? [],
                        color: HobbyIQTheme.Colors.hobbyGreen,
                        icon: "arrow.up.right"
                    )
                    marketPlayerSection(
                        title: "Cooling Off",
                        subtitle: marketSectionSubtitle(from: signals.fading?.first?.latestWeekStart),
                        entries: signals.fading ?? [],
                        color: HobbyIQTheme.Colors.danger,
                        icon: "arrow.down.right"
                    )
                    marketVolumeSection(
                        title: "Most Traded (30d)",
                        entries: signals.topVolume30d ?? []
                    )
                    marketSupplySection(
                        title: "Supply Squeeze",
                        entries: signals.supplyDryLeadingUp ?? []
                    )

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
        icon: String
    ) -> some View {
        Group {
            if entries.isEmpty == false {
                VStack(alignment: .leading, spacing: 8) {
                    marketSubsectionHeader(title: title, subtitle: subtitle, icon: icon, color: color, count: entries.count, badge: nil)
                    ForEach(entries.prefix(5)) { entry in
                        Button {
                            playerIQName = entry.player
                        } label: {
                            HStack(spacing: 10) {
                                Text(entry.player)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                Spacer(minLength: 8)
                                if let pct = signedPercent(from: entry.medianRatio) {
                                    HStack(spacing: 3) {
                                        Image(systemName: entry.medianRatio ?? 1.0 >= 1.0 ? "arrow.up" : "arrow.down")
                                            .font(.caption2.weight(.bold))
                                        Text(pct)
                                            .font(.caption.weight(.bold))
                                            .monospacedDigit()
                                    }
                                    .foregroundStyle(color)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func marketVolumeSection(
        title: String,
        entries: [DailyIQMarketVolumeEntry]
    ) -> some View {
        Group {
            if entries.isEmpty == false {
                VStack(alignment: .leading, spacing: 8) {
                    marketSubsectionHeader(title: title, subtitle: nil, icon: "chart.bar.fill", color: HobbyIQTheme.Colors.electricBlue, count: entries.count, badge: nil)
                    ForEach(entries.prefix(5)) { entry in
                        Button {
                            playerIQName = entry.player
                        } label: {
                            HStack(spacing: 10) {
                                Text(entry.player)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                Spacer(minLength: 8)
                                if let sales = entry.totalSales30d {
                                    Text("\(sales.formatted(.number)) sales")
                                        .font(.caption.weight(.bold))
                                        .monospacedDigit()
                                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func marketSupplySection(
        title: String,
        entries: [DailyIQMarketSupplyEntry]
    ) -> some View {
        Group {
            if entries.isEmpty == false {
                VStack(alignment: .leading, spacing: 8) {
                    marketSubsectionHeader(
                        title: title,
                        subtitle: nil,
                        icon: "arrow.triangle.merge",
                        color: HobbyIQTheme.Colors.hobbyGreen,
                        count: entries.count,
                        badge: "LEADING"
                    )
                    ForEach(entries.prefix(5)) { entry in
                        Button {
                            playerIQName = entry.player
                        } label: {
                            HStack(spacing: 10) {
                                Text(entry.player)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                Spacer(minLength: 8)
                                if let supplyText = supplyChangeText(from: entry.volumeRatio) {
                                    Text(supplyText)
                                        .font(.caption.weight(.bold))
                                        .monospacedDigit()
                                        .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func marketSubsectionHeader(
        title: String,
        subtitle: String?,
        icon: String,
        color: Color,
        count: Int,
        badge: String?
    ) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(color)
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let badge {
                Text(badge)
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(Capsule())
            }
            if let subtitle {
                Text("· \(subtitle)")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
            Text("\(count)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
        }
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

    /// volumeRatio < 1.0 → supply drying up. Rendered as "supply -28%"
    /// (negative percent of the shortfall). Values >= 1.0 suppress the
    /// pill — Supply Squeeze rows are always drying supply.
    private func supplyChangeText(from ratio: Double?) -> String? {
        guard let ratio, ratio > 0, ratio < 1.0 else { return nil }
        let pct = Int(((1.0 - ratio) * 100).rounded())
        return "supply -\(pct)%"
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

// CF-DAILYIQ-TREND-FIRST (2026-07-01): DailySegment enum removed with
// the segment control. DailyIQ is now a single-scroll trend view.

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
