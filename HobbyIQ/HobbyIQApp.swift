//
//  HobbyIQApp.swift
//  HobbyIQ
//
//  Created by Drew Vabulas on 4/12/26.
//

import SwiftData
import SwiftUI
import UserNotifications

final class HobbyIQAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = PushNotificationManager.shared
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushNotificationManager.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            PushNotificationManager.shared.didFailToRegisterForRemoteNotifications(error: error)
        }
    }
}

@main
struct HobbyIQApp: App {
    @UIApplicationDelegateAdaptor(HobbyIQAppDelegate.self) private var appDelegate
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        HobbyIQTheme.applyGlobalAppearance()
    }

    var body: some Scene {
        WindowGroup {
            HIQAppContainer {
                AppRootView()
            }
            .environmentObject(appState)
            .onAppear {
                AppState.shared = appState
            }
            // P0.7 delta (2026-07-16, backend PR #501): detect an APNs
            // permission revoke that happened while the app was
            // backgrounded, and PATCH `apnsDeviceToken: null` so the flip
            // fan-out worker stops targeting the stale device.
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    Task { await PushNotificationManager.shared.syncAuthorizationStatusOnForeground() }
                }
            }
        }
        .modelContainer(for: [CardItem.self, CardSaleRecord.self, SyncIntent.self])
    }
}
