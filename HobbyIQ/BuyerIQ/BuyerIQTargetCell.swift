//
//  BuyerIQTargetCell.swift
//  HobbyIQ
//
//  CF-BUYERIQ (Drew, 2026-07-31). Row cell for a card target in a
//  BuyerIQ list. Shows player + card identity, priority chip, max-
//  price cap, and status.
//

import SwiftUI

struct BuyerIQTargetCell: View {
    let target: BuyerIqTarget

    var body: some View {
        HStack(alignment: .top, spacing: HobbyIQTheme.Spacing.medium) {
            thumbnail
            VStack(alignment: .leading, spacing: 4) {
                Text(target.playerName)
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                if let subtitle = subtitleLine() {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                if let parallel = target.parallel, !parallel.isEmpty {
                    Text(parallel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.9))
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    priorityChip
                    if let cap = target.maxPrice {
                        Text("Cap $\(cap, specifier: "%.0f")")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(HobbyIQTheme.Colors.steelGray.opacity(0.25))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .clipShape(Capsule())
                    }
                    if target.status == .acquired, let price = target.acquiredPrice {
                        Text("Paid $\(price, specifier: "%.0f")")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(HobbyIQTheme.Colors.successGreen.opacity(0.25))
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                            .clipShape(Capsule())
                    }
                }
            }
            Spacer(minLength: 0)
            statusIcon
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.85))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .opacity(target.status == .passed ? 0.55 : 1.0)
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let urlString = target.imageUrl, let url = URL(string: urlString) {
            AsyncImage(url: url) { image in
                image.resizable().aspectRatio(contentMode: .fit)
            } placeholder: {
                thumbnailPlaceholder
            }
            .frame(width: 44, height: 60)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
        }
    }

    private var thumbnailPlaceholder: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(HobbyIQTheme.Colors.steelGray.opacity(0.25))
            .frame(width: 44, height: 60)
            .overlay(
                Image(systemName: "photo")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            )
    }

    private var priorityChip: some View {
        let (label, bg): (String, Color) = {
            switch target.priority {
            case .high: return ("High", HobbyIQTheme.Colors.danger)
            case .medium: return ("Med", HobbyIQTheme.Colors.warning)
            case .low: return ("Low", HobbyIQTheme.Colors.steelGray)
            }
        }()
        return Text(label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(bg.opacity(0.25))
            .foregroundStyle(bg)
            .clipShape(Capsule())
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch target.status {
        case .wanted:
            Image(systemName: "target")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
                .font(.title3)
        case .acquired:
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                .font(.title3)
        case .passed:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .font(.title3)
        }
    }

    private func subtitleLine() -> String? {
        var parts: [String] = []
        if let year = target.cardYear { parts.append(String(year)) }
        if let set = target.setName, !set.isEmpty { parts.append(set) }
        if let num = target.cardNumber, !num.isEmpty { parts.append("#\(num)") }
        if let g = target.gradeCompany, let v = target.gradeValue {
            parts.append("\(g) \(v)")
        } else if target.isAuto == true {
            parts.append("Auto")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
