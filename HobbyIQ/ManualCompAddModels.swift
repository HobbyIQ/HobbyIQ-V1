//
//  ManualCompAddModels.swift
//  HobbyIQ
//
//  Wire models for POST /api/portfolio/manual-comps/add (backend
//  PR #601). Powers the "Report a sale" sheet on Card Detail.
//

import Foundation

/// Request body for manual comp add. `cardId` and `playerName` are
/// required by the backend; the rest are optional but recommended so
/// the pipeline can key the comp against the exact SKU.
struct ManualCompAddRequest: Encodable {
    let cardId: String
    let playerName: String
    let price: Double
    /// ISO string (UTC). Client-side validation rejects > 1d in the future.
    let soldAt: String
    let cardYear: Int?
    let setName: String?
    let parallel: String?
    let cardNumber: String?
    let isAuto: Bool?
    let gradeCompany: String?
    let gradeValue: Double?
    let title: String?
}

struct ManualCompAddResponse: Decodable, Hashable {
    let success: Bool?
    let sourceExternalId: String?
    let cardId: String?
    let price: Double?
    let soldAt: String?
}
