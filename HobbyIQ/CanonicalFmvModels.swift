//
//  CanonicalFmvModels.swift
//  HobbyIQ
//
//  Wire model for POST /api/compiq/canonical-fmv — the single deterministic
//  FMV function every consumer should call so Card Detail, Inventory,
//  Portfolio, Sell Composer, Alerts, and ERP all agree on the same
//  number for the same holding.
//
//  Every FMV display in the app should route through APIService
//  `fetchCanonicalFmv` — do NOT compute FMV on device.
//

import Foundation

struct CanonicalFmvRequest: Encodable {
    let cardId: String
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let cardYear: Int?
    let product: String?
    let player: String?
    let cardNumber: String?
    /// True bypasses the 15-min server cache. Use only on explicit
    /// pull-to-refresh — never on tab-open.
    let freshCompute: Bool

    init(
        cardId: String,
        parallel: String? = nil,
        gradeCompany: String? = nil,
        gradeValue: Double? = nil,
        cardYear: Int? = nil,
        product: String? = nil,
        player: String? = nil,
        cardNumber: String? = nil,
        freshCompute: Bool = false
    ) {
        self.cardId = cardId
        self.parallel = parallel
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
        self.cardYear = cardYear
        self.product = product
        self.player = player
        self.cardNumber = cardNumber
        self.freshCompute = freshCompute
    }
}

/// Canonical FMV method tier. Order tracks confidence (direct-comp
/// highest, product-tier lowest). Method names are NEVER shown to end
/// users verbatim — surface via `CanonicalFmvBadge` labels.
enum CanonicalFmvMethod: String, Codable, Hashable {
    case directComp        = "direct-comp"
    case crossParallel     = "cross-parallel"
    case neighborParallel  = "neighbor-parallel"
    case familyBaseline    = "family-baseline"
    case productTier       = "product-tier"
    case noBasis           = "no-basis"
}

struct CanonicalFmvResponse: Decodable, Hashable {
    let fmv: Double?
    /// String form for forward compatibility; parse into `methodEnum`
    /// only when known.
    let method: String?
    let confidence: Double?
    let provenance: CanonicalFmvProvenance?
    /// ISO string — never surfaced to the user directly.
    let computedAt: String?
    /// 2026-07-19 (card-show batch): empirical PSA/BGS/SGC/CGC ratios
    /// derived from the last 365d of CardHedge sales for the family.
    /// Nullable — hide the "Same card in other grades" section
    /// entirely when the backend can't produce it.
    let gradeLadder: GradeLadder?
    /// 2026-07-20: honest observed-comp range from the top rungs
    /// (direct-comp / cross-parallel). Nil for rung 5+ (family-
    /// baseline fallback) where there's no direct sample; UI hides
    /// the "sells around $X (range $Y–$Z)" subtitle in that case
    /// rather than fabricate one.
    let recentRange: CanonicalFmvRecentRange?

    var methodEnum: CanonicalFmvMethod? {
        method.flatMap(CanonicalFmvMethod.init(rawValue:))
    }

    /// Renderable when the pipeline produced a positive number. `nil`
    /// / `no-basis` / non-positive all fall through to the "not enough
    /// data" state.
    var isRenderable: Bool {
        guard let fmv, fmv > 0 else { return false }
        return methodEnum != .noBasis
    }
}

/// Provenance shape widened 2026-07-19 to accept both the older
/// (summary + comps) fields and the new (sampleSize / compsUsed /
/// windowDays / notes) fields side-by-side. All optional — whichever
/// the backend sends is what we render. Comps array is deprecated in
/// favor of the dedicated `/recent-sales` endpoint (see
/// RecentSalesModels.swift).
struct CanonicalFmvProvenance: Decodable, Hashable {
    let summary: String?
    let comps: [CanonicalFmvComp]?
    let trendPctPerMonth: Double?
    let sampleSize: Int?
    let compsUsed: Int?
    let windowDays: Int?
    let notes: String?
}

// MARK: - Grade Ladder

struct GradeLadder: Decodable, Hashable {
    /// Product family (e.g. "bowman-chrome") that produced the ratios.
    /// Never surfaced verbatim to end users.
    let family: String?
    let sampleSize: Int?
    let tiers: [GradeLadderTier]?
}

struct GradeLadderTier: Decodable, Hashable, Identifiable {
    let grader: String
    let medianRatio: Double?
    let fmv: Double?

    var id: String { grader }
}

/// 2026-07-20: observed-comp range from the canonical FMV compute.
/// `median` is the point estimate the headline shows; `p25`/`p75`
/// bound the typical spread; `min`/`max` show the outer bookends.
/// `n` is the sample count — UIs should suppress the range display
/// when n is low (< 3) even if the field is present.
struct CanonicalFmvRecentRange: Decodable, Hashable {
    let n: Int?
    let min: Double?
    let p25: Double?
    let median: Double?
    let p75: Double?
    let max: Double?
}

struct CanonicalFmvComp: Decodable, Hashable, Identifiable {
    let price: Double
    let soldAt: String
    let source: String?
    let parallel: String?
    let verifiedByUser: Bool?

    /// Composite id for ForEach stability; comp docs don't carry a
    /// server-side id.
    var id: String {
        "\(soldAt)|\(price)|\(source ?? "")|\(parallel ?? "")"
    }
}
