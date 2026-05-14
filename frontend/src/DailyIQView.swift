import SwiftUI

// MARK: - ViewModel

@MainActor
class DailyIQViewModel: ObservableObject {
    @Published var brief: DailyBriefResponse? = nil
    @Published var selectedDate: Date = Calendar.current.startOfDay(for: Date())
    @Published var watchlist: DailyWatchlistResponse? = nil
    @Published var topWatched: [DailyTopWatchedPlayer] = []
    @Published var watchSuggestions: [DailyWatchSuggestion] = []
    @Published var selectedWatchSuggestion: DailyWatchSuggestion? = nil
    @Published var isLoading = false
    @Published var isRefreshing = false   // pull-to-refresh indicator (brief already visible)
    @Published var isSavingWatchlist = false
    @Published var error: String? = nil
    @Published var watchlistError: String? = nil
    @Published var watchPlayerName = ""

    private var loadTask: Task<Void, Never>? = nil
    private var retryTask: Task<Void, Never>? = nil
    private var suggestionTask: Task<Void, Never>? = nil
    private var briefByDay: [String: DailyBriefResponse] = [:]

    private let briefCacheKey = "dailyiq.brief.cache.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: briefCacheKey),
           let decoded = try? JSONDecoder().decode([String: DailyBriefResponse].self, from: data) {
            // Drop cached entries that have no player data so they don't block a real fetch
            briefByDay = decoded.filter { briefHasData($0.value) }
        }
    }

    private func dayKey(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func persistBriefCache() {
        guard let data = try? JSONEncoder().encode(briefByDay) else { return }
        UserDefaults.standard.set(data, forKey: briefCacheKey)
    }

    private func derivePlayerId(from playerName: String) -> String {
        let lower = playerName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lower
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    func isWatchlisted(playerId: String? = nil, playerName: String) -> Bool {
        guard let items = watchlist?.watchlist else { return false }
        if let playerId, items.contains(where: { $0.playerId == playerId }) {
            return true
        }
        let target = derivePlayerId(from: playerName)
        return items.contains { $0.playerId == target }
    }

    func watchlistItem(for playerName: String) -> DailyWatchlistItem? {
        guard let items = watchlist?.watchlist else { return nil }
        let target = derivePlayerId(from: playerName)
        return items.first { $0.playerId == target }
    }

    // Returns true if data is loaded (always true for non-placeholder response)
    private func briefHasData(_ brief: DailyBriefResponse) -> Bool {
        !(brief.mlb.isEmpty && brief.milb.isEmpty)
    }

    // Schedule a one-shot retry after `delay` seconds if needed
    private func scheduleRetry(sessionId: String?, date: Date, delay: Double = 4.0) {
        retryTask?.cancel()
        retryTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await fetchBrief(sessionId: sessionId, date: date, fresh: true, isBackgroundRetry: true)
        }
    }

    // Core brief fetch — shared by load() and refresh()
    private func fetchBrief(sessionId: String?, date: Date, fresh: Bool, isBackgroundRetry: Bool = false) async {
        let day = dayKey(date)

        if !fresh, let cached = briefByDay[day], briefHasData(cached) {
            brief = cached
            await fetchSecondary(sessionId: sessionId)
            return
        }

        do {
            let result = try await APIService.shared.fetchDailyBrief(date: date, fresh: fresh)
            brief = result
            let hasData = briefHasData(result)
            // If cache/read path returns an empty payload, immediately force a fresh fetch for the same day.
            if !hasData, !fresh {
                await fetchBrief(sessionId: sessionId, date: date, fresh: true, isBackgroundRetry: isBackgroundRetry)
                return
            }

            // Only cache responses that have player data so stale empty entries don't block future loads
            if hasData {
                briefByDay[day] = result
                persistBriefCache()
            } else if !isBackgroundRetry {
                // Fresh data still not ready yet — schedule a retry in 5 s
                scheduleRetry(sessionId: sessionId, date: date, delay: 5.0)
            }
            // Secondary data — doesn't affect brief visibility
            await fetchSecondary(sessionId: sessionId)
        } catch {
            if !isBackgroundRetry {
                if let de = error as? DecodingError {
                    switch de {
                    case .keyNotFound(let key, let ctx):
                        self.error = "Missing key '\(key.stringValue)' at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
                    case .typeMismatch(let type, let ctx):
                        self.error = "Type mismatch \(type) at \(ctx.codingPath.map(\.stringValue).joined(separator: ".")): \(ctx.debugDescription)"
                    case .valueNotFound(_, let ctx):
                        self.error = "Null at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
                    case .dataCorrupted(let ctx):
                        self.error = "Corrupted: \(ctx.debugDescription)"
                    @unknown default:
                        self.error = "Decode error: \(de)"
                    }
                } else {
                    self.error = error.localizedDescription
                }
                brief = nil
                watchlist = nil
                watchlistError = nil
                topWatched = []
            }
        }
    }

    private func fetchSecondary(sessionId: String?) async {
        if let sessionId, !sessionId.isEmpty {
            do {
                watchlist = try await APIService.shared.fetchDailyWatchlist(sessionId: sessionId, date: selectedDate)
                watchlistError = nil
            } catch {
                watchlist = nil
                if case APIServiceError.invalidResponse(401) = error {
                    watchlistError = "Session expired. Please sign in again."
                    Task { await AuthManager.shared.signOut() }
                } else {
                    watchlistError = "Couldn't load watchlist right now."
                }
            }
        } else {
            watchlist = nil
            watchlistError = nil
        }
        do {
            topWatched = try await APIService.shared.fetchDailyTopWatched(limit: 10).players
        } catch {
            topWatched = []
        }
    }

    func load(sessionId: String? = nil) {
        guard !isLoading, !isRefreshing else { return }
        isLoading = true
        error = nil
        watchlistError = nil
        let selectedDay = selectedDate
        loadTask?.cancel()
        loadTask = Task {
            defer { isLoading = false }
            // Initial load: use cached endpoint for fast first render
            await fetchBrief(sessionId: sessionId, date: selectedDay, fresh: false)
        }
    }

    // Pull-to-refresh: keeps existing brief visible while fetching live data
    func refresh(sessionId: String? = nil) {
        guard !isRefreshing else { return }
        isRefreshing = true
        error = nil
        loadTask?.cancel()
        retryTask?.cancel()
        let selectedDay = selectedDate
        loadTask = Task {
            defer { isRefreshing = false }
            // Refresh always uses fresh=true — bypass cache, get live pricing
            await fetchBrief(sessionId: sessionId, date: selectedDay, fresh: true)
        }
    }

    func selectDate(_ date: Date, sessionId: String? = nil) {
        let normalized = Calendar.current.startOfDay(for: date)
        guard normalized != selectedDate else { return }
        selectedDate = normalized
        error = nil

        loadTask?.cancel()
        retryTask?.cancel()
        isLoading = true
        loadTask = Task {
            defer { isLoading = false }
            await fetchBrief(sessionId: sessionId, date: normalized, fresh: false)
        }
    }

    func addWatchPlayer(sessionId: String) {
        let playerName = watchPlayerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !playerName.isEmpty, !isSavingWatchlist else { return }

        if let selected = selectedWatchSuggestion,
           selected.playerName.caseInsensitiveCompare(playerName) == .orderedSame {
            addWatchPlayer(
                playerName: selected.playerName,
                team: selected.team,
                league: selected.league,
                sessionId: sessionId
            )
            return
        }

        addWatchPlayerFromSearch(query: playerName, team: nil, league: nil, sessionId: sessionId)
    }

    func updateWatchSuggestions(query: String) {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)

        suggestionTask?.cancel()

        if normalized.count < 2 {
            watchSuggestions = []
            if let selected = selectedWatchSuggestion,
               selected.playerName.caseInsensitiveCompare(normalized) != .orderedSame {
                selectedWatchSuggestion = nil
            }
            return
        }

        if let selected = selectedWatchSuggestion,
           selected.playerName.caseInsensitiveCompare(normalized) != .orderedSame {
            selectedWatchSuggestion = nil
        }

        suggestionTask = Task {
            do {
                let response = try await APIService.shared.fetchDailyWatchSuggestions(query: normalized, limit: 8)
                if Task.isCancelled { return }
                watchSuggestions = response.suggestions
            } catch {
                if Task.isCancelled { return }
                watchSuggestions = []
            }
        }
    }

    func selectWatchSuggestion(_ suggestion: DailyWatchSuggestion) {
        selectedWatchSuggestion = suggestion
        watchPlayerName = suggestion.playerName
        watchSuggestions = []
    }

    func addWatchSuggestion(_ suggestion: DailyWatchSuggestion, sessionId: String) {
        addWatchPlayer(
            playerId: suggestion.playerId,
            playerName: suggestion.playerName,
            team: suggestion.team,
            league: suggestion.league,
            sessionId: sessionId
        )
    }

    @MainActor
    private func syncWatchlistStateAfterMutation(sessionId: String) async {
        do {
            watchlist = try await APIService.shared.fetchDailyWatchlist(sessionId: sessionId, date: selectedDate)
        } catch {
            // Keep optimistic local state if sync fails.
        }

        do {
            topWatched = try await APIService.shared.fetchDailyTopWatched(limit: 10).players
        } catch {
            // Best-effort refresh only.
        }
    }

    @MainActor
    private func handleWatchlistError(_ error: Error) {
        if case APIServiceError.invalidResponse(401) = error {
            watchlistError = "Session expired. Please sign in again."
            Task { await AuthManager.shared.signOut() }
        } else if case APIServiceError.invalidResponse(404) = error {
            watchlistError = "Player not found in the current DailyIQ player pool."
        } else {
            watchlistError = error.localizedDescription
        }
    }

    @MainActor
    private func upsertWatchlistItemLocal(playerId: String? = nil, playerName: String, team: String?, league: String?) {
        let normalizedPlayerName = playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPlayerName.isEmpty else { return }

        let resolvedPlayerId = (playerId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? playerId!
            : derivePlayerId(from: normalizedPlayerName)
        var items = watchlist?.watchlist ?? []

        if !items.contains(where: { $0.playerId == resolvedPlayerId }) {
            items.append(
                DailyWatchlistItem(
                    playerId: resolvedPlayerId,
                    playerName: normalizedPlayerName,
                    team: team,
                    league: league,
                    level: nil,
                    position: nil,
                    addedAt: nil,
                    dailyStats: nil,
                    seasonStats: nil,
                    recentForm: nil,
                    tomorrowMatchup: nil
                )
            )
        }

        let userId = watchlist?.userId ?? AuthManager.shared.currentUser?.userId ?? "local-user"
        watchlist = DailyWatchlistResponse(
            userId: userId,
            count: items.count,
            watchlist: items
        )
    }

    func addWatchPlayerFromSearch(query: String, team: String?, league: String?, sessionId: String) {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSavingWatchlist else { return }
        guard !normalizedQuery.isEmpty else {
            watchlistError = "Enter a player name to search and add."
            return
        }

        isSavingWatchlist = true
        watchlistError = nil

        Task {
            defer { isSavingWatchlist = false }
            do {
                let addResponse = try await APIService.shared.addDailyWatchPlayerBySearch(
                    query: normalizedQuery,
                    team: team,
                    league: league,
                    sessionId: sessionId
                )
                watchPlayerName = ""
                selectedWatchSuggestion = nil
                watchSuggestions = []
                upsertWatchlistItemLocal(
                    playerId: addResponse.item?.playerId,
                    playerName: addResponse.item?.playerName ?? normalizedQuery,
                    team: team,
                    league: addResponse.item?.league ?? league
                )
                await syncWatchlistStateAfterMutation(sessionId: sessionId)
            } catch {
                handleWatchlistError(error)
            }
        }
    }

    func addWatchPlayer(playerId: String? = nil, playerName: String, team: String?, league: String?, sessionId: String) {
        let normalizedPlayerName = playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSavingWatchlist else { return }
        guard !normalizedPlayerName.isEmpty else {
            watchlistError = "Enter a valid player name before adding."
            return
        }

        isSavingWatchlist = true
        watchlistError = nil

        Task {
            defer { isSavingWatchlist = false }
            do {
                let addResponse = try await APIService.shared.addDailyWatchPlayer(
                    request: DailyWatchlistUpsertRequest(
                        playerId: playerId ?? derivePlayerId(from: normalizedPlayerName),
                        playerName: normalizedPlayerName,
                        team: team,
                        league: league
                    ),
                    sessionId: sessionId
                )
                watchPlayerName = ""
                selectedWatchSuggestion = nil
                watchSuggestions = []
                upsertWatchlistItemLocal(
                    playerId: addResponse.playerId ?? playerId,
                    playerName: addResponse.playerName ?? normalizedPlayerName,
                    team: team,
                    league: addResponse.league ?? league
                )
                await syncWatchlistStateAfterMutation(sessionId: sessionId)
            } catch {
                handleWatchlistError(error)
            }
        }
    }

    func removeWatchPlayer(_ playerName: String, sessionId: String) {
        guard let item = watchlistItem(for: playerName) else { return }
        removeWatchPlayer(playerId: item.playerId, sessionId: sessionId)
    }

    func removeWatchPlayer(playerId: String, sessionId: String) {
        guard !isSavingWatchlist else { return }

        isSavingWatchlist = true
        watchlistError = nil

        Task {
            defer { isSavingWatchlist = false }
            do {
                _ = try await APIService.shared.removeDailyWatchPlayer(playerId: playerId, sessionId: sessionId)
                await syncWatchlistStateAfterMutation(sessionId: sessionId)
            } catch {
                handleWatchlistError(error)
            }
        }
    }
}

// MARK: - Main View

struct DailyIQView: View {
    private enum DailyIQTab: String, CaseIterable, Identifiable {
        case mlb = "MLB"
        case milb = "MiLB"
        case watchlist = "Watchlist"

        var id: String { rawValue }
    }

    @State private var showAccount = false
    @State private var selectedTab: DailyIQTab = .mlb
    @FocusState private var isWatchSearchFocused: Bool
    @StateObject private var vm = DailyIQViewModel()
    @StateObject private var auth = AuthManager.shared
    var onAccount: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    headerBar
                    tabSelector
                    content
                        .padding(.horizontal)
                        .padding(.top, 12)
                }
            }
            .background(Color.black.ignoresSafeArea())
            .refreshable {
                // Awaiting ensures the spinner stays until live data arrives
                await withCheckedContinuation { continuation in
                    vm.refresh(sessionId: auth.activeSessionId)
                    // Poll until refresh finishes so SwiftUI dismisses the spinner correctly
                    Task {
                        while vm.isRefreshing { try? await Task.sleep(nanoseconds: 100_000_000) }
                        continuation.resume()
                    }
                }
            }
            .onAppear { if vm.brief == nil { vm.load(sessionId: auth.activeSessionId) } }
            .onChange(of: auth.currentUser?.userId) { _ in
                vm.refresh(sessionId: auth.activeSessionId)
            }
            .sheet(isPresented: $showAccount) {
                AccountView().preferredColorScheme(.dark)
            }
        }
    }

    private var headerBar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("DailyIQ")
                    .font(.title2.weight(.bold))
                    .foregroundColor(.blue)
                if let date = vm.brief?.date {
                    Text(date)
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            }
            Spacer()
            DatePicker(
                "",
                selection: Binding(
                    get: { vm.selectedDate },
                    set: { vm.selectDate($0, sessionId: auth.activeSessionId) }
                ),
                displayedComponents: .date
            )
            .labelsHidden()
            .datePickerStyle(.compact)
            .tint(.blue)
            .padding(.trailing, 6)
            if vm.isLoading || vm.isRefreshing {
                ProgressView()
                    .tint(.blue)
                    .padding(.trailing, 4)
            }
            AccountButton {
                if let onAccount { onAccount() } else { showAccount = true }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
        if let error = vm.error {
            errorView(error)
        } else if vm.isLoading && vm.brief == nil {
            skeletonView
        } else if let brief = vm.brief {
            switch selectedTab {
            case .mlb:
                mlbContent(brief)
            case .milb:
                milbContent(brief)
            case .watchlist:
                watchlistContent
            }
        } else {
            emptyTabState("No data for this date — pull down to refresh.")
        }
    }

    private func mlbContent(_ brief: DailyBriefResponse) -> some View {
        return VStack(spacing: 14) {
            if brief.mlb.isEmpty {
                emptyTabState("No MLB performers today.")
            } else {
                ForEach(brief.mlb) { performer in
                    DailyPerformerRow(
                        performer: performer,
                        isWatchlisted: vm.isWatchlisted(playerId: performer.playerId, playerName: performer.playerName),
                        onAdd: {
                            if let sessionId = auth.activeSessionId {
                                vm.addWatchPlayer(
                                    playerId: performer.playerId,
                                    playerName: performer.playerName,
                                    team: performer.team,
                                    league: performer.league,
                                    sessionId: sessionId
                                )
                            }
                        },
                        onRemove: {
                            if let sessionId = auth.activeSessionId {
                                vm.removeWatchPlayer(performer.playerName, sessionId: sessionId)
                            }
                        }
                    )
                }
            }
        }
    }

    private func milbContent(_ brief: DailyBriefResponse) -> some View {
        return VStack(spacing: 14) {
            if brief.milb.isEmpty {
                emptyTabState("No MiLB performers today.")
            } else {
                ForEach(brief.milb) { performer in
                    DailyPerformerRow(
                        performer: performer,
                        isWatchlisted: vm.isWatchlisted(playerId: performer.playerId, playerName: performer.playerName),
                        onAdd: {
                            if let sessionId = auth.activeSessionId {
                                vm.addWatchPlayer(
                                    playerId: performer.playerId,
                                    playerName: performer.playerName,
                                    team: performer.team,
                                    league: performer.league,
                                    sessionId: sessionId
                                )
                            }
                        },
                        onRemove: {
                            if let sessionId = auth.activeSessionId {
                                vm.removeWatchPlayer(performer.playerName, sessionId: sessionId)
                            }
                        }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func dailyPerformerRow(_ performer: DailyPerformer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(performer.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)
                    Text(performer.team + " • " + performer.league)
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Today: \(performer.dailyStats.hits)-\(performer.dailyStats.atBats), \(performer.dailyStats.battingAverage) BA")
                        .font(.caption)
                        .foregroundColor(.white)
                    Text("Season: \(performer.seasonStats.homeRuns) HR, \(performer.seasonStats.rbis) RBI, \(performer.seasonStats.ops) OPS")
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private struct DailyPerformerRow: View {
        let performer: DailyPerformer
        let isWatchlisted: Bool
        let onAdd: () -> Void
        let onRemove: () -> Void

        private var teamLeagueLine: String {
            if let level = performer.level, !level.isEmpty, performer.league == "MiLB" {
                return (performer.team ?? "Unknown") + " • " + performer.league
            }
            return (performer.team ?? "Unknown") + " • " + performer.league
        }

        private var levelBadgeText: String? {
            guard performer.league == "MiLB", let level = performer.level, !level.isEmpty else { return nil }
            switch level {
            case "Triple-A": return "AAA"
            case "Double-A": return "AA"
            case "High-A": return "High-A"
            case "Single-A": return "A"
            case "Rookie": return "Rookie"
            default: return level
            }
        }

        private var levelBadgeColor: Color {
            guard let level = performer.level else { return .gray }
            switch level {
            case "Triple-A": return .purple
            case "Double-A": return .blue
            case "High-A": return .green
            case "Single-A": return .orange
            case "Rookie": return .pink
            default: return .gray
            }
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(performer.playerName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.white)
                        HStack(spacing: 6) {
                            Text(teamLeagueLine)
                                .font(.caption)
                                .foregroundColor(.gray)
                            if let badge = levelBadgeText {
                                Text(badge)
                                    .font(.system(size: 10, weight: .bold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(levelBadgeColor.opacity(0.2))
                                    .foregroundColor(levelBadgeColor)
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    Spacer()
                    Button(action: isWatchlisted ? onRemove : onAdd) {
                        Image(systemName: isWatchlisted ? "heart.fill" : "heart")
                            .foregroundColor(isWatchlisted ? .red : .gray)
                    }
                }
                
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("Today:")
                            .font(.caption)
                            .foregroundColor(.gray)
                        Spacer()
                        if performer.isPitcher, let ip = performer.dailyStats.inningsPitched {
                            Text("IP: \(ip) | \(performer.dailyStats.strikeouts) K | \(performer.dailyStats.walks) BB | \(performer.dailyStats.earnedRuns ?? 0) ER")
                                .font(.caption)
                                .foregroundColor(.white)
                        } else {
                            Text("\(performer.dailyStats.hits)-\(performer.dailyStats.atBats) | BA: \(performer.dailyStats.battingAverage) | OPS: \(performer.dailyStats.ops)")
                                .font(.caption)
                                .foregroundColor(.white)
                        }
                    }
                    
                    HStack {
                        Text("Season:")
                            .font(.caption)
                            .foregroundColor(.gray)
                        Spacer()
                        if performer.isPitcher {
                            let w = performer.seasonStats.wins ?? 0
                            let l = performer.seasonStats.losses ?? 0
                            let era = performer.seasonStats.era ?? "-.--"
                            let whip = performer.seasonStats.whip ?? "-.--"
                            Text("ERA: \(era) | \(w)-\(l) | WHIP: \(whip) | \(performer.seasonStats.strikeouts) K")
                                .font(.caption2)
                                .foregroundColor(.white)
                        } else {
                            Text("\(performer.seasonStats.homeRuns) HR | \(performer.seasonStats.rbis) RBI | BA: \(performer.seasonStats.battingAverage) | OPS: \(performer.seasonStats.ops)")
                                .font(.caption2)
                                .foregroundColor(.white)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }

    private func emptyTabState(_ text: String) -> some View {
        VStack(spacing: 14) {
            Text(text)
                .font(.caption)
                .foregroundColor(.gray)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }

    private var watchlistContent: some View {
        VStack(spacing: 14) {
            watchlistSection
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct DailyWatchlistRow: View {
        let item: DailyWatchlistItem
        let onRemove: () -> Void

        private var teamLeagueLine: String {
            let team = item.team ?? "Unknown"
            let league = item.league ?? "Unknown"
            return team + " • " + league
        }

        private var levelBadgeText: String? {
            guard item.league == "MiLB", let level = item.level, !level.isEmpty else { return nil }
            switch level {
            case "Triple-A": return "AAA"
            case "Double-A": return "AA"
            case "High-A": return "High-A"
            case "Single-A": return "A"
            case "Rookie": return "Rookie"
            default: return level
            }
        }

        private var levelBadgeColor: Color {
            guard let level = item.level else { return .gray }
            switch level {
            case "Triple-A": return .purple
            case "Double-A": return .blue
            case "High-A": return .green
            case "Single-A": return .orange
            case "Rookie": return .pink
            default: return .gray
            }
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.playerName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.white)
                        HStack(spacing: 6) {
                            Text(teamLeagueLine)
                                .font(.caption)
                                .foregroundColor(.gray)
                            if let badge = levelBadgeText {
                                Text(badge)
                                    .font(.system(size: 10, weight: .bold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(levelBadgeColor.opacity(0.2))
                                    .foregroundColor(levelBadgeColor)
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    Spacer()
                    Button(action: onRemove) {
                        Image(systemName: "heart.fill")
                            .foregroundColor(.red)
                    }
                }
                
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("Today:")
                            .font(.caption)
                            .foregroundColor(.gray)
                        Spacer()
                        if let daily = item.dailyStats, daily.statsType == "pitching" {
                            Text(daily.inningsPitched.map { "IP: \($0) | \(daily.strikeouts) K | \(daily.walks) BB | \(daily.earnedRuns ?? 0) ER" } ?? "—")
                                .font(.caption)
                                .foregroundColor(.white)
                        } else {
                            Text(item.dailyStats.map { "\($0.hits)-\($0.atBats) | BA: \($0.battingAverage) | OPS: \($0.ops)" } ?? "—")
                                .font(.caption)
                                .foregroundColor(.white)
                        }
                    }
                    
                    HStack {
                        Text("Season Overall:")
                            .font(.caption)
                            .foregroundColor(.gray)
                        Spacer()
                        if let season = item.seasonStats, season.statsType == "pitching" {
                            let w = season.wins ?? 0
                            let l = season.losses ?? 0
                            let era = season.era ?? "-.--"
                            let whip = season.whip ?? "-.--"
                            let gs = season.gamesStarted ?? 0
                            Text("ERA: \(era) | \(w)-\(l) | WHIP: \(whip) | GS: \(gs) | \(season.strikeouts) K")
                                .font(.caption2)
                                .foregroundColor(.white)
                        } else {
                            Text(item.seasonStats.map { "BA: \($0.battingAverage) | OBP: \($0.obp) | SLG: \($0.slg) | OPS: \($0.ops) | \($0.homeRuns) HR | \($0.rbis) RBI" } ?? "—")
                                .font(.caption2)
                                .foregroundColor(.white)
                        }
                    }

                    // Last 7 / Last 15 game-log splits (real data from MLB Stats API gameLog)
                    if let form = item.recentForm {
                        if form.last7.games > 0 {
                            recentFormLine(label: "Last 7:", split: form.last7)
                        }
                        if form.last15.games > 0 {
                            recentFormLine(label: "Last 15:", split: form.last15)
                        }
                    }

                    // Tomorrow matchup (MLB only)
                    if let matchup = item.tomorrowMatchup {
                        HStack(alignment: .top) {
                            Text("Tomorrow:")
                                .font(.caption)
                                .foregroundColor(.gray)
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                let prefix = matchup.isHome ? "vs" : "@"
                                Text("\(prefix) \(matchup.opponentAbbreviation)")
                                    .font(.caption)
                                    .foregroundColor(.white)
                                if let pitcher = matchup.probablePitcherName {
                                    let hand = matchup.probablePitcherHand.map { " (\($0)HP)" } ?? ""
                                    let era = matchup.probablePitcherEra.map { " · \($0) ERA" } ?? ""
                                    Text("vs \(pitcher)\(hand)\(era)")
                                        .font(.caption2)
                                        .foregroundColor(.gray)
                                } else {
                                    Text("Probable TBD")
                                        .font(.caption2)
                                        .foregroundColor(.gray)
                                }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }

        @ViewBuilder
        private func recentFormLine(label: String, split: RecentFormSplit) -> some View {
            HStack {
                Text(label)
                    .font(.caption)
                    .foregroundColor(.gray)
                Spacer()
                Text(formatSplit(split))
                    .font(.caption2)
                    .foregroundColor(.white)
            }
        }

        private func formatSplit(_ split: RecentFormSplit) -> String {
            if item.isPitcher {
                let ip = split.inningsPitched ?? "0.0"
                let er = split.earnedRuns ?? 0
                let k = split.strikeouts ?? 0
                let bb = split.walks ?? 0
                let era = split.era ?? "-.--"
                let whip = split.whip ?? "-.--"
                return "\(split.games) G | \(ip) IP | \(er) ER | \(k) K | \(bb) BB | ERA \(era) | WHIP \(whip)"
            } else {
                let h = split.hits ?? 0
                let ab = split.atBats ?? 0
                let hr = split.homeRuns ?? 0
                let rbi = split.rbis ?? 0
                let ba = split.battingAverage ?? ".000"
                let ops = split.ops ?? ".000"
                return "\(split.games) G | \(h)/\(ab) | BA \(ba) | OPS \(ops) | \(hr) HR | \(rbi) RBI"
            }
        }
    }

    private var tabSelector: some View {
        HStack(spacing: 8) {
            ForEach(DailyIQTab.allCases) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    Text(tab.rawValue)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(selectedTab == tab ? .black : .white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 9)
                                .fill(selectedTab == tab ? Color.blue : Color(.secondarySystemBackground))
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal)
    }

    @ViewBuilder
    private var watchlistSection: some View {
        if auth.isAuthenticated {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Watchlist")
                        .font(.headline)
                        .foregroundColor(.white)
                    Spacer()
                    if let count = vm.watchlist?.count {
                        Text("\(count) players")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                }

                HStack(alignment: .top, spacing: 8) {
                    VStack(spacing: 6) {
                        TextField("Search player and add to your account watchlist", text: $vm.watchPlayerName)
                            .textInputAutocapitalization(.words)
                            .disableAutocorrection(true)
                            .submitLabel(.done)
                            .focused($isWatchSearchFocused)
                            .onChange(of: vm.watchPlayerName) { value in
                                vm.updateWatchSuggestions(query: value)
                            }
                            .onSubmit {
                                if let sessionId = auth.activeSessionId {
                                    vm.addWatchPlayer(sessionId: sessionId)
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Color(.secondarySystemBackground))
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))

                        if isWatchSearchFocused && !vm.watchSuggestions.isEmpty {
                            VStack(spacing: 0) {
                                ForEach(vm.watchSuggestions) { suggestion in
                                    Button {
                                        if let sessionId = auth.activeSessionId {
                                            vm.addWatchSuggestion(suggestion, sessionId: sessionId)
                                        } else {
                                            vm.selectWatchSuggestion(suggestion)
                                        }
                                        isWatchSearchFocused = false
                                    } label: {
                                        HStack(spacing: 8) {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(suggestion.playerName)
                                                    .font(.caption.weight(.semibold))
                                                    .foregroundColor(.white)
                                                HStack(spacing: 6) {
                                                    if let team = suggestion.team, !team.isEmpty {
                                                        Text(team)
                                                            .font(.caption2)
                                                            .foregroundColor(.gray)
                                                    }
                                                    if let league = suggestion.league, !league.isEmpty {
                                                        Text(league)
                                                            .font(.caption2)
                                                            .foregroundColor(.blue)
                                                    }
                                                }
                                            }
                                            Spacer()
                                        }
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 9)
                                    }
                                    .buttonStyle(.plain)

                                    if suggestion.id != vm.watchSuggestions.last?.id {
                                        Divider().background(Color.gray.opacity(0.2))
                                    }
                                }
                            }
                            .background(Color(.tertiarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }

                    Button(vm.isSavingWatchlist ? "..." : "Search + Add") {
                        if let sessionId = auth.activeSessionId {
                            vm.addWatchPlayer(sessionId: sessionId)
                            isWatchSearchFocused = false
                        }
                    }
                    .disabled(vm.isSavingWatchlist || auth.activeSessionId == nil)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.blue.opacity(vm.isSavingWatchlist ? 0.4 : 1.0))
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                if let watchlistError = vm.watchlistError {
                    Text(watchlistError)
                        .font(.caption)
                        .foregroundColor(.red)
                }

                if let watchlist = vm.watchlist {
                    if !watchlist.watchlist.isEmpty {
                        VStack(spacing: 10) {
                            ForEach(watchlist.watchlist) { item in
                                DailyWatchlistRow(item: item) {
                                    if let sessionId = auth.activeSessionId {
                                        vm.removeWatchPlayer(playerId: item.playerId, sessionId: sessionId)
                                    }
                                }
                            }
                        }
                    } else {
                        Text("No saved watchlist players yet. Add the players you want DailyIQ stats for.")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                } else {
                    Text("No saved watchlist players yet. Add the players you want DailyIQ stats for.")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
            }
            .padding(16)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Watchlist")
                    .font(.headline)
                    .foregroundColor(.white)
                Text("Sign in to save players to your account and track their DailyIQ stats.")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }

        if !vm.topWatched.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Top Watched Players")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.white)

                ForEach(vm.topWatched.prefix(5)) { player in
                    HStack(spacing: 8) {
                        Text(player.playerName)
                            .font(.caption)
                            .foregroundColor(.white)
                            .lineLimit(1)
                        if let team = player.team, !team.isEmpty {
                            Text(team)
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                        Spacer()
                        Text("\(player.watchCount)")
                            .font(.caption.weight(.semibold))
                            .foregroundColor(.blue)
                        Text("watchers")
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                }
            }
            .padding(12)
            .background(Color(.tertiarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }

    private var skeletonView: some View {
        VStack(spacing: 14) {
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 14)
                    .fill(Color(.secondarySystemBackground).opacity(0.6))
                    .frame(height: 120)
                    .redacted(reason: .placeholder)
            }
        }
    }

    private func errorView(_ msg: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.red)
            VStack(alignment: .leading, spacing: 6) {
                Text(msg).font(.subheadline)
                Button("Try Again") { vm.refresh(sessionId: auth.activeSessionId) }
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.blue)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.top, 40)
    }
}

// MARK: - Daily Card Row

private struct DailyCardRow: View {
    let card: DailyBriefCard
    let isWatchlisted: Bool
    let onAdd: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header: label + action badge
            HStack {
                if let label = card.label {
                    Text(label.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color(.tertiarySystemBackground))
                        .clipShape(Capsule())
                }
                Spacer()
                if let action = card.action {
                    Text(action.uppercased())
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(actionColor(action).opacity(0.15))
                        .foregroundColor(actionColor(action))
                        .clipShape(Capsule())
                }

                Button {
                    if isWatchlisted {
                        onRemove()
                    } else {
                        onAdd()
                    }
                } label: {
                    Text(isWatchlisted ? "Added" : "Add")
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(isWatchlisted ? Color.green.opacity(0.2) : Color.blue.opacity(0.2))
                        .foregroundColor(isWatchlisted ? .green : .blue)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }

            // Player + card line
            VStack(alignment: .leading, spacing: 2) {
                Text(card.playerName)
                    .font(.headline)
                    .foregroundColor(.white)
                if let title = card.cardTitle, !title.isEmpty {
                    Text(title)
                        .font(.subheadline)
                        .foregroundColor(.gray)
                        .lineLimit(1)
                } else {
                    let sub = [card.cardYear.map(String.init), card.product].compactMap { $0 }.joined(separator: " ")
                    if !sub.isEmpty {
                        Text(sub)
                            .font(.subheadline)
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                }
            }

            // Price triptych
            if card.fairMarketValue != nil || card.quickSaleValue != nil || card.premiumValue != nil {
                HStack(spacing: 0) {
                    dailyPriceLane(label: "Quick", value: card.quickSaleValue, color: .orange)
                    Divider().frame(height: 36)
                    dailyPriceLane(label: "Fair Value", value: card.fairMarketValue, color: .white)
                    Divider().frame(height: 36)
                    dailyPriceLane(label: "Premium", value: card.premiumValue, color: .blue)
                }
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            // Verdict + deal score
            HStack(alignment: .top, spacing: 8) {
                if let verdict = card.verdict, !verdict.isEmpty {
                    Text(verdict)
                        .font(.caption)
                        .foregroundColor(.gray)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let score = card.dealScore {
                    VStack(spacing: 0) {
                        Text("\(Int(score))")
                            .font(.subheadline.bold())
                            .foregroundColor(dealScoreColor(score))
                        Text("Score")
                            .font(.system(size: 8))
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(dealScoreColor(score).opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            // Market DNA chips
            if let dna = card.marketDNA {
                HStack(spacing: 6) {
                    dnaTag("D", dna.demand)
                    dnaTag("S", dna.speed)
                    dnaTag("R", dna.risk)
                    dnaTag("T", dna.trend)
                    Spacer()
                    if let comps = card.compsUsed, comps > 0 {
                        Text("\(comps) comps")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.06), radius: 6, x: 0, y: 2)
    }

    private func dailyPriceLane(label: String, value: Double?, color: Color) -> some View {
        VStack(spacing: 3) {
            Text(label).font(.system(size: 9)).foregroundColor(.secondary)
            Text(value?.currencyFormatted ?? "—").font(.caption.weight(.semibold)).foregroundColor(color)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func dnaTag(_ key: String, _ value: String?) -> some View {
        HStack(spacing: 3) {
            Text(key).font(.system(size: 8)).foregroundColor(.secondary)
            Text(value ?? "—").font(.system(size: 9, weight: .semibold)).foregroundColor(.white)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func actionColor(_ action: String) -> Color {
        switch action.lowercased() {
        case "buy", "strong_buy": return .green
        case "sell": return .red
        default: return .yellow
        }
    }

    private func dealScoreColor(_ score: Double) -> Color {
        score >= 70 ? .green : score >= 45 ? .yellow : .red
    }
}

private struct DailyWatchPlayerRow: View {
    let player: DailyWatchPlayer
    let onRemove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(player.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)
                    if player.buySignal == true {
                        Text("Buy Signal")
                            .font(.caption2.weight(.medium))
                            .foregroundColor(.green)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.green.opacity(0.15))
                            .clipShape(Capsule())
                    }
                }

                if let statLine = player.statLine, !statLine.isEmpty {
                    Text(statLine)
                        .font(.caption.monospacedDigit())
                        .foregroundColor(.white.opacity(0.85))
                } else if let ba = player.battingAverage,
                          let hr = player.homeRuns,
                          let rbi = player.rbis {
                    Text("BA \(ba) | HR \(hr) | RBI \(rbi)")
                        .font(.caption.monospacedDigit())
                        .foregroundColor(.white.opacity(0.85))
                } else if let noGameMessage = player.noGameMessage, !noGameMessage.isEmpty {
                    Text(noGameMessage)
                        .font(.caption)
                        .foregroundColor(.gray)
                }

                if let obp = player.obp,
                   let slg = player.slg,
                   let ops = player.ops {
                    Text("OBP \(obp) | SLG \(slg) | OPS \(ops)")
                        .font(.caption2.monospacedDigit())
                        .foregroundColor(.white.opacity(0.75))
                }

                if let ratio = player.walkToStrikeout, !ratio.isEmpty {
                    Text("BB:K \(ratio)")
                        .font(.caption2.monospacedDigit())
                        .foregroundColor(.white.opacity(0.75))
                } else if let bb = player.walks, let so = player.strikeouts {
                    Text("BB:K \(bb):\(so)")
                        .font(.caption2.monospacedDigit())
                        .foregroundColor(.white.opacity(0.75))
                }

                if let note = player.performanceNote, !note.isEmpty {
                    Text(note)
                        .font(.caption2)
                        .foregroundColor(.gray)
                        .lineLimit(2)
                }
            }

            Spacer()

            Button("Remove", role: .destructive, action: onRemove)
                .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
    }
}

private struct DailyWatchlistItemRow: View {
    let item: DailyWatchlistItem
    let onRemove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.playerName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.white)

                HStack(spacing: 6) {
                    if let team = item.team, !team.isEmpty {
                        Text(team)
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                    if let league = item.league, !league.isEmpty {
                        Text(league)
                            .font(.caption2)
                            .foregroundColor(.blue)
                    }
                }

                Text("Saved to watchlist")
                    .font(.caption)
                    .foregroundColor(.gray)
            }

            Spacer()

            Button("Remove", role: .destructive, action: onRemove)
                .font(.caption.weight(.semibold))
        }
        .padding(12)
        .background(Color(.tertiarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

struct DailyIQView_Previews: PreviewProvider {
    static var previews: some View {
        DailyIQView(onAccount: {})
            .preferredColorScheme(.dark)
    }
}

