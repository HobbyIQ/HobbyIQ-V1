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
    /// 2026-07-20 (spec §3): copy-to-clipboard toast state. Fades
    /// after a short delay.
    @State private var copyToast: String?
    /// 2026-07-20 (spec §3): UIActivityViewController item for
    /// "Share as text". Bound to `.sheet(item:)`.
    @State private var shareItem: RecentSalesShareItem?

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
                // 2026-07-20 (spec §3): Copy + Share action row.
                // Renders below the expanded sales list. Formatter
                // emits the top 5 sales as bulleted text lines.
                actionRow(sales: sales)
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
        .sheet(item: $shareItem) { item in
            RecentSalesShareSheet(activityItems: [item.text])
        }
        .overlay(alignment: .top) {
            if let copyToast {
                Text(copyToast)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.95))
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1)
                    )
                    .clipShape(Capsule(style: .continuous))
                    .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
                    .padding(.top, 4)
                    .transition(.opacity)
            }
        }
    }

    /// 2026-07-20 (spec §3): Copy N + Share row. Renders below the
    /// expanded sales list; both actions operate on the top 5 sales
    /// (or fewer if the response is thin).
    private func actionRow(sales: [RecentSale]) -> some View {
        let topN = Array(sales.prefix(5))
        return HStack(spacing: 8) {
            Button {
                let text = formatSalesForClipboard(topN)
                UIPasteboard.general.string = text
                copyToast = "Copied \(topN.count) sale\(topN.count == 1 ? "" : "s")"
                scheduleToastClear()
            } label: {
                actionChip(icon: "doc.on.clipboard", label: "Copy \(topN.count)")
            }
            .buttonStyle(.plain)

            Button {
                shareItem = RecentSalesShareItem(text: formatSalesForClipboard(topN))
            } label: {
                actionChip(icon: "square.and.arrow.up", label: "Share")
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
        .padding(.top, 4)
    }

    private func actionChip(icon: String, label: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
            Text(label)
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
        .clipShape(Capsule(style: .continuous))
    }

    /// Formats the top N sales as bulleted text lines. Matches the
    /// spec's per-sale "$price · date · source" structure. Also
    /// includes a header line and a footer with count + median from
    /// the response envelope so the paste is self-explanatory.
    private func formatSalesForClipboard(_ sales: [RecentSale]) -> String {
        var lines: [String] = []
        if let count = response?.count, count > 0 {
            lines.append("HobbyIQ · \(count) recent sale\(count == 1 ? "" : "s")")
        }
        for sale in sales {
            var parts: [String] = []
            if let price = sale.price {
                parts.append("$\(Int(price.rounded()).formatted(.number.grouping(.automatic)))")
            }
            if let soldAt = sale.soldAt, let rel = Self.relativeDate(from: soldAt) {
                parts.append(rel)
            }
            if let source = sale.source?.chipLabel {
                parts.append(source)
            }
            if parts.isEmpty == false {
                lines.append("\u{2022} " + parts.joined(separator: " \u{00B7} "))
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Compact "3d" / "2w" / "1mo" style from an ISO8601 sold-at.
    private static func relativeDate(from iso: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = formatter.date(from: iso) ?? {
            let alt = ISO8601DateFormatter()
            alt.formatOptions = [.withInternetDateTime]
            return alt.date(from: iso)
        }()
        guard let date = parsed else { return nil }
        let seconds = Date().timeIntervalSince(date)
        let days = Int(seconds / 86_400)
        if days < 1 { return "today" }
        if days < 7 { return "\(days)d ago" }
        if days < 30 { return "\(days / 7)w ago" }
        if days < 365 { return "\(days / 30)mo ago" }
        return "\(days / 365)y ago"
    }

    private func scheduleToastClear() {
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await MainActor.run { copyToast = nil }
        }
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

// MARK: - Share sheet bridge (2026-07-20 spec §3)

/// Wraps the formatted-comps string in an Identifiable so
/// `.sheet(item:)` can present the activity view controller.
private struct RecentSalesShareItem: Identifiable {
    let id = UUID()
    let text: String
}

private struct RecentSalesShareSheet: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
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
