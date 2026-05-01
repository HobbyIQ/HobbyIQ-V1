import Foundation

@MainActor
class NetworkManager: ObservableObject {
    static let shared = NetworkManager()
    private let apiService = APIService.shared

    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var searchResult: CardSearchResponse?

    // Search cards by free-text query (calls /api/compiq/search)
    func searchCards(query: String) async {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        isLoading = true
        errorMessage = nil
        searchResult = nil
        do {
            searchResult = try await apiService.searchCards(query: query)
        } catch {
            print("[NetworkManager] searchCards error: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    // Price a card by free-text query (calls /api/compiq/price)
    func priceCard(query: String) async -> CardSearchResponse? {
        isLoading = true
        errorMessage = nil
        do {
            let result = try await apiService.priceCard(query: query)
            isLoading = false
            return result
        } catch {
            print("[NetworkManager] priceCard error: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            isLoading = false
            return nil
        }
    }

    // Full structured estimate for Add Card flow (calls /api/compiq/estimate)
    func estimateCard(request: CompIQEstimateRequest) async -> CompIQEstimateResponse? {
        isLoading = true
        errorMessage = nil
        do {
            let result = try await apiService.estimateCard(request: request)
            isLoading = false
            return result
        } catch {
            print("[NetworkManager] estimateCard error: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
            isLoading = false
            return nil
        }
    }
}
