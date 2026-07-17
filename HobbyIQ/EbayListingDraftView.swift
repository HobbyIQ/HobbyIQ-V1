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
    @State private var policies: EbayPoliciesResponse?
    @State private var selectedPaymentPolicyId: String?
    @State private var selectedFulfillmentPolicyId: String?
    @State private var selectedReturnPolicyId: String?

    // CF-EBAY-HYDRATE-FROM-CARDSIGHT (2026-06-17): one-shot hydration of
    // empty year/setName/brand fields from the holding's cardId
    // when present. Guards against re-fire on view re-appear; only fills
    // EMPTY fields (never clobbers a user edit).
    @State private var hydrationAttempted = false
    @State private var isHydrating = false

    // CF-EBAY-TITLE-HONOR-FROM-IOS (2026-06-17): the backend's buildTitle
    // now honors a non-empty cardTitle verbatim (capped at 80) and only
    // falls back to structured composition when empty. iOS therefore
    // sends listingTitle (user-editable) as cardTitle. We track the
    // initial seed so post-hydration we can re-seed listingTitle from
    // the freshly-populated structured fields ONLY when the user hasn't
    // already typed over it.
    @State private var listingTitleInitialSeed: String = ""

    // PR #425 (2026-07-13): trend-anchored price picker. On task, hit
    // /price-by-id for the holding's cardId + grade to grab the
    // engine's suggested / aggressive / quick sale recommendations.
    // When present, render a radio picker instead of the raw text
    // field. Nil / no cardId → fall through to the legacy text-only
    // field.
    @State private var listPriceRecommendations: ListPriceRecommendations?
    @State private var selectedPriceOption: PriceOption = .suggested

    enum PriceOption: String, CaseIterable, Identifiable {
        case suggested, aggressive, quickSale, custom
        var id: String { rawValue }
    }

    init(viewModel: PortfolioIQViewModel, card: InventoryCard, onCompleted: @escaping (PortfolioEbayListingResponse) -> Void) {
        self.viewModel = viewModel
        self.card = card
        self.onCompleted = onCompleted
        _frontPhotoUrl = State(initialValue: card.imageFrontUrl)
        _backPhotoUrl = State(initialValue: card.imageBackUrl)
        let seedTitle = Self.defaultTitle(for: card)
        _listingTitle = State(initialValue: seedTitle)
        _listingTitleInitialSeed = State(initialValue: seedTitle)
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

                // Seller policies
                if policies != nil {
                    policiesSection
                }

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
        .task {
            await ebayStore.refreshConnectionStatus()
            await loadPolicies()
            await hydrateFromCardsightIfNeeded()
            await loadListPriceRecommendations()
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

            // PR #425: trend-anchored radio picker when the engine
            // provided recommendations; otherwise the legacy text
            // field.
            let priceLabel = listingFormat == .buyItNow ? "List Price" : "Starting Price"
            if let recs = listPriceRecommendations,
               (recs.suggested ?? 0) > 0 || (recs.aggressive ?? 0) > 0 || (recs.quickSale ?? 0) > 0 {
                listPriceRadioPicker(label: priceLabel, recommendations: recs)
            } else {
                field(
                    title: priceLabel,
                    text: $askingPriceText,
                    keyboard: .decimalPad
                )
            }

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
        // CF-UNIFY-SECTION-HEADERS (2026-06-17): delegates to the shared
        // HIQSectionHeader so the draft sheet's "Listing Type", "Photos",
        // "Condition", "Description", etc. sections share the hairline
        // chrome used everywhere else.
        HIQSectionHeader(text)
    }

    // MARK: - Policies Section

    private var policiesSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionLabel("Seller Policies")

            if let paymentPolicies = policies?.paymentPolicies, !paymentPolicies.isEmpty {
                policyPicker(title: "Payment Policy", policies: paymentPolicies, selection: $selectedPaymentPolicyId)
            }

            if let fulfillmentPolicies = policies?.fulfillmentPolicies, !fulfillmentPolicies.isEmpty {
                policyPicker(title: "Fulfillment Policy", policies: fulfillmentPolicies, selection: $selectedFulfillmentPolicyId)
            }

            if let returnPolicies = policies?.returnPolicies, !returnPolicies.isEmpty {
                policyPicker(title: "Return Policy", policies: returnPolicies, selection: $selectedReturnPolicyId)
            }
        }
        .listingCard()
    }

    private func policyPicker(title: String, policies: [EbayPolicy], selection: Binding<String?>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            Menu {
                Button("None") { selection.wrappedValue = nil }
                ForEach(policies) { policy in
                    Button(policy.name ?? policy.policyId) {
                        selection.wrappedValue = policy.policyId
                    }
                }
            } label: {
                HStack {
                    Text(selectedPolicyName(from: policies, id: selection.wrappedValue))
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
    }

    private func selectedPolicyName(from policies: [EbayPolicy], id: String?) -> String {
        guard let id else { return "Select…" }
        return policies.first(where: { $0.policyId == id })?.name ?? id
    }

    private func loadPolicies() async {
        do {
            let response = try await APIService.shared.ebayPolicies()
            policies = response
            if selectedPaymentPolicyId == nil {
                selectedPaymentPolicyId = response.paymentPolicies?.first(where: { $0.isDefault == true })?.policyId
                    ?? response.paymentPolicies?.first?.policyId
            }
            if selectedFulfillmentPolicyId == nil {
                selectedFulfillmentPolicyId = response.fulfillmentPolicies?.first(where: { $0.isDefault == true })?.policyId
                    ?? response.fulfillmentPolicies?.first?.policyId
            }
            if selectedReturnPolicyId == nil {
                selectedReturnPolicyId = response.returnPolicies?.first(where: { $0.isDefault == true })?.policyId
                    ?? response.returnPolicies?.first?.policyId
            }
        } catch {
            // Policies are optional — listing still works without them
        }
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
        guard let listingPrice = Double(askingPriceText.trimmingCharacters(in: .whitespacesAndNewlines)), listingPrice > 0 else {
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

        // CF-EBAY-PUBLISH-400-FIX (2026-06-17): map to HoldingListingInput.
        //   - holdingId = InventoryCard.id (the real holding id; the sale-
        //     recon webhook keys on this to mark the holding sold).
        //   - cardYear is Int on the wire; parse from the year text field
        //     and fall back to 0 when missing/invalid so the request still
        //     validates (backend ignores cardYear == 0 in buildTitle).
        //   - product mirrors setName until iOS surfaces a separate field
        //     (matches backend's shimmedProduct fallback semantics).
        //   - gradingCompany + grade split from InventoryCard's structured
        //     fields so buildTitle composes "PSA 10" instead of "PSA PSA 10".
        let yearTrimmed = yearText.trimmingCharacters(in: .whitespacesAndNewlines)
        let cardYear = Int(yearTrimmed) ?? 0
        let setTrimmed = setNameText.trimmingCharacters(in: .whitespacesAndNewlines)
        let brandTrimmed = brandText.trimmingCharacters(in: .whitespacesAndNewlines)
        let parallelTrimmed = parallelText.trimmingCharacters(in: .whitespacesAndNewlines)
        let gradeCompanyRaw = (card.gradeCompany ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let gradingCompany: String? = gradeCompanyRaw.isEmpty ? nil : gradeCompanyRaw
        let gradeValueString: String? = card.gradeValue.map { value in
            value.truncatingRemainder(dividingBy: 1) == 0
                ? String(Int(value))
                : String(value)
        }

        return PortfolioEbayListingRequest(
            holdingId: card.id.uuidString.lowercased(),
            playerName: playerNameText.trimmingCharacters(in: .whitespacesAndNewlines),
            // CF-EBAY-TITLE-HONOR-FROM-IOS (2026-06-17): send the user-
            // editable listingTitle (initialized from defaultTitle and
            // possibly re-seeded after cardsight hydration). Backend's
            // buildTitle honors this verbatim when non-empty.
            cardTitle: listingTitle.trimmingCharacters(in: .whitespacesAndNewlines),
            cardYear: cardYear,
            brand: brandTrimmed,
            setName: setTrimmed,
            product: setTrimmed,
            isAuto: isAutoToggle,
            isPatch: false,
            isRookie: false,
            quantity: quantity,
            listingPrice: listingPrice,
            bestOfferEnabled: false,
            sport: nil,
            cardNumber: nil,
            parallel: parallelTrimmed.isEmpty ? nil : parallelTrimmed,
            serialNumber: nil,
            printRun: nil,
            variation: nil,
            grade: gradeValueString,
            gradingCompany: gradingCompany,
            certNumber: nil,
            conditionNotes: nil,
            conditionEstimate: nil,
            bestOfferMinPrice: nil,
            imageFrontUrl: frontPhotoUrl,
            imageBackUrl: backPhotoUrl,
            description: listingDescription.trimmingCharacters(in: .whitespacesAndNewlines),
            categoryId: nil,
            paymentPolicyId: selectedPaymentPolicyId,
            returnPolicyId: selectedReturnPolicyId,
            fulfillmentPolicyId: selectedFulfillmentPolicyId
        )
    }

    // CF-EBAY-TITLE-HONOR-FROM-IOS (2026-06-17): mirror backend's
    // buildTitle compose format — `[year] [set] [player]
    // [parallel(+serial)] [Auto?]` — with the same brand-vs-set dedup
    // so the seed title (and any post-hydration re-seed) lines up with
    // what backend would otherwise compose on the FALLBACK path.
    private static func defaultTitle(for card: InventoryCard) -> String {
        composeTitle(
            year: card.year,
            brand: defaultBrand(for: card),
            setName: card.setName,
            playerName: card.playerName,
            parallel: card.parallel,
            isAuto: card.isAuto
        )
    }

    /// Mirrors `composeTitle` in `backend/src/services/ebay/ebayListing.service.ts`.
    /// Order: [year] [set with brand-dedup] [player] [parallel] [Auto?].
    /// Empty tokens collapsed; capped at eBay's 80-char title limit.
    private static func composeTitle(
        year: String,
        brand: String,
        setName: String,
        playerName: String,
        parallel: String,
        isAuto: Bool
    ) -> String {
        var tokens: [String] = []

        let yearTrim = year.trimmingCharacters(in: .whitespaces)
        if !yearTrim.isEmpty, let n = Int(yearTrim), n > 0 {
            tokens.append(yearTrim)
        }

        let set = formatSetWithBrandDedup(brand: brand, set: setName)
        if !set.isEmpty { tokens.append(set) }

        let player = playerName.trimmingCharacters(in: .whitespaces)
        if !player.isEmpty { tokens.append(player) }

        let par = parallel.trimmingCharacters(in: .whitespaces)
        if !par.isEmpty { tokens.append(par) }

        if isAuto { tokens.append("Auto") }

        let joined = tokens
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespaces)

        if joined.count <= 80 { return joined }
        return String(joined.prefix(77)) + "..."
    }

    private static func formatSetWithBrandDedup(brand: String, set: String) -> String {
        let brandTrim = brand.trimmingCharacters(in: .whitespaces)
        let setTrim = set.trimmingCharacters(in: .whitespaces)
        if brandTrim.isEmpty && setTrim.isEmpty { return "" }
        if brandTrim.isEmpty { return setTrim }
        if setTrim.isEmpty { return brandTrim }
        let lcSet = setTrim.lowercased()
        let lcBrand = brandTrim.lowercased()
        if lcSet == lcBrand { return setTrim }
        if lcSet.contains(lcBrand) { return setTrim }
        return "\(brandTrim) \(setTrim)"
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

    // MARK: - Cardsight Hydration (CF-EBAY-HYDRATE-FROM-CARDSIGHT 2026-06-17)
    //
    // Backend's PortfolioHolding may have empty year/setName/brand when
    // the holding was added before the variant-picker stamped them, OR
    // when manual entry skipped them. buildTitle on the publish path
    // composes from structured fields — empty fields produce a sparse
    // title ("Eric Hartman" alone). When the holding carries a
    // cardId, /api/compiq/price-by-id returns a `cardIdentity`
    // block (release/set/year) we can use to fill the empty draft text
    // fields. Backend's `getCardDetail` cache is 24h so repeat opens
    // are cheap.
    //
    // Hydration policy:
    //   - Only fires once per view appearance (hydrationAttempted guard).
    //   - Only fills EMPTY @State fields — never clobbers user edits.
    //   - Only triggers when at least one field is missing AND we have
    //     a cardId to query.
    //   - Failures are non-fatal: log, fall through to the default
    //     empty/`"Trading Card"` state. User can still type values.
    //   - The hydrated values are local-only (do NOT PATCH the holding
    //     here). A backend-side hoist into the holding record is the
    //     durable follow-up; this is the same-day mitigation so the
    //     next publish ships a good title.
    // PR #425 (2026-07-13): fetch trend-anchored recommendations. Fires
    // once on task; nil result keeps the legacy text-field fallback.
    private func loadListPriceRecommendations() async {
        guard let cardId = card.cardId?.trimmingCharacters(in: .whitespaces),
              cardId.isEmpty == false else { return }
        do {
            let response = try await APIService.shared.priceByCardId(
                cardId: cardId,
                query: nil,
                gradeCompany: card.gradeCompany,
                gradeValue: card.gradeValue,
                parallelId: nil,
                parallelName: card.parallel.isEmpty ? nil : card.parallel,
                isBlackLabel: card.isBlackLabel
            )
            await MainActor.run {
                listPriceRecommendations = response.listPriceRecommendations
                // Seed the picker + text field with the suggested value
                // so the initial state matches the default radio pick.
                if let suggested = response.listPriceRecommendations?.suggested, suggested > 0 {
                    askingPriceText = String(format: "%.2f", suggested)
                }
            }
        } catch {
            // Silent fall-through — legacy text field renders in place.
        }
    }

    @ViewBuilder
    private func listPriceRadioPicker(label: String, recommendations: ListPriceRecommendations) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel(label)

            listPriceRadioRow(
                option: .suggested,
                title: "Suggested",
                price: recommendations.suggested,
                rationale: recommendations.rationale?.suggestedBasis ?? "Predicted next 30d"
            )
            listPriceRadioRow(
                option: .aggressive,
                title: "Aggressive",
                price: recommendations.aggressive,
                rationale: recommendations.rationale?.aggressiveBasis ?? "Top of prediction range"
            )
            listPriceRadioRow(
                option: .quickSale,
                title: "Quick Sale",
                price: recommendations.quickSale,
                rationale: recommendations.rationale?.quickSaleBasis ?? "10% below market value"
            )
            listPriceCustomRow()
        }
    }

    private func listPriceRadioRow(option: PriceOption, title: String, price: Double?, rationale: String) -> some View {
        Button {
            selectedPriceOption = option
            if let price, price > 0 {
                askingPriceText = String(format: "%.2f", price)
            }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: selectedPriceOption == option ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(selectedPriceOption == option ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        Spacer(minLength: 6)
                        Text(price.map { $0.formatted(.currency(code: "USD").precision(.fractionLength(0))) } ?? "—")
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    Text(rationale)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    private func listPriceCustomRow() -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                selectedPriceOption = .custom
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: selectedPriceOption == .custom ? "largecircle.fill.circle" : "circle")
                        .font(.system(size: 18))
                        .foregroundStyle(selectedPriceOption == .custom ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText)
                    Text("Custom")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if selectedPriceOption == .custom {
                TextField("Enter price", text: $askingPriceText)
                    .keyboardType(.decimalPad)
                    .foregroundStyle(.white)
                    .padding(14)
                    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1.2)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    private func hydrateFromCardsightIfNeeded() async {
        guard !hydrationAttempted else { return }
        hydrationAttempted = true

        guard let csid = card.cardId?
                .trimmingCharacters(in: .whitespaces),
              csid.isEmpty == false else {
            return
        }

        let needsYear  = yearText.trimmingCharacters(in: .whitespaces).isEmpty
        let needsSet   = setNameText.trimmingCharacters(in: .whitespaces).isEmpty
        let brandTrim  = brandText.trimmingCharacters(in: .whitespaces)
        let needsBrand = brandTrim.isEmpty || brandTrim == "Trading Card"
        guard needsYear || needsSet || needsBrand else { return }

        isHydrating = true
        defer { isHydrating = false }

        do {
            // gradeCompany/gradeValue forwarded so the call routes to the
            // user's actual sub-market and the backend reuses any pricing
            // cache; cardIdentity comes back identically regardless of
            // grade scope.
            let response = try await APIService.shared.priceByCardId(
                cardId: csid,
                query: nil,
                gradeCompany: card.gradeCompany,
                gradeValue: card.gradeValue,
                parallelId: nil,
                parallelName: nil
            )
            guard let identity = response.cardIdentity else { return }

            if needsYear, let year = identity.year, year > 0 {
                yearText = String(year)
            }
            // Prefer `release` (publication line, e.g. "Bowman Chrome")
            // over `set` (subset, e.g. "Chrome Prospect Autographs") for
            // the iOS setName field — release is what eBay sellers think
            // of as the "set" and what buildTitle's `product` token wants.
            if needsSet {
                if let release = identity.release?
                    .trimmingCharacters(in: .whitespaces),
                   release.isEmpty == false {
                    setNameText = release
                } else if let set = identity.set?
                    .trimmingCharacters(in: .whitespaces),
                   set.isEmpty == false {
                    setNameText = set
                }
            }
            if needsBrand {
                let sourceForBrand = setNameText.trimmingCharacters(in: .whitespaces)
                if let derived = brandFromRelease(sourceForBrand) {
                    brandText = derived
                }
            }

            // CF-EBAY-TITLE-HONOR-FROM-IOS (2026-06-17): re-seed the
            // listingTitle from the hydrated text fields ONLY when the
            // user hasn't yet edited it (current value still equals the
            // original seed). This keeps the visible title in lockstep
            // with the now-rich year/set/brand fields while preserving
            // any hand-typed override.
            if listingTitle == listingTitleInitialSeed {
                let reseed = Self.composeTitle(
                    year: yearText,
                    brand: brandText,
                    setName: setNameText,
                    playerName: playerNameText,
                    parallel: parallelText,
                    isAuto: isAutoToggle
                )
                if !reseed.isEmpty, reseed != listingTitle {
                    listingTitle = reseed
                    listingTitleInitialSeed = reseed
                }
            }
        } catch {
            #if DEBUG
            print("[EbayDraft] cardsight hydration failed (non-fatal): \(APIService.errorMessage(from: error))")
            #endif
        }
    }

    private static func mapCondition(for card: InventoryCard) -> EbayCardCondition {
        let grade = card.grade.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if grade.isEmpty || grade == "ungraded" || grade == "raw" {
            return .ungraded
        }
        return .graded
    }
}

// MARK: - Brand-Split Map (CF-EBAY-HYDRATE-FROM-CARDSIGHT 2026-06-17)
//
// Cardsight's catalog returns `releaseName` (publication line — e.g.
// "Bowman Chrome", "Topps Update") but does not split out the
// manufacturer. eBay's title needs the manufacturer as a discrete
// `brand` token AND the publication line as `product`. Without the
// split, brand = product literally → buildTitle emits doubling
// ("Bowman Bowman Chrome"). This is a small static table — the major
// sports-card publication lines are well-known and stable. Falls back
// to nil when the release doesn't match a known publisher so the
// caller can leave the brand text as-is.
fileprivate func brandFromRelease(_ release: String) -> String? {
    let lowercased = release.lowercased()
    if lowercased.contains("bowman")     { return "Bowman" }
    if lowercased.contains("topps")      { return "Topps" }
    if lowercased.contains("panini")     { return "Panini" }
    if lowercased.contains("upper deck") { return "Upper Deck" }
    if lowercased.contains("donruss")    { return "Panini" }       // Donruss is a Panini brand line
    if lowercased.contains("stadium club") { return "Topps" }       // Stadium Club is Topps
    if lowercased.contains("finest")     { return "Topps" }         // Finest is Topps
    if lowercased.contains("allen & ginter") || lowercased.contains("allen and ginter") { return "Topps" }
    if lowercased.contains("heritage")   { return "Topps" }         // Heritage is Topps
    if lowercased.contains("select")     { return "Panini" }        // Select is Panini
    if lowercased.contains("prizm")      { return "Panini" }
    if lowercased.contains("optic")      { return "Panini" }
    if lowercased.contains("mosaic")     { return "Panini" }
    return nil
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
