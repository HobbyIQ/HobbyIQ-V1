//
//  NotificationModels.swift
//  HobbyIQ
//

import Foundation

struct DeviceTokenRegisterRequest: Codable, Equatable {
    let userId: String
    let platform: String
    let token: String
    let environment: String
}

struct DeviceTokenRecord: Codable, Equatable, Identifiable {
    let id: String
    let userId: String
    let platform: String
    let token: String
    let environment: String
    let createdAt: String
    let updatedAt: String
}

struct NotificationRegisterResponse: Codable, Equatable {
    let deviceToken: DeviceTokenRecord
}

struct NotificationPreferences: Codable, Equatable {
    var userId: String
    var sellIQAlerts: Bool
    var roi50Alerts: Bool
    var roi100Alerts: Bool
    var dailyIQAlerts: Bool
    var dailyIQTime: String

    static func demo(userId: String = "demo") -> NotificationPreferences {
        NotificationPreferences(
            userId: userId,
            sellIQAlerts: true,
            roi50Alerts: true,
            roi100Alerts: true,
            dailyIQAlerts: true,
            dailyIQTime: "07:00"
        )
    }

    var dailyIQTimeDisplay: String {
        Self.displayTime(for: dailyIQTime)
    }

    private static func displayTime(for rawValue: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"

        guard let date = formatter.date(from: rawValue) else {
            return "7:00 AM"
        }

        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }
}

struct NotificationEvent: Codable, Equatable, Identifiable {
    let id: String
    let userId: String
    let type: String
    let title: String
    let body: String
    let data: [String: String]
    let status: String
    let createdAt: String
    let sentAt: String?
}

struct NotificationTestRequest: Codable, Equatable {
    let userId: String
    let title: String
    let body: String
}

struct NotificationTestResponse: Codable, Equatable {
    let event: NotificationEvent
    let deliveryMode: String
    let message: String
}

struct NotificationEnvironment: Codable, Equatable {
    let rawValue: String

    static let development = NotificationEnvironment(rawValue: "development")
    static let production = NotificationEnvironment(rawValue: "production")
}

extension APIConfig.AppEnvironment {
    var notificationEnvironment: NotificationEnvironment {
        switch self {
        case .production:
            return .production
        case .staging, .development:
            return .development
        }
    }
}
