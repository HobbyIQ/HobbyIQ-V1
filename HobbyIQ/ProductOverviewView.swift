// CF-CATALOG-FIRST product-structure view (Drew, 2026-08-04).
//
// Renders the authoritative baseballcardpedia-derived product structure
// for a product family: every parallel (with print run), every insert
// subset, every autograph subset. User lands here from CardSearchView
// via NavigationLink when a search result carries a productKey (2024
// Bowman Chrome, etc.).
//
// Web counterpart: apps/web/src/app/app/product/[productKey]/page.tsx.
// Same data shape, mirrored components.

import SwiftUI

struct ProductOverviewView: View {
    let productKey: String
    // Passed-in seed so the header can render before the network call
    // resolves. Nil for cold-load flows.
    var seedProductName: String?
    var seedBrand: String?
    var seedYear: Int?

    @State private var product: ProductStructure?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.large) {
                header
                if let msg = errorMessage {
                    Text(msg)
                        .font(HobbyIQTheme.Typography.body)
                        .foregroundStyle(.red)
                        .padding(HobbyIQTheme.Spacing.medium)
                } else if let product {
                    sections(for: product)
                } else if isLoading {
                    ProgressView()
                        .padding(.top, HobbyIQTheme.Spacing.large)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .navigationTitle(seedProductName ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
            Text(product?.productName ?? seedProductName ?? "Product")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let brand = product?.brand ?? seedBrand, let year = product?.year ?? seedYear {
                Text("\(brand.uppercased()) · \(String(year))")
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    @ViewBuilder
    private func sections(for product: ProductStructure) -> some View {
        if !product.parallels.isEmpty {
            productSection(
                title: "Parallels",
                subtitle: "\(product.parallels.count) variants",
                content: {
                    ForEach(product.parallels) { p in
                        ParallelRow(parallel: p)
                    }
                }
            )
        }
        if !product.inserts.isEmpty {
            productSection(
                title: "Inserts",
                subtitle: "\(product.inserts.count) subsets",
                content: {
                    ForEach(product.inserts) { s in
                        SubsetRow(name: s.name, prefix: s.cardPrefix, parallelCount: s.parallelCount)
                    }
                }
            )
        }
        if !product.autos.isEmpty {
            productSection(
                title: "Autographs",
                subtitle: "\(product.autos.count) subsets",
                content: {
                    ForEach(product.autos) { s in
                        SubsetRow(name: s.name, prefix: s.cardPrefix, parallelCount: s.parallelCount)
                    }
                }
            )
        }
        if !product.gameUsed.isEmpty {
            productSection(
                title: "Game-Used",
                subtitle: "\(product.gameUsed.count) subsets",
                content: {
                    ForEach(product.gameUsed) { r in
                        SubsetRow(name: r.name, prefix: r.cardPrefix, parallelCount: 0)
                    }
                }
            )
        }
        if !product.gimmicks.isEmpty {
            productSection(
                title: "Gimmicks",
                subtitle: "\(product.gimmicks.count) subsets",
                content: {
                    ForEach(product.gimmicks) { r in
                        SubsetRow(name: r.name, prefix: r.cardPrefix, parallelCount: 0)
                    }
                }
            )
        }
    }

    @ViewBuilder
    private func productSection<Content: View>(
        title: String,
        subtitle: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                Text(subtitle)
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            VStack(spacing: 0) {
                content()
            }
        }
    }

    private func load() async {
        guard product == nil, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            product = try await APIService.shared.fetchProductStructure(productKey: productKey)
        } catch {
            errorMessage = "Couldn't load product — \(error.localizedDescription)"
        }
    }
}

private struct ParallelRow: View {
    let parallel: ProductParallel
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(parallel.name)
                    .font(HobbyIQTheme.Typography.body)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(parallel.section)
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
            if let n = parallel.printRun {
                Text("/\(n)")
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            } else {
                Text("unnum.")
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(.vertical, HobbyIQTheme.Spacing.xSmall)
        Divider().overlay(HobbyIQTheme.Colors.mutedText.opacity(0.2))
    }
}

private struct SubsetRow: View {
    let name: String
    let prefix: String?
    let parallelCount: Int
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(HobbyIQTheme.Typography.body)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let prefix {
                    Text("prefix \(prefix)")
                        .font(HobbyIQTheme.Typography.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            Spacer()
            if parallelCount > 0 {
                Text("\(parallelCount) parallels")
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
        }
        .padding(.vertical, HobbyIQTheme.Spacing.xSmall)
        Divider().overlay(HobbyIQTheme.Colors.mutedText.opacity(0.2))
    }
}
