//
//  ReportWrongCompSheet.swift
//  HobbyIQ
//
//  2026-07-15: reason-capture sheet for the moderation flow.
//  Presented from the recent-comps row context menu on the priced
//  card. The user can Skip (send with no reason) or Send (send with
//  the optional short reason). Success flips a local "flagged"
//  state on the parent so the row fades — backend soft-deletes on
//  next fetch. Errors are silent (best-effort moderation).
//

import SwiftUI

struct ReportWrongCompSheet: View {
    let comp: CompIQPriceRecentComp
    let cardId: String
    /// Fires with `(compId, didFlag)`. `didFlag == true` only when
    /// the network POST returned a success/status:"flagged".
    let onCompleted: (String, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var reason: String = ""
    @State private var isSubmitting = false

    private var compId: String {
        comp.compId?.trimmingCharacters(in: .whitespaces) ?? ""
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    reasonField
                    Spacer(minLength: 0)
                }
                .padding(20)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Report as Wrong")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
            .safeAreaInset(edge: .bottom) {
                actionButtons
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let price = comp.price {
                Text(price.formatted(.currency(code: "USD").precision(.fractionLength(0))))
                    .font(.title3.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if let title = comp.title, title.isEmpty == false {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(3)
            }
            Text("This comp will be removed from pricing after review.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .padding(.top, 4)
        }
    }

    private var reasonField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reason (optional)")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField("e.g. wrong parallel, damaged card, lot listing", text: $reason, axis: .vertical)
                .lineLimit(3...5)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(12)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onChange(of: reason) { _, newValue in
                    // Cap at 200 chars per prompt constraint. Truncate
                    // silently — no toast, no error — the user just
                    // can't type further.
                    if newValue.count > 200 {
                        reason = String(newValue.prefix(200))
                    }
                }

            HStack {
                Spacer()
                Text("\(reason.count) / 200")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    private var actionButtons: some View {
        HStack(spacing: 10) {
            Button("Skip") {
                Task { await submit(includeReason: false) }
            }
            .buttonStyle(.bordered)
            .tint(HobbyIQTheme.Colors.mutedText)
            .disabled(isSubmitting)

            Button {
                Task { await submit(includeReason: true) }
            } label: {
                HStack(spacing: 8) {
                    if isSubmitting {
                        ProgressView().tint(HobbyIQTheme.Colors.pureWhite)
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                    Text(isSubmitting ? "Sending…" : "Send")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(HobbyIQTheme.Colors.electricBlue)
            .disabled(isSubmitting)
        }
    }

    private func submit(includeReason: Bool) async {
        guard compId.isEmpty == false else {
            dismiss()
            return
        }
        isSubmitting = true
        defer { isSubmitting = false }
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveReason: String? = (includeReason && trimmed.isEmpty == false) ? trimmed : nil
        do {
            let ok = try await APIService.shared.flagCompAsWrong(
                cardId: cardId,
                compId: compId,
                reason: effectiveReason
            )
            await MainActor.run {
                onCompleted(compId, ok)
                dismiss()
            }
        } catch {
            // Silent — moderation is best-effort. Still fire the
            // callback with didFlag=false so the parent knows nothing
            // to fade.
            await MainActor.run {
                onCompleted(compId, false)
                dismiss()
            }
        }
    }
}
