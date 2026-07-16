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
    /// P0.7 delta (2026-07-16, backend PR #501): last hex token successfully
    /// PATCHed to `/api/portfolio/preferences`. Guards against re-sending
    /// the same token every launch — spec explicitly says diff before write.
    private let lastPreferencesTokenKey = "hobbyiq.push.lastPreferencesToken"
    /// P0.7 delta (2026-07-16): last observed system authorization status.
    /// Used to detect a revoke transition (authorized → denied) on scene
    /// activation so we can fire the null PATCH exactly once.
    private let lastAuthStatusKey = "hobbyiq.push.lastAuthStatus"

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

    /// P1 (2026-07-16, iOS delta): ask for push permission on first
    /// meaningful use of the app — opening a holding detail sheet, or
    /// checking DailyIQ. Per Apple HIG, ask when the affordance is
    /// clearly connected to the value the user is about to receive.
    ///
    /// Guards: only fires when the OS status is `.notDetermined` (never
    /// re-asked once granted or denied — declined users defer to the
    /// Settings toggle affordance for a second chance). Also gated by a
    /// UserDefaults flag so a rapid re-open doesn't hit the same code
    /// path twice before iOS reflects the status change.
    func askIfFirstMeaningfulUse() async {
        let firstAskShownKey = "hobbyiq.push.firstAskShown"
        if UserDefaults.standard.bool(forKey: firstAskShownKey) { return }
        await refreshStatus()
        guard authorizationStatus == .notDetermined else {
            UserDefaults.standard.set(true, forKey: firstAskShownKey)
            return
        }
        UserDefaults.standard.set(true, forKey: firstAskShownKey)
        await requestPermissionAndRegister()
    }

    /// Called from AppDelegate when APNs returns the device token.
    func didRegisterForRemoteNotifications(deviceToken tokenData: Data) {
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        self.deviceToken = hex
        UserDefaults.standard.set(hex, forKey: tokenKey)
        Task {
            await registerTokenWithBackend(hex)
            // P0.7 delta (2026-07-16, backend PR #501): also write the token
            // to the portfolio-preferences doc so the flip fan-out worker
            // can target this device. Diff-gated inside the method.
            await registerTokenWithPortfolioPreferences(hex)
        }
    }

    /// P0.7 delta (2026-07-16, backend PR #501): PATCH the APNs token to
    /// `/api/portfolio/preferences`. Diff-gated per the spec's "do not
    /// retry on every launch if the server already has the same token"
    /// rule — compares against a locally-cached copy of the last
    /// successfully-registered token.
    func registerTokenWithPortfolioPreferences(_ token: String) async {
        let lastRegistered = UserDefaults.standard.string(forKey: lastPreferencesTokenKey)
        guard token != lastRegistered else { return }
        do {
            _ = try await APIService.shared.registerAPNsToken(token)
            UserDefaults.standard.set(token, forKey: lastPreferencesTokenKey)
        } catch {
            #if DEBUG
            print("[Push] Failed to PATCH APNs token to preferences: \(error.localizedDescription)")
            #endif
        }
    }

    /// P0.7 delta (2026-07-16, backend PR #501): PATCH `apnsDeviceToken: null`
    /// so the backend stops targeting a stale device. Called on iOS-side
    /// permission revoke and on sign-out. Clears the local
    /// `lastPreferencesTokenKey` so a re-grant re-PATCHes fresh.
    func unregisterTokenFromPortfolioPreferences() async {
        do {
            _ = try await APIService.shared.unregisterAPNsToken()
            UserDefaults.standard.removeObject(forKey: lastPreferencesTokenKey)
        } catch {
            #if DEBUG
            print("[Push] Failed to null APNs token in preferences: \(error.localizedDescription)")
            #endif
        }
    }

    /// P0.7 delta (2026-07-16): detect an authorization-status transition
    /// from `.authorized` → `.denied` and fire the null-token PATCH exactly
    /// once. Callers hook this into a scene-active lifecycle event so a
    /// user revoking notifications in iOS Settings pushes the state up
    /// to the backend on next foreground.
    func syncAuthorizationStatusOnForeground() async {
        await refreshStatus()
        let previousRaw = UserDefaults.standard.integer(forKey: lastAuthStatusKey)
        let previous = UNAuthorizationStatus(rawValue: previousRaw)
        UserDefaults.standard.set(authorizationStatus.rawValue, forKey: lastAuthStatusKey)

        // Only fire when we KNOW the user has revoked — first launch has
        // previous == nil which we treat as "no signal".
        if previous == .authorized, authorizationStatus == .denied {
            await unregisterTokenFromPortfolioPreferences()
        }
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
        // P0.7 delta (2026-07-16): also clear the token on the portfolio-
        // preferences doc so the flip fan-out worker doesn't target this
        // device after sign-out.
        await unregisterTokenFromPortfolioPreferences()
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
        case "verdict.flip":
            // P0.7 (2026-07-16, verdict-history-flip-surfaces.md): major
            // flip push deep-link. Backend fan-out worker (out of scope for
            // this PR) emits `{ type: "verdict.flip", cardId, playerName }`
            // when a portfolio's player crosses the bull/bear boundary.
            // Prefer cardId (opens holding detail); fall back to playerName.
            if let cardId = userInfo["cardId"] as? String {
                appState.route(to: .card(cardId))
            } else if let playerName = userInfo["playerName"] as? String {
                appState.route(to: .player(playerName))
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
