//
//  AddCardFlow.swift
//  HobbyIQ
//

import SwiftUI
import UIKit
import Foundation

struct CardUploadPayload {
    let data: Data
    let mimeType: String
}

enum CardPhotoFormat {
    static func payload(for image: UIImage) -> CardUploadPayload? {
        if let data = image.jpegData(compressionQuality: 0.86) {
            return CardUploadPayload(data: data, mimeType: "image/jpeg")
        }

        if let data = image.pngData() {
            return CardUploadPayload(data: data, mimeType: "image/png")
        }

        return nil
    }
}

enum CardPhotoSide: String, Codable, CaseIterable, Identifiable {
    case front
    case back

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .front:
            return "Front"
        case .back:
            return "Back"
        }
    }
}

struct CardPhotoPickerRequest: Identifiable, Equatable {
    let id = UUID()
    let side: CardPhotoSide
    let sourceType: UIImagePickerController.SourceType
}

struct AddCardFlow: View {
    @StateObject private var viewModel = AddPortfolioCardViewModel()

    var body: some View {
        AddPortfolioCardView(viewModel: viewModel)
    }
}

// MARK: - PSA Cert Lookup Types

struct PSACardInfo: Decodable {
    let subject: String?
    let year: String?
    let brand: String?
    let grade: String?
    let gradeDescription: String?
    let category: String?
    let cardNumber: String?
    let variety: String?
    let totalPopulation: Int?
    let populationHigher: Int?
    let certNumber: String?
    let specNumber: String?
    let labelType: String?

    private enum CodingKeys: String, CodingKey {
        case subject, year, brand, grade, gradeDescription, category
        case cardNumber, variety, totalPopulation, populationHigher
        case certNumber, specNumber, labelType
        // PascalCase variants from PSA API
        case Subject, Year, Brand, Grade, GradeDescription, Category
        case CardNumber, Variety, TotalPopulation, PopulationHigher
        case CertNumber, SpecNumber, LabelType
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        subject = try c.decodeIfPresent(String.self, forKey: .subject)
            ?? c.decodeIfPresent(String.self, forKey: .Subject)
        brand = try c.decodeIfPresent(String.self, forKey: .brand)
            ?? c.decodeIfPresent(String.self, forKey: .Brand)
        grade = try c.decodeIfPresent(String.self, forKey: .grade)
            ?? c.decodeIfPresent(String.self, forKey: .Grade)
        gradeDescription = try c.decodeIfPresent(String.self, forKey: .gradeDescription)
            ?? c.decodeIfPresent(String.self, forKey: .GradeDescription)
        category = try c.decodeIfPresent(String.self, forKey: .category)
            ?? c.decodeIfPresent(String.self, forKey: .Category)
        cardNumber = try c.decodeIfPresent(String.self, forKey: .cardNumber)
            ?? c.decodeIfPresent(String.self, forKey: .CardNumber)
        variety = try c.decodeIfPresent(String.self, forKey: .variety)
            ?? c.decodeIfPresent(String.self, forKey: .Variety)
        certNumber = try c.decodeIfPresent(String.self, forKey: .certNumber)
            ?? c.decodeIfPresent(String.self, forKey: .CertNumber)
        specNumber = try c.decodeIfPresent(String.self, forKey: .specNumber)
            ?? c.decodeIfPresent(String.self, forKey: .SpecNumber)
        labelType = try c.decodeIfPresent(String.self, forKey: .labelType)
            ?? c.decodeIfPresent(String.self, forKey: .LabelType)

        // Year can be Int or String
        if let s = try? c.decodeIfPresent(String.self, forKey: .year) { year = s }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .Year) { year = s }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .year) { year = String(i) }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .Year) { year = String(i) }
        else { year = nil }

        // Population can be Int or String
        if let i = try? c.decodeIfPresent(Int.self, forKey: .totalPopulation) { totalPopulation = i }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .TotalPopulation) { totalPopulation = i }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .totalPopulation) { totalPopulation = Int(s) }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .TotalPopulation) { totalPopulation = Int(s) }
        else { totalPopulation = nil }

        if let i = try? c.decodeIfPresent(Int.self, forKey: .populationHigher) { populationHigher = i }
        else if let i = try? c.decodeIfPresent(Int.self, forKey: .PopulationHigher) { populationHigher = i }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .populationHigher) { populationHigher = Int(s) }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .PopulationHigher) { populationHigher = Int(s) }
        else { populationHigher = nil }
    }

    init(subject: String?, year: String?, brand: String?, grade: String?,
         gradeDescription: String?, category: String?, cardNumber: String?,
         variety: String?, totalPopulation: Int?, populationHigher: Int?,
         certNumber: String? = nil, specNumber: String? = nil, labelType: String? = nil) {
        self.subject = subject; self.year = year; self.brand = brand
        self.grade = grade; self.gradeDescription = gradeDescription
        self.category = category; self.cardNumber = cardNumber
        self.variety = variety; self.totalPopulation = totalPopulation
        self.populationHigher = populationHigher; self.certNumber = certNumber
        self.specNumber = specNumber; self.labelType = labelType
    }
}

struct PSACertLookupResponse: Decodable {
    let success: Bool
    let certNumber: String?
    let error: String?
    let card: PSACardInfo?

    private enum CodingKeys: String, CodingKey {
        case success, certNumber, error, card
        case psaCert = "PSACert"
        case data
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = (try? c.decodeIfPresent(Bool.self, forKey: .success)) ?? true
        certNumber = try? c.decodeIfPresent(String.self, forKey: .certNumber)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        // Try "card", then "PSACert", then "data" key for the nested card info
        card = (try? c.decodeIfPresent(PSACardInfo.self, forKey: .card))
            ?? (try? c.decodeIfPresent(PSACardInfo.self, forKey: .psaCert))
            ?? (try? c.decodeIfPresent(PSACardInfo.self, forKey: .data))
    }

    init(success: Bool, certNumber: String?, error: String?, card: PSACardInfo?) {
        self.success = success; self.certNumber = certNumber
        self.error = error; self.card = card
    }
}

/// Envelope for PSA public API format: `{ "PSACert": { ... } }`
struct PSACertEnvelope: Decodable {
    let psaCert: PSACardInfo

    private enum CodingKeys: String, CodingKey {
        case psaCert = "PSACert"
    }
}

struct CardPhotoPicker: UIViewControllerRepresentable {
    let sourceType: UIImagePickerController.SourceType
    let onImagePicked: (UIImage) -> Void
    var onCancel: (() -> Void)? = nil
    /// P0.2 (2026-07-16, compiq-scan-route.md): shared card-outline
    /// viewfinder for scan flows. Only rendered when `sourceType == .camera`.
    /// Off by default so photo-attachment sites (add-card, listing-draft,
    /// portfolio-detail) keep the plain system camera.
    var showCardOutlineGuide: Bool = false

    func makeCoordinator() -> Coordinator {
        Coordinator(onImagePicked: onImagePicked, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = sourceType
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        picker.mediaTypes = ["public.image"]
        if sourceType == .camera && showCardOutlineGuide {
            picker.cameraOverlayView = CardOutlineOverlayView(frame: UIScreen.main.bounds)
        }
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {
        uiViewController.sourceType = sourceType
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let onImagePicked: (UIImage) -> Void
        private let onCancel: (() -> Void)?

        init(onImagePicked: @escaping (UIImage) -> Void, onCancel: (() -> Void)? = nil) {
            self.onImagePicked = onImagePicked
            self.onCancel = onCancel
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
            onCancel?()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let image = (info[.originalImage] as? UIImage) ?? (info[.editedImage] as? UIImage)
            picker.dismiss(animated: true)
            guard let image else { return }
            onImagePicked(image)
        }
    }
}

/// Dashed card-outline viewfinder overlay for `/api/compiq/scan` capture.
/// Per compiq-scan-route.md, the guide is a card-shaped rectangle (2.5:3.5)
/// not slab-shaped — slabs, raw cards, and thick-graded holders all fit
/// inside without biasing the user to any particular medium.
///
/// The overlay is passive: it does not intercept touch (`isUserInteractionEnabled = false`),
/// so the system camera's shutter, flash, and library buttons remain fully usable.
private final class CardOutlineOverlayView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isUserInteractionEnabled = false
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }

        // Card aspect: 2.5 x 3.5 inches (0.714 w:h). Fit inside 78% of screen
        // width, then center vertically at 46% (slightly above center — the
        // system camera's bottom shutter bar occupies the lower third).
        let cardAspect: CGFloat = 2.5 / 3.5
        let targetWidth = rect.width * 0.78
        let targetHeight = targetWidth / cardAspect
        let originX = (rect.width - targetWidth) / 2
        let originY = (rect.height - targetHeight) * 0.42
        let cardRect = CGRect(x: originX, y: originY, width: targetWidth, height: targetHeight)
        let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 14)

        // Dim everything outside the card rect so the guide reads as an
        // "aim here" affordance without hiding the framing subject.
        let fullPath = UIBezierPath(rect: rect)
        fullPath.append(cardPath)
        fullPath.usesEvenOddFillRule = true
        ctx.saveGState()
        UIColor.black.withAlphaComponent(0.35).setFill()
        fullPath.fill(with: .normal, alpha: 1.0)
        ctx.restoreGState()

        // Dashed white outline for the card rectangle itself.
        ctx.saveGState()
        UIColor.white.withAlphaComponent(0.9).setStroke()
        cardPath.lineWidth = 2.0
        cardPath.setLineDash([10, 6], count: 2, phase: 0)
        cardPath.stroke()
        ctx.restoreGState()
    }
}
