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

    private let apiClient: APIClient
    private let chatPath: String

    init(chatPath: String = "/api/playeriq/chat") {
        self.apiClient = .shared
        self.chatPath = chatPath
    }

    func sendMessage(query: String) async {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedQuery.isEmpty == false else { return }

        error = nil
        messages.append(PlayerIQMessage(text: trimmedQuery, isUser: true))
        isLoading = true

        do {
            let response: PlayerIQResponse

            if APIConfig.preferLiveData {
                do {
                    let liveResponse: PlayerIQAPIResponse = try await apiClient.post(
                        path: chatPath,
                        body: PlayerIQPromptRequest(query: trimmedQuery)
                    )
                    response = liveResponse.asPlayerIQResponse()
                } catch {
                    guard APIConfig.fallbackToMockData else { throw error }
                    try await Task.sleep(for: .seconds(0.6))
                    response = mockResponse(for: trimmedQuery)
                }
            } else {
                try await Task.sleep(for: .seconds(Double.random(in: 1.1 ... 1.8)))
                response = mockResponse(for: trimmedQuery)
            }

            messages.append(
                PlayerIQMessage(
                    text: response.summary,
                    isUser: false,
                    response: response
                )
            )
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    private func mockResponse(for query: String) -> PlayerIQResponse {
        let normalized = query.lowercased()

        if normalized.contains("blake burke") {
            return PlayerIQResponse(
                player: PlayerProfile(
                    name: "Blake Burke",
                    organization: "Milwaukee Brewers",
                    position: "1B",
                    level: "AA"
                ),
                summary: "Burke remains a bat-led profile with real impact potential, but the investment case is narrower because the profile needs the hit-power combo to fully carry the outcome.",
                overallScore: 78,
                tier: .watch,
                investmentTake: "Selective buy when momentum cools and pricing resets.",
                talentBreakdown: PlayerIQTalentBreakdown(
                    hit: 57,
                    power: 64,
                    speed: 39,
                    fielding: 45,
                    arm: 48
                ),
                marketBreakdown: PlayerIQMarketBreakdown(
                    demand: 71,
                    supply: 58,
                    liquidity: 66,
                    marketTrend: 68,
                    confidenceScore: 77
                ),
                riskFactors: [
                    "First-base profile puts full pressure on the bat.",
                    "Short-term hobby demand can fade quickly if homer output cools.",
                    "There is less defensive cushion than with premium up-the-middle prospects."
                ],
                nextQuestions: [
                    "Compare to Caleb Bonemer",
                    "What are his card values?",
                    "What is the downside case?"
                ],
                cardMarketSnapshot: CardMarketSnapshot(
                    activeListings: 34,
                    averageMarketPrice: 138,
                    averageFairValue: 124,
                    marketHeat: "Measured",
                    note: "Market is active, but buyers are selective above recent sale highs."
                ),
                topGemRateCards: [
                    TopGemRateCard(
                        cardName: "2024 Bowman Chrome Auto",
                        parallel: "Blue Refractor",
                        gemRateSignal: "Above Average",
                        confidence: 76
                    )
                ],
                topParallelsToBuy: [
                    ParallelBuyRecommendation(
                        cardName: "2024 Bowman Chrome Auto",
                        parallel: "Purple Refractor",
                        estimatedMarketPrice: 138,
                        estimatedFairValue: 122,
                        buyRating: "Watch",
                        valueGap: -16,
                        liquiditySignal: "Healthy",
                        scarcitySignal: "Moderate",
                        gemRateSignal: "Average",
                        whyItsABuy: "Still liquid enough to trade, but the price needs to cool before edge appears.",
                        buyUnder: 118,
                        confidence: 74,
                        activeListings: 34,
                        twoWeekSupplyChangePercent: 11,
                        supplyTrend: "Up",
                        supplyPressure: "Building"
                    )
                ],
                buyOpportunities: [
                    ParallelBuyRecommendation(
                        cardName: "2024 Bowman Chrome Auto",
                        parallel: "Blue Refractor",
                        estimatedMarketPrice: 198,
                        estimatedFairValue: 176,
                        buyRating: "Selective Buy",
                        valueGap: -22,
                        liquiditySignal: "Good",
                        scarcitySignal: "Better",
                        gemRateSignal: "Strong",
                        whyItsABuy: "Cleaner scarcity profile with enough liquidity to matter if the bat heats up again.",
                        buyUnder: 175,
                        confidence: 78,
                        activeListings: 16,
                        twoWeekSupplyChangePercent: -8,
                        supplyTrend: "Down",
                        supplyPressure: "Light"
                    )
                ],
                ebaySupplySnapshot: EbaySupplySnapshot(
                    currentActiveListings: 34,
                    twoWeekSupplyChangePercent: 11,
                    twoWeekSupplyTrend: "Rising",
                    supplySignal: "Neutral to Heavy",
                    supplyNote: "Supply is drifting higher, which caps upside unless performance reaccelerates."
                )
            )
        }

        if normalized.contains("max clark") {
            return PlayerIQResponse(
                player: PlayerProfile(
                    name: "Max Clark",
                    organization: "Detroit Tigers",
                    position: "OF",
                    level: "A+"
                ),
                summary: "Clark still looks like one of the cleaner long-term bets in the prospect market thanks to athleticism, broad collector demand, and a profile with star-level narrative support.",
                overallScore: 89,
                tier: .elite,
                investmentTake: "Core long-term hold with premium hobby durability.",
                talentBreakdown: PlayerIQTalentBreakdown(
                    hit: 65,
                    power: 56,
                    speed: 68,
                    fielding: 63,
                    arm: 61
                ),
                marketBreakdown: PlayerIQMarketBreakdown(
                    demand: 88,
                    supply: 43,
                    liquidity: 80,
                    marketTrend: 83,
                    confidenceScore: 85
                ),
                riskFactors: [
                    "Valuation already embeds a lot of future upside.",
                    "Development timeline still leaves room for volatility.",
                    "Premium cards can swing hard on prospect sentiment shifts."
                ],
                nextQuestions: [
                    "What's the ceiling?",
                    "Should I buy now or wait?",
                    "How do his cards compare to Bonemer?"
                ],
                cardMarketSnapshot: CardMarketSnapshot(
                    activeListings: 48,
                    averageMarketPrice: 245,
                    averageFairValue: 232,
                    marketHeat: "Strong",
                    note: "Collector demand remains broad enough to absorb most new listings."
                ),
                topGemRateCards: [
                    TopGemRateCard(
                        cardName: "2024 Bowman Chrome 1st",
                        parallel: "Base Auto",
                        gemRateSignal: "Strong",
                        confidence: 84
                    ),
                    TopGemRateCard(
                        cardName: "2024 Bowman Chrome 1st",
                        parallel: "Blue Wave Auto",
                        gemRateSignal: "Above Average",
                        confidence: 80
                    )
                ],
                topParallelsToBuy: [
                    ParallelBuyRecommendation(
                        cardName: "2024 Bowman Chrome 1st Auto",
                        parallel: "Blue Wave",
                        estimatedMarketPrice: 590,
                        estimatedFairValue: 545,
                        buyRating: "Strong Hold",
                        valueGap: -45,
                        liquiditySignal: "High",
                        scarcitySignal: "Strong",
                        gemRateSignal: "Above Average",
                        whyItsABuy: "Premium look plus strong buyer depth keeps this parallel near the top of the market stack.",
                        buyUnder: 540,
                        confidence: 84,
                        activeListings: 12,
                        twoWeekSupplyChangePercent: -6,
                        supplyTrend: "Down",
                        supplyPressure: "Light"
                    )
                ],
                buyOpportunities: [
                    ParallelBuyRecommendation(
                        cardName: "2024 Bowman Chrome 1st Auto",
                        parallel: "Base",
                        estimatedMarketPrice: 245,
                        estimatedFairValue: 232,
                        buyRating: "Accumulation",
                        valueGap: -13,
                        liquiditySignal: "Very High",
                        scarcitySignal: "Standard",
                        gemRateSignal: "Strong",
                        whyItsABuy: "Easiest entry point for broad demand with clean gem-rate support.",
                        buyUnder: 225,
                        confidence: 82,
                        activeListings: 48,
                        twoWeekSupplyChangePercent: 2,
                        supplyTrend: "Flat",
                        supplyPressure: "Balanced"
                    )
                ],
                ebaySupplySnapshot: EbaySupplySnapshot(
                    currentActiveListings: 48,
                    twoWeekSupplyChangePercent: 2,
                    twoWeekSupplyTrend: "Stable",
                    supplySignal: "Balanced",
                    supplyNote: "Supply is healthy, but demand remains strong enough to keep premium copies liquid."
                )
            )
        }

        if normalized.contains("gavin kilen") || normalized.contains("risk") || normalized.contains("downside") {
            return PlayerIQResponse(
                player: PlayerProfile(
                    name: "Gavin Kilen",
                    organization: "Cleveland Guardians",
                    position: "INF",
                    level: "A+"
                ),
                summary: "Kilen offers polished baseball feel and a credible hit-driven path, but the market is still deciding how much upside to assign to the profile and the near-term investment case remains fragile.",
                overallScore: 68,
                tier: .risk,
                investmentTake: "Avoid chasing until the profile earns stronger upper-level conviction.",
                talentBreakdown: PlayerIQTalentBreakdown(
                    hit: 58,
                    power: 47,
                    speed: 52,
                    fielding: 54,
                    arm: 51
                ),
                marketBreakdown: PlayerIQMarketBreakdown(
                    demand: 49,
                    supply: 55,
                    liquidity: 43,
                    marketTrend: 45,
                    confidenceScore: 71
                ),
                riskFactors: [
                    "Current hobby demand is not deep enough to absorb weak stretches cleanly.",
                    "The offensive ceiling may settle below premium hobby archetypes.",
                    "Without a sharper performance spike, the market can drift sideways for a long time."
                ],
                nextQuestions: [
                    "How does he compare to Bonemer?",
                    "What would make him a buy?",
                    "What are his card values?"
                ],
                cardMarketSnapshot: CardMarketSnapshot(
                    activeListings: 29,
                    averageMarketPrice: 72,
                    averageFairValue: 64,
                    marketHeat: "Soft",
                    note: "The market remains thin and reactive, which increases downside volatility."
                ),
                topGemRateCards: [],
                topParallelsToBuy: [],
                buyOpportunities: [
                    ParallelBuyRecommendation(
                        cardName: "2024 Bowman Chrome 1st Auto",
                        parallel: "Blue Refractor",
                        estimatedMarketPrice: 109,
                        estimatedFairValue: 92,
                        buyRating: "Speculative",
                        valueGap: -17,
                        liquiditySignal: "Light",
                        scarcitySignal: "Good",
                        gemRateSignal: "Average",
                        whyItsABuy: "Only worth considering if you want low-exposure speculative upside with patience.",
                        buyUnder: 88,
                        confidence: 69,
                        activeListings: 8,
                        twoWeekSupplyChangePercent: 14,
                        supplyTrend: "Up",
                        supplyPressure: "Heavy"
                    )
                ],
                ebaySupplySnapshot: EbaySupplySnapshot(
                    currentActiveListings: 29,
                    twoWeekSupplyChangePercent: 14,
                    twoWeekSupplyTrend: "Rising",
                    supplySignal: "Heavy",
                    supplyNote: "Supply is expanding faster than demand, which increases the risk of dead money."
                )
            )
        }

        return PlayerIQResponse(
            player: PlayerProfile(
                name: "Caleb Bonemer",
                organization: "Chicago White Sox",
                position: "SS / 3B",
                level: "High-A"
            ),
            summary: "Bonemer looks like a high-upside bat-first infield prospect with improving impact and a market that still has room to climb before full consensus fully settles in.",
            overallScore: 84,
            tier: .strong,
            investmentTake: "Accumulation candidate before broad hobby consensus fully catches up.",
            talentBreakdown: PlayerIQTalentBreakdown(
                hit: 78,
                power: 74,
                speed: 61,
                fielding: 58,
                arm: 66
            ),
            marketBreakdown: PlayerIQMarketBreakdown(
                demand: 79,
                supply: 47,
                liquidity: 67,
                marketTrend: 76,
                confidenceScore: 81
            ),
            riskFactors: [
                "Defensive home remains fluid, which could affect long-term value framing.",
                "Power output still needs to fully validate premium bat-first pricing.",
                "Short-term market enthusiasm could outrun fundamentals if hype spikes."
            ],
            nextQuestions: [
                "Compare to Blake Burke",
                "What are his card values?",
                "What's the ceiling?"
            ],
            cardMarketSnapshot: CardMarketSnapshot(
                activeListings: 21,
                averageMarketPrice: 185,
                averageFairValue: 198,
                marketHeat: "Firm",
                note: "Pricing still looks constructive because listing depth remains relatively contained."
            ),
            topGemRateCards: [
                TopGemRateCard(
                    cardName: "2025 Bowman Chrome 1st Auto",
                    parallel: "Base Auto",
                    gemRateSignal: "Strong",
                    confidence: 82
                ),
                TopGemRateCard(
                    cardName: "2025 Bowman Chrome 1st Auto",
                    parallel: "Blue Wave Auto",
                    gemRateSignal: "Above Average",
                    confidence: 79
                )
            ],
            topParallelsToBuy: [
                ParallelBuyRecommendation(
                    cardName: "2025 Bowman Chrome 1st Auto",
                    parallel: "Blue Wave",
                    estimatedMarketPrice: 285,
                    estimatedFairValue: 312,
                    buyRating: "Buy",
                    valueGap: 27,
                    liquiditySignal: "Healthy",
                    scarcitySignal: "Strong",
                    gemRateSignal: "Above Average",
                    whyItsABuy: "Demand is rising faster than listing supply, and eye appeal keeps this parallel liquid.",
                    buyUnder: 290,
                    confidence: 84,
                    activeListings: 9,
                    twoWeekSupplyChangePercent: -12,
                    supplyTrend: "Down",
                    supplyPressure: "Light"
                )
            ],
            buyOpportunities: [
                ParallelBuyRecommendation(
                    cardName: "2025 Bowman Chrome 1st Auto",
                    parallel: "Refractor",
                    estimatedMarketPrice: 220,
                    estimatedFairValue: 236,
                    buyRating: "Accumulate",
                    valueGap: 16,
                    liquiditySignal: "Good",
                    scarcitySignal: "Moderate",
                    gemRateSignal: "Strong",
                    whyItsABuy: "A cleaner entry point than premium parallels while still benefiting from the same player thesis.",
                    buyUnder: 225,
                    confidence: 80,
                    activeListings: 12,
                    twoWeekSupplyChangePercent: -5,
                    supplyTrend: "Down",
                    supplyPressure: "Balanced"
                ),
                ParallelBuyRecommendation(
                    cardName: "2025 Bowman Chrome 1st Auto",
                    parallel: "Base Auto",
                    estimatedMarketPrice: 185,
                    estimatedFairValue: 198,
                    buyRating: "Accumulation",
                    valueGap: 13,
                    liquiditySignal: "High",
                    scarcitySignal: "Standard",
                    gemRateSignal: "Strong",
                    whyItsABuy: "Most liquid exposure point with enough gem-rate support to matter if demand broadens further.",
                    buyUnder: 190,
                    confidence: 78,
                    activeListings: 21,
                    twoWeekSupplyChangePercent: -4,
                    supplyTrend: "Stable to Down",
                    supplyPressure: "Balanced"
                )
            ],
            ebaySupplySnapshot: EbaySupplySnapshot(
                currentActiveListings: 21,
                twoWeekSupplyChangePercent: -4,
                twoWeekSupplyTrend: "Stable to Down",
                supplySignal: "Constructive",
                supplyNote: "Supply has stayed contained while demand remains active, which supports buy-under discipline."
            )
        )
    }
}
