//
//  MainAppView.swift
//  HobbyIQ
//

import SwiftData
import SwiftUI

struct MainAppView: View {
    @StateObject private var authService = AuthService.shared
    @StateObject private var dailyIQService = DailyIQService.shared
    @StateObject private var sessionViewModel = AppSessionViewModel()
    @EnvironmentObject private var appState: AppState
    /// CF-BACK-NAV-FIX (2026-07-06): captures the most-recent valid
    /// `AuthSession` seen. If `authService.session` briefly flips to
    /// nil (transient re-init, notification bounce, etc.), we continue
    /// rendering `AppTabShellView` against the last-known session so
    /// SwiftUI doesn't swap the Group branch to `AuthView` and back —
    /// which would recreate the whole tab shell, resetting
    /// `selectedTab` to `.dashboard` and reading as "back went to
    /// dashboard". Cleared only on explicit sign-out (i.e. when
    /// `isLoggedIn` also flips false in `.onChange` below).
    @State private var lastKnownSession: AuthSession?

    var body: some View {
        Group {
            if let session = authService.session ?? lastKnownSession, authService.isLoggedIn || lastKnownSession != nil {
                AppTabShellView(
                    session: session,
                    dailyIQService: dailyIQService,
                    sessionViewModel: sessionViewModel
                )
                .id(session.id)
            } else {
                AuthView()
                    .preferredColorScheme(.dark)
            }
        }
        .onChange(of: authService.session) { _, newValue in
            if let newValue {
                lastKnownSession = newValue
            }
        }
        .onChange(of: authService.isLoggedIn) { _, newValue in
            if !newValue {
                // User explicitly signed out — release the latch.
                lastKnownSession = nil
            }
        }
        .onAppear {
            if let session = authService.session {
                lastKnownSession = session
            }
        }
    }
}

private struct AppTabShellView: View {
    let session: AuthSession
    @ObservedObject var dailyIQService: DailyIQService
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @EnvironmentObject private var appState: AppState
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase

    @State private var selectedTab: MainTab = .dashboard
    /// Tracks which tabs have been visited so we can defer creation of
    /// off-screen tabs and avoid unnecessary API calls at launch.
    @State private var visitedTabs: Set<MainTab> = [.dashboard]
    @StateObject private var portfolioVM = PortfolioIQViewModel()
    @State private var isKeyboardVisible = false
    @State private var syncService: PortfolioSyncService?

    /// Approximate height of `LegacyTabBar` including its inner padding
    /// + the outer `.padding(.top, 8)` and `.padding(.bottom, 2)`. Used
    /// as bottom padding on `tabContent` so pushed pages don't render
    /// underneath the overlay tab bar.
    private static let tabBarReserve: CGFloat = 76

    var body: some View {
        // CF-PERSISTENT-TAB-BAR (2026-07-04): the tab bar was applied as
        // a bottom safeAreaInset on `tabContent`, but iOS 17's
        // NavigationStack sometimes shadows the injected safe area when
        // it pushes a view with its own nav bar. Now rendered as an
        // overlay in the outer ZStack. Tab content reserves space via
        // bottom padding.
        // CF-NAV-STACK-STABILITY (2026-07-04): keep LegacyTabBar ALWAYS
        // in the ZStack (hide via opacity/offset instead of an `if`
        // branch). Adding/removing a sibling was causing the ZStack to
        // re-render `tabContent`, which reset every tab's
        // NavigationStack push state — back button appeared to jump
        // straight to the tab root (feeling like "goes to Home
        // Screen"). Fixed bottom padding keeps layout stable too.
        ZStack(alignment: .bottom) {
            HobbyIQBackground()

            // CF-KEYBOARD-GAP-FIX (2026-07-04): drop the tab-bar
            // reserve padding when the keyboard is up — otherwise a
            // 76pt blank strip shows between the last content and the
            // top of the keyboard's predictive-text bar. The tab bar
            // itself is already hidden via opacity/offset, so the
            // padding has no purpose while the keyboard covers the
            // bottom. Padding change is a modifier tweak (not a
            // sibling add/remove), so NavigationStack push state is
            // preserved.
            tabContent
                .padding(.bottom, isKeyboardVisible ? 0 : Self.tabBarReserve)

            LegacyTabBar(selectedTab: $selectedTab)
                .padding(.top, 8)
                .padding(.bottom, 2)
                .opacity(isKeyboardVisible ? 0 : 1)
                .offset(y: isKeyboardVisible ? Self.tabBarReserve : 0)
                .allowsHitTesting(!isKeyboardVisible)
        }
        .animation(.easeInOut(duration: 0.25), value: isKeyboardVisible)
        .preferredColorScheme(.dark)
        .environmentObject(sessionViewModel)
        .task(id: session.id) {
            // CF-BACK-NAV-FIX (2026-07-06): intentionally no
            // `selectedTab = .dashboard` reset here — if session.id
            // genuinely changes, `AppTabShellView` re-inits and
            // `@State selectedTab` already defaults to `.dashboard`
            // on the fresh instance. Resetting explicitly caused
            // spurious tab flips when SwiftUI re-fired the task.
            applyPendingOAuthCallbackIfNeeded()

            // Initialize sync service and trigger initial sync
            let service = PortfolioSyncService(
                modelContext: modelContext,
                apiService: .shared
            )
            syncService = service
            await service.onSignIn()
        }
        .onChange(of: selectedTab) { _, newTab in
            visitedTabs.insert(newTab)
        }
        .onChange(of: appState.pendingOAuthCallback?.id) { _, _ in
            applyPendingOAuthCallbackIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isKeyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isKeyboardVisible = false
        }
        .onReceive(NotificationCenter.default.publisher(for: .inventoryHoldingSaved)) { _ in
            // CardIdentifyView just persisted an identified card. Route the
            // user straight to Inventory and refresh the shared portfolio VM
            // so the new holding appears with its photo thumbnail.
            visitedTabs.insert(.inventory)
            selectedTab = .inventory
            Task { await portfolioVM.refresh() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .actionPlanRowTapped)) { _ in
            // PR #546 (2026-07-17): DailyIQ Action Plan row was tapped.
            // Switch to Inventory so the user can drill into the holding.
            visitedTabs.insert(.inventory)
            selectedTab = .inventory
        }
        .onChange(of: scenePhase) { _, newPhase in
            // Foreground recovery for entitlements. Resets the retry counter
            // and re-fetches, so a load that earlier exhausted its 1-2-4s
            // retry chain gets another chance once the app is active.
            if newPhase == .active {
                Task { await sessionViewModel.subscriptionManager.refreshEntitlementsFromForeground() }
            }
        }
    }

    private var tabContent: some View {
        ZStack {
            NavigationStack {
                DashboardView(selectedTab: $selectedTab, sessionViewModel: sessionViewModel)
            }
            .opacity(selectedTab == .dashboard ? 1 : 0)
            .allowsHitTesting(selectedTab == .dashboard)

            if visitedTabs.contains(.daily) {
                // CF-DAILYIQ-NAV-STACK (2026-07-02): wrap DailyIQ in its own
                // NavigationStack so any pushed drill-down (e.g. owned-cards
                // sheet routed as a push, future player detail) has a stack
                // to push into. Every other tab already gets this treatment;
                // DailyIQ was the lone exception and any push from it would
                // silently drop the pushed screen + tab bar.
                NavigationStack {
                    DailyIQView(userId: session.userId, service: dailyIQService)
                }
                .opacity(selectedTab == .daily ? 1 : 0)
                .allowsHitTesting(selectedTab == .daily)
            }

            if visitedTabs.contains(.comp) {
                NavigationStack {
                    // CF-COMPIQ-BACK-ROUTE (2026-07-02): CompIQ is a tab root
                    // reached from Dashboard's quick-access card, not from a
                    // push/modal. Wire the Back button to switch selectedTab
                    // back to Dashboard so it matches "back = previous
                    // screen" instead of no-op'ing dismiss() on the stack
                    // root (which was the crash the user hit).
                    CompIQView(onBack: { selectedTab = .dashboard })
                }
                .opacity(selectedTab == .comp ? 1 : 0)
                .allowsHitTesting(selectedTab == .comp)
            }

            if visitedTabs.contains(.player) {
                NavigationStack {
                    PlayerIQView()
                }
                .opacity(selectedTab == .player ? 1 : 0)
                .allowsHitTesting(selectedTab == .player)
            }

            if visitedTabs.contains(.inventory) {
                NavigationStack {
                    InventoryIQView(vm: portfolioVM)
                }
                .opacity(selectedTab == .inventory ? 1 : 0)
                .allowsHitTesting(selectedTab == .inventory)
            }

            if visitedTabs.contains(.portfolio) {
                NavigationStack {
                    PortfolioIQView(vm: portfolioVM) { filter in
                        portfolioVM.pendingInventoryFilter = filter
                        selectedTab = .inventory
                    }
                }
                .opacity(selectedTab == .portfolio ? 1 : 0)
                .allowsHitTesting(selectedTab == .portfolio)
            }

            if visitedTabs.contains(.erp) {
                NavigationStack {
                    ERPHubView()
                }
                .opacity(selectedTab == .erp ? 1 : 0)
                .allowsHitTesting(selectedTab == .erp)
            }
        }
    }

    private func applyPendingOAuthCallbackIfNeeded() {
        guard let callback = appState.pendingOAuthCallback else { return }
        guard callback.provider.lowercased() == "ebay" else { return }

        if callback.isEBayConnection {
            selectedTab = .portfolio
        }

        appState.consumeOAuthCallback()
    }
}

private struct LegacyTabBar: View {
    @Binding var selectedTab: MainTab

    private let tabs: [MainTab] = [.dashboard, .portfolio, .inventory, .daily, .erp]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(tabs) { tab in
                LegacyTabButton(tab: tab, isSelected: selectedTab == tab) {
                    selectedTab = tab
                }
            }
        }
        .padding(6)
        .background(
            HobbyIQTheme.Colors.cardNavy.opacity(0.96)
                .background(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(
                    LinearGradient(
                        colors: [
                            HobbyIQTheme.Colors.electricBlue.opacity(0.5),
                            HobbyIQTheme.Colors.hobbyGreen.opacity(0.3),
                            HobbyIQTheme.Colors.electricBlue.opacity(0.2)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1.5
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.12), radius: 20, x: 0, y: 8)
        .padding(.horizontal, 24)
        .padding(.bottom, 8)
    }
}

private struct LegacyTabButton: View {
    let tab: MainTab
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: isSelected ? tab.selectedSystemImage : tab.systemImage)
                    .font(.system(size: 17, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .frame(width: 22, height: 22)
                Text(tab.title)
                    .font(.system(size: 10, weight: .semibold))
                    .lineLimit(1)
                    .frame(height: 12)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .foregroundStyle(
                isSelected
                    ? HobbyIQTheme.Colors.electricBlue
                    : HobbyIQTheme.Colors.mutedText.opacity(0.7)
            )
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    MainAppView()
        .environmentObject(AppState())
}
