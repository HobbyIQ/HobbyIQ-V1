import Foundation
import UIKit

struct CardScanResult: Codable {
    let cardId: String
    let cardName: String
    let playerName: String?
    let year: Int?
    let set: String?
    let grade: String?
    let gradingCompany: String?
    let certNumber: String?
    let imageUrl: String?
    let marketPrice: Double?
    let confidence: Double
}

enum CardScannerError: Error {
    case lowConfidence(Double)
    case network(String)
    case invalidResponse
}

class CardScannerService {
    static let shared = CardScannerService()
    private init() {}

    func scanCard(image: UIImage) async -> CardScanResult? {
        guard let jpegData = image.resizedAndCompressedJPEG(maxDimension: 1200, quality: 0.85) else { return nil }
        let base64 = jpegData.base64EncodedString()
        guard let url = URL(string: Env.MCP_BASE_URL + "/api/compiq/image") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let auth = Env.MCP_AUTH_HEADER {
            let (header, value) = auth
            request.setValue(value, forHTTPHeaderField: header)
        }
        let body: [String: Any] = [
            "image": base64,
            "mimeType": "image/jpeg"
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            if http.statusCode == 404 {
                // Low confidence or not recognized
                return nil
            }
            let result = try JSONDecoder().decode(CardScanResult.self, from: data)
            if result.confidence < 0.8 {
                return nil
            }
            return result
        } catch {
            return nil
        }
    }
}

private extension UIImage {
    func resizedAndCompressedJPEG(maxDimension: CGFloat, quality: CGFloat) -> Data? {
        let size = self.size
        let scale = min(1, maxDimension / max(size.width, size.height))
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        UIGraphicsBeginImageContextWithOptions(newSize, false, 1.0)
        self.draw(in: CGRect(origin: .zero, size: newSize))
        let resized = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()
        return resized?.jpegData(compressionQuality: quality)
    }
}

// Env helper for MCP_BASE_URL and optional auth header
struct Env {
    static let MCP_BASE_URL: String = {
        Bundle.main.object(forInfoDictionaryKey: "MCP_BASE_URL") as? String ?? ""
    }()
    static let MCP_AUTH_HEADER: (String, String)? = {
        if let key = Bundle.main.object(forInfoDictionaryKey: "MCP_AUTH_HEADER_KEY") as? String,
           let value = Bundle.main.object(forInfoDictionaryKey: "MCP_AUTH_HEADER_VALUE") as? String {
            return (key, value)
        }
        return nil
    }()
}
