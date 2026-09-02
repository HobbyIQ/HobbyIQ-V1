//
//  PortfolioAdvancedModels.swift
//  HobbyIQ
//

import Foundation

// MARK: - Portfolio Health Score

struct PortfolioHealthResponse: Codable {
    let totalHoldings: Int?
    let score: Double?
    let concentrationRisk: Double?
    let staleDataRisk: Double?
    let downsideRisk: Double?
}

// MARK: - Calibration Report

struct CalibrationReportResponse: Codable {
    let sampleCount: Int?
    let meanAbsolutePctError: Double?
}

// MARK: - Weekly Brief

struct WeeklyBriefResponse: Codable {
    let period: String?
    let generatedAt: String?
    let headline: String?
    let summary: WeeklyBriefSummary?
    let topWinners: [WeeklyBriefMover]?
    let topLosers: [WeeklyBriefMover]?
    let recommendations: [String]?
}

struct WeeklyBriefSummary: Codable {
    let holdings: Int?
    let alerts: Int?
    let criticalAlerts: Int?
    let feedbackEvents: Int?
    let recommendationFollowRatePct: Double?
}

struct WeeklyBriefMover: Codable, Identifiable {
    let holdingId: String?
    let playerName: String?
    let cardTitle: String?
    let movePct: Double?
    let latestValue: Double?
    var id: String { holdingId ?? UUID().uuidString }
}

// MARK: - Recommendation Feedback

struct RecommendationFeedbackRequest: Encodable {
    let holdingId: String
    let recommendation: String
    let actionTaken: String
    let notes: String?
}

struct RecommendationFeedbackResponse: Codable {
    let message: String?
}

// MARK: - Holding Price History

struct HoldingPriceHistoryResponse: Codable {
    let holdingId: String?
    let count: Int?
    let points: [PortfolioPricePoint]?
}

struct PortfolioPricePoint: Codable, Identifiable {
    let at: String?
    let value: Double?
    let source: String?
    var id: String { at ?? UUID().uuidString }
}

// MARK: - Refresh Holding

struct RefreshHoldingResponse: Codable {
    let message: String?
    let id: String?
    /// CF-UNIVERSAL-MUTATION-ENVELOPE (backend PR #395): backend now
    /// returns the freshly-repriced holding inline — currentValue,
    /// fairMarketValue, predictedPrice, trend analysis all live here
    /// so callers can update local state without a follow-up GET.
    let holding: InventoryCard?
    let entry: HoldingMutationEntry?

    var updatedHolding: InventoryCard? {
        entry?.holding ?? holding
    }
}

// MARK: - Batch Reprice

struct BatchRepriceResponse: Codable {
    let requested: Int?
    let repriced: Int?
    let skipped: Int?
    let reason: String?
    let gates: BatchRepriceGates?
    let updates: [BatchRepriceUpdate]?
    let throttled: Bool?
    let freshSkipped: Int?
    let examined: Int?
    // CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): POST /reprice/batch now
    // answers 202 the moment the run is dispatched instead of pricing every
    // holding first (one measured request cost 5,657 Cosmos calls / 68.3s and
    // the client aborted before it finished). On that response the count
    // fields above are absent and these describe the dispatch instead; poll
    // GET /api/portfolio/reprice/status for the finished counts.
    let accepted: Bool?
    let status: String?
    let alreadyRunning: Bool?
    /// Handle for the dispatched run. Pass it to `batchRepriceStatus(jobId:)`
    /// so a poll that lands on the other serving instance can be answered
    /// "unknown-here" instead of the ambiguous "idle".
    let jobId: String?
    let startedAt: String?
    /// True on dispatch: on-screen values are the last persisted ones until
    /// the background run lands. Surface this rather than implying "now".
    let stale: Bool?
    /// CF-PORTFOLIO-FRESH-ON-OPEN (#1639, 2026-09-02): on a `throttled`
    /// answer, WHEN the values on screen were last refreshed. A skip that
    /// says only "no" is indistinguishable from a broken refresh; this lets
    /// the header say "as of 10:42" instead of going quiet.
    ///
    /// Optional so an older server that answers a bare `{ throttled: true }`
    /// still decodes — the UI falls back to the portfolio envelope's
    /// `newestValuationAt`, and says nothing when neither is present.
    let freshAsOf: String?
    let freshAgeMs: Double?
}

/// CF-PORTFOLIO-FRESH-ON-OPEN (#1639, 2026-09-02): the `valuation` block on
/// `GET /api/portfolio`.
///
/// These values are ALWAYS the last persisted ones — that endpoint has never
/// computed a price. Now that opening the screen dispatches a reprice, the
/// payload says so rather than letting the UI present possibly-superseded
/// numbers as current.
struct PortfolioValuationEnvelope: Decodable, Hashable {
    /// A background reprice is working on this user's holdings right now —
    /// AS SEEN BY THE WORKER THAT ANSWERED. App Insights shows 2 serving
    /// instances, so this can read false while a run is alive on the other
    /// one. The client must OR it with its own dispatch state rather than
    /// treating it as the only "is it refreshing" signal.
    let repricing: Bool?
    /// `lastUpdated` of the STALEST holding, ISO-8601.
    let oldestValuationAt: String?
    let oldestValuationAgeMs: Double?
    /// `lastUpdated` of the FRESHEST holding — the "as of" the UI shows.
    let newestValuationAt: String?
    /// Durable cross-instance marker of the last dispatched reprice.
    let lastRepriceDispatchAt: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repricing = (try? c.decodeIfPresent(Bool.self, forKey: .repricing)) ?? nil
        oldestValuationAt = (try? c.decodeIfPresent(String.self, forKey: .oldestValuationAt)) ?? nil
        oldestValuationAgeMs = (try? c.decodeIfPresent(Double.self, forKey: .oldestValuationAgeMs)) ?? nil
        newestValuationAt = (try? c.decodeIfPresent(String.self, forKey: .newestValuationAt)) ?? nil
        lastRepriceDispatchAt = (try? c.decodeIfPresent(String.self, forKey: .lastRepriceDispatchAt)) ?? nil
    }

    private enum CodingKeys: String, CodingKey {
        case repricing, oldestValuationAt, oldestValuationAgeMs
        case newestValuationAt, lastRepriceDispatchAt
    }
}

/// CF-PORTFOLIO-REFRESH-ASYNC (2026-08-31): GET /api/portfolio/reprice/status
///
/// Judged blocker, same date: the backend serves from 2 instances and the job
/// map is per-process, so a poll can land on the worker that did NOT dispatch.
/// That worker answers `unknown-here` — it has no view of the run, which is
/// NOT the same as the run being finished. Branch on `settled`; never treat
/// "status is not running" as completion.
struct RepriceStatusResponse: Codable {
    /// "idle" | "unknown-here" | "running" | "done" | "error"
    let status: String?
    let running: Bool?
    /// True only when a worker actually observed the run reach done/error.
    /// `idle` and `unknown-here` are explicitly not settled — keep polling.
    let settled: Bool?
    let jobId: String?
    let startedAt: String?
    let finishedAt: String?
    let result: BatchRepriceResponse?
    let error: String?
}

struct BatchRepriceGates: Codable {
    let minPricingConfidence: Double?
    let minCompsUsed: Int?
}

struct BatchRepriceUpdate: Codable, Identifiable {
    let id: String
    let status: String?
    let reason: String?
    let cardId: String?
}

// MARK: - SAS Upload (card-photo)

struct SASUploadRequest: Encodable {
    let clientId: String?
    let fileExtension: String
}

struct SASUploadResponse: Codable {
    let success: Bool?
    let uploadUrl: String?
    let blobUrl: String?
    let blobName: String?
    let containerName: String?
    let contentType: String?
    let maxSizeBytes: Int?
    let expiresAt: String?
}

// MARK: - Card Identify

struct CardIdentifyRequest: Encodable {
    let blobUrl: String
    let blobName: String?
    let extractCert: Bool?
}

struct CardIdentifyResponse: Codable {
    let success: Bool?
    let requestId: String?
    let processingTime: Double?
    let detections: [CardIdentifyDetection]?
    let messages: [CardIdentifyMessage]?
    let error: String?
}

// CF-PAGES-NOT-SHEETS (2026-07-04): Hashable added throughout so
// `CardIdentifyDetection` can be a value passed to
// `.navigationDestination(item:)`.
struct CardIdentifyDetection: Codable, Identifiable, Hashable {
    let confidence: String?
    let card: CardIdentifyCard?
    let grading: CardIdentifyGrading?
    var id: String { card?.id ?? UUID().uuidString }
}

struct CardIdentifyCard: Codable, Hashable {
    let id: String
    let segmentId: String?
    let releaseId: String?
    let setId: String?
    let year: String?
    let manufacturer: String?
    let releaseName: String?
    let setName: String?
    let name: String?
    let number: String?
    let parallel: CardIdentifyParallel?
}

struct CardIdentifyParallel: Codable, Hashable {
    let id: String?
    let name: String?
    let numberedTo: Int?
}

struct CardIdentifyGrading: Codable, Hashable {
    let confidence: String?
    let company: CardIdentifyGradeCompany?
    let grade: CardIdentifyGradeValue?
    let qualifier: CardIdentifyQualifier?
    let autoGrade: CardIdentifyGradeValue?
}

struct CardIdentifyGradeCompany: Codable, Hashable {
    let id: String?
    let name: String?
}

struct CardIdentifyGradeValue: Codable, Hashable {
    let id: String?
    let value: String?
    let condition: String?
}

struct CardIdentifyQualifier: Codable, Hashable {
    let id: String?
    let code: String?
}

struct CardIdentifyMessage: Codable, Identifiable {
    let type: String?
    let message: String?
    var id: String { "\(type ?? "")_\(message ?? "")" }
}

// MARK: - Identifiable Sets

struct IdentifiableSetsResponse: Codable {
    let success: Bool?
    let refreshedAt: String?
    let totalCount: Int?
    let segmentCount: Int?
    let skip: Int?
    let take: Int?
    let sets: [IdentifiableSet]?
}

struct IdentifiableSet: Codable, Identifiable {
    let year: String?
    let releaseName: String?
    let segmentName: String?
    let setName: String?
    let setId: String?
    var id: String { setId ?? UUID().uuidString }

    private enum CodingKeys: String, CodingKey {
        case year
        case releaseName = "release_name"
        case segmentName = "segment_name"
        case setName = "set_name"
        case setId = "set_id"
    }
}

// MARK: - Set Supported

struct SetSupportedResponse: Codable {
    let success: Bool?
    let setId: String?
    let supported: Bool?
    let source: String?
}
