//
//  AppRootView.swift
//  HobbyIQ
//

import SwiftUI

struct AppRootView: View {
    @StateObject private var sessionViewModel = AppSessionViewModel()

    var body: some View {
        Group {
            switch sessionViewModel.launchState {
            case .launching:
                LaunchView()
            case .signedOut:
                LoginView(sessionViewModel: sessionViewModel)
            case .paywall:
                PaywallView(sessionViewModel: sessionViewModel)
            case .ready:
                MainTabView()
            case .error(let message):
                ErrorStateView(title: "App unavailable", message: message, retryTitle: "Reload") {
                    Task { await sessionViewModel.checkSessionOnLaunch() }
                }
                .padding(20)
                .background(HobbyIQTheme.bg.ignoresSafeArea())
            }
        }
        .preferredColorScheme(.dark)
        .background(HobbyIQTheme.bg)
        .task {
            await sessionViewModel.checkSessionOnLaunch()
        }
    }
}

#Preview {
    AppRootView()
}
