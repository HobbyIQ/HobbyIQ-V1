//
//  CompIQDecodeTests.swift
//  HobbyIQTests
//

import Foundation
import XCTest
@testable import HobbyIQ

final class CompIQDecodeTests: XCTestCase {

    // MARK: - Phase 3 fields present and populated

    func testPhase3FieldsDecodeWhenPresent() throws {
        let json = """
        {
            "cardTitle": "2024 Bowman Chrome Roman Anthony Base Raw",
            "verdict": "Fair Value",
            "recommendation": "Hold",
            "action": "Hold",
            "fairMarketValue": 42.50,
            "marketValue": 42.50,
            "predictedPrice": 45.00,
            "predictedPriceRange": { "low": 38.0, "high": 52.0 },
            "quickSaleValue": 35.00,
            "premiumValue": 55.00,
            "explanation": ["Stable market", "Good liquidity"],
            "source": "compiq-v3",
            "estimate": 42.50,
            "compsUsed": 12,
            "gradeUsed": "Raw",
            "dealScore": 0.72,
            "effectiveFmv": 42.50,
            "holdZone": [38.0, 47.0],
            "sellZone": [52.0, 60.0],
            "dataSufficiency": {
                "sufficient": true,
                "level": "good",
                "message": "12 comps available"
            }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CardEstimateResponse.self, from: json)

        // Phase 3 fields
        XCTAssertEqual(decoded.effectiveFmv, 42.50)
        XCTAssertEqual(decoded.holdZone?.compactMap({ $0 }), [38.0, 47.0])
        XCTAssertEqual(decoded.sellZone?.compactMap({ $0 }), [52.0, 60.0])

        // dataSufficiency structured decode
        XCTAssertEqual(decoded.dataSufficiencyObj?.sufficient, true)
        XCTAssertEqual(decoded.dataSufficiencyObj?.level, "good")
        XCTAssertEqual(decoded.dataSufficiencyObj?.message, "12 comps available")
        XCTAssertEqual(decoded.dataSufficiencyLabel, "12 comps available")

        // predictedPrice / range
        XCTAssertEqual(decoded.predictedPrice, 45.00)
        XCTAssertEqual(decoded.predictedPriceRange?.low, 38.0)
        XCTAssertEqual(decoded.predictedPriceRange?.high, 52.0)

        // Core fields still work
        XCTAssertEqual(decoded.cardTitle, "2024 Bowman Chrome Roman Anthony Base Raw")
        XCTAssertEqual(decoded.fairMarketValue, 42.50)
        XCTAssertEqual(decoded.estimate, 42.50)
        XCTAssertEqual(decoded.compsUsed, 12)
    }

    // MARK: - Phase 3 fields absent (pre-Phase-3 backend)

    func testPhase3FieldsDecodeAsNilWhenAbsent() throws {
        let json = """
        {
            "cardTitle": "Legacy Card",
            "fairMarketValue": 20.0,
            "estimate": 20.0,
            "compsUsed": 5
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CardEstimateResponse.self, from: json)

        XCTAssertNil(decoded.effectiveFmv)
        XCTAssertNil(decoded.holdZone)
        XCTAssertNil(decoded.sellZone)
        XCTAssertNil(decoded.predictedPrice)
        XCTAssertNil(decoded.predictedPriceRange)
        XCTAssertNil(decoded.dataSufficiencyObj)
        XCTAssertNil(decoded.dataSufficiencyLabel)

        XCTAssertEqual(decoded.cardTitle, "Legacy Card")
        XCTAssertEqual(decoded.fairMarketValue, 20.0)
    }

    // MARK: - Phase 3 fields present as null

    func testPhase3FieldsDecodeAsNilWhenNull() throws {
        let json = """
        {
            "cardTitle": "",
            "effectiveFmv": null,
            "holdZone": null,
            "sellZone": null,
            "predictedPrice": null,
            "predictedPriceRange": null,
            "dataSufficiency": {
                "sufficient": false,
                "level": "none",
                "message": "no comps on file"
            },
            "compsUsed": 0
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CardEstimateResponse.self, from: json)

        XCTAssertNil(decoded.effectiveFmv)
        XCTAssertNil(decoded.holdZone)
        XCTAssertNil(decoded.sellZone)
        XCTAssertNil(decoded.predictedPrice)

        // dataSufficiency still decodes as structured object even with level=none
        XCTAssertEqual(decoded.dataSufficiencyObj?.sufficient, false)
        XCTAssertEqual(decoded.dataSufficiencyObj?.level, "none")
        XCTAssertEqual(decoded.dataSufficiencyLabel, "no comps on file")
        XCTAssertEqual(decoded.compsUsed, 0)
    }

    // MARK: - holdZone / sellZone with interior nulls

    func testZoneArraysWithInteriorNullsDecode() throws {
        let json = """
        {
            "holdZone": [30.0, null],
            "sellZone": [null, 65.0]
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CardEstimateResponse.self, from: json)

        XCTAssertEqual(decoded.holdZone?.count, 2)
        XCTAssertEqual(decoded.holdZone?[0], 30.0)
        XCTAssertNil(decoded.holdZone?[1])

        XCTAssertEqual(decoded.sellZone?.count, 2)
        XCTAssertNil(decoded.sellZone?[0])
        XCTAssertEqual(decoded.sellZone?[1], 65.0)
    }

    // MARK: - Unknown keys are silently ignored

    func testUnknownKeysIgnored() throws {
        let json = """
        {
            "cardTitle": "Test",
            "brandNewField": "should not crash",
            "anotherFutureField": 999
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CardEstimateResponse.self, from: json)
        XCTAssertEqual(decoded.cardTitle, "Test")
    }

    // MARK: - Realistic backend payload (matches live shape)

    func testRealisticBackendPayload() throws {
        let json = """
        {
            "cardTitle": "2024 Bowman Chrome Roman Anthony Base Raw",
            "verdict": "Fair Value",
            "recommendation": "Hold",
            "action": "Hold",
            "fairMarketValue": 42.50,
            "marketValue": 42.50,
            "effectiveFmv": null,
            "predictedPrice": null,
            "predictedPriceRange": null,
            "quickSaleValue": 35.00,
            "premiumValue": 55.00,
            "explanation": "Stable market conditions",
            "source": "compiq-v3",
            "estimate": 42.50,
            "compsUsed": 0,
            "gradeUsed": "Raw",
            "dataSufficiency": {
                "sufficient": false,
                "level": "none",
                "message": "no comps on file"
            },
            "engineVersion": "3.1",
            "computedAt": "2026-05-20T12:00:00Z"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CardEstimateResponse.self, from: json)

        XCTAssertEqual(decoded.cardTitle, "2024 Bowman Chrome Roman Anthony Base Raw")
        XCTAssertEqual(decoded.fairMarketValue, 42.50)
        XCTAssertNil(decoded.effectiveFmv)
        XCTAssertNil(decoded.holdZone)
        XCTAssertNil(decoded.sellZone)
        XCTAssertEqual(decoded.dataSufficiencyObj?.sufficient, false)
        XCTAssertEqual(decoded.dataSufficiencyLabel, "no comps on file")

        // explanation decoded as single-string-wrapped-in-array
        XCTAssertEqual(decoded.explanation, ["Stable market conditions"])
    }
}
