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

    // Scope 3 (2026-07-12): eBay purchase-history sync surface.
    @State private var syncDays: Int = 30
    @State private var isSyncingPurchases = false
    @State private var lastImportSummary: EbayImportSummary?
    @State private var showImportSummary = false
    @State private var importError: String?

    private static let syncDayOptions: [Int] = [30, 60, 90]

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
                syncPurchasesBlock

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
        .sheet(isPresented: $showImportSummary) {
            if let summary = lastImportSummary {
                EbayPurchaseImportSummarySheet(summary: summary)
            }
        }
    }

    // MARK: eBay purchase sync (Scope 3)

    private var syncPurchasesBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sync eBay Purchases")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("Pull your recent orders into HobbyIQ so cost basis and cash flow are tracked automatically.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }

            HStack(spacing: 8) {
                Picker("Days", selection: $syncDays) {
                    ForEach(Self.syncDayOptions, id: \.self) { d in
                        Text("Last \(d) days").tag(d)
                    }
                }
                .pickerStyle(.menu)
                .tint(HobbyIQTheme.Colors.electricBlue)
                .disabled(isSyncingPurchases)

                Spacer()

                Button {
                    Task { await syncEbayPurchases() }
                } label: {
                    HStack(spacing: 6) {
                        if isSyncingPurchases {
                            ProgressView().tint(HobbyIQTheme.Colors.pureWhite).controlSize(.small)
                        } else {
                            Image(systemName: "arrow.down.circle.fill")
                                .font(.subheadline.weight(.semibold))
                        }
                        Text(isSyncingPurchases ? "Fetching…" : "Sync now")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isSyncingPurchases)
                .accessibilityLabel(isSyncingPurchases ? "Syncing eBay purchases" : "Sync eBay purchases")
            }

            if let importError {
                Text(importError)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
        }
        .padding(.vertical, 4)
    }

    private func syncEbayPurchases() async {
        isSyncingPurchases = true
        importError = nil
        defer { isSyncingPurchases = false }
        do {
            let summary = try await APIService.shared.importEbayPurchases(days: syncDays)
            // Backend returns 200 with `{success:false, error:"…"}` on bad days.
            if summary.success == false, let err = summary.error {
                importError = err
                return
            }
            lastImportSummary = summary
            showImportSummary = true
            NotificationCenter.default.post(name: .portfolioPurchaseRecorded, object: nil)
        } catch {
            importError = APIService.errorMessage(from: error)
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

// MARK: - eBay Purchase Import Summary Sheet

/// Modal presented after `POST /erp/purchases/import/ebay` returns. Shows
/// the same counters the API returns (fetched / imported / replayHits /
/// skipped / errors) plus the totalCost. Follows the same theme as the
/// Financials hub — HobbyIQBackground, cardNavy metric cards, dashboard
/// stroke on the summary card.
struct EbayPurchaseImportSummarySheet: View {
    let summary: EbayImportSummary
    @Environment(\.dismiss) private var dismiss

    private var imported: Int { summary.imported ?? 0 }
    private var replayHits: Int { summary.replayHits ?? 0 }
    private var fetched: Int { summary.fetched ?? 0 }
    private var skipped: Int { summary.skipped ?? 0 }
    private var errors: Int { summary.errors ?? 0 }
    private var totalCost: Double { summary.totalCost ?? 0 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    headline
                    metricsCard
                    if errors > 0 {
                        errorHint
                    }
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, 16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Purchases Synced")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(headlineText)
                .font(.title2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(subheadlineText)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headlineText: String {
        if imported == 0 && replayHits == 0 {
            return "Nothing new to sync"
        }
        if imported == 0 {
            return "You’re all caught up"
        }
        return "Imported \(imported) new purchase\(imported == 1 ? "" : "s")"
    }

    private var subheadlineText: String {
        var parts: [String] = []
        if imported > 0 {
            parts.append("totaling \(totalCost.portfolioCurrencyText)")
        }
        if replayHits > 0 {
            parts.append("\(replayHits) already synced")
        }
        if skipped > 0 {
            parts.append("\(skipped) skipped")
        }
        if parts.isEmpty {
            return "eBay returned \(fetched) order\(fetched == 1 ? "" : "s") — none matched a card purchase."
        }
        return parts.joined(separator: " · ")
    }

    private var metricsCard: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                metricCell(label: "New", value: "\(imported)", color: HobbyIQTheme.Colors.successGreen)
                divider
                metricCell(label: "Fetched", value: "\(fetched)")
                divider
                metricCell(label: "Already synced", value: "\(replayHits)")
            }
            if skipped > 0 || errors > 0 {
                Divider().overlay(Color.white.opacity(0.08))
                HStack(spacing: 12) {
                    if skipped > 0 { metricCell(label: "Skipped", value: "\(skipped)") }
                    if errors > 0 { metricCell(label: "Errors", value: "\(errors)", color: HobbyIQTheme.Colors.warning) }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func metricCell(label: String, value: String, color: Color = HobbyIQTheme.Colors.pureWhite) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title3.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.08))
            .frame(width: 1, height: 32)
    }

    private var errorHint: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text("Some orders couldn’t be imported")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("Try again — transient eBay API errors usually clear on the next sync.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}
