//
//  FmvRungParityTests.swift
//  HobbyIQTests
//
//  CF-IOS-RUNG-PARITY (Drew, 2026-09-02). The pins for the rung
//  vocabulary and the speculation-staleness line.
//
//  THE #1621 LESSON, MADE MECHANICAL. A rung the engine emits and the
//  client does not know renders as a silent "?" — or worse, reads as an
//  observed number. Two mechanisms stop that here, and this file pins
//  both:
//
//    1. COMPILE-TIME. `FmvRung.describe()` switches over the enum with no
//       `default:`. Adding a case without a branch does not compile.
//       `testEveryRungIsDescribed` is the belt to that braces: it walks
//       `allCases` and asserts each produced real words, so a branch that
//       exists but returns something empty is caught too.
//
//    2. WIRE-TIME. A label OUTSIDE the vocabulary decodes to no case and
//       is rendered `unknown rung "<label>"` — never upgraded to observed.
//       `testUnknownLabelIsNamedNotHidden` pins that.
//
//  The VOCABULARY ITSELF is pinned by `testVocabularyMatchesTheEngine`,
//  which lists all 27 labels literally. That list is transcribed from
//  backend/src/services/compiq/fmvRung.ts (via apps/web/src/lib/rung.ts,
//  which mirrors it). If the engine adds a rung, that test fails with the
//  missing name — which is the point: the failure NAMES the drift instead
//  of the app quietly rendering "?" in production.
//

import Foundation
import XCTest
@testable import HobbyIQ

final class FmvRungParityTests: XCTestCase {

    // MARK: - The closed vocabulary

    /// Every label in the engine's closed vocabulary, transcribed from
    /// `backend/src/services/compiq/fmvRung.ts`:
    ///   - `ExactPoolRungLabel` (6)
    ///   - the four named fallbacks on `FmvRungLabel` (5, incl. #1647's
    ///     `player-index-projection`)
    ///   - `CanonicalFmvMethod` minus `direct-comp` (canonicalFmv.service.ts)
    ///   - `HobbyIqFmvMethod` minus `direct-slug` (hobbyIqFmv.service.ts)
    ///   - `no-basis`
    /// de-duplicated across the two ladders, which overlap.
    private static let engineVocabulary: Set<String> = [
        // exact pool (6)
        "exact-pool-projection",
        "exact-pool-last-sale",
        "exact-pool-leading-edge",
        "exact-pool-weighted-median",
        "exact-pool-median",
        "exact-pool-trajectory",
        // named fallbacks (5)
        "cross-grade-fallback",
        "grade-curve-estimate",
        "graded-pool-inverse",
        "player-index-projection",
        "sibling-estimate",
        // canonical-fmv ladder (8)
        "cross-parallel",
        "neighbor-parallel",
        "sibling-parallel",
        "hot-raw-same-card-anchor",
        "family-baseline",
        "product-tier",
        "tiered-momentum-card",
        "tiered-momentum-player",
        // hobbyIqFmv ladder (7)
        "cross-setkey",
        "cross-printrun",
        "same-printrun-cross-parallel",
        "printrun-discovery",
        "grade-cross-raw",
        "composite-neighbor",
        "rare-card-anchor",
        // declined (1)
        "no-basis",
    ]

    func testVocabularyMatchesTheEngine() {
        let ios = Set(FmvRung.allCases.map(\.rawValue))
        let missingFromIOS = Self.engineVocabulary.subtracting(ios)
        let extraInIOS = ios.subtracting(Self.engineVocabulary)
        XCTAssertTrue(
            missingFromIOS.isEmpty,
            "The engine names rungs iOS does not: \(missingFromIOS.sorted()). "
                + "Add them to FmvRung — until then they render as \"unknown rung\"."
        )
        XCTAssertTrue(
            extraInIOS.isEmpty,
            "iOS names rungs the engine does not: \(extraInIOS.sorted()). "
                + "Either the engine dropped one or this list is stale."
        )
        // 27 = 6 exact-pool + 20 fallbacks + no-basis. Stated so a change
        // in COUNT is visible even if someone edits both sides at once.
        XCTAssertEqual(FmvRung.allCases.count, 27)
    }

    /// #1647 specifically. The rung it added is the reason this whole
    /// file exists, so it gets its own pin rather than only riding the
    /// set comparison above.
    func testPlayerIndexProjectionIsKnownAndIsAnEstimate() {
        let d = describeRung("player-index-projection")
        XCTAssertEqual(d.kind, .estimate, "the anchor is a real sale of this card, but the number is that anchor moved by OTHER cards' sales — a fallback rung, never observed")
        XCTAssertEqual(d.label, "player-index-projection")
        XCTAssertTrue(d.text.hasPrefix("estimate"), "every fallback's words begin with \"estimate\" — the doctrine rung.test.ts pins")
        // Both halves of the claim must be said; either alone misleads.
        XCTAssertTrue(d.text.contains("last sale"), "must name the anchor: a real trade of this exact card")
        XCTAssertTrue(d.text.contains("player's market trend"), "must name what moved it")
        XCTAssertFalse(isExactPoolRung("player-index-projection"))
    }

    // MARK: - Exhaustive description

    func testEveryRungIsDescribed() {
        for rung in FmvRung.allCases {
            let d = rung.describe(compsUsed: 4)
            XCTAssertFalse(
                d.text.trimmingCharacters(in: .whitespaces).isEmpty,
                "\(rung.rawValue) produced no words"
            )
            XCTAssertEqual(d.label, rung.rawValue, "\(rung.rawValue) lost its label")
            XCTAssertNotEqual(
                d.kind, .unknown,
                "\(rung.rawValue) is in the vocabulary but described as unknown"
            )
            XCTAssertFalse(
                d.text.contains("unknown rung"),
                "\(rung.rawValue) fell through to the unknown-label copy"
            )
        }
    }

    /// The two doctrines web's rung.test.ts pins, asserted here so the two
    /// clients cannot drift apart in wording.
    func testWordingDoctrine() {
        for rung in FmvRung.allCases {
            let d = rung.describe(compsUsed: 3)
            switch d.kind {
            case .observed:
                XCTAssertTrue(
                    d.text.contains("this card"),
                    "every exact-pool rung must say \"this card\" — \(rung.rawValue) said \"\(d.text)\""
                )
            case .estimate:
                XCTAssertTrue(
                    d.text.hasPrefix("estimate"),
                    "every fallback must begin with \"estimate\" — \(rung.rawValue) said \"\(d.text)\""
                )
            case .unpriced, .unknown:
                continue
            }
        }
    }

    // MARK: - Kind classification

    func testExactPoolRungsAreObservedAndEverythingElseIsNot() {
        for rung in FmvRung.allCases {
            let d = rung.describe()
            if rung.isExactPool {
                XCTAssertEqual(d.kind, .observed, "\(rung.rawValue) reads the exact pool but is not observed")
                XCTAssertTrue(isExactPoolRung(rung.rawValue))
            } else if rung == .noBasis {
                XCTAssertEqual(d.kind, .unpriced)
            } else {
                XCTAssertEqual(d.kind, .estimate, "\(rung.rawValue) is a fallback but is not an estimate")
                XCTAssertFalse(isExactPoolRung(rung.rawValue), "\(rung.rawValue) must not classify as exact-pool")
            }
        }
    }

    func testExactPoolRungCountIsSix() {
        XCTAssertEqual(FmvRung.allCases.filter(\.isExactPool).count, 6)
        XCTAssertEqual(ExactPoolRung.allCases.count, 6)
        // The two enums must name the same six.
        XCTAssertEqual(
            Set(ExactPoolRung.allCases.map(\.rawValue)),
            Set(FmvRung.allCases.filter(\.isExactPool).map(\.rawValue))
        )
    }

    // MARK: - Unknown and missing labels are never upgraded

    func testUnknownLabelIsNamedNotHidden() {
        let d = describeRung("a-rung-that-does-not-exist-yet")
        XCTAssertEqual(d.kind, .unknown)
        XCTAssertEqual(d.text, "unknown rung \"a-rung-that-does-not-exist-yet\"")
        XCTAssertEqual(d.label, "a-rung-that-does-not-exist-yet", "the raw label the wire sent is never dropped")
    }

    func testMissingLabelSaysSoAndIsNotObserved() {
        for label in [nil, "", "   "] as [String?] {
            let d = describeRung(label)
            XCTAssertEqual(d.kind, .unknown, "a consumer with no label does not get to assume the best case")
            XCTAssertEqual(d.text, "rung not reported")
            XCTAssertNil(d.label)
        }
        XCTAssertFalse(isExactPoolRung(nil))
        XCTAssertFalse(isExactPoolRung(""))
    }

    /// A FUTURE `exact-pool-*` rung classifies as exact-pool by prefix even
    /// before anyone writes its words — the same rule fmvRung.ts follows.
    /// It still renders as unknown (we do not know its words), and that is
    /// the honest answer.
    func testFutureExactPoolLabelClassifiesByPrefixButHasNoWords() {
        XCTAssertTrue(isExactPoolRung("exact-pool-something-new"))
        XCTAssertEqual(describeRung("exact-pool-something-new").kind, .unknown)
    }

    // MARK: - compsUsed decoration

    func testCompsUsedDecoratesExactPoolPhrasesOnly() {
        XCTAssertEqual(
            describeRung("exact-pool-projection", compsUsed: 5).text,
            "projected from 5 sales of this card"
        )
        XCTAssertEqual(
            describeRung("exact-pool-projection", compsUsed: 1).text,
            "projected from 1 sale of this card",
            "singular"
        )
        // Missing / zero / negative collapse to the bare noun rather than
        // printing "0 sales".
        for n in [nil, 0, -3] as [Int?] {
            XCTAssertEqual(
                describeRung("exact-pool-projection", compsUsed: n).text,
                "projected from sales of this card"
            )
        }
        // A fallback rung's pool belongs to another card, so the count
        // never decorates it.
        XCTAssertEqual(
            describeRung("family-baseline", compsUsed: 99).text,
            "estimate from the card family"
        )
    }

    // MARK: - Head words

    func testEstimateGetsNoHeadWordAndTheOthersDo() {
        XCTAssertNil(describeRung("family-baseline").headWord, "an estimate's words already begin with \"estimate\"")
        XCTAssertEqual(describeRung("exact-pool-median").headWord, "observed")
        XCTAssertEqual(describeRung("no-basis").headWord, "unpriced")
        XCTAssertEqual(describeRung(nil).headWord, "unknown")
    }

    // MARK: - Speculation staleness (#1646)

    func testStalenessFiresPast45DaysWithBothHalvesOfTheFraming() {
        let note = describeStaleness(daysSinceNewestComp: 60)
        XCTAssertNotNil(note)
        XCTAssertEqual(note?.weeks, 9, "60 / 7 rounds to 9")
        XCTAssertEqual(note?.daysSinceNewestComp, 60)
        XCTAssertEqual(note?.short, "last sale 9 weeks ago — priced to today's market")
        // Drew's framing, both halves.
        XCTAssertTrue(note!.long.contains("aren't fair value today"))
        XCTAssertTrue(note!.long.contains("projects today's market"))
    }

    func testStalenessIsSilentInsideTheThreshold() {
        for d in [0, 1, 7, 30, 44, 45] {
            XCTAssertNil(
                describeStaleness(daysSinceNewestComp: d),
                "\(d)d is not stale — 45 is the threshold and it fires STRICTLY past it"
            )
        }
        XCTAssertNotNil(describeStaleness(daysSinceNewestComp: 46), "fires strictly past 45")
    }

    func testAValueWeCannotDateIsNeverDressedAsStale() {
        XCTAssertNil(describeStaleness(daysSinceNewestComp: nil), "a missing age is not evidence of an old one")
        XCTAssertNil(describeStaleness(daysSinceNewestComp: -1), "a negative age is nonsense, not staleness")
        XCTAssertNil(describeStaleness(daysSinceNewestComp: Int.min))
    }

    func testNoFiringAgeEverReadsZeroWeeks() {
        // Every day from just past the threshold to two years out.
        for d in (staleCompDays + 1)...730 {
            guard let note = describeStaleness(daysSinceNewestComp: d) else {
                return XCTFail("\(d)d is past the threshold and must fire")
            }
            XCTAssertGreaterThanOrEqual(note.weeks, 1, "\(d)d rendered \(note.weeks) weeks")
            // NOTE the word boundary. A bare `contains("0 weeks")` is the
            // wrong assertion and fails on every correct output ending in
            // a zero — "10 weeks", "20 weeks". The claim is that the
            // rendered NUMBER is never zero.
            XCTAssertFalse(note.short.contains(" 0 weeks "), "\(d)d rendered a literal '0 weeks': \(note.short)")
            XCTAssertTrue(note.short.contains("\(note.weeks) weeks"), "\(d)d copy must carry its week count")
        }
    }

    func testThresholdIs45AndIsInjectable() {
        XCTAssertEqual(staleCompDays, 45, "inside Drew's 30-60 band; see the doctrine note in FmvRung.swift")
        // Injectable so a future per-class threshold does not need a second
        // implementation of the copy.
        XCTAssertNotNil(describeStaleness(daysSinceNewestComp: 31, thresholdDays: 30))
        XCTAssertNil(describeStaleness(daysSinceNewestComp: 31, thresholdDays: 60))
    }

    /// The rung and the age are SEPARATE facts. Adding the age must never
    /// have rewritten the rung's words — this asserts the exact-pool
    /// phrasing is untouched by a stale age being present.
    func testStalenessDoesNotRewriteTheRung() {
        let rung = describeRung("exact-pool-projection", compsUsed: 5)
        XCTAssertEqual(rung.text, "projected from 5 sales of this card")
        XCTAssertEqual(rung.kind, .observed, "a cold pool does not stop the rung being an exact-pool read")
        XCTAssertNotNil(describeStaleness(daysSinceNewestComp: 63), "the age is stated beside it, not instead of it")
    }
}
