//
//  EbayConnectView.swift
//  HobbyIQ
//

import SwiftUI

struct EbayConnectView: View {
    @ObservedObject private var ebayStore = EBayOAuthCoordinator.shared

    var body: some View {
        VStack(spacing: 10) {
            connectionStatus

            Button {
                ebayStore.startConnect()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ebayStore.connectionState == .connected ? "Reconnect eBay" : "Connect eBay")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        Text(ebayStore.connectionState == .connected ? "Switch or refresh the linked eBay account." : "Sign in to link eBay to your HobbyIQ account.")
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
            .disabled(ebayStore.isConnecting)

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
            .disabled(ebayStore.isConnecting)
        }
        .task {
            await ebayStore.refreshConnectionStatus()
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
