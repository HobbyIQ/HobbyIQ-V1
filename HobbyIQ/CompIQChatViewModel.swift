//
//  CompIQChatViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation

@MainActor
final class CompIQChatViewModel: ObservableObject {
    private let recentSearchesKey = "com.hobbyiq.compiq.recentSearches"

    @Published var query = ""
    @Published private(set) var messages: [CompIQMessage]
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var recentSearches: [String]

    let suggestedPrompts: [String]

    private let chatPath: String

    init(
        messages: [CompIQMessage] = [],
        suggestedPrompts: [String] = [
            "What is a Caleb Bonemer blue wave worth?",
            "Should I buy a Max Clark PSA 10 now?",
            "Compare purple vs blue wave for Blake Burke",
            "What is Roman Anthony's call-up value?"
        ],
        chatPath: String = "/api/compiq/estimate"
    ) {
        self.messages = messages
        self.suggestedPrompts = suggestedPrompts
        self.chatPath = chatPath
        self.recentSearches = UserDefaults.standard.stringArray(forKey: recentSearchesKey) ?? []
    }

    func sendCurrentQuery() async {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedQuery.isEmpty == false else { return }

        query = ""
        await send(prompt: trimmedQuery)
    }

    func rerunRecentSearch(_ prompt: String) async {
        query = prompt
        await sendCurrentQuery()
    }

    func send(prompt: String) async {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedPrompt.isEmpty == false else { return }

        errorMessage = nil
        isLoading = true

        messages.append(
            CompIQMessage(
                text: trimmedPrompt,
                isUser: true
            )
        )
        saveRecentSearch(trimmedPrompt)

        do {
            let response = try await APIService.shared.analyzeComp(query: trimmedPrompt).asPromptResponse()

            messages.append(
                CompIQMessage(
                    text: response.summary,
                    isUser: false,
                    response: response
                )
            )
        } catch {
            errorMessage = "CompIQ could not complete that search right now."
        }

        isLoading = false
    }

    private func saveRecentSearch(_ prompt: String) {
        var updatedSearches = recentSearches.filter { $0.caseInsensitiveCompare(prompt) != .orderedSame }
        updatedSearches.insert(prompt, at: 0)
        recentSearches = Array(updatedSearches.prefix(8))
        UserDefaults.standard.set(recentSearches, forKey: recentSearchesKey)
    }
}

private extension CompIQResponse {
    func asPromptResponse() -> CompIQPromptResponse {
        CompIQPromptResponse(
            summary: summary ?? "Live CompIQ results are available.",
            estimatedRaw: marketTier?.value ?? 0,
            estimatedPsa10: marketTier?.high ?? marketTier?.value ?? 0,
            estimatedPsa9: holdZone?.first ?? marketTier?.value ?? 0,
            confidenceScore: Int((confidence ?? 0) * 100),
            recommendation: trendAnalysis?.marketDirection?.capitalized ?? "Hold",
            explanationBullets: [
                trendAnalysis?.marketDirection,
                trendAnalysis?.changeFromOlderToRecent,
                trendAnalysis?.liquidity.map { "Liquidity: \($0)" }
            ].compactMap { $0 },
            nextQuestions: [
                "What is the PSA 10 worth?",
                "Should I buy now?",
                "How liquid is this card?"
            ]
        )
    }
}
