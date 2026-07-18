//
//  CurrentlyListingViews.swift
//  HobbyIQ
//
//  "Currently listing on eBay" section + drill-down sheet (backend
//  PR #592). Sits under the FMV headline on Card Detail; shows active
//  listing p25-p75 band vs FMV with a direction chip when they diverge
//  by more than 15%.
//

import SwiftUI
import UIKit

// MARK: - Section

/// Compact card that fetches the listing-range on task and renders a
/// single-band summary. Full-suppresses when the card has no cardId or
/// the backend returns count == 0.
struct CurrentlyListingSection: View {
    let cardId: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let cardYear: Int?
    let product: String?
    let player: String
    let cardNumber: String?

    @State private var response: ListingRangeResponse?
    @State private var showSheet: Bool = false
    @State private var loaded = false

    var body: some View {
        Group {
            if let response, let count = response.count, count > 0 {
                bodyForRenderable(response: response, count: count)
            } else {
                EmptyView()
            }
        }
        .task(id: cardId ?? "") {
            guard loaded == false else { return }
            await load()
            loaded = true
        }
        .sheet(isPresented: $showSheet) {
            if let response {
                CurrentlyListingSheet(response: response, cardTitle: displayTitle)
            }
        }
    }

    private func bodyForRenderable(response: ListingRangeResponse, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Currently listing on eBay")
                    .font(.caption.weight(.bold))
                    .tracking(0.4)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer(minLength: 6)
                directionChip(for: response.delta)
            }

            priceLine(response: response, count: count)

            metaLine(response: response, count: count)

            if response.listings?.isEmpty == false {
                Button {
                    showSheet = true
                } label: {
                    HStack(spacing: 6) {
                        Text("See listings")
                            .font(.caption.weight(.bold))
                        Image(systemName: "arrow.up.right.square")
                            .font(.caption)
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func priceLine(response: ListingRangeResponse, count: Int) -> some View {
        if count >= 4, let range = response.range {
            Text("\(currency(range.p25)) \u{2013} \(currency(range.p75))")
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        } else if let listings = response.listings, listings.isEmpty == false {
            // Thin data (1-3 listings): render actual asks inline.
            let prices = listings.prefix(3).compactMap { $0.price }.map { currency($0) }
            Text(prices.joined(separator: " \u{00B7} "))
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private func metaLine(response: ListingRangeResponse, count: Int) -> some View {
        var parts: [String] = ["\(count) active listing\(count == 1 ? "" : "s")"]
        if count >= 4, let median = response.median {
            parts.append("median \(currency(median))")
        } else if count < 4 {
            parts.append("thin data")
        }
        return Text(parts.joined(separator: " \u{00B7} "))
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }

    @ViewBuilder
    private func directionChip(for delta: ListingRangeDelta?) -> some View {
        if let delta,
           let direction = delta.direction,
           direction != .flat,
           let pct = delta.vsFmvPct {
            let color: Color = direction == .up ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.warning
            let glyph = direction == .up ? "\u{25B2}" : "\u{25BC}"
            let sign = pct >= 0 ? "+" : "\u{2212}"
            let abs = String(format: "%.1f", Swift.abs(pct))
            HStack(spacing: 4) {
                Text(glyph)
                    .font(.caption.weight(.bold))
                Text("\(sign)\(abs)% vs FMV")
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.14))
            .clipShape(Capsule(style: .continuous))
        }
    }

    private var displayTitle: String {
        var parts: [String] = []
        if let cardYear { parts.append(String(cardYear)) }
        if let product, product.isEmpty == false { parts.append(product) }
        parts.append(player)
        if let parallel, parallel.isEmpty == false { parts.append(parallel) }
        return parts.joined(separator: " ")
    }

    private func currency(_ value: Double) -> String {
        value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }

    private func load() async {
        guard let trimmed = cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
              trimmed.isEmpty == false else {
            response = nil
            return
        }
        do {
            response = try await APIService.shared.fetchListingRange(
                cardId: trimmed,
                parallel: parallel,
                gradeCompany: gradeCompany,
                gradeValue: gradeValue,
                cardYear: cardYear,
                product: product,
                player: player,
                cardNumber: cardNumber
            )
        } catch {
            response = nil
        }
    }
}

// MARK: - Drill-down sheet

struct CurrentlyListingSheet: View {
    let response: ListingRangeResponse
    let cardTitle: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        headerBlock
                        LazyVStack(spacing: 10) {
                            ForEach(response.listings ?? []) { listing in
                                listingRow(listing)
                            }
                        }
                    }
                    .padding(HobbyIQTheme.Spacing.screenPadding)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("Currently on eBay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("LISTINGS")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(cardTitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(2)
        }
    }

    private func listingRow(_ listing: ListingRangeEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            thumbnail(listing.imageUrl)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    if let price = listing.price {
                        Text(price.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0))))
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    Spacer(minLength: 4)
                    if let ends = relativeEnds(from: listing.endsAt) {
                        Text(ends)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                if let seller = listing.sellerHandle, seller.isEmpty == false {
                    Text(seller)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                if let title = listing.title, title.isEmpty == false {
                    Text(title)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                        .lineLimit(2)
                }
                if let urlString = listing.itemWebUrl,
                   let url = URL(string: urlString) {
                    Button {
                        UIApplication.shared.open(url)
                    } label: {
                        HStack(spacing: 4) {
                            Text("Open on eBay")
                                .font(.caption.weight(.bold))
                            Image(systemName: "arrow.up.right.square")
                                .font(.caption2)
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func thumbnail(_ urlString: String?) -> some View {
        if let urlString = urlString?.trimmingCharacters(in: .whitespacesAndNewlines),
           urlString.isEmpty == false,
           let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .empty, .failure:
                    thumbnailPlaceholder
                @unknown default:
                    thumbnailPlaceholder
                }
            }
            .frame(width: 52, height: 72)
            .background(HobbyIQTheme.Colors.slateGray)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
                .frame(width: 52, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    private var thumbnailPlaceholder: some View {
        ZStack {
            HobbyIQTheme.Colors.slateGray
            Image(systemName: "rectangle.on.rectangle")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private func relativeEnds(from iso: String?) -> String? {
        guard let iso, iso.isEmpty == false else { return nil }
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = isoFormatter.date(from: iso)
        if date == nil {
            let fallback = ISO8601DateFormatter()
            fallback.formatOptions = [.withInternetDateTime]
            date = fallback.date(from: iso)
        }
        guard let date else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "ends " + formatter.localizedString(for: date, relativeTo: Date())
    }
}
