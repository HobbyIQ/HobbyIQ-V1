//  BacktestAdminView.swift
//  HobbyIQ — DEBUG-only admin view that surfaces fn-backtest-runner output
//  through the MCP /admin/backtest/summary endpoint.
//
//  This view is only ever surfaced inside #if DEBUG blocks (see entry point
//  in PortfolioSettingsView). It is never compiled into production binaries.

import SwiftUI

#if DEBUG

// MARK: - DTOs

/// Top-level response from GET /admin/backtest/summary on the MCP server.
/// Fields are decoded leniently: missing values become nil/0 rather than
/// throwing, so a partial backtest run still renders something useful.
struct BacktestSummaryResponse: Decodable {
    let totalPredictions: Int?
    let dateRangeStart: String?
    let dateRangeEnd: String?
    let overallAccuracy: Double?
    let buckets: [BacktestBucket]?
    let recent: [BacktestRow]?

    enum CodingKeys: String, CodingKey {
        case totalPredictions = "total_predictions"
        case dateRangeStart   = "date_range_start"
        case dateRangeEnd     = "date_range_end"
        case overallAccuracy  = "overall_accuracy"
        case buckets
        case recent
    }
}

struct BacktestBucket: Decodable, Identifiable {
    let signalSource: String
    let predictionCount: Int
    let correctPct: Double
    let meanErrorPct: Double

    var id: String { signalSource }

    enum CodingKeys: String, CodingKey {
        case signalSource    = "signal_source"
        case predictionCount = "prediction_count"
        case correctPct      = "correct_pct"
        case meanErrorPct    = "mean_error_pct"
    }
}

struct BacktestRow: Decodable, Identifiable {
    let id: String
    let player: String
    let predictedPrice: Double
    let actualPrice: Double
    let directionCorrect: Bool
    let scoredAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case player
        case predictedPrice   = "predicted_price"
        case actualPrice      = "actual_price"
        case directionCorrect = "direction_correct"
        case scoredAt         = "scored_at"
    }
}

// MARK: - View

struct BacktestAdminView: View {

    @State private var isLoading: Bool = false
    @State private var summary: BacktestSummaryResponse?
    @State private var loadError: String?

    @State private var isRunning: Bool = false
    @State private var runBanner: BannerState?

    private let mcpBaseURL: String = ProcessInfo.processInfo
        .environment["MCP_BASE_URL"]?
        .trimmingCharacters(in: .whitespaces)
        .nonEmptyOrNil
        ?? "https://compiq-mcp.azurewebsites.net"

    private let adminKey: String = ProcessInfo.processInfo
        .environment["MCP_ADMIN_KEY"]?
        .trimmingCharacters(in: .whitespaces)
        ?? ""

    var body: some View {
        Group {
            if isLoading && summary == nil {
                loadingState
            } else if let summary {
                content(summary: summary)
            } else if let loadError {
                errorState(message: loadError)
            } else {
                loadingState
            }
        }
        .navigationTitle("Backtest Admin")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task { await runNow() }
                } label: {
                    if isRunning {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Run Now", systemImage: "play.circle")
                    }
                }
                .disabled(isRunning)
            }
        }
        .task { await fetchSummary() }
        .refreshable { await fetchSummary() }
    }

    // MARK: Body sections

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading backtest summary…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    private func errorState(message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(.orange)
            Text("Couldn't load backtest summary")
                .font(.headline)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button {
                Task { await fetchSummary() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                    .background(Color.blue.opacity(0.12))
                    .foregroundColor(.blue)
                    .clipShape(Capsule())
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    private func content(summary: BacktestSummaryResponse) -> some View {
        List {
            if let banner = runBanner {
                Section {
                    HStack(spacing: 8) {
                        Image(systemName: banner.isError
                              ? "exclamationmark.triangle.fill"
                              : "checkmark.circle.fill")
                            .foregroundStyle(banner.isError ? .orange : .green)
                        Text(banner.message).font(.footnote)
                        Spacer()
                        Button {
                            runBanner = nil
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            // 1. Summary header
            Section("Summary") {
                summaryRow("Total predictions",
                           value: "\(summary.totalPredictions ?? 0)")
                summaryRow("Date range",
                           value: dateRangeText(summary))
                summaryRow("Overall accuracy",
                           value: percentString(summary.overallAccuracy))
            }

            // 2. Accuracy by bucket
            Section("Accuracy by signal source") {
                if let buckets = summary.buckets, !buckets.isEmpty {
                    ForEach(buckets) { b in
                        bucketRow(b)
                    }
                } else {
                    Text("No bucket data yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            // 4. Recalibration note
            if let note = recalibrationNote(buckets: summary.buckets) {
                Section {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "lightbulb.fill")
                            .foregroundStyle(.yellow)
                        Text(note)
                            .font(.footnote)
                    }
                } header: {
                    Text("Recalibration")
                }
            }

            // 3. Recent scored rows (last 10)
            Section("Recent scored predictions") {
                let rows = Array((summary.recent ?? []).prefix(10))
                if rows.isEmpty {
                    Text("No rows scored yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(rows) { row in
                        recentRowView(row)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func summaryRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label).font(.subheadline)
            Spacer()
            Text(value)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private func bucketRow(_ b: BacktestBucket) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(bucketColor(b.correctPct))
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(b.signalSource.capitalized)
                    .font(.subheadline)
                    .fontWeight(.medium)
                Text("\(b.predictionCount) predictions")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(percentString(b.correctPct))
                    .font(.subheadline.monospacedDigit())
                    .fontWeight(.semibold)
                    .foregroundColor(bucketColor(b.correctPct))
                Text("± \(percentString(b.meanErrorPct))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func recentRowView(_ row: BacktestRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(row.player)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer()
                Image(systemName: row.directionCorrect
                      ? "checkmark.circle.fill"
                      : "xmark.circle.fill")
                    .foregroundStyle(row.directionCorrect ? .green : .red)
            }
            HStack(spacing: 10) {
                Text("Predicted \(currency(row.predictedPrice))")
                Text("→")
                Text("Actual \(currency(row.actualPrice))")
                    .fontWeight(.medium)
                Spacer()
                Text(row.scoredAt.prefix(10))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    // MARK: Helpers

    private func dateRangeText(_ s: BacktestSummaryResponse) -> String {
        let start = s.dateRangeStart?.prefix(10) ?? "—"
        let end   = s.dateRangeEnd?.prefix(10) ?? "—"
        return "\(start) → \(end)"
    }

    private func percentString(_ value: Double?) -> String {
        guard let v = value else { return "—" }
        return String(format: "%.1f%%", v)
    }

    private func currency(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    /// green > 70, amber 50…70, red < 50.
    private func bucketColor(_ pct: Double) -> Color {
        if pct > 70 { return .green }
        if pct >= 50 { return .orange }
        return .red
    }

    /// Build the plain-text recalibration note when one or more buckets fall
    /// into the red band. Returns nil when nothing is below 50%.
    private func recalibrationNote(buckets: [BacktestBucket]?) -> String? {
        guard let buckets else { return nil }
        let weak = buckets
            .filter { $0.correctPct < 50 }
            .map { $0.signalSource }
        guard !weak.isEmpty else { return nil }
        return "Consider reducing weight for: \(weak.joined(separator: ", "))"
    }

    // MARK: Networking

    private func authorizedRequest(path: String, method: String) -> URLRequest? {
        guard let url = URL(string: mcpBaseURL.trimmingCharacters(in: .init(charactersIn: "/"))
                            + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 15
        if !adminKey.isEmpty {
            req.setValue(adminKey, forHTTPHeaderField: "x-functions-key")
        }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    @MainActor
    private func fetchSummary() async {
        // Don't wipe the previous summary — Known Bug rule (preserve state
        // until new payload is verified). Only flip isLoading; clear error.
        isLoading = true
        loadError = nil
        defer { isLoading = false }

        guard let req = authorizedRequest(path: "/admin/backtest/summary",
                                          method: "GET") else {
            loadError = "Bad URL"
            return
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                loadError = "No HTTP response"
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                loadError = "HTTP \(http.statusCode)"
                return
            }
            let decoded = try JSONDecoder().decode(BacktestSummaryResponse.self,
                                                   from: data)
            self.summary = decoded
        } catch {
            self.loadError = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }

    @MainActor
    private func runNow() async {
        isRunning = true
        runBanner = nil
        defer { isRunning = false }

        guard let req = authorizedRequest(path: "/admin/backtest/run",
                                          method: "POST") else {
            runBanner = .error("Bad URL")
            return
        }
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                runBanner = .error("No HTTP response")
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                runBanner = .error("HTTP \(http.statusCode)")
                return
            }
            runBanner = .success("Backtest run kicked off. Refresh in a few minutes.")
            // Re-fetch summary once a run is queued so the UI eventually
            // reflects new rows; the runner is async on the server.
            await fetchSummary()
        } catch {
            runBanner = .error(error.localizedDescription)
        }
    }
}

// MARK: - Banner state

private struct BannerState {
    let message: String
    let isError: Bool

    static func success(_ msg: String) -> BannerState { .init(message: msg, isError: false) }
    static func error(_ msg: String)   -> BannerState { .init(message: msg, isError: true) }
}

// MARK: - Local nonEmpty helper

private extension String {
    var nonEmptyOrNil: String? { isEmpty ? nil : self }
}

#endif
