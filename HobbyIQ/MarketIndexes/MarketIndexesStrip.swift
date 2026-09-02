//
//  MarketIndexesStrip.swift
//  HobbyIQ
//
//  CF-MARKET-INDEXES iOS parity (#1644, Drew 2026-09-02).
//
//  ONE component, mounted on both surfaces that show it (the Market screen
//  and DailyIQ) — exactly as apps/web keeps a single MarketIndexes.tsx for
//  its two pages. Two copies of the tile markup would be two chances for
//  the two screens to drift, which is the bug that shared component exists
//  to prevent.
//
//  Like DailyIQ's, this mounts OUTSIDE any brief/phase gate on its host:
//  a locked or errored section must not take the index strip down with it.
//
//  NO CLIENT COMPUTATION. `latestLevel` and `changePct` come off the wire;
//  the sparkline is the only thing derived here, and it derives shape, not
//  a number.
//

import SwiftUI

struct MarketIndexesStrip: View {
    /// Window the tiles render. 180d matches the web default.
    var days: Int = 180

    @State private var response: MarketIndexesResponse?
    @State private var isLoading = false
    @State private var loadFailed = false

    var body: some View {
        // Self-suppressing: a strip that has never loaded, or whose sports
        // all came back empty, renders nothing rather than a row of
        // placeholder tiles claiming an index exists.
        //
        // The loader is attached to the OUTER Group rather than living in
        // an `else` branch, so the not-yet-loaded state is a genuine
        // EmptyView. A zero-height placeholder would still take a stack
        // spacing slot on both hosts, leaving a visible gap where an index
        // that may never arrive would have gone.
        Group {
            if let response, response.indexes.isEmpty == false {
                strip(response)
            }
        }
        .task(id: days) { await load() }
    }

    private func strip(_ response: MarketIndexesResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            header(asOf: response.indexes.compactMap(\.asOf).max())
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    // Server order is the tile order and it is STABLE —
                    // empty sports are returned rather than omitted
                    // precisely so this strip does not re-order between
                    // loads. Never sort or filter here.
                    ForEach(response.indexes) { index in
                        MarketIndexTile(index: index)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func header(asOf: String?) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "chart.xyaxis.line")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text("Market Indexes")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            HIQHelpButton(
                title: "Market Indexes",
                message: "A fixed basket of each sport's most-traded cards, held for the quarter. "
                    + "The level tracks each card against its OWN starting value, so a card simply "
                    + "showing up in (or dropping out of) a day's sales can't move the index — only "
                    + "a real change in what those cards are worth."
            )
            Spacer(minLength: 0)
            if isLoading {
                ProgressView()
                    .controlSize(.mini)
                    .tint(HobbyIQTheme.Colors.electricBlue)
            } else if let asOf {
                Text(asOf)
                    .font(.caption2.weight(.medium).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    private func load() async {
        // Already have a strip and no explicit reason to refetch — the two
        // hosts both mount this and a tab switch shouldn't re-hit the
        // endpoint on every appear.
        guard response == nil, isLoading == false, loadFailed == false else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchMarketIndexes(days: days)
        } catch {
            // Silent: an index strip is context, not the screen's payload.
            // The host keeps working; the strip stays absent.
            loadFailed = true
        }
    }
}

/// One sport's tile: name, % change, 180d sparkline, index level.
struct MarketIndexTile: View {
    let index: SportIndexSeries

    /// Green/red/neutral off the SERVED change, not a derived one.
    private var changeColor: Color {
        guard let pct = index.changePct else { return HobbyIQTheme.Colors.mutedText }
        if pct > 0 { return HobbyIQTheme.Colors.successGreen }
        if pct < 0 { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }

    private var changeText: String? {
        guard let pct = index.changePct else { return nil }
        return String(format: "%+.1f%%", pct)
    }

    /// The index level, printed the way an index is: one decimal, base 100.
    private var levelText: String {
        guard let level = index.latestLevel else { return "—" }
        return String(format: "%.1f", level)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(index.displayName)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer(minLength: 4)
                if let changeText {
                    Text(changeText)
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(changeColor)
                }
            }

            if index.hasRenderableSeries {
                UnifiedSparkline(points: index.levels, color: changeColor, height: 34)
            } else {
                // A one-point (or zero-point) series has no shape and no
                // honest change. Say the index is still building rather
                // than drawing a flat line that reads as "no movement".
                Text("Building")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 34)
            }

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(levelText)
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let basket = index.basketSize {
                    Text("\(basket) cards")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .padding(12)
        .frame(width: 148, alignment: .leading)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.14))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.25), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = ["\(index.displayName) index"]
        if index.latestLevel != nil { parts.append("level \(levelText)") }
        if let changeText, let window = index.windowDays {
            parts.append("\(changeText) over \(window) days")
        } else if let changeText {
            parts.append(changeText)
        }
        if let basket = index.basketSize { parts.append("basket of \(basket) cards") }
        return parts.joined(separator: ", ")
    }
}

#Preview("Tiles") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        VStack {
            MarketIndexesStrip()
            Spacer()
        }
        .padding()
    }
    .preferredColorScheme(.dark)
}
