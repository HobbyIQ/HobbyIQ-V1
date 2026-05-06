import Foundation
import XCTest
@testable import HobbyIQ

@MainActor
final class PortfolioWorkspaceViewModelTests: XCTestCase {
    override func tearDown() {
        URLProtocolMock.requestHandler = nil
        super.tearDown()
    }

    func testLoadPopulatesSummaryAndInventoryFromAzureEndpoints() async throws {
        let service = makeService { request in
            switch request.url?.path {
            case "/api/portfolio/inventory":
                let body = #"""
                [
                  {
                    "id": "card-1",
                    "playerName": "Test Player",
                    "cardName": "Test Card",
                    "cost": 100,
                    "currentValue": 125,
                    "status": "Hold",
                    "year": "2024",
                    "setName": "Bowman",
                    "parallel": "Base",
                    "grade": "Raw"
                  }
                ]
                """#.data(using: .utf8)!
                return (self.httpResponse(for: request, statusCode: 200), body)
            case "/api/portfolio/summary":
                let body = #"""
                {
                  "month": { "totalSold": 2400, "totalProfit": 420, "margin": 0.175 },
                  "year": { "totalSold": 12800, "totalProfit": 2600, "margin": 0.203125 }
                }
                """#.data(using: .utf8)!
                return (self.httpResponse(for: request, statusCode: 200), body)
            default:
                XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
                return (self.httpResponse(for: request, statusCode: 404), Data())
            }
        }

        let viewModel = PortfolioWorkspaceViewModel(apiService: service)
        await viewModel.load()

        XCTAssertEqual(viewModel.inventory.count, 1)
        XCTAssertEqual(viewModel.monthPerformance.totalSold, 2400)
        XCTAssertEqual(viewModel.monthPerformance.totalProfit, 420)
        XCTAssertEqual(viewModel.monthPerformance.margin, 0.175)
        XCTAssertEqual(viewModel.yearPerformance.totalSold, 12800)
        XCTAssertEqual(viewModel.yearPerformance.totalProfit, 2600)
        XCTAssertEqual(viewModel.yearPerformance.margin, 0.203125)
        XCTAssertNil(viewModel.errorMessage)
    }

    func testLoadKeepsSummaryWhenInventoryFails() async throws {
        let service = makeService { request in
            switch request.url?.path {
            case "/api/portfolio/inventory":
                return (self.httpResponse(for: request, statusCode: 500), #"{"message":"fail"}"#.data(using: .utf8)!)
            case "/api/portfolio/summary":
                let body = #"""
                {
                  "month": { "totalSold": 100, "totalProfit": 10, "margin": 0.1 },
                  "year": { "totalSold": 1000, "totalProfit": 100, "margin": 0.1 }
                }
                """#.data(using: .utf8)!
                return (self.httpResponse(for: request, statusCode: 200), body)
            default:
                XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
                return (self.httpResponse(for: request, statusCode: 404), Data())
            }
        }

        let viewModel = PortfolioWorkspaceViewModel(apiService: service)
        await viewModel.load()

        XCTAssertTrue(viewModel.inventory.isEmpty)
        XCTAssertEqual(viewModel.monthPerformance.totalSold, 100)
        XCTAssertEqual(viewModel.yearPerformance.totalProfit, 100)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.errorMessage?.contains("Inventory is unavailable right now.") == true)
    }

    func testDashboardSnapshotUsesPortfolioSummaryValues() async throws {
        let dashboardBody = #"""
        {
          "userId": "demo-user",
          "date": "2024-05-01",
          "portfolio": {
            "totalCost": 100,
            "totalCurrentValue": 150,
            "totalProfitLoss": 50,
            "roi": 50,
            "activeCount": 1,
            "monthProfit": 12,
            "yearProfit": 34
          },
          "metrics": null,
          "highlights": {
            "portfolioHighlights": [
              {
                "playerName": "Dashboard Player",
                "team": "BOS",
                "statLine": "Dashboard highlight",
                "cardImpact": "+$10",
                "action": "Watch",
                "actionRationale": "Dashboard payload",
                "inventoryImpact": "Stable"
              }
            ],
            "hotPlayers": [
              "Dashboard Player"
            ]
          },
          "watchFeed": [
            {
              "playerName": "Dashboard Watch",
              "team": "BOS",
              "statLine": "Dashboard watch",
              "trend": "up"
            }
          ],
          "notifications": {
            "unreadCount": 1,
            "recent": [
              {
                "id": "dash-1",
                "type": "portfolio",
                "status": "watch",
                "createdAt": "2024-05-01T12:00:00Z",
                "data": {
                  "playerName": "Dashboard Player",
                  "cardName": "Dashboard Card",
                  "message": "Dashboard notification",
                  "action": "Watch"
                }
              }
            ]
          }
        }
        """#.data(using: .utf8)!

        let portfolioBody = #"""
        {
          "inventory": {
            "totalCost": 240,
            "totalCurrentValue": 360,
            "totalProfitLoss": 120,
            "roi": 50,
            "activeCount": 3
          },
          "accountSnapshot": {
            "userId": "demo-user",
            "totalCards": 3,
            "totalValue": 360,
            "totalCost": 240,
            "totalProfitLoss": 120,
            "roi": 50,
            "generatedAt": "2024-05-01T12:00:00Z"
          },
          "inventoryDetails": [],
          "bestCardsToSellNow": [],
          "month": {
            "totalSold": 1000,
            "totalProfit": 160,
            "totalExpenses": 40,
            "netProfit": 120,
            "margin": 12
          },
          "year": {
            "totalSold": 5000,
            "totalProfit": 700,
            "totalExpenses": 100,
            "netProfit": 600,
            "margin": 12
          }
        }
        """#.data(using: .utf8)!

        let dashboardService = makeDashboardService { request in
            switch request.url?.path {
            case "/api/dashboard":
                let queryItems = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                XCTAssertEqual(queryItems?.first(where: { $0.name == "userId" })?.value, "demo-user")
                return (self.httpResponse(for: request, statusCode: 200), dashboardBody)
            case "/api/portfolio/summary":
                let queryItems = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                XCTAssertEqual(queryItems?.first(where: { $0.name == "userId" })?.value, "demo-user")
                return (self.httpResponse(for: request, statusCode: 200), portfolioBody)
            default:
                XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
                return (self.httpResponse(for: request, statusCode: 404), Data())
            }
        }

        await dashboardService.load(userId: "demo-user")

        XCTAssertEqual(dashboardService.snapshot?.portfolio.totalCost, 240)
        XCTAssertEqual(dashboardService.snapshot?.portfolio.totalCurrentValue, 360)
        XCTAssertEqual(dashboardService.snapshot?.portfolio.totalProfitLoss, 120)
        XCTAssertEqual(dashboardService.snapshot?.portfolio.roi, 50)
        XCTAssertEqual(dashboardService.snapshot?.portfolio.activeCount, 3)
        XCTAssertEqual(dashboardService.snapshot?.portfolio.monthProfit, 120)
        XCTAssertEqual(dashboardService.snapshot?.portfolio.yearProfit, 600)
        XCTAssertEqual(dashboardService.snapshot?.highlights.hotPlayers, ["Dashboard Player"])
        XCTAssertNil(dashboardService.snapshot?.metrics)
        XCTAssertNil(dashboardService.errorMessage)
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

    private func makeDashboardService(
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> DashboardService {
        URLProtocolMock.requestHandler = handler

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolMock.self]
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 2

        let session = URLSession(configuration: configuration)
        let portfolioService = APIService(session: session)
        return DashboardService(session: session, portfolioService: portfolioService)
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
