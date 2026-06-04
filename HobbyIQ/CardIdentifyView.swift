//
//  CardIdentifyView.swift
//  HobbyIQ
//

import PhotosUI
import SwiftUI

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

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: HobbyIQTheme.Spacing.large) {
                    heroCard

                    captureButtons

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
        }
        .sheet(item: $selectedDetection) { detection in
            if let card = detection.card {
                NavigationStack {
                    CompIQPricedCardView(
                        hit: CompIQVariantHit(
                            cardsightCardId: card.id,
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
                }
                .environmentObject(sessionViewModel)
            }
        }
        .sheet(isPresented: $showCamera) {
            CardPhotoPicker(sourceType: .camera) { image in
                showCamera = false
                capturedImage = image
                Task { await uploadAndIdentify(image) }
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.predictions)
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

    // MARK: - Capture Buttons

    private var captureButtons: some View {
        HStack(spacing: 12) {
            Button {
                showCamera = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "camera.fill")
                        .font(.subheadline.weight(.semibold))
                    Text("Camera")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)

            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                HStack(spacing: 8) {
                    Image(systemName: "photo.on.rectangle")
                        .font(.subheadline.weight(.semibold))
                    Text("Library")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
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

            Button {
                selectedDetection = detection
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus.circle.fill")
                        .font(.caption.weight(.semibold))
                    Text("Price with CompIQ")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
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
            self.error = APIService.errorMessage(from: error)
        }
    }
}
