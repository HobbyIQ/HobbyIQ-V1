//
//  AddPortfolioCardView.swift
//  HobbyIQ
//

import SwiftUI
import UIKit

struct AddPortfolioCardView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject var viewModel: AddPortfolioCardViewModel
    var onSave: (() -> Void)? = nil
    @State private var showingFrontPhotoSources = false
    @State private var showingBackPhotoSources = false
    @State private var frontPhotoRequest: CardPhotoPickerRequest?
    @State private var backPhotoRequest: CardPhotoPickerRequest?

    // PSA Cert Lookup
    @State private var certNumberInput: String = ""
    @State private var psaLookupState: PSALookupState = .idle

    private enum PSALookupState: Equatable {
        case idle
        case loading
        case success(String)
        case error(String)
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: HobbyIQTheme.Spacing.medium) {
                    headerCard
                    psaCertLookupCard
                    searchCard
                    photoCard
                    conditionCard
                    purchaseCard
                    moreDetailsCard

                    if let successMessage = viewModel.successMessage {
                        successBanner(message: successMessage)
                    }

                    if let errorMessage = viewModel.errorMessage {
                        HobbyIQErrorStateView(title: "Could not save card", message: errorMessage) {
                            Task { _ = await viewModel.save() }
                        }
                    }

                    saveButton
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.top, 8)
                .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
            }
            .background(HobbyIQBackground())
            .scrollDismissesKeyboard(.interactively)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .semibold))
                            Text("Cancel")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    .buttonStyle(.plain)
                }

                ToolbarItem(placement: .principal) {
                    Text(viewModel.mode.title)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    // MARK: - Header Card

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "plus.rectangle.on.rectangle.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)

                Text(viewModel.mode.title)
                    .font(HobbyIQTheme.Typography.title)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            Text("Type one card description, verify it live, then add the clean details below.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .lineSpacing(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    // MARK: - PSA Cert Lookup

    private var psaCertLookupCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader(title: "PSA Cert Lookup", icon: "checkmark.seal.fill", tint: Color(red: 0, green: 0.85, blue: 0.85))

            HStack(spacing: 10) {
                TextField("Cert # (e.g. 43707013)", text: $certNumberInput)
                    .keyboardType(.numberPad)
                    .submitLabel(.search)
                    .onSubmit { Task { await lookupPSACert() } }
                    .textFieldStyle(.plain)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(12)
                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                            .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.6), lineWidth: 1)
                    )

                Button(action: { Task { await lookupPSACert() } }) {
                    if psaLookupState == .loading {
                        ProgressView()
                            .tint(HobbyIQTheme.Colors.pureWhite)
                            .frame(width: 40, height: 40)
                    } else {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.black)
                            .frame(width: 40, height: 40)
                            .background(Color(red: 0, green: 0.85, blue: 0.85))
                            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                    }
                }
                .disabled(certNumberInput.trimmingCharacters(in: .whitespaces).isEmpty
                          || psaLookupState == .loading)
            }

            switch psaLookupState {
            case .idle, .loading:
                EmptyView()
            case .success(let label):
                statusChip(icon: "checkmark.circle.fill", text: label, tint: HobbyIQTheme.Colors.successGreen)
            case .error(let msg):
                statusChip(icon: "exclamationmark.triangle.fill", text: msg, tint: HobbyIQTheme.Colors.warning)
            }
        }
        .hiqCard()
    }

    // MARK: - Search Section

    private var searchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Search & Verify", icon: "magnifyingglass", tint: HobbyIQTheme.Colors.electricBlue)

            Text("Enter the card description once. We'll parse the player, year, set, parallel, and auto/graded state for you.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            searchField

            if let estimate = viewModel.estimateResult {
                verifiedBanner(estimate)
                pricingRow(for: estimate)
            }
        }
        .hiqCard()
    }

    // MARK: - Photos

    private var photoCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Card Photos", icon: "camera.fill", tint: HobbyIQTheme.Colors.electricBlue)

            Text("Add front and back photos now so they can be reused in the eBay draft later.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            HStack(spacing: 10) {
                photoTile(
                    title: "Front",
                    subtitle: viewModel.frontPhotoUrl ?? "No front photo",
                    isUploading: viewModel.isUploadingFrontPhoto,
                    hasPhoto: viewModel.frontPhotoUrl != nil
                ) {
                    showingFrontPhotoSources = true
                }

                photoTile(
                    title: "Back",
                    subtitle: viewModel.backPhotoUrl ?? "No back photo",
                    isUploading: viewModel.isUploadingBackPhoto,
                    hasPhoto: viewModel.backPhotoUrl != nil
                ) {
                    showingBackPhotoSources = true
                }
            }

            if let photoMessage = viewModel.photoMessage {
                successBanner(message: photoMessage)
            }
        }
        .hiqCard()
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
                Task { await viewModel.uploadPhoto(image, side: request.side) }
            }
        }
        .sheet(item: $backPhotoRequest) { request in
            CardPhotoPicker(sourceType: request.sourceType) { image in
                Task { await viewModel.uploadPhoto(image, side: request.side) }
            }
        }
    }

    private func photoTile(
        title: String,
        subtitle: String,
        isUploading: Bool,
        hasPhoto: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer(minLength: 0)
                    if isUploading {
                        ProgressView()
                            .tint(HobbyIQTheme.Colors.successGreen)
                    } else if hasPhoto {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    } else {
                        Image(systemName: "camera.viewfinder")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }

                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
            .padding(14)
            .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(hasPhoto ? HobbyIQTheme.Colors.successGreen.opacity(0.4) : HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
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

    // MARK: - Condition

    private var conditionCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Condition", icon: "shield.checkered", tint: HobbyIQTheme.Colors.electricBlue)

            HStack(spacing: 8) {
                conditionPill(title: "Raw", isSelected: viewModel.isGraded == false) {
                    withAnimation(.easeInOut(duration: 0.2)) { viewModel.isGraded = false }
                }
                conditionPill(title: "Graded", isSelected: viewModel.isGraded) {
                    withAnimation(.easeInOut(duration: 0.2)) { viewModel.isGraded = true }
                }
            }

            if viewModel.isGraded {
                HStack(spacing: 10) {
                    themedFormField("Grader", text: $viewModel.grader)
                    themedFormField("Grade", text: $viewModel.grade, keyboard: .numbersAndPunctuation)
                }
            }

            Toggle(isOn: $viewModel.isAutoCard) {
                Text("Autograph")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .tint(HobbyIQTheme.Colors.electricBlue)
        }
        .hiqCard()
    }

    // MARK: - Purchase

    private var purchaseCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Purchase", icon: "dollarsign.circle.fill", tint: HobbyIQTheme.Colors.successGreen)

            themedFormField("Purchase Price", text: $viewModel.purchasePrice, keyboard: .decimalPad)
            themedFormField("Current Value", text: $viewModel.currentValue, keyboard: .decimalPad)
            themedFormField("Purchase Location", text: $viewModel.purchaseLocation)
        }
        .hiqCard()
    }

    // MARK: - More Details

    private var moreDetailsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    viewModel.showMoreDetails.toggle()
                }
            } label: {
                HStack {
                    sectionHeader(title: "More Details", icon: "ellipsis.rectangle.fill", tint: HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Image(systemName: viewModel.showMoreDetails ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .buttonStyle(.plain)

            if viewModel.showMoreDetails {
                VStack(spacing: 12) {
                    themedFormField("Player Name", text: $viewModel.playerName)
                    themedFormField("Card Title", text: $viewModel.cardTitle)
                    themedFormField("Year", text: $viewModel.year, keyboard: .numbersAndPunctuation)
                    themedFormField("Set Name", text: $viewModel.setName)
                    themedFormField("Parallel", text: $viewModel.parallel)
                    themedFormField("Serial Number", text: $viewModel.serialNumber)
                    themedFormField("Quantity", text: $viewModel.quantity, keyboard: .numberPad)

                    Toggle(isOn: $viewModel.includePurchaseDate) {
                        Text("Add Purchase Date")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    .tint(HobbyIQTheme.Colors.electricBlue)

                    if viewModel.includePurchaseDate {
                        DatePicker(
                            "Purchase Date",
                            selection: $viewModel.purchaseDate,
                            displayedComponents: .date
                        )
                        .datePickerStyle(.compact)
                        .colorScheme(.dark)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Notes")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                        TextEditor(text: $viewModel.notes)
                            .frame(minHeight: 96)
                            .padding(12)
                            .scrollContentBackground(.hidden)
                            .background(HobbyIQTheme.Colors.steelGray.opacity(0.3))
                            .overlay(
                                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
                .padding(.top, 14)
            }
        }
        .hiqCard()
    }

    // MARK: - Save Button

    private var saveButton: some View {
        Button {
            save()
        } label: {
            HStack(spacing: 10) {
                if viewModel.isSaving {
                    ProgressView().tint(HobbyIQTheme.Colors.pureWhite)
                    Text("Saving...")
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16, weight: .semibold))
                    Text(viewModel.primaryButtonTitle)
                }
            }
            .font(HobbyIQTheme.Typography.bodyEmphasis)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .background(HobbyIQTheme.Colors.electricBlue)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.5), lineWidth: 1.5)
            )
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.3), radius: 12, x: 0, y: 6)
        }
        .buttonStyle(.plain)
        .disabled(viewModel.estimateResult == nil || viewModel.isSaving || viewModel.isUploadingFrontPhoto || viewModel.isUploadingBackPhoto || !canParsePurchasePrice)
        .opacity((viewModel.estimateResult == nil || viewModel.isSaving || viewModel.isUploadingFrontPhoto || viewModel.isUploadingBackPhoto || !canParsePurchasePrice) ? 0.5 : 1.0)
    }

    // MARK: - Search Field

    private var searchField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Card description")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            TextField("2024 Bowman Chrome Dylan Crews Auto", text: $viewModel.searchText)
                .submitLabel(.search)
                .onSubmit {
                    Task { await viewModel.searchCard() }
                }
                .textInputAutocapitalization(.words)
                .disableAutocorrection(true)
                .padding(14)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.6), lineWidth: 1)
                )

            Button {
                Task { await viewModel.searchCard() }
            } label: {
                HStack(spacing: 8) {
                    if viewModel.isSearching {
                        ProgressView().tint(HobbyIQTheme.Colors.pureWhite)
                        Text("Searching eBay sales…")
                    } else {
                        Image(systemName: "magnifyingglass")
                        Text("Search & Verify Card")
                    }
                }
                .font(.subheadline.weight(.bold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isSearching || viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).count <= 2)
            .opacity((viewModel.isSearching || viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).count <= 2) ? 0.5 : 1.0)
        }
    }

    // MARK: - Verified Banner

    private func verifiedBanner(_ estimate: CardEstimateResponse) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)

            VStack(alignment: .leading, spacing: 2) {
                Text("Verified")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)

                Text(verifiedDetailText(from: estimate))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            Spacer(minLength: 0)
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.successGreen.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.3), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func verifiedDetailText(from estimate: CardEstimateResponse) -> String {
        if let parallel = estimate.pricingAnalytics?.parallelDetected, parallel.isEmpty == false {
            return parallel
        }
        if let comps = estimate.pricingAnalytics?.compsUsed {
            return "\(comps) comps used"
        }
        return "Live pricing complete"
    }

    // MARK: - Pricing Row

    private func pricingRow(for estimate: CardEstimateResponse) -> some View {
        HStack(spacing: 8) {
            priceTile(title: "Fair Market", value: estimate.fairMarketValue, tint: HobbyIQTheme.Colors.electricBlue)
            priceTile(title: "Quick Sale", value: estimate.quickSaleValue, tint: HobbyIQTheme.Colors.warning)
            priceTile(title: "Suggested", value: estimate.premiumValue, tint: Color.purple)
        }
    }

    private func priceTile(title: String, value: Double?, tint: Color) -> some View {
        VStack(spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.5)
            Text(value.map { String(format: "$%.0f", $0) } ?? "--")
                .font(.headline.bold())
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(tint.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(tint.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    // MARK: - Reusable Components

    private func sectionHeader(title: String, icon: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.2)
        }
    }

    private func themedFormField(_ title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField(title, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.words)
                .disableAutocorrection(true)
                .padding(12)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1)
                )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func conditionPill(title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(isSelected ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(isSelected ? HobbyIQTheme.Colors.electricBlue.opacity(0.2) : HobbyIQTheme.Colors.steelGray.opacity(0.2))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(isSelected ? HobbyIQTheme.Colors.electricBlue.opacity(0.5) : HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.2)
                )
                .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func statusChip(icon: String, text: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .font(.caption)
            Text(text)
                .font(.caption)
                .foregroundStyle(tint)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.08))
        .clipShape(Capsule(style: .continuous))
    }

    private func successBanner(message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)

            Text(message)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            Spacer(minLength: 0)
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.successGreen.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.3), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private var canParsePurchasePrice: Bool {
        decimal(from: viewModel.purchasePrice) != nil
    }

    private func decimal(from value: String) -> Double? {
        let sanitized = value
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Double(sanitized)
    }

    // MARK: - Actions

    private func lookupPSACert() async {
        let cert = certNumberInput.trimmingCharacters(in: .whitespaces)
        guard !cert.isEmpty else { return }

        psaLookupState = .loading
        do {
            let resp = try await APIService.shared.fetchPSACertLookup(
                certNumber: cert
            )
            guard resp.success, let card = resp.card else {
                psaLookupState = .error(resp.error ?? "Cert not found.")
                return
            }
            if let subject = card.subject, !subject.isEmpty {
                viewModel.playerName = subject
                viewModel.searchText = subject
            }
            if let year = card.year, !year.isEmpty {
                viewModel.year = year
            }
            if let brand = card.brand, !brand.isEmpty {
                viewModel.setName = brand
            }
            if let variety = card.variety, !variety.isEmpty {
                viewModel.parallel = variety
            }
            if let cardNumber = card.cardNumber, !cardNumber.isEmpty {
                viewModel.serialNumber = cardNumber
            }
            if let grade = card.grade, !grade.isEmpty {
                viewModel.grade = grade
                viewModel.gradeValue = grade
                viewModel.isGraded = true
                viewModel.gradingCompany = "PSA"
            }
            viewModel.grader = "PSA"

            let titleParts = [
                card.year,
                card.brand,
                card.subject,
                card.variety
            ].compactMap { $0 }.filter { !$0.isEmpty }
            if !titleParts.isEmpty {
                viewModel.cardTitle = titleParts.joined(separator: " ")
                viewModel.searchText = titleParts.joined(separator: " ")
            }

            psaLookupState = .success("Auto-filled from cert \(cert) — PSA \(card.grade ?? "")")
        } catch let apiError as APIServiceError {
            psaLookupState = .error(apiError.errorDescription ?? "PSA lookup failed.")
        } catch {
            psaLookupState = .error("PSA lookup failed: \(error.localizedDescription)")
        }
    }

    private func save() {
        Task {
            let didSave = await viewModel.save()
            if didSave {
                await MainActor.run {
                    onSave?()
                }
                try? await Task.sleep(nanoseconds: 800_000_000)
                dismiss()
            }
        }
    }
}

// MARK: - Card Modifier

private extension View {
    func hiqCard() -> some View {
        self
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 4)
    }
}

#Preview {
    AddPortfolioCardView(viewModel: AddPortfolioCardViewModel())
}
