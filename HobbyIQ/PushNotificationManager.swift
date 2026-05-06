//
//  PushNotificationManager.swift
//  HobbyIQ
//

import Foundation
import UserNotifications

@MainActor
final class PushNotificationManager: NSObject, ObservableObject {
    static let shared = PushNotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined

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
}

extension PushNotificationManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }
}

@MainActor
final class NotificationPermissionViewModel: ObservableObject {
    @Published private(set) var status: UNAuthorizationStatus = .notDetermined

    private let manager: PushNotificationManager

    init(manager: PushNotificationManager = .shared) {
        self.manager = manager
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
