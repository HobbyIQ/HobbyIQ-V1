//
//  HoldingEbayEnrichmentSection.swift
//  HobbyIQ
//
//  CF-EBAY-BROWSE-ENRICHMENT (backend PR #383, 2026-07-12) — the
//  read-side section pair rendered on any holding that was auto-created
//  from an eBay purchase and enriched via Browse API item specifics:
//
//    • "eBay specifics" key/value list (from `ebayItemAspects`)
//    • "Bought from @seller (feedback)" footer line
//
//  The whole surface self-suppresses when the underlying wire fields
//  are nil, so it's a no-op on manually-added holdings.
//

import SwiftUI

struct HoldingEbayEnrichmentSection: View {
    let card: InventoryCard

    private var aspects: [(key: String, value: String)] {
        guard let raw = card.ebayItemAspects, raw.isEmpty == false else { return [] }
        // Stable, human-friendly order: prioritize the fields collectors
        // scan first, then everything else alphabetically. Keys the
        // caller doesn't know about still render — Browse API sometimes
        // surfaces surprising fields (Autographed, Card Condition,
        // Serial Numbered, etc).
        let priority = ["Sport", "Player", "Manufacturer", "Set", "Year", "Grade",
                        "Grader", "Parallel/Variety", "Card Number", "Team", "League",
                        "Card Condition", "Autographed", "Serial Numbered"]
        let orderedKeys = raw.keys.sorted { lhs, rhs in
            let li = priority.firstIndex(of: lhs) ?? Int.max
            let ri = priority.firstIndex(of: rhs) ?? Int.max
            if li != ri { return li < ri }
            return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }
        return orderedKeys.map { ($0, raw[$0] ?? "") }
    }

    private var shouldRender: Bool {
        aspects.isEmpty == false || card.ebaySeller != nil
    }

    var body: some View {
        if shouldRender {
            VStack(alignment: .leading, spacing: 12) {
                if aspects.isEmpty == false {
                    specificsCard
                }
                if let seller = card.ebaySeller {
                    sellerFooter(seller)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    // MARK: eBay specifics

    private var specificsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("eBay specifics")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.0)
                Spacer()
            }

            VStack(spacing: 0) {
                ForEach(Array(aspects.enumerated()), id: \.offset) { idx, pair in
                    specificsRow(key: pair.key, value: pair.value)
                    if idx < aspects.count - 1 {
                        Rectangle()
                            .fill(Color.white.opacity(0.06))
                            .frame(height: 1)
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
    }

    private func specificsRow(key: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(key)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .frame(minWidth: 96, alignment: .leading)
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 6)
    }

    // MARK: Seller footer

    private func sellerFooter(_ seller: EbaySeller) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "person.crop.circle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(footerText(for: seller))
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 6)
    }

    private func footerText(for seller: EbaySeller) -> String {
        if let fb = seller.feedbackScore {
            return "Bought from @\(seller.username) (\(fb))"
        }
        return "Bought from @\(seller.username)"
    }
}
