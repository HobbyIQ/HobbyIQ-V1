//
//  PortfolioDetailPhotosCard.swift
//  HobbyIQ
//

import SwiftUI
import UIKit

struct PortfolioDetailPhotosCard: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let card: InventoryCard
    let onUpdated: () -> Void

    @State private var frontPhotoUrl: String?
    @State private var backPhotoUrl: String?
    @State private var localFrontImage: UIImage?
    @State private var localBackImage: UIImage?
    @State private var showingFrontPhotoSources = false
    @State private var showingBackPhotoSources = false
    @State private var frontPhotoRequest: CardPhotoPickerRequest?
    @State private var backPhotoRequest: CardPhotoPickerRequest?
    @State private var localError: String?

    init(viewModel: PortfolioIQViewModel, card: InventoryCard, onUpdated: @escaping () -> Void) {
        self.viewModel = viewModel
        self.card = card
        self.onUpdated = onUpdated
        _frontPhotoUrl = State(initialValue: card.imageFrontUrl)
        _backPhotoUrl = State(initialValue: card.imageBackUrl)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Photos")
                .font(.caption.weight(.bold))
                .foregroundStyle(Color(hex: 0x9CA3AF))
                .tracking(1.2)

            VStack(alignment: .leading, spacing: 14) {
                Text("Tap either side to add or replace a photo. Those images are reused in the eBay draft.")
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x9CA3AF))

                HStack(spacing: 12) {
                    photoTile(
                        title: "Front",
                        subtitle: localFrontImage != nil ? "Photo added" : (frontPhotoUrl ?? "No front photo"),
                        localImage: localFrontImage,
                        urlString: frontPhotoUrl,
                        fallbackSymbol: "photo.on.rectangle",
                        hasPhoto: localFrontImage != nil || frontPhotoUrl != nil
                    ) {
                        showingFrontPhotoSources = true
                    }

                    photoTile(
                        title: "Back",
                        subtitle: localBackImage != nil ? "Photo added" : (backPhotoUrl ?? "No back photo"),
                        localImage: localBackImage,
                        urlString: backPhotoUrl,
                        fallbackSymbol: "rectangle.on.rectangle.angled",
                        hasPhoto: localBackImage != nil || backPhotoUrl != nil
                    ) {
                        showingBackPhotoSources = true
                    }
                }

                if let localError {
                    Text(localError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .padding(14)
        .background(Color(hex: 0x1A1D24))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .alert(
            "Front Photo Source",
            isPresented: $showingFrontPhotoSources
        ) {
            photoSourceButtons(for: .front)
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Choose how you want to add the front photo.")
        }
        .alert(
            "Back Photo Source",
            isPresented: $showingBackPhotoSources
        ) {
            photoSourceButtons(for: .back)
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Choose how you want to add the back photo.")
        }
        .sheet(item: $frontPhotoRequest) { request in
            CardPhotoPicker(sourceType: request.sourceType) { image in
                Task { await uploadPhoto(image, side: request.side) }
            }
        }
        .sheet(item: $backPhotoRequest) { request in
            CardPhotoPicker(sourceType: request.sourceType) { image in
                Task { await uploadPhoto(image, side: request.side) }
            }
        }
    }

    private func photoTile(
        title: String,
        subtitle: String,
        localImage: UIImage?,
        urlString: String?,
        fallbackSymbol: String,
        hasPhoto: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    Spacer(minLength: 0)
                    if hasPhoto {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(HobbyIQTheme.green)
                    } else {
                        Image(systemName: "camera.viewfinder")
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }
                }

                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color(hex: 0x141821))

                    if let localImage {
                        Image(uiImage: localImage)
                            .resizable()
                            .scaledToFill()
                            .frame(maxWidth: .infinity)
                            .frame(height: 118)
                            .clipped()
                    } else if let urlString, let url = URL(string: urlString) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .empty:
                                ProgressView()
                                    .tint(Color(hex: 0x93C5FD))
                            case .success(let image):
                                image
                                    .resizable()
                                    .scaledToFill()
                            case .failure:
                                Image(systemName: fallbackSymbol)
                                    .font(.system(size: 28, weight: .semibold))
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                            @unknown default:
                                Image(systemName: fallbackSymbol)
                                    .font(.system(size: 28, weight: .semibold))
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 118)
                        .clipped()
                    } else {
                        Image(systemName: fallbackSymbol)
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                            .frame(maxWidth: .infinity)
                            .frame(height: 118)
                    }
                }

                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
            .padding(14)
            .background(HobbyIQTheme.cardElevated)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(hasPhoto ? HobbyIQTheme.green.opacity(0.35) : HobbyIQTheme.stroke, lineWidth: 1.6)
            )
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func photoSourceButtons(for side: CardPhotoSide) -> some View {
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button("Camera") {
                configurePhotoRequest(side: side, sourceType: .camera)
            }
        }
        Button("Photo Library") {
            configurePhotoRequest(side: side, sourceType: .photoLibrary)
        }
        let hasExistingPhoto: Bool = {
            switch side {
            case .front: return localFrontImage != nil || frontPhotoUrl != nil
            case .back: return localBackImage != nil || backPhotoUrl != nil
            }
        }()
        if hasExistingPhoto {
            Button("Remove Photo", role: .destructive) {
                Task { await removePhoto(side: side) }
            }
        }
    }

    private func configurePhotoRequest(side: CardPhotoSide, sourceType: UIImagePickerController.SourceType) {
        let request = CardPhotoPickerRequest(side: side, sourceType: sourceType)
        switch side {
        case .front:
            frontPhotoRequest = request
        case .back:
            backPhotoRequest = request
        }
    }

    private func removePhoto(side: CardPhotoSide) async {
        localError = nil

        switch side {
        case .front:
            localFrontImage = nil
            frontPhotoUrl = nil
        case .back:
            localBackImage = nil
            backPhotoUrl = nil
        }

        // Build an updated card with the photo URL cleared
        let updatedCard = InventoryCard(
            id: card.id,
            playerName: card.playerName,
            cardName: card.cardName,
            cost: card.cost,
            currentValue: card.currentValue,
            status: card.status,
            year: card.year,
            setName: card.setName,
            parallel: card.parallel,
            grade: card.grade,
            purchaseDate: card.purchaseDate,
            purchasePlatform: card.purchasePlatform,
            quantity: card.quantity,
            notes: card.notes,
            imageFrontUrl: side == .front ? nil : card.imageFrontUrl,
            imageBackUrl: side == .back ? nil : card.imageBackUrl,
            lowValue: card.lowValue,
            highValue: card.highValue,
            confidence: card.confidence,
            method: card.method,
            summary: card.summary,
            isAuto: card.isAuto
        )

        do {
            _ = try await APIService.shared.updatePortfolioHolding(updatedCard)
            let currentInventory = await LocalPortfolioProvider.shared.getInventory()
            let updatedInventory = currentInventory.map { $0.id == card.id ? updatedCard : $0 }
            await LocalPortfolioProvider.shared.saveInventory(updatedInventory)
            onUpdated()
        } catch {
            localError = "Could not remove that photo right now."
        }
    }

    private func uploadPhoto(_ image: UIImage, side: CardPhotoSide) async {
        localError = nil

        // Show the image immediately so it doesn't disappear
        switch side {
        case .front:
            localFrontImage = image
        case .back:
            localBackImage = image
        }

        guard let response = await viewModel.uploadCardPhoto(for: card, image: image, side: side) else {
            localError = viewModel.errorMessage ?? "Could not upload that photo right now."
            return
        }

        switch side {
        case .front:
            frontPhotoUrl = response.resolvedURL
        case .back:
            backPhotoUrl = response.resolvedURL
        }

        onUpdated()
    }
}
