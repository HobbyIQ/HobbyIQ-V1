import SwiftUI

// MARK: - Response Models

private struct DIQDailyStats: Decodable {
    let hits: Int
    let atBats: Int
    let runs: Int
    let rbis: Int
    let homeRuns: Int
    let strikeouts: Int
    let walks: Int
    let battingAverage: String
    let ops: String
    let dailyStatsStatus: String?

    enum CodingKeys: String, CodingKey {
        case hits
        case atBats
        case runs
        case rbis
        case rbi
        case homeRuns
        case strikeouts
        case walks
        case battingAverage
        case ops
        case dailyStatsStatus
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hits = try container.decodeIfPresent(Int.self, forKey: .hits) ?? 0
        atBats = try container.decodeIfPresent(Int.self, forKey: .atBats) ?? 0
        runs = try container.decodeIfPresent(Int.self, forKey: .runs) ?? 0
        let rbisValue = try container.decodeIfPresent(Int.self, forKey: .rbis)
        let rbiValue = try container.decodeIfPresent(Int.self, forKey: .rbi)
        rbis = rbisValue ?? rbiValue ?? 0
        homeRuns = try container.decodeIfPresent(Int.self, forKey: .homeRuns) ?? 0
        strikeouts = try container.decodeIfPresent(Int.self, forKey: .strikeouts) ?? 0
        walks = try container.decodeIfPresent(Int.self, forKey: .walks) ?? 0
        battingAverage = try container.decodeIfPresent(String.self, forKey: .battingAverage) ?? ".000"
        ops = try container.decodeIfPresent(String.self, forKey: .ops) ?? ".000"
        dailyStatsStatus = try container.decodeIfPresent(String.self, forKey: .dailyStatsStatus)
    }
}

private struct DIQSeasonStats: Decodable {
    let battingAverage: String
    let homeRuns: Int
    let rbis: Int
    let obp: String
    let slg: String
    let ops: String
    let walks: Int
    let strikeouts: Int
    let walkToStrikeout: String?

    enum CodingKeys: String, CodingKey {
        case battingAverage
        case homeRuns
        case rbis
        case rbi
        case obp
        case onBasePercentage
        case slg
        case sluggingPercentage
        case ops
        case walks
        case strikeouts
        case walkToStrikeout
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        battingAverage = try container.decodeIfPresent(String.self, forKey: .battingAverage) ?? ".000"
        homeRuns = try container.decodeIfPresent(Int.self, forKey: .homeRuns) ?? 0
        let rbisValue = try container.decodeIfPresent(Int.self, forKey: .rbis)
        let rbiValue = try container.decodeIfPresent(Int.self, forKey: .rbi)
        rbis = rbisValue ?? rbiValue ?? 0
        obp = try container.decodeIfPresent(String.self, forKey: .obp)
            ?? (try container.decodeIfPresent(String.self, forKey: .onBasePercentage))
            ?? ".000"
        slg = try container.decodeIfPresent(String.self, forKey: .slg)
            ?? (try container.decodeIfPresent(String.self, forKey: .sluggingPercentage))
            ?? ".000"
        ops = try container.decodeIfPresent(String.self, forKey: .ops) ?? ".000"
        walks = try container.decodeIfPresent(Int.self, forKey: .walks) ?? 0
        strikeouts = try container.decodeIfPresent(Int.self, forKey: .strikeouts) ?? 0
        walkToStrikeout = try container.decodeIfPresent(String.self, forKey: .walkToStrikeout)
    }
}

private struct DIQPerformer: Decodable, Identifiable {
    var id: String { playerId }
    let playerId: String
    let playerName: String
    let team: String
    let league: String
    let level: String?
    let dailyStats: DIQDailyStats
    let seasonStats: DIQSeasonStats
}

private struct DIQBriefResponse: Decodable {
    let date: String
    let generatedAt: String
    let mlb: [DIQPerformer]
    let milb: [DIQPerformer]
}

// MARK: - API

private enum DailyIQAPI {
    static let baseURL = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

    static func fetchBrief(fresh: Bool = false) async throws -> DIQBriefResponse {
        var urlStr = baseURL + "/api/dailyiq/brief"
        if fresh { urlStr += "?fresh=true" }
        guard let url = URL(string: urlStr) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(DIQBriefResponse.self, from: data)
    }
}

// MARK: - View

struct DailyIQView: View {
    @State private var brief: DIQBriefResponse? = nil
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var hasData: Bool { brief != nil }
    private var mlbPerformers: [DIQPerformer] {
        brief?.mlb.filter { $0.league.caseInsensitiveCompare("MLB") == .orderedSame } ?? []
    }

    private var milbPerformers: [DIQPerformer] {
        brief?.milb.filter { $0.league.caseInsensitiveCompare("MiLB") == .orderedSame } ?? []
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && !hasData {
                    ProgressView("Loading DailyIQ...")
                        .tint(.blue)
                } else if let errorMessage, !hasData {
                    VStack(spacing: 12) {
                        Text("DailyIQ unavailable")
                            .font(.headline)
                            .foregroundColor(.white)
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundColor(.gray)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                        Button("Retry") {
                            Task { await loadBrief() }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    List {
                        if !mlbPerformers.isEmpty {
                            Section("MLB Top Performers") {
                                ForEach(mlbPerformers) { performer in
                                    PerformerRow(performer: performer)
                                        .listRowBackground(Color.black)
                                }
                            }
                        }
                        if !milbPerformers.isEmpty {
                            Section("MiLB Top Performers") {
                                ForEach(milbPerformers) { performer in
                                    PerformerRow(performer: performer)
                                        .listRowBackground(Color.black)
                                }
                            }
                        }
                        if mlbPerformers.isEmpty && milbPerformers.isEmpty {
                            Section {
                                let mlbCount = brief?.mlb.count ?? 0
                                let milbCount = brief?.milb.count ?? 0
                                Text("No performers loaded (API returned mlb:\(mlbCount) milb:\(milbCount))")
                                    .font(.caption)
                                    .foregroundColor(.orange)
                                    .listRowBackground(Color.black)
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .refreshable {
                        await loadBrief(fresh: true)
                    }
                }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("DailyIQ")
            .task {
                if !hasData {
                    await loadBrief()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func loadBrief(fresh: Bool = false) async {
        isLoading = true
        errorMessage = nil
        do {
            brief = try await DailyIQAPI.fetchBrief(fresh: fresh)
        } catch let decodingError as DecodingError {
            switch decodingError {
            case .keyNotFound(let key, _):
                errorMessage = "Missing field: \(key.stringValue)"
            case .typeMismatch(_, let ctx):
                errorMessage = "Type mismatch: \(ctx.debugDescription)"
            case .valueNotFound(_, let ctx):
                errorMessage = "Null value: \(ctx.debugDescription)"
            case .dataCorrupted(let ctx):
                errorMessage = "Data error: \(ctx.debugDescription)"
            @unknown default:
                errorMessage = "Decode error: \(decodingError)"
            }
        } catch {
            errorMessage = "Network error: \(error.localizedDescription)"
        }
        isLoading = false
    }
}

// MARK: - Performer Row

private struct PerformerRow: View {
    let performer: DIQPerformer

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(performer.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)
                    Text("\(performer.team) · \(performer.league)")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                Spacer()
                Text("BA \(performer.seasonStats.battingAverage)")
                    .font(.caption.monospacedDigit())
                    .foregroundColor(.blue)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.blue.opacity(0.12))
                    .clipShape(Capsule())
            }

            let s = performer.dailyStats
            Text("\(s.hits)-\(s.atBats)  \(s.homeRuns) HR  \(s.rbis) RBI  \(s.walks) BB  \(s.strikeouts) K  OPS \(s.ops)")
                .font(.caption.monospacedDigit())
                .foregroundColor(.white.opacity(0.85))

            HStack(spacing: 12) {
                statChip("HR", "\(performer.seasonStats.homeRuns)")
                statChip("RBI", "\(performer.seasonStats.rbis)")
                statChip("OPS", performer.seasonStats.ops)
            }
        }
        .padding(.vertical, 6)
    }

    private func statChip(_ label: String, _ value: String) -> some View {
        HStack(spacing: 3) {
            Text(label)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(.secondary)
            Text(value)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.white)
        }
    }
}

#Preview {
    DailyIQView()
}
