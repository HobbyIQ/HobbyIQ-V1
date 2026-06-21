//
//  HoldingsExport.swift
//  HobbyIQ
//
//  CF-IOS-EXPORT-BUILD (2026-06-21): payload type + header parsers for
//  GET /api/portfolio/export.
//
//  iOS does NOT inspect the file's contents — `data` is raw bytes (xlsx
//  binary or text/csv) handed straight to UIActivityViewController via
//  a temp file URL. The two header fields are best-effort metadata:
//
//    - `holdingsCount` from the custom `X-Holdings-Count: <int>` header.
//      Surfaces the row count for UI ("Exported N holdings"). nil when
//      the header is absent or the value is non-integer.
//    - `suggestedFilename` from `Content-Disposition: attachment;
//      filename="..."`. Used as the temp-file name so the share sheet
//      shows the backend-chosen "hobbyiq-holdings-YYYY-MM-DD.{ext}"
//      and "Open in Numbers" picks the right UTType. nil when the
//      header is absent — caller falls back to a default.
//
//  Parsers live as `static` methods on a nested namespace so the unit
//  tests can hit them directly without network mocking.
//

import Foundation

/// Result of GET /api/portfolio/export — raw bytes + best-effort header
/// metadata. Transport only.
struct HoldingsExportPayload {
    let data: Data
    let holdingsCount: Int?
    let suggestedFilename: String?
}

/// Parsers for the two custom response headers the export endpoint
/// emits. Internal so the test target (@testable import HobbyIQ) can
/// exercise them without hitting the network.
enum HoldingsExportHeaderParser {

    /// Parse `X-Holdings-Count` header value into an Int. Returns nil
    /// when the header is absent, empty, or non-integer (defensive —
    /// the backend always emits an integer when present, but we don't
    /// want a malformed header to throw).
    static func parseHoldingsCount(from header: String?) -> Int? {
        guard let header else { return nil }
        let trimmed = header.trimmingCharacters(in: .whitespaces)
        guard trimmed.isEmpty == false, let value = Int(trimmed) else {
            return nil
        }
        return value
    }

    /// Parse the `filename` parameter out of a `Content-Disposition`
    /// header. Handles both quoted (`filename="hobbyiq-holdings.xlsx"`)
    /// and unquoted (`filename=hobbyiq-holdings.xlsx`) forms, plus the
    /// RFC 5987 `filename*=UTF-8''...` extended form. Returns nil when
    /// the header is absent or contains no `filename` parameter.
    ///
    /// Per the RFC, parameter order isn't guaranteed; iterate
    /// semicolon-separated parts looking for the right one rather than
    /// assuming a fixed position.
    static func parseFilename(fromContentDisposition header: String?) -> String? {
        guard let header else { return nil }

        for part in header.split(separator: ";") {
            let trimmed = part.trimmingCharacters(in: .whitespaces)

            // RFC 5987 extended-form: prefer it when present.
            // `filename*=UTF-8''hobbyiq-holdings.xlsx`
            if trimmed.lowercased().hasPrefix("filename*=") {
                let raw = String(trimmed.dropFirst("filename*=".count))
                // Strip the optional `<charset>''` prefix.
                if let tickRange = raw.range(of: "''") {
                    let encoded = String(raw[tickRange.upperBound...])
                    return encoded.removingPercentEncoding ?? encoded
                }
                return raw
            }

            if trimmed.lowercased().hasPrefix("filename=") {
                var value = String(trimmed.dropFirst("filename=".count))
                if value.hasPrefix("\"") { value.removeFirst() }
                if value.hasSuffix("\"") { value.removeLast() }
                return value.isEmpty ? nil : value
            }
        }
        return nil
    }
}
