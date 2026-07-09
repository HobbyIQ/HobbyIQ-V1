//
//  HoldingsImportView.swift
//  HobbyIQ
//
//  CF-IOS-IMPORT-BUILD (2026-06-21): the full import flow as one sheet.
//
//  State machine (ImportPhase):
//    .idle           → pick-a-file empty state.
//    .uploading      → preview request in flight.
//    .polling        → backend is processing >40-row file; poll every
//                       3s up to 40 attempts (~2 min).
//    .ready          → envelopes + summary in hand; reconciliation UI.
//    .committing     → commit POST in flight.
//    .complete       → outcomes + totals from the server.
//    .capacityExceeded → 402 from commit — distinct from generic
//                         .failed; routes to PaywallView via a sheet.
//    .failed         → generic terminal error.
//    .stale          → backend cleared the job before iOS picked it up.
//    .timeout        → poll loop exceeded its attempt cap.
//
//  Idempotency: a UUID is generated ONCE per HoldingsImportSession at
//  init and reused on every commit (including retries) — backend uses
//  it for cached-replay so a duplicate tap produces the same outcome,
//  not a double-import.
//
//  Reconciliation v1 scope: defaults + collision override ONLY. Per
//  the build CF — no per-row editor for ambiguous / unresolved /
//  identity-edited rows; they render as informational with a "fix
//  the file and re-import" prompt.
//

import Combine
import Foundation
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Orchestrator

@MainActor
final class HoldingsImportSession: ObservableObject {

    enum Phase {
        case idle
        case uploading
        case polling(jobId: String, progress: ImportJobProgress?)
        case ready(summary: ImportPreviewSummary, envelopes: [ImportRowEnvelope])
        case committing
        case complete(totals: ImportTotals, outcomes: [ImportRowOutcome], freshCollisionsBlocked: Int)
        case capacityExceeded(CapacityExceeded)
        case failed(message: String)
        case stale
        case timeout
    }

    @Published private(set) var phase: Phase = .idle

    /// Idempotency token used on commit. Regenerated at the start of
    /// every `runPreview(url:)` so a single session can run multiple
    /// preview/commit cycles cleanly — without regen, commit-A →
    /// pick-another-file-B → commit-B would replay A's cached outcome
    /// (`cached:true`) and silently miscommit. Within ONE cycle the
    /// token is stable: any retry of the same commit reuses it, and
    /// the backend returns the cached result rather than double-
    /// importing.
    private var idempotencyToken: String = UUID().uuidString

    /// ~9 MB raw cap leaves headroom under the backend's 12 MB JSON
    /// body limit after the base64 (~33%) inflation.
    static let maxFileBytes: Int = 9 * 1024 * 1024

    /// 40 attempts × 3 s = ~2 min max wait for an async preview.
    static let maxPollAttempts: Int = 40
    static let pollIntervalSeconds: UInt64 = 3

    // MARK: Preview

    func runPreview(url: URL) async {
        // New preview cycle → new idempotency token. Without this, a
        // second file picked after a successful commit would reuse the
        // first cycle's token and get back the first cycle's cached
        // outcome instead of importing the new file.
        idempotencyToken = UUID().uuidString
        phase = .uploading
        do {
            let data = try readFileWithSizeGuard(url: url)
            let format = url.pathExtension.lowercased() == "csv" ? "csv" : "xlsx"
            let body = ImportPreviewRequest(
                file: data.base64EncodedString(),
                format: format
            )
            let response = try await APIService.shared.importPreview(body: body)
            switch response {
            case .inline(let inline):
                phase = .ready(summary: inline.summary, envelopes: inline.envelopes)
            case .asyncJob(let asyncResp):
                phase = .polling(jobId: asyncResp.jobId, progress: nil)
                await pollUntilTerminal(jobId: asyncResp.jobId)
            }
        } catch let importError as HoldingsImportError {
            phase = .failed(message: importError.userMessage)
        } catch {
            phase = .failed(message: APIService.errorMessage(from: error))
        }
    }

    private func pollUntilTerminal(jobId: String) async {
        for _ in 1...Self.maxPollAttempts {
            try? await Task.sleep(nanoseconds: Self.pollIntervalSeconds * 1_000_000_000)
            do {
                let job = try await APIService.shared.fetchImportJob(jobId: jobId)
                switch job.status {
                case "ready":
                    guard let envelopes = job.envelopes,
                          let summary = job.summaryAtReady else {
                        phase = .failed(message: "Server returned ready without payload.")
                        return
                    }
                    phase = .ready(summary: summary, envelopes: envelopes)
                    return
                case "failed":
                    phase = .failed(message: job.errorMessage ?? "Import job failed.")
                    return
                case "stale":
                    phase = .stale
                    return
                case "pending", "processing":
                    phase = .polling(jobId: jobId, progress: job.progress)
                default:
                    // Unknown status — keep polling within cap.
                    continue
                }
            } catch {
                phase = .failed(message: APIService.errorMessage(from: error))
                return
            }
        }
        phase = .timeout
    }

    // MARK: Commit

    func runCommit(envelopes: [ImportRowEnvelope], collisionActions: [Int: String]) async {
        phase = .committing
        let actionsMap: [String: String]?
        if collisionActions.isEmpty {
            actionsMap = nil
        } else {
            actionsMap = Dictionary(uniqueKeysWithValues:
                collisionActions.map { (String($0.key), $0.value) }
            )
        }
        let body = ImportCommitRequest(
            idempotencyToken: idempotencyToken,
            envelopes: envelopes,
            actions: actionsMap
        )
        do {
            let response = try await APIService.shared.importCommit(body: body)
            phase = .complete(
                totals: response.totals,
                outcomes: response.outcomes,
                freshCollisionsBlocked: response.freshCollisionsBlocked
            )
        } catch let apiError as APIServiceError {
            if case .httpError(let statusCode, let bodyText) = apiError, statusCode == 402 {
                if let data = bodyText.data(using: .utf8),
                   let cap = try? JSONDecoder().decode(CapacityExceededResponse.self, from: data) {
                    phase = .capacityExceeded(cap.capacityExceeded)
                } else {
                    phase = .failed(message: "Capacity exceeded for your plan.")
                }
            } else {
                phase = .failed(message: APIService.errorMessage(from: apiError))
            }
        } catch {
            phase = .failed(message: APIService.errorMessage(from: error))
        }
    }

    // MARK: File read + size guard

    private func readFileWithSizeGuard(url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        if let size = values.fileSize, size > Self.maxFileBytes {
            throw HoldingsImportError.fileTooLarge(actualBytes: size, maxBytes: Self.maxFileBytes)
        }
        return try Data(contentsOf: url)
    }
}

// MARK: - Errors

enum HoldingsImportError: Error {
    case fileTooLarge(actualBytes: Int, maxBytes: Int)

    var userMessage: String {
        switch self {
        case .fileTooLarge(let actual, let max):
            let actualMB = Double(actual) / 1_048_576
            let maxMB = Double(max) / 1_048_576
            return String(
                format: "This file is %.1f MB. Please trim it under %.1f MB and try again.",
                actualMB, maxMB
            )
        }
    }
}

// MARK: - View

struct HoldingsImportView: View {
    @StateObject private var session = HoldingsImportSession()
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var showFilePicker = false
    @State private var collisionActions: [Int: String] = [:]
    @State private var showPaywall = false

    var body: some View {
        ZStack {
            HobbyIQBackground()
            content
                .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                .padding(.vertical, HobbyIQTheme.Spacing.medium)
        }
        .navigationTitle("Import holdings")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .fileImporter(
            isPresented: $showFilePicker,
            allowedContentTypes: Self.allowedTypes,
            allowsMultipleSelection: false
        ) { result in
            handleFilePick(result: result)
        }
        .sheet(isPresented: $showPaywall) {
            PaywallView(sessionViewModel: sessionViewModel)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch session.phase {
        case .idle:
            idleView
        case .uploading:
            progressBlock(message: "Uploading and previewing…")
        case .polling(_, let progress):
            pollingView(progress: progress)
        case .ready(let summary, let envelopes):
            reconciliationView(summary: summary, envelopes: envelopes)
        case .committing:
            progressBlock(message: "Committing…")
        case .complete(let totals, let outcomes, let freshCollisionsBlocked):
            completeView(totals: totals, outcomes: outcomes, freshCollisionsBlocked: freshCollisionsBlocked)
        case .capacityExceeded(let info):
            capacityView(info: info)
        case .failed(let message):
            terminalErrorView(title: "Import failed", message: message)
        case .stale:
            terminalErrorView(
                title: "Import went stale",
                message: "The preview expired before commit. Pick the file again to retry."
            )
        case .timeout:
            terminalErrorView(
                title: "Import timed out",
                message: "Processing took longer than expected. Try again, or trim the file."
            )
        }
    }

    // MARK: Phase views

    private var idleView: some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            Image(systemName: "tray.and.arrow.down")
                .font(.system(size: 36, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text("Import from a spreadsheet")
                .font(.title3.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Pick an .xlsx or .csv file to preview rows before they're added to your portfolio.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
            Button {
                showFilePicker = true
            } label: {
                Text("Choose file")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.large)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func progressBlock(message: String) -> some View {
        VStack(spacing: 12) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func pollingView(progress: ImportJobProgress?) -> some View {
        VStack(spacing: 12) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Processing…")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let progress {
                Text("Row \(progress.rowsProcessed) of \(progress.rowsTotal)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            } else {
                Text("Preparing…")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 180)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func reconciliationView(summary: ImportPreviewSummary, envelopes: [ImportRowEnvelope]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
                reconciliationHeader(summary: summary)

                let grouped = Dictionary(grouping: envelopes, by: \.bucket)
                ForEach(bucketDisplayOrder, id: \.self) { bucket in
                    if let rows = grouped[bucket], rows.isEmpty == false {
                        bucketSection(bucket: bucket, rows: rows)
                    }
                }

                commitButton(envelopes: envelopes, summary: summary)
            }
        }
    }

    private func reconciliationHeader(summary: ImportPreviewSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if summary.isRoundTrip {
                    headerChip(label: "ROUND-TRIP", color: HobbyIQTheme.Colors.electricBlue)
                }
                ForEach(bucketDisplayOrder, id: \.self) { bucket in
                    if let count = summary.bucketCounts[bucket], count > 0 {
                        headerChip(label: "\(count) \(bucketLabel(bucket))", color: bucketColor(bucket))
                    }
                }
                Spacer(minLength: 0)
            }
            if summary.capacityProjection.wouldExceed {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                    Text("This import would exceed your \(summary.capacityProjection.cap)-card plan cap.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                }
            }
            Text("\(summary.defaultCommitCount) row\(summary.defaultCommitCount == 1 ? "" : "s") will be committed by default.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func bucketSection(bucket: String, rows: [ImportRowEnvelope]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(bucketColor(bucket)).frame(width: 7, height: 7)
                Text(bucketLabel(bucket).uppercased())
                    .font(.caption.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            ForEach(rows) { row in
                envelopeRow(row)
            }
            if isInformationalBucket(bucket) {
                Text("These rows won't import. Fix the file and re-import to include them.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .padding(.top, 2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func envelopeRow(_ row: ImportRowEnvelope) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Row \(row.rowNumber)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text(rowDisplayTitle(row))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
            }
            if let subtitle = rowDisplaySubtitle(row), subtitle.isEmpty == false {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if let collision = row.collision {
                collisionPicker(rowNumber: row.rowNumber, collision: collision)
            } else if let message = row.message, message.isEmpty == false {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
            }
        }
        .padding(.vertical, 4)
    }

    private func collisionPicker(rowNumber: Int, collision: ImportCollision) -> some View {
        let binding = Binding<String>(
            get: { collisionActions[rowNumber] ?? collision.defaultAction },
            set: { collisionActions[rowNumber] = $0 }
        )
        return HStack(spacing: 8) {
            Picker("Action", selection: binding) {
                Text("Skip").tag("skip")
                Text("Add as copy").tag("add-as-copy")
                Text("Update cost").tag("update-cost")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .padding(.top, 4)
    }

    private func commitButton(envelopes: [ImportRowEnvelope], summary: ImportPreviewSummary) -> some View {
        let willCommit = envelopes.contains { isCommittableBucket($0.bucket) }
        return Button {
            Task {
                await session.runCommit(envelopes: envelopes, collisionActions: collisionActions)
            }
        } label: {
            Text(willCommit ? "Commit \(summary.defaultCommitCount) rows" : "Nothing to commit")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(willCommit ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.steelGray.opacity(0.4))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(willCommit == false)
    }

    private func completeView(totals: ImportTotals, outcomes: [ImportRowOutcome], freshCollisionsBlocked: Int) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                Text("Import complete")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            HStack(spacing: 16) {
                totalChip(label: "Added", value: totals.added, color: HobbyIQTheme.Colors.successGreen)
                totalChip(label: "Updated", value: totals.updated, color: HobbyIQTheme.Colors.electricBlue)
                totalChip(label: "Skipped", value: totals.skipped, color: HobbyIQTheme.Colors.mutedText)
                totalChip(label: "Failed", value: totals.failed, color: HobbyIQTheme.Colors.danger)
            }
            if freshCollisionsBlocked > 0 {
                Text("\(freshCollisionsBlocked) collision\(freshCollisionsBlocked == 1 ? "" : "s") flagged after the preview were blocked at commit.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
            }
            Button {
                dismiss()
            } label: {
                Text("Done")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func capacityView(info: CapacityExceeded) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "lock.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                Text("Plan capacity exceeded")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            Text("This import would put you at \(info.wouldBeTotal) cards (cap \(info.cap)). You're currently at \(info.currentCount).")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Button {
                showPaywall = true
            } label: {
                Text("Upgrade plan")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func terminalErrorView(title: String, message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Button {
                showFilePicker = true
            } label: {
                Text("Pick another file")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Helpers

    private func handleFilePick(result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            Task { await session.runPreview(url: url) }
        case .failure(let error):
            session.objectWillChange.send()
            // No state change beyond surfacing the picker error.
            print("[HoldingsImportView] file picker failed: \(error.localizedDescription)")
        }
    }

    private static let allowedTypes: [UTType] = {
        var types: [UTType] = [.commaSeparatedText]
        if let xlsx = UTType(filenameExtension: "xlsx") { types.append(xlsx) }
        if let xls = UTType(filenameExtension: "xls") { types.append(xls) }
        return types
    }()

    private let bucketDisplayOrder: [String] = [
        "resolved-clean",
        "resolved-collision",
        "ambiguous",
        "unresolved",
        "identity-edited"
    ]

    private func bucketLabel(_ bucket: String) -> String {
        switch bucket {
        case "resolved-clean": return "ready"
        case "resolved-collision": return "collisions"
        case "ambiguous": return "ambiguous"
        case "unresolved": return "unresolved"
        case "identity-edited": return "identity-edited"
        default: return bucket
        }
    }

    private func bucketColor(_ bucket: String) -> Color {
        switch bucket {
        case "resolved-clean": return HobbyIQTheme.Colors.successGreen
        case "resolved-collision": return HobbyIQTheme.Colors.warning
        case "ambiguous", "unresolved", "identity-edited": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.mutedText
        }
    }

    private func isInformationalBucket(_ bucket: String) -> Bool {
        bucket == "ambiguous" || bucket == "unresolved" || bucket == "identity-edited"
    }

    private func isCommittableBucket(_ bucket: String) -> Bool {
        bucket == "resolved-clean" || bucket == "resolved-collision"
    }

    private func headerChip(label: String, color: Color) -> some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.12))
            .clipShape(Capsule(style: .continuous))
    }

    private func totalChip(label: String, value: Int, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.title3.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
            Text(label.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
    }

    private func rowDisplayTitle(_ row: ImportRowEnvelope) -> String {
        let player = row.payload["playerName"]?.stringValue
            ?? row.payload["player"]?.stringValue
        let cardName = row.payload["cardName"]?.stringValue
            ?? row.payload["cardTitle"]?.stringValue
        let parts = [player, cardName].compactMap { $0 }.filter { $0.isEmpty == false }
        return parts.isEmpty ? "Row \(row.rowNumber)" : parts.joined(separator: " · ")
    }

    private func rowDisplaySubtitle(_ row: ImportRowEnvelope) -> String? {
        let year = row.payload["year"]?.stringValue ?? row.payload["cardYear"]?.stringValue
        let set = row.payload["setName"]?.stringValue ?? row.payload["product"]?.stringValue
        let parallel = row.payload["parallel"]?.stringValue
        let grade = row.payload["grade"]?.stringValue
        let parts = [year, set, parallel, grade].compactMap { $0 }.filter { $0.isEmpty == false }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
