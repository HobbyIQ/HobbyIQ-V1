//
//  AppRootView.swift
//  HobbyIQ
//

import SwiftUI

struct AppRootView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var sessionViewModel = AppSessionViewModel()
    /// CF-BACK-NAV-FIX (2026-07-06): once launchState reaches `.ready`
    /// for the first time, latch it so transient re-evaluations of
    /// `launchState` (paywall flicker, entitlement refresh gaps, etc.)
    /// can't destroy MainTabView. Without this latch, any brief
    /// non-`.ready` state — even one that flips back immediately —
    /// tore down the whole tab shell, resetting `selectedTab` to its
    /// default (`.dashboard`) and making the user believe "back went
    /// to Dashboard". Only explicit `.signedOut` un-latches, per the
    /// user's mental model of "I'm signed in until I sign out."
    @State private var hasReachedReady = false

    var body: some View {
        Group {
            if hasReachedReady, sessionViewModel.launchState != .signedOut {
                MainTabView()
            } else {
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
        }
        .task {
            await sessionViewModel.checkSessionOnLaunch()
        }
        .onChange(of: sessionViewModel.launchState) { _, newState in
            if case .ready = newState {
                hasReachedReady = true
            }
            if case .signedOut = newState {
                hasReachedReady = false
            }
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
