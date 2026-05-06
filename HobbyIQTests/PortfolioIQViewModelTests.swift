import Foundation
import XCTest
@testable import HobbyIQ

@MainActor
final class PortfolioIQSummaryViewModelTests: XCTestCase {
    override func tearDown() {
        URLProtocolMock.requestHandler = nil
        super.tearDown()
    }

    func testDeleteRemovesCardAndRefreshesSummary() async throws {
        let card = PortfolioCardDetail(
            id: "card-1",
            playerName: "Test Player",
            cardName: "Test Card",
            cost: 100,
            currentValue: 150,
            profitLoss: 50,
            roi: 50,
            purchaseDate: nil,
            purchasePlatform: nil,
            notes: nil,
            lastPricedAt: nil,
            signal: "hold",
            format: nil,
            sellReason: nil
        )

        let initialSummary = PortfolioSummaryResponse(
            inventory: PortfolioInventorySummary(
                totalCost: 100,
                totalCurrentValue: 150,
                totalProfitLoss: 50,
                roi: 50,
                activeCount: 1
            ),
            accountSnapshot: PortfolioAccountSnapshot(
                userId: "demo",
                totalCards: 1,
                totalValue: 150,
                totalCost: 100,
                totalProfitLoss: 50,
                roi: 50,
                generatedAt: "2024-04-29T14:22:00Z"
            ),
            inventoryDetails: [card],
            bestCardsToSellNow: [],
            month: nil,
            year: nil
        )

        let refreshedSummaryBody = #"""
        {
          "inventory": {
            "totalCost": 0,
            "totalCurrentValue": 0,
            "totalProfitLoss": 0,
            "roi": 0,
            "activeCount": 0
          },
          "accountSnapshot": {
            "userId": "demo",
            "totalCards": 0,
            "totalValue": 0,
            "totalCost": 0,
            "totalProfitLoss": 0,
            "roi": 0,
            "generatedAt": "2024-04-29T14:22:00Z"
          },
          "inventoryDetails": [],
          "bestCardsToSellNow": [],
          "month": null,
          "year": null
        }
        """#.data(using: .utf8)!

        let service = makeService { request in
            switch request.url?.path {
            case "/api/portfolio/cards/card-1/delete":
                return (self.httpResponse(for: request, statusCode: 204), Data())
            case "/api/portfolio/summary":
                return (self.httpResponse(for: request, statusCode: 200), refreshedSummaryBody)
            default:
                XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
                return (self.httpResponse(for: request, statusCode: 404), Data())
            }
        }

        let viewModel = PortfolioIQSummaryViewModel(service: service, initialSummary: initialSummary)
        let deleted = await viewModel.delete(card)

        XCTAssertTrue(deleted)
        XCTAssertEqual(viewModel.inventorySummary?.activeCount, 0)
        XCTAssertEqual(viewModel.accountSnapshot?.totalCards, 0)
        XCTAssertTrue(viewModel.inventoryDetails.isEmpty)
        XCTAssertNil(viewModel.errorMessage)
    }

    private func makeService(
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> APIService {
        URLProtocolMock.requestHandler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolMock.self]
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 2

        let session = URLSession(configuration: configuration)
        return APIService(session: session)
    }

    private func httpResponse(for request: URLRequest, statusCode: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url ?? URL(string: "https://example.com")!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
    }
}
