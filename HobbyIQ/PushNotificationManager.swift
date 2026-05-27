//
//  PushNotificationManager.swift
//  HobbyIQ
//

import Combine
import Foundation
import UIKit
import UserNotifications

@MainActor
final class PushNotificationManager: NSObject, ObservableObject {
    static let shared = PushNotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var deviceToken: String?

    private let tokenKey = "hobbyiq.push.deviceToken"

    override init() {
        super.init()
        deviceToken = UserDefaults.standard.string(forKey: tokenKey)
    }

    func refreshStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    func requestPermission() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshStatus()
            return granted
        } catch {
            await refreshStatus()
            return false
        }
    }

    /// Request permission, then register for remote notifications to get a device token.
    func requestPermissionAndRegister() async {
        let granted = await requestPermission()
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Called from AppDelegate when APNs returns the device token.
    func didRegisterForRemoteNotifications(deviceToken tokenData: Data) {
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        self.deviceToken = hex
        UserDefaults.standard.set(hex, forKey: tokenKey)
        Task { await registerTokenWithBackend(hex) }
    }

    /// Called from AppDelegate when APNs registration fails.
    func didFailToRegisterForRemoteNotifications(error: Error) {
        #if DEBUG
        print("[Push] Failed to register for remote notifications: \(error.localizedDescription)")
        #endif
    }

    /// Register the current device token with the backend.
    func registerTokenWithBackend(_ token: String? = nil) async {
        guard let resolvedToken = token ?? deviceToken else { return }
        do {
            _ = try await APIService.shared.registerDeviceToken(resolvedToken)
            #if DEBUG
            print("[Push] Registered device token with backend")
            #endif
        } catch {
            #if DEBUG
            print("[Push] Failed to register device token: \(error.localizedDescription)")
            #endif
        }
    }

    /// Unregister the current device token from the backend. Call on sign-out.
    func unregisterTokenFromBackend() async {
        guard let token = deviceToken else { return }
        do {
            _ = try await APIService.shared.unregisterDeviceToken(token)
            #if DEBUG
            print("[Push] Unregistered device token from backend")
            #endif
        } catch {
            #if DEBUG
            print("[Push] Failed to unregister device token: \(error.localizedDescription)")
            #endif
        }
    }
}

extension PushNotificationManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo: [AnyHashable: Any] = response.notification.request.content.userInfo
        nonisolated(unsafe) let sendableInfo = userInfo
        await MainActor.run {
            guard let appState = AppState.shared else { return }
            NotificationRouter.route(userInfo: sendableInfo, appState: appState)
        }
    }
}

@MainActor
final class NotificationPermissionViewModel: ObservableObject {
    @Published private(set) var status: UNAuthorizationStatus = .notDetermined

    private let manager: PushNotificationManager

    init(manager: PushNotificationManager? = nil) {
        self.manager = manager ?? PushNotificationManager.shared
    }

    func load() async {
        await manager.refreshStatus()
        status = manager.authorizationStatus
    }

    func request() async {
        _ = await manager.requestPermission()
        status = manager.authorizationStatus
    }
}

enum NotificationRouter {
    static func route(userInfo: [AnyHashable: Any], appState: AppState) {
        let pushType = userInfo["type"] as? String

        switch pushType {
        case "dailyiq.top_performer":
            // Deep link to DailyIQ — switch to the daily tab
            if let playerName = userInfo["playerName"] as? String {
                appState.route(to: .player(playerName))
            }
        case "price.alert":
            if let cardId = userInfo["cardId"] as? String {
                appState.route(to: .card(cardId))
            }
        case "portfolio.movement":
            if let cardId = userInfo["cardId"] as? String {
                appState.route(to: .card(cardId))
            }
        default:
            // Fall back to legacy "target" key routing
            guard let target = userInfo["target"] as? String else { return }
            switch target {
            case "alert":
                if let idString = userInfo["id"] as? String, let id = UUID(uuidString: idString) {
                    appState.route(to: .alert(id))
                }
            case "portfolio":
                if let idString = userInfo["id"] as? String, let id = UUID(uuidString: idString) {
                    appState.route(to: .portfolio(id))
                }
            case "player":
                if let query = userInfo["query"] as? String {
                    appState.route(to: .player(query))
                }
            case "card":
                if let query = userInfo["query"] as? String {
                    appState.route(to: .card(query))
                }
            default:
                break
            }
        }
    }
}
