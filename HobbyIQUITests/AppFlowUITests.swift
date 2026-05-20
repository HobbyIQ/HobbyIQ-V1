import XCTest

final class AppFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testHomeShowsLiveHealthStatus() {
        let app = launchApp()

        let status = app.staticTexts["home.backendStatus"]
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        XCTAssertEqual(status.label, "HobbyIQ running")
    }

    func testPortfolioSummaryShowsLiveAzureData() {
        let app = launchApp()

        let portfolioTab = app.tabBars.buttons["PortfolioIQ"]
        XCTAssertTrue(portfolioTab.waitForExistence(timeout: 10))
        portfolioTab.tap()

        let monthCard = app.otherElements["portfolio.summary.month"]
        let yearCard = app.otherElements["portfolio.summary.year"]

        XCTAssertTrue(monthCard.waitForExistence(timeout: 10))
        XCTAssertTrue(yearCard.waitForExistence(timeout: 10))

        XCTAssertTrue(app.staticTexts["portfolio.summary.month.sold"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["portfolio.summary.year.sold"].waitForExistence(timeout: 10))
    }

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "-hasSeenOnboarding", "YES"
        ]
        app.launch()
        return app
    }
}
