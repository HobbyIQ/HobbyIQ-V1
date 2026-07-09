//
//  NewReleasesView.swift
//  HobbyIQ
//
//  CF-NEW-RELEASES (2026-07-04, backend batch §3): catalog additions
//  feed backed by GET /api/compiq/new-releases. Renders a paginated
//  list of newly added sets with category filter chips + pull-to-
//  refresh. Row tap deep-links into CompIQ search with the setName
//  as the query.
//

import SwiftUI

// MARK: - Wire Models (GET /api/compiq/new-releases)

struct NewReleasesResponse: Decodable {
    let success: Bool?
    let startDate: String?
    let endDate: String?
    let category: String?
    let page: Int?
    let pageSize: Int?
    let totalRows: Int?
    let releases: [NewReleaseEntry]?
}

struct NewReleaseEntry: Decodable, Identifiable, Hashable {
    let category: String?
    let setName: String?
    let subset: String?
    let variants: String?
    let addedDate: String?
    let cardCount: Int?

    /// Stable id built from setName + subset + addedDate. `setName` is
    /// unique per release under normal backend behavior; adding subset
    /// + addedDate guards against a rare same-name re-issue collision.
    var id: String {
        "\(setName ?? "?")|\(subset ?? "")|\(addedDate ?? "")"
    }
}

// MARK: - Category

enum NewReleasesCategory: String, CaseIterable, Identifiable {
    case all         = "All"
    case baseball    = "Baseball"
    case basketball  = "Basketball"
    case football    = "Football"
    case pokemon     = "Pokemon"

    var id: String { rawValue }

    /// Backend query param — omitted for `.all`.
    var queryValue: String? {
        switch self {
        case .all:        return nil
        default:          return rawValue
        }
    }

    static let userDefaultsKey = "newReleases.category"
}

// MARK: - View

struct NewReleasesView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

    @State private var releases: [NewReleaseEntry] = []
    @State private var category: NewReleasesCategory = NewReleasesView.loadPersistedCategory()
    @State private var page: Int = 1
    @State private var pageSize: Int = 50
    @State private var totalRows: Int = 0
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var errorText: String?
    @State private var searchQuery: String?

    var body: some View {
        ZStack {
            HobbyIQBackground()

            ScrollView {
                VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
                    heroCopy
                    categoryChips
                    if isLoading && releases.isEmpty {
                        loadingCard
                    } else if let msg = errorText, releases.isEmpty {
                        errorCard(msg)
                    } else if releases.isEmpty {
                        emptyStateCard
                    } else {
                        releasesList
                    }
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, HobbyIQTheme.Spacing.medium)
            }
            .refreshable {
                await refresh()
            }
        }
        .navigationTitle("New Releases")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            if releases.isEmpty {
                await refresh()
            }
        }
        .onChange(of: category) { _, newValue in
            persistCategory(newValue)
            Task { await refresh() }
        }
        .navigationDestination(
            isPresented: Binding(
                get: { searchQuery != nil },
                set: { if !$0 { searchQuery = nil } }
            )
        ) {
            if let q = searchQuery {
                CompIQView(
                    initialQuery: q,
                    onBack: { searchQuery = nil }
                )
                .environmentObject(sessionViewModel)
            }
        }
    }

    // MARK: Hero copy

    private var heroCopy: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Fresh from the catalog")
                .font(.headline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("New sets added over the last 30 days. Tap into a release to search all its cards.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Category chips

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(NewReleasesCategory.allCases) { cat in
                    let isSelected = cat == category
                    Button {
                        category = cat
                    } label: {
                        Text(cat.rawValue)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(isSelected
                                             ? HobbyIQTheme.Colors.pureWhite
                                             : HobbyIQTheme.Colors.mutedText)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(
                                Capsule().fill(
                                    isSelected
                                        ? HobbyIQTheme.Colors.electricBlue
                                        : HobbyIQTheme.Colors.steelGray.opacity(0.25)
                                )
                            )
                            .overlay(
                                Capsule().stroke(
                                    isSelected
                                        ? HobbyIQTheme.Colors.electricBlue
                                        : HobbyIQTheme.Colors.steelGray.opacity(0.4),
                                    lineWidth: 1
                                )
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    // MARK: Empty / Loading / Error states

    private var loadingCard: some View {
        HStack(spacing: 12) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading new releases…")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private var emptyStateCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Nothing new in this window")
                .font(.headline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("No sets added in the last 30 days for this category. Check back after the next catalog cycle.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func errorCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                Text("Couldn't load")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Releases list

    private var releasesList: some View {
        LazyVStack(spacing: 10) {
            ForEach(releases) { release in
                Button {
                    if let setName = release.setName, setName.isEmpty == false {
                        searchQuery = setName
                    }
                } label: {
                    releaseRow(release)
                }
                .buttonStyle(.plain)
                .onAppear {
                    // CF-NEW-RELEASES-INFINITE-SCROLL (2026-07-04): when
                    // the last (or near-last) row appears and there's
                    // more to load, trigger the next page. Guarded by
                    // isLoadingMore so we don't stack fetches.
                    if release.id == releases.last?.id, hasMore, !isLoadingMore {
                        Task { await loadMore() }
                    }
                }
            }
            if isLoadingMore {
                HStack(spacing: 10) {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Loading more…")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .padding(.vertical, 8)
            }
        }
    }

    private func releaseRow(_ release: NewReleaseEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(release.setName ?? "Unnamed set")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                let subtitle = subtitleText(release)
                if subtitle.isEmpty == false {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 8) {
                    if let addedPhrase = relativeAddedDatePhrase(release.addedDate) {
                        Text(addedPhrase)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    if let category = release.category, category.isEmpty == false {
                        categoryChip(category)
                    }
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                if let count = release.cardCount, count > 0 {
                    Text("\(count)")
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(count == 1 ? "card" : "cards")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .contentShape(Rectangle())
    }

    private func categoryChip(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
            .clipShape(Capsule())
    }

    private func subtitleText(_ release: NewReleaseEntry) -> String {
        [release.subset, release.variants]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }
            .joined(separator: " · ")
    }

    /// "Added: 3 days ago" style phrase from an ISO YYYY-MM-DD date.
    /// Falls back to the raw string when parsing fails.
    private func relativeAddedDatePhrase(_ isoDate: String?) -> String? {
        guard let isoDate else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        if let date = formatter.date(from: isoDate) {
            let interval = Date().timeIntervalSince(date)
            let days = Int(interval / 86400)
            if days <= 0 {
                return "Added: today"
            } else if days == 1 {
                return "Added: 1 day ago"
            } else if days < 30 {
                return "Added: \(days) days ago"
            } else {
                let df = DateFormatter()
                df.dateFormat = "MMM d"
                return "Added: \(df.string(from: date))"
            }
        }
        return "Added: \(isoDate)"
    }

    // MARK: Pagination + fetch

    private var hasMore: Bool {
        releases.count < totalRows
    }

    private func refresh() async {
        page = 1
        isLoading = true
        errorText = nil
        do {
            let response = try await APIService.shared.fetchNewReleases(
                category: category.queryValue,
                page: 1,
                pageSize: pageSize
            )
            releases = response.releases ?? []
            totalRows = response.totalRows ?? releases.count
        } catch {
            releases = []
            totalRows = 0
            errorText = APIService.errorMessage(from: error)
        }
        isLoading = false
    }

    private func loadMore() async {
        guard hasMore, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let nextPage = page + 1
        do {
            let response = try await APIService.shared.fetchNewReleases(
                category: category.queryValue,
                page: nextPage,
                pageSize: pageSize
            )
            let more = response.releases ?? []
            releases.append(contentsOf: more)
            totalRows = response.totalRows ?? totalRows
            page = nextPage
        } catch {
            // Silent — user can pull-to-refresh to retry.
        }
    }

    // MARK: Category persistence

    private static func loadPersistedCategory() -> NewReleasesCategory {
        guard let raw = UserDefaults.standard.string(forKey: NewReleasesCategory.userDefaultsKey),
              let cat = NewReleasesCategory(rawValue: raw) else {
            return .all
        }
        return cat
    }

    private func persistCategory(_ cat: NewReleasesCategory) {
        UserDefaults.standard.set(cat.rawValue, forKey: NewReleasesCategory.userDefaultsKey)
    }
}
