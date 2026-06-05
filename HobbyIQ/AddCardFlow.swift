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

    func makeCoordinator() -> Coordinator {
        Coordinator(onImagePicked: onImagePicked, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = sourceType
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        picker.mediaTypes = ["public.image"]
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
