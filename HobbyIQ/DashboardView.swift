//
//  DashboardView.swift
//  HobbyIQ
//

import SwiftUI

struct DashboardView: View {
    @Binding var selectedTab: MainTab
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @StateObject private var profileImageStore = ProfileImageStore.shared
    @State private var speechRecognizer = SpeechRecognizer()
    @State private var showAccount = false
    @State private var searchQuery = ""
    @State private var navigateToCompIQSearch = false
    @State private var navigateToCertResolve = false
    @State private var certResolveInput = ""
    @State private var showCardScanner = false
    @FocusState private var isAskFocused: Bool

    var body: some View {
        ZStack(alignment: .topTrailing) {
            HobbyIQBackground()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 14) {
                    Spacer(minLength: 0)

                    // Large centered logo — same as login
                    VStack(spacing: 12) {
                        Image("hobbyiq_logo")
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity)
                            .frame(height: 306)
                            .accessibilityLabel("HobbyIQ")

                        Text("Fast answers for the Hobby.")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                            .multilineTextAlignment(.center)
                            .offset(y: -115)
                    }

                    searchBar

                    scanAffordance
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .onTapGesture {
                isAskFocused = false
            }

            // Account button overlay
            Button {
                showAccount = true
            } label: {
                if let uiImage = profileImageStore.image {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 40, height: 40)
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 2)
                        )
                } else {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 24, weight: .medium))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(8)
                        .background(
                            Circle()
                                .fill(HobbyIQTheme.Colors.cardNavy.opacity(0.85))
                                .overlay(
                                    Circle()
                                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1.5)
                                )
                        )
                }
            }
            .buttonStyle(.plain)
            .padding(.trailing, 16)
            .padding(.top, 8)
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showAccount) {
            AccountView(sessionViewModel: sessionViewModel)
        }
        .scanFlow(isPresented: $showCardScanner, sessionViewModel: sessionViewModel)
    }

    // MARK: - Scan affordance

    private var scanAffordance: some View {
        Button {
            showCardScanner = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "camera.viewfinder")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("Scan a card to price it")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.5)
            )
            .clipShape(Capsule(style: .continuous))
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scan a card to price it")
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HIQSearchBar(
            text: $searchQuery,
            placeholder: "Search cards, players, comps...",
            showsMicIcon: true,
            isListening: speechRecognizer.isRecording,
            onSubmit: {
                isAskFocused = false
                let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !query.isEmpty else { return }
                if Self.looksLikeCertNumber(query) {
                    certResolveInput = query
                    navigateToCertResolve = true
                } else {
                    navigateToCompIQSearch = true
                }
            },
            onMicTap: {
                if speechRecognizer.isRecording {
                    speechRecognizer.stopRecording()
                } else {
                    isAskFocused = false
                    speechRecognizer.startRecording()
                }
            }
        )
        .focused($isAskFocused)
        .onChange(of: speechRecognizer.transcript) { _, newValue in
            if !newValue.isEmpty {
                searchQuery = newValue
            }
        }
        .navigationDestination(isPresented: $navigateToCompIQSearch) {
            CompIQVariantPickerView(initialQuery: searchQuery.trimmingCharacters(in: .whitespacesAndNewlines))
                .environmentObject(sessionViewModel)
        }
        .navigationDestination(isPresented: $navigateToCertResolve) {
            CertResolveView(input: certResolveInput)
                .environmentObject(sessionViewModel)
        }
    }

    /// 4–10 all-digit input is treated as a cert-like query and routed through
    /// the unified-search classifier instead of the variant-search text path.
    /// Tight bounds avoid catching set numbers (e.g. "#199") or partial years.
    static func looksLikeCertNumber(_ input: String) -> Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let digitCount = trimmed.count
        guard (4...10).contains(digitCount) else { return false }
        return trimmed.allSatisfy(\.isNumber)
    }

}

#Preview {
    NavigationStack {
        DashboardView(selectedTab: .constant(.dashboard), sessionViewModel: AppSessionViewModel())
    }
}
