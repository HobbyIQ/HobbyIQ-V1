import SwiftUI

// MARK: - Models

struct DailyPlayerStat: Identifiable, Decodable {
    var id: String { "\(playerName)-\(team)-\(level)" }
    let playerName: String
    let team: String
    let level: String
    let position: String
    let statLine: String
    let performanceNote: String?
    let trend: String
    let hr: Int?
    let hits: Int?
    let rbi: Int?
    let strikeouts: Int?
    let era: Double?
    let isProspect: Bool?
    let buySignal: Bool?
}

private struct DailyIQResponse: Decodable {
    let date: String
    let stats: [DailyPlayerStat]
}

// MARK: - API

private enum DailyIQAPI {
    static let baseURL = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

    static func fetchMLB() async -> [DailyPlayerStat] {
        await fetchStats(path: "/api/dailyiq/mlb")
    }

    static func fetchMiLB() async -> [DailyPlayerStat] {
        await fetchStats(path: "/api/dailyiq/milb")
    }

    private static func fetchStats(path: String) async -> [DailyPlayerStat] {
        guard let url = URL(string: baseURL + path) else { return [] }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return [] }
        guard let response = try? JSONDecoder().decode(DailyIQResponse.self, from: data) else { return [] }
        return response.stats
    }
}

// MARK: - View

struct DailyIQView: View {
    @State private var mlbStats: [DailyPlayerStat] = []
    @State private var milbStats: [DailyPlayerStat] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var hasData: Bool { !mlbStats.isEmpty || !milbStats.isEmpty }

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
                            Task { await loadStats() }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                } else {
                    List {
                        if !mlbStats.isEmpty {
                            Section("MLB Top Performers") {
                                ForEach(mlbStats) { stat in
                                    PlayerStatRow(stat: stat)
                                        .listRowBackground(Color.black)
                                }
                            }
                        }
                        if !milbStats.isEmpty {
                            Section("MiLB Top Performers") {
                                ForEach(milbStats) { stat in
                                    PlayerStatRow(stat: stat)
                                        .listRowBackground(Color.black)
                                }
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                    .refreshable {
                        await loadStats()
                    }
                }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("DailyIQ")
            .task {
                if !hasData {
                    await loadStats()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func loadStats() async {
        isLoading = true
        errorMessage = nil

        async let mlb = DailyIQAPI.fetchMLB()
        async let milb = DailyIQAPI.fetchMiLB()
        let (mlbResult, milbResult) = await (mlb, milb)

        mlbStats = mlbResult
        milbStats = milbResult

        if mlbResult.isEmpty && milbResult.isEmpty {
            errorMessage = "No games found for yesterday. Check back after games are played."
        }
        isLoading = false
    }
}

// MARK: - Player Row

private struct PlayerStatRow: View {
    let stat: DailyPlayerStat

    private var trendColor: Color {
        switch stat.trend {
        case "hot":  return .orange
        case "up":   return .green
        case "cold": return .blue
        default:     return .gray
        }
    }

    private var trendLabel: String {
        switch stat.trend {
        case "hot":  return "🔥 Hot"
        case "up":   return "↑ Rising"
        case "cold": return "❄️ Cold"
        case "down": return "↓ Down"
        default:     return "— Flat"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(stat.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)
                    Text("\(stat.team) · \(stat.position)")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                Spacer()
                HStack(spacing: 6) {
                    if stat.buySignal == true {
                        Text("Buy Signal")
                            .font(.caption2.weight(.medium))
                            .foregroundColor(.green)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.green.opacity(0.15))
                            .clipShape(Capsule())
                    }
                    Text(trendLabel)
                        .font(.caption2.weight(.medium))
                        .foregroundColor(trendColor)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(trendColor.opacity(0.15))
                        .clipShape(Capsule())
                }
            }

            Text(stat.statLine)
                .font(.caption.monospacedDigit())
                .foregroundColor(.white.opacity(0.85))

            if let note = stat.performanceNote, !note.isEmpty {
                Text(note)
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 6)
    }
}

#Preview {
    DailyIQView()
}
