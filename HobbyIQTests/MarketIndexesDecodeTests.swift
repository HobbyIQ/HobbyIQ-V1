//
//  MarketIndexesDecodeTests.swift
//  HobbyIQTests
//
//  CF-MARKET-INDEXES iOS parity (#1644, Drew 2026-09-02).
//
//  Fixtures are transcribed from the endpoint contract documented at
//  backend/src/routes/marketIndexes.routes.ts and the shapes in
//  marketIndexRead.service.ts (`SportIndexSeries`, `MarketIndexesResponse`).
//
//  What these pin, and why each one matters:
//
//   - the full payload decodes, and `latestLevel` / `changePct` come off
//     the WIRE. The index's whole claim is that mix-shift cannot move it;
//     a client that recomputed a % from `series` would be a second
//     implementation of that number and a second chance for the two
//     surfaces to disagree. So the test asserts the served values are
//     what the model exposes — there is no derivation to test because
//     there must not be one.
//   - EMPTY SERIES ARE KEPT, not dropped. The backend returns a sport
//     with no points rather than omitting it precisely so the tile order
//     is stable; a client that filtered them would undo that.
//   - an older server omitting the optional halves still decodes.
//   - FRESHNESS (H-12, 2026-09-03): freshMembers / usedWeight / stale
//     decode, and `freshnessNote` says "n of N fresh" only when the
//     newest point came off less than the full basket. A level from 1
//     member must not render identically to one from 94.
//

import Foundation
import XCTest
@testable import HobbyIQ

final class MarketIndexesDecodeTests: XCTestCase {

    private func decode(_ json: String) throws -> MarketIndexesResponse {
        try JSONDecoder().decode(MarketIndexesResponse.self, from: Data(json.utf8))
    }

    // MARK: - Full payload

    private let fullPayload = """
    {
      "success": true,
      "computedAt": "2026-09-02T18:04:11.221Z",
      "windowDays": 180,
      "indexes": [
        {
          "sport": "baseball",
          "series": [
            { "date": "2026-03-07", "level": 100.0 },
            { "date": "2026-06-07", "level": 93.4 },
            { "date": "2026-09-02", "level": 106.8 }
          ],
          "latestLevel": 106.8,
          "changePct": 6.8,
          "windowDays": 180,
          "basketSize": 100,
          "asOf": "2026-09-02"
        },
        {
          "sport": "basketball",
          "series": [],
          "latestLevel": null,
          "changePct": null,
          "windowDays": 180,
          "basketSize": null,
          "asOf": null
        }
      ]
    }
    """

    func testFullPayloadDecodes() throws {
        let r = try decode(fullPayload)
        XCTAssertEqual(r.success, true)
        XCTAssertEqual(r.windowDays, 180)
        XCTAssertEqual(r.indexes.count, 2)

        let baseball = r.indexes[0]
        XCTAssertEqual(baseball.sport, "baseball")
        XCTAssertEqual(baseball.series.count, 3)
        XCTAssertEqual(baseball.series.first?.date, "2026-03-07")
        XCTAssertEqual(baseball.basketSize, 100)
        XCTAssertEqual(baseball.asOf, "2026-09-02")
    }

    /// The served numbers are the displayed numbers. No client computation.
    func testLatestLevelAndChangePctComeOffTheWire() throws {
        let baseball = try decode(fullPayload).indexes[0]
        XCTAssertEqual(baseball.latestLevel, 106.8)
        XCTAssertEqual(baseball.changePct, 6.8)
        // Deliberately NOT asserted against a locally-derived
        // (last-first)/first: the client must not own that formula. This
        // instead pins that the wire's value survives decode unchanged.
        XCTAssertEqual(baseball.levels, [100.0, 93.4, 106.8], "sparkline shape, oldest first")
    }

    /// A sport with no points is returned rather than omitted so the tile
    /// order stays stable. The model must keep it.
    func testEmptySeriesSportIsKeptSoTileOrderIsStable() throws {
        let r = try decode(fullPayload)
        XCTAssertEqual(r.indexes.map(\.sport), ["baseball", "basketball"], "server order is the tile order")
        let basketball = r.indexes[1]
        XCTAssertTrue(basketball.series.isEmpty)
        XCTAssertNil(basketball.latestLevel)
        XCTAssertNil(basketball.changePct)
        XCTAssertFalse(basketball.hasRenderableSeries, "renders \"Building\", not a flat line")
    }

    /// One point has no shape and no honest change — it must not draw a
    /// flat line that reads as "no movement".
    func testSinglePointSeriesIsNotRenderable() throws {
        let r = try decode("""
        { "indexes": [ { "sport": "hockey", "series": [ { "date": "2026-09-02", "level": 100.0 } ],
          "latestLevel": 100.0, "changePct": null } ] }
        """)
        XCTAssertEqual(r.indexes[0].series.count, 1)
        XCTAssertFalse(r.indexes[0].hasRenderableSeries)
    }

    // MARK: - Tolerance for older servers

    func testOlderServerOmittingOptionalFieldsStillDecodes() throws {
        let r = try decode("""
        { "indexes": [ { "sport": "football" } ] }
        """)
        XCTAssertEqual(r.indexes.count, 1)
        let football = r.indexes[0]
        XCTAssertEqual(football.sport, "football")
        XCTAssertTrue(football.series.isEmpty)
        XCTAssertNil(football.latestLevel)
        XCTAssertNil(football.changePct)
        XCTAssertNil(football.basketSize)
        XCTAssertNil(football.windowDays)
        XCTAssertNil(r.success)
    }

    func testMissingIndexesArrayDecodesToEmptyRatherThanThrowing() throws {
        let r = try decode("""
        { "success": true, "computedAt": "2026-09-02T18:04:11Z", "windowDays": 180 }
        """)
        XCTAssertTrue(r.indexes.isEmpty, "the strip self-suppresses rather than erroring the host screen")
    }

    // MARK: - Display names

    func testDisplayNamesCoverTheKnownSportsAndTitleCaseTheRest() throws {
        let r = try decode("""
        { "indexes": [
          { "sport": "baseball" }, { "sport": "basketball" }, { "sport": "football" },
          { "sport": "hockey" }, { "sport": "soccer" }, { "sport": "pokemon" },
          { "sport": "cricket" }
        ] }
        """)
        XCTAssertEqual(
            r.indexes.map(\.displayName),
            ["Baseball", "Basketball", "Football", "Hockey", "Soccer", "Pokémon", "Cricket"],
            "an unrecognised sport is title-cased, never dropped — a new backend sport must still appear"
        )
    }

    // MARK: - Freshness (H-12)

    func testFreshnessNoteNamesThinBasket() throws {
        let json = """
        {
          "indexes": [
            {
              "sport": "hockey",
              "series": [
                { "date": "2026-09-02", "level": 100.0, "freshMembers": 40, "usedWeight": 0.93 },
                { "date": "2026-09-03", "level": 101.2, "freshMembers": 1, "usedWeight": 0.0006 }
              ],
              "latestLevel": 101.2,
              "changePct": 1.2,
              "windowDays": 180,
              "basketSize": 43,
              "asOf": "2026-09-03",
              "freshMembers": 1,
              "usedWeight": 0.0006
            }
          ]
        }
        """
        let res = try decode(json)
        let hockey = try XCTUnwrap(res.indexes.first)
        XCTAssertEqual(hockey.freshMembers, 1)
        XCTAssertEqual(hockey.usedWeight ?? 0, 0.0006, accuracy: 1e-9)
        // The tile must SAY the level came off one card of forty-three.
        XCTAssertEqual(hockey.freshnessNote, "1 of 43 fresh")
        XCTAssertEqual(hockey.series.last?.freshMembers, 1)
    }

    func testFullBasketShowsNoFreshnessQualifier() throws {
        let json = """
        {
          "indexes": [
            {
              "sport": "baseball",
              "series": [
                { "date": "2026-09-02", "level": 109.1 },
                { "date": "2026-09-03", "level": 109.59 }
              ],
              "latestLevel": 109.59,
              "changePct": 0.4,
              "windowDays": 180,
              "basketSize": 100,
              "asOf": "2026-09-03",
              "freshMembers": 100,
              "usedWeight": 1.0
            }
          ]
        }
        """
        let baseball = try XCTUnwrap(try decode(json).indexes.first)
        XCTAssertNil(baseball.freshnessNote)
    }

    func testCarriedLevelSaysItIsCarried() throws {
        let json = """
        {
          "indexes": [
            {
              "sport": "hockey",
              "series": [{ "date": "2026-09-03", "level": 98.4, "stale": true }],
              "latestLevel": 98.4,
              "windowDays": 180,
              "basketSize": 43,
              "asOf": "2026-09-03",
              "freshMembers": 1,
              "usedWeight": 0.02,
              "stale": true,
              "withheldReason": "used_weight_below_floor"
            }
          ]
        }
        """
        let hockey = try XCTUnwrap(try decode(json).indexes.first)
        XCTAssertEqual(hockey.stale, true)
        XCTAssertEqual(hockey.withheldReason, "used_weight_below_floor")
        XCTAssertEqual(hockey.freshnessNote, "Carried \u{00B7} basket too thin to price")
    }

    func testOlderServerWithoutFreshnessFieldsStillDecodes() throws {
        let json = """
        {
          "indexes": [
            {
              "sport": "football",
              "series": [{ "date": "2026-09-03", "level": 102.64 }],
              "latestLevel": 102.64,
              "windowDays": 180,
              "basketSize": 100,
              "asOf": "2026-09-03"
            }
          ]
        }
        """
        let football = try XCTUnwrap(try decode(json).indexes.first)
        XCTAssertNil(football.freshMembers)
        XCTAssertNil(football.usedWeight)
        XCTAssertNil(football.freshnessNote)
        XCTAssertEqual(football.latestLevel, 102.64)
    }

}
