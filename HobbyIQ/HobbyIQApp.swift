//
//  HobbyIQApp.swift
//  HobbyIQ
//
//  Created by Drew Vabulas on 4/12/26.
//

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
        }
    }
}
