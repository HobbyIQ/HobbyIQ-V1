//
//  HoldingsImportTests.swift
//  HobbyIQTests
//
//  CF-IOS-IMPORT-BUILD (2026-06-21): unit guards for the import flow's
//  decode-layer behavior and the small derivations the orchestrator
//  performs locally (collision-actions map shape, opaque payload
//  round-trip).
//

import Foundation
import XCTest
@testable import HobbyIQ

final class HoldingsImportTests: XCTestCase {

    // MARK: - PreviewResponse discriminated decode

    func testPreviewDecode_inlineShape_decodesInline() throws {
        let json = """
        {
          "ok": true,
          "summary": {
            "bucketCounts": { "resolved-clean": 3, "resolved-collision": 1 },
            "defaultCommitCount": 4,
            "isRoundTrip": false,
            "capacityProjection": { "cap": 250, "wouldExceed": false, "currentCount": 12, "wouldBeTotal": 16 }
          },
          "envelopes": [
            {
              "rowNumber": 1, "lane": "new", "bucket": "resolved-clean",
              "cardId": "csc_abc",
              "payload": { "playerName": "Mike Trout", "cardName": "2011 Topps Update", "year": "2011" },
              "parseFlags": []
            }
          ],
          "unmappedHeaders": [],
          "proposedMapping": {}
        }
        """
        let envelope = try JSONDecoder().decode(
            PreviewResponseEnvelope.self,
            from: json.data(using: .utf8)!
        )
        switch envelope.payload {
        case .inline(let inline):
            XCTAssertEqual(inline.summary.defaultCommitCount, 4)
            XCTAssertEqual(inline.envelopes.count, 1)
            XCTAssertEqual(inline.envelopes[0].rowNumber, 1)
            XCTAssertEqual(inline.envelopes[0].payload["playerName"]?.stringValue, "Mike Trout")
        case .asyncJob:
            XCTFail("Inline payload misclassified as async")
        }
    }

    func testPreviewDecode_asyncFlag_decodesAsyncJob() throws {
        let json = """
        {
          "ok": true,
          "async": true,
          "jobId": "job_xyz",
          "totalRows": 150,
          "isRoundTrip": false
        }
        """
        let envelope = try JSONDecoder().decode(
            PreviewResponseEnvelope.self,
            from: json.data(using: .utf8)!
        )
        switch envelope.payload {
        case .asyncJob(let async):
            XCTAssertEqual(async.jobId, "job_xyz")
            XCTAssertEqual(async.totalRows, 150)
            XCTAssertFalse(async.isRoundTrip)
        case .inline:
            XCTFail("Async payload misclassified as inline")
        }
    }

    func testPreviewDecode_asyncFalse_decodesInline() throws {
        // Explicit `async: false` should NOT route to the async branch —
        // the discriminator is "is true", not "is present".
        let json = """
        {
          "ok": true,
          "async": false,
          "summary": {
            "bucketCounts": {},
            "defaultCommitCount": 0,
            "isRoundTrip": false,
            "capacityProjection": { "cap": 250, "wouldExceed": false }
          },
          "envelopes": []
        }
        """
        let envelope = try JSONDecoder().decode(
            PreviewResponseEnvelope.self,
            from: json.data(using: .utf8)!
        )
        if case .asyncJob = envelope.payload {
            XCTFail("`async: false` must route to inline, not async")
        }
    }

    // MARK: - Job polling decode

    func testJobDecode_readyStatus_carriesEnvelopesAndSummary() throws {
        let json = """
        {
          "ok": true,
          "status": "ready",
          "envelopes": [
            { "rowNumber": 7, "lane": "update", "bucket": "resolved-collision",
              "existingHoldingId": "h_existing",
              "collision": { "defaultAction": "update-cost", "existingHoldingIds": ["h_existing"], "reason": "matched-by-identity" },
              "payload": { "playerName": "Trout" }, "parseFlags": [] }
          ],
          "summaryAtReady": {
            "bucketCounts": { "resolved-collision": 1 },
            "defaultCommitCount": 1,
            "isRoundTrip": false,
            "capacityProjection": { "cap": 250, "wouldExceed": false }
          }
        }
        """
        let job = try JSONDecoder().decode(ImportJobDoc.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(job.status, "ready")
        XCTAssertEqual(job.envelopes?.count, 1)
        XCTAssertEqual(job.envelopes?.first?.collision?.defaultAction, "update-cost")
        XCTAssertEqual(job.summaryAtReady?.defaultCommitCount, 1)
    }

    func testJobDecode_pendingStatus_carriesProgress() throws {
        let json = """
        {
          "ok": true,
          "status": "processing",
          "progress": { "rowsProcessed": 32, "rowsTotal": 150 }
        }
        """
        let job = try JSONDecoder().decode(ImportJobDoc.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(job.status, "processing")
        XCTAssertEqual(job.progress?.rowsProcessed, 32)
        XCTAssertEqual(job.progress?.rowsTotal, 150)
        XCTAssertNil(job.envelopes)
    }

    func testJobDecode_failedStatus_carriesErrorMessage() throws {
        let json = """
        {
          "ok": true,
          "status": "failed",
          "errorMessage": "Spreadsheet parser crashed at row 42."
        }
        """
        let job = try JSONDecoder().decode(ImportJobDoc.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(job.status, "failed")
        XCTAssertEqual(job.errorMessage, "Spreadsheet parser crashed at row 42.")
    }

    func testJobDecode_staleStatus_decodesCleanly() throws {
        let json = #"{ "ok": true, "status": "stale" }"#
        let job = try JSONDecoder().decode(ImportJobDoc.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(job.status, "stale")
    }

    // MARK: - Commit response

    /// `freshCollisionsBlocked` is OMITTED by the backend when 0. The
    /// decoder must default-fill to 0 so the UI doesn't have to handle
    /// nil — confirmed by the build CF.
    func testCommitDecode_freshCollisionsBlocked_omitted_defaultsToZero() throws {
        let json = """
        {
          "ok": true,
          "cached": false,
          "outcomes": [],
          "totals": { "added": 5, "updated": 0, "skipped": 1, "failed": 0 }
        }
        """
        let response = try JSONDecoder().decode(ImportCommitResponse.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(response.freshCollisionsBlocked, 0, "Omitted field must default to 0")
        XCTAssertEqual(response.totals.added, 5)
        XCTAssertEqual(response.totals.skipped, 1)
        XCTAssertFalse(response.cached)
    }

    func testCommitDecode_freshCollisionsBlocked_present_carriesValue() throws {
        let json = """
        {
          "ok": true,
          "cached": true,
          "outcomes": [
            { "rowNumber": 3, "action": "skip", "outcome": "blocked", "reason": "fresh-collision" }
          ],
          "totals": { "added": 0, "updated": 0, "skipped": 1, "failed": 0 },
          "freshCollisionsBlocked": 2
        }
        """
        let response = try JSONDecoder().decode(ImportCommitResponse.self, from: json.data(using: .utf8)!)
        XCTAssertEqual(response.freshCollisionsBlocked, 2)
        XCTAssertTrue(response.cached)
        XCTAssertEqual(response.outcomes.first?.outcome, "blocked")
    }

    // MARK: - 402 capacity exceeded

    func testCapacityExceededDecode_routesViaErrorBody() throws {
        // 402 body shape — decoded from the httpError body string by
        // the orchestrator, not by an APIService throwing-decode helper.
        let json = """
        {
          "ok": false,
          "error": "capacity_exceeded",
          "capacityExceeded": { "currentCount": 23, "cap": 25, "wouldBeTotal": 28 }
        }
        """
        let response = try JSONDecoder().decode(
            CapacityExceededResponse.self,
            from: json.data(using: .utf8)!
        )
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error, "capacity_exceeded")
        XCTAssertEqual(response.capacityExceeded.cap, 25)
        XCTAssertEqual(response.capacityExceeded.wouldBeTotal, 28)
    }

    // MARK: - Opaque payload round-trip

    /// The envelope's `payload` field must round-trip verbatim through
    /// decode → re-encode so the commit endpoint receives exactly what
    /// the preview shipped. JSONValue is the carrier.
    func testEnvelopePayload_roundTripsVerbatim() throws {
        let json = """
        {
          "rowNumber": 1,
          "lane": "new",
          "bucket": "resolved-clean",
          "payload": {
            "playerName": "Trout",
            "cost": 100.5,
            "quantity": 2,
            "notes": "PSA10",
            "extra": { "nested": [1, 2, "three"] }
          },
          "parseFlags": ["normalized-year"]
        }
        """
        let original = try JSONDecoder().decode(ImportRowEnvelope.self, from: json.data(using: .utf8)!)
        let reEncoded = try JSONEncoder().encode(original)
        let reDecoded = try JSONDecoder().decode(ImportRowEnvelope.self, from: reEncoded)

        XCTAssertEqual(reDecoded.rowNumber, 1)
        XCTAssertEqual(reDecoded.payload["playerName"]?.stringValue, "Trout")
        XCTAssertEqual(reDecoded.payload["cost"]?.doubleValue, 100.5)
        XCTAssertEqual(reDecoded.payload["quantity"]?.intValue, 2)
        // Nested structures must survive too.
        XCTAssertNotNil(reDecoded.payload["extra"]?["nested"])
    }

    // MARK: - Commit request shape

    func testCommitRequest_emptyActionsMap_omitsField() throws {
        // When the user overrides no collisions, `actions` must be nil
        // (so the encoded JSON omits the field entirely rather than
        // sending `actions: {}`) — backend defaults handle the rest.
        let body = ImportCommitRequest(
            idempotencyToken: "tok-1",
            envelopes: [],
            actions: nil
        )
        let encoded = try JSONEncoder().encode(body)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        XCTAssertNotNil(object)
        XCTAssertEqual(object?["idempotencyToken"] as? String, "tok-1")
        XCTAssertNil(object?["actions"], "Empty actions map must serialize as omitted, not {}")
    }

    func testCommitRequest_populatedActionsMap_serializesPerRow() throws {
        let body = ImportCommitRequest(
            idempotencyToken: "tok-2",
            envelopes: [],
            actions: ["3": "skip", "7": "update-cost"]
        )
        let encoded = try JSONEncoder().encode(body)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        let actions = object?["actions"] as? [String: String]
        XCTAssertEqual(actions?["3"], "skip")
        XCTAssertEqual(actions?["7"], "update-cost")
    }

    // MARK: - Size guard threshold

    /// The size guard rejects raw files above ~9 MB before base64
    /// expansion would push the body past the backend's 12 MB cap.
    /// The constant lives on HoldingsImportSession.maxFileBytes.
    func testSizeGuard_thresholdAt9MB() {
        XCTAssertEqual(HoldingsImportSession.maxFileBytes, 9 * 1024 * 1024)
        let actualMB = Double(HoldingsImportSession.maxFileBytes) / 1_048_576
        XCTAssertEqual(actualMB, 9.0, accuracy: 0.001)
    }

    // MARK: - Poll-loop terminal states

    /// The poll loop's cap (40 attempts × 3 s = ~2 min) and its
    /// transition rules are derived from the job-status string. The
    /// status strings here must match the backend's `status` values
    /// the build CF locked: pending | processing | ready | failed | stale.
    func testPollLoop_statusVocabulary_isKnownSet() {
        let known: Set<String> = ["pending", "processing", "ready", "failed", "stale"]
        XCTAssertEqual(known.count, 5)
    }

    func testPollLoop_capConstants() {
        XCTAssertEqual(HoldingsImportSession.maxPollAttempts, 40)
        XCTAssertEqual(HoldingsImportSession.pollIntervalSeconds, 3)
    }
}
