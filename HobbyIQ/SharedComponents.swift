//
//  SharedComponents.swift
//  HobbyIQ
//

import SwiftUI

struct SearchBarView: View {
    let placeholder: String
    @Binding var text: String
    var onSubmit: () -> Void

    var body: some View {
        HStack(spacing: HobbyIQTheme.Spacing.small) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.words)
                .submitLabel(.search)
                .onSubmit(onSubmit)

            if text.isEmpty == false {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .buttonStyle(.plain)
            }
        }
        .inputFieldStyle()
    }
}

struct SectionCardView<Content: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder var content: Content

    init(title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            // CF-UNIFY-SECTION-HEADERS (2026-06-17): delegates to the
            // shared HIQSectionHeader.
            HIQSectionHeader(title, subtitle: subtitle)

            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct MetricPillView: View {
    let title: String
    let value: String
    var accent: Color = HobbyIQTheme.Colors.pureWhite

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(accent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.appBackground.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
}

struct ActionBadgeView: View {
    let action: RecommendationAction

    var body: some View {
        Text(action.rawValue)
            .font(.caption.weight(.bold))
            .foregroundStyle(foregroundColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(backgroundColor)
            .clipShape(Capsule())
    }

    private var foregroundColor: Color {
        switch action {
        case .buy:
            return HobbyIQTheme.Colors.electricBlue
        case .hold, .watch:
            return HobbyIQTheme.Colors.warning
        case .trim, .sell:
            return HobbyIQTheme.Colors.danger
        }
    }

    private var backgroundColor: Color {
        foregroundColor.opacity(0.14)
    }
}

struct ConfidenceMetaRow: View {
    let refreshMeta: RefreshMeta

    var body: some View {
        HStack(spacing: HobbyIQTheme.Spacing.small) {
            Label(refreshMeta.relativeTimestamp, systemImage: "clock.arrow.circlepath")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            if let confidence = refreshMeta.confidence {
                Label("\(confidence)% confidence", systemImage: "gauge.with.dots.needle.50percent")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            Spacer()
        }
    }
}

struct RefreshMetaView: View {
    let refreshMeta: RefreshMeta

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ConfidenceMetaRow(refreshMeta: refreshMeta)

            if let note = refreshMeta.note, note.isEmpty == false {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)

            VStack(spacing: HobbyIQTheme.Spacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(PrimaryButton())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct ErrorStateView: View {
    let title: String
    let message: String
    var retryTitle: String = "Retry"
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.danger)

            VStack(spacing: HobbyIQTheme.Spacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            if let retry {
                Button(retryTitle, action: retry)
                    .buttonStyle(SecondaryButton())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct LoadingCardView: View {
    let title: String
    let message: String

    var body: some View {
        HStack(spacing: HobbyIQTheme.Spacing.medium) {
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: HobbyIQTheme.Colors.electricBlue))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct ActivityIndicatorView: View {
    var body: some View {
        ProgressView()
            .progressViewStyle(CircularProgressViewStyle(tint: HobbyIQTheme.Colors.electricBlue))
    }
}

struct PortfolioInsightCardView: View {
    let playerName: String
    let cardName: String
    let roiText: String
    let roiColor: Color
    let valueText: String
    let listText: String?
    let accent: Color
    let reasoning: [String]?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(playerName)
                        .font(.headline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(cardName)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                Spacer()

                Text(roiText)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(roiColor)
            }

            HStack {
                Text("Value")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(valueText)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fontWeight(.semibold)
            }

            if let listText {
                HStack {
                    Text("List")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(listText)
                        .foregroundStyle(accent)
                        .fontWeight(.semibold)
                }
            }

            if let reasoning, reasoning.isEmpty == false {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(reasoning.prefix(2).enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .top, spacing: 8) {
                            Text("•")
                                .foregroundStyle(accent)
                            Text(line)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Spacer()
                        }
                        .font(.footnote)
                    }
                }
                .padding(12)
                .background(HobbyIQTheme.Colors.steelGray)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            }
        }
        .padding(14)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}
