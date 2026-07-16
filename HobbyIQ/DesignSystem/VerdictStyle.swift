//
//  VerdictStyle.swift
//  HobbyIQ
//
//  PR #425 (2026-07-13): shared supply/demand verdict badge branding.
//  Every surface that renders a verdict (Card Detail Market Trend,
//  Portfolio Home Supply/Demand Dashboard, Signal-Weighted Totals
//  breakdown, DailyIQ Buy Candidates) reads from this helper so the
//  emoji + label + color mapping stays consistent app-wide.
//
//  iOS never derives verdicts locally — backend is authoritative. This
//  helper only maps the wire enum string to display attributes.
//

import SwiftUI

struct VerdictStyle {
    let emoji: String
    let label: String
    let color: Color

    static func from(_ verdict: String?) -> VerdictStyle {
        switch verdict?.lowercased() {
        case "strong_bull":
            return VerdictStyle(emoji: "🔥", label: "STRONG BULL", color: .green)
        case "bull":
            return VerdictStyle(emoji: "📈", label: "BULL", color: .green.opacity(0.8))
        case "supply_tight":
            return VerdictStyle(emoji: "🔒", label: "SUPPLY TIGHT", color: .blue)
        case "mixed":
            return VerdictStyle(emoji: "⚖️", label: "MIXED", color: .orange)
        case "static":
            return VerdictStyle(emoji: "→", label: "STATIC", color: .gray)
        case "oversupply":
            return VerdictStyle(emoji: "📦", label: "OVERSUPPLY", color: .orange)
        case "bear":
            return VerdictStyle(emoji: "🐻", label: "BEAR", color: .red)
        case "soft":
            return VerdictStyle(emoji: "📉", label: "SOFT", color: .red.opacity(0.8))
        case "weak":
            return VerdictStyle(emoji: "💤", label: "WEAK", color: .gray)
        default:
            // Includes "unavailable" and any unknown wire value.
            return VerdictStyle(emoji: "—", label: "—", color: .gray)
        }
    }

    /// True when the verdict warrants rendering — used to gate whole
    /// sections. `unavailable` and any unknown / missing wire value
    /// suppress the surface entirely rather than showing a muted
    /// placeholder.
    static func isRenderable(_ verdict: String?) -> Bool {
        guard let normalized = verdict?.lowercased(), normalized.isEmpty == false else { return false }
        return normalized != "unavailable" && normalized != "—"
    }
}

/// Format `salesSlopePerMonthPct` / `listingsSlopePerMonthPct` as
/// `+18%/mo` / `−9%/mo`. Uses U+2212 minus for typographic alignment.
func formatSlopePerMonth(_ pct: Double?) -> String? {
    guard let pct else { return nil }
    let sign = pct >= 0 ? "+" : "\u{2212}"
    return "\(sign)\(Int(pct.rounded()))%/mo"
}
