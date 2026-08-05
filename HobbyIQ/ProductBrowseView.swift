// CF-CATALOG-BROWSE — iOS browse-products landing (Drew, 2026-08-05).
//
// Enumerates every product family in the BCCP-derived catalog for a
// year, optionally filtered by brand. Backed by
// APIService.listProductStructures(year:brand:) which hits
// /api/catalog/product-structure/list. Each row navigates to
// ProductOverviewView for the full parallel/insert/auto rollup.
//
// Web counterpart: apps/web/src/app/app/products/page.tsx.
// Same data shape, mirrored layout (year+brand pickers on top, filter
// field, grid of product cards).

import SwiftUI

struct ProductBrowseView: View {
    private static let years: [Int] = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2010, 2005, 2000, 1995, 1990, 1985, 1980, 1975, 1970, 1965, 1960, 1955, 1950]
    private static let brands: [(id: String, label: String)] = [
        ("",           "All brands"),
        ("topps",      "Topps"),
        ("bowman",     "Bowman"),
        ("panini",     "Panini"),
        ("upper-deck", "Upper Deck"),
        ("fleer",      "Fleer"),
        ("pinnacle",   "Pinnacle"),
        ("opc",        "O-Pee-Chee"),
        ("goudey",     "Goudey"),
        ("other",      "Other"),
    ]

    @State private var year: Int = 2025
    @State private var brand: String = ""
    @State private var products: [ProductListItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var filterText: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.large) {
                header
                pickers
                filterField

                if isLoading {
                    ProgressView().padding(.top, HobbyIQTheme.Spacing.large)
                } else if let msg = errorMessage {
                    Text(msg)
                        .font(HobbyIQTheme.Typography.body)
                        .foregroundStyle(.red)
                        .padding(HobbyIQTheme.Spacing.medium)
                } else if filteredProducts.isEmpty {
                    Text("No products \(brand.isEmpty ? "" : "for that brand ")in \(String(year)). Try a different year or brand.")
                        .font(HobbyIQTheme.Typography.body)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .padding(HobbyIQTheme.Spacing.medium)
                } else {
                    resultsCount
                    grid
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xxLarge)
        }
        .navigationTitle("Browse Products")
        .navigationBarTitleDisplayMode(.inline)
        .background { HobbyIQBackground() }
        .task { await load() }
        .onChange(of: year) { _, _ in Task { await load() } }
        .onChange(of: brand) { _, _ in Task { await load() } }
    }

    private var filteredProducts: [ProductListItem] {
        let q = filterText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return products }
        return products.filter { $0.productName.lowercased().contains(q) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
            Text("Browse Products")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Every Topps, Bowman, Panini, and vintage set with parallel + insert + autograph enumeration.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private var pickers: some View {
        HStack(spacing: HobbyIQTheme.Spacing.small) {
            Menu {
                ForEach(Self.years, id: \.self) { y in
                    Button(String(y)) { year = y }
                }
            } label: {
                pickerLabel(String(year))
            }
            Menu {
                ForEach(Self.brands, id: \.id) { b in
                    Button(b.label) { brand = b.id }
                }
            } label: {
                pickerLabel(Self.brands.first(where: { $0.id == brand })?.label ?? "All brands")
            }
            Spacer()
        }
    }

    private func pickerLabel(_ text: String) -> some View {
        HStack(spacing: 6) {
            Text(text)
                .font(HobbyIQTheme.Typography.bodyEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            Capsule(style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
        )
        .clipShape(Capsule(style: .continuous))
    }

    private var filterField: some View {
        TextField("Filter \(String(year)) products…", text: $filterText)
            .textFieldStyle(.plain)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }

    private var resultsCount: some View {
        Text("\(filteredProducts.count) product\(filteredProducts.count == 1 ? "" : "s")")
            .font(HobbyIQTheme.Typography.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }

    private var grid: some View {
        LazyVStack(spacing: HobbyIQTheme.Spacing.small) {
            ForEach(filteredProducts) { p in
                NavigationLink {
                    ProductOverviewView(
                        productKey: p.productKey,
                        seedProductName: p.productName,
                        seedBrand: p.brand,
                        seedYear: p.year
                    )
                } label: {
                    productCard(p)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func productCard(_ p: ProductListItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(p.productName)
                .font(HobbyIQTheme.Typography.bodyEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(2)
            Text("\(p.brand.uppercased()) · \(p.setKey)")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .lineLimit(1)
            HStack(spacing: 6) {
                if p.parallelCount > 0 { statPill("\(p.parallelCount) parallels", .electricBlue) }
                if p.insertCount > 0   { statPill("\(p.insertCount) inserts",     .mutedText) }
                if p.autoCount > 0     { statPill("\(p.autoCount) autos",         .hobbyGreen) }
                if p.gameUsedCount > 0 { statPill("\(p.gameUsedCount) relics",    .mutedText) }
                Spacer(minLength: 0)
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func statPill(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.14))
            .clipShape(Capsule(style: .continuous))
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            products = try await APIService.shared.listProductStructures(
                year: year,
                brand: brand.isEmpty ? nil : brand
            )
        } catch {
            errorMessage = "Couldn't load products — \(error.localizedDescription)"
            products = []
        }
    }
}
