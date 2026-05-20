//
//  Labels.swift
//  HobbyIQ
//

import Foundation

/// Centralized, age-adaptive display strings.
///
/// Usage: `Text(Labels.roi)` or `detailRow(title: Labels.roi, ...)`
///
/// Reads `AgeTier.current` from UserDefaults on every access.
/// Since tier changes are extremely rare (only on explicit user action),
/// and SwiftUI will re-evaluate bodies when navigating back from settings,
/// this is performant and always correct.
enum Labels {

    // MARK: - Financial Metrics

    static var roi: String {
        tier == .young ? "Return" : "ROI"
    }

    static var costBasis: String {
        tier == .young ? "Total Spent" : "Cost Basis"
    }

    static var profitLoss: String {
        tier == .young ? "Profit / Loss" : "P/L"
    }

    static var margin: String {
        tier == .young ? "Profit %" : "Margin"
    }

    static var fairValue: String {
        tier == .young ? "What It's Worth" : "Fair Value"
    }

    static var confidence: String {
        tier == .young ? "Accuracy" : "Confidence"
    }

    static var liveEstimate: String {
        tier == .young ? "Live Price Check" : "Live Estimate"
    }

    // MARK: - Zones

    static var buyZone: String {
        tier == .young ? "Good Deal" : "Buy Zone"
    }

    static var sellZone: String {
        tier == .young ? "Sell Price" : "Sell Zone"
    }

    // MARK: - Filter / Segment Labels

    static var gainers: String {
        tier == .young ? "Going Up" : "Gainers"
    }

    static var losers: String {
        tier == .young ? "Going Down" : "Losers"
    }

    static var sellWatch: String {
        tier == .young ? "Ready to Sell" : "Sell Watch"
    }

    static var stale: String {
        tier == .young ? "Needs Update" : "Stale"
    }

    // MARK: - Section Headers

    static var topMovers: String {
        tier == .young ? "BIGGEST CHANGES" : "TOP MOVERS"
    }

    static var priorityActions: String {
        tier == .young ? "THINGS TO DO" : "PRIORITY ACTIONS"
    }

    static var performance: String {
        tier == .young ? "HOW YOU'RE DOING" : "PERFORMANCE"
    }

    // MARK: - Portfolio / Collection

    static var portfolio: String {
        tier == .young ? "Collection" : "Portfolio"
    }

    static var portfolioValue: String {
        tier == .young ? "COLLECTION VALUE" : "PORTFOLIO VALUE"
    }

    static var viewPortfolio: String {
        tier == .young ? "View Collection" : "View Portfolio"
    }

    static var portfolioInsights: String {
        tier == .young ? "COLLECTION TIPS" : "PORTFOLIO INSIGHTS"
    }

    // MARK: - CompIQ

    static var howWeCompedIt: String {
        tier == .young ? "How We Priced It" : "How We Comped It"
    }

    // MARK: - DailyIQ

    static var signals: String {
        tier == .young ? "updates" : "signals"
    }

    // MARK: - Formatted

    static func marginFormatted(_ value: Double) -> String {
        tier == .young
            ? String(format: "%.1f%% profit", value)
            : String(format: "%.1f%% margin", value)
    }

    // MARK: - Private

    private static var tier: AgeTier { AgeTier.current }
}
