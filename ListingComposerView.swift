// ListingComposerView.swift
// Two-step eBay listing composer wired to the actual TS backend routes:
//
//   GET  /api/ebay/status                    — { success, connected, ebayUserId?, ... }
//   GET  /api/ebay/connect/start             — { success, authUrl }
//   POST /api/ebay/listings/preview          — body: HoldingListingInput, returns { success, preview }
//   POST /api/ebay/listings/publish          — body: HoldingListingInput, returns { success, offerId, listingId, listingUrl }
//   GET  /api/ebay/listings/:offerId/status  — { success, offerId, status, listingId?, listingUrl? }
//
// All endpoints require an x-session-id header (UserDefaults "auth.sessionId").
//
// Step A: Compose → Preview — POST /preview, render returned draft.
// Step B: Publish — POST /publish only after the user taps "List on eBay".
//   On success: write listingId/listingUrl/listingStatus to the CardItem in
//   SwiftData and start polling /listings/:offerId/status every 30 s until
//   the listing reaches a terminal state.

import SwiftUI
import SwiftData

#if canImport(UIKit)
import UIKit
#endif

struct ListingComposerView: View {

    // Card being listed
    @Bindable var card: CardItem

    // Optional pricing hints — composer prefers predictedPrice72h, then
    // anchorPrice, then card.currentValue.
    var predictedPrice72h: Double?
    var anchorPrice: Double?

    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss

    // MARK: State
    @State private var step: Step = .compose
    @State private var title: String = ""
    @State private var binPrice: String = ""
    @State private var conditionLabel: String = ""
    @State private var titleError: String?
    @State private var priceError: String?
    @State private var bannerError: String?

    @State private var isPreviewing = false
    @State private var preview: ListingPreview?

    @State private var isPublishing = false
    @State private var publishResult: ListingPublishResponse?

    @State private var ebayConnected: EbayConnectionState = .unknown
    @State private var pollTask: Task<Void, Never>?

    // Backend base URL (same App Service host the rest of the app calls)
    private let backendBaseURL = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

    enum Step { case compose, preview, success }
    enum EbayConnectionState { case unknown, missing, connected }

    init(
        card: CardItem,
        predictedPrice72h: Double? = nil,
        anchorPrice: Double? = nil
    ) {
        self.card = card
        self.predictedPrice72h = predictedPrice72h
        self.anchorPrice = anchorPrice
    }

    // MARK: Body

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .compose: composeStep
                case .preview: previewStep
                case .success: successStep
                }
            }
            .navigationTitle("List on eBay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await loadInitialState() }
            .onDisappear { pollTask?.cancel() }
        }
    }

    // MARK: Step A — Compose

    private var composeStep: some View {
        Form {
            if ebayConnected == .missing {
                ebayConnectSection
            }

            Section("Title") {
                TextField("Title", text: $title, axis: .vertical)
                    .lineLimit(1...3)
                if let e = titleError {
                    Text(e).font(.caption).foregroundStyle(.red)
                }
            }

            Section("Buy It Now Price") {
                TextField("Price", text: $binPrice)
                    .keyboardType(.decimalPad)
                if let e = priceError {
                    Text(e).font(.caption).foregroundStyle(.red)
                }
                Text("Suggested: \(suggestedPriceString())")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Condition") {
                Text(conditionLabel)
                    .foregroundStyle(.secondary)
            }

            if !card.photoURLs.isEmpty {
                Section("Photos") {
                    Text("\(card.photoURLs.count) photo(s) will be sent.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let banner = bannerError {
                Section {
                    Label(banner, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }

            Section {
                Button {
                    Task { await runPreview() }
                } label: {
                    HStack {
                        if isPreviewing { ProgressView().controlSize(.small); Spacer() }
                        Text(isPreviewing ? "Previewing…" : "Preview Listing")
                            .frame(maxWidth: .infinity)
                            .font(.body.bold())
                    }
                }
                .disabled(isPreviewing || ebayConnected != .connected)
            }
        }
    }

    private var ebayConnectSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Connect your eBay account", systemImage: "link.circle.fill")
                    .font(.headline)
                Text("To list this card, sign in to eBay so we can publish on your behalf.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button {
                    Task { await openEbayOAuth() }
                } label: {
                    Text("Connect eBay")
                        .font(.subheadline.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Color.accentColor)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Step B — Preview

    private var previewStep: some View {
        Form {
            if let p = preview {
                Section("Listing") {
                    Text(p.title).font(.headline)
                    HStack { Text("Price"); Spacer(); Text(money(p.price)).bold() }
                    if !p.conditionLabel.isEmpty {
                        HStack {
                            Text("Condition"); Spacer()
                            Text(p.conditionLabel).foregroundStyle(.secondary)
                        }
                    }
                    HStack {
                        Text("Quantity"); Spacer()
                        Text("\(p.quantity)").foregroundStyle(.secondary)
                    }
                    HStack {
                        Text("Photos"); Spacer()
                        Text("\(p.imageCount)").foregroundStyle(.secondary)
                    }
                    if !p.categoryId.isEmpty {
                        HStack {
                            Text("Category"); Spacer()
                            Text(p.categoryId).foregroundStyle(.secondary)
                        }
                    }
                    if !p.marketplaceId.isEmpty {
                        HStack {
                            Text("Marketplace"); Spacer()
                            Text(p.marketplaceId).foregroundStyle(.secondary)
                        }
                    }
                }

                if !p.description.isEmpty {
                    Section("Description") {
                        Text(p.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let banner = bannerError {
                Section {
                    Label(banner, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }

            Section {
                Button {
                    Task { await runPublish() }
                } label: {
                    HStack {
                        if isPublishing { ProgressView().controlSize(.small); Spacer() }
                        Text(isPublishing ? "Publishing…" : "List on eBay")
                            .frame(maxWidth: .infinity)
                            .font(.body.bold())
                    }
                }
                .disabled(isPublishing)

                Button("Back to edit") { step = .compose }
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: Step C — Success

    private var successStep: some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)
            Text("Listed on eBay")
                .font(.title2.bold())

            if let r = publishResult {
                if let lid = r.listingId {
                    Text("Listing ID: \(lid)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let urlStr = r.listingUrl, let url = URL(string: urlStr) {
                    Link(destination: url) {
                        Text("View on eBay")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(Color.accentColor)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .padding(.horizontal)
                }
            }

            if !card.ebayListingStatus.isEmpty {
                Text("Status: \(card.ebayListingStatus.capitalized)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
            Button("Done") { dismiss() }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Color(.tertiarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)
        }
        .padding(.top, 40)
    }

    // MARK: Initial pre-fill + connection check

    private func loadInitialState() async {
        if title.isEmpty { title = defaultTitle() }
        if binPrice.isEmpty { binPrice = defaultBinPriceString() }
        if conditionLabel.isEmpty { conditionLabel = mapCondition() }
        await checkEbayConnection()
    }

    private func defaultTitle() -> String {
        var parts: [String] = []
        if let y = card.year { parts.append(String(y)) }
        let player = card.playerName.trimmingCharacters(in: .whitespaces)
        if !player.isEmpty { parts.append(player) }
        if !card.setName.isEmpty { parts.append(card.setName) }
        if !card.cardNumber.isEmpty { parts.append("#\(card.cardNumber)") }
        if !card.isRaw {
            let g = "\(card.gradingCompany) \(card.grade)".trimmingCharacters(in: .whitespaces)
            if !g.isEmpty { parts.append(g) }
        }
        return parts.joined(separator: " ")
    }

    private func defaultBinPriceString() -> String {
        let p = predictedPrice72h ?? anchorPrice ?? card.currentValue
        guard p > 0 else { return "" }
        return String(format: "%.2f", p)
    }

    private func suggestedPriceString() -> String {
        if let p = predictedPrice72h { return String(format: "$%.2f (CompIQ 72h)", p) }
        if let a = anchorPrice       { return String(format: "$%.2f (anchor)", a) }
        return String(format: "$%.2f", card.currentValue)
    }

    /// PSA 10/BGS 9.5 → Like New, PSA 9 → New other, raw → Very Good.
    private func mapCondition() -> String {
        if card.isRaw { return "Very Good" }
        let g = card.grade.trimmingCharacters(in: .whitespaces)
        if let n = Double(g) {
            if n >= 9.5 { return "Like New" }
            if n >= 8.0 { return "New other" }
        }
        return "Very Good"
    }

    // MARK: Session id

    private var sessionId: String? {
        let raw = UserDefaults.standard.string(forKey: "auth.sessionId") ?? ""
        return raw.isEmpty ? nil : raw
    }

    // MARK: eBay connection check — GET /api/ebay/status

    private func checkEbayConnection() async {
        guard let sid = sessionId else {
            ebayConnected = .missing
            bannerError = "Sign in required."
            return
        }
        guard let url = URL(string: "\(backendBaseURL)/api/ebay/status") else {
            ebayConnected = .missing
            return
        }
        var req = URLRequest(url: url)
        req.setValue(sid, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 15
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                ebayConnected = .missing
                return
            }
            let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let connected = (json["connected"] as? Bool) ?? false
            ebayConnected = connected ? .connected : .missing
        } catch {
            ebayConnected = .missing
        }
    }

    /// GET /api/ebay/connect/start → { success, authUrl }; open authUrl in Safari.
    private func openEbayOAuth() async {
        guard let sid = sessionId else {
            bannerError = "Sign in required."
            return
        }
        guard let url = URL(string: "\(backendBaseURL)/api/ebay/connect/start") else { return }
        var req = URLRequest(url: url)
        req.setValue(sid, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 15
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                bannerError = "Could not start eBay sign-in."
                return
            }
            let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            guard let authUrlStr = json["authUrl"] as? String, let authUrl = URL(string: authUrlStr) else {
                bannerError = "eBay sign-in URL was missing."
                return
            }
            #if canImport(UIKit)
            await MainActor.run { UIApplication.shared.open(authUrl) }
            #endif
        } catch {
            bannerError = "eBay sign-in failed: \(error.localizedDescription)"
        }
    }

    // MARK: Validation

    private func validateInputs() -> Bool {
        titleError = nil
        priceError = nil
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedTitle.count < 5 {
            titleError = "Title must be at least 5 characters."
        } else if trimmedTitle.count > 80 {
            titleError = "Title must be at most 80 characters."
        }
        let priceVal = Double(binPrice)
        if priceVal == nil || (priceVal ?? 0) <= 0 {
            priceError = "Enter a valid price."
        }
        return titleError == nil && priceError == nil
    }

    // MARK: Holding id (stable across launches)

    /// CardItem has no app-level UUID; we derive a stable id from SwiftData's
    /// persistentModelID URI and clean it to alphanumerics so the backend can
    /// safely use it as the eBay inventoryItemKey suffix (`hobbyiq-${id}`).
    private func holdingId() -> String {
        let raw = String(describing: card.persistentModelID)
        let alnum = raw.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        let cleaned = String(String.UnicodeScalarView(alnum))
        return String(cleaned.suffix(40))
    }

    // MARK: Build HoldingListingInput body

    private func buildListingInputBody(price: Double) -> [String: Any] {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedTitle: String = {
            if !trimmedTitle.isEmpty { return trimmedTitle }
            if !card.cardTitle.isEmpty { return card.cardTitle }
            return card.playerName
        }()

        var body: [String: Any] = [
            "holdingId":        holdingId(),
            "playerName":       card.playerName,
            "cardTitle":        resolvedTitle,
            "cardYear":         card.year ?? 0,
            "brand":            firstWord(card.setName),
            "setName":          card.setName,
            "product":          card.setName,
            "isAuto":           card.isAuto,
            "isPatch":          false,
            "isRookie":         false,
            "quantity":         1,
            "listingPrice":     price,
            "bestOfferEnabled": false
        ]
        if !card.cardNumber.isEmpty   { body["cardNumber"]   = card.cardNumber }
        if !card.parallel.isEmpty     { body["parallel"]     = card.parallel }
        if !card.serialNumber.isEmpty {
            body["serialNumber"] = card.serialNumber
            // Try to extract printRun from "47/99"
            if let slash = card.serialNumber.firstIndex(of: "/") {
                let after = card.serialNumber[card.serialNumber.index(after: slash)...]
                if let pr = Int(after.trimmingCharacters(in: .whitespaces)) {
                    body["printRun"] = pr
                }
            }
        }
        if !card.isRaw {
            if !card.grade.isEmpty          { body["grade"]          = card.grade }
            if !card.gradingCompany.isEmpty { body["gradingCompany"] = card.gradingCompany }
            if !card.certNumber.isEmpty     { body["certNumber"]     = card.certNumber }
        } else {
            body["conditionEstimate"] = conditionLabel
        }

        // First two photos → imageFrontUrl / imageBackUrl per backend contract.
        let photos = card.photoURLs.filter { !$0.isEmpty }
        if let f = photos.first { body["imageFrontUrl"] = f }
        if photos.count >= 2     { body["imageBackUrl"]  = photos[1] }
        return body
    }

    private func firstWord(_ s: String) -> String {
        s.split(separator: " ").first.map(String.init) ?? ""
    }

    // MARK: Step A action — runPreview

    private func runPreview() async {
        bannerError = nil
        guard validateInputs() else { return }
        guard let sid = sessionId else {
            bannerError = "Sign in required."
            return
        }
        guard ebayConnected == .connected else {
            bannerError = "Connect your eBay account first."
            return
        }
        isPreviewing = true
        defer { isPreviewing = false }

        let price = Double(binPrice) ?? 0
        let body = buildListingInputBody(price: price)
        do {
            let envelope: PreviewEnvelope = try await postJSON(
                path: "/api/ebay/listings/preview", body: body, sessionId: sid
            )
            guard envelope.success, let p = envelope.preview else {
                bannerError = envelope.error ?? "Preview failed."
                return
            }
            preview = p
            step = .preview
        } catch let e as ListingError {
            bannerError = e.message
        } catch {
            bannerError = "Preview failed: \(error.localizedDescription)"
        }
    }

    // MARK: Step B action — runPublish

    private func runPublish() async {
        bannerError = nil
        guard let sid = sessionId else {
            bannerError = "Sign in required."
            return
        }
        guard let p = preview else { return }
        isPublishing = true
        defer { isPublishing = false }

        let body = buildListingInputBody(price: p.price)
        do {
            let resp: ListingPublishResponse = try await postJSON(
                path: "/api/ebay/listings/publish", body: body, sessionId: sid
            )
            guard resp.success else {
                bannerError = resp.error ?? "eBay rejected the listing."
                return
            }
            publishResult = resp
            applyPublishToCard(resp)
            step = .success
            if let offerId = resp.offerId {
                startStatusPolling(offerId: offerId)
            }
        } catch let e as ListingError {
            bannerError = e.message
        } catch {
            bannerError = "Publish failed: \(error.localizedDescription)"
        }
    }

    // MARK: SwiftData write-through

    private func applyPublishToCard(_ resp: ListingPublishResponse) {
        // CardItem.status is a String (CardStatus.rawValue), not an enum.
        card.ebayListingId = resp.listingId ?? resp.offerId ?? ""
        card.ebayListingURL = resp.listingUrl ?? ""
        card.ebayListingStatus = "listed"
        card.status = CardStatus.listed.rawValue
        card.updatedAt = Date()
        try? modelContext.save()
    }

    // MARK: Status polling — every 30 s, terminal-state break

    private func startStatusPolling(offerId: String) {
        pollTask?.cancel()
        let sid = sessionId ?? ""
        guard !sid.isEmpty else { return }
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                await pollStatusOnce(offerId: offerId, sessionId: sid)
                let s = card.ebayListingStatus.lowercased()
                if s == "sold" || s == "ended" || s == "cancelled" || s == "unpublished" { break }
            }
        }
    }

    private func pollStatusOnce(offerId: String, sessionId: String) async {
        guard let encoded = offerId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "\(backendBaseURL)/api/ebay/listings/\(encoded)/status")
        else { return }

        var req = URLRequest(url: url)
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 20

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            let status = (json["status"] as? String) ?? ""
            let listingUrl = json["listingUrl"] as? String
            await MainActor.run {
                if !status.isEmpty {
                    card.ebayListingStatus = status
                }
                if let u = listingUrl, !u.isEmpty {
                    card.ebayListingURL = u
                }
                card.updatedAt = Date()
                try? modelContext.save()
            }
        } catch {
            // Swallow polling errors — never crash on background polling.
        }
    }

    // MARK: HTTP helper

    private func postJSON<R: Decodable>(path: String, body: [String: Any], sessionId: String) async throws -> R {
        guard let url = URL(string: "\(backendBaseURL)\(path)") else {
            throw ListingError(message: "Invalid backend URL.")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 30
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw ListingError(message: "No response from server.")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = (json["error"] as? String) ?? (json["message"] as? String) {
                throw ListingError(message: "\(msg) (HTTP \(http.statusCode))")
            }
            throw ListingError(message: "Server returned HTTP \(http.statusCode).")
        }
        do {
            return try JSONDecoder().decode(R.self, from: data)
        } catch {
            throw ListingError(message: "Bad response format from server.")
        }
    }

    // MARK: Formatting

    private func money(_ d: Double?) -> String {
        guard let d = d else { return "—" }
        return String(format: "$%.2f", d)
    }
}

// MARK: - Response models matching the actual backend contract

private struct PreviewEnvelope: Decodable {
    let success: Bool
    let preview: ListingPreview?
    let error: String?
}

/// Mirrors `buildListingPreview` in backend/src/services/ebay/ebayListing.service.ts.
struct ListingPreview: Decodable {
    let title: String
    let description: String
    let price: Double
    let bestOfferEnabled: Bool
    let quantity: Int
    let categoryId: String
    let marketplaceId: String

    // condition is `{ conditionId, conditionDescription? }`; flatten for display.
    let conditionLabel: String

    // images is `[{ imageUrl: String }]`; we only need a count for UI.
    let imageCount: Int

    private enum CodingKeys: String, CodingKey {
        case title, description, price, bestOfferEnabled, quantity, categoryId, marketplaceId, condition, images
    }
    private struct Condition: Decodable {
        let conditionId: String?
        let conditionDescription: String?
    }
    private struct Image: Decodable { let imageUrl: String? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title             = (try? c.decode(String.self, forKey: .title)) ?? ""
        description       = (try? c.decode(String.self, forKey: .description)) ?? ""
        price             = (try? c.decode(Double.self, forKey: .price)) ?? 0
        bestOfferEnabled  = (try? c.decode(Bool.self, forKey: .bestOfferEnabled)) ?? false
        quantity          = (try? c.decode(Int.self, forKey: .quantity)) ?? 1
        categoryId        = (try? c.decode(String.self, forKey: .categoryId)) ?? ""
        marketplaceId     = (try? c.decode(String.self, forKey: .marketplaceId)) ?? ""
        let cond          = try? c.decode(Condition.self, forKey: .condition)
        conditionLabel    = cond?.conditionDescription ?? cond?.conditionId ?? ""
        let imgs          = (try? c.decode([Image].self, forKey: .images)) ?? []
        imageCount        = imgs.count
    }
}

/// Backend returns the full EbayListingResult object directly (no envelope).
struct ListingPublishResponse: Decodable {
    let success: Bool
    let offerId: String?
    let listingId: String?
    let listingUrl: String?
    let inventoryItemKey: String?
    let error: String?
}

private struct ListingError: Error {
    let message: String
}
