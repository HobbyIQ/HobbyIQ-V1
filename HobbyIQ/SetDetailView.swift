//
//  SetDetailView.swift
//  HobbyIQ
//
//  2026-07-20 (backend PR #623): Set / Product Detail — cards in a
//  set ranked by median FMV. User picks a product (e.g.
//  "2020 Bowman Chrome Prospects") and sees every card sorted by
//  the metric they care about. Row tap → Comp Sheet.
//
//  Endpoint: GET /api/compiq/sets/:setSlug?sport&days&limit&sortBy
//

import SwiftUI

// MARK: - Wire models

struct SetDetailResponse: Decodable {
    let setSlug: String?
    let sport: String?
    let windowDays: Int?
    let cardCount: Int?
    let totalSales: Int?
    let cards: [SetDetailCard]?

    enum CodingKeys: String, CodingKey {
        case setSlug, sport, windowDays, card_count, total_sales, cards
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        setSlug = try? c.decodeIfPresent(String.self, forKey: .setSlug)
        sport = try? c.decodeIfPresent(String.self, forKey: .sport)
        windowDays = try? c.decodeIfPresent(Int.self, forKey: .windowDays)
        cardCount = try? c.decodeIfPresent(Int.self, forKey: .card_count)
        totalSales = try? c.decodeIfPresent(Int.self, forKey: .total_sales)
        cards = try? c.decodeIfPresent([SetDetailCard].self, forKey: .cards)
    }
}

struct SetDetailCard: Decodable, Hashable, Identifiable {
    let cardId: String?
    let playerName: String?
    let cardNumber: String?
    let parallel: String?
    let cardYear: Int?
    let product: String?
    let sampleImageUrl: String?
    let salesInWindow: Int?
    let min: Double?
    let p25: Double?
    let median: Double?
    let p75: Double?
    let max: Double?

    var id: String { cardId ?? "\(cardNumber ?? "?")|\(parallel ?? "-")" }

    var displayTitle: String {
        var parts: [String] = []
        if let p = playerName { parts.append(p) }
        if let parallel, parallel.lowercased() != "base" { parts.append(parallel) }
        if let num = cardNumber { parts.append("#\(num)") }
        return parts.isEmpty ? "\u{2014}" : parts.joined(separator: " \u{00B7} ")
    }
}

/// Sort options exposed to the user. Backend accepts these strings
/// verbatim (see PR #623 route handler).
enum SetDetailSort: String, CaseIterable, Identifiable {
    case medianDesc = "median-desc"
    case medianAsc = "median-asc"
    case salesDesc = "sales-desc"
    case salesAsc = "sales-asc"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .medianDesc: return "Highest median"
        case .medianAsc: return "Lowest median"
        case .salesDesc: return "Most sold"
        case .salesAsc: return "Least sold"
        }
    }
}

/// 2026-07-20 helper: URL-slugify a set name for the endpoint path.
/// Lowercase + non-alphanumerics collapsed to a single hyphen. Not
/// a perfect Unicode-safe implementation, but covers the sports-card
/// domain (mostly ASCII product names).
enum SetSlug {
    static func from(setName: String, year: Int? = nil) -> String {
        var raw = setName
        if let year, raw.contains(String(year)) == false {
            raw = "\(year) \(raw)"
        }
        let allowed = CharacterSet.alphanumerics
        let lowered = raw.lowercased()
        var scalars = String.UnicodeScalarView()
        var lastWasHyphen = false
        for u in lowered.unicodeScalars {
            if allowed.contains(u) {
                scalars.append(u)
                lastWasHyphen = false
            } else if lastWasHyphen == false {
                scalars.append(Unicode.Scalar("-"))
                lastWasHyphen = true
            }
        }
        return String(scalars).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

// MARK: - View

struct SetDetailView: View {
    let setSlug: String

    @State private var sortBy: SetDetailSort = .medianDesc
    @State private var response: SetDetailResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var navigateCardId: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                summaryHeader
                sortRow
                if isLoading && response == nil {
                    loadingState
                } else if let errorMessage {
                    errorState(errorMessage)
                } else if let cards = response?.cards, cards.isEmpty == false {
                    ForEach(cards) { card in
                        cardRow(card)
                    }
                } else if response != nil {
                    emptyState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .navigationTitle(response?.setSlug ?? setSlug)
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task(id: sortBy.rawValue) {
            await reload()
        }
        .navigationDestination(item: $navigateCardId) { cardId in
            CompIQPricedCardView(hit: CompIQVariantHit(cardId: cardId))
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var summaryHeader: some View {
        if let response {
            VStack(alignment: .leading, spacing: 4) {
                Text(setSlug.replacingOccurrences(of: "-", with: " ").capitalized)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                HStack(spacing: 12) {
                    if let count = response.cardCount {
                        stat(label: "Cards", value: "\(count.formatted(.number.grouping(.automatic)))")
                    }
                    if let sales = response.totalSales {
                        stat(label: "Sales (last \(response.windowDays ?? 90)d)", value: "\(sales.formatted(.number.grouping(.automatic)))")
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func stat(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2.weight(.bold))
                .tracking(0.4)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    // MARK: - Sort row

    private var sortRow: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Sort", selection: $sortBy) {
                    ForEach(SetDetailSort.allCases) { s in
                        Text(s.label).tag(s)
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(sortBy.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1)
                )
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
    }

    // MARK: - Row

    private func cardRow(_ card: SetDetailCard) -> some View {
        Button {
            navigateCardId = card.cardId
        } label: {
            HStack(spacing: 10) {
                if let url = card.sampleImageUrl.flatMap(URL.init(string:)) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                        default:
                            Color.clear
                        }
                    }
                    .frame(width: 36, height: 50)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.displayTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(1)
                    if let sales = card.salesInWindow {
                        Text("\(sales) sales")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer(minLength: 0)
                if let median = card.median {
                    Text(dollars(median))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                } else {
                    Text("\u{2014}")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            }
            .padding(.vertical, 8)
            .padding(.horizontal, HobbyIQTheme.Spacing.small)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(card.cardId == nil)
    }

    private func dollars(_ value: Double) -> String {
        "$\(Int(value.rounded()).formatted(.number.grouping(.automatic)))"
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading set\u{2026}")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "square.stack.3d.up")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No cards indexed for this set.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title3)
                .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.8))
            Text("Couldn't load this set.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    // MARK: - Reload

    private func reload() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchSetDetail(
                setSlug: setSlug,
                sport: "baseball",
                days: 90,
                limit: 50,
                sortBy: sortBy.rawValue
            )
        } catch {
            errorMessage = "The server didn't respond in time."
        }
    }
}
