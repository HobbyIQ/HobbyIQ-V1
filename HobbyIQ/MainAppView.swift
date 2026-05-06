//
//  MainAppView.swift
//  HobbyIQ
//

import SwiftUI

struct MainAppView: View {
    @StateObject private var authService = AuthService.shared
    @StateObject private var dailyIQService = DailyIQService.shared
    @StateObject private var sessionViewModel = AppSessionViewModel()

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

    @State private var homeSelectedTab: MainTab = .dashboard
    @State private var selectedTab: RootTab = .dashboard

    var body: some View {
        ZStack {
            HobbyIQBackground()

            TabView(selection: $selectedTab) {
                NavigationStack {
                    DashboardView(userId: session.userId, selectedTab: $homeSelectedTab)
                        .id("dashboard-\(session.id)")
                }
                .tabItem {
                    Image(systemName: "square.grid.2x2.fill")
                    Text("Dashboard")
                }
                .tag(RootTab.dashboard)

                NavigationStack {
                    DailyIQView(userId: session.userId, service: dailyIQService)
                        .id("daily-\(session.id)")
                }
                .tabItem {
                    Image(systemName: "brain.head.profile")
                    Text("DailyIQ")
                }
                .tag(RootTab.daily)

                NavigationStack {
                    CompIQView()
                        .id("compiq-\(session.id)")
                }
                .tabItem {
                    Image(systemName: "magnifyingglass")
                    Text("CompIQ")
                }
                .tag(RootTab.compiq)

                NavigationStack {
                    ProfitListView()
                        .id("portfolio-\(session.id)")
                }
                .tabItem {
                    Image(systemName: "chart.bar.xaxis")
                    Text("PortfolioIQ")
                }
                .tag(RootTab.portfolio)

                NavigationStack {
                    AccountView(sessionViewModel: sessionViewModel, showsCloseButton: false)
                        .id("account-\(session.id)")
                }
                .tabItem {
                    Image(systemName: "person.crop.circle")
                    Text("Account")
                }
                .tag(RootTab.account)
            }
            .tint(HobbyIQTheme.blue)
            .preferredColorScheme(.dark)
            .toolbarBackground(HobbyIQTheme.deepNavy, for: .tabBar, .navigationBar)
            .toolbarBackground(.visible, for: .tabBar, .navigationBar)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Rectangle()
                    .fill(HobbyIQTheme.neonBorder)
                    .frame(height: 1)
                    .shadow(color: HobbyIQTheme.blue.opacity(0.36), radius: 8, x: 0, y: 0)
                    .opacity(0.9)
            }
        }
        .task(id: session.id) {
            selectedTab = .dashboard
            homeSelectedTab = .dashboard
            await sessionViewModel.checkSessionOnLaunch()
            await dailyIQService.refreshAll(userId: session.userId)
        }
    }
}

private enum RootTab: Hashable {
    case dashboard
    case daily
    case compiq
    case portfolio
    case account
}

#Preview {
    MainAppView()
}
