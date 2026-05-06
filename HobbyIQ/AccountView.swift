//
//  AccountView.swift
//  HobbyIQ
//

import SwiftUI

struct AccountView: View {
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @StateObject private var viewModel = AccountViewModel()

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 16) {
                header
                AccountHeaderCard(info: viewModel.accountInfo(from: sessionViewModel))
                accountSection
                settingsSection
                appInfoSection
                testingSection
                sessionSection

                if let statusMessage = viewModel.statusMessage {
                    HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
                        Text(statusMessage)
                            .font(.subheadline)
                            .foregroundStyle(.white)
                    }
                    .onTapGesture {
                        viewModel.clearStatus()
                    }
                }
            }
            .padding(16)
            .padding(.bottom, 32)
        }
        .background(HobbyIQTheme.bg.ignoresSafeArea())
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Account")
                .font(.largeTitle.bold())
                .foregroundStyle(.white)
            Text("Profile, membership, settings, and support.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var accountSection: some View {
        SettingsSectionCard(title: "Account") {
            SettingsRow(title: "Profile", value: sessionViewModel.currentUser?.displayName) {}
            SettingsRow(title: "Email", value: sessionViewModel.currentUser?.email ?? "Not available") {}
            SettingsRow(title: "Membership / Plan", value: sessionViewModel.activeTier?.title ?? "No Access") {}
            SettingsRow(title: "Restore Purchases", value: nil) {
                Task { await viewModel.restorePurchases(using: sessionViewModel) }
            }
            SettingsRow(title: "Manage Subscription", value: nil) {
                viewModel.manageSubscription()
            }
        }
    }

    private var settingsSection: some View {
        SettingsSectionCard(title: "App Settings") {
            ToggleSettingsRow(title: "Notifications", isOn: $viewModel.settings.notificationsEnabled)
            ToggleSettingsRow(title: "Email Alerts", isOn: $viewModel.settings.emailAlertsEnabled)
            ToggleSettingsRow(title: "Market Alerts", isOn: $viewModel.settings.marketAlertsEnabled)
            ToggleSettingsRow(title: "Daily Brief Notifications", isOn: $viewModel.settings.dailyBriefEnabled)
            ToggleSettingsRow(title: "Haptics", isOn: $viewModel.settings.hapticsEnabled)
        }
    }

    private var appInfoSection: some View {
        SettingsSectionCard(title: "HobbyIQ Info") {
            SettingsRow(title: "App Version", value: viewModel.appVersionText) {}
            SettingsRow(title: "Build Number", value: viewModel.buildNumber) {}
            SettingsRow(title: "Privacy Policy", value: nil) {}
            SettingsRow(title: "Terms of Use", value: nil) {}
            SettingsRow(title: "Contact Support", value: nil) {
                viewModel.contactSupport()
            }
            SettingsRow(title: "Send Feedback", value: nil) {
                viewModel.sendFeedback()
            }
        }
    }

    private var testingSection: some View {
        SettingsSectionCard(title: "Testing & QA") {
            SettingsRow(title: "Environment", value: "Test / Mock") {}
            SettingsRow(title: "Auth State", value: sessionViewModel.isAuthenticated ? "Authenticated" : "Signed Out") {}
            SettingsRow(title: "Subscription State", value: sessionViewModel.activeTier?.title ?? "No Access") {}
            SettingsRow(title: "Mock Scenario", value: sessionViewModel.devScenario.rawValue.capitalized) {}
            SettingsRow(title: "Re-run Launch Check", value: nil) {
                Task { await sessionViewModel.checkSessionOnLaunch() }
            }
            SettingsRow(title: "Unlock Premium for Testing", value: nil) {
                sessionViewModel.unlockAccessForTesting()
            }
            SettingsRow(title: "Show Paywall for Testing", value: nil) {
                sessionViewModel.revokeAccessForTesting()
            }
        }
    }

    private var sessionSection: some View {
        SettingsSectionCard(title: "Session") {
            Button {
                Task { await sessionViewModel.signOut() }
            } label: {
                HStack {
                    Text("Sign Out")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.red)
                    Spacer()
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
        }
    }
}

#Preview {
    NavigationStack {
        AccountView(sessionViewModel: AppSessionViewModel())
    }
}
