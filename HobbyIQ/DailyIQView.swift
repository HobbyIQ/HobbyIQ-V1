//
//  DailyIQView.swift
//  HobbyIQ
//

import SwiftUI

@MainActor
struct DailyIQView: View {
    private let userId: String
    @ObservedObject private var service: DailyIQService
    @State private var selectedSegment: DailySegment = .watchlist
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

                segmentControl

                switch selectedSegment {
                case .milb:
                    backendPlayersCard(
                        title: "MiLB Daily Prospect Brief",
                        subtitle: "Top MiLB performers for the day",
                        players: milbPlayers
                    )
                case .mlb:
                    backendPlayersCard(
                        title: "MLB Daily Brief",
                        subtitle: "Top MLB performers for the day",
                        players: mlbPlayers
                    )
                case .watchlist:
                    watchlistCard
                case .brief:
                    briefCard
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
            await refreshDailyIQ(for: nil)
            await loadTopAndSuggest()
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

                    Text("Daily player performance & hobby \(Labels.signals)")
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

            // Single calm count line — replaces the bordered sub-card with
            // big colored zeros AND the redundant second date display.
            Text("\(milbPlayers.count) MiLB · \(mlbPlayers.count) MLB · \(trackedWatchlist.count) watching")
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

    private var segmentControl: some View {
        HStack(spacing: 6) {
            ForEach(DailySegment.allCases) { segment in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        selectedSegment = segment
                    }
                } label: {
                    Text(segment.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(selectedSegment == segment ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background {
                            if selectedSegment == segment {
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
                                Task { await addWatchlistEntry(from: sug.playerName) }
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

            // Watchlist entries
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
        }
    }

    private func backendPlayersCard(
        title: String,
        subtitle: String,
        players: [DailyPlayerStat]
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if service.isLoading && players.isEmpty {
                VStack(spacing: 10) {
                    ProgressView()
                        .tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Loading…")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            } else if players.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "person.3")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text("No data available yet.")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(players.prefix(50)) { stat in
                        Button {
                            playerIQName = stat.playerName
                        } label: {
                            DailyPlayerStatRow(
                                stat: stat,
                                isTracked: watchedPlayerNames.contains(stat.playerName),
                                onToggleWatch: { _ = Task { await toggleWatch(for: stat) } }
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - Brief Tab (gated investor+)

    private var briefCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if isLoadingBrief {
                HStack(spacing: 10) {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Loading brief…")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
                .padding(.vertical, 16)
            } else if let brief = fullBrief {
                if let meta = brief.meta {
                    HStack(spacing: 6) {
                        if let gen = meta.generatedAt {
                            Text("Generated: \(gen)")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                        Spacer()
                        if let freshness = meta.dataFreshness {
                            Text(freshness)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                                .clipShape(Capsule())
                        }
                    }
                }

                briefMoverSection(title: "Risers", movers: brief.risers ?? [], color: HobbyIQTheme.Colors.hobbyGreen, icon: "arrow.up.right")
                briefMoverSection(title: "Fallers", movers: brief.fallers ?? [], color: HobbyIQTheme.Colors.danger, icon: "arrow.down.right")
                briefMoverSection(title: "Breakouts", movers: brief.breakouts ?? [], color: HobbyIQTheme.Colors.electricBlue, icon: "star.fill")
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "newspaper")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text("No brief data available yet.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
            }
        }
        .task { await loadFullBrief() }
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

    private var milbPlayers: [DailyPlayerStat] {
        Array(service.brief?.topMiLB.prefix(50) ?? [])
    }

    private var mlbPlayers: [DailyPlayerStat] {
        Array(service.brief?.topMLB.prefix(50) ?? [])
    }

    private var currentPlayers: [DailyPlayerStat] {
        milbPlayers + mlbPlayers
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

private func dailySectionHeader(_ title: String) -> some View {
    HStack(spacing: 10) {
        Rectangle()
            .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
            .frame(height: 1)
        Text(title)
            .font(.caption.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .tracking(1.2)
            .fixedSize()
        Rectangle()
            .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
            .frame(height: 1)
    }
}

private struct DailyPlayerRoleSection: View {
    let title: String
    let players: [DailyPlayerStat]
    let isTracked: (DailyPlayerStat) -> Bool
    let onToggleWatch: (DailyPlayerStat) -> Void
    let onSelectPlayer: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.2)

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
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.2)

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

private enum DailySegment: String, CaseIterable, Identifiable {
    case milb = "MiLB"
    case mlb = "MLB"
    case watchlist = "Watchlist"
    case brief = "Brief"

    var id: String { rawValue }
    var title: String { rawValue }
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
