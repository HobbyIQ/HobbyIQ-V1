//
//  CommunityViews.swift
//  HobbyIQ
//
//  Card-detail community pill + progressive consent modal (PR #555).
//  Owner surfaces (PortfolioHoldingDetailSheet) pass in a cardId; the
//  pill fetches on task and self-suppresses on nil / failure.
//

import SwiftUI

// MARK: - UserDefaults gate for the consent modal

enum CommunityConsentGate {
    /// UserDefaults key set the first time the user answers the modal
    /// (either "Not now" or "Turn on"). Suppresses re-prompting on
    /// every community-surface tap.
    static let seenModalKey = "hobbyiq.community.seenConsentModal"

    static var hasSeenModal: Bool {
        UserDefaults.standard.bool(forKey: seenModalKey)
    }

    static func markSeen() {
        UserDefaults.standard.set(true, forKey: seenModalKey)
    }
}

// MARK: - Card Detail community pill

/// Fetches `/api/community/card/:cardId` on task and renders the compact
/// signal card below the recent-comps section on Card Detail. Rows self-
/// suppress on nil values; all-null renders the single "signal available
/// at 5+ contributors" line.
struct CommunitySignalPill: View {
    let cardId: String?

    @State private var response: CommunityCardResponse?
    @State private var loaded = false
    @State private var showConsentModal = false

    var body: some View {
        Group {
            if let cardId, cardId.isEmpty == false {
                pillContent(cardId: cardId)
                    .task(id: cardId) {
                        guard loaded == false else { return }
                        await load(cardId: cardId)
                        loaded = true
                    }
                    .sheet(isPresented: $showConsentModal) {
                        CommunityConsentModal()
                            .presentationDetents([.medium])
                    }
            }
        }
    }

    @ViewBuilder
    private func pillContent(cardId: String) -> some View {
        if let response {
            renderedCard(response: response)
                .onTapGesture {
                    if CommunityConsentGate.hasSeenModal == false {
                        showConsentModal = true
                    }
                }
        }
    }

    private func renderedCard(response: CommunityCardResponse) -> some View {
        let signal = response.signal
        let pool = response.contributorPoolSize ?? 0
        let hasHolder = signal?.holderShare?.value != nil
        let hasTurnover = signal?.turnover?.value != nil
        let hasConsensus = signal?.consensusPrice?.value != nil
        let anyRow = hasHolder || hasTurnover || hasConsensus

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("COMMUNITY")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                if pool > 0 {
                    Text("\u{00B7} \(pool) pros contributing")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer(minLength: 0)
            }

            if anyRow {
                VStack(spacing: 6) {
                    if hasHolder, let v = signal?.holderShare?.value {
                        row(label: "Owners in the pool", value: percentString(v))
                    }
                    if hasTurnover, let v = signal?.turnover?.value {
                        let windowDays = signal?.turnover?.windowDays ?? 30
                        row(label: "Sold in last \(windowDays)d", value: percentString(v))
                    }
                    if hasConsensus, let v = signal?.consensusPrice?.value {
                        row(label: "Consensus predicted", value: currencyString(v))
                    }
                }
            } else {
                Text("Community signal available at 5+ contributors")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func row(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private func percentString(_ value: Double) -> String {
        String(format: "%.0f%%", value * 100)
    }

    private func currencyString(_ value: Double) -> String {
        value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }

    private func load(cardId: String) async {
        do {
            response = try await APIService.shared.fetchCommunityCard(cardId: cardId)
        } catch {
            response = nil
        }
    }
}

// MARK: - Consent modal

struct CommunityConsentModal: View {
    @Environment(\.dismiss) private var dismiss
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                VStack(spacing: 20) {
                    Text("Join the community?")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .multilineTextAlignment(.center)
                        .padding(.top, 8)

                    Text("Contribute your (anonymized) portfolio and sales to sharpen these signals for everyone. Your data is aggregated k=5; no individual portfolio ever leaves this device without being pooled with at least 4 others.")
                        .font(.body)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 8)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                            .multilineTextAlignment(.center)
                    }

                    Spacer(minLength: 0)

                    HStack(spacing: 12) {
                        Button {
                            CommunityConsentGate.markSeen()
                            dismiss()
                        } label: {
                            Text("Not now")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .frame(maxWidth: .infinity)
                                .frame(minHeight: 48)
                                .background(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                                .clipShape(Capsule(style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(isSubmitting)

                        Button {
                            Task { await turnOn() }
                        } label: {
                            HStack(spacing: 6) {
                                if isSubmitting {
                                    ProgressView().controlSize(.mini).tint(HobbyIQTheme.Colors.pureWhite)
                                }
                                Text(isSubmitting ? "Turning on…" : "Turn on")
                                    .font(.subheadline.weight(.bold))
                            }
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 48)
                            .background(HobbyIQTheme.Colors.electricBlue)
                            .clipShape(Capsule(style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(isSubmitting)
                    }
                }
                .padding(HobbyIQTheme.Spacing.screenPadding)
                .padding(.bottom, 12)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func turnOn() async {
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            _ = try await APIService.shared.patchCommunityConsent(
                contributeSignal: true,
                shareHoldings: true,
                shareSales: true,
                shareEngineEstimates: true
            )
            CommunityConsentGate.markSeen()
            dismiss()
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Account tab section

/// Community section for the Account tab. Loads current consent, exposes
/// four toggles (master + three sub-shares). Sub-toggles gray out when
/// master is off. Every change PATCHes back and rolls back on failure.
struct CommunitySettingsSection: View {
    @State private var consent: CommunityConsent = .empty
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("COMMUNITY")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            VStack(spacing: 0) {
                toggleRow(
                    label: "Contribute my signal",
                    caption: "Master switch — required for any share.",
                    isOn: Binding(
                        get: { consent.contributeSignal ?? false },
                        set: { newValue in Task { await patch(contributeSignal: newValue) } }
                    ),
                    enabled: true
                )
                Divider().overlay(Color.white.opacity(0.06))
                toggleRow(
                    label: "Share holdings",
                    caption: nil,
                    isOn: Binding(
                        get: { consent.shareHoldings ?? false },
                        set: { newValue in Task { await patch(shareHoldings: newValue) } }
                    ),
                    enabled: consent.contributeSignal == true
                )
                Divider().overlay(Color.white.opacity(0.06))
                toggleRow(
                    label: "Share sales",
                    caption: nil,
                    isOn: Binding(
                        get: { consent.shareSales ?? false },
                        set: { newValue in Task { await patch(shareSales: newValue) } }
                    ),
                    enabled: consent.contributeSignal == true
                )
                Divider().overlay(Color.white.opacity(0.06))
                toggleRow(
                    label: "Share estimates",
                    caption: nil,
                    isOn: Binding(
                        get: { consent.shareEngineEstimates ?? false },
                        set: { newValue in Task { await patch(shareEngineEstimates: newValue) } }
                    ),
                    enabled: consent.contributeSignal == true
                )
            }
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
        }
        .task { await load() }
    }

    private func toggleRow(label: String, caption: String?, isOn: Binding<Bool>, enabled: Bool) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(enabled ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText.opacity(0.6))
                if let caption {
                    Text(caption)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            Spacer()
            Toggle("", isOn: isOn)
                .labelsHidden()
                .tint(HobbyIQTheme.Colors.electricBlue)
                .disabled(enabled == false)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let envelope = try await APIService.shared.fetchCommunityConsent()
            consent = envelope.consent ?? .empty
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func patch(
        contributeSignal: Bool? = nil,
        shareHoldings: Bool? = nil,
        shareSales: Bool? = nil,
        shareEngineEstimates: Bool? = nil
    ) async {
        let priorConsent = consent
        // Optimistic apply — matches the toggle animation.
        consent = CommunityConsent(
            contributeSignal: contributeSignal ?? consent.contributeSignal,
            shareHoldings: shareHoldings ?? consent.shareHoldings,
            shareSales: shareSales ?? consent.shareSales,
            shareEngineEstimates: shareEngineEstimates ?? consent.shareEngineEstimates,
            consentedAt: consent.consentedAt
        )
        do {
            let envelope = try await APIService.shared.patchCommunityConsent(
                contributeSignal: contributeSignal,
                shareHoldings: shareHoldings,
                shareSales: shareSales,
                shareEngineEstimates: shareEngineEstimates
            )
            consent = envelope.consent ?? consent
        } catch {
            consent = priorConsent
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}
