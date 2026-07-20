//
//  PortfolioImportPreviewView.swift
//  HobbyIQ
//
//  2026-07-20: Step B + C of the bulk-import flow — preview screen
//  with add/update/conflict/reject bucketing, per-row conflict
//  resolution, and idempotency-token-gated commit. Uses the file
//  handed off by `PortfolioDataView`'s file picker.
//

import SwiftUI

struct PortfolioImportPreviewView: View {
    let fileUrl: URL
    let format: String
    let onFinished: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var response: PortfolioImportPreviewResponse?
    @State private var idempotencyToken: String = UUID().uuidString
    /// User-chosen action per envelopeId — starts populated from the
    /// bucket default (add → "add", update → "update", conflict →
    /// "skip"). Rejects never enter this map.
    @State private var actions: [String: String] = [:]
    @State private var isCommitting = false
    @State private var committed = false

    var body: some View {
        Group {
            if isLoading {
                loadingState
            } else if let errorMessage {
                errorState(errorMessage)
            } else if let response {
                content(response)
            }
        }
        .navigationTitle("Import preview")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task {
            await runPreview()
        }
    }

    // MARK: - Content

    private func content(_ response: PortfolioImportPreviewResponse) -> some View {
        let envelopes = response.envelopes ?? []
        let counts = bucketCounts(envelopes)

        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                summaryCard(counts)
                if envelopes.isEmpty {
                    Text("The file didn't produce any parseable rows.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                } else {
                    ForEach(PortfolioImportBucket.allCases, id: \.rawValue) { bucket in
                        let rows = envelopes.filter { $0.bucketKind == bucket }
                        if rows.isEmpty == false {
                            bucketSection(bucket: bucket, rows: rows)
                        }
                    }
                }
                commitBar(envelopes: envelopes)
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
    }

    private func summaryCard(_ counts: [PortfolioImportBucket: Int]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Preview")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            summaryLine(bucket: .add, count: counts[.add] ?? 0, tint: HobbyIQTheme.Colors.hobbyGreen)
            summaryLine(bucket: .update, count: counts[.update] ?? 0, tint: HobbyIQTheme.Colors.electricBlue)
            summaryLine(bucket: .conflict, count: counts[.conflict] ?? 0, tint: HobbyIQTheme.Colors.warning)
            summaryLine(bucket: .reject, count: counts[.reject] ?? 0, tint: HobbyIQTheme.Colors.danger)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func summaryLine(bucket: PortfolioImportBucket, count: Int, tint: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: bucket.iconSystemName)
                .foregroundStyle(tint)
                .frame(width: 22)
            Text("\(count) \(bucket.label.lowercased())")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer(minLength: 0)
        }
    }

    private func bucketSection(bucket: PortfolioImportBucket, rows: [PortfolioImportEnvelope]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(bucket.label.uppercased())
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            ForEach(rows) { row in
                envelopeRow(row)
            }
        }
    }

    private func envelopeRow(_ row: PortfolioImportEnvelope) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: row.bucketKind.iconSystemName)
                    .foregroundStyle(color(for: row.bucketKind))
                Text(row.displayLabel ?? row.playerName ?? "Row \(row.rowIndex.map(String.init) ?? "\u{2014}")")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer(minLength: 0)
            }
            if let sub = rowSubtitle(row) {
                Text(sub)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if row.bucketKind == .reject, let reason = row.reason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.85))
            }
            if row.bucketKind == .conflict {
                conflictPicker(for: row)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func conflictPicker(for row: PortfolioImportEnvelope) -> some View {
        Picker("Action", selection: Binding(
            get: { actions[row.id] ?? "skip" },
            set: { actions[row.id] = $0 }
        )) {
            Text("Skip").tag("skip")
            Text("Overwrite").tag("update")
            Text("Keep existing").tag("skip")
        }
        .pickerStyle(.segmented)
    }

    private func rowSubtitle(_ row: PortfolioImportEnvelope) -> String? {
        var parts: [String] = []
        if let year = row.year { parts.append(year) }
        if let set = row.setName { parts.append(set) }
        if let num = row.cardNumber { parts.append("#\(num)") }
        if let parallel = row.parallel, parallel.lowercased() != "base" { parts.append(parallel) }
        if let gc = row.gradeCompany, let gv = row.gradeValue {
            parts.append("\(gc) \(gv.truncatingRemainder(dividingBy: 1) == 0 ? String(format: "%.0f", gv) : String(format: "%.1f", gv))")
        }
        if let qty = row.quantity, qty > 1 { parts.append("qty \(qty)") }
        if let price = row.purchasePrice, price > 0 {
            parts.append("$\(Int(price.rounded()))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    private func color(for bucket: PortfolioImportBucket) -> Color {
        switch bucket {
        case .add: return HobbyIQTheme.Colors.hobbyGreen
        case .update: return HobbyIQTheme.Colors.electricBlue
        case .conflict: return HobbyIQTheme.Colors.warning
        case .reject: return HobbyIQTheme.Colors.danger
        }
    }

    private func commitBar(envelopes: [PortfolioImportEnvelope]) -> some View {
        let applyCount = envelopes.filter { row in
            switch row.bucketKind {
            case .add: return (actions[row.id] ?? "add") != "skip"
            case .update: return (actions[row.id] ?? "update") != "skip"
            case .conflict: return (actions[row.id] ?? "skip") != "skip"
            case .reject: return false
            }
        }.count

        return VStack(spacing: 10) {
            Text("\(applyCount) rows will be applied. Nothing writes until you tap Confirm.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
            Button {
                Task { await runCommit(envelopes: envelopes) }
            } label: {
                HStack(spacing: 8) {
                    if isCommitting {
                        ProgressView().tint(HobbyIQTheme.Colors.pureWhite)
                    }
                    Text(committed ? "Imported" : (isCommitting ? "Applying\u{2026}" : "Confirm import"))
                }
            }
            .buttonStyle(.appPrimary)
            .disabled(isCommitting || committed || applyCount == 0)
            .opacity((isCommitting || committed || applyCount == 0) ? 0.6 : 1)
        }
        .padding(.top, 8)
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Parsing your file\u{2026}")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.85))
            Text("Couldn't parse this file")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Preview

    private func runPreview() async {
        do {
            let data = try Data(contentsOf: fileUrl)
            var result = try await APIService.shared.previewImport(
                fileData: data,
                format: format
            )
            // Async large-file path: backend returns jobId with
            // status="processing". Poll every 2s until ready.
            if result.isProcessing, let jobId = result.jobId {
                for _ in 0..<60 {  // cap at 2 minutes
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    result = try await APIService.shared.pollImportJob(jobId: jobId)
                    if result.isReady || result.isFailed { break }
                }
            }
            if result.isFailed {
                errorMessage = result.error ?? "The server couldn't process the file."
            } else {
                response = result
                if let token = result.idempotencyToken {
                    idempotencyToken = token
                }
                actions = defaultActions(for: result.envelopes ?? [])
            }
        } catch {
            errorMessage = "Couldn't send the file for preview. Try again in a moment."
        }
        isLoading = false
    }

    private func defaultActions(for envelopes: [PortfolioImportEnvelope]) -> [String: String] {
        var map: [String: String] = [:]
        for env in envelopes {
            switch env.bucketKind {
            case .add: map[env.id] = "add"
            case .update: map[env.id] = "update"
            case .conflict: map[env.id] = "skip"
            case .reject: continue
            }
        }
        return map
    }

    private func bucketCounts(_ envelopes: [PortfolioImportEnvelope]) -> [PortfolioImportBucket: Int] {
        var counts: [PortfolioImportBucket: Int] = [:]
        for env in envelopes {
            counts[env.bucketKind, default: 0] += 1
        }
        return counts
    }

    // MARK: - Commit

    private func runCommit(envelopes: [PortfolioImportEnvelope]) async {
        isCommitting = true
        defer { isCommitting = false }
        // Exclude reject-bucket envelopes; only send ones with an
        // active action.
        let applyEnvelopes = envelopes.filter { $0.bucketKind != .reject }
        let applyActions = actions.filter { !$0.value.isEmpty }
        do {
            let result = try await APIService.shared.commitImport(
                idempotencyToken: idempotencyToken,
                envelopes: applyEnvelopes,
                actions: applyActions
            )
            if result.isIdempotencyExpired {
                errorMessage = "This preview expired \u{2014} redo the import from Step 1."
                return
            }
            let added = result.holdingsAdded ?? 0
            let updated = result.holdingsUpdated ?? 0
            committed = true
            onFinished("Imported \(added + updated) holdings.")
            // Give the toast a beat, then pop.
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await MainActor.run { dismiss() }
        } catch {
            errorMessage = "The commit failed. Nothing was written; try again."
        }
    }
}

// PortfolioImportBucket is defined in PortfolioImportModels.swift;
// add CaseIterable conformance here so the preview view can iterate
// buckets in a stable UI order.
extension PortfolioImportBucket: CaseIterable {
    public static var allCases: [PortfolioImportBucket] {
        [.add, .update, .conflict, .reject]
    }
}
