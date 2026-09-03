//
//  FmvRung.swift
//  HobbyIQ
//
//  CF-IOS-RUNG-PARITY (Drew, 2026-09-02). iOS says what the engine says.
//
//  Mirror of the CLOSED rung vocabulary in
//  backend/src/services/compiq/fmvRung.ts, and of the web's rendering of
//  it in apps/web/src/lib/rung.ts. Every price the backend serves carries
//  the name of the RUNG that produced it — which pool the number came
//  from, and how it was read. D16/D17 put that name on every route
//  (`rungLabel`, price-by-id's `source`, each grade-curve entry's
//  `rungLabel`) and on the persisted holding (`fmvRung`,
//  `pricingSourceMeta.method`).
//
//  Until this file, iOS typed NONE of it: `grep -i rung` over the app
//  found only `ParallelLadderRung` (an unrelated corpus-signals shape) and
//  three comments. So a sibling-estimate number rendered exactly like an
//  observed one on every iOS surface.
//
//  THE #1621 LESSON — emitter/client vocabulary parity. The rung set is
//  closed and it GROWS: `graded-pool-inverse` (#1631-era) and
//  `player-index-projection` (#1647) were both added after the first web
//  mapping shipped, and web's own rung.test.ts caught `graded-pool-inverse`
//  only as a chronic red. So the mapping here is written to make a NEW
//  RUNG A COMPILE ERROR, not a silent fallthrough:
//
//    - `FmvRung` is a String enum over the closed vocabulary.
//    - `describe()` switches over it EXHAUSTIVELY, with no `default:`.
//      Adding a case to the enum without adding it to the switch does not
//      compile. `FmvRungParityTests` asserts allCases is described.
//    - a wire label OUTSIDE the vocabulary is not silently upgraded: it
//      decodes to nil and renders `unknown rung "<label>"`, the same rule
//      web follows and the same rule fmvRung.ts's isExactPoolRung follows.
//      A consumer with no label does not get to assume the best case.
//
//  Adding a rung means adding it in fmvRung.ts first, then here.
//

import Foundation

// MARK: - The closed vocabulary

/// Rungs that read the exact (identity, grade) pool. These are the only
/// rungs the divergence digest admits, and the only ones that may be
/// described as OBSERVED.
///
/// Mirrors the engine's SEPARATE `ExactPoolRungLabel` type (fmvRung.ts),
/// which exists there for the same reason: the exact-pool subset is a
/// contract in its own right, not merely "the ones whose names happen to
/// start with a prefix".
///
/// No production call site reads this type — `FmvRung.isExactPool` and the
/// free `isExactPoolRung(_:)` do that work, because they must also answer
/// for labels outside the vocabulary. Its job is to be the SECOND,
/// independently-written statement of which six rungs are exact-pool, so
/// `FmvRungParityTests.testExactPoolRungCountIsSix` can cross-check the
/// prefix rule against an explicit list. If the two ever disagree, one of
/// them is wrong and the test says so.
enum ExactPoolRung: String, CaseIterable, Hashable {
    case projection = "exact-pool-projection"
    case lastSale = "exact-pool-last-sale"
    case leadingEdge = "exact-pool-leading-edge"
    case weightedMedian = "exact-pool-weighted-median"
    case median = "exact-pool-median"
    case trajectory = "exact-pool-trajectory"
}

/// Every rung any engine can name: the exact-pool rungs, every fallback
/// rung, and `no-basis` (the engine declining to price).
///
/// Order mirrors `apps/web/src/lib/rung.ts` so a diff of the two lists is
/// readable. `CaseIterable` is what lets the parity test prove that every
/// member of the vocabulary is described.
enum FmvRung: String, CaseIterable, Hashable {
    // ── exact pool (6) ───────────────────────────────────────────────
    case exactPoolProjection = "exact-pool-projection"
    case exactPoolLastSale = "exact-pool-last-sale"
    case exactPoolLeadingEdge = "exact-pool-leading-edge"
    case exactPoolWeightedMedian = "exact-pool-weighted-median"
    case exactPoolMedian = "exact-pool-median"
    case exactPoolTrajectory = "exact-pool-trajectory"

    // ── unified / grade-curve fallbacks (5) ──────────────────────────
    case crossGradeFallback = "cross-grade-fallback"
    case gradeCurveEstimate = "grade-curve-estimate"
    case gradedPoolInverse = "graded-pool-inverse"
    /// CF-PLAYER-TREND-SPECULATION (#1647, Drew 2026-09-02): this card's
    /// own pool went cold AND its own trend was unmeasurable, so its last
    /// REAL sale was carried forward on the PLAYER's market index. A
    /// FALLBACK rung, not an exact-pool one — the anchor is a real sale of
    /// this exact card, but the number served is that anchor moved by
    /// OTHER cards' sales.
    case playerIndexProjection = "player-index-projection"
    case siblingEstimate = "sibling-estimate"

    // ── canonical-fmv ladder (direct-comp IS the exact pool) (7) ──────
    case crossParallel = "cross-parallel"
    case neighborParallel = "neighbor-parallel"
    case siblingParallel = "sibling-parallel"
    case hotRawSameCardAnchor = "hot-raw-same-card-anchor"
    case familyBaseline = "family-baseline"
    case productTier = "product-tier"
    case tieredMomentumCard = "tiered-momentum-card"
    case tieredMomentumPlayer = "tiered-momentum-player"

    // ── hobbyIqFmv ladder (direct-slug IS the exact pool) (7) ─────────
    case crossSetKey = "cross-setkey"
    case crossPrintRun = "cross-printrun"
    case samePrintRunCrossParallel = "same-printrun-cross-parallel"
    case printRunDiscovery = "printrun-discovery"
    case gradeCrossRaw = "grade-cross-raw"
    case compositeNeighbor = "composite-neighbor"
    case rareCardAnchor = "rare-card-anchor"

    // ── declined ─────────────────────────────────────────────────────
    case noBasis = "no-basis"

    /// True iff this rung read the exact (identity, grade) pool.
    ///
    /// Derived from the label prefix, exactly as `fmvRung.ts`'s
    /// `isExactPoolRung` does — so a future `exact-pool-*` rung is
    /// classified correctly even before anyone writes its words.
    var isExactPool: Bool { rawValue.hasPrefix("exact-pool-") }
}

// MARK: - Rendering

enum RungKind: String, Hashable {
    /// Read from the exact (identity, grade) pool.
    case observed
    /// A neighbouring parallel, a family baseline, another grade, a model.
    case estimate
    /// The engine declined to price.
    case unpriced
    /// A label we do not know, or no label at all. NEVER upgraded.
    case unknown
}

struct RungDescription: Hashable {
    let kind: RungKind
    /// The rung in human words.
    let text: String
    /// The label exactly as the wire carried it (nil when it carried none).
    let label: String?

    /// A short head word for the surfaces that show a mark rather than a
    /// sentence. An estimate's words already begin with "estimate", so it
    /// gets no head — the same rule ProvenanceChip.tsx follows.
    var headWord: String? {
        switch kind {
        case .observed: return "observed"
        case .estimate: return nil
        case .unpriced: return "unpriced"
        case .unknown: return "unknown"
        }
    }
}

/// `compsUsed` is the size of the pool the rung read (the tier's pool, not
/// the whole curve's). It only decorates the exact-pool phrases — a
/// fallback rung's pool belongs to another card.
private func salesPhrase(_ n: Int?) -> String {
    guard let n, n > 0 else { return "sales" }
    return "\(n) sale\(n == 1 ? "" : "s")"
}

extension FmvRung {
    /// The words for this rung.
    ///
    /// EXHAUSTIVE by construction — there is deliberately no `default:`
    /// case. A rung added to `FmvRung` without a branch here is a compile
    /// error, which is the whole point of this file (#1621: the emitter
    /// and the client must not drift silently).
    ///
    /// Wording is kept byte-identical to `apps/web/src/lib/rung.ts`'s
    /// `describeRung`, whose phrasing rung.test.ts pins as doctrine: every
    /// fallback begins with "estimate", every exact-pool rung says "this
    /// card".
    func describe(compsUsed: Int? = nil) -> RungDescription {
        let n = compsUsed
        switch self {
        // ── exact pool: observed ─────────────────────────────────────
        case .exactPoolProjection:
            return .init(kind: .observed, text: "projected from \(salesPhrase(n)) of this card", label: rawValue)
        case .exactPoolLastSale:
            return .init(kind: .observed, text: "from the last sale of this card, trend-adjusted", label: rawValue)
        case .exactPoolLeadingEdge:
            return .init(kind: .observed, text: "from the newest of \(salesPhrase(n)) of this card", label: rawValue)
        case .exactPoolWeightedMedian:
            return .init(kind: .observed, text: "from \(salesPhrase(n)) of this card (thin pool)", label: rawValue)
        case .exactPoolMedian:
            return .init(kind: .observed, text: "from \(salesPhrase(n)) of this card (median)", label: rawValue)
        case .exactPoolTrajectory:
            return .init(kind: .observed, text: "from \(salesPhrase(n)) of this card, carried by player momentum", label: rawValue)

        // ── fallbacks: estimates ─────────────────────────────────────
        case .crossGradeFallback:
            return .init(kind: .estimate, text: "estimate from another grade of this card", label: rawValue)
        case .gradeCurveEstimate:
            return .init(kind: .estimate, text: "estimate from the grade curve", label: rawValue)
        case .gradedPoolInverse:
            return .init(kind: .estimate, text: "estimate from this card's own graded sales", label: rawValue)
        case .playerIndexProjection:
            // #1647. The words say both halves of the claim, because either
            // alone would mislead: "this card's last sale" (a real trade of
            // this exact card) and "the player's market trend" (what moved
            // it). Begins with "estimate" — the doctrine every fallback follows.
            return .init(kind: .estimate, text: "estimate from this card's last sale x the player's market trend", label: rawValue)
        case .siblingEstimate:
            return .init(kind: .estimate, text: "estimate from a sibling card x parallel premium", label: rawValue)
        case .crossParallel, .neighborParallel, .siblingParallel, .samePrintRunCrossParallel:
            return .init(kind: .estimate, text: "estimate from sibling parallels", label: rawValue)
        case .crossSetKey:
            return .init(kind: .estimate, text: "estimate from this card in a sister product", label: rawValue)
        case .crossPrintRun:
            return .init(kind: .estimate, text: "estimate from this card at other print runs", label: rawValue)
        case .printRunDiscovery:
            return .init(kind: .estimate, text: "estimate from this card's dominant print run", label: rawValue)
        case .familyBaseline:
            return .init(kind: .estimate, text: "estimate from the card family", label: rawValue)
        case .hotRawSameCardAnchor:
            return .init(kind: .estimate, text: "estimate from this card's raw sales", label: rawValue)
        case .gradeCrossRaw:
            return .init(kind: .estimate, text: "estimate from raw sales x a grade multiplier", label: rawValue)
        case .compositeNeighbor:
            return .init(kind: .estimate, text: "estimate from composite neighbors", label: rawValue)
        case .rareCardAnchor:
            return .init(kind: .estimate, text: "estimate from this card's last sale, drift-adjusted", label: rawValue)
        case .productTier:
            return .init(kind: .estimate, text: "estimate from the product tier", label: rawValue)
        case .tieredMomentumCard:
            return .init(kind: .estimate, text: "estimate from card momentum", label: rawValue)
        case .tieredMomentumPlayer:
            return .init(kind: .estimate, text: "estimate from player momentum", label: rawValue)

        // ── declined ─────────────────────────────────────────────────
        case .noBasis:
            return .init(kind: .unpriced, text: "no price basis", label: rawValue)
        }
    }
}

/// The words for a rung label off the wire.
///
/// A label we do not know is NEVER hidden — it renders as
/// `unknown rung "<label>"`; a missing label renders as
/// "rung not reported". Neither is upgraded to observed.
func describeRung(_ label: String?, compsUsed: Int? = nil) -> RungDescription {
    guard let raw = label?.trimmingCharacters(in: .whitespacesAndNewlines), raw.isEmpty == false else {
        return .init(kind: .unknown, text: "rung not reported", label: nil)
    }
    guard let rung = FmvRung(rawValue: raw) else {
        return .init(kind: .unknown, text: "unknown rung \"\(raw)\"", label: raw)
    }
    return rung.describe(compsUsed: compsUsed)
}

/// True iff the label names a rung that read the exact (identity, grade)
/// pool. Unknown / missing labels are NOT exact-pool — the same rule as
/// `fmvRung.ts`, and the reason it is a free function over the raw string
/// rather than a method: it must answer for labels the enum does not know.
func isExactPoolRung(_ label: String?) -> Bool {
    guard let label else { return false }
    return label.hasPrefix("exact-pool-")
}

// MARK: - Speculation pricing: a stale comp is not the price
//
// Drew, 2026-09-02: "the last comps from 2 months ago aren't a fair price.
// It is priced based on speculation and today's market."
//
// The rung says WHICH POOL the number came from. It does not say HOW OLD
// that pool is, and those are different facts: `exact-pool-projection` off
// five sales from June reads exactly like one off five sales from last
// week. So the age is a SECOND fact rendered beside the rung, never a
// rewrite of it — `describe()` above is left matching web byte for byte.
//
// #1647 is the other half of this ruling, and it lives in the ENGINE:
// past the same threshold, with the card's own trend unmeasurable, the
// NUMBER itself is re-derived on the player index and the rung comes back
// as `player-index-projection`. So the two surfaces compose: a cold card
// whose own trend was readable keeps its exact-pool rung and gets this
// chip; one whose trend was not gets the new rung, whose words already say
// it, and the chip beside it.

/// Days past which the newest direct comp is too old to BE the price.
///
/// 45 days — inside Drew's ~30-60d band and chosen off the shape of the
/// data rather than the middle of the range: a card that trades monthly
/// has a comp inside 30 days on a normal week, so a 30d line would fire on
/// ordinary cards between sales and the copy would stop meaning anything.
///
/// Mirrors `STALE_COMP_DAYS` in apps/web/src/lib/rung.ts and
/// backend/src/services/compiq/staleComp.ts.
let staleCompDays: Int = 45

struct StalenessNote: Hashable {
    /// Whole weeks since the newest direct comp (>= 1 when stale).
    let weeks: Int
    let daysSinceNewestComp: Int
    /// The chip line: short, sits beside the rung.
    let short: String
    /// The long form for the detail row / accessibility label.
    let long: String
}

/// The speculation line for a value whose newest direct comp has gone
/// cold, or nil when it has not.
///
/// Nil — no line at all — for every case that is not provably stale: a
/// missing or negative age, and an age inside the threshold. A value we
/// cannot date does NOT get told it is old (the same rule the rung
/// vocabulary follows for a missing label: never invent the fact, and
/// never assume the bad case in the copy).
func describeStaleness(daysSinceNewestComp: Int?, thresholdDays: Int = staleCompDays) -> StalenessNote? {
    guard let d = daysSinceNewestComp, d >= 0, d > thresholdDays else { return nil }
    let weeks = max(1, Int((Double(d) / 7.0).rounded()))
    return StalenessNote(
        weeks: weeks,
        daysSinceNewestComp: d,
        short: "last sale \(weeks) weeks ago — priced to today's market",
        long: "Last direct sale was \(weeks) weeks ago — old prints aren't fair value today. "
            + "This price projects today's market from the card's trend."
    )
}
