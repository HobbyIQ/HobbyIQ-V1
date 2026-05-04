import Foundation

private struct SearchRequest: Codable {
    let query: String
}

private struct SearchResponse: Codable {
    let success: Bool?
    let query: String?
    let summary: String?
    let marketTier: SearchMarketTier?
    let confidence: Double?
    let recentComps: [SearchComp]?
    let trendAnalysis: SearchTrend?
}

private struct SearchMarketTier: Codable {
    let value: Double?
    let high: Double?
}

private struct SearchComp: Codable {
    let title: String?
}

private struct SearchTrend: Codable {
    let market_direction: String?
    let change_from_older_to_recent: String?
    let liquidity: String?
}

struct CompIQResult: Codable, Identifiable, Equatable {
    let id = UUID()
    let cardTitle: String
    let subject: [String: AnyCodable]
    let verdict: String
    let action: String
    let dealScore: Int
    let quickSaleValue: Int
    let fairMarketValue: Int
    let premiumValue: Int
    let explanation: [String]
    let marketDNA: [String]
    let confidence: [String: AnyCodable]
    let exitStrategy: [String: AnyCodable]
    let freshness: String?
    let lastUpdated: Date
}

enum CompIQAPI {
    static func estimate(for query: String) async -> CompIQResult? {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else { return nil }

        do {
            let url = URL(string: "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/compiq/search")!
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.timeoutInterval = 60
            request.httpBody = try JSONEncoder().encode(SearchRequest(query: trimmedQuery))

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                return nil
            }

            let decoded = try JSONDecoder().decode(SearchResponse.self, from: data)
            guard decoded.success ?? false else { return nil }

            let fairValue = Int((decoded.marketTier?.value ?? 0).rounded())
            let premiumValue = Int((decoded.marketTier?.high ?? decoded.marketTier?.value ?? 0).rounded())
            let quickSaleValue = Int((Double(fairValue) * 0.85).rounded())
            let dealScore = max(1, min(99, Int(((decoded.confidence ?? 0.5) * 100).rounded())))

            let trendDirection = decoded.trendAnalysis?.market_direction?.capitalized ?? "Neutral"
            let liquidity = decoded.trendAnalysis?.liquidity ?? "Unknown liquidity"
            let change = decoded.trendAnalysis?.change_from_older_to_recent ?? "No trend delta"

            let verdict: String
            let action: String
            switch decoded.trendAnalysis?.market_direction?.lowercased() {
            case "up":
                verdict = "Bullish"
                action = "Buy"
            case "down":
                verdict = "Caution"
                action = "Hold"
            default:
                verdict = "Neutral"
                action = "Watch"
            }

            let title = decoded.query ?? trimmedQuery
            let summary = decoded.summary ?? "Live HobbyIQ market data"
            let firstComp = decoded.recentComps?.first?.title ?? "No recent comp title"

            return CompIQResult(
                cardTitle: title,
                subject: [
                    "query": AnyCodable(title),
                    "source": AnyCodable("live-api")
                ],
                verdict: verdict,
                action: action,
                dealScore: dealScore,
                quickSaleValue: quickSaleValue,
                fairMarketValue: fairValue,
                premiumValue: premiumValue,
                explanation: [
                    summary,
                    "Trend: \(trendDirection) (\(change))",
                    "Recent comp: \(firstComp)"
                ],
                marketDNA: [
                    trendDirection,
                    liquidity,
                    "Confidence \(dealScore)%"
                ],
                confidence: [
                    "score": AnyCodable(dealScore)
                ],
                exitStrategy: [
                    "plan": AnyCodable("List near premium in strong markets")
                ],
                freshness: "Live",
                lastUpdated: Date()
            )
        } catch {
            return nil
        }
    }
}
