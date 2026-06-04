//
//  EbayConnectView.swift
//  HobbyIQ
//

import SwiftUI

struct EbayConnectView: View {
    @ObservedObject private var ebayStore = EBayOAuthCoordinator.shared
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var showUpgradePaywall = false
    @State private var isReconnecting = false
    @State private var reconnectError: String?

    var body: some View {
        VStack(spacing: 10) {
            connectionStatus

            Button {
                ebayStore.startConnect()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Connect eBay")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        Text("Sign in to link eBay to your HobbyIQ account.")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }
                    Spacer()

                    if ebayStore.isConnecting {
                        ProgressView()
                            .tint(HobbyIQTheme.Colors.electricBlue)
                    }
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .disabled(ebayStore.isConnecting || isReconnecting)

            if ebayStore.connectionState == .connected {
                Button {
                    Task { await reconnectEbay() }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Reconnect eBay")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            Text("Disconnect and start a fresh OAuth link.")
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.textSecondary)
                        }
                        Spacer()

                        if isReconnecting {
                            ProgressView()
                                .tint(HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
                .disabled(isReconnecting || ebayStore.isConnecting)
            }

            Button {
                Task { await ebayStore.resetConnection() }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sign Out of eBay")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(.red)
                        Text("Clears the linked eBay account so it behaves like you are not signed in.")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }
                    Spacer()

                    if ebayStore.isRefreshing {
                        ProgressView()
                            .tint(HobbyIQTheme.Colors.electricBlue)
                    }
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .disabled(ebayStore.isConnecting || isReconnecting)

            if let reconnectError {
                Text(reconnectError)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
        }
        .task {
            await ebayStore.refreshConnectionStatus()
        }
        .lockedOverlay(
            feature: GatedFeature.ebayIntegration,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.ebayIntegration)
            )
        }
    }

    private func reconnectEbay() async {
        isReconnecting = true
        reconnectError = nil
        defer { isReconnecting = false }

        do {
            let response = try await APIService.shared.ebayReconnect()
            if let authUrl = response.authUrl, let url = URL(string: authUrl) {
                await MainActor.run {
                    UIApplication.shared.open(url)
                }
            } else {
                await ebayStore.refreshConnectionStatus()
            }
        } catch {
            reconnectError = error.localizedDescription
        }
    }

    private var connectionStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("eBay Connection")
                .font(.headline)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(ebayStore.connectedUser ?? "Not connected")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(ebayStore.connectionState == .connected ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(ebayStore.statusMessage ?? "Sign in to connect eBay.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
