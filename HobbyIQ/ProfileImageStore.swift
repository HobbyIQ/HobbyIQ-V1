//
//  ProfileImageStore.swift
//  HobbyIQ
//

import SwiftUI
import Combine
import PhotosUI

/// Persists a user-chosen profile image to the app's documents directory
/// and publishes it as a SwiftUI `Image` for use across the app.
@MainActor
final class ProfileImageStore: ObservableObject {
    static let shared = ProfileImageStore()

    @Published private(set) var image: UIImage?

    private let fileName = "profile_photo.jpg"

    private init() {
        image = loadFromDisk()
    }

    // MARK: - Public

    func setImage(_ uiImage: UIImage) {
        let cropped = squareCrop(uiImage)
        image = cropped
        saveToDisk(cropped)
    }

    func removeImage() {
        image = nil
        deleteFromDisk()
    }

    // MARK: - Persistence

    private var fileURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(fileName)
    }

    private func saveToDisk(_ uiImage: UIImage) {
        guard let data = uiImage.jpegData(compressionQuality: 0.85) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    private func loadFromDisk() -> UIImage? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return UIImage(data: data)
    }

    private func deleteFromDisk() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    // MARK: - Helpers

    private func squareCrop(_ source: UIImage) -> UIImage {
        let side = min(source.size.width, source.size.height)
        let origin = CGPoint(
            x: (source.size.width - side) / 2,
            y: (source.size.height - side) / 2
        )
        let cropRect = CGRect(origin: origin, size: CGSize(width: side, height: side))
        guard let cgImage = source.cgImage?.cropping(to: cropRect) else { return source }
        return UIImage(cgImage: cgImage, scale: source.scale, orientation: source.imageOrientation)
    }
}
