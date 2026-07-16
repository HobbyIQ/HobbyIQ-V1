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

    // CF-LABEL-FMV-CANONICAL (audit PR #481, 2026-07-15): canonical
    // label for the estimated fair market value. The whole-app audit
    // found SIX competing labels ("Fair Market" / "Market Value" / "FMV"
    // / "Fair Value" / "Market" / "Fair Price") for the same number,
    // including a triple-label site on ONE card (CompIQAdvancedViews
    // :526-532). "Market Value" wins on Drew's own naming + the
    // dashboard's HIQStatCard treatment. Every raw literal site must
    // migrate to `Labels.marketValue`.
    static var marketValue: String {
        tier == .young ? "What It's Worth" : "Market Value"
    }

    // `fairValue` retained as a deprecated alias so PR-splitting doesn't
    // stall — existing callers get the same canonical string, and iOS
    // migrations to `Labels.marketValue` can proceed at their own pace.
    // Delete this alias once every caller is migrated.
    static var fairValue: String { marketValue }

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
        tier == .young ? "Biggest changes" : "Top movers"
    }

    static var priorityActions: String {
        tier == .young ? "Things to do" : "Priority actions"
    }

    static var performance: String {
        tier == .young ? "How you're doing" : "Performance"
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
