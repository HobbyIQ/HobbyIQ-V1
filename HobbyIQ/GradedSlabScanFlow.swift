//
//  GradedSlabScanFlow.swift
//  HobbyIQ
//

import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

/// Camera-first flow for the Dashboard "Scan a graded slab" affordance.
///
/// Pipeline (CF-COMPIQ-SCAN-ROUTE, 2026-06-30):
///   1. Launch the camera straight into the viewfinder (same routing rules
///      as `ScanFlow` — simulator + permission-denied fall back to a photo
///      library picker so the user is never stranded).
///   2. Send the captured slab image to `POST /api/compiq/scan` with
///      `hint: "graded"`. Backend runs cert-OCR and returns cert info +
///      the resolved card identity (when confident). This replaced the
///      previous on-device Vision OCR path — telemetry, matcher quality,
///      and code-path simplicity all improve when the backend owns the
///      OCR.
///   3. Present a theme-matched confirmation sheet pre-filled with what
///      was read. The cert number is editable so a mis-read is a
///      one-tap fix.
///   4. On confirm, route INTO the existing graded pipeline:
///        - cert number present -> `CertResolveView(input:)` (the same path
///          the Dashboard search bar uses for typed cert numbers; backend
///          classifies the cert, then resolves Cardsight pricing with the
///          grade pre-filled).
///        - no cert number -> `CompIQVariantPickerView(initialQuery:initialGrade:)`
///          so a slab with an unreadable cert still lands on priced comps,
///          with the detected grade carried through.
///
/// Downstream routing intentionally unchanged in this CF. A follow-up can
/// leverage `GradedSlabReading.cardId` (populated by /scan when
/// confidence is high) to short-circuit CertResolveView and land the
/// user directly on the priced comp page.
///
/// The whole flow is self-contained inside a sheet with its own
/// `NavigationStack` (mirrors `CardIdentifyView`) so the Dashboard only has
/// to flip a single `Bool` — no sheet -> navigationDestination race.

// MARK: - OCR reading model

/// Structured result of reading a graded slab label.
struct GradedSlabReading: Identifiable, Equatable {
    let id = UUID()
    var certNumber: String?
    var gradeCompany: String?
    var gradeValue: Double?
    /// Card-identity strings the backend already resolved for us. Used to
    /// build a good `fallbackQuery` when there's no usable cert number,
    /// and available to future flow-overhaul CFs that want to skip
    /// CertResolveView entirely.
    var rawLines: [String]
    /// CF-COMPIQ-SCAN-ROUTE (2026-06-30): resolved LiveMarket catalog id
    /// when `/scan` matched a card with confidence. Not consumed by the
    /// current downstream routing — reserved for a follow-up CF that
    /// short-circuits directly to `/price-by-id`.
    var cardId: String?

    init(
        certNumber: String? = nil,
        gradeCompany: String? = nil,
        gradeValue: Double? = nil,
        rawLines: [String] = [],
        cardId: String? = nil
    ) {
        self.certNumber = certNumber
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
        self.rawLines = rawLines
        self.cardId = cardId
    }

    /// Best-effort free-text description built from the recognized lines,
    /// used to seed the variant-search fallback when no cert number was read.
    /// Drops obvious label noise (company name, the grade word, pure-digit
    /// cert runs) so the query is closer to "year set player".
    var fallbackQuery: String {
        let noise: Set<String> = [
            "PSA", "BGS", "BECKETT", "SGC", "CGC", "CSG", "HGA",
            "GEM", "MT", "MINT", "GEM-MT", "GEM MT", "NM", "NM-MT", "EX",
            "AUTHENTIC", "AUTO", "POP", "CERT", "GRADED", "GRADE"
        ]
        let cleaned = rawLines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { line in
                guard line.isEmpty == false else { return false }
                let upper = line.uppercased()
                if noise.contains(upper) { return false }
                // Drop lines that are only digits (cert/serial) or only a grade.
                let stripped = upper.replacingOccurrences(of: " ", with: "")
                if stripped.allSatisfy({ $0.isNumber }) { return false }
                return true
            }
        return cleaned.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// True when the cert number looks usable for the cert-resolve path.
    var hasUsableCert: Bool {
        guard let certNumber else { return false }
        let digits = certNumber.filter(\.isNumber)
        return (7...11).contains(digits.count)
    }
}

// MARK: - Backend /scan reader

/// CF-COMPIQ-SCAN-ROUTE (2026-06-30 / PR #215): the on-device Vision
/// OCR path was replaced with a POST to `/api/compiq/scan` (hint =
/// "graded"). Backend runs cert-OCR and returns cert info + resolved
/// card identity. Rationale: telemetry (`compiq_scan_attempt` fires
/// only when /scan is called), matcher quality, and single-code-path
/// simplicity all win when the backend owns OCR. There is no local
/// fallback — an offline scan surfaces as an empty reading and the
/// user is nudged to try again once online.
enum GradedSlabOCR {
    /// Post the captured slab image to `/api/compiq/scan` and map the
    /// response into a `GradedSlabReading`. Always resolves — a network
    /// error / low-confidence result / 429 rate-limit returns an empty
    /// reading so the caller never hangs.
    static func read(from image: UIImage) async -> GradedSlabReading {
        // JPEG 0.7 keeps the base64 payload under a few hundred KB even
        // for a 12MP capture — well under the request-body ceiling.
        guard let jpeg = image.jpegData(compressionQuality: 0.7) else {
            return GradedSlabReading()
        }
        let base64 = jpeg.base64EncodedString()
        do {
            let response = try await APIService.shared.scanCard(
                imageBase64: base64,
                hint: "graded"
            )
            return reading(from: response)
        } catch {
            return GradedSlabReading()
        }
    }

    /// Map the /scan wire response into the existing `GradedSlabReading`
    /// shape so the downstream confirmation sheet + routing keep working
    /// without change. `rawLines` is synthesized from the backend's
    /// resolved card-identity fields (year/set/player/variant/number)
    /// so `fallbackQuery` still produces a useful search string when
    /// there's no cert.
    static func reading(from response: CompIQScanResponse) -> GradedSlabReading {
        let gradeValue: Double? = {
            guard let raw = response.certInfo?.grade?.trimmingCharacters(in: .whitespaces),
                  raw.isEmpty == false else { return nil }
            return Double(raw)
        }()
        let identityLines: [String] = [
            response.set,
            response.player,
            response.variant,
            response.number
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }

        return GradedSlabReading(
            certNumber: response.certInfo?.certNumber,
            gradeCompany: response.certInfo?.grader,
            gradeValue: gradeValue,
            rawLines: identityLines,
            cardId: response.cardId
        )
    }
}

// MARK: - Scan flow modifier

private enum GradedScanPhase: Equatable {
    case idle
    case camera
    case result
}

private struct GradedSlabScanFlowModifier: ViewModifier {
    @Binding var isPresented: Bool
    @ObservedObject var sessionViewModel: AppSessionViewModel

    @State private var phase: GradedScanPhase = .idle
    @State private var capturedImage: UIImage?
    @State private var cameraDenied = false

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented) { _, newValue in
                if newValue && phase == .idle {
                    route()
                } else if !newValue && phase != .idle {
                    teardown()
                }
            }
            .fullScreenCover(isPresented: cameraBinding) {
                CardPhotoPicker(
                    sourceType: .camera,
                    onImagePicked: { image in
                        capturedImage = image
                        phase = .result
                    },
                    onCancel: { endFlow() }
                )
                .ignoresSafeArea()
            }
            .sheet(isPresented: resultBinding) {
                GradedSlabResultView(
                    initialImage: capturedImage,
                    cameraDenied: cameraDenied
                )
                .environmentObject(sessionViewModel)
            }
    }

    private func route() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            cameraDenied = false
            phase = .result
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            cameraDenied = true
            phase = .result
        case .notDetermined, .authorized:
            cameraDenied = false
            phase = .camera
        @unknown default:
            cameraDenied = false
            phase = .result
        }
    }

    private var cameraBinding: Binding<Bool> {
        Binding(
            get: { phase == .camera },
            set: { newValue in
                guard !newValue, phase == .camera else { return }
                endFlow()
            }
        )
    }

    private var resultBinding: Binding<Bool> {
        Binding(
            get: { phase == .result },
            set: { newValue in
                guard !newValue, phase == .result else { return }
                endFlow()
            }
        )
    }

    private func endFlow() {
        teardown()
        isPresented = false
    }

    private func teardown() {
        phase = .idle
        capturedImage = nil
        cameraDenied = false
    }
}

extension View {
    /// Presents the graded-slab scan flow (camera -> OCR -> graded pricing)
    /// when `isPresented` flips true. See `GradedSlabScanFlowModifier`.
    func gradedSlabScanFlow(
        isPresented: Binding<Bool>,
        sessionViewModel: AppSessionViewModel
    ) -> some View {
        modifier(GradedSlabScanFlowModifier(
            isPresented: isPresented,
            sessionViewModel: sessionViewModel
        ))
    }
}

// MARK: - Result / confirmation view

/// Confirmation sheet: shows the OCR reading, lets the user correct the cert
/// number, then routes into the graded pricing pipeline within its own
/// NavigationStack.
private struct GradedSlabResultView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var image: UIImage?
    @State private var reading: GradedSlabReading?
    @State private var isReading = false
    @State private var certField = ""
    @State private var descriptionField = ""
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var navigateToResolve = false

    private let cameraDenied: Bool

    init(initialImage: UIImage?, cameraDenied: Bool) {
        self.cameraDenied = cameraDenied
        _image = State(initialValue: initialImage)
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: HobbyIQTheme.Spacing.large) {
                    heroCard

                    // CF-CERT-LOOKUP-ENTRY (2026-07-04, backend batch §2):
                    // shortcut into the cert-number-only flow when the
                    // user already knows the cert and doesn't need OCR.
                    certLookupEntry

                    if cameraDenied {
                        cameraDeniedBanner
                    }

                    if let image {
                        imagePreview(image)
                    }

                    if isReading {
                        readingProgress
                    } else if reading != nil {
                        detectionCard
                        certEntryCard
                        findButton
                    } else if image == nil {
                        emptyPrompt
                    }
                }
                .padding(HobbyIQTheme.Spacing.screenPadding)
                .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
            }
            .background(HobbyIQBackground())
            .navigationTitle("Graded Slab")
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
                bottomLibraryBar
            }
            .navigationDestination(isPresented: $navigateToResolve) {
                resolveDestination
            }
        }
        .task(id: image) {
            guard let image else { return }
            await runOCR(on: image)
        }
        .onChange(of: selectedPhotoItem) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self),
                   let picked = UIImage(data: data) {
                    image = picked
                }
            }
        }
    }

    // MARK: Destination

    @ViewBuilder
    private var resolveDestination: some View {
        let cert = certField.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedCardId = reading?.cardId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // P0.2 (2026-07-16) — cardId short-circuit per
        // compiq-scan-route.md Flow 1/2: when /scan resolved a card
        // identity with high confidence, skip CertResolveView + the
        // variant picker and land the user directly on the priced
        // comp page. The synthesized hit carries the resolved fields
        // so the downstream `priceByCardId` request uses the same
        // ids the scan-side matcher already validated.
        if resolvedCardId.isEmpty == false {
            CompIQPricedCardView(hit: syntheticHitForCardId(resolvedCardId))
                .environmentObject(sessionViewModel)
        } else if cert.isEmpty == false {
            CertResolveView(input: cert)
                .environmentObject(sessionViewModel)
        } else {
            CompIQVariantPickerView(
                initialQuery: descriptionField.trimmingCharacters(in: .whitespacesAndNewlines),
                initialGrade: detectedGradeOption
            )
            .environmentObject(sessionViewModel)
        }
    }

    private func syntheticHitForCardId(_ cardId: String) -> CompIQVariantHit {
        CompIQVariantHit(
            cardId: cardId,
            gradeCompany: reading?.gradeCompany,
            gradeValue: reading?.gradeValue,
            certNumber: reading?.certNumber
        )
    }

    private var detectedGradeOption: CompIQPricedCardView.GradeOption? {
        CompIQPricedCardView.gradeOption(
            forCompany: reading?.gradeCompany,
            value: reading?.gradeValue
        )
    }

    // MARK: OCR

    private func runOCR(on image: UIImage) async {
        isReading = true
        let result = await GradedSlabOCR.read(from: image)
        reading = result
        certField = result.certNumber ?? ""
        descriptionField = result.fallbackQuery
        isReading = false
    }

    // MARK: Hero

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Graded Card Scanner")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Photograph the label on a PSA, BGS, SGC, or CGC slab to find the card and price it at its grade.")
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

    private var certLookupEntry: some View {
        NavigationLink(destination: SlabCertLookupView().environmentObject(sessionViewModel)) {
            HStack(spacing: 8) {
                Image(systemName: "textformat.123")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("Have a cert # instead?")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: Camera-denied banner

    private var cameraDeniedBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            VStack(alignment: .leading, spacing: 4) {
                Text("Camera access is off")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("Enable camera in Settings to scan a slab, or pick a photo from your library below.")
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

    // MARK: Image preview

    private func imagePreview(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity)
            .frame(maxHeight: 260)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.0)
            )
    }

    // MARK: Reading progress

    private var readingProgress: some View {
        HStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Reading slab label...")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    // MARK: Detection summary

    private var detectionCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Detected")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            detectionRow(label: "Grader", value: reading?.gradeCompany ?? "Not detected")
            detectionRow(label: "Grade", value: gradeDisplay)
            detectionRow(label: "Cert #", value: reading?.certNumber ?? "Not detected")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.5), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func detectionRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private var gradeDisplay: String {
        guard let value = reading?.gradeValue else { return "Not detected" }
        let number = value.truncatingRemainder(dividingBy: 1) == 0
            ? String(format: "%.0f", value)
            : String(format: "%.1f", value)
        if let company = reading?.gradeCompany {
            return "\(company) \(number)"
        }
        return number
    }

    // MARK: Cert entry

    private var certEntryCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Cert number")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            TextField("e.g. 12345678", text: $certField)
                .keyboardType(.numberPad)
                .font(.body.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            Text("Edit if the scan misread it. Leave blank to search by card details instead.")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    // MARK: Find button

    private var findButton: some View {
        Button {
            navigateToResolve = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.subheadline.weight(.bold))
                Text("Find this card")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(HobbyIQTheme.Colors.electricBlue)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.3), radius: 12, x: 0, y: 6)
        }
        .buttonStyle(.plain)
        .disabled(isFindDisabled)
        .opacity(isFindDisabled ? 0.5 : 1.0)
        .accessibilityLabel("Find this card from the scanned slab")
    }

    private var isFindDisabled: Bool {
        let cert = certField.trimmingCharacters(in: .whitespacesAndNewlines)
        let desc = descriptionField.trimmingCharacters(in: .whitespacesAndNewlines)
        return cert.isEmpty && desc.isEmpty
    }

    // MARK: Empty prompt (no image yet)

    private var emptyPrompt: some View {
        VStack(spacing: 10) {
            Image(systemName: "rectangle.badge.checkmark")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text("Choose a slab photo from your library to read its label.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.large)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    // MARK: Bottom library bar

    private var bottomLibraryBar: some View {
        HStack(spacing: 12) {
            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                HStack(spacing: 8) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.subheadline.weight(.semibold))
                    Text(image == nil ? "Choose from Library" : "Use a different photo")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.5))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.5)
                )
                .clipShape(Capsule(style: .continuous))
                .contentShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.appBackground)
    }
}
