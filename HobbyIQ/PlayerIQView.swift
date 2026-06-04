//
//  PlayerIQView.swift
//  HobbyIQ
//

import SwiftUI

struct PlayerIQView: View {
    var initialQuery: String? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var response: PlayerIQResponse?
    @State private var statsResponse: PlayerStatsResponse?
    @State private var isLoading = false
    @State private var isLoadingStats = false
    @State private var errorMessage: String?
    @State private var didApplyInitialQuery = false
    @State private var didAddToWatchlist = false
    @State private var isAddingToWatchlist = false
    @State private var topPlayers: [PlayerIQTopEntry] = []
    @State private var isLoadingTop = false
    @State private var historyPoints: [PlayerIQHistoryPoint] = []
    @State private var isLoadingHistory = false
    @FocusState private var isSearchFocused: Bool

    /// When presented from another screen (initialQuery != nil), show a back button.
    private var isPresented: Bool { initialQuery != nil }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                if isPresented {
                    HStack {
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

                        Spacer()

                        Button {
                            Task { await addToWatchlist() }
                        } label: {
                            HStack(spacing: 4) {
                                if isAddingToWatchlist {
                                    ProgressView()
                                        .tint(HobbyIQTheme.Colors.electricBlue)
                                        .scaleEffect(0.7)
                                } else {
                                    Image(systemName: didAddToWatchlist ? "checkmark" : "plus")
                                        .font(.system(size: 14, weight: .semibold))
                                }
                                Text(didAddToWatchlist ? "Added" : "Watchlist")
                                    .font(.subheadline.weight(.medium))
                            }
                            .foregroundStyle(didAddToWatchlist ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue)
                        }
                        .buttonStyle(.plain)
                        .disabled(isAddingToWatchlist || didAddToWatchlist)
                    }
                }

                if !isPresented {
                    header
                    searchSection
                    stateSection

                    if !topPlayers.isEmpty && response == nil && !isLoading {
                        topPlayersSection
                    }
                }
                // 1. Bio card (from stats)
                if let statsResponse, statsResponse.status == "ok" {
                    bioCard(statsResponse)
                }

                // 2. Hitting / Pitching stats
                if let statsResponse {
                    PlayerIdentityLine(stats: statsResponse)

                    if let hitting = statsResponse.hitting, let years = hitting.yearByYear, !years.isEmpty {
                        HittingStatsTable(yearByYear: years, career: hitting.career)
                    }

                    if let pitching = statsResponse.pitching, let years = pitching.yearByYear, !years.isEmpty {
                        PitchingStatsTable(yearByYear: years, career: pitching.career)
                    }
                } else if isLoadingStats {
                    LoadingCardView(title: "Loading Stats", message: "Fetching season-by-season stats.")
                }

                // 3. PlayerIQ score + call, then Card Market
                if let response {
                    reportSection(response)
                }

                // 4. Score History
                if !historyPoints.isEmpty {
                    scoreHistorySection
                } else if isLoadingHistory {
                    LoadingCardView(title: "Loading History", message: "Fetching score history.")
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xxLarge)
        }
        .background { HobbyIQBackground() }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            if let initialQuery, !didApplyInitialQuery {
                didApplyInitialQuery = true
                query = initialQuery
                await submitSearch()
            } else {
                await loadTopPlayers()
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
            Text("PlayerIQ")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            Text("Get a live player answer first.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var searchSection: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            HobbyIQSearchField(text: $query, placeholder: "Search a player...")
                .focused($isSearchFocused)
                .onSubmit {
                    Task { await submitSearch() }
                }

            Button(isLoading ? "Searching..." : "Search") {
                Task { await submitSearch() }
            }
            .buttonStyle(HobbyIQBlueButtonStyle())
            .disabled(isLoading || query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @ViewBuilder
    private var stateSection: some View {
        if isLoading {
            LoadingCardView(title: "Loading PlayerIQ", message: "Pulling live backend player context.")
        }

        if let errorMessage {
            ErrorStateView(title: "PlayerIQ unavailable", message: errorMessage) {
                Task { await submitSearch() }
            }
        }
    }

    private func reportSection(_ response: PlayerIQResponse) -> some View {
        VStack(spacing: HobbyIQTheme.Spacing.large) {
            // PlayerIQ Score + Call
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
                HStack(spacing: HobbyIQTheme.Spacing.small) {
                    ScoreBlock(title: "PlayerIQ Score", value: "\(response.playerIQScore ?? 0)")
                    ScoreBlock(title: "Call", value: response.playerIQLabel ?? "—")
                }

                if let direction = response.playerIQDirection {
                    DirectionBadge(direction: direction)
                }

                // Performance summary inline
                if let perf = response.performance {
                    if let statLine = perf.statLine, !statLine.isEmpty {
                        HStack(spacing: 6) {
                            Text("Performance")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(statLine)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.cardPadding)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))

            // Card Market
            if let market = response.market {
                SimpleSectionCard(
                    title: "Card Market",
                    rows: [
                        market.marketScore.map { ("Market Score", "\($0)") },
                        market.marketDirection.map { ("Direction", $0.capitalized) },
                        market.avgTrendPct.map { ("Avg Trend", "\($0 >= 0 ? "+" : "")\(Int($0))%") },
                        market.totalSamples.map { ("Samples", "\($0)") },
                        market.cardCount.map { ("Cards Tracked", "\($0)") },
                        market.topCardName.map { ("Top Card", $0) },
                        market.confidence.map { ("Confidence", $0.capitalized) },
                    ].compactMap { $0 }
                )
            }
        }
    }

    private func bioCard(_ stats: PlayerStatsResponse) -> some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
            // Headshot + name row
            HStack(spacing: HobbyIQTheme.Spacing.medium) {
                if let mlbId = stats.mlbPlayerId {
                    AsyncImage(url: URL(string: "https://midfield.mlbstatic.com/v1/people/\(mlbId)/spots/120")) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .scaledToFill()
                        case .failure:
                            Image(systemName: "person.crop.circle.fill")
                                .font(.system(size: 36))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        default:
                            ProgressView()
                                .tint(HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                    .frame(width: 72, height: 72)
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 2)
                    )
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(stats.fullName ?? stats.playerName ?? "")
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    if let level = stats.currentLevel {
                        Text(level)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.2))
                            .clipShape(Capsule(style: .continuous))
                    }

                    if let nickName = stats.nickName, !nickName.isEmpty {
                        Text("\"\(nickName)\"")
                            .font(.caption.italic())
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }

                Spacer(minLength: 0)
            }

            // Bio grid
            let bioRows = buildBioRows(stats)
            if !bioRows.isEmpty {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
                    ForEach(bioRows, id: \.label) { row in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.label)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(row.value)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .lineLimit(2)
                                .minimumScaleFactor(0.8)
                        }
                    }
                }
            }

            // Draft block
            if let draft = stats.draft, draft.year != nil {
                draftBlock(draft)
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func draftBlock(_ draft: PlayerDraftInfoDTO) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "scroll.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("Draft")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            let parts = [
                draft.year,
                draft.round.map { "Round \($0)" },
                draft.pickNumber.map { "Pick #\($0)" },
                draft.team.map { "by \($0)" },
                draft.school.map { "from \($0)" }
            ].compactMap { $0 }

            if !parts.isEmpty {
                Text(parts.joined(separator: " · "))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.small)
        .background(Color.white.opacity(0.03))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private struct BioRow {
        let label: String
        let value: String
    }

    private func buildBioRows(_ stats: PlayerStatsResponse) -> [BioRow] {
        var rows: [BioRow] = []

        if let pos = stats.position, !pos.isEmpty {
            rows.append(BioRow(label: "Position", value: pos))
        }

        let bt = [stats.bats, stats.throwsHand].compactMap { $0 }
        if !bt.isEmpty {
            rows.append(BioRow(label: "B/T", value: bt.joined(separator: "/")))
        }

        if let h = stats.height, !h.isEmpty {
            rows.append(BioRow(label: "Height", value: h))
        }

        if let w = stats.weight {
            rows.append(BioRow(label: "Weight", value: "\(w) lbs"))
        }

        if let age = stats.currentAge {
            rows.append(BioRow(label: "Age", value: "\(age)"))
        }

        let birthParts = [stats.birthCity, stats.birthStateProvince, stats.birthCountry].compactMap { $0 }.filter { !$0.isEmpty }
        if !birthParts.isEmpty {
            rows.append(BioRow(label: "Born", value: birthParts.joined(separator: ", ")))
        }

        if let debut = stats.mlbDebutDate, !debut.isEmpty {
            rows.append(BioRow(label: "MLB Debut", value: debut))
        }

        if let active = stats.active {
            rows.append(BioRow(label: "Status", value: active ? "Active" : "Inactive"))
        }

        if let hs = stats.highSchool, !hs.isEmpty {
            rows.append(BioRow(label: "High School", value: hs))
        }

        if let college = stats.college, !college.isEmpty {
            rows.append(BioRow(label: "College", value: college))
        }

        return rows
    }

    private func submitSearch() async {
        isSearchFocused = false
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }

        isLoading = true
        isLoadingStats = true
        errorMessage = nil
        defer { isLoading = false }

        // Fetch PlayerIQ score and stats concurrently
        async let playerIQTask = APIService.shared.analyzePlayer(query: trimmed)
        async let statsTask = APIService.shared.fetchPlayerStats(playerName: trimmed)

        do {
            response = try await playerIQTask
        } catch {
            response = nil
            errorMessage = error.localizedDescription
        }

        do {
            let stats = try await statsTask
            if stats.status == "ok" {
                statsResponse = stats
            } else {
                statsResponse = nil
            }
        } catch {
            statsResponse = nil
        }
        isLoadingStats = false

        await loadHistory(for: trimmed)
    }

    // MARK: - Top Players

    private var topPlayersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Top Players")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            ForEach(topPlayers, id: \.stableId) { entry in
                Button {
                    query = entry.playerName ?? ""
                    Task { await submitSearch() }
                } label: {
                    topPlayerRow(entry)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func topPlayerRow(_ entry: PlayerIQTopEntry) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.playerName ?? "Unknown")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                let details = [entry.team, entry.position, entry.level].compactMap { $0 }.filter { !$0.isEmpty }
                if !details.isEmpty {
                    Text(details.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }

            Spacer()

            if let score = entry.playerIQScore {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(score)")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    if let dir = entry.playerIQDirection {
                        Text(dir.capitalized)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(directionColor(dir))
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Score History

    private var scoreHistorySection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Score History")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            if historyPoints.count > 1 {
                scoreChart
            }

            ForEach(Array(historyPoints.prefix(10).enumerated()), id: \.offset) { _, point in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        if let date = point.updatedAt {
                            Text(date.prefix(10))
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                        if let label = point.playerIQLabel {
                            Text(label)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white)
                        }
                    }
                    Spacer()
                    if let score = point.playerIQScore {
                        Text("\(score)")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                    if let dir = point.playerIQDirection {
                        Image(systemName: directionIcon(dir))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(directionColor(dir))
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var scoreChart: some View {
        let scores = historyPoints.reversed().compactMap { $0.playerIQScore }
        let minScore = max((scores.min() ?? 0) - 5, 0)
        let maxScore = min((scores.max() ?? 100) + 5, 200)
        let range = Double(max(maxScore - minScore, 1))

        return GeometryReader { geo in
            let w = geo.size.width
            let h: CGFloat = 100
            let step = scores.count > 1 ? w / CGFloat(scores.count - 1) : w

            Path { path in
                for (i, score) in scores.enumerated() {
                    let x = CGFloat(i) * step
                    let y = h - (CGFloat(score - minScore) / CGFloat(range)) * h
                    if i == 0 {
                        path.move(to: CGPoint(x: x, y: y))
                    } else {
                        path.addLine(to: CGPoint(x: x, y: y))
                    }
                }
            }
            .stroke(HobbyIQTheme.Colors.electricBlue, lineWidth: 2)
        }
        .frame(height: 100)
    }

    private func directionColor(_ dir: String) -> Color {
        switch dir.lowercased() {
        case "rising": HobbyIQTheme.Colors.hobbyGreen
        case "falling": HobbyIQTheme.Colors.danger
        default: HobbyIQTheme.Colors.mutedText
        }
    }

    private func directionIcon(_ dir: String) -> String {
        switch dir.lowercased() {
        case "rising": "arrow.up.right"
        case "falling": "arrow.down.right"
        default: "arrow.right"
        }
    }

    private func loadTopPlayers() async {
        isLoadingTop = true
        defer { isLoadingTop = false }
        do {
            let response = try await APIService.shared.fetchPlayerIQTop(limit: 15)
            topPlayers = response.players ?? []
        } catch {
            // Non-critical — top players section just won't show
        }
    }

    private func loadHistory(for playerName: String) async {
        isLoadingHistory = true
        historyPoints = []
        defer { isLoadingHistory = false }
        do {
            let response = try await APIService.shared.fetchPlayerIQHistory(name: playerName)
            historyPoints = response.points ?? []
        } catch {
            // Non-critical
        }
    }

    private func addToWatchlist() async {
        guard let playerName = initialQuery?.trimmingCharacters(in: .whitespacesAndNewlines),
              !playerName.isEmpty else { return }
        let userId = AuthService.shared.userId ?? ""
        guard !userId.isEmpty else { return }

        let playerId: String = {
            if let id = response?.mlbPlayerId { return String(id) }
            return playerName
        }()

        isAddingToWatchlist = true
        defer { isAddingToWatchlist = false }

        _ = await DailyIQService.shared.addWatchlistEntry(
            userId: userId,
            playerId: playerId,
            playerName: playerName
        )
        didAddToWatchlist = true
    }
}

// MARK: - Stats Table Views

private struct PlayerIdentityLine: View {
    let stats: PlayerStatsResponse

    var body: some View {
        let parts = [
            stats.currentTeam,
            stats.currentLevel,
            stats.position,
            stats.primaryNumber.map { "#\($0)" }
        ].compactMap { $0 }.filter { !$0.isEmpty }

        if !parts.isEmpty {
            Text(parts.joined(separator: " • "))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }
}

private struct HittingStatsTable: View {
    let yearByYear: [PlayerSeasonStats]
    let career: PlayerSeasonStatLine?

    private let columns = ["Year", "Team", "G", "AB", "H", "HR", "RBI", "SB", "AVG", "OBP", "SLG", "OPS"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Hitting")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity, alignment: .center)

            ScrollView(.horizontal, showsIndicators: false) {
                VStack(spacing: 0) {
                    // Header
                    HStack(spacing: 0) {
                        ForEach(columns, id: \.self) { col in
                            Text(col)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .frame(width: col == "Team" ? 60 : 44, alignment: col == "Year" || col == "Team" ? .leading : .trailing)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)

                    Divider().overlay(HobbyIQTheme.Colors.electricBlue.opacity(0.12))

                    // Year rows
                    ForEach(yearByYear) { season in
                        let s = season.stats
                        let levelSuffix = (season.level != nil && season.level != "MLB") ? " (\(season.level!))" : ""
                        HStack(spacing: 0) {
                            Text(season.season ?? "—")
                                .frame(width: 44, alignment: .leading)
                            Text("\(season.team ?? "—")\(levelSuffix)")
                                .frame(width: 60, alignment: .leading)
                                .lineLimit(1)
                            Text(s?.gamesPlayed.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.atBats.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.hits.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.homeRuns.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.rbi.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.stolenBases.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.avg ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.obp ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.slg ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.ops ?? "—").frame(width: 44, alignment: .trailing)
                        }
                        .font(.system(size: 10))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .padding(.vertical, 5)
                        .padding(.horizontal, 8)

                        Divider().overlay(HobbyIQTheme.Colors.electricBlue.opacity(0.06))
                    }

                    // Career row
                    if let c = career {
                        HStack(spacing: 0) {
                            Text("Career")
                                .fontWeight(.bold)
                                .frame(width: 44, alignment: .leading)
                            Text("")
                                .frame(width: 60, alignment: .leading)
                            Text(c.gamesPlayed.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.atBats.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.hits.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.homeRuns.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.rbi.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.stolenBases.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.avg ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.obp ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.slg ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.ops ?? "—").frame(width: 44, alignment: .trailing)
                        }
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.vertical, 5)
                        .padding(.horizontal, 8)
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

private struct PitchingStatsTable: View {
    let yearByYear: [PlayerSeasonStats]
    let career: PlayerSeasonStatLine?

    private let columns = ["Year", "Team", "W", "L", "ERA", "G", "GS", "SV", "IP", "K", "BB", "WHIP"]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pitching")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity, alignment: .center)

            ScrollView(.horizontal, showsIndicators: false) {
                VStack(spacing: 0) {
                    // Header
                    HStack(spacing: 0) {
                        ForEach(columns, id: \.self) { col in
                            Text(col)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .frame(width: col == "Team" ? 60 : 44, alignment: col == "Year" || col == "Team" ? .leading : .trailing)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)

                    Divider().overlay(HobbyIQTheme.Colors.electricBlue.opacity(0.12))

                    // Year rows
                    ForEach(yearByYear) { season in
                        let s = season.stats
                        let levelSuffix = (season.level != nil && season.level != "MLB") ? " (\(season.level!))" : ""
                        HStack(spacing: 0) {
                            Text(season.season ?? "—")
                                .frame(width: 44, alignment: .leading)
                            Text("\(season.team ?? "—")\(levelSuffix)")
                                .frame(width: 60, alignment: .leading)
                                .lineLimit(1)
                            Text(s?.wins.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.losses.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.era ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.gamesPlayed.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.gamesStarted.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.saves.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.inningsPitched ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.strikeOuts.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.baseOnBalls.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(s?.whip ?? "—").frame(width: 44, alignment: .trailing)
                        }
                        .font(.system(size: 10))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .padding(.vertical, 5)
                        .padding(.horizontal, 8)

                        Divider().overlay(HobbyIQTheme.Colors.electricBlue.opacity(0.06))
                    }

                    // Career row
                    if let c = career {
                        HStack(spacing: 0) {
                            Text("Career")
                                .fontWeight(.bold)
                                .frame(width: 44, alignment: .leading)
                            Text("")
                                .frame(width: 60, alignment: .leading)
                            Text(c.wins.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.losses.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.era ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.gamesPlayed.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.gamesStarted.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.saves.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.inningsPitched ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.strikeOuts.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.baseOnBalls.map { String($0) } ?? "—").frame(width: 44, alignment: .trailing)
                            Text(c.whip ?? "—").frame(width: 44, alignment: .trailing)
                        }
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.vertical, 5)
                        .padding(.horizontal, 8)
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

private struct DirectionBadge: View {
    let direction: String

    private var icon: String {
        switch direction.lowercased() {
        case "rising": "arrow.up.right"
        case "falling": "arrow.down.right"
        default: "arrow.right"
        }
    }

    private var color: Color {
        switch direction.lowercased() {
        case "rising": HobbyIQTheme.Colors.hobbyGreen
        case "falling": HobbyIQTheme.Colors.danger
        default: HobbyIQTheme.Colors.mutedText
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .bold))
            Text(direction.capitalized)
                .font(.subheadline.weight(.semibold))
        }
        .foregroundStyle(color)
    }
}

private struct ScoreBlock: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
            Text(title)
                .font(HobbyIQTheme.Typography.captionEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.small)
        .background(Color.white.opacity(0.03))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
}

private struct SimpleSectionCard: View {
    let title: String
    let rows: [(String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
            Text(title)
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity, alignment: .center)

            ForEach(rows, id: \.0) { row in
                HStack {
                    Text(row.0)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(row.1)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

#Preview {
    NavigationStack {
        PlayerIQView()
    }
}
