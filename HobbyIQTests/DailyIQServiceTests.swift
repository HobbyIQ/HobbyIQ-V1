import XCTest
@testable import HobbyIQ

@MainActor
final class DailyIQServiceTests: XCTestCase {
    func testRemoveWatchlistPlayerLocallyRemovesMatchingPlayer() {
        let service = DailyIQService.shared
        let playerId = "unit-test-player-1"

        service.ensureWatchlistPlayer(
            playerId: playerId,
            playerName: "Unit Test Player",
            team: "TEST",
            league: "MLB"
        )

        XCTAssertTrue(service.isWatchlisted(WatchPlayerResult(
            playerId: playerId,
            playerName: "Unit Test Player",
            lastGameDate: nil,
            statLine: nil,
            played: false,
            noGameMessage: nil,
            trend: nil,
            buySignal: nil,
            performanceNote: nil,
            team: "TEST",
            position: nil,
            level: "MLB"
        )))

        let removed = service.removeWatchlistPlayerLocally(playerId: playerId)

        XCTAssertEqual(removed.count, 1)
        XCTAssertFalse(service.isWatchlisted(WatchPlayerResult(
            playerId: playerId,
            playerName: "Unit Test Player",
            lastGameDate: nil,
            statLine: nil,
            played: false,
            noGameMessage: nil,
            trend: nil,
            buySignal: nil,
            performanceNote: nil,
            team: "TEST",
            position: nil,
            level: "MLB"
        )))
    }
}
