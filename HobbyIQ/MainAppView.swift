//
//  MainAppView.swift
//  HobbyIQ
//

import SwiftUI

struct MainAppView: View {
    @StateObject private var authService = AuthService.shared
    @StateObject private var dailyIQService = DailyIQService.shared
    @StateObject private var sessionViewModel = AppSessionViewModel()
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Group {
            if authService.isLoggedIn, let session = authService.session {
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
    }
}

private struct AppTabShellView: View {
    let session: AuthSession
    @ObservedObject var dailyIQService: DailyIQService
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @EnvironmentObject private var appState: AppState

    @State private var selectedTab: MainTab = .dashboard
    /// Tracks which tabs have been visited so we can defer creation of
    /// off-screen tabs and avoid unnecessary API calls at launch.
    @State private var visitedTabs: Set<MainTab> = [.dashboard]
    @StateObject private var portfolioVM = PortfolioIQViewModel()
    @State private var isKeyboardVisible = false

    var body: some View {
        ZStack {
            HobbyIQBackground()

            tabContent
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if !isKeyboardVisible {
                        LegacyTabBar(selectedTab: $selectedTab)
                            .padding(.top, 8)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .padding(.bottom, 2)
                .animation(.easeInOut(duration: 0.25), value: isKeyboardVisible)
        }
        .preferredColorScheme(.dark)
        .task(id: session.id) {
            selectedTab = .dashboard
            applyPendingOAuthCallbackIfNeeded()
            await sessionViewModel.checkSessionOnLaunch()
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
    }

    private var tabContent: some View {
        ZStack {
            NavigationStack {
                DashboardView(selectedTab: $selectedTab, sessionViewModel: sessionViewModel)
            }
            .opacity(selectedTab == .dashboard ? 1 : 0)
            .allowsHitTesting(selectedTab == .dashboard)

            if visitedTabs.contains(.daily) {
                DailyIQView(userId: session.userId, service: dailyIQService)
                    .opacity(selectedTab == .daily ? 1 : 0)
                    .allowsHitTesting(selectedTab == .daily)
            }

            if visitedTabs.contains(.comp) {
                NavigationStack {
                    CompIQView()
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

    private let tabs: [MainTab] = [.dashboard, .daily, .inventory, .portfolio]

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
                    .font(.system(size: 17, weight: isSelected ? .bold : .medium))
                    .symbolRenderingMode(.hierarchical)
                Text(tab.title)
                    .font(.system(size: 10, weight: isSelected ? .bold : .medium))
                    .lineLimit(1)
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
