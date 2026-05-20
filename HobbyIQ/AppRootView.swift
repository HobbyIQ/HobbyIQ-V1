//
//  AppRootView.swift
//  HobbyIQ
//

import SwiftUI

struct AppRootView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var sessionViewModel = AppSessionViewModel()

    var body: some View {
        Group {
            switch sessionViewModel.launchState {
            case .launching:
                LaunchView(sessionViewModel: sessionViewModel)
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
                .background(HobbyIQBackground())
            }
        }
        .task {
            await sessionViewModel.checkSessionOnLaunch()
        }
        .onOpenURL { url in
            _ = appState.handleIncomingURL(url)
        }
    }
}

#Preview {
    AppRootView()
        .environmentObject(AppState())
}
