// CF-MARKETPLACE-SEARCH iOS (Drew, 2026-08-10). Cross-storefront search
// hosted on the Storefront tab. Universally available — even free users
// can browse other sellers' inventory. Sits above the manage-storefront
// gate so the tab is useful for buyers, not just Investor/Pro Seller.
//
// Hits GET /api/marketplace/search — public endpoint, no auth required.
// The materialized marketplace_listings container is rebuilt nightly
// via marketplace-listings-refresh.yml at 07:30 UTC (see docs/GO-LIVE-CHECKLIST.md
// for the "freshness cadence" trade-off — will bump when we have real buyers).

import SwiftUI

struct StorefrontDiscoverView: View {
    @State private var query: String = ""
    @State private var results: [MarketplaceListing] = []
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var lastQuery: String = ""
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Discover storefronts")
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("Search cards across every public shop. Tap a card to view the seller.")
                        .font(HobbyIQTheme.Typography.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }

            searchField

            if loading {
                HStack {
                    Spacer()
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Spacer()
                }
                .padding(.top, HobbyIQTheme.Spacing.small)
            } else if let msg = errorMessage {
                Text(msg)
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(.red)
                    .padding(.top, HobbyIQTheme.Spacing.xSmall)
            } else if !lastQuery.isEmpty, results.isEmpty {
                Text("No listings match \"\(lastQuery)\". Try a player name, set, or year.")
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, HobbyIQTheme.Spacing.xSmall)
            } else if !results.isEmpty {
                resultsSummary
                LazyVStack(spacing: HobbyIQTheme.Spacing.xSmall) {
                    ForEach(results) { listing in
                        resultRow(listing)
                    }
                }
            } else {
                Text("Try \"griffey\", \"chrome\", \"2020 bowman\", or a card number like BCP-102.")
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, HobbyIQTheme.Spacing.xSmall)
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    // ─── search field ─────────────────────────────────────────────

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
            TextField("Search all shops…", text: $query)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                #if canImport(UIKit)
                .textInputAutocapitalization(.never)
                #endif
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .onSubmit { runSearch() }
                .onChange(of: query) { _, _ in scheduleDebouncedSearch() }
            if !query.isEmpty {
                Button {
                    query = ""
                    results = []
                    lastQuery = ""
                    errorMessage = nil
                    searchTask?.cancel()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.appBackground)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
    }

    // ─── results ──────────────────────────────────────────────────

    private var resultsSummary: some View {
        HStack {
            Text("\(results.count) result\(results.count == 1 ? "" : "s")")
                .font(HobbyIQTheme.Typography.captionEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text("Live from public shops")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.top, HobbyIQTheme.Spacing.small)
    }

    private func resultRow(_ l: MarketplaceListing) -> some View {
        HStack(alignment: .top, spacing: HobbyIQTheme.Spacing.small) {
            thumbnail(for: l)
            VStack(alignment: .leading, spacing: 2) {
                Text(l.cardTitle)
                    .font(HobbyIQTheme.Typography.bodyEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(2)
                if let grade = l.gradeDisplay {
                    Text(grade)
                        .font(HobbyIQTheme.Typography.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                HStack(spacing: 6) {
                    if let seller = l.sellerUsername {
                        Text("@\(seller)")
                            .font(HobbyIQTheme.Typography.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                    }
                    if let fmv = l.fmv {
                        Text("·")
                            .font(HobbyIQTheme.Typography.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(fmv.currencyFormatted)
                            .font(HobbyIQTheme.Typography.captionEmphasis)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(HobbyIQTheme.Spacing.small)
        .background(HobbyIQTheme.Colors.appBackground)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { openSellerStorefront(username: l.sellerUsername) }
    }

    @ViewBuilder
    private func thumbnail(for l: MarketplaceListing) -> some View {
        if let url = l.imageUrl, let parsed = URL(string: url) {
            AsyncImage(url: parsed) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().aspectRatio(contentMode: .fit)
                default:
                    thumbnailPlaceholder
                }
            }
            .frame(width: 56, height: 56)
            .background(HobbyIQTheme.Colors.appBackground)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
                .frame(width: 56, height: 56)
        }
    }

    private var thumbnailPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(HobbyIQTheme.Colors.appBackground)
            .overlay(
                Image(systemName: "photo")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.4))
            )
    }

    // ─── actions ──────────────────────────────────────────────────

    private func scheduleDebouncedSearch() {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            results = []
            lastQuery = ""
            errorMessage = nil
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000)  // 350ms debounce
            if Task.isCancelled { return }
            await runSearchAsync()
        }
    }

    private func runSearch() {
        searchTask?.cancel()
        Task { await runSearchAsync() }
    }

    private func runSearchAsync() async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else { return }
        await MainActor.run {
            loading = true
            errorMessage = nil
        }
        do {
            let listings = try await MarketplaceAPI.search(query: trimmed, limit: 50)
            await MainActor.run {
                results = listings
                lastQuery = trimmed
                loading = false
            }
        } catch {
            await MainActor.run {
                errorMessage = "Search failed: \(error.localizedDescription)"
                results = []
                loading = false
            }
        }
    }

    private func openSellerStorefront(username: String?) {
        guard let username, !username.isEmpty else { return }
        #if canImport(UIKit)
        if let url = URL(string: "https://hobby-iq.com/u/\(username)") {
            UIApplication.shared.open(url)
        }
        #endif
    }
}

// ─── model ──────────────────────────────────────────────────────

struct MarketplaceListing: Identifiable, Decodable {
    let id: String
    let sellerId: String
    let sellerUsername: String?
    let sellerPlan: String?
    let holdingId: String?
    let hobbyiqCardId: String?
    let cardTitle: String
    let playerName: String?
    let year: Int?
    let setName: String?
    let parallel: String?
    let cardNumber: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let isAuto: Bool?
    let printRun: Int?
    let fmv: Double?
    let imageUrl: String?

    var gradeDisplay: String? {
        guard let company = gradeCompany, let value = gradeValue else { return nil }
        let vTrim = value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(value))
            : String(value)
        return "\(company) \(vTrim)"
    }
}

// ─── API client ─────────────────────────────────────────────────

enum MarketplaceAPI {
    struct SearchResponse: Decodable {
        let success: Bool
        let results: [MarketplaceListing]?
        let count: Int?
        let truncated: Bool?
    }

    static func search(query: String, limit: Int = 50) async throws -> [MarketplaceListing] {
        var components = URLComponents(url: APIConfig.baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/api/marketplace/search"
        components.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components.url else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw NSError(domain: "MarketplaceAPI", code: code,
                          userInfo: [NSLocalizedDescriptionKey: "HTTP \(code)"])
        }
        let decoded = try JSONDecoder().decode(SearchResponse.self, from: data)
        return decoded.results ?? []
    }
}

// ─── helpers ────────────────────────────────────────────────────

private extension Double {
    var currencyFormatted: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = self < 1000 ? 2 : 0
        return formatter.string(from: NSNumber(value: self)) ?? "$\(self)"
    }
}
