//
//  NotificationSettingsView.swift
//  HobbyIQ
//

import SwiftUI

struct NotificationSettingsView: View {
    @StateObject var viewModel = NotificationSettingsViewModel()
    @StateObject private var notificationManager = NotificationManager.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Alerts")
                .font(.headline)
                .foregroundStyle(.white)

            VStack(alignment: .leading, spacing: 10) {
                Text(notificationManager.statusText)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(notificationManager.statusText == "Alerts enabled" ? HobbyIQTheme.green : HobbyIQTheme.textSecondary)

                if let statusMessage = viewModel.statusMessage {
                    Text(statusMessage)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }

                if let errorMessage = viewModel.errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            .padding(12)
            .background(HobbyIQTheme.bgSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

            if notificationManager.canRequestPermission {
                Button {
                    Task { await viewModel.requestPermission() }
                } label: {
                    HStack {
                        Text(notificationManager.authorizationStatus == .notDetermined ? "Enable Notifications" : "Retry Device Registration")
                            .font(.subheadline.weight(.bold))
                        Spacer()
                        Image(systemName: "bell.badge.fill")
                    }
                    .foregroundStyle(HobbyIQTheme.bg)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(HobbyIQTheme.green)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
            }

            ToggleSettingsRow(title: "SellIQ Alerts", isOn: binding(\.sellIQAlerts))
            ToggleSettingsRow(title: "ROI +50% Alerts", isOn: binding(\.roi50Alerts))
            ToggleSettingsRow(title: "ROI +100% Alerts", isOn: binding(\.roi100Alerts))
            ToggleSettingsRow(title: "DailyIQ Brief", isOn: binding(\.dailyIQAlerts))

            SettingsRow(title: "DailyIQ time", value: viewModel.preferences.dailyIQTimeDisplay) {}

            Button {
                Task { await viewModel.sendTestAlert() }
            } label: {
                HStack {
                    Text("Send Test Alert")
                        .font(.subheadline.weight(.bold))
                    Spacer()
                    if viewModel.isSaving {
                        ProgressView()
                            .tint(HobbyIQTheme.green)
                    }
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(HobbyIQTheme.bgSecondary)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(HobbyIQTheme.stroke, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .onAppear {
            Task {
                await viewModel.load()
            }
        }
    }

    private func binding(_ keyPath: WritableKeyPath<NotificationPreferences, Bool>) -> Binding<Bool> {
        Binding(
            get: {
                viewModel.preferences[keyPath: keyPath]
            },
            set: { newValue in
                var updated = viewModel.preferences
                updated[keyPath: keyPath] = newValue
                viewModel.preferences = updated
                Task {
                    await viewModel.savePreferences()
                }
            }
        )
    }
}
