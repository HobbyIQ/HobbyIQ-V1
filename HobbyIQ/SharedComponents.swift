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
        HStack(spacing: Theme.Spacing.small) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.Colors.textSecondary)

            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.words)
                .submitLabel(.search)
                .onSubmit(onSubmit)

            if text.isEmpty == false {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.Colors.textSecondary)
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
        VStack(spacing: Theme.Spacing.small) {
            HStack(spacing: 10) {
                Rectangle()
                    .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                    .frame(height: 1)

                Text(title.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.2)
                    .fixedSize()

                Rectangle()
                    .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                    .frame(height: 1)
            }

            if let subtitle, subtitle.isEmpty == false {
                Text(subtitle)
                    .font(.subheadline)
                    .secondaryTextStyle()
                    .frame(maxWidth: .infinity, alignment: .center)
            }

            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .cardStyle()
    }
}

struct MetricPillView: View {
    let title: String
    let value: String
    var accent: Color = Theme.Colors.textPrimary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.Colors.textSecondary)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(accent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.Colors.background.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
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
            return Theme.Colors.accent
        case .hold, .watch:
            return Theme.Colors.caution
        case .trim, .sell:
            return Theme.Colors.negative
        }
    }

    private var backgroundColor: Color {
        foregroundColor.opacity(0.14)
    }
}

struct ConfidenceMetaRow: View {
    let refreshMeta: RefreshMeta

    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Label(refreshMeta.relativeTimestamp, systemImage: "clock.arrow.circlepath")
                .font(.caption)
                .foregroundStyle(Theme.Colors.textSecondary)

            if let confidence = refreshMeta.confidence {
                Label("\(confidence)% confidence", systemImage: "gauge.with.dots.needle.50percent")
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.textSecondary)
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
                    .secondaryTextStyle()
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
        VStack(spacing: Theme.Spacing.medium) {
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Theme.Colors.accent)

            VStack(spacing: Theme.Spacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .secondaryTextStyle()
            }

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(PrimaryButton())
            }
        }
        .frame(maxWidth: .infinity)
        .cardStyle()
    }
}

struct ErrorStateView: View {
    let title: String
    let message: String
    var retryTitle: String = "Retry"
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Theme.Colors.negative)

            VStack(spacing: Theme.Spacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .secondaryTextStyle()
            }

            if let retry {
                Button(retryTitle, action: retry)
                    .buttonStyle(SecondaryButton())
            }
        }
        .frame(maxWidth: .infinity)
        .cardStyle()
    }
}

struct LoadingCardView: View {
    let title: String
    let message: String

    var body: some View {
        HStack(spacing: Theme.Spacing.medium) {
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: Theme.Colors.accent))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.Colors.textPrimary)
                Text(message)
                    .font(.subheadline)
                    .secondaryTextStyle()
            }
            Spacer()
        }
        .cardStyle()
    }
}

struct ActivityIndicatorView: View {
    var body: some View {
        ProgressView()
            .progressViewStyle(CircularProgressViewStyle(tint: Theme.Colors.accent))
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
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(cardName)
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }

                Spacer()

                Text(roiText)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(roiColor)
            }

            HStack {
                Text("Value")
                    .foregroundStyle(Theme.Colors.textMuted)
                Spacer()
                Text(valueText)
                    .foregroundStyle(Theme.Colors.textPrimary)
                    .fontWeight(.semibold)
            }

            if let listText {
                HStack {
                    Text("List")
                        .foregroundStyle(Theme.Colors.textMuted)
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
                                .foregroundStyle(Theme.Colors.textSecondary)
                            Spacer()
                        }
                        .font(.footnote)
                    }
                }
                .padding(12)
                .background(Theme.Colors.surfaceElevated)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .padding(14)
        .background(Theme.Colors.surface)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}
