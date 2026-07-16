//
//  EbayListingManageView.swift
//  HobbyIQ
//

import SwiftUI

struct EbayListingManageView: View {
    let offerId: String
    let card: InventoryCard
    @ObservedObject var viewModel: PortfolioIQViewModel

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var ebayStore = EBayOAuthCoordinator.shared
    @State private var statusResponse: EbayListingStatusResponse?
    @State private var isLoadingStatus = false
    @State private var isEnding = false
    @State private var isRevising = false
    @State private var showEndConfirmation = false
    @State private var showReviseSheet = false
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    cardHeader

                    if isLoadingStatus {
                        ProgressView("Loading listing status…")
                            .tint(HobbyIQTheme.Colors.electricBlue)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 32)
                    } else if let status = statusResponse {
                        statusCard(status)
                    }

                    if let localError {
                        Text(localError)
                            .font(.footnote)
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                            .padding(.horizontal, 4)
                    }

                    actionButtons
                }
                .padding(16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Listing Details")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(AppColors.textSecondary)
                }
            }
        }
        .task { await loadStatus() }
        .alert("End Listing?", isPresented: $showEndConfirmation) {
            Button("End Listing", role: .destructive) {
                Task { await endListing() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will remove the listing from eBay. This action cannot be undone.")
        }
        .sheet(isPresented: $showReviseSheet) {
            EbayListingDraftView(viewModel: viewModel, card: card) { _ in
                showReviseSheet = false
                Task { await loadStatus() }
            }
        }
    }

    private var cardHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(card.playerName)
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
            Text(card.cardName)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
            Text("Offer ID: \(offerId)")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(hex: 0x141821))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func statusCard(_ status: EbayListingStatusResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Listing Status")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            statusRow("Status", value: status.status?.capitalized ?? "Unknown")
            statusRow("Listing ID", value: status.listingId ?? "—")
            if let price = status.price {
                statusRow("Price", value: price.currencyString)
            }
            if let qty = status.quantity {
                statusRow("Quantity", value: "\(qty)")
            }
            if let url = status.listingUrl, let link = URL(string: url) {
                Link(destination: link) {
                    HStack {
                        Text("View on eBay")
                            .font(.caption.weight(.semibold))
                        Image(systemName: "arrow.up.right.square")
                            .font(.caption)
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .padding(.top, 4)
            }
        }
        .padding(14)
        .background(Color(hex: 0x141821))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func statusRow(_ title: String, value: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .frame(width: 92, alignment: .leading)
            Text(value)
                .font(.caption)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
        }
    }

    private var actionButtons: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    Task { await loadStatus() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.clockwise")
                        Text(isLoadingStatus ? "Refreshing…" : "Refresh")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isLoadingStatus)

                Button {
                    showReviseSheet = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "pencil")
                        Text("Revise")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isRevising || isEnding)
            }

            Button {
                showEndConfirmation = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isEnding ? "hourglass" : "xmark.circle")
                    Text(isEnding ? "Ending…" : "End Listing")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(HobbyIQTheme.Colors.danger)
                .background(HobbyIQTheme.Colors.danger.opacity(0.1))
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.danger.opacity(0.3), lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isEnding || isLoadingStatus)
        }
    }

    private func loadStatus() async {
        isLoadingStatus = true
        localError = nil
        defer { isLoadingStatus = false }

        do {
            statusResponse = try await APIService.shared.ebayListingStatus(offerId: offerId)
        } catch {
            localError = error.localizedDescription
        }
    }

    private func endListing() async {
        isEnding = true
        localError = nil
        defer { isEnding = false }

        do {
            _ = try await APIService.shared.ebayEndListing(offerId: offerId)
            await loadStatus()
        } catch {
            localError = error.localizedDescription
        }
    }
}
