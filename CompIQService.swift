// CompIQService.swift
// Calls the HobbyIQ backend CompIQ endpoint to fetch predicted next-sale price.
// Uses POST /api/compiq/search with a natural-language query built from card fields.

import Foundation

// MARK: - Result

struct CompIQMarketResult {
    let nextSaleEstimate: Double   // predicted next-sale price — use as currentValue
    let rangeLow: Double
    let rangeMedian: Double
    let rangeHigh: Double
    let sampleSize: Int
    let recommendation: String     // "hold" | "move"
    let queryUsed: String

    // Forward-looking prediction (from MCP `prediction` block)
    let predicted72h: Double?
    let predicted7d: Double?
    let predictedDirection: String?    // rising | falling | stable | volatile
    let confidence: Int?               // 0–100
    let confidenceReason: String?
    let keyDrivers: [String]
    let riskFlags: [String]
    let bestTimeToSell: String?        // now | 3 days | 7 days | hold
    let catalystDetected: Bool?
    let catalystDetail: String?
    let anchorPrice: Double?

    // Recent comps used to build the prediction (always populated when the
    // MCP server returns any). Shown by the iOS UI under price tiles.
    let recentComps: [CompEstimateRecentComp]
}

// MARK: - Errors

enum CompIQServiceError: LocalizedError {
    case missingPlayerName
    case noEstimateReturned
    case httpError(Int)
    case decodingError
    /// Server responded but couldn't build a prediction (insufficient data /
    /// no anchor price). The associated `comps` are whatever raw sales the
    /// server *did* have on file — callers can show them to the user instead
    /// of treating this as a hard failure.
    case insufficientWithComps([CompEstimateRecentComp])

    var errorDescription: String? {
        switch self {
        case .missingPlayerName:   return "Enter a player name before fetching a market value."
        case .noEstimateReturned:  return "CompIQ couldn't find enough sales data for this card."
        case .httpError(let code): return "Server returned HTTP \(code)."
        case .decodingError:       return "Unexpected response format from server."
        case .insufficientWithComps(let c):
            return "Not enough recent comps to build a prediction (\(c.count) on file)."
        }
    }
}

// MARK: - Service

enum CompIQService {

    private static let baseURL = "https://compiq-mcp.azurewebsites.net"

    /// Build a natural-language query string from card fields (kept for logging/debug).
    static func buildQuery(
        playerName: String,
        year: Int?,
        setName: String,
        cardNumber: String,
        parallel: String,
        isAuto: Bool,
        isRaw: Bool,
        gradingCompany: String,
        grade: String
    ) -> String {
        var parts: [String] = []
        if let y = year { parts.append(String(y)) }
        let set = setName.trimmingCharacters(in: .whitespaces)
        if !set.isEmpty { parts.append(set) }
        parts.append(playerName.trimmingCharacters(in: .whitespaces))
        let par = parallel.trimmingCharacters(in: .whitespaces)
        if !par.isEmpty { parts.append(par) }
        if isAuto { parts.append("auto") }
        let num = cardNumber.trimmingCharacters(in: .whitespaces)
        if !num.isEmpty { parts.append("#\(num)") }
        if isRaw {
            parts.append("raw")
        } else {
            let co = gradingCompany.trimmingCharacters(in: .whitespaces)
            if !co.isEmpty { parts.append(co) }
            let gr = grade.trimmingCharacters(in: .whitespaces)
            if !gr.isEmpty { parts.append(gr) }
        }
        return parts.joined(separator: " ")
    }

    /// Fetch predicted market value from the CompIQ MCP server.
    /// - Returns: `CompIQMarketResult` with `nextSaleEstimate` as the predicted market price.
    static func fetchMarketValue(
        playerName: String,
        year: Int?,
        setName: String,
        cardNumber: String,
        parallel: String,
        isAuto: Bool,
        isRaw: Bool,
        gradingCompany: String,
        grade: String
    ) async throws -> CompIQMarketResult {

        let name = playerName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { throw CompIQServiceError.missingPlayerName }

        let query = buildQuery(
            playerName: name,
            year: year,
            setName: setName,
            cardNumber: cardNumber,
            parallel: parallel,
            isAuto: isAuto,
            isRaw: isRaw,
            gradingCompany: gradingCompany,
            grade: grade
        )

        guard let url = URL(string: "\(baseURL)/api/compiq/predict") else {
            throw CompIQServiceError.decodingError
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60

        // Build structured body for MCP /api/compiq/predict.
        var body: [String: Any] = [
            "playerName": name,
            "set": setName.trimmingCharacters(in: .whitespaces),
            "cardNumber": cardNumber.trimmingCharacters(in: .whitespaces)
        ]
        if let y = year { body["year"] = y }

        let trimmedParallel = parallel.trimmingCharacters(in: .whitespaces)
        if !trimmedParallel.isEmpty { body["variant"] = trimmedParallel }

        if isRaw {
            body["grade"] = "raw"
        } else {
            let co = gradingCompany.trimmingCharacters(in: .whitespaces)
            let gr = grade.trimmingCharacters(in: .whitespaces)
            let combined = [co, gr].filter { !$0.isEmpty }.joined(separator: " ")
            body["grade"] = combined.isEmpty ? "raw" : combined
        }

        // Heuristic: assume rookie if "rookie" or "rc" appears in set or parallel.
        let setLower = setName.lowercased()
        let parLower = parallel.lowercased()
        let isRookieGuess = setLower.contains("rookie") || setLower.contains(" rc")
            || parLower.contains("rookie") || parLower.contains(" rc")
        if isRookieGuess { body["isRookie"] = true }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        // Decode the raw JSON once so we can extract comps in BOTH the
        // success and error paths.
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CompIQServiceError.decodingError
        }

        // Comps are always returned (even from the 422 "no_anchor_price"
        // path) so iOS can show them when there's no usable prediction.
        let rawCompsArray = (json["recentComps"] as? [[String: Any]]) ?? []
        let recentComps: [CompEstimateRecentComp] = rawCompsArray.compactMap { dict in
            guard let compData = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? JSONDecoder().decode(CompEstimateRecentComp.self, from: compData)
        }

        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            // 422 "no_anchor_price" returns recentComps — surface them via
            // the rich error so the UI can render the list.
            if http.statusCode == 422 {
                throw CompIQServiceError.insufficientWithComps(recentComps)
            }
            throw CompIQServiceError.httpError(http.statusCode)
        }

        guard let estimate = json["nextSaleEstimate"] as? Double, estimate > 0 else {
            throw CompIQServiceError.insufficientWithComps(recentComps)
        }

        let compRange = json["compRange"] as? [String: Any]
        let rangeLow    = compRange?["low"]    as? Double ?? 0
        let rangeHigh   = compRange?["high"]   as? Double ?? 0
        let rangeMedian = compRange?["median"] as? Double ?? 0

        let pricing    = json["pricing"] as? [String: Any]
        let sampleSize = pricing?["sampleSize"] as? Int ?? 0

        let recommendation = json["recommendation"] as? String ?? "hold"

        let prediction = json["prediction"] as? [String: Any]
        let predicted72h = prediction?["predicted_price_72h"] as? Double
        let predicted7d  = prediction?["predicted_price_7d"]  as? Double
        let direction    = prediction?["predicted_direction"] as? String
        let confidenceRaw = prediction?["confidence"]
        let confidence: Int? = (confidenceRaw as? Int) ?? (confidenceRaw as? Double).map { Int($0) }
        let confidenceReason = prediction?["confidence_reason"] as? String
        let keyDrivers = prediction?["key_drivers"] as? [String] ?? []
        let riskFlags  = prediction?["risk_flags"]  as? [String] ?? []
        let bestTime   = prediction?["best_time_to_sell"] as? String
        let catalystDetected = prediction?["catalyst_detected"] as? Bool
        let catalystDetail   = prediction?["catalyst_detail"] as? String
        let anchorPrice = json["anchorPrice"] as? Double

        return CompIQMarketResult(
            nextSaleEstimate: estimate,
            rangeLow: rangeLow,
            rangeMedian: rangeMedian,
            rangeHigh: rangeHigh,
            sampleSize: sampleSize,
            recommendation: recommendation,
            queryUsed: query,
            predicted72h: predicted72h,
            predicted7d: predicted7d,
            predictedDirection: direction,
            confidence: confidence,
            confidenceReason: confidenceReason,
            keyDrivers: keyDrivers,
            riskFlags: riskFlags,
            bestTimeToSell: bestTime,
            catalystDetected: catalystDetected,
            catalystDetail: catalystDetail,
            anchorPrice: anchorPrice,
            recentComps: recentComps
        )
    }
}
