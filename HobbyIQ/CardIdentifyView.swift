//
//  CardIdentifyView.swift
//  HobbyIQ
//

import PhotosUI
import SwiftUI

extension Notification.Name {
    /// Posted when a Cardsight detection is saved into inventory via the
    /// CardIdentifyView "Save to inventory" affordance. MainAppView listens
    /// and (a) switches to the Inventory tab, (b) refreshes the portfolio
    /// view model so the new holding appears with its photo thumbnail.
    static let inventoryHoldingSaved = Notification.Name("hobbyiq.inventory.holdingSaved")

    /// Posted when a portfolio holding is successfully marked sold (backend
    /// confirmed). The Financials tab (ERPHubView) is kept mounted across
    /// tab switches, so its `.task { loadAll() }` only fires once — this
    /// notification lets it re-fetch P&L/timeseries after a sale so the
    /// user isn't stuck on stale numbers until they pull-to-refresh.
    static let portfolioSaleRecorded = Notification.Name("hobbyiq.portfolio.saleRecorded")

    /// Posted when a purchase is imported (eBay sync) or manually added.
    /// Same reason as `.portfolioSaleRecorded`: mounted-tab views need a
    /// nudge to re-fetch cogs / cashFlow / recent purchases without
    /// waiting for pull-to-refresh.
    static let portfolioPurchaseRecorded = Notification.Name("hobbyiq.portfolio.purchaseRecorded")

    /// PR #546 (2026-07-17): posted by the DailyIQ Action Plan hero when
    /// the user taps an action row. MainAppView switches to the Inventory
    /// tab so the user can drill in from familiar navigation. Deep-link
    /// to the specific holding sheet is a follow-up.
    static let actionPlanRowTapped = Notification.Name("hobbyiq.dailyiq.actionPlanRowTapped")
}

struct CardIdentifyView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var capturedImage: UIImage?
    @State private var showCamera = false
    @State private var identifyResponse: CardIdentifyResponse?
    @State private var isUploading = false
    @State private var isIdentifying = false
    @State private var error: String?
    @State private var showUpgradePaywall = false
    @State private var selectedDetection: CardIdentifyDetection?
    @State private var hasUploadedInitialImage = false
    /// Permanent blob URL produced by the identify SAS upload, captured so the
    /// "Save to inventory" handler can attach the same image to the new holding.
    @State private var identifyBlobUrl: String?
    /// Per-detection ID for the in-flight save (or last-saved). Single source of
    /// truth for the save button's disabled/spinner/success state so a tap can
    /// only persist one holding per detection. Collectors who want duplicates
    /// can tap a sibling detection or re-scan — we never block intentional dupes.
    @State private var savingDetectionId: String?
    @State private var savedDetectionIds: Set<String> = []
    @State private var saveErrorMessage: String?
    private let initialImage: UIImage?
    private let cameraDenied: Bool

    init(initialImage: UIImage? = nil, cameraDenied: Bool = false) {
        self.initialImage = initialImage
        self.cameraDenied = cameraDenied
        if let initialImage {
            self._capturedImage = State(initialValue: initialImage)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: HobbyIQTheme.Spacing.large) {
                    heroCard

                    if cameraDenied {
                        cameraDeniedBanner
                    }

                    if let image = capturedImage {
                        imagePreview(image)
                    }

                    if isUploading || isIdentifying {
                        HStack(spacing: 10) {
                            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                            Text(isUploading ? "Uploading image..." : "Identifying card...")
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Spacer()
                        }
                        .padding(HobbyIQTheme.Spacing.medium)
                        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
                    }

                    if let error {
                        identifyErrorBanner(error)
                    }

                    if let response = identifyResponse {
                        responseSection(response)
                    }
                }
                .padding(HobbyIQTheme.Spacing.screenPadding)
                .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
            }
            .background(HobbyIQBackground())
            .navigationTitle("Scan Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
            .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                bottomCameraBar
            }
        }
        .task(id: initialImage) {
            // When the caller hands us a pre-captured image (e.g. the dashboard's
            // direct-camera scan flow), feed it straight into the existing
            // SAS-upload -> identify pipeline. Camera launch is no longer the
            // view's responsibility; the ScanFlow coordinator owns that.
            guard let initialImage, !hasUploadedInitialImage else { return }
            hasUploadedInitialImage = true
            await uploadAndIdentify(initialImage)
        }
        // CF-PAGES-NOT-SHEETS (2026-07-04): identified card now pushes
        // as a page onto the parent's NavigationStack (bottom tab bar
        // stays visible, swipe-back works, native back button).
        .navigationDestination(item: $selectedDetection) { detection in
            if let card = detection.card {
                CompIQPricedCardView(
                    hit: CompIQVariantHit(
                        cardId: card.id,
                        player: card.name,
                        set: card.setName,
                        year: card.year.flatMap { Int($0) },
                        number: card.number,
                        variant: card.parallel?.name,
                        title: nil,
                        displayLabel: [card.year, card.setName, card.name, card.number, card.parallel?.name]
                            .compactMap { $0 }
                            .joined(separator: " "),
                        imageUrl: nil
                    )
                )
                .environmentObject(sessionViewModel)
            }
        }
        .sheet(isPresented: $showCamera) {
            CardPhotoPicker(
                sourceType: .camera,
                onImagePicked: { image in
                    showCamera = false
                    capturedImage = image
                    Task { await uploadAndIdentify(image) }
                },
                showCardOutlineGuide: true
            )
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedCap.scansPerMonth
                    .upgradeTier(from: sessionViewModel.activeTier)
                    ?? .collector
            )
        }
        .onChange(of: selectedPhotoItem) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self),
                   let image = UIImage(data: data) {
                    capturedImage = image
                    await uploadAndIdentify(image)
                }
            }
        }
    }

    // MARK: - Hero

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Card Scanner")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Take a photo or select from your library to identify a card using Cardsight.")
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.18), radius: 18, x: 0, y: 10)
    }

    // MARK: - Camera-denied banner

    /// Shown when the ScanFlow coordinator detected that camera permission is
    /// .denied / .restricted. Steers the user to Settings while leaving the
    /// library path on the bottom toolbar fully usable.
    private var cameraDeniedBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            VStack(alignment: .leading, spacing: 4) {
                Text("Camera access is off")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("Enable camera in Settings to scan, or pick a card from your library below.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Text("Open Settings")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open the system Settings app to enable camera access")
            }
            Spacer(minLength: 0)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.warning.opacity(0.15))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.5), lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Bottom camera bar

    /// Bottom-anchored toolbar styled after the native iOS Camera app:
    /// the library shortcut sits at the leading edge (replaces the camera
    /// roll thumbnail), and a prominent re-open-camera shutter button
    /// occupies the trailing edge for retakes after the auto-launched
    /// camera is dismissed.
    private var bottomCameraBar: some View {
        HStack(spacing: 12) {
            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                HStack(spacing: 8) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.subheadline.weight(.semibold))
                    Text("Choose from Library")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.5))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
                )
                .clipShape(Capsule(style: .continuous))
                .contentShape(Capsule(style: .continuous))
            }
            .accessibilityLabel("Choose a photo from your library")

            Spacer()

            Button {
                showCamera = true
            } label: {
                Image(systemName: "camera.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(width: 56, height: 56)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Circle())
                    .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 12, x: 0, y: 6)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open camera")
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
        .padding(.vertical, HobbyIQTheme.Spacing.medium)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                .frame(height: 1)
        }
    }

    // MARK: - Image Preview

    private func imagePreview(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxHeight: 240)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
    }

    // MARK: - Response

    @ViewBuilder
    private func responseSection(_ response: CardIdentifyResponse) -> some View {
        if let messages = response.messages, !messages.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(messages) { msg in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: msg.type == "error" ? "exclamationmark.triangle.fill" : "info.circle.fill")
                            .foregroundStyle(msg.type == "error" ? HobbyIQTheme.Colors.danger : HobbyIQTheme.Colors.electricBlue)
                        Text(msg.message ?? "")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }

        if let requestId = response.requestId {
            HStack {
                Text("Request: \(requestId.prefix(12))…")
                    .font(.caption2.weight(.medium).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                if let time = response.processingTime {
                    Text(String(format: "%.1fs", time / 1000))
                        .font(.caption2.weight(.medium).monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }

        if let detections = response.detections, !detections.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "rectangle.stack.badge.checkmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    Text("\(detections.count) Detection\(detections.count == 1 ? "" : "s")")
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }

                ForEach(detections) { detection in
                    detectionCard(detection)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        } else if response.success == true {
            VStack(spacing: 8) {
                Image(systemName: "viewfinder.rectangular")
                    .font(.title)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("No cards detected in this image.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .frame(maxWidth: .infinity)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
    }

    private func detectionCard(_ detection: CardIdentifyDetection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    if let name = detection.card?.name {
                        Text(name)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    let subtitle = [detection.card?.year, detection.card?.setName, detection.card?.number]
                        .compactMap { $0 }
                        .joined(separator: " · ")
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer()
                if let conf = detection.confidence {
                    Text(conf)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(confidenceColor(conf).opacity(0.3))
                        .clipShape(Capsule())
                }
            }

            if let card = detection.card {
                if let manufacturer = card.manufacturer {
                    identifyDataRow(label: "Manufacturer", value: manufacturer)
                }
                if let release = card.releaseName {
                    identifyDataRow(label: "Release", value: release)
                }
                if let setName = card.setName {
                    identifyDataRow(label: "Set", value: setName)
                }
                if let parallel = card.parallel {
                    identifyDataRow(label: "Parallel", value: parallel.name ?? parallel.id ?? "")
                    if let numberedTo = parallel.numberedTo {
                        identifyDataRow(label: "Numbered To", value: "/\(numberedTo)")
                    }
                }
                if let segmentId = card.segmentId {
                    identifyDataRow(label: "Segment", value: segmentId)
                }
            }

            if let grading = detection.grading {
                VStack(alignment: .leading, spacing: 4) {
                    Text("GRADING")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(0.8)
                    if let company = grading.company?.name {
                        identifyDataRow(label: "Company", value: company)
                    }
                    if let grade = grading.grade {
                        identifyDataRow(label: "Grade", value: [grade.value, grade.condition].compactMap { $0 }.joined(separator: " — "))
                    }
                    if let conf = grading.confidence {
                        identifyDataRow(label: "Confidence", value: conf)
                    }
                    if let qualifier = grading.qualifier?.code {
                        identifyDataRow(label: "Qualifier", value: qualifier)
                    }
                    if let auto = grading.autoGrade {
                        identifyDataRow(label: "Auto Grade", value: [auto.value, auto.condition].compactMap { $0 }.joined(separator: " — "))
                    }
                }
            }

            HStack(spacing: 8) {
                saveToInventoryButton(for: detection)

                Button {
                    selectedDetection = detection
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chart.bar.fill")
                            .font(.caption.weight(.semibold))
                        Text("Price with CompIQ")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                    .clipShape(Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Price this card with CompIQ")
            }

            if let saveErrorMessage, savingDetectionId == nil {
                Text(saveErrorMessage)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    @ViewBuilder
    private func saveToInventoryButton(for detection: CardIdentifyDetection) -> some View {
        let isSaving = savingDetectionId == detection.id
        let isSaved = savedDetectionIds.contains(detection.id)
        let canSave = identifyBlobUrl != nil && !isSaving && !isSaved

        Button {
            Task { await saveDetectionToInventory(detection) }
        } label: {
            HStack(spacing: 6) {
                if isSaving {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(HobbyIQTheme.Colors.electricBlue)
                } else if isSaved {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption.weight(.semibold))
                } else {
                    Image(systemName: "plus.circle.fill")
                        .font(.caption.weight(.semibold))
                }
                Text(isSaved ? "Saved" : (isSaving ? "Saving…" : "Save to inventory"))
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(isSaved ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(
                isSaved
                    ? HobbyIQTheme.Colors.successGreen.opacity(0.16)
                    : HobbyIQTheme.Colors.electricBlue.opacity(canSave ? 0.85 : 0.35)
            )
            .clipShape(Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canSave)
        .accessibilityLabel(isSaved ? "Already saved to inventory" : "Save this card to your inventory")
    }

    /// Persists the detection as a new InventoryCard via the EXISTING
    /// AddPortfolioCardViewModel.save() path. Seeded from the detection +
    /// the SAS upload's permanent blob URL so the photo lands on the
    /// holding as imageFrontUrl. On success: notify the host (MainAppView)
    /// to switch to the inventory tab + refresh, then dismiss the
    /// identify sheet. Disables the button while in flight to guard
    /// double-saves; intentional duplicates are still allowed via a
    /// sibling detection or a re-scan.
    private func saveDetectionToInventory(_ detection: CardIdentifyDetection) async {
        guard let blobUrl = identifyBlobUrl else {
            saveErrorMessage = "Photo upload didn't complete — try again."
            return
        }
        guard !savedDetectionIds.contains(detection.id) else { return }

        savingDetectionId = detection.id
        saveErrorMessage = nil
        defer { savingDetectionId = nil }

        let viewModel = AddPortfolioCardViewModel()
        viewModel.seed(fromIdentifyDetection: detection, blobUrl: blobUrl)
        let didSave = await viewModel.save()

        if didSave {
            savedDetectionIds.insert(detection.id)
            NotificationCenter.default.post(
                name: .inventoryHoldingSaved,
                object: nil
            )
            dismiss()
        } else {
            saveErrorMessage = viewModel.errorMessage ?? "Could not save right now."
        }
    }

    private func identifyDataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        }
    }

    private func confidenceColor(_ conf: String) -> Color {
        switch conf.lowercased() {
        case "high": return HobbyIQTheme.Colors.successGreen
        case "medium": return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.danger
        }
    }

    private func identifyErrorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.danger)
            Text(message)
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.danger.opacity(0.25))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.danger.opacity(0.3), lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Upload & Identify Flow

    private func uploadAndIdentify(_ image: UIImage) async {
        error = nil
        identifyResponse = nil
        identifyBlobUrl = nil
        savedDetectionIds = []
        saveErrorMessage = nil

        guard let jpegData = image.jpegData(compressionQuality: 0.85) else {
            error = "Could not encode image."
            return
        }

        isUploading = true
        do {
            let sasResponse = try await APIService.shared.requestCardPhotoSAS(fileExtension: "jpg")
            guard let uploadUrl = sasResponse.uploadUrl, let blobUrl = sasResponse.blobUrl else {
                error = "Server did not return upload URLs."
                isUploading = false
                return
            }

            try await APIService.shared.uploadImageToSAS(
                uploadUrl: uploadUrl,
                imageData: jpegData,
                contentType: sasResponse.contentType ?? "image/jpeg"
            )
            isUploading = false

            // Hold on to the permanent blob URL so the per-detection
            // "Save to inventory" handler can attach the same image to
            // the new holding without re-uploading.
            identifyBlobUrl = blobUrl

            isIdentifying = true
            let request = CardIdentifyRequest(
                blobUrl: blobUrl,
                blobName: sasResponse.blobName,
                extractCert: true
            )
            identifyResponse = try await APIService.shared.identifyCard(request: request)
            isIdentifying = false
        } catch {
            isUploading = false
            isIdentifying = false
            if let apiError = error as? APIServiceError,
               case .httpError(let code, _) = apiError, code == 402 {
                self.error = "You've used your monthly scan limit. Upgrade for unlimited scans."
                showUpgradePaywall = true
            } else {
                self.error = APIService.errorMessage(from: error)
            }
        }
    }
}
