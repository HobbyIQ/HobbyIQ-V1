//
//  DashboardView.swift
//  HobbyIQ
//

import Combine
import SwiftUI

struct DashboardView: View {
    @Binding var selectedTab: MainTab
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @StateObject private var profileImageStore = ProfileImageStore.shared
    @StateObject private var atAGlance = DashboardAtAGlanceViewModel()
    @State private var speechRecognizer = SpeechRecognizer()
    @State private var showAccount = false
    @State private var searchQuery = ""
    @State private var navigateToCompIQSearch = false
    @State private var navigateToCertResolve = false
    @State private var navigateToCertLookup = false
    @State private var navigateToMovers = false
    @State private var certResolveInput = ""
    @State private var showCardScanner = false
    @State private var showGradedScanner = false
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

                    scanAndCertRow

                    gradedScanAffordance

                    atAGlanceSection
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            // CF-DASHBOARD-KEYBOARD-GAP (2026-07-04): don't reserve
            // safe-area space for the keyboard — iOS was leaving a
            // visible gap between the search bar and the top of the
            // keyboard. Letting the keyboard overlay the natural
            // layout keeps things flush.
            .ignoresSafeArea(.keyboard, edges: .bottom)
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
        .gradedSlabScanFlow(isPresented: $showGradedScanner, sessionViewModel: sessionViewModel)
        .navigationDestination(isPresented: $navigateToCertLookup) {
            SlabCertLookupView()
                .environmentObject(sessionViewModel)
        }
        .navigationDestination(isPresented: $navigateToMovers) {
            // 2026-07-19 (spec §4): route to card-level Market Movers.
            // Seed with the at-a-glance viewmodel's cached response so
            // the initial paint is instant; the list re-fetches from
            // the network when the user changes any filter.
            MarketMoversListView(seededResponse: atAGlance.marketMoversResponse)
                .environmentObject(sessionViewModel)
        }
        // 2026-07-19: at-a-glance previews poll only on foreground reveal
        // (per spec §1) — no timers, no `.onReceive` continuous updates.
        .task {
            await atAGlance.loadIfStale()
        }
    }

    // MARK: - At-a-glance section (spec §1)

    private var atAGlanceSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("AT A GLANCE")
                .font(.caption2.weight(.bold))
                .tracking(1.2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .padding(.top, 6)
                .padding(.horizontal, 4)

            DashboardAtAGlanceCard(
                icon: "brain.head.profile",
                iconTint: HobbyIQTheme.Colors.electricBlue,
                title: "DailyIQ",
                subtitle: "Today's briefing"
            ) {
                selectedTab = .daily
            }

            DashboardAtAGlanceCard(
                icon: "chart.bar.xaxis",
                iconTint: HobbyIQTheme.Colors.hobbyGreen,
                title: "Portfolio",
                subtitle: atAGlance.portfolioSubtitle
            ) {
                selectedTab = .portfolio
            }

            DashboardAtAGlanceCard(
                icon: "flame.fill",
                iconTint: Color(hex: 0xFF6B4A),
                title: "Movers today",
                subtitle: atAGlance.moversSubtitle
            ) {
                navigateToMovers = true
            }
        }
        .padding(.top, 4)
    }

    // MARK: - Scan + cert entry row (spec §1)

    /// 2026-07-19: split the single scan-raw button into a two-button
    /// row that pairs scan-raw (left, primary) with a "# Cert #" chip
    /// (right) that opens `SlabCertLookupView`. Cert lookup was
    /// previously only reachable via the search bar's 4–10-digit
    /// shortcut or from inside the graded slab scan flow.
    private var scanAndCertRow: some View {
        HStack(spacing: 10) {
            Button {
                showCardScanner = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "camera.viewfinder")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("Scan raw")
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
            .accessibilityLabel("Scan a raw card to price it")

            Button {
                navigateToCertLookup = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "number")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("Cert #")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.5)
                )
                .clipShape(Capsule(style: .continuous))
                .contentShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Look up a graded card by cert number")
        }
    }

    // MARK: - Graded slab scan affordance

    private var gradedScanAffordance: some View {
        Button {
            showGradedScanner = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.badge.checkmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("Scan a graded slab to find it")
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
        .accessibilityLabel("Scan a graded slab to find the card")
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

// MARK: - At-a-glance card (spec §1)

/// Preview tile for the Dashboard at-a-glance section. Icon + title +
/// dynamic subtitle + trailing chevron; whole surface is tappable and
/// forwards to the destination the caller wires up.
private struct DashboardAtAGlanceCard: View {
    let icon: String
    let iconTint: Color
    let title: String
    let subtitle: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(iconTint)
                    .frame(width: 36, height: 36)
                    .background(iconTint.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.2), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - At-a-glance view model (spec §1)

/// Foreground-only preview data for the Dashboard at-a-glance section.
/// Loads once per Dashboard reveal (via `.task`), no timers. Individual
/// data sources degrade silently — a nil field just renders as a
/// generic CTA subtitle.
///
/// Portfolio total reads the same UserDefaults cache
/// `PortfolioIQViewModel` writes after a successful canonical-FMV batch
/// (key: `hobbyiq.portfolio.total.cached`) — no network needed, and the
/// value survives cold starts so the card is populated the moment the
/// dashboard renders.
@MainActor
final class DashboardAtAGlanceViewModel: ObservableObject {
    @Published private(set) var moversUp: Int?
    @Published private(set) var moversDown: Int?
    @Published private(set) var portfolioTotal: Double?
    /// Held so the Movers tap-through can seed `MarketMoversListView`
    /// with the same response the glance card already fetched — no
    /// double round-trip on first paint. The list re-fetches from the
    /// backend when the user changes any filter.
    @Published private(set) var marketMoversResponse: MarketMoversResponse?

    private var lastLoad: Date?
    private static let staleWindow: TimeInterval = 30
    private static let cachedPortfolioTotalKey = "hobbyiq.portfolio.total.cached"

    var portfolioSubtitle: String {
        guard let total = portfolioTotal, total > 0 else {
            return "See your holdings"
        }
        let dollars = Int(total.rounded())
        let formatted = dollars.formatted(.number.grouping(.automatic))
        return "$\(formatted) total"
    }

    var moversSubtitle: String {
        guard let up = moversUp, let down = moversDown, (up + down) > 0 else {
            return "See what's moving"
        }
        return "\(up) up · \(down) down"
    }

    func loadIfStale() async {
        if let last = lastLoad, Date().timeIntervalSince(last) < Self.staleWindow {
            return
        }
        lastLoad = Date()

        let cached = UserDefaults.standard.double(forKey: Self.cachedPortfolioTotalKey)
        if cached > 0 {
            portfolioTotal = cached
        }

        do {
            // 2026-07-19 (spec §4): card-level Market Movers is the
            // authoritative source for the "Movers today" preview
            // (priorMedian → currentMedian deltas). Hot Right Now is
            // player-level momentum, semantically distinct.
            let response = try await APIService.shared.fetchMarketMovers(
                sport: "baseball",
                window: "7d",
                direction: "both",
                limit: 50
            )
            marketMoversResponse = response
            let movers = response.movers ?? []
            var up = 0
            var down = 0
            for mover in movers {
                if mover.isUp { up += 1 }
                else if mover.isDown { down += 1 }
            }
            moversUp = up
            moversDown = down
        } catch {
            // Silent — card falls back to the generic "See what's moving" CTA.
        }
    }
}

#Preview {
    NavigationStack {
        DashboardView(selectedTab: .constant(.dashboard), sessionViewModel: AppSessionViewModel())
    }
}
