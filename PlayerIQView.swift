// PlayerIQView.swift
// Dedicated player intelligence screen powered by the backend
// /api/playeriq/{playerName} + /history endpoints.
//
// Two entry modes:
//   1. Tab landing (no arg)  — shows a Top Movers leaderboard.
//   2. Detail (playerName)   — shows the full hero card, sub-scores,
//      market + performance breakdowns, score history chart, and any
//      related inventory cards.
//
// The route value type `PlayerIQDestination` is registered on every
// NavigationStack that wants to link into this view.

import SwiftUI
import SwiftData
import Charts

// MARK: - Navigation value type

/// Hashable navigation value so any NavigationStack can push PlayerIQView
/// via `.navigationDestination(for: PlayerIQDestination.self)`.
struct PlayerIQDestination: Hashable {
    let playerName: String
    let playerId: String?
}

// MARK: - Decodable API models

struct PlayerIQScoreDTO: Decodable, Equatable {
    let playerId: String
    let playerName: String
    let team: String?
    let position: String?
    let sport: String?
    let milbLevel: String?
    let market: MarketDTO
    let performance: PerformanceDTO
    let playerIQScore: Double
    let playerIQDirection: String
    let playerIQLabel: String
    let updatedAt: String
    let dataSource: String?
    let confidence: String?

    struct MarketDTO: Decodable, Equatable {
        let marketScore: Double
        let marketDirection: String
        let marketTrendPct: Double
        let cardCount: Int
        let topCardName: String?
        let confidence: String?
    }
    struct PerformanceDTO: Decodable, Equatable {
        let performanceScore: Double
        let performanceDirection: String
        let statLine: String?
        let last5Label: String?
        let momentumRatio: Double
        let confidence: String?
    }
}

struct PlayerIQHistoryDTO: Decodable {
    let playerName: String
    let playerId: String
    let points: [Point]
    let count: Int

    struct Point: Decodable, Equatable {
        let playerIQScore: Double
        let playerIQDirection: String
        let playerIQLabel: String
        let marketScore: Double
        let performanceScore: Double
        let updatedAt: String
        let dataSource: String?
    }
}

struct PlayerIQTopResponseDTO: Decodable {
    let players: [PlayerIQScoreDTO]
    let count: Int
}

// MARK: - Player Stats (MLB.com-style season + career)

/// Each numeric stat from the MLB Stats API is sometimes returned as a number
/// and sometimes as a string ("0.301", "2.1 IP"). We accept both at decode
/// time and surface a single display string.
enum StatValue: Decodable, Equatable {
    case string(String)
    case number(Double)
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let d = try? c.decode(Double.self) { self = .number(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        self = .null
    }

    var display: String {
        switch self {
        case .string(let s): return s
        case .number(let d):
            if d == floor(d) && abs(d) < 1e9 { return String(Int(d)) }
            return String(format: "%.3f", d)
        case .null: return "—"
        }
    }
}

struct PlayerStatsSeasonRowDTO: Decodable, Equatable {
    let season: String
    let team: String?
    let league: String?
    let level: String?
    let stats: [String: StatValue]
}

struct PlayerStatsGroupDTO: Decodable, Equatable {
    let yearByYear: [PlayerStatsSeasonRowDTO]
    let career: [String: StatValue]?
}

struct PlayerDraftInfoDTO: Decodable, Equatable {
    let year: String?
    let round: String?
    let pickNumber: Int?
    let team: String?
    let school: String?
    let type: String?
}

struct PlayerStatsPayloadDTO: Decodable, Equatable {
    let playerName: String
    let mlbPlayerId: Int?
    let fullName: String?
    let nickName: String?
    let position: String?
    let primaryNumber: String?
    let currentTeam: String?
    let currentTeamId: Int?
    let currentLevel: String?
    let bats: String?
    let throwsHand: String?
    let height: String?
    let weight: Int?
    let currentAge: Int?
    let active: Bool?
    let birthDate: String?
    let birthCity: String?
    let birthStateProvince: String?
    let birthCountry: String?
    let mlbDebutDate: String?
    let draft: PlayerDraftInfoDTO?
    let highSchool: String?
    let college: String?
    let hitting: PlayerStatsGroupDTO?
    let pitching: PlayerStatsGroupDTO?
    let status: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case playerName, mlbPlayerId, fullName, nickName, position, primaryNumber
        case currentTeam, currentTeamId, currentLevel, bats
        case throwsHand = "throws"
        case height, weight, currentAge, active
        case birthDate, birthCity, birthStateProvince, birthCountry
        case mlbDebutDate, draft, highSchool, college
        case hitting, pitching, status, updatedAt
    }
}

// MARK: - ViewModel

@MainActor
final class PlayerIQViewModel: ObservableObject {
    @Published var score: PlayerIQScoreDTO?
    @Published var history: [PlayerIQHistoryDTO.Point] = []
    @Published var top: [PlayerIQScoreDTO] = []
    @Published var playerStats: PlayerStatsPayloadDTO?
    @Published var isLoading = false
    @Published var isLoadingStats = false
    @Published var errorMessage: String?

    private let baseURL: String
    private let session: URLSession

    init(
        baseURL: String = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net",
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL.hasSuffix("/")
            ? String(baseURL.dropLast())
            : baseURL
        self.session = session
    }

    func loadPlayer(_ name: String) async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil

        async let scoreTask: PlayerIQScoreDTO? = fetchScore(playerName: name)
        async let historyTask: [PlayerIQHistoryDTO.Point] = fetchHistory(playerName: name)
        async let statsTask: PlayerStatsPayloadDTO? = fetchStats(playerName: name)

        let (s, h, st) = await (scoreTask, historyTask, statsTask)
        self.score = s
        self.history = h
        self.playerStats = st
        if s == nil {
            self.errorMessage = "No PlayerIQ score yet for \(name). Run a CompIQ estimate on one of their cards to seed it."
        }
    }

    func loadTop(direction: String? = nil, limit: Int = 15) async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil
        var components = URLComponents(string: "\(baseURL)/api/playeriq/top")
        var items: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(limit))]
        if let d = direction { items.append(URLQueryItem(name: "direction", value: d)) }
        components?.queryItems = items
        guard let url = components?.url else { return }
        do {
            let (data, resp) = try await session.data(from: url)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                self.errorMessage = "PlayerIQ leaderboard unavailable."
                return
            }
            let decoded = try JSONDecoder().decode(PlayerIQTopResponseDTO.self, from: data)
            self.top = decoded.players
        } catch {
            self.errorMessage = "Couldn't load PlayerIQ leaderboard."
        }
    }

    private func fetchScore(playerName: String) async -> PlayerIQScoreDTO? {
        guard let encoded = playerName.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ), let url = URL(string: "\(baseURL)/api/playeriq/\(encoded)") else { return nil }
        do {
            let (data, resp) = try await session.data(from: url)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return nil
            }
            return try JSONDecoder().decode(PlayerIQScoreDTO.self, from: data)
        } catch {
            return nil
        }
    }

    private func fetchHistory(playerName: String) async -> [PlayerIQHistoryDTO.Point] {
        guard let encoded = playerName.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ), let url = URL(string: "\(baseURL)/api/playeriq/\(encoded)/history?limit=30") else {
            return []
        }
        do {
            let (data, resp) = try await session.data(from: url)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return []
            }
            let decoded = try JSONDecoder().decode(PlayerIQHistoryDTO.self, from: data)
            return decoded.points
        } catch {
            return []
        }
    }

    private func fetchStats(playerName: String) async -> PlayerStatsPayloadDTO? {
        guard let encoded = playerName.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ), let url = URL(string: "\(baseURL)/api/playeriq/\(encoded)/stats") else { return nil }
        do {
            let (data, resp) = try await session.data(from: url)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return nil
            }
            return try JSONDecoder().decode(PlayerStatsPayloadDTO.self, from: data)
        } catch {
            return nil
        }
    }
}

// MARK: - View

struct PlayerIQView: View {
    /// Optional player to load on appear. When nil, view shows the Top Movers
    /// landing leaderboard.
    let destination: PlayerIQDestination?
    var onAccount: (() -> Void)? = nil

    @StateObject private var vm = PlayerIQViewModel()
    @State private var showAccount = false

    init(destination: PlayerIQDestination? = nil, onAccount: (() -> Void)? = nil) {
        self.destination = destination
        self.onAccount = onAccount
    }

    var body: some View {
        Group {
            if let dest = destination {
                detailView(dest: dest)
            } else {
                NavigationStack {
                    landingView
                        .navigationDestination(for: PlayerIQDestination.self) { d in
                            PlayerIQView(destination: d, onAccount: onAccount)
                        }
                }
            }
        }
        .sheet(isPresented: $showAccount) {
            AccountView().preferredColorScheme(.dark)
        }
    }

    // MARK: Landing (top movers)

    @ViewBuilder
    private var landingView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("PlayerIQ")
                        .font(.title2.bold())
                        .foregroundStyle(.blue)
                    Spacer()
                    AccountButton {
                        if let onAccount { onAccount() } else { showAccount = true }
                    }
                }
                .padding(.horizontal)

                Text("Top movers — combined card market + on-field momentum")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)

                if vm.isLoading && vm.top.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding()
                }

                VStack(spacing: 8) {
                    ForEach(vm.top, id: \.playerId) { p in
                        NavigationLink(value: PlayerIQDestination(
                            playerName: p.playerName, playerId: p.playerId
                        )) {
                            leaderboardRow(player: p)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)

                if let err = vm.errorMessage, vm.top.isEmpty {
                    Text(err).font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
        .background(Color.black.ignoresSafeArea())
        .task { await vm.loadTop(limit: 25) }
        .refreshable { await vm.loadTop(limit: 25) }
    }

    @ViewBuilder
    private func leaderboardRow(player p: PlayerIQScoreDTO) -> some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(directionColor(p.playerIQDirection).opacity(0.18))
                    .frame(width: 44, height: 44)
                Text("\(Int(p.playerIQScore.rounded()))")
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(directionColor(p.playerIQDirection))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(p.playerName).font(.subheadline.bold()).foregroundStyle(.primary)
                Text(p.playerIQLabel).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(Color.white.opacity(0.04))
        .cornerRadius(10)
    }

    // MARK: Detail (specific player)

    @ViewBuilder
    private func detailView(dest: PlayerIQDestination) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if vm.isLoading && vm.score == nil {
                    ProgressView().frame(maxWidth: .infinity).padding()
                } else if let s = vm.score {
                    headerCard(s)
                    heroCard(s)
                    bioCard()
                    marketCard(s)
                    performanceCard(s)
                    seasonAndCareerCard()
                    historyChart(playerName: s.playerName)
                    relatedCards(playerName: s.playerName)
                    actionButtons(playerName: s.playerName)
                } else if let err = vm.errorMessage {
                    Text(err)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding()
                }
            }
            .padding()
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(dest.playerName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.loadPlayer(dest.playerName) }
    }

    @ViewBuilder
    private func headerCard(_ s: PlayerIQScoreDTO) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(s.playerName).font(.title2.bold()).foregroundStyle(.primary)
            HStack(spacing: 6) {
                if let t = s.team, !t.isEmpty { Text(t) }
                if let p = s.position, !p.isEmpty { Text("· \(p)") }
                if let sport = s.sport, sport.lowercased() == "milb", let lvl = s.milbLevel {
                    Text("· \(lvl)").foregroundStyle(.orange)
                } else if let sport = s.sport {
                    Text("· \(sport.uppercased())").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func heroCard(_ s: PlayerIQScoreDTO) -> some View {
        let color = directionColor(s.playerIQDirection)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(Int(s.playerIQScore.rounded()))")
                    .font(.system(size: 56, weight: .heavy, design: .rounded))
                    .foregroundStyle(color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.playerIQLabel).font(.subheadline.bold()).foregroundStyle(color)
                    Text("PlayerIQ").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                directionBadge(s.playerIQDirection)
            }
            ProgressView(value: max(0, min(1, s.playerIQScore / 100)))
                .tint(color)
            Text("Market \(Int(s.market.marketScore.rounded())) · Performance \(Int(s.performance.performanceScore.rounded()))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(Color.white.opacity(0.05))
        .cornerRadius(14)
    }

    @ViewBuilder
    private func marketCard(_ s: PlayerIQScoreDTO) -> some View {
        let m = s.market
        VStack(alignment: .leading, spacing: 8) {
            Text("Market Trend").font(.headline)
            HStack(spacing: 8) {
                tag(label: m.marketDirection.uppercased(),
                    color: marketDirectionColor(m.marketDirection))
                Text(String(format: "%+.1f%%", m.marketTrendPct))
                    .font(.subheadline.bold())
                    .foregroundStyle(marketDirectionColor(m.marketDirection))
            }
            ProgressView(value: max(0, min(1, m.marketScore / 100)))
                .tint(.blue)
            Text("Based on \(m.cardCount) card\(m.cardCount == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let top = m.topCardName, !top.isEmpty {
                Text("Top card: \(top)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color.white.opacity(0.04))
        .cornerRadius(12)
    }

    @ViewBuilder
    private func performanceCard(_ s: PlayerIQScoreDTO) -> some View {
        let p = s.performance
        VStack(alignment: .leading, spacing: 8) {
            Text("Performance").font(.headline)
            if let line = p.statLine, !line.isEmpty {
                Text(line).font(.subheadline).foregroundStyle(.primary)
            }
            if let l5 = p.last5Label, !l5.isEmpty {
                Text(l5).font(.caption).foregroundStyle(.secondary)
            }
            ProgressView(value: max(0, min(1, p.performanceScore / 100)))
                .tint(.orange)
            Text(String(format: "%.2fx vs baseline", p.momentumRatio))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(Color.white.opacity(0.04))
        .cornerRadius(12)
    }

    // MARK: Season + Career Stats (MLB.com-style)

    @ViewBuilder
    private func bioCard() -> some View {
        if let s = vm.playerStats, s.status != "error", (s.fullName?.isEmpty == false) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 14) {
                    headshotView(mlbPlayerId: s.mlbPlayerId)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.fullName ?? s.playerName)
                            .font(.title3.bold())
                            .foregroundStyle(.primary)
                        if let nick = s.nickName, !nick.isEmpty {
                            Text("\"\(nick)\"")
                                .font(.subheadline.italic())
                                .foregroundStyle(.secondary)
                        }
                        HStack(spacing: 6) {
                            if let team = s.currentTeam {
                                Text(team).font(.subheadline).foregroundStyle(.secondary)
                            }
                            if let lvl = s.currentLevel {
                                Text(lvl)
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.blue.opacity(0.18))
                                    .foregroundStyle(.blue)
                                    .clipShape(Capsule())
                            }
                            if let num = s.primaryNumber {
                                Text("#\(num)")
                                    .font(.caption2.bold())
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    Spacer()
                }

                Divider().background(Color.white.opacity(0.08))

                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), alignment: .leading),
                        GridItem(.flexible(), alignment: .leading),
                    ],
                    alignment: .leading,
                    spacing: 8
                ) {
                    bioCell("Position", s.position)
                    bioCell("B/T", batThrowString(s))
                    bioCell("Height", s.height)
                    bioCell("Weight", s.weight.map { "\($0) lbs" })
                    bioCell("Age", s.currentAge.map { "\($0)" })
                    bioCell("Born", formatBirth(s))
                    bioCell("MLB Debut", s.mlbDebutDate)
                    bioCell("Status", s.active.map { $0 ? "Active" : "Inactive" })
                    bioCell("High School", s.highSchool)
                    bioCell("College", s.college)
                }

                if let d = s.draft {
                    Divider().background(Color.white.opacity(0.08))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Draft").font(.caption.bold()).foregroundStyle(.secondary)
                        Text(formatDraft(d))
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                        if let type = d.type {
                            Text(type)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .padding()
            .background(Color.white.opacity(0.04))
            .cornerRadius(12)
        }
    }

    @ViewBuilder
    private func headshotView(mlbPlayerId: Int?) -> some View {
        if let id = mlbPlayerId,
           let url = URL(string: "https://midfield.mlbstatic.com/v1/people/\(id)/spots/120") {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                default:
                    placeholderHeadshot()
                }
            }
            .frame(width: 72, height: 72)
            .background(Color.white.opacity(0.06))
            .clipShape(Circle())
            .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 1))
        } else {
            placeholderHeadshot()
                .frame(width: 72, height: 72)
                .background(Color.white.opacity(0.06))
                .clipShape(Circle())
        }
    }

    @ViewBuilder
    private func placeholderHeadshot() -> some View {
        Image(systemName: "person.fill")
            .font(.title2)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func bioCell(_ label: String, _ value: String?) -> some View {
        if let v = value, !v.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.caption2).foregroundStyle(.tertiary)
                Text(v).font(.subheadline).foregroundStyle(.primary)
            }
        }
    }

    private func batThrowString(_ s: PlayerStatsPayloadDTO) -> String? {
        guard s.bats != nil || s.throwsHand != nil else { return nil }
        return "\(s.bats ?? "—")/\(s.throwsHand ?? "—")"
    }

    private func formatBirth(_ s: PlayerStatsPayloadDTO) -> String? {
        let placeBits = [s.birthCity, s.birthStateProvince, s.birthCountry]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        let place = placeBits.isEmpty ? nil : placeBits.joined(separator: ", ")
        switch (s.birthDate, place) {
        case let (date?, place?): return "\(date) · \(place)"
        case let (date?, nil):    return date
        case let (nil, place?):   return place
        default:                  return nil
        }
    }

    private func formatDraft(_ d: PlayerDraftInfoDTO) -> String {
        var parts: [String] = []
        if let y = d.year { parts.append(y) }
        if let r = d.round { parts.append("Round \(r)") }
        if let pick = d.pickNumber { parts.append("Pick #\(pick)") }
        if let team = d.team { parts.append("by \(team)") }
        if let school = d.school { parts.append("from \(school)") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func seasonAndCareerCard() -> some View {
        if let stats = vm.playerStats {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Season & Career Stats").font(.headline)
                    Spacer()
                    if let lvl = stats.currentLevel {
                        Text(lvl)
                            .font(.caption.bold())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.blue.opacity(0.18))
                            .foregroundStyle(.blue)
                            .clipShape(Capsule())
                    }
                }
                identityLine(stats)

                if stats.status != "ok" {
                    Text("No MLB-tracked stats yet for this player.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    if let h = stats.hitting {
                        statsTable(title: "Hitting", group: h, keys: PlayerIQView.hittingDisplayKeys)
                    }
                    if let p = stats.pitching {
                        statsTable(title: "Pitching", group: p, keys: PlayerIQView.pitchingDisplayKeys)
                    }
                }

                Text("Source: MLB Stats API")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding()
            .background(Color.white.opacity(0.04))
            .cornerRadius(12)
        }
    }

    @ViewBuilder
    private func identityLine(_ s: PlayerStatsPayloadDTO) -> some View {
        let bits: [String] = [
            s.position,
            s.currentTeam,
            (s.bats != nil || s.throwsHand != nil)
                ? "B/T: \(s.bats ?? "—")/\(s.throwsHand ?? "—")"
                : nil,
            s.mlbDebutDate.map { "MLB debut \($0)" },
        ].compactMap { $0 }
        if !bits.isEmpty {
            Text(bits.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// Compact label list — kept short so it fits in a phone-width scroll row.
    private static let hittingDisplayKeys: [(String, String)] = [
        ("gamesPlayed", "G"), ("atBats", "AB"), ("hits", "H"), ("homeRuns", "HR"),
        ("rbi", "RBI"), ("stolenBases", "SB"), ("avg", "AVG"), ("obp", "OBP"),
        ("slg", "SLG"), ("ops", "OPS"),
    ]
    private static let pitchingDisplayKeys: [(String, String)] = [
        ("wins", "W"), ("losses", "L"), ("era", "ERA"), ("gamesPlayed", "G"),
        ("gamesStarted", "GS"), ("saves", "SV"), ("inningsPitched", "IP"),
        ("strikeOuts", "K"), ("baseOnBalls", "BB"), ("whip", "WHIP"),
    ]

    @ViewBuilder
    private func statsTable(
        title: String,
        group: PlayerStatsGroupDTO,
        keys: [(String, String)]
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.bold()).foregroundStyle(.primary)
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 4) {
                    // Header row
                    HStack(spacing: 12) {
                        statHeaderCell("YR", width: 52, leading: true)
                        statHeaderCell("TM", width: 64, leading: true)
                        ForEach(keys, id: \.0) { (_, label) in
                            statHeaderCell(label, width: 46)
                        }
                    }
                    Divider().background(Color.white.opacity(0.1))
                    // Year-by-year
                    ForEach(group.yearByYear, id: \.season) { row in
                        HStack(spacing: 12) {
                            statRowCell(row.season, width: 52, leading: true, bold: true)
                            statRowCell(
                                row.level == "MLB" || row.level == nil
                                    ? (row.team ?? "—")
                                    : "\(row.team ?? "—") (\(row.level!))",
                                width: 64, leading: true
                            )
                            ForEach(keys, id: \.0) { (key, _) in
                                statRowCell(row.stats[key]?.display ?? "—", width: 46)
                            }
                        }
                    }
                    // Career totals
                    if let career = group.career, !career.isEmpty {
                        Divider().background(Color.white.opacity(0.1))
                        HStack(spacing: 12) {
                            statRowCell("Career", width: 52, leading: true, bold: true)
                            statRowCell("—", width: 64, leading: true)
                            ForEach(keys, id: \.0) { (key, _) in
                                statRowCell(career[key]?.display ?? "—", width: 46, bold: true)
                            }
                        }
                    }
                }
            }
        }
    }

    private func statHeaderCell(_ text: String, width: CGFloat, leading: Bool = false) -> some View {
        Text(text)
            .font(.caption2.bold())
            .foregroundStyle(.secondary)
            .frame(width: width, alignment: leading ? .leading : .trailing)
    }

    private func statRowCell(
        _ text: String,
        width: CGFloat,
        leading: Bool = false,
        bold: Bool = false
    ) -> some View {
        Text(text)
            .font(bold ? .caption.bold().monospacedDigit() : .caption.monospacedDigit())
            .foregroundStyle(.primary)
            .frame(width: width, alignment: leading ? .leading : .trailing)
            .lineLimit(1)
    }

    @ViewBuilder
    private func historyChart(playerName: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PlayerIQ History").font(.headline)
            if vm.history.count < 3 {
                Text("Not enough history yet — check back after a few estimate cycles.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                let parsed = vm.history.compactMap { p -> (Date, Double)? in
                    guard let d = parseISO(p.updatedAt) else { return nil }
                    return (d, p.playerIQScore)
                }
                Chart {
                    ForEach(parsed.indices, id: \.self) { i in
                        LineMark(
                            x: .value("Date", parsed[i].0),
                            y: .value("Score", parsed[i].1)
                        )
                        .foregroundStyle(Color.blue)
                        PointMark(
                            x: .value("Date", parsed[i].0),
                            y: .value("Score", parsed[i].1)
                        )
                        .foregroundStyle(Color.blue.opacity(0.6))
                    }
                }
                .chartYScale(domain: 0...100)
                .frame(height: 180)
            }
        }
        .padding()
        .background(Color.white.opacity(0.04))
        .cornerRadius(12)
    }

    @ViewBuilder
    private func relatedCards(playerName: String) -> some View {
        RelatedInventoryCards(playerName: playerName)
    }

    @ViewBuilder
    private func actionButtons(playerName: String) -> some View {
        VStack(spacing: 8) {
            Button {
                NotificationCenter.default.post(
                    name: .searchIQAddToInventory,
                    object: nil,
                    userInfo: ["query": playerName]
                )
            } label: {
                Label("Search \(playerName) cards", systemImage: "magnifyingglass")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.top, 4)
    }

    // MARK: Helpers

    private func directionColor(_ d: String) -> Color {
        switch d.lowercased() {
        case "rising":  return .green
        case "falling": return .red
        default:        return .gray
        }
    }
    private func marketDirectionColor(_ d: String) -> Color {
        switch d.lowercased() {
        case "up":   return .green
        case "down": return .red
        default:     return .gray
        }
    }

    @ViewBuilder
    private func directionBadge(_ d: String) -> some View {
        let icon: String = {
            switch d.lowercased() {
            case "rising":  return "arrow.up.right"
            case "falling": return "arrow.down.right"
            default:        return "arrow.left.and.right"
            }
        }()
        Image(systemName: icon)
            .foregroundStyle(directionColor(d))
            .font(.title2.weight(.semibold))
    }

    @ViewBuilder
    private func tag(label: String, color: Color) -> some View {
        Text(label)
            .font(.caption2.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.18))
            .foregroundStyle(color)
            .cornerRadius(6)
    }

    private func parseISO(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

// MARK: - Related inventory cards (SwiftData)

private struct RelatedInventoryCards: View {
    let playerName: String
    @Query private var allCards: [CardItem]

    var body: some View {
        let matches = allCards.filter {
            $0.playerName.localizedCaseInsensitiveContains(playerName)
        }
        return VStack(alignment: .leading, spacing: 8) {
            Text("Your cards").font(.headline)
            if matches.isEmpty {
                Text("No cards in your inventory for this player.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(matches) { card in
                    NavigationLink(value: card) {
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayTitle(for: card))
                                    .font(.subheadline.bold())
                                    .foregroundStyle(.primary)
                                Text(displaySubtitle(for: card))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding()
        .background(Color.white.opacity(0.04))
        .cornerRadius(12)
    }

    private func displayTitle(for card: CardItem) -> String {
        [card.playerName, card.setName]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
    private func displaySubtitle(for card: CardItem) -> String {
        var parts: [String] = []
        if let y = card.year { parts.append(String(y)) }
        if !card.cardNumber.isEmpty { parts.append("#\(card.cardNumber)") }
        if !card.parallel.isEmpty { parts.append(card.parallel) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Preview

struct PlayerIQView_Previews: PreviewProvider {
    static var previews: some View {
        PlayerIQView()
            .preferredColorScheme(.dark)
    }
}
