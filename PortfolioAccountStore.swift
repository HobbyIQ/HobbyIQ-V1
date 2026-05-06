import Foundation

final class PortfolioAccountStore {
    static let shared = PortfolioAccountStore()

    private init() {}

    private func storageKey(for userId: String?) -> String {
        let normalized = (userId ?? "guest").trimmingCharacters(in: .whitespacesAndNewlines)
        return "portfolio.holdings.\(normalized.isEmpty ? "guest" : normalized)"
    }

    func loadHoldings(userId: String?) -> [PortfolioHolding] {
        let key = storageKey(for: userId)
        guard let data = UserDefaults.standard.data(forKey: key) else {
            return []
        }

        do {
            return try JSONDecoder().decode([PortfolioHolding].self, from: data)
        } catch {
            return []
        }
    }

    func saveHoldings(_ holdings: [PortfolioHolding], userId: String?) {
        let key = storageKey(for: userId)
        do {
            let data = try JSONEncoder().encode(holdings)
            UserDefaults.standard.set(data, forKey: key)
        } catch {
            // Keep UI responsive even if persistence fails.
        }
    }
}
