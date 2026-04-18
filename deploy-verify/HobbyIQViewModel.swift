import Foundation

@MainActor
class HobbyIQViewModel: ObservableObject {
    @Published var compResult: CompIQResponse?
    @Published var playerResult: PlayerIQResponse?
    @Published var isLoading = false
    @Published var errorMessage: String?

    let api = APIService()

    func runCompIQ() async {
        isLoading = true
        errorMessage = nil
        do {
            let request = CompIQRequest(
                player: "Test Player",
                cardType: "Bowman Chrome Auto",
                parallel: "Gold /50",
                grade: "PSA 10",
                recentComps: [120, 140, 160]
            )
            compResult = try await api.analyzeCompIQ(request: request)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func runPlayerIQ() async {
        isLoading = true
        errorMessage = nil
        do {
            let request = PlayerIQRequest(
                player: "Test Player",
                level: "AA",
                stats: .init(avg: 0.285, hr: 12, ops: 0.840)
            )
            playerResult = try await api.analyzePlayerIQ(request: request)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
