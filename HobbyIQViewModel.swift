import Foundation

@MainActor
class HobbyIQViewModel: ObservableObject {
    static let shared = HobbyIQViewModel()
    private init() {}

    // MARK: - Input fields (bound to CompIQView form)
    @Published var playerName = ""
    @Published var cardName   = ""
    @Published var parallel   = ""
    @Published var grade      = "Raw"
    @Published var costInput  = ""

    // MARK: - State
    @Published var isLoading    = false
    @Published var errorMessage: String?
    @Published var estimateResult: CompIQEstimateResult?

    // MARK: - Legacy
    @Published var searchResult: CardSearchResponse?

    private let api = APIService.shared

    // MARK: - priceCard (called by CompIQView)
    func priceCard() async {
        let name = playerName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else {
            errorMessage = "Player name is required."
            return
        }
        isLoading     = true
        errorMessage  = nil
        estimateResult = nil

        let (cardYear, product, isAuto) = parseCardName(cardName)
        let parallelVal = parallel.trimmingCharacters(in: .whitespaces).isEmpty ? nil
                        : parallel.trimmingCharacters(in: .whitespaces)
        let gradeVal    = grade == "Raw" ? nil : grade

        let request = CompIQPriceRequest(
            playerName: name,
            cardYear: cardYear,
            product: product,
            parallel: parallelVal,
            grade: gradeVal,
            isAuto: isAuto
        )
        do {
            let response = try await api.priceCardEstimate(request: request)
            estimateResult = response.asEstimateResult(requestedParallel: parallelVal)
        } catch {
            errorMessage = "Pricing failed — please try again."
        }
        isLoading = false
    }

    // MARK: - Parse card name into (year, product, isAuto)
    private func parseCardName(_ raw: String) -> (Int?, String, Bool?) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return (nil, "Bowman Chrome", nil) }
        let lower   = trimmed.lowercased()
        let isAuto  = lower.contains("auto") ? true : nil
        var year: Int? = nil
        for token in trimmed.components(separatedBy: .whitespaces) {
            if let y = Int(token), y >= 2010 && y <= 2030 { year = y; break }
        }
        return (year, trimmed, isAuto)
    }

    // MARK: - Legacy helpers
    func search(query: String) async {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        isLoading    = true
        errorMessage = nil
        do {
            searchResult = try await api.searchCards(query: query)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func estimate(subject: CompIQSubject, comps: [CompIQComp] = [], context: CompIQContext = CompIQContext(activeListings: nil, soldCount30d: nil, playerTrendScore: nil, scarcityScore: nil)) async {
        isLoading    = true
        errorMessage = nil
        do {
            let request = CompIQEstimateRequest(subject: subject, comps: comps, context: context, debug: nil)
            let response = try await api.estimateCard(request: request)
            _ = response // legacy path — not mapped to estimateResult
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

