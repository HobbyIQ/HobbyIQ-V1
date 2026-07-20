//
//  CertNumberInputSheet.swift
//  HobbyIQ
//
//  2026-07-19 (spec §2): unified modal cert-lookup entry point.
//  Presented from the Dashboard "Cert #" chip and from any surface
//  that needs a manual cert-number path. On successful lookup it
//  pushes `CertLookupResultView` with the resolved card + canonical
//  FMV + ready-to-add prefill. On failure it renders an inline error
//  and stays open so the user can correct the input.
//
//  Distinct from `SlabCertLookupView` — that surface is a full-page
//  view kept for the graded scan flow's "Have a cert # instead?"
//  affordance. This modal is the spec's canonical entry point.
//

import SwiftUI

struct CertNumberInputSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var grader: Grader = .psa
    @State private var cert: String = ""
    @State private var isLoading = false
    @State private var result: LookupByCertResponse?
    @State private var errorMessage: String?
    @State private var pushToResult = false
    @FocusState private var certFocused: Bool

    /// Minimum cert length before we enable the Look Up button. Cert
    /// numbers across the four graders vary (PSA 8 digits, BGS 10,
    /// SGC 8-10, CGC 8-10), so 6 is a permissive lower bound.
    private static let minCertLength = 6

    enum Grader: String, CaseIterable, Identifiable {
        case psa = "PSA"
        case bgs = "BGS"
        case sgc = "SGC"
        case cgc = "CGC"
        var id: String { rawValue }
    }

    private var canLookUp: Bool {
        cert.trimmingCharacters(in: .whitespaces).count >= Self.minCertLength && isLoading == false
    }

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                VStack(alignment: .leading, spacing: 20) {
                    graderPicker
                    certField
                    lookUpButton
                    if let errorMessage {
                        inlineError(errorMessage)
                    }
                    Spacer()
                }
                .padding(HobbyIQTheme.Spacing.screenPadding)
            }
            .navigationTitle("Look up cert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
            .navigationDestination(isPresented: $pushToResult) {
                if let result, result.success {
                    CertLookupResultView(response: result)
                }
            }
            .onAppear {
                // Auto-focus the cert field on modal reveal (spec §2).
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    certFocused = true
                }
            }
        }
    }

    // MARK: - Grader picker

    private var graderPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Grader")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Picker("Grader", selection: $grader) {
                ForEach(Grader.allCases) { g in
                    Text(g.rawValue).tag(g)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - Cert field

    private var certField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Cert number")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            TextField("e.g. 12345678", text: $cert)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled(true)
                .keyboardType(.asciiCapable)
                .textFieldStyle(.plain)
                .font(.body.monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.2)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                .focused($certFocused)
                .submitLabel(.search)
                .onSubmit {
                    if canLookUp { Task { await performLookup() } }
                }
        }
    }

    // MARK: - Look up button

    private var lookUpButton: some View {
        Button {
            Task { await performLookup() }
        } label: {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView().tint(HobbyIQTheme.Colors.pureWhite)
                }
                Text(isLoading ? "Looking up\u{2026}" : "Look up")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(canLookUp ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.electricBlue.opacity(0.3))
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(canLookUp == false)
    }

    // MARK: - Inline error

    private func inlineError(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.danger)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.danger.opacity(0.14))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    // MARK: - Lookup

    private func performLookup() async {
        let trimmed = cert.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= Self.minCertLength else { return }
        certFocused = false
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchCertLookup(
                cert: trimmed,
                grader: grader.rawValue,
                days: 90
            )
            if response.success {
                result = response
                pushToResult = true
            } else {
                errorMessage = response.error ?? "No match for \(grader.rawValue) #\(trimmed) — check the number."
            }
        } catch {
            errorMessage = "Couldn't reach the server. Try again in a moment."
        }
    }
}
