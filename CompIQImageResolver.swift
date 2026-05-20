// CompIQImageResolver.swift
// Resolves card images from (playerName, year, set, cardNumber) so cards
// never display a blank placeholder before the lookup pipeline has run.
//
// Strategy:
//   1. If the card already has photoURLs, use them.
//   2. Call MCP `/api/compiq/image` — server-side wrapper around Card Hedge
//      card-search + card-match. Only returns image URLs when text-match
//      confidence is >= 0.80. Server caches 7 days in blob.
//
// All network work runs off the main actor. UI updates back on @MainActor.

import Foundation
import SwiftUI

// MARK: - Resolver

actor CompIQImageResolver {

    static let shared = CompIQImageResolver()

    private static let mcpBaseURL = "https://compiq-mcp.azurewebsites.net"

    private let session: URLSession
    private var inflight: [String: Task<[String], Never>] = [:]

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 12
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        cfg.urlCache = URLCache(memoryCapacity: 16 * 1024 * 1024,
                                diskCapacity: 64 * 1024 * 1024)
        self.session = URLSession(configuration: cfg)
    }

    /// Resolve image URLs for a card. Always returns the existing photoURLs
    /// unchanged when they are non-empty — never wipes them.
    func resolve(for card: CardItem) async -> [String] {
        if !card.photoURLs.isEmpty { return card.photoURLs }

        let key = Self.cacheKey(for: card)
        if let task = inflight[key] {
            return await task.value
        }

        let task = Task { [weak self] () -> [String] in
            guard let self else { return [] }
            return await self.lookup(card: card)
        }
        inflight[key] = task
        defer { inflight[key] = nil }
        return await task.value
    }

    private func lookup(card: CardItem) async -> [String] {
        guard let url = Self.mcpImageURL(for: card) else { return [] }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return [] }
            // 200 = found; 404 = no high-confidence match (do not surface error)
            guard http.statusCode == 200 else { return [] }
            let decoded = try JSONDecoder().decode(MCPImageResponse.self, from: data)
            guard decoded.ok else { return [] }
            return decoded.image_urls
        } catch {
            return []
        }
    }

    // MARK: - Cache key + URL builders

    private static func cacheKey(for card: CardItem) -> String {
        let yr = card.year.map(String.init) ?? "x"
        return "\(card.playerName.lowercased())|\(yr)|\(card.setName.lowercased())|\(card.cardNumber.lowercased())"
    }

    /// Build the Card Hedge text-match query string from the card fields.
    static func searchQuery(for card: CardItem) -> String {
        var parts: [String] = []
        if let y = card.year { parts.append(String(y)) }
        if !card.setName.isEmpty { parts.append(card.setName) }
        parts.append(card.playerName)
        if !card.cardNumber.isEmpty { parts.append("#\(card.cardNumber)") }
        if !card.parallel.isEmpty { parts.append(card.parallel) }
        if card.isAuto { parts.append("Auto") }
        if !card.isRaw, !card.gradingCompany.isEmpty, !card.grade.isEmpty {
            parts.append("\(card.gradingCompany) \(card.grade)")
        }
        return parts.joined(separator: " ")
    }

    private static func mcpImageURL(for card: CardItem) -> URL? {
        let query = searchQuery(for: card)
        guard !query.isEmpty else { return nil }
        var comps = URLComponents(string: "\(mcpBaseURL)/api/compiq/image")
        comps?.queryItems = [
            URLQueryItem(name: "query", value: query),
            URLQueryItem(name: "player", value: card.playerName),
        ]
        return comps?.url
    }
}

// MARK: - Wire format

private struct MCPImageResponse: Decodable {
    let ok: Bool
    let image_urls: [String]
    let confidence: Double?
    let card_id: String?
}

// MARK: - Async image cache (NSCache, off main thread)

@MainActor
final class CardImageCache {
    static let shared = CardImageCache()
    private let cache = NSCache<NSURL, UIImage>()
    private init() { cache.totalCostLimit = 64 * 1024 * 1024 }

    func image(for url: URL) -> UIImage? { cache.object(forKey: url as NSURL) }
    func store(_ image: UIImage, for url: URL) {
        cache.setObject(image, forKey: url as NSURL,
                        cost: Int(image.size.width * image.size.height * 4))
    }
}

// MARK: - Reusable image view

struct CardRemoteImage: View {
    let urlString: String
    var contentMode: ContentMode = .fill

    @State private var image: UIImage?
    @State private var failed: Bool = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else if failed {
                placeholder(systemName: "photo.badge.exclamationmark")
            } else {
                placeholder(systemName: "photo")
                    .overlay(ProgressView())
            }
        }
        .task(id: urlString) { await load() }
    }

    private func placeholder(systemName: String) -> some View {
        ZStack {
            Color(.secondarySystemBackground)
            Image(systemName: systemName)
                .font(.title2)
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        guard let url = URL(string: urlString) else {
            failed = true
            return
        }
        if let cached = CardImageCache.shared.image(for: url) {
            self.image = cached
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse,
               !(200..<300).contains(http.statusCode) {
                failed = true
                return
            }
            if let img = UIImage(data: data) {
                CardImageCache.shared.store(img, for: url)
                self.image = img
            } else {
                failed = true
            }
        } catch {
            failed = true
        }
    }
}
