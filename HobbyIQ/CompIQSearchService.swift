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

        // Dispatcher emits no explicit `success` flag — only `candidates`
        // (and warnings). Treat nil success as "no signal, trust the
        // candidates array"; only bail on an explicit success=false.
        guard response.success != false else {
            logger.warning("cardsearch returned success=false")
            return []
        }

        let hits = response.results ?? []
        logger.info("Found \(hits.count) variants")
        return hits
    }

    /// Fetches full pricing data for a specific card variant by its Cardsight ID.
    /// CF-PARALLEL-SUBMARKET (2026-06-10): `parallelId` + `parallelName`
    /// added so a parallel-row tap in the picker can request the
    /// sub-market via the parent's base id + parallel disambiguator —
    /// matching the wire contract at compiq.routes.ts:1158.
    func priceByCardId(
        _ id: String,
        query: String?,
        gradeCompany: String?,
        gradeValue: Double?,
        parallelId: String? = nil,
        parallelName: String? = nil
    ) async throws -> CompIQPriceByIdResponse {
        logger.info("Fetching price for cardId: \(id)")
        let response = try await APIService.shared.priceByCardId(
            cardId: id,
            query: query,
            gradeCompany: gradeCompany,
            gradeValue: gradeValue,
            parallelId: parallelId,
            parallelName: parallelName
        )
        if let fmv = response.marketTier?.value {
            logger.info("Price received: $\(fmv)")
        } else {
            logger.info("No FMV in response (source: \(response.source ?? "unknown"))")
        }
        return response
    }
}
