enum League: String, CaseIterable, Identifiable {
    case mlb = "MLB"
    case milb = "MiLB"
    var id: String { rawValue }
}
import Foundation
import SwiftUI

@MainActor
class DailyIQViewModel: ObservableObject {
    @Published var mlbPlayers: [DailyIQPlayer] = []
    @Published var milbPlayers: [DailyIQPlayer] = []
    @Published var selectedLeague: League = .mlb
    @Published var isLoading: Bool = false
    @Published var error: String? = nil
    @Published var lastUpdated: String? = nil

    func fetchPlayers(date: String? = nil, limit: Int = 25, sessionId: String? = nil) async {
        isLoading = true
        error = nil
        do {
            let (mlb, milb) = try await DailyIQService.fetchBrief(date: date, sessionId: sessionId)
            self.mlbPlayers = mlb
            self.milbPlayers = milb
            self.lastUpdated = mlb.first?.lastUpdated ?? milb.first?.lastUpdated
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
