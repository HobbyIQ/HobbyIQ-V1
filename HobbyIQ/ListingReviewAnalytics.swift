//
//  ListingReviewAnalytics.swift
//  HobbyIQ
//
//  2026-07-20: fire-and-forget telemetry for the Listing Review
//  flow. Today emits to `os.Logger` so events show up in Console
//  during development; when a real telemetry sink lands (Segment /
//  Amplitude / /api/analytics/events endpoint), swap the log
//  bodies for the sink call and every existing caller keeps
//  working — the facade is stable.
//

import Foundation
import os

enum ListingReviewAnalytics {
    private static let logger = Logger(
        subsystem: "com.hobbyiq.app",
        category: "listing-review"
    )
    /// Throttle window for field-edit events — the spec says
    /// "throttled to 1/field/second" so a fast typist doesn't
    /// flood the pipe. Keyed by field name.
    private static var lastFieldEmit: [String: Date] = [:]
    private static let fieldEditThrottle: TimeInterval = 1

    static func opened(holdingId: String) {
        logger.info("listing_review_opened holdingId=\(holdingId, privacy: .public)")
    }

    static func fieldEdited(holdingId: String, field: String) {
        let now = Date()
        if let last = lastFieldEmit[field], now.timeIntervalSince(last) < fieldEditThrottle {
            return
        }
        lastFieldEmit[field] = now
        logger.info("listing_review_field_edited holdingId=\(holdingId, privacy: .public) field=\(field, privacy: .public)")
    }

    static func validationBlocked(holdingId: String, missingFields: [String]) {
        let joined = missingFields.joined(separator: ",")
        logger.info("listing_review_validation_blocked holdingId=\(holdingId, privacy: .public) missing=\(joined, privacy: .public)")
    }

    static func published(holdingId: String, editedFieldsCount: Int) {
        logger.info("listing_review_published holdingId=\(holdingId, privacy: .public) editedFields=\(editedFieldsCount)")
    }

    static func publishFailed(holdingId: String, ebayError: String) {
        logger.error("listing_review_publish_failed holdingId=\(holdingId, privacy: .public) error=\(ebayError, privacy: .public)")
    }
}
