//
//  RecentSalesSection.swift
//  HobbyIQ
//
//  "N recent sales" collapsed section on Card Detail. Fetches
//  /recent-sales on task, hides when count == 0. Tap to expand -> full
//  scrollable list with source chips + "You" marker + Safari tap for
//  seller handles.
//

import SwiftUI
import UIKit

struct RecentSalesSection: View {
    let cardId: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    /// Passed in from parent so the section can re-fetch when the user
    /// adds a manual comp (parent bumps this to a fresh UUID string).
    let refreshToken: String

    @State private var response: RecentSalesResponse?
    @State private var isExpanded: Bool = false
    @State private var loaded = false

    var body: some View {
        Group {
            if let count = response?.count, count > 0 {
                content(count: count)
            } else {
                EmptyView()
            }
        }
        .task(id: taskKey) {
            guard loaded == false else { return }
            await load()
            loaded = true
        }
        .onChange(of: refreshToken) { _, _ in
            Task { await load() }
        }
    }

    private var taskKey: String {
        [cardId ?? "", parallel ?? "", gradeCompany ?? "", gradeValue.map { String($0) } ?? "", refreshToken]
            .joined(separator: "|")
    }

    private func content(count: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack {
                    Text("\(count) recent sale\(count == 1 ? "" : "s")")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer(minLength: 0)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded, let sales = response?.sales {
                LazyVStack(spacing: 10) {
                    ForEach(sales) { sale in
                        RecentSaleRow(sale: sale)
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func load() async {
        guard let trimmed = cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
              trimmed.isEmpty == false else {
            response = nil
            return
        }
        do {
            response = try await APIService.shared.fetchRecentSales(
                cardId: trimmed,
                parallel: parallel,
                gradeCompany: gradeCompany,
                gradeValue: gradeValue
            )
        } catch {
            response = nil
        }
    }
}

// MARK: - Row

private struct RecentSaleRow: View {
    let sale: RecentSale

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            thumbnail
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(priceString)
                        .font(.system(size: 18, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer(minLength: 4)
                    if let relative = relativeSoldAt {
                        Text(relative)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                if let title = sale.title, title.isEmpty == false {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(2)
                }
                HStack(spacing: 6) {
                    if let source = sale.source {
                        sourceChip(source)
                    }
                    if sale.isSelfContribution {
                        Text("You")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(HobbyIQTheme.Colors.successGreen.opacity(0.16))
                            .clipShape(Capsule(style: .continuous))
                    }
                    if let seller = sale.sellerHandle, seller.isEmpty == false, sale.isSelfContribution == false {
                        Button {
                            openSellerProfile(handle: seller)
                        } label: {
                            Text(seller)
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(rowOpacity)
        .background(HobbyIQTheme.Colors.slateGray.opacity(0.25))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private var priceString: String {
        guard let price = sale.price else { return "\u{2014}" }
        return price.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }

    private var rowOpacity: Double {
        guard let confidence = sale.confidence else { return 1.0 }
        return confidence < 0.7 ? 0.75 : 1.0
    }

    private func sourceChip(_ source: RecentSaleSource) -> some View {
        Text(source.chipLabel)
            .font(.caption2.weight(.bold))
            .foregroundStyle(chipColor(for: source))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(chipColor(for: source).opacity(0.14))
            .clipShape(Capsule(style: .continuous))
    }

    private func chipColor(for source: RecentSaleSource) -> Color {
        switch source {
        case .ebayUserPurchase, .ebayUserSale, .ebayBrowseEnded: return .purple
        case .manualUserEntry:                                    return HobbyIQTheme.Colors.electricBlue
        case .cardhedge:                                           return HobbyIQTheme.Colors.warning
        case .cardsight:                                           return HobbyIQTheme.Colors.mutedText
        }
    }

    private var relativeSoldAt: String? {
        guard let iso = sale.soldAt, iso.isEmpty == false else { return nil }
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
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let urlString = sale.imageUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
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
            .frame(width: 48, height: 66)
            .background(HobbyIQTheme.Colors.slateGray)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
                .frame(width: 48, height: 66)
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

    private func openSellerProfile(handle: String) {
        let trimmed = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false,
              let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "https://www.ebay.com/usr/\(encoded)") else { return }
        UIApplication.shared.open(url)
    }
}
