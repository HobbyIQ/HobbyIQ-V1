//
//  NewDropsView.swift
//  HobbyIQ
//
//  "New Drops" feed — recent CH catalog additions grouped by added date.
//  Accessible as a sheet from DailyIQ (backend PR #556).
//

import SwiftUI

struct NewDropsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var response: CatalogAdditionsResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedCategory: NewDropsCategory = .all
    /// Rolling 14-day window per spec.
    private static let sinceWindowDays: Int = 14

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        headerBlock
                        categoryPicker
                        if isLoading {
                            loadingState
                        } else if let response, let additions = response.additions, additions.isEmpty == false {
                            groupedFeed(additions: additions)
                        } else if errorMessage != nil {
                            errorState
                        } else {
                            emptyState
                        }
                    }
                    .padding(HobbyIQTheme.Spacing.screenPadding)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                }
            }
            .navigationTitle("New Drops")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
            .onChange(of: selectedCategory) { _, _ in
                Task { await load() }
            }
        }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("NEW DROPS")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("Last \(Self.sinceWindowDays) days\(countSuffix)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private var countSuffix: String {
        guard let count = response?.count, count > 0 else { return "" }
        return " \u{00B7} \(count) additions"
    }

    private var categoryPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(NewDropsCategory.allCases) { category in
                    Button {
                        selectedCategory = category
                    } label: {
                        Text(category.label)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(selectedCategory == category ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(selectedCategory == category ? HobbyIQTheme.Colors.electricBlue.opacity(0.22) : HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                            .overlay(
                                Capsule(style: .continuous)
                                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(selectedCategory == category ? 0.8 : 0.28), lineWidth: 1)
                            )
                            .clipShape(Capsule(style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    @ViewBuilder
    private func groupedFeed(additions: [CatalogAddition]) -> some View {
        let grouped = groupByDate(additions)
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(grouped, id: \.date) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Text(dateLabel(for: group.date))
                        .font(.caption.weight(.bold))
                        .tracking(0.4)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    VStack(spacing: 10) {
                        ForEach(group.items) { addition in
                            NewDropsRow(addition: addition)
                        }
                    }
                }
            }
        }
    }

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading drops…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No new releases yet")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Check back tomorrow.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var errorState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Couldn't load drops")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Data

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        let sinceDate = Calendar.current.date(byAdding: .day, value: -Self.sinceWindowDays, to: Date()) ?? Date()
        let sinceString = Self.isoDateFormatter.string(from: sinceDate)
        do {
            response = try await APIService.shared.fetchCatalogAdditions(
                since: sinceString,
                category: selectedCategory == .all ? nil : selectedCategory.wireValue
            )
        } catch {
            response = nil
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private static let isoDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private struct DateGroup {
        let date: String
        let items: [CatalogAddition]
    }

    private func groupByDate(_ additions: [CatalogAddition]) -> [DateGroup] {
        let byDate = Dictionary(grouping: additions) { $0.addedDate ?? "" }
        return byDate
            .map { DateGroup(date: $0.key, items: $0.value) }
            .sorted { $0.date > $1.date }
    }

    private func dateLabel(for iso: String) -> String {
        guard let date = Self.isoDateFormatter.date(from: iso) else { return iso }
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        let display = DateFormatter()
        display.dateFormat = "MMM d"
        return display.string(from: date)
    }
}

// MARK: - Category picker

private enum NewDropsCategory: String, CaseIterable, Identifiable {
    case all
    case baseball
    case basketball
    case football

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all:        return "All"
        case .baseball:   return "Baseball"
        case .basketball: return "Basketball"
        case .football:   return "Football"
        }
    }

    /// Server-side category strings are Title Case per the wire example.
    var wireValue: String { label }
}

// MARK: - Row

private struct NewDropsRow: View {
    let addition: CatalogAddition

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 2) {
                Text("\(addition.cardCount ?? 0)")
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("new")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .frame(width: 56)

            VStack(alignment: .leading, spacing: 4) {
                Text(addition.setName ?? "Unknown set")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(2)
                if let subset = addition.subset, subset.isEmpty == false {
                    Text(subset)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                if let category = addition.category, category.isEmpty == false {
                    Text(category)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                        .clipShape(Capsule(style: .continuous))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.22), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}
