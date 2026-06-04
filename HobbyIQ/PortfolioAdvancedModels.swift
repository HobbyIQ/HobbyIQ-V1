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
}

struct BatchRepriceGates: Codable {
    let minPricingConfidence: Double?
    let minCompsUsed: Int?
}

struct BatchRepriceUpdate: Codable, Identifiable {
    let id: String
    let status: String?
    let reason: String?
    let cardsightCardId: String?
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

struct CardIdentifyDetection: Codable, Identifiable {
    let confidence: String?
    let card: CardIdentifyCard?
    let grading: CardIdentifyGrading?
    var id: String { card?.id ?? UUID().uuidString }
}

struct CardIdentifyCard: Codable {
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

struct CardIdentifyParallel: Codable {
    let id: String?
    let name: String?
    let numberedTo: Int?
}

struct CardIdentifyGrading: Codable {
    let confidence: String?
    let company: CardIdentifyGradeCompany?
    let grade: CardIdentifyGradeValue?
    let qualifier: CardIdentifyQualifier?
    let autoGrade: CardIdentifyGradeValue?
}

struct CardIdentifyGradeCompany: Codable {
    let id: String?
    let name: String?
}

struct CardIdentifyGradeValue: Codable {
    let id: String?
    let value: String?
    let condition: String?
}

struct CardIdentifyQualifier: Codable {
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
