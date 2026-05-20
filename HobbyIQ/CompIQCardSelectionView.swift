//
//  CompIQCardSelectionView.swift
//  HobbyIQ
//

import SwiftUI

struct CompIQCardSelectionView: View {
    let candidates: [CompIQResolvedVariant]
    let onSelect: (CompIQResolvedVariant) -> Void
    let title: String
    let subtitle: String?
    let dismissOnSelect: Bool

    @Environment(\.dismiss) private var dismiss

    private let backgroundColor = Theme.Colors.background
    private let cardColor = Theme.Colors.card
    private let textPrimary = Theme.Colors.textPrimary
    private let textSecondary = Theme.Colors.textSecondary
    private let accentColor = Theme.Colors.accent

    init(
        candidates: [CompIQResolvedVariant],
        onSelect: @escaping (CompIQResolvedVariant) -> Void,
        title: String = "Select Card",
        subtitle: String? = nil,
        dismissOnSelect: Bool = true
    ) {
        self.candidates = candidates
        self.onSelect = onSelect
        self.title = title
        self.subtitle = subtitle
        self.dismissOnSelect = dismissOnSelect
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 14) {
                if let subtitle {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(title)
                            .font(.title2.bold())
                            .foregroundStyle(textPrimary)

                        Text(subtitle)
                            .font(.subheadline)
                            .foregroundStyle(textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(cardColor)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
                    )
                    .shadow(color: Theme.Colors.shadow, radius: Theme.Shadow.radius, x: 0, y: Theme.Shadow.y)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .hiqGlowSection(cornerRadius: 20)
                } else {
                    header
                }

                if candidates.isEmpty {
                    emptyState
                } else {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: 12),
                            GridItem(.flexible(), spacing: 12)
                        ],
                        spacing: 12
                    ) {
                        ForEach(candidates) { variant in
                            Button {
                                onSelect(variant)
                                if dismissOnSelect {
                                    dismiss()
                                }
                            } label: {
                                tile(for: variant)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(backgroundColor.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.title2.bold())
                .foregroundStyle(textPrimary)

            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .shadow(color: Theme.Colors.shadow, radius: Theme.Shadow.radius, x: 0, y: Theme.Shadow.y)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .hiqGlowSection(cornerRadius: 20)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "tray")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(textSecondary)

            Text("No exact variants found.")
                .font(.headline.bold())
                .foregroundStyle(textPrimary)

            Text("Try a broader search, then verify the exact card tile.")
                .font(.caption)
                .foregroundStyle(textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: Theme.Colors.shadow, radius: Theme.Shadow.radius, x: 0, y: Theme.Shadow.y)
    }

    private func tile(for variant: CompIQResolvedVariant) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(variant.playerName)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(textPrimary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            Text(variant.canonicalCardName)
                .font(.footnote)
                .foregroundStyle(textSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            if variant.subtitle.isEmpty == false {
                Text(variant.subtitle)
                    .font(.caption2)
                    .foregroundStyle(textSecondary.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 6) {
                if let grade = normalizedLabel(variant.grade) {
                    pill(grade)
                }
                if let parallel = normalizedLabel(variant.parallel) {
                    pill(parallel)
                }
                if let serialNumber = variant.serialNumber {
                    pill("#\(serialNumber)")
                }
                if variant.isAuto {
                    pill("Auto")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 164, alignment: .leading)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: Theme.Colors.shadow, radius: Theme.Shadow.radius, x: 0, y: Theme.Shadow.y)
    }

    private func pill(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(accentColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(accentColor.opacity(0.14))
            .clipShape(Capsule())
    }

    private func normalizedLabel(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              trimmed.isEmpty == false else {
            return nil
        }
        return trimmed
    }
}
