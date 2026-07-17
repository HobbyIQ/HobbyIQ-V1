//
//  ICalledItView.swift
//  HobbyIQ
//
//  Phase 4.11 (2026-07-17, PR #533): "I Called It" flex moments — cards
//  the user bought that appreciated meaningfully. Full list + a share-card
//  generator that renders a 1080×1920 Instagram-story-format image via
//  SwiftUI ImageRenderer.
//

import SwiftUI
import UIKit

// MARK: - List view

struct ICalledItView: View {
    @State private var response: ICalledItResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var pendingShareMoment: FlexMoment?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                if isLoading && response == nil {
                    loadingState
                } else if let moments = response?.moments, moments.isEmpty == false {
                    ForEach(moments) { moment in
                        momentRow(moment)
                    }
                } else if errorMessage != nil {
                    errorState
                } else {
                    emptyState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("I Called It")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task { await load() }
        .sheet(item: $pendingShareMoment) { moment in
            FlexShareSheet(moment: moment)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recent flexes")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Cards you bought that appreciated. Tap Share to post the win.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func momentRow(_ moment: FlexMoment) -> some View {
        let gain = moment.gainUsd ?? 0
        let gainPct = moment.gainPct ?? 0

        return VStack(alignment: .leading, spacing: 6) {
            if let headline = moment.shareablePayload?.headline?.trimmingCharacters(in: .whitespaces),
               headline.isEmpty == false {
                Text(headline)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            } else {
                Text("+\(String(format: "%.0f", gainPct))% on \(moment.player ?? "your card")")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            }

            if let subline = moment.shareablePayload?.subline {
                Text(subline)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 12) {
                if gain > 0 {
                    Text("+\(portfolioCurrencyString(gain))")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                }
                Spacer(minLength: 0)
                Button {
                    pendingShareMoment = moment
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.caption.weight(.bold))
                        Text("Share")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.35), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading your flexes…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 120)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "trophy")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No flexes yet")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Your appreciating cards will show up here.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private var errorState: some View {
        Text(errorMessage ?? "Couldn't load your flexes.")
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .frame(maxWidth: .infinity, minHeight: 120)
    }

    private func load() async {
        do {
            let result = try await APIService.shared.fetchICalledIt()
            response = result
            isLoading = false
        } catch {
            errorMessage = "Couldn't load your flexes right now."
            isLoading = false
        }
    }
}

// MARK: - Share card generator (1080×1920 Instagram story format)

/// SwiftUI view sized 1080×1920 (9:16, Instagram Stories native). Rendered
/// to a UIImage via `ImageRenderer` in `FlexShareSheet`. Design tokens per
/// spec: cool-grey #1F2937 ground with metallic-gold gradient behind the
/// headline number; uncroppable watermark bottom-right so the URL survives
/// any crop that keeps the CTA.
struct FlexShareCard: View {
    let moment: FlexMoment

    private static let designWidth: CGFloat = 1080
    private static let designHeight: CGFloat = 1920

    var body: some View {
        ZStack {
            // Ground
            Rectangle()
                .fill(Color(red: 0.122, green: 0.157, blue: 0.216))
                .frame(width: Self.designWidth, height: Self.designHeight)

            // Metallic-gold gradient overlay behind the headline area.
            RadialGradient(
                colors: [
                    Color(red: 0.855, green: 0.678, blue: 0.290).opacity(0.32),
                    Color(red: 0.122, green: 0.157, blue: 0.216).opacity(0.0)
                ],
                center: .center,
                startRadius: 0,
                endRadius: 700
            )
            .frame(width: Self.designWidth, height: Self.designHeight)

            VStack(spacing: 40) {
                Spacer(minLength: 220)

                Text("\u{1F3C6}")
                    .font(.system(size: 140))

                Text(moment.shareablePayload?.headline ?? headlineFallback())
                    .font(.system(size: 96, weight: .bold, design: .serif))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 80)

                Text(moment.shareablePayload?.subline ?? sublineFallback())
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.72))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 80)

                Spacer(minLength: 0)

                // CTA + brand tag stacked at the bottom-right corner,
                // uncroppable together.
                VStack(alignment: .trailing, spacing: 16) {
                    Text(moment.shareablePayload?.cta ?? "SEE THE ANALYSIS \u{2192}")
                        .font(.system(size: 40, weight: .bold))
                        .tracking(3)
                        .foregroundStyle(Color(red: 0.267, green: 0.647, blue: 0.933))
                    Text("hobbyiq.io")
                        .font(.system(size: 36, weight: .semibold))
                        .foregroundStyle(Color.white.opacity(0.55))
                }
                .padding(.trailing, 80)
                .padding(.bottom, 100)
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .frame(width: Self.designWidth, height: Self.designHeight, alignment: .top)
        }
        .frame(width: Self.designWidth, height: Self.designHeight)
    }

    private func headlineFallback() -> String {
        let pct = moment.gainPct.map { Int($0.rounded()) } ?? 0
        return "+\(pct)% on \(moment.player ?? "your card")"
    }

    private func sublineFallback() -> String {
        let orig = moment.originalPrice.map(portfolioCurrencyString) ?? "$0"
        let current = moment.currentMarketValue.map(portfolioCurrencyString) ?? "$0"
        return "Bought at \(orig), now \(current)"
    }
}

// MARK: - Share sheet

/// Wraps a rendered `FlexShareCard` in a native activity sheet so the user
/// can post to Stories, iMessage, or save to Photos. Rendering the SwiftUI
/// view to UIImage via `ImageRenderer` runs on scene presentation.
struct FlexShareSheet: View {
    let moment: FlexMoment
    @Environment(\.dismiss) private var dismiss
    @State private var renderedImage: UIImage?
    @State private var showActivity = false

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                VStack(spacing: 20) {
                    Text("Preview")
                        .font(.caption.weight(.bold))
                        .tracking(0.6)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                    if let img = renderedImage {
                        Image(uiImage: img)
                            .resizable()
                            .aspectRatio(9.0/16.0, contentMode: .fit)
                            .frame(maxWidth: 300)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
                            )
                    } else {
                        ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    }

                    Button {
                        showActivity = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "square.and.arrow.up.fill")
                                .font(.subheadline.weight(.bold))
                            Text("Share")
                                .font(.subheadline.weight(.bold))
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .padding(.horizontal, 24)
                        .frame(minHeight: 48)
                        .background(HobbyIQTheme.Colors.electricBlue)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(renderedImage == nil)
                }
                .padding(HobbyIQTheme.Spacing.screenPadding)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
        .task { await render() }
        .sheet(isPresented: $showActivity) {
            if let img = renderedImage {
                ShareActivityView(items: [img])
            }
        }
    }

    @MainActor
    private func render() async {
        // ImageRenderer is main-actor bound in iOS 16+. Bake the SwiftUI
        // card at 1× (the view is already sized in absolute pixels) so
        // the output lands exactly at 1080×1920.
        let renderer = ImageRenderer(content: FlexShareCard(moment: moment))
        renderer.scale = 1.0
        renderedImage = renderer.uiImage
    }
}

/// Minimal UIActivityViewController representable — shares whatever items
/// are passed in (typically the rendered UIImage).
struct ShareActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
