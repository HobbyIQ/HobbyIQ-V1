//
//  NotificationManager.swift
//  HobbyIQ
//

import Combine
import Foundation
import UIKit
import UserNotifications

@MainActor
final class NotificationManager: NSObject, ObservableObject {
    enum RegistrationState: Equatable {
        case idle
        case requestingPermission
        case registering
        case registered
        case denied
        case failed(String)
    }

    static let shared = NotificationManager()

    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var registrationState: RegistrationState = .idle
    @Published private(set) var statusMessage: String?

    private var activeUserId: String = "demo"

    var statusText: String {
        switch registrationState {
        case .registered:
            return "Alerts enabled"
        case .denied:
            return "Alerts off"
        case .failed:
            return "Could not register device"
        case .requestingPermission, .registering:
            return "Registering device..."
        case .idle:
            switch authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                return "Alerts enabled"
            case .denied:
                return "Alerts off"
            case .notDetermined:
                return "Alerts off"
            @unknown default:
                return "Alerts off"
            }
        }
    }

    var canRequestPermission: Bool {
        authorizationStatus != .denied && registrationState != .registered
    }

    func refreshStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    func requestPermission(userId: String = "demo") async -> Bool {
        activeUserId = userId

        guard authorizationStatus != .denied else {
            registrationState = .denied
            statusMessage = "Alerts are off. Enable them in Settings to receive updates."
            return false
        }

        registrationState = .requestingPermission
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshStatus()

            guard granted else {
                registrationState = .denied
                statusMessage = "Alerts are off. You can turn them on later in Settings."
                return false
            }

            registrationState = .registering
            UIApplication.shared.registerForRemoteNotifications()
            statusMessage = "Registering device..."
            return true
        } catch {
            await refreshStatus()
            registrationState = .failed(error.localizedDescription)
            statusMessage = "Could not register device."
            return false
        }
    }

    func handleDidRegisterForRemoteNotifications(deviceToken: Data) async {
        let token = Self.hexString(from: deviceToken)
        await registerDeviceToken(token: token)
    }

    func handleDidFailToRegisterForRemoteNotifications(error: Error) {
        registrationState = .failed(error.localizedDescription)
        statusMessage = "Could not register device."
    }

    private func registerDeviceToken(token: String) async {
        do {
            let request = DeviceTokenRegisterRequest(
                userId: activeUserId,
                platform: "ios",
                token: token,
                environment: APIConfig.environment.notificationEnvironment.rawValue
            )
            _ = try await APIService.shared.registerDeviceToken(request)
            registrationState = .registered
            statusMessage = "Alerts enabled"
        } catch {
            registrationState = .failed(error.localizedDescription)
            statusMessage = "Could not register device."
        }
    }

    private static func hexString(from data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor
final class NotificationSettingsViewModel: ObservableObject {
    @Published var preferences = NotificationPreferences.demo()
    @Published private(set) var isLoading = false
    @Published private(set) var isSaving = false
    @Published var statusMessage: String?
    @Published var errorMessage: String?

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            preferences = try await APIService.shared.fetchNotificationPreferences(userId: preferences.userId)
            await NotificationManager.shared.refreshStatus()
        } catch {
            errorMessage = "Could not load alert settings."
        }
    }

    func requestPermission() async {
        statusMessage = nil
        errorMessage = nil

        let granted = await NotificationManager.shared.requestPermission(userId: preferences.userId)
        if granted {
            statusMessage = "Alerts enabled"
        } else {
            if NotificationManager.shared.authorizationStatus == .denied {
                statusMessage = "Alerts off"
            } else {
                statusMessage = "Could not register device"
            }
        }
    }

    func savePreferences() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            preferences = try await APIService.shared.updateNotificationPreferences(preferences)
            statusMessage = "Alert settings saved."
        } catch {
            errorMessage = "Could not save alert settings."
        }
    }

    func sendTestAlert() async {
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let response = try await APIService.shared.sendTestNotification(
                userId: preferences.userId,
                title: "HobbyIQ Test",
                body: "Notifications are connected."
            )
            statusMessage = response.message
        } catch {
            errorMessage = "Could not send test alert."
        }
    }
}
