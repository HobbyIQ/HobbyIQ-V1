//
//  CommunityModels.swift
//  HobbyIQ
//
//  Wire models for community intelligence — GET /api/community/card/:cardId
//  and GET/PATCH /api/community/consent (backend PR #555). Powers the
//  community-signal pill on Card Detail + the consent flow.
//

import Foundation

/// One community sub-signal (holderShare, turnover, consensusPrice).
/// `value` is nil when suppressed (below k-anonymity or no contributors);
/// `reason` communicates why. Row hidden entirely when value is nil per
/// the never-show-em-dash guardrail.
struct CommunitySubSignal: Codable, Hashable {
    let value: Double?
    let reason: String?
    let contributorPool: Int?
    let windowDays: Int?
    let sampleSize: Int?
}

struct CommunitySignal: Codable, Hashable {
    let kAnonymity: Int?
    let holderShare: CommunitySubSignal?
    let turnover: CommunitySubSignal?
    let consensusPrice: CommunitySubSignal?
}

struct CommunityCardResponse: Codable, Hashable {
    let cardId: String?
    let signal: CommunitySignal?
    let contributorPoolSize: Int?
}

// MARK: - Consent

/// User-facing consent flags. `consentedAt` is an ISO string when the
/// user has opted in at least once. Nil = never consented.
struct CommunityConsent: Codable, Hashable {
    let contributeSignal: Bool?
    let shareHoldings: Bool?
    let shareSales: Bool?
    let shareEngineEstimates: Bool?
    let consentedAt: String?

    /// Empty-defaulted convenience initialiser for optimistic UI state.
    static let empty = CommunityConsent(
        contributeSignal: false,
        shareHoldings: false,
        shareSales: false,
        shareEngineEstimates: false,
        consentedAt: nil
    )
}

struct CommunityConsentEnvelope: Codable, Hashable {
    let consent: CommunityConsent?
}
