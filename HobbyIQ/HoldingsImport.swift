//
//  HoldingsImport.swift
//  HobbyIQ
//
//  CF-IOS-IMPORT-BUILD (2026-06-21): wire models for the holdings
//  import flow — preview / poll / commit. iOS never parses the
//  spreadsheet itself; it base64-encodes the file bytes, ships them
//  to /import/preview, and renders the envelopes the backend produces.
//
//  Three endpoints, four user-distinct terminal states:
//
//    POST /api/portfolio/import/preview
//      → ≤40 rows: inline {summary, envelopes, unmappedHeaders, ...}
//      → >40 rows: {ok, async:true, jobId, totalRows, isRoundTrip}
//    GET  /api/portfolio/import/jobs/:jobId
//      → {status: pending|processing|ready|failed|stale, ...}
//    POST /api/portfolio/import/commit
//      → 200 {totals, outcomes, freshCollisionsBlocked?(omitted when 0)}
//      → 402 {error:"capacity_exceeded", capacityExceeded{...}}
//
//  Decode preserves the row `payload` opaquely via JSONValue so the
//  commit can round-trip envelopes verbatim. The UI extracts known
//  fields (player / card / year / set / parallel / grade) for display
//  but never mutates the payload.
//

import Foundation

// MARK: - Preview request

struct ImportPreviewRequest: Encodable {
    /// Raw file bytes, base64-encoded. NOT multipart — backend accepts
    /// a JSON body with `file` as a base64 string.
    let file: String
    /// "xlsx" or "csv". Derived from the picked file's extension.
    let format: String
}

// MARK: - Preview response (discriminated union)

/// Inline payload returned when the spreadsheet has ≤40 rows. The
/// backend resolves everything synchronously and ships envelopes
/// + summary in the response.
struct ImportPreviewInlineResponse: Decodable {
    let summary: ImportPreviewSummary
    let envelopes: [ImportRowEnvelope]
    let unmappedHeaders: [String]?
    let proposedMapping: [String: String]?
}

/// Async payload returned when the spreadsheet has >40 rows. No
/// envelopes inline — the iOS client must poll /import/jobs/:jobId
/// until status is `ready` (or a terminal failure).
struct ImportPreviewAsyncResponse: Decodable {
    let jobId: String
    let totalRows: Int
    let isRoundTrip: Bool
}

/// Discriminated union over the two preview response shapes. The
/// backend distinguishes them via the `async: true` flag — when
/// present the response is async; otherwise inline.
enum PreviewResponse {
    case inline(ImportPreviewInlineResponse)
    case asyncJob(ImportPreviewAsyncResponse)
}

/// Top-level decode envelope. Custom `init(from:)` peeks at `async`
/// to choose the inline vs async branch.
struct PreviewResponseEnvelope: Decodable {
    let ok: Bool
    let payload: PreviewResponse

    private enum CodingKeys: String, CodingKey {
        case ok
        case asyncFlag = "async"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.ok = (try? c.decode(Bool.self, forKey: .ok)) ?? true
        let isAsync = (try? c.decode(Bool.self, forKey: .asyncFlag)) ?? false
        if isAsync {
            self.payload = .asyncJob(try ImportPreviewAsyncResponse(from: decoder))
        } else {
            self.payload = .inline(try ImportPreviewInlineResponse(from: decoder))
        }
    }
}

// MARK: - Preview summary

struct ImportPreviewSummary: Decodable {
    /// Per-bucket counts keyed by bucket name string. Decoded as a
    /// generic dict so the UI can iterate without locking the bucket
    /// vocabulary at the decode layer (the backend may add buckets).
    let bucketCounts: [String: Int]
    /// Rows that will land at commit time if the user accepts every
    /// default — `resolved-clean` + collision rows that don't get
    /// overridden to skip.
    let defaultCommitCount: Int
    /// True when the spreadsheet is a HobbyIQ export being re-imported
    /// (a round-trip). Surfaces as a chip in the reconciliation header.
    let isRoundTrip: Bool
    let capacityProjection: ImportCapacityProjection
}

struct ImportCapacityProjection: Decodable {
    let cap: Int
    let wouldExceed: Bool
    let currentCount: Int?
    let wouldBeTotal: Int?
}

// MARK: - Envelope (the unit of reconciliation)

/// One row from the spreadsheet, after the backend has identified +
/// bucketed it. The envelope round-trips verbatim from preview → commit
/// (the `payload` is preserved opaquely via JSONValue so iOS can render
/// a few known fields without locking the schema).
struct ImportRowEnvelope: Codable, Hashable, Identifiable {
    let rowNumber: Int
    /// "update" (matched an existing holding) | "new" (insert).
    let lane: String
    /// "resolved-clean" | "resolved-collision" | "ambiguous"
    /// | "unresolved" | "identity-edited". Render-keyed.
    let bucket: String
    let cardsightCardId: String?
    let existingHoldingId: String?
    let collision: ImportCollision?
    /// Raw normalized payload from the backend, opaque to iOS. Carries
    /// player / card / year / set / parallel / grade / cost / quantity
    /// / notes — whatever the backend extracted. Round-tripped to the
    /// commit endpoint verbatim.
    let payload: JSONValue
    let parseFlags: [String]?
    let message: String?

    var id: Int { rowNumber }
}

struct ImportCollision: Codable, Hashable {
    /// "skip" | "add-as-copy" | "update-cost" — backend's recommended
    /// default. The user can override via the reconciliation Picker.
    let defaultAction: String
    let existingHoldingIds: [String]
    let reason: String
}

// MARK: - Job polling

/// Response from GET /import/jobs/:jobId. The `envelopes` and
/// `summaryAtReady` fields are only present when `status == "ready"`;
/// `errorMessage` only when `status == "failed"`.
struct ImportJobDoc: Decodable {
    let ok: Bool
    let status: String
    let progress: ImportJobProgress?
    let envelopes: [ImportRowEnvelope]?
    let summaryAtReady: ImportPreviewSummary?
    let errorMessage: String?
}

struct ImportJobProgress: Decodable {
    let rowsProcessed: Int
    let rowsTotal: Int
}

// MARK: - Commit

struct ImportCommitRequest: Encodable {
    /// UUID generated ONCE per preview and reused verbatim on every
    /// retry. Backend uses it for cached-replay so duplicate clicks
    /// produce the same outcome rather than double-importing.
    let idempotencyToken: String
    let envelopes: [ImportRowEnvelope]
    /// Sparse map: {<rowNumber as string>: chosen action}. Only
    /// populated for collision rows the user overrode; rows omitted
    /// here use the backend's default action. nil → omit entirely
    /// (Codable Optional encoding).
    let actions: [String: String]?
}

struct ImportCommitResponse: Decodable {
    let ok: Bool
    let cached: Bool
    let outcomes: [ImportRowOutcome]
    let totals: ImportTotals
    /// Omitted by the backend when 0. Default-decoded to 0 so the UI
    /// doesn't have to handle nil.
    let freshCollisionsBlocked: Int

    private enum CodingKeys: String, CodingKey {
        case ok, cached, outcomes, totals, freshCollisionsBlocked
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.ok = try c.decode(Bool.self, forKey: .ok)
        self.cached = try c.decode(Bool.self, forKey: .cached)
        self.outcomes = try c.decode([ImportRowOutcome].self, forKey: .outcomes)
        self.totals = try c.decode(ImportTotals.self, forKey: .totals)
        self.freshCollisionsBlocked =
            (try? c.decode(Int.self, forKey: .freshCollisionsBlocked)) ?? 0
    }
}

struct ImportRowOutcome: Decodable, Hashable, Identifiable {
    let rowNumber: Int
    let action: String
    let outcome: String
    let holdingId: String?
    let reason: String?

    var id: Int { rowNumber }
}

struct ImportTotals: Decodable {
    let added: Int
    let updated: Int
    let skipped: Int
    let failed: Int
}

// MARK: - 402 capacity exceeded

/// Decoded from the body of an HTTP 402 response — backend's distinct
/// signal for "this would push the user over their plan's holdings
/// cap." Routes to PaywallView, NOT to the generic error path.
struct CapacityExceededResponse: Decodable {
    let ok: Bool
    let error: String
    let capacityExceeded: CapacityExceeded
}

struct CapacityExceeded: Decodable {
    let currentCount: Int
    let cap: Int
    let wouldBeTotal: Int
}

// MARK: - Opaque JSON value

/// Round-trips an arbitrary JSON value through Codable so the import
/// envelope's `payload` survives preview → commit unchanged. The UI
/// extracts known fields for display via the subscript accessors;
/// unknown fields pass through opaquely.
indirect enum JSONValue: Codable, Hashable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value at this position"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let v): try container.encode(v)
        case .int(let v): try container.encode(v)
        case .double(let v): try container.encode(v)
        case .string(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        }
    }

    // Convenience accessors used by the reconciliation UI to extract
    // display fields without locking the schema. Unknown / missing
    // keys return nil cleanly.

    var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    var doubleValue: Double? {
        if case .double(let v) = self { return v }
        if case .int(let v) = self { return Double(v) }
        return nil
    }

    var intValue: Int? {
        if case .int(let v) = self { return v }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }
}
