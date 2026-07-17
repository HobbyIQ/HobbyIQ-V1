//
//  SoldCompsSection.swift
//  HobbyIQ
//
//  Scope 3.5 (backend PR #386) — "Recent comps" section for the holding
//  detail sheet and comp card. Backed by
//  `GET /api/portfolio/sold-comps?...`. Auto-populates filters from
//  the InventoryCard's own fields; grade accepts either "PSA 10" or
//  "PSA10" so we send the un-spaced form and let the backend normalize.
//

import SwiftUI

struct SoldCompsSection: View {
    let card: InventoryCard

    @State private var response: SoldCompsResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var comps: [SoldComp] { response?.comps ?? [] }
    private var stats: SoldCompsStats? { response?.stats }
    private var count: Int { response?.count ?? comps.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HIQSectionHeader("Recent comps")

            if isLoading && response == nil {
                loadingCard
            } else if let errorMessage {
                errorCard(errorMessage)
            } else if comps.isEmpty {
                emptyCard
            } else {
                statsHeader
                compsList
            }
        }
        .task { await load() }
    }

    // MARK: Headline

    private var statsHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .lastTextBaseline) {
                Text(stats?.medianPrice.map { $0.portfolioCurrencyText } ?? "—")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("median")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.6)
                Spacer()
                Text("\(count) sold")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if let stats {
                HStack(spacing: 12) {
                    if let mn = stats.minPrice {
                        smallStat(label: "Low", value: mn.portfolioCurrencyText)
                    }
                    if let mean = stats.meanPrice {
                        smallStat(label: "Mean", value: mean.portfolioCurrencyText)
                    }
                    if let mx = stats.maxPrice {
                        smallStat(label: "High", value: mx.portfolioCurrencyText)
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func smallStat(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.5)
            Text(value)
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    // MARK: Comps list

    private var compsList: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(comps) { comp in
                    SoldCompCard(comp: comp)
                }
            }
        }
    }

    // MARK: Loading / empty / error

    private var loadingCard: some View {
        HStack {
            Spacer()
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Spacer()
        }
        .frame(height: 88)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var emptyCard: some View {
        Text("No recent comps for this exact configuration yet.")
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func errorCard(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Data

    /// Concatenates gradeCompany + gradeValue into the unspaced form
    /// (`PSA10`, `BGS9.5`). Backend accepts either form per PR #386.
    private var gradeQueryValue: String? {
        guard let company = card.gradeCompany, company.isEmpty == false,
              let value = card.gradeValue else { return nil }
        let s = value.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(value))
            : String(format: "%.1f", value)
        return "\(company)\(s)"
    }

    private func load() async {
        guard response == nil else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let year = card.year.trimmingCharacters(in: .whitespaces)
            let set = card.setName.trimmingCharacters(in: .whitespaces)
            let player = card.playerName.trimmingCharacters(in: .whitespaces)
            // 2026-07-17: loosened from exact-config match — drop
            // `parallel` from the filter set so a Refractor Auto holding
            // matches the Base Auto pool + siblings. cardId still
            // narrows to the correct SKU when present. Variant treatment
            // can be tightened on the backend when best-effort variant
            // matching lands.
            response = try await APIService.shared.fetchSoldComps(
                year: year.isEmpty ? nil : year,
                set: set.isEmpty ? nil : set,
                parallel: nil,
                grade: gradeQueryValue,
                playerName: player.isEmpty ? nil : player,
                cardNumber: nil,
                isAuto: card.isAuto ? true : nil,
                cardId: card.cardId,
                limit: 12
            )
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Active eBay Listings section (2026-07-17, PR #544)

/// Wired to `GET /api/compiq/cards/:cardId/active-listings`. Renders the
/// top-5 by matchScore with image, price, seller, and a confidence chip
/// for grade mismatches. Empty / error / thin-cardId states all
/// self-render — never leaves the layout blank.
struct ActiveEbayListingsSection: View {
    let cardId: String?
    let gradeCompany: String?
    let gradeValue: String?

    @State private var response: ActiveListingsResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    init(cardId: String?, gradeCompany: String? = nil, gradeValue: String? = nil) {
        self.cardId = cardId
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if let cardId = trimmedCardId(), cardId.isEmpty == false {
                if isLoading && response == nil {
                    loadingState
                } else if let msg = errorMessage {
                    errorState(msg)
                } else if let listings = response?.listings, listings.isEmpty == false {
                    listingsList(Array(listings.prefix(5)))
                } else if response != nil {
                    emptyState
                } else {
                    loadingState
                }
            } else {
                // No cardId means we can't fetch — hide silently.
                EmptyView()
            }
        }
        .task(id: reloadKey) { await load() }
    }

    private var header: some View {
        HStack {
            HIQSectionHeader("Active Listings on eBay")
            Spacer(minLength: 0)
            Button {
                Task {
                    response = nil
                    await load(force: true)
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption2.weight(.bold))
                    Text("Refresh")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Refresh active listings")
        }
    }

    // MARK: - States

    private var loadingState: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small).tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading listings…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 80)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.title3)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No matching active listings — try a broader parallel")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 100)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.4))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func errorState(_ msg: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title3)
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text(msg)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 90)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.4))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Listings list

    private func listingsList(_ listings: [ActiveListing]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let total = response?.totalReported, total > 0 {
                Text("Showing \(listings.count) of \(total) match\(total == 1 ? "" : "es")")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            VStack(spacing: 6) {
                ForEach(listings) { listing in
                    listingRow(listing)
                }
            }
        }
    }

    @ViewBuilder
    private func listingRow(_ listing: ActiveListing) -> some View {
        Button {
            if let raw = listing.itemWebUrl, let url = URL(string: raw) {
                UIApplication.shared.open(url)
            }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                listingThumb(url: listing.imageUrl)
                VStack(alignment: .leading, spacing: 3) {
                    if let title = listing.title?.trimmingCharacters(in: .whitespaces),
                       title.isEmpty == false {
                        Text(title)
                            .font(.system(size: 13))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 6) {
                        if let price = listing.price {
                            Text(price.portfolioCurrencyText)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        if let seller = listing.seller,
                           let username = seller.username?.trimmingCharacters(in: .whitespaces),
                           username.isEmpty == false {
                            Text("·")
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text("@\(username)")
                                .font(.system(size: 11))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            if let pct = seller.feedbackPercentage {
                                Text("·")
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                Text(String(format: "%.1f%%", pct))
                                    .font(.system(size: 11))
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            }
                        }
                    }
                    if let chip = gradeChipCopy(listing.scoreBreakdown?.gradeMatch) {
                        HStack(spacing: 3) {
                            Text(chip.label)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(chip.color)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(chip.color.opacity(0.15))
                                .clipShape(Capsule())
                        }
                        .padding(.top, 2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right.square")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.top, 2)
            }
            .padding(HobbyIQTheme.Spacing.small)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func listingThumb(url urlString: String?) -> some View {
        Group {
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFit()
                    default:
                        thumbPlaceholder
                    }
                }
            } else {
                thumbPlaceholder
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private var thumbPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(HobbyIQTheme.Colors.steelGray.opacity(0.25))
            .overlay(
                Image(systemName: "photo")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            )
    }

    /// PR #544 spec: only chip actionable grade-signals. Silent when
    /// everything matches (`correct` / `no-signal`).
    private func gradeChipCopy(_ raw: String?) -> (label: String, color: Color)? {
        switch raw?.lowercased() {
        case "wrong-grade":
            return ("Wrong grade", HobbyIQTheme.Colors.warning)
        case "raw-but-graded":
            return ("Graded, you're Raw", HobbyIQTheme.Colors.warning)
        case "not-graded":
            return ("No grade in title", HobbyIQTheme.Colors.mutedText)
        default:
            return nil
        }
    }

    // MARK: - Fetch

    private var reloadKey: String {
        "\(cardId ?? "")|\(gradeCompany ?? "")|\(gradeValue ?? "")"
    }

    private func trimmedCardId() -> String? {
        cardId?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func load(force: Bool = false) async {
        guard let id = trimmedCardId(), id.isEmpty == false else { return }
        if response != nil && force == false { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchActiveListings(
                cardId: id,
                gradeCompany: gradeCompany,
                gradeValue: gradeValue
            )
        } catch {
            errorMessage = "eBay temporarily unavailable — try again"
        }
    }
}

// MARK: - Individual comp card

private struct SoldCompCard: View {
    let comp: SoldComp

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            thumbnail
            Text(comp.unitSalePrice.map { $0.portfolioCurrencyText } ?? "—")
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let age = comp.daysSinceSold {
                Text(ageLabel(days: age))
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(8)
        .frame(width: 110)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var thumbnail: some View {
        Group {
            if let urlString = comp.ebayImageUrl, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .empty, .failure:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 22, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default: EmptyView()
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(height: 96)
        .frame(maxWidth: .infinity)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func ageLabel(days: Int) -> String {
        if days <= 1 { return "yesterday" }
        if days < 30 { return "\(days)d ago" }
        if days < 365 { return "\(days / 30)mo ago" }
        return "\(days / 365)y ago"
    }
}
