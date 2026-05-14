import SwiftUI

struct DailyIQView: View {
    @StateObject private var viewModel = DailyIQViewModel()
    @State private var showError = false

    var body: some View {
        NavigationStack {
            VStack {
                Picker("League", selection: $viewModel.selectedLeague) {
                    ForEach(League.allCases) { league in
                        Text(league.rawValue).tag(league)
                    }
                }
                .pickerStyle(.segmented)
                .padding([.horizontal, .top])

                Group {
                    if viewModel.isLoading {
                        ProgressView("Loading top performers...")
                            .padding()
                    } else if let error = viewModel.error {
                        VStack(spacing: 16) {
                            Text("Failed to load DailyIQ performers.")
                                .foregroundColor(.red)
                            Text(error)
                                .font(.caption)
                                .foregroundColor(.gray)
                            Button("Retry") {
                                Task { await viewModel.fetchPlayers() }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .padding()
                    } else if (viewModel.selectedLeague == .mlb ? viewModel.mlbPlayers : viewModel.milbPlayers).isEmpty {
                        Text("No top performers found.")
                            .foregroundColor(.gray)
                            .padding()
                    } else {
                        List(viewModel.selectedLeague == .mlb ? viewModel.mlbPlayers : viewModel.milbPlayers) { player in
                            NavigationLink(value: PlayerIQDestination(
                                playerName: player.playerName,
                                playerId: player.playerId
                            )) {
                                VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text("#\(player.rank)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                    Text(player.playerName)
                                        .font(.headline)
                                    if let label = player.playerIQLabel, !label.isEmpty {
                                        Text(label)
                                            .font(.caption2.bold())
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(playerIQColor(player.playerIQDirection).opacity(0.18))
                                            .foregroundColor(playerIQColor(player.playerIQDirection))
                                            .clipShape(Capsule())
                                    }
                                    Spacer()
                                    if let score = player.playerIQScore {
                                        Text("IQ \(Int(score.rounded()))")
                                            .font(.caption.monospacedDigit())
                                            .foregroundColor(playerIQColor(player.playerIQDirection))
                                    }
                                    if player.isOnWatchlist {
                                        Image(systemName: "eye.fill")
                                            .foregroundColor(.blue)
                                    }
                                }
                                Text(player.teamAbbreviation)
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)
                                HStack(spacing: 12) {
                                    Text("Score: \(String(format: "%.2f", player.rankingScore))")
                                        .font(.caption2)
                                        .foregroundColor(.orange)
                                    Text(player.position)
                                        .font(.caption2)
                                        .foregroundColor(.gray)
                                    // MiLB badges
                                    if viewModel.selectedLeague == .milb {
                                        if let level = player.level, !level.isEmpty {
                                            Text(level)
                                                .font(.caption2)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(Color.gray.opacity(0.18))
                                                .foregroundColor(.gray)
                                                .clipShape(Capsule())
                                        }
                                        if let mlbPersonId = (player as? (any Identifiable & Codable))?.id, !mlbPersonId.isEmpty, player.level != nil {
                                            // If mlbPersonId is present, show call-up badge (assume player has mlbPersonId if on 40-man)
                                            if player.mlbPersonId != nil {
                                                Text("⚡ Call-Up Watch")
                                                    .font(.caption2)
                                                    .padding(.horizontal, 6)
                                                    .padding(.vertical, 2)
                                                    .background(Color.orange.opacity(0.18))
                                                    .foregroundColor(.orange)
                                                    .clipShape(Capsule())
                                            }
                                        }
                                    }
                                }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .listStyle(.plain)
                    }
                }
            }
            .navigationTitle("DailyIQ Top Performers")
            .navigationDestination(for: PlayerIQDestination.self) { dest in
                PlayerIQView(destination: dest)
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task { await viewModel.fetchPlayers() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .onAppear {
                if viewModel.mlbPlayers.isEmpty && viewModel.milbPlayers.isEmpty {
                    Task { await viewModel.fetchPlayers() }
                }
            }
        }
    }

    private func playerIQColor(_ direction: String?) -> Color {
        switch (direction ?? "").lowercased() {
        case "rising":  return .green
        case "falling": return .red
        default:        return .gray
        }
    }
}

struct DailyIQView_Previews: PreviewProvider {
    static var previews: some View {
        DailyIQView()
            .preferredColorScheme(.dark)
    }
}
