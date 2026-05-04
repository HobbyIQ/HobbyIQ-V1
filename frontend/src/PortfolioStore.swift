import Foundation
import Combine

class PortfolioStore: ObservableObject {
    @Published private(set) var holdings: [PortfolioHolding] = []
    @Published var sort: Sort = .highestValue
    @Published var filter: Filter = .all

    enum Sort: String, CaseIterable, Identifiable {
        case highestValue = "Highest Value"
        case biggestGain = "Biggest Gain"
        case recentlyUpdated = "Recently Updated"
        case bestSell = "Best Sell"
        var id: String { rawValue }
    }
    enum Filter: String, CaseIterable, Identifiable {
        case all = "All"
        case winners = "Winners"
        case losers = "Losers"
        case sellWatch = "Sell Watch"
        case risky = "Risky"
        var id: String { rawValue }
    }

    private let storageKey = "PortfolioHoldings"

    init() {
        load()
    }

    func add(_ holding: PortfolioHolding) {
        holdings.append(holding)
        save()
    }
    func update(_ holding: PortfolioHolding) {
        if let idx = holdings.firstIndex(where: { $0.id == holding.id }) {
            holdings[idx] = holding
            save()
        }
    }
    func remove(_ holding: PortfolioHolding) {
        holdings.removeAll { $0.id == holding.id }
        save()
    }
    func load() {
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let decoded = try? JSONDecoder().decode([PortfolioHolding].self, from: data) {
            holdings = decoded
        }
    }
    func save() {
        if let data = try? JSONEncoder().encode(holdings) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }
    var filteredSortedHoldings: [PortfolioHolding] {
        let filtered: [PortfolioHolding]
        switch filter {
        case .all: filtered = holdings
        case .winners: filtered = holdings.filter { $0.profitLoss > 0 }
        case .losers: filtered = holdings.filter { $0.profitLoss < 0 }
        case .sellWatch: filtered = holdings.filter { $0.status.lowercased().contains("sell") }
        case .risky: filtered = holdings.filter { $0.marketDNA.contains(where: { $0.lowercased().contains("risk") }) }
        }
        switch sort {
        case .highestValue: return filtered.sorted { $0.currentValue > $1.currentValue }
        case .biggestGain: return filtered.sorted { $0.profitLoss > $1.profitLoss }
        case .recentlyUpdated: return filtered.sorted { $0.lastUpdated > $1.lastUpdated }
        case .bestSell: return filtered.sorted { $0.status.lowercased().contains("sell") && !$1.status.lowercased().contains("sell") }
        }
    }
}
