//
//  CompIQSearchService.swift
//  HobbyIQ
//

import Foundation
import os

@MainActor
final class CompIQSearchService {
    static let shared = CompIQSearchService()
    private let logger = Logger(subsystem: "com.compiq.app", category: "CompIQ")
    private init() {}

    /// Searches for card variants matching a free-text query.
    /// Returns the list of variant hits, preserving order from the backend.
    func searchVariants(query: String) async throws -> [CompIQVariantHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return [] }

        logger.info("Searching variants for: \(trimmed)")
        let response = try await APIService.shared.searchVariantList(query: trimmed)

        guard response.success == true else {
            logger.warning("cardsearch returned ok=false")
            return []
        }

        let hits = response.results ?? []
        logger.info("Found \(hits.count) variants")
        return hits
    }

    /// Fetches full pricing data for a specific card variant by its Cardsight ID.
    func priceByCardId(
        _ id: String,
        query: String?,
        gradeCompany: String?,
        gradeValue: Double?
    ) async throws -> CompIQPriceByIdResponse {
        logger.info("Fetching price for cardId: \(id)")
        let response = try await APIService.shared.priceByCardId(
            cardsightCardId: id,
            query: query,
            gradeCompany: gradeCompany,
            gradeValue: gradeValue
        )
        if let fmv = response.marketTier?.value {
            logger.info("Price received: $\(fmv)")
        } else {
            logger.info("No FMV in response (source: \(response.source ?? "unknown"))")
        }
        return response
    }
}
