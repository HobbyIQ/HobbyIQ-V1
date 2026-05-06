import Foundation
import XCTest
@testable import HobbyIQ

final class APIServiceTests: XCTestCase {
    override func tearDown() {
        URLProtocolMock.requestHandler = nil
        super.tearDown()
    }

    func testFetchHealthReturnsLiveStatus() async throws {
        let service = makeService { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/health")

            let body = #"{"status":"HobbyIQ running","ignored":"extra"}"#.data(using: .utf8)!
            let response = httpResponse(for: request, statusCode: 200)
            return (response, body)
        }

        let health = try await service.fetchHealth()

        XCTAssertEqual(health.status, "HobbyIQ running")
    }

    func testFetchPortfolioSummaryDecodesMonthAndYear() async throws {
        let service = makeService { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/portfolio/summary")

            let body = #"""
            {
              "month": {
                "totalSold": 1250.5,
                "totalProfit": 275.25,
                "margin": 0.22,
                "unknownField": "ignored"
              },
              "year": {
                "totalSold": 9325.0,
                "totalProfit": 1825.75,
                "margin": 0.196,
                "anotherUnknownField": 123
              }
            }
            """#.data(using: .utf8)!
            let response = httpResponse(for: request, statusCode: 200)
            return (response, body)
        }

        let summary = try await service.fetchPortfolioSummary()

        XCTAssertEqual(summary.month?.totalSold, 1250.5)
        XCTAssertEqual(summary.month?.totalProfit, 275.25)
        XCTAssertEqual(summary.month?.margin, 0.22)
        XCTAssertEqual(summary.year?.totalSold, 9325.0)
        XCTAssertEqual(summary.year?.totalProfit, 1825.75)
        XCTAssertEqual(summary.year?.margin, 0.196)
    }

    func testBulkEstimatePostsExpectedBodyAndMapsResults() async throws {
        var capturedRequest: URLRequest?
        let service = makeService { request in
            capturedRequest = request

            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/compiq/bulk-estimate")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

            let body = #"""
            {
              "results": [
                {
                  "estimatedValue": 100.0,
                  "confidence": 0.5,
                  "ignored": "extra"
                }
              ]
            }
            """#.data(using: .utf8)!
            let response = httpResponse(for: request, statusCode: 200)
            return (response, body)
        }

        let estimates = try await service.bulkEstimate(
            cards: [
                CardInput(playerName: "Test Player", cardName: "Test Card", cost: 100)
            ]
        )

        XCTAssertEqual(estimates.count, 1)
        XCTAssertEqual(estimates.first?.playerName, "Test Player")
        XCTAssertEqual(estimates.first?.cardName, "Test Card")
        XCTAssertEqual(estimates.first?.estimatedValue, 100.0)
        XCTAssertEqual(estimates.first?.confidence, 0.5)

        guard
            let bodyData = capturedRequest?.httpBody,
            let json = try JSONSerialization.jsonObject(with: bodyData) as? [String: Any],
            let cards = json["cards"] as? [[String: Any]],
            let card = cards.first
        else {
            XCTFail("Request body was not encoded as expected.")
            return
        }

        XCTAssertEqual(card["playerName"] as? String, "Test Player")
        XCTAssertEqual(card["cardName"] as? String, "Test Card")
        XCTAssertEqual(card["cost"] as? Double, 100)
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
