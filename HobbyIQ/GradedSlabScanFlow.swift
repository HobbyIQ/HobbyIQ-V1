//
//  GradedSlabScanFlow.swift
//  HobbyIQ
//

import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
@preconcurrency import Vision

/// Camera-first flow for the Dashboard "Scan a graded slab" affordance.
///
/// Pipeline:
///   1. Launch the camera straight into the viewfinder (same routing rules
///      as `ScanFlow` — simulator + permission-denied fall back to a photo
///      library picker so the user is never stranded).
///   2. Run on-device Vision OCR over the captured slab label to pull the
///      grading company (PSA / BGS / SGC / CGC), the numeric grade, and the
///      cert / serial number.
///   3. Present a theme-matched confirmation sheet pre-filled with what was
///      read. The cert number is editable so a mis-read is a one-tap fix.
///   4. On confirm, route INTO the existing graded pipeline:
///        - cert number present -> `CertResolveView(input:)` (the same path
///          the Dashboard search bar uses for typed cert numbers; backend
///          classifies the cert, then resolves Cardsight pricing with the
///          grade pre-filled).
///        - no cert number -> `CompIQVariantPickerView(initialQuery:initialGrade:)`
///          so a slab with an unreadable cert still lands on priced comps,
///          with the detected grade carried through.
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
    var rawLines: [String]

    init(
        certNumber: String? = nil,
        gradeCompany: String? = nil,
        gradeValue: Double? = nil,
        rawLines: [String] = []
    ) {
        self.certNumber = certNumber
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
        self.rawLines = rawLines
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

// MARK: - Vision OCR

enum GradedSlabOCR {
    /// Recognize text on the slab label and parse it into a `GradedSlabReading`.
    /// Runs the Vision request off the main thread; always resolves (an empty
    /// reading on failure) so the caller never hangs.
    static func read(from image: UIImage) async -> GradedSlabReading {
        guard let cgImage = image.cgImage else {
            return GradedSlabReading()
        }
        let orientation = image.cgImagePropertyOrientation

        return await withCheckedContinuation { continuation in
            let request = VNRecognizeTextRequest { request, _ in
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let lines = observations.compactMap { $0.topCandidates(1).first?.string }
                continuation.resume(returning: parse(lines: lines))
            }
            request.recognitionLevel = .accurate
            // Cert numbers and grades are not dictionary words; correction hurts.
            request.usesLanguageCorrection = false

            let handler = VNImageRequestHandler(
                cgImage: cgImage,
                orientation: orientation,
                options: [:]
            )
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    continuation.resume(returning: GradedSlabReading())
                }
            }
        }
    }

    /// Parse recognized text lines into a structured reading. Heuristic by
    /// design — the confirmation sheet lets the user correct any field.
    static func parse(lines: [String]) -> GradedSlabReading {
        let trimmed = lines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }

        return GradedSlabReading(
            certNumber: detectCertNumber(trimmed),
            gradeCompany: detectCompany(trimmed),
            gradeValue: detectGrade(trimmed),
            rawLines: trimmed
        )
    }

    // MARK: Field detectors

    private static func detectCompany(_ lines: [String]) -> String? {
        let joined = lines.joined(separator: " ").uppercased()
        // Order matters: check the longer / more specific tokens first.
        if joined.contains("BECKETT") || joined.contains("BGS") { return "BGS" }
        if joined.contains("PSA") { return "PSA" }
        if joined.contains("SGC") { return "SGC" }
        if joined.contains("CGC") { return "CGC" }
        if joined.contains("CSG") { return "CSG" }
        if joined.contains("HGA") { return "HGA" }
        return nil
    }

    /// Longest all-digit run of length 7...11 across every line. PSA certs are
    /// 8–9 digits, SGC ~10, BGS serials ~9–10; a 4-digit year never qualifies.
    private static func detectCertNumber(_ lines: [String]) -> String? {
        var best: String?
        let pattern = try? NSRegularExpression(pattern: "[0-9]{7,11}")
        for line in lines {
            guard let pattern else { break }
            let range = NSRange(line.startIndex..<line.endIndex, in: line)
            pattern.enumerateMatches(in: line, range: range) { match, _, _ in
                guard let match, let r = Range(match.range, in: line) else { return }
                let candidate = String(line[r])
                if best == nil || candidate.count > (best?.count ?? 0) {
                    best = candidate
                }
            }
        }
        return best
    }

    /// Detect the numeric grade (1...10, optional half). Prefers labeled
    /// patterns ("GEM MT 10", "MINT 9", "NM-MT 8"); falls back to a standalone
    /// 1–10 value sitting on a short line near the company/grade wording.
    private static func detectGrade(_ lines: [String]) -> Double? {
        let upper = lines.map { $0.uppercased() }

        let labeledPatterns = [
            "GEM\\s*-?\\s*MT\\s*([0-9]{1,2}(?:\\.5)?)",
            "GEM\\s*MINT\\s*([0-9]{1,2}(?:\\.5)?)",
            "MINT\\s*([0-9]{1,2}(?:\\.5)?)",
            "NM\\s*-?\\s*MT\\s*([0-9]{1,2}(?:\\.5)?)",
            "GRADE\\s*([0-9]{1,2}(?:\\.5)?)"
        ]
        for line in upper {
            for pattern in labeledPatterns {
                if let value = firstCapturedDouble(in: line, pattern: pattern),
                   (1.0...10.0).contains(value) {
                    return value
                }
            }
        }

        // Fallback: a short line whose entire content is a 1–10 (half) grade,
        // e.g. PSA's big "10" sitting alone under "GEM MT".
        for line in upper {
            let token = line.trimmingCharacters(in: .whitespaces)
            if token.count <= 4,
               let value = Double(token),
               (1.0...10.0).contains(value),
               value.truncatingRemainder(dividingBy: 0.5) == 0 {
                return value
            }
        }
        return nil
    }

    private static func firstCapturedDouble(in text: String, pattern: String) -> Double? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              match.numberOfRanges >= 2,
              let captured = Range(match.range(at: 1), in: text) else { return nil }
        return Double(text[captured])
    }
}

// MARK: - UIImage orientation bridge

private extension UIImage {
    /// Map UIKit image orientation to the CGImagePropertyOrientation Vision wants.
    var cgImagePropertyOrientation: CGImagePropertyOrientation {
        switch imageOrientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
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
        if cert.isEmpty == false {
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
