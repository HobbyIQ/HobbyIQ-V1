//
//  EbayListingDraftView.swift
//  HobbyIQ
//

import SwiftUI
import UIKit

// MARK: - Listing Format

enum EbayListingFormat: String, CaseIterable, Identifiable {
    case buyItNow = "Buy It Now"
    case auction = "Auction"

    var id: String { rawValue }
}

// MARK: - eBay Condition Values

enum EbayCardCondition: String, CaseIterable, Identifiable {
    case brandNew = "Brand New"
    case likeNew = "Like New"
    case veryGood = "Very Good"
    case good = "Good"
    case acceptable = "Acceptable"
    case ungraded = "Ungraded"
    case graded = "Graded"

    var id: String { rawValue }
}

// MARK: - View

struct EbayListingDraftView: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let card: InventoryCard
    let onCompleted: (PortfolioEbayListingResponse) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var ebayStore = EBayOAuthCoordinator.shared
    @State private var frontPhotoUrl: String?
    @State private var backPhotoUrl: String?
    @State private var localFrontImage: UIImage?
    @State private var localBackImage: UIImage?
    @State private var showingFrontPhotoSources = false
    @State private var showingBackPhotoSources = false
    @State private var frontPhotoRequest: CardPhotoPickerRequest?
    @State private var backPhotoRequest: CardPhotoPickerRequest?
    @State private var listingTitle: String
    @State private var listingDescription: String
    @State private var askingPriceText: String
    @State private var quantityText: String
    @State private var selectedCondition: EbayCardCondition
    @State private var brandText: String
    @State private var playerNameText: String
    @State private var yearText: String
    @State private var setNameText: String
    @State private var parallelText: String
    @State private var gradeText: String
    @State private var isAutoToggle: Bool
    @State private var listingFormat: EbayListingFormat = .buyItNow
    @State private var auctionStartDate: Date = Date()
    @State private var localError: String?
    @State private var isPreviewing = false
    @State private var isPublishing = false
    @State private var previewResponse: PortfolioEbayListingResponse?
    @State private var publishResponse: PortfolioEbayListingResponse?

    init(viewModel: PortfolioIQViewModel, card: InventoryCard, onCompleted: @escaping (PortfolioEbayListingResponse) -> Void) {
        self.viewModel = viewModel
        self.card = card
        self.onCompleted = onCompleted
        _frontPhotoUrl = State(initialValue: card.imageFrontUrl)
        _backPhotoUrl = State(initialValue: card.imageBackUrl)
        _listingTitle = State(initialValue: Self.defaultTitle(for: card))
        _listingDescription = State(initialValue: Self.defaultDescription(for: card))
        _askingPriceText = State(initialValue: String(format: "%.2f", max(card.currentValue, card.highValue ?? card.currentValue)))
        _quantityText = State(initialValue: String(format: "%.0f", max(card.quantity ?? 1, 1)))
        _selectedCondition = State(initialValue: Self.mapCondition(for: card))
        _brandText = State(initialValue: Self.defaultBrand(for: card))
        _playerNameText = State(initialValue: card.playerName)
        _yearText = State(initialValue: card.year)
        _setNameText = State(initialValue: card.setName)
        _parallelText = State(initialValue: card.parallel)
        _gradeText = State(initialValue: card.grade)
        _isAutoToggle = State(initialValue: card.isAuto)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Card header
                    VStack(alignment: .leading, spacing: 4) {
                        Text(card.playerName)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)

                        Text(card.cardName)
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }

                    // Listing format selector
                    listingFormatSection

                    // Photos
                    photoSection

                    // Input fields
                    inputSection

                    // Auction scheduling
                    if listingFormat == .auction {
                        auctionScheduleSection
                    }

                    // Preview
                    previewSection

                    // Results
                    if let previewResponse {
                        resultCard(title: "Latest Preview", response: previewResponse)
                    }

                    if let publishResponse {
                        resultCard(title: "Publish Result", response: publishResponse)
                    }

                    // Error
                    if let localError {
                        Text(localError)
                            .font(.footnote)
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                            .padding(.horizontal, 4)
                    }

                    // Action buttons
                    actionButtons
                }
                .padding(16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("eBay Listing")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(AppColors.textSecondary)
                }
            }
        }
        .task {
            await ebayStore.refreshConnectionStatus()
        }
        .onChange(of: ebayStore.lastErrorMessage) { _, newValue in
            if let newValue {
                localError = newValue
            }
        }
    }

    // MARK: - Listing Format Section

    private var listingFormatSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Listing Type")

            HStack(spacing: 10) {
                ForEach(EbayListingFormat.allCases) { format in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            listingFormat = format
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: format == .buyItNow ? "tag.fill" : "hammer.fill")
                                .font(.caption)
                            Text(format.rawValue)
                                .font(.subheadline.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .foregroundStyle(listingFormat == format ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                        .background(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                                .fill(listingFormat == format ? HobbyIQTheme.Colors.electricBlue.opacity(0.18) : Color.clear)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                                .stroke(listingFormat == format ? HobbyIQTheme.Colors.electricBlue.opacity(0.5) : Color.white.opacity(0.08), lineWidth: 1.6)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listingCard()
    }

    // MARK: - Photo Section

    private var photoSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Photos")

            HStack(spacing: 12) {
                photoTile(
                    title: "Front",
                    localImage: localFrontImage,
                    urlString: frontPhotoUrl,
                    fallbackSymbol: "photo.on.rectangle",
                    isUploading: false,
                    hasPhoto: localFrontImage != nil || frontPhotoUrl != nil
                ) {
                    showingFrontPhotoSources = true
                }

                photoTile(
                    title: "Back",
                    localImage: localBackImage,
                    urlString: backPhotoUrl,
                    fallbackSymbol: "rectangle.on.rectangle.angled",
                    isUploading: false,
                    hasPhoto: localBackImage != nil || backPhotoUrl != nil
                ) {
                    showingBackPhotoSources = true
                }
            }
        }
        .listingCard()
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
        localImage: UIImage?,
        urlString: String?,
        fallbackSymbol: String,
        isUploading: Bool,
        hasPhoto: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color(hex: 0x141821))

                    if let localImage {
                        Image(uiImage: localImage)
                            .resizable()
                            .scaledToFill()
                            .frame(maxWidth: .infinity)
                            .frame(height: 110)
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
                                    .font(.system(size: 24, weight: .semibold))
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                            @unknown default:
                                Image(systemName: fallbackSymbol)
                                    .font(.system(size: 24, weight: .semibold))
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 110)
                        .clipped()
                    } else {
                        VStack(spacing: 6) {
                            Image(systemName: "camera.viewfinder")
                                .font(.system(size: 22, weight: .semibold))
                                .foregroundStyle(HobbyIQTheme.textSecondary)
                            Text("Tap to add")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 110)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                HStack(spacing: 4) {
                    if isUploading {
                        ProgressView().tint(HobbyIQTheme.green)
                    } else if hasPhoto {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(HobbyIQTheme.green)
                            .font(.caption)
                    }
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(10)
            .background(HobbyIQTheme.cardElevated)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(hasPhoto ? HobbyIQTheme.green.opacity(0.35) : HobbyIQTheme.stroke, lineWidth: 1.6)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
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
    }

    // MARK: - Input Section

    private var inputSection: some View {
        VStack(spacing: 14) {
            field(title: "Listing Title", text: $listingTitle)

            // Price label changes based on format
            field(
                title: listingFormat == .buyItNow ? "List Price" : "Starting Price",
                text: $askingPriceText,
                keyboard: .decimalPad
            )

            field(title: "Quantity", text: $quantityText, keyboard: .numberPad)

            // Condition dropdown
            VStack(alignment: .leading, spacing: 8) {
                sectionLabel("Condition")

                Menu {
                    ForEach(EbayCardCondition.allCases) { condition in
                        Button(condition.rawValue) {
                            selectedCondition = condition
                        }
                    }
                } label: {
                    HStack {
                        Text(selectedCondition.rawValue)
                            .foregroundStyle(.white)
                        Spacer()
                        Image(systemName: "chevron.down")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    .padding(14)
                    .background(Color(hex: 0x1A1D24))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 2)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }

            field(title: "Brand", text: $brandText)

            // Two-column grid for compact fields
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 14) {
                field(title: "Player Name", text: $playerNameText)
                field(title: "Year", text: $yearText)
                field(title: "Set Name", text: $setNameText)
                field(title: "Parallel", text: $parallelText)
            }

            field(title: "Grade", text: $gradeText)

            Toggle(isOn: $isAutoToggle) {
                Text("Autograph")
                    .font(.subheadline)
                    .foregroundStyle(.white)
            }
            .tint(HobbyIQTheme.Colors.electricBlue)

            VStack(alignment: .leading, spacing: 8) {
                sectionLabel("Description")

                TextEditor(text: $listingDescription)
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(.white)
                    .frame(minHeight: 120, alignment: .topLeading)
                    .padding(12)
                    .background(Color(hex: 0x1A1D24))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 2)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .listingCard()
    }

    // MARK: - Auction Schedule Section

    private var auctionScheduleSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Auction Start")

            DatePicker(
                "Start Date & Time",
                selection: $auctionStartDate,
                in: Date()...,
                displayedComponents: [.date, .hourAndMinute]
            )
            .datePickerStyle(.compact)
            .tint(HobbyIQTheme.Colors.electricBlue)
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)

            Text("Your auction will start at the selected date and time.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .listingCard()
    }

    // MARK: - Preview Section

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Listing Preview")

            VStack(spacing: 6) {
                listingRow(title: "Format", value: listingFormat.rawValue)
                listingRow(title: "Title", value: listingTitle)
                listingRow(title: listingFormat == .buyItNow ? "List Price" : "Starting Price", value: askingPricePreview)
                listingRow(title: "Quantity", value: quantityPreview)
                listingRow(title: "Condition", value: selectedCondition.rawValue)
                listingRow(title: "Brand", value: brandText)
                listingRow(title: "Player", value: playerNameText)
                listingRow(title: "Year", value: yearText.isEmpty ? "—" : yearText)
                listingRow(title: "Set", value: setNameText.isEmpty ? "—" : setNameText)
                listingRow(title: "Parallel", value: parallelText.isEmpty ? "—" : parallelText)
                listingRow(title: "Grade", value: gradeText.isEmpty ? "—" : gradeText)
                if listingFormat == .auction {
                    listingRow(title: "Starts", value: auctionStartDate.formatted(date: .abbreviated, time: .shortened))
                }
            }
        }
        .listingCard()
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    Task { await generatePreview() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isPreviewing ? "hourglass" : "doc.text.magnifyingglass")
                        Text(isPreviewing ? "Generating..." : "Preview")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isPreviewing || isPublishing || ebayStore.connectionState != .connected)

                Button {
                    Task { await publishListing() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isPublishing ? "hourglass" : "paperplane.fill")
                        Text(isPublishing ? "Publishing..." : "List on eBay")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isPublishing || isPreviewing || ebayStore.connectionState != .connected)
            }

            if ebayStore.connectionState != .connected {
                Text("Connect eBay in Account settings to publish listings.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }

            if publishResponse != nil {
                Button("Done") {
                    dismiss()
                }
                .buttonStyle(.bordered)
                .tint(HobbyIQTheme.Colors.electricBlue)
            }
        }
    }

    // MARK: - Helpers

    private func resultCard(title: String, response: PortfolioEbayListingResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            listingRow(title: "Listing ID", value: response.listingId ?? "—")
            listingRow(title: "URL", value: response.listingURL ?? "—")
            listingRow(title: "Status", value: response.status ?? "—")
            listingRow(title: "Message", value: response.message ?? "—")
        }
        .listingCard()
    }

    private func listingRow(title: String, value: String, valueColor: Color = .white) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .frame(width: 92, alignment: .leading)

            Text(value.isEmpty ? "—" : value)
                .font(.caption)
                .foregroundStyle(valueColor)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
        }
    }

    private var askingPricePreview: String {
        guard let price = Double(askingPriceText.trimmingCharacters(in: .whitespacesAndNewlines)), price > 0 else {
            return "—"
        }
        return price.portfolioCurrencyText
    }

    private var quantityPreview: String {
        guard let quantity = Int(quantityText.trimmingCharacters(in: .whitespacesAndNewlines)), quantity > 0 else {
            return "—"
        }
        return "\(quantity)"
    }

    private func field(title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField(title, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.words)
                .padding(12)
                .background(Color(hex: 0x1A1D24))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .foregroundStyle(.white)
        }
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
    }

    // MARK: - API

    private func generatePreview() async {
        localError = nil
        guard let request = buildRequest() else { return }
        isPreviewing = true
        defer { isPreviewing = false }

        if let response = await viewModel.previewEbayListing(for: card, request: request) {
            if response.success ?? true {
                previewResponse = response
                ebayStore.registerDraftResult(response)
            } else {
                localError = response.message ?? viewModel.errorMessage ?? "Could not generate preview."
            }
        } else {
            localError = viewModel.errorMessage ?? "Could not generate preview."
        }
    }

    private func publishListing() async {
        localError = nil
        guard let request = buildRequest() else { return }
        isPublishing = true
        defer { isPublishing = false }

        if let response = await viewModel.publishEbayListing(for: card, request: request) {
            if response.success ?? true {
                publishResponse = response
                ebayStore.registerPublishResult(response)
                onCompleted(response)
            } else {
                localError = response.message ?? viewModel.errorMessage ?? "Could not publish the listing. Try again."
            }
        } else {
            localError = viewModel.errorMessage ?? "Could not publish the listing. Try again."
        }
    }

    private func buildRequest() -> PortfolioEbayListingRequest? {
        guard let askingPrice = Double(askingPriceText.trimmingCharacters(in: .whitespacesAndNewlines)), askingPrice > 0 else {
            localError = listingFormat == .buyItNow ? "Enter a valid list price." : "Enter a valid starting price."
            return nil
        }

        guard let quantity = Int(quantityText.trimmingCharacters(in: .whitespacesAndNewlines)), quantity > 0 else {
            localError = "Enter a valid quantity."
            return nil
        }

        guard ebayStore.connectionState == .connected else {
            localError = ebayStore.connectionState == .signedOut ? "Sign in to connect eBay." : "Connect eBay first."
            return nil
        }

        let formatValue = listingFormat == .buyItNow ? "buyItNow" : "auction"
        let auctionDate: String? = listingFormat == .auction
            ? ISO8601DateFormatter().string(from: auctionStartDate)
            : nil

        return PortfolioEbayListingRequest(
            title: listingTitle.trimmingCharacters(in: .whitespacesAndNewlines),
            description: listingDescription.trimmingCharacters(in: .whitespacesAndNewlines),
            askingPrice: askingPrice,
            quantity: quantity,
            ebayUser: ebayStore.connectedUser,
            cardId: card.id.uuidString,
            playerName: playerNameText.trimmingCharacters(in: .whitespacesAndNewlines),
            cardName: card.cardName.trimmingCharacters(in: .whitespacesAndNewlines),
            year: yearText.trimmingCharacters(in: .whitespacesAndNewlines),
            setName: setNameText.trimmingCharacters(in: .whitespacesAndNewlines),
            parallel: parallelText.trimmingCharacters(in: .whitespacesAndNewlines),
            grade: gradeText.trimmingCharacters(in: .whitespacesAndNewlines),
            condition: selectedCondition.rawValue,
            brand: brandText.trimmingCharacters(in: .whitespacesAndNewlines),
            cardNumber: nil,
            imageFrontUrl: frontPhotoUrl,
            imageBackUrl: backPhotoUrl,
            purchasePrice: card.cost,
            purchasePlatform: card.purchasePlatform,
            purchaseDate: card.purchaseDate,
            notes: card.notes,
            summary: card.summary,
            isAuto: isAutoToggle ? true : nil,
            listingFormat: formatValue,
            auctionStartDate: auctionDate
        )
    }

    private static func defaultTitle(for card: InventoryCard) -> String {
        var parts = [card.playerName, card.cardName]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }
        if card.isAuto {
            parts.append("AUTO")
        }
        return parts.joined(separator: " - ")
    }

    private static func defaultDescription(for card: InventoryCard) -> String {
        let parts: [String?] = [
            card.summary,
            card.notes,
            card.year.isEmpty ? nil : "Year: \(card.year)",
            card.setName.isEmpty ? nil : "Set: \(card.setName)",
            card.parallel.isEmpty ? nil : "Parallel: \(card.parallel)",
            card.grade.isEmpty ? nil : "Grade: \(card.grade)",
            card.isAuto ? "Autograph: Yes" : nil,
            card.purchasePlatform.map { "Purchase Source: \($0)" },
            card.purchaseDate.map { "Purchase Date: \($0)" }
        ]

        return parts
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }
            .joined(separator: "\n")
    }

    private static func defaultBrand(for card: InventoryCard) -> String {
        let lowercased = card.cardName.lowercased()
        if lowercased.contains("topps") { return "Topps" }
        if lowercased.contains("bowman") { return "Bowman" }
        if lowercased.contains("panini") { return "Panini" }
        if lowercased.contains("upper deck") { return "Upper Deck" }
        return card.setName.isEmpty ? "Trading Card" : card.setName
    }

    private static func mapCondition(for card: InventoryCard) -> EbayCardCondition {
        let grade = card.grade.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if grade.isEmpty || grade == "ungraded" || grade == "raw" {
            return .ungraded
        }
        return .graded
    }
}

// MARK: - Listing Card Modifier

private extension View {
    func listingCard() -> some View {
        self
            .padding(14)
            .background(Color(hex: 0x141821))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}
