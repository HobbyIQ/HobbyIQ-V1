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

struct CanonicalFmvProvenance: Decodable, Hashable {
    let summary: String?
    let comps: [CanonicalFmvComp]?
    let trendPctPerMonth: Double?
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
