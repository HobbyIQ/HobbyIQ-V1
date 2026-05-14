//  PriceAlertService.swift
//  HobbyIQ — APNs registration + REST client for /api/alerts.
//
//  Responsibilities:
//  - Request user permission for notifications and trigger APNs registration.
//  - Capture the device token (set by HobbyIQAppDelegate) and POST it to the
//    backend so fn-price-alert-checker can target this device.
//  - CRUD wrapper for /api/alerts: list / create / delete.
//
//  All requests carry the `x-session-id` header from UserDefaults
//  (key: "auth.sessionId"), matching the existing AuthManager contract.

import Foundation
import UIKit
import UserNotifications

@MainActor
final class PriceAlertService: NSObject, ObservableObject {

    static let shared = PriceAlertService()

    @Published private(set) var alerts: [PriceAlert] = []
    @Published private(set) var isLoading: Bool = false
    @Published var lastError: String?

    /// The hex-encoded APNs device token set by HobbyIQAppDelegate. Once we
    /// know the user is signed in we send it to the backend exactly once per
    /// (token, user) pair to avoid hammering Cosmos.
    @Published private(set) var deviceToken: String?
    private var lastRegisteredKey: String?

    private static let backendBase = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"
    private static let sessionKey  = "auth.sessionId"
    private static let tokenKey    = "device.pushToken"

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
        // Restore previously-captured push token so we can re-register against
        // a fresh session id without waiting for APNs to re-issue.
        if let saved = UserDefaults.standard.string(forKey: Self.tokenKey), !saved.isEmpty {
            self.deviceToken = saved
        }
    }

    // MARK: - Permission + registration

    /// Asks for notification permission (alert + badge + sound) and, if
    /// granted, kicks off APNs registration on the main queue. Safe to call
    /// repeatedly — UNUserNotificationCenter coalesces.
    func requestPermissionAndRegister() async {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Called by HobbyIQAppDelegate once APNs hands us a device token. We
    /// stash it locally and (if signed in) push it to the backend.
    func handleDeviceToken(_ tokenData: Data) {
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        self.deviceToken = hex
        UserDefaults.standard.set(hex, forKey: Self.tokenKey)
        Task { await registerDeviceTokenWithBackend() }
    }

    func registerDeviceTokenWithBackend() async {
        guard let token = deviceToken else { return }
        guard let sessionId = UserDefaults.standard.string(forKey: Self.sessionKey),
              !sessionId.isEmpty else {
            // Not signed in yet; we'll register after sign-in.
            return
        }
        let key = "\(token)::\(sessionId)"
        if key == lastRegisteredKey { return }

        let body = RegisterDeviceTokenRequest(
            token: token,
            platform: "ios",
            bundleId: Bundle.main.bundleIdentifier
        )

        do {
            var req = try makeRequest(path: "/api/devices/token", method: "POST")
            req.httpBody = try JSONEncoder().encode(body)
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                lastRegisteredKey = key
            }
        } catch {
            // Non-fatal — we'll retry on next launch / sign-in.
            lastError = error.localizedDescription
        }
    }

    /// Called from sign-out flow. Best-effort DELETE; clears the local
    /// registration cache so a future sign-in re-registers cleanly.
    func unregisterDeviceTokenFromBackend() async {
        defer { lastRegisteredKey = nil }
        guard let token = deviceToken else { return }
        guard let sessionId = UserDefaults.standard.string(forKey: Self.sessionKey),
              !sessionId.isEmpty else {
            return
        }
        _ = sessionId
        do {
            var req = try makeRequest(path: "/api/devices/token", method: "DELETE")
            let payload: [String: String] = ["token": token]
            req.httpBody = try JSONSerialization.data(withJSONObject: payload)
            _ = try await URLSession.shared.data(for: req)
        } catch {
            // Non-fatal.
        }
    }

    // MARK: - CRUD

    func loadAlerts() async {
        isLoading = true
        lastError = nil
        defer { isLoading = false }
        do {
            let req = try makeRequest(path: "/api/alerts", method: "GET")
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                lastError = "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1)"
                return
            }
            let decoded = try JSONDecoder().decode(PriceAlertResponse.self, from: data)
            // Preserve previous list on a non-success response (Known Bugs:
            // never wipe state before confirming new payload).
            if decoded.success, let list = decoded.alerts {
                self.alerts = list
            } else if let message = decoded.error {
                lastError = message
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    @discardableResult
    func createAlert(
        cardId: String,
        playerName: String,
        targetPrice: Double,
        direction: PriceAlertDirection,
        currentPrice: Double?,
        cardSnapshot: PriceAlertCardSnapshot? = nil
    ) async -> PriceAlert? {
        lastError = nil
        let body = CreatePriceAlertRequest(
            cardId: cardId,
            playerName: playerName,
            targetPrice: targetPrice,
            direction: direction,
            currentPrice: currentPrice,
            cardSnapshot: cardSnapshot
        )
        do {
            var req = try makeRequest(path: "/api/alerts", method: "POST")
            req.httpBody = try JSONEncoder().encode(body)
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                lastError = "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1)"
                return nil
            }
            let decoded = try JSONDecoder().decode(PriceAlertResponse.self, from: data)
            if decoded.success, let created = decoded.alert {
                alerts.insert(created, at: 0)
                return created
            }
            lastError = decoded.error ?? "Server returned no alert"
            return nil
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func deleteAlert(_ alertId: String) async {
        lastError = nil
        do {
            let req = try makeRequest(path: "/api/alerts/\(alertId)", method: "DELETE")
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                lastError = "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1)"
                return
            }
            alerts.removeAll { $0.alertId == alertId }
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Request builder

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        guard let url = URL(string: Self.backendBase + path) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let sid = UserDefaults.standard.string(forKey: Self.sessionKey), !sid.isEmpty {
            req.setValue(sid, forHTTPHeaderField: "x-session-id")
        }
        req.timeoutInterval = 20
        return req
    }
}

// MARK: - Foreground presentation

extension PriceAlertService: UNUserNotificationCenterDelegate {
    /// Show banners + play sound when the app is in foreground so the user
    /// notices a price-alert push without backgrounding.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}
