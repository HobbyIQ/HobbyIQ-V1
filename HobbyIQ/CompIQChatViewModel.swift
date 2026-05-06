//
//  CompIQChatViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation

@MainActor
final class CompIQChatViewModel: ObservableObject {
    private let isMockMode = true
    private let recentSearchesKey = "com.hobbyiq.compiq.recentSearches"

    @Published var query = ""
    @Published private(set) var messages: [CompIQMessage]
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var recentSearches: [String]

    let suggestedPrompts: [String]

    private let apiClient: APIClient
    private let chatPath: String

    init(
        messages: [CompIQMessage] = [],
        suggestedPrompts: [String] = [
            "What is a Caleb Bonemer blue wave worth?",
            "Should I buy a Max Clark PSA 10 now?",
            "Compare purple vs blue wave for Blake Burke",
            "What is Roman Anthony's call-up value?"
        ],
        chatPath: String = "/api/compiq/chat"
    ) {
        self.messages = messages
        self.suggestedPrompts = suggestedPrompts
        self.apiClient = .shared
        self.chatPath = chatPath
        self.recentSearches = UserDefaults.standard.stringArray(forKey: recentSearchesKey) ?? []
    }

    init(
        apiClient: APIClient,
        messages: [CompIQMessage] = [],
        suggestedPrompts: [String] = [
            "What is a Caleb Bonemer blue wave worth?",
            "Should I buy a Max Clark PSA 10 now?",
            "Compare purple vs blue wave for Blake Burke",
            "What is Roman Anthony's call-up value?"
        ],
        chatPath: String = "/api/compiq/chat"
    ) {
        self.apiClient = apiClient
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
            let response: CompIQPromptResponse

            if isMockMode {
                try await Task.sleep(for: .seconds(Double.random(in: 1.1 ... 1.8)))
                response = mockResponse(for: trimmedPrompt)
            } else {
                response = try await apiClient.post(
                    path: chatPath,
                    body: CompIQPromptRequest(query: trimmedPrompt)
                )
            }

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

    private func mockResponse(for prompt: String) -> CompIQPromptResponse {
        let lowercasePrompt = prompt.lowercased()

        if lowercasePrompt.contains("caleb bonemer") {
            return CompIQPromptResponse(
                summary: "Caleb Bonemer Blue Wave autos are trading with healthy momentum, and current hobby activity supports a firm raw floor with meaningful graded upside.",
                estimatedRaw: 285,
                estimatedPsa10: 675,
                estimatedPsa9: 340,
                confidenceScore: 84,
                recommendation: "Buy on dips",
                explanationBullets: [
                    "Recent comps have clustered between $260 and $310 on clean raw copies.",
                    "PSA 10 premium remains strong because high-end buyers are leaning into upside bats.",
                    "Listing depth is not expanding fast enough to fully cool the market.",
                    "If performance holds, the next repricing likely happens in graded copies first."
                ],
                nextQuestions: [
                    "What is the PSA 10 worth?",
                    "Should I sell now?",
                    "What is the call-up value?"
                ]
            )
        }

        if lowercasePrompt.contains("blake burke") && lowercasePrompt.contains("purple") {
            return CompIQPromptResponse(
                summary: "Blake Burke purple autos remain liquid, but current pricing looks closer to fair than obvious value unless another offensive spike lands soon.",
                estimatedRaw: 138,
                estimatedPsa10: 325,
                estimatedPsa9: 190,
                confidenceScore: 77,
                recommendation: "Hold into strength",
                explanationBullets: [
                    "Recent comps have been stable, but buyers are selective above the last sale range.",
                    "Purple remains a solid middle-tier parallel, though it does not carry Blue Wave eye-appeal premium.",
                    "Liquidity is good enough to exit on a strong game without heavy slippage.",
                    "The market still wants a clearer catalyst before paying a new high."
                ],
                nextQuestions: [
                    "Compare purple vs blue wave",
                    "Should I grade this card?",
                    "What is the downside case?"
                ]
            )
        }

        if lowercasePrompt.contains("max clark") {
            return CompIQPromptResponse(
                summary: "Max Clark PSA 10 pricing still looks premium but defensible, with demand supported by broad collector conviction and long-term ceiling hype.",
                estimatedRaw: 245,
                estimatedPsa10: 590,
                estimatedPsa9: 335,
                confidenceScore: 82,
                recommendation: "Strong hold",
                explanationBullets: [
                    "PSA 10 copies are still clearing at a premium because demand remains deeper than supply.",
                    "The market is already pricing in star-level upside, which limits obvious bargain entries.",
                    "Even so, Clark has one of the strongest hobby demand profiles in the class.",
                    "Short-term pullbacks are more likely to be buying windows than thesis breaks."
                ],
                nextQuestions: [
                    "Should I buy now or wait?",
                    "What is his long-term ceiling?",
                    "How does he compare to Bonemer?"
                ]
            )
        }

        if lowercasePrompt.contains("roman anthony") {
            return CompIQPromptResponse(
                summary: "Roman Anthony cards are still trading like premium inventory, and call-up anticipation is keeping top parallels in demand despite already-rich pricing.",
                estimatedRaw: 310,
                estimatedPsa10: 760,
                estimatedPsa9: 415,
                confidenceScore: 81,
                recommendation: "Trim on spikes",
                explanationBullets: [
                    "Anthony remains one of the most liquid prospect names in the market.",
                    "Prices are being supported by both production and broad collector trust.",
                    "That said, the market has already priced in a lot of the good story.",
                    "Fresh spikes are more likely to be trim spots than blind chase spots."
                ],
                nextQuestions: [
                    "What is the PSA 10 ceiling?",
                    "Should I sell before the call-up?",
                    "Which parallel has the best upside?"
                ]
            )
        }

        if lowercasePrompt.contains("compare") || lowercasePrompt.contains("blue wave") || lowercasePrompt.contains("purple") {
            return CompIQPromptResponse(
                summary: "Blue Wave typically commands a stronger premium than purple in the current prospect market, especially when eye appeal matters to buyers browsing recent listings.",
                estimatedRaw: 128,
                estimatedPsa10: 295,
                estimatedPsa9: 182,
                confidenceScore: 79,
                recommendation: "Favor Blue Wave",
                explanationBullets: [
                    "Blue Wave parallels tend to pull stronger listing engagement and showcase better visually.",
                    "Purple remains liquid, but it usually caps lower in comparable player situations.",
                    "The spread widens when the player has fresh hobby momentum or prospect buzz.",
                    "If grading is part of the plan, the stronger premium usually belongs to Blue Wave."
                ],
                nextQuestions: [
                    "Which parallel should I buy?",
                    "What is the graded premium?",
                    "How much does scarcity matter here?"
                ]
            )
        }

        return CompIQPromptResponse(
            summary: "Current comps suggest a balanced market with moderate upside if the player keeps attracting hobby attention and listing supply stays disciplined.",
            estimatedRaw: 115,
            estimatedPsa10: 268,
            estimatedPsa9: 169,
            confidenceScore: 76,
            recommendation: "Accumulate selectively",
            explanationBullets: [
                "Recent sales show a stable range without clear capitulation from sellers.",
                "PSA 10 pricing still carries the strongest premium in active prospect segments.",
                "Collector demand appears steady, though not yet in breakout territory.",
                "Watching the next few sales should provide a cleaner directional signal."
            ],
            nextQuestions: [
                "Should I grade this card?",
                "What is the downside risk?",
                "How does this compare to similar comps?"
            ]
        )
    }

    private func saveRecentSearch(_ prompt: String) {
        var updatedSearches = recentSearches.filter { $0.caseInsensitiveCompare(prompt) != .orderedSame }
        updatedSearches.insert(prompt, at: 0)
        recentSearches = Array(updatedSearches.prefix(8))
        UserDefaults.standard.set(recentSearches, forKey: recentSearchesKey)
    }
}
