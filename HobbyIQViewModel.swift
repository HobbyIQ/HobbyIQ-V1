import Foundation

@MainActor
class HobbyIQViewModel: ObservableObject {
    @Published var searchResult: CardSearchResponse?
    @Published var estimateResult: CompIQEstimateResponse?
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let api = APIService.shared

    func search(query: String) async {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        isLoading = true
        errorMessage = nil
        do {
            searchResult = try await api.searchCards(query: query)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func estimate(subject: CompIQSubject, comps: [CompIQComp] = [], context: CompIQContext = CompIQContext(activeListings: nil, soldCount30d: nil, playerTrendScore: nil, scarcityScore: nil)) async {
        isLoading = true
        errorMessage = nil
        do {
            let request = CompIQEstimateRequest(subject: subject, comps: comps, context: context, debug: nil)
            estimateResult = try await api.estimateCard(request: request)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
