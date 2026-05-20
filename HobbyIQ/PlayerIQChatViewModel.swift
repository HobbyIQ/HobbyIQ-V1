//
//  PlayerIQChatViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation

@MainActor
final class PlayerIQChatViewModel: ObservableObject {
    @Published private(set) var messages: [PlayerIQMessage] = []
    @Published private(set) var isLoading = false
    @Published var error: String?

    private let recentSearchesKey = "com.hobbyiq.playeriq.recentSearches"
    @Published private(set) var recentSearches: [String]

    init(chatPath: String = "/api/compiq/estimate") {
        self.recentSearches = UserDefaults.standard.stringArray(forKey: recentSearchesKey) ?? []
    }

    func sendMessage(query: String) async {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedQuery.isEmpty == false else { return }

        error = nil
        messages.append(PlayerIQMessage(text: trimmedQuery, isUser: true))
        saveRecentSearch(trimmedQuery)
        isLoading = true

        defer { isLoading = false }

        do {
            let response = try await APIService.shared.analyzePlayer(query: trimmedQuery)
            let label = response.playerIQLabel ?? "—"
            let score = response.playerIQScore ?? 0
            messages.append(PlayerIQMessage(text: "\(response.playerName ?? trimmedQuery): \(label) (\(score))", isUser: false, response: response))
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func saveRecentSearch(_ query: String) {
        var updated = recentSearches.filter { $0.caseInsensitiveCompare(query) != .orderedSame }
        updated.insert(query, at: 0)
        recentSearches = Array(updated.prefix(8))
        UserDefaults.standard.set(recentSearches, forKey: recentSearchesKey)
    }
}
