//
//  ActionPlanModels.swift
//  HobbyIQ
//
//  Wire models for GET /api/dailyiq/action-plan (backend PR #546).
//  Sorted per-holding verdict feed that powers the DailyIQ tab hero
//  surface — "what should I do today" across every card the user owns.
//

import Foundation
import SwiftUI

/// Verdict shipped by /action-plan. Wire values are SCREAMING_SNAKE;
/// UI uses `label` + `color` for the badge treatment.
enum ActionVerdict: String, Codable, Hashable, CaseIterable, Identifiable {
    case sellNow      = "SELL_NOW"
    case gradeUp      = "GRADE_UP"
    case listHigher   = "LIST_HIGHER"
    case waitToList   = "WAIT_TO_LIST"
    case hold         = "HOLD"

    var id: String { rawValue }

    /// Clean, non-shouty label for the badge + summary chips.
    var label: String {
        switch self {
        case .sellNow:    return "Sell Now"
        case .gradeUp:    return "Grade Up"
        case .listHigher: return "List Higher"
        case .waitToList: return "Wait"
        case .hold:       return "Hold"
        }
    }

    /// Uppercase short chip label matching the spec strip.
    var chipLabel: String {
        switch self {
        case .sellNow:    return "SELL NOW"
        case .gradeUp:    return "GRADE UP"
        case .listHigher: return "LIST HIGHER"
        case .waitToList: return "WAIT"
        case .hold:       return "HOLD"
        }
    }

    var color: Color {
        switch self {
        case .sellNow:    return HobbyIQTheme.Colors.danger
        case .gradeUp:    return HobbyIQTheme.Colors.electricBlue
        case .listHigher: return HobbyIQTheme.Colors.successGreen
        case .waitToList: return HobbyIQTheme.Colors.warning
        case .hold:       return HobbyIQTheme.Colors.mutedText
        }
    }

    /// Key used by the wire `counts` dictionary.
    var countsKey: String { rawValue }
}

struct ActionCard: Codable, Identifiable, Hashable {
    let holdingId: String
    let cardId: String?
    let playerName: String
    let cardTitle: String
    let grade: String
    let imageUrl: String?
    let verdict: ActionVerdict
    let urgency: Int
    let reason: String
    let priceTarget: Double?
    let windowClosesIn: String?
    let marketValue: Double?
    let predictedPrice: Double?
    let purchasePrice: Double?
    let unrealizedGainUsd: Double?
    let isGuestimate: Bool

    var id: String { holdingId }
}

struct ActionPlanResponse: Codable, Hashable {
    /// ISO string — never surfaced to the user directly.
    let generatedAt: String?
    let totalHoldings: Int?
    let counts: [String: Int]?
    let actions: [ActionCard]?

    /// Count for a given verdict (0 when missing from the payload).
    func count(for verdict: ActionVerdict) -> Int {
        counts?[verdict.countsKey] ?? 0
    }

    /// Actions filtered by verdict; nil filter returns all actions.
    func actions(filteredBy verdict: ActionVerdict?) -> [ActionCard] {
        let all = actions ?? []
        guard let verdict else { return all }
        return all.filter { $0.verdict == verdict }
    }
}

// MARK: - Row view

/// Single Action Plan row: thumbnail + player + card title/grade + reason
/// + verdict badge + priceTarget + optional window-closing chip. Tap fires
/// the caller-supplied handler (DailyIQ posts the `.actionPlanRowTapped`
/// notification for MainAppView to switch tabs).
struct ActionCardRow: View {
    let card: ActionCard
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 12) {
                thumbnail

                VStack(alignment: .leading, spacing: 4) {
                    // Top row: player name + verdict badge
                    HStack(alignment: .firstTextBaseline) {
                        Text(card.playerName)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        verdictBadge
                    }

                    // Card title + grade
                    Text(cardTitleLine)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)

                    // Reason (two-line, secondary)
                    Text(card.reason)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.9))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    // Trailing metadata row: price target + window closing
                    HStack(spacing: 8) {
                        if let target = card.priceTarget, target > 0 {
                            Text(formatCurrency(target))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(card.verdict.color)
                            if card.isGuestimate {
                                Text("estimate")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.6))
                                    .clipShape(Capsule(style: .continuous))
                            }
                        }
                        Spacer(minLength: 0)
                        if let window = card.windowClosesIn, window.isEmpty == false {
                            HStack(spacing: 4) {
                                Image(systemName: "clock")
                                    .font(.caption2)
                                Text(window)
                                    .font(.caption2.weight(.semibold))
                            }
                            .foregroundStyle(HobbyIQTheme.Colors.warning)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .background(HobbyIQTheme.Colors.warning.opacity(0.14))
                            .clipShape(Capsule(style: .continuous))
                        }
                    }
                    .padding(.top, 2)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(card.verdict.color.opacity(0.32), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var cardTitleLine: String {
        let grade = card.grade.trimmingCharacters(in: .whitespaces)
        if grade.isEmpty { return card.cardTitle }
        return "\(card.cardTitle) · \(grade)"
    }

    private var verdictBadge: some View {
        Text(card.verdict.label.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(card.verdict.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(card.verdict.color.opacity(0.16))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(card.verdict.color.opacity(0.55), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let urlString = card.imageUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
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
            .frame(width: 44, height: 60)
            .background(HobbyIQTheme.Colors.slateGray)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            thumbnailPlaceholder
                .frame(width: 44, height: 60)
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

    private func formatCurrency(_ value: Double) -> String {
        value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD").precision(.fractionLength(0)))
    }
}
