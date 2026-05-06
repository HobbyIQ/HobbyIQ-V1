//
//  CompIQView.swift
//  HobbyIQ
//

import SwiftUI

struct CompIQView: View {
    @StateObject private var viewModel: CompIQViewModel
    @State private var initialQuery: String?
    @State private var parseText = ""
    @State private var listingPlatform = "eBay"
    @State private var salePlatform = "eBay"
    @State private var didApplyInitialQuery = false

    private let backgroundColor = Color(hex: 0x10131A)
    private let cardColor = Color(hex: 0x1A1D24)
    private let accentColor = Color(hex: 0x3B82F6)
    private let textPrimary = Color(hex: 0xE8EAF0)
    private let textSecondary = Color(hex: 0x9CA3AF)

    @MainActor
    init(initialQuery: String? = nil, viewModel: CompIQViewModel? = nil) {
        self.initialQuery = initialQuery
        self._viewModel = StateObject(wrappedValue: viewModel ?? CompIQViewModel.shared)
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 16) {
                header
                inputSection
                actionsSection
                resultSection
            }
            .padding(16)
            .padding(.bottom, 24)
        }
        .background(backgroundColor.ignoresSafeArea())
        .navigationTitle("CompIQ")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { applyInitialQueryIfNeeded() }
        .onChange(of: initialQuery) { _, _ in
            didApplyInitialQuery = false
            applyInitialQueryIfNeeded()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CompIQ")
                .font(.largeTitle.bold())
                .foregroundStyle(textPrimary)

            Text("Live comp estimates, insights, listings, and sale records.")
                .font(.subheadline)
                .foregroundStyle(textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Card Input Form", subtitle: "Enter one card and run a live estimate.")

            VStack(spacing: 12) {
                field(title: "Player Name", placeholder: "Caleb Bonemer", text: $viewModel.playerName)
                field(title: "Card Name / Set", placeholder: "2025 Bowman Chrome Auto", text: $viewModel.cardName)
                field(title: "Your Cost", placeholder: "125", text: $viewModel.cost, keyboardType: .decimalPad)

                HStack(spacing: 12) {
                    field(title: "Parallel", placeholder: "Blue Wave", text: $viewModel.parallel)
                    field(title: "Serial #", placeholder: " /99", text: $viewModel.serialNumber, keyboardType: .numberPad)
                }

                Picker("Grade", selection: $viewModel.grade) {
                    Text("Raw").tag("")
                    Text("PSA 9").tag("PSA 9")
                    Text("PSA 10").tag("PSA 10")
                    Text("BGS 9.5").tag("BGS 9.5")
                    Text("SGC 10").tag("SGC 10")
                }
                .pickerStyle(.menu)
                .tint(accentColor)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(cardColor.opacity(0.9))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Color.white.opacity(0.06), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                VStack(alignment: .leading, spacing: 8) {
                    Text("Parse Text")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(textSecondary)

                    TextEditor(text: $parseText)
                        .frame(minHeight: 92)
                        .scrollContentBackground(.hidden)
                        .padding(10)
                        .foregroundStyle(textPrimary)
                        .background(cardColor.opacity(0.9))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(Color.white.opacity(0.06), lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }

            HStack(spacing: 12) {
                Button {
                    Task { await viewModel.runEstimate() }
                } label: {
                    HStack(spacing: 8) {
                        if viewModel.isLoading {
                            ProgressView().tint(backgroundColor)
                        }
                        Text(viewModel.isLoading ? "Running..." : "Run CompIQ")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(CompIQPrimaryButtonStyle(accent: accentColor, background: textPrimary))
                .disabled(viewModel.isLoading)

                Button {
                    Task { await viewModel.parseFromText(parseText) }
                } label: {
                    Text("Parse Card")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(CompIQSecondaryButtonStyle(background: cardColor, accent: accentColor, textColor: textPrimary))
                .disabled(parseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var actionsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(title: "Actions", subtitle: "Generate insight, listing copy, and sale records.")

            HStack(spacing: 12) {
                Button {
                    Task { await viewModel.loadInsight() }
                } label: {
                    Text(viewModel.isLoadingInsight ? "Loading..." : "Insight")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(CompIQSecondaryButtonStyle(background: cardColor, accent: accentColor, textColor: textPrimary))
                .disabled(viewModel.isLoadingInsight)

                Menu {
                    Button("eBay") { listingPlatform = "eBay" }
                    Button("COMC") { listingPlatform = "COMC" }
                    Button("Goldin") { listingPlatform = "Goldin" }
                    Button("Other") { listingPlatform = "Other" }
                } label: {
                    Text(listingPlatform)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(CompIQSecondaryButtonStyle(background: cardColor, accent: accentColor, textColor: textPrimary))

                Button {
                    Task { await viewModel.loadListing(platform: listingPlatform) }
                } label: {
                    Text(viewModel.isLoadingListing ? "Listing..." : "Listing")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(CompIQSecondaryButtonStyle(background: cardColor, accent: accentColor, textColor: textPrimary))
                .disabled(viewModel.isLoadingListing)
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Sale Record")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(textSecondary)

                field(title: "Sale Price", placeholder: "150", text: $viewModel.salePrice, keyboardType: .decimalPad)

                HStack(spacing: 12) {
                    Menu {
                        Button("eBay") { salePlatform = "eBay" }
                        Button("COMC") { salePlatform = "COMC" }
                        Button("Instagram") { salePlatform = "Instagram" }
                        Button("Other") { salePlatform = "Other" }
                    } label: {
                        Text(salePlatform)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(CompIQSecondaryButtonStyle(background: cardColor, accent: accentColor, textColor: textPrimary))

                    Button {
                        Task { await viewModel.submitSale(platform: salePlatform) }
                    } label: {
                        Text("Record Sale")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(CompIQSecondaryButtonStyle(background: cardColor, accent: accentColor, textColor: textPrimary))
                }
            }
        }
        .padding(16)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    @ViewBuilder
    private var resultSection: some View {
        if let errorMessage = viewModel.errorMessage {
            errorBanner(message: errorMessage)
        }

        if viewModel.isLoading {
            loadingCard
        }

        if let result = viewModel.result {
            VStack(alignment: .leading, spacing: 14) {
                sectionHeader(title: "Live Estimate", subtitle: "The current value returned by Azure.")
                estimateCard(result)
                zonesCard(result)
                summaryCard(result)
                explanationCard(result)
            }
            .padding(16)
            .background(cardColor)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.white.opacity(0.05), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        } else if viewModel.isLoading == false {
            emptyStateCard
        }

        if let insight = viewModel.insight {
            infoCard(title: "Insight", body: insight)
        }

        if let title = viewModel.listingTitle {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Listing Copy", subtitle: "Generated listing text for your platform.")
                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(textPrimary)
                if let listingDescription = viewModel.listingDescription {
                    Text(listingDescription)
                        .font(.subheadline)
                        .foregroundStyle(textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(16)
            .background(cardColor)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.white.opacity(0.05), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }

        if let parsed = viewModel.parsedCard {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Parsed Card", subtitle: "Fields inferred from your text.")
                Text(parsed.playerName ?? "Unknown player")
                    .font(.headline.bold())
                    .foregroundStyle(textPrimary)
                Text([parsed.cardName, parsed.parallel, parsed.grade].compactMap { $0 }.joined(separator: " • "))
                    .font(.subheadline)
                    .foregroundStyle(textSecondary)
            }
            .padding(16)
            .background(cardColor)
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.white.opacity(0.05), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private var loadingCard: some View {
        HStack(spacing: 12) {
            ProgressView()
                .tint(accentColor)
            Text("CompIQ is working...")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(textPrimary)
            Spacer()
        }
        .padding(16)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var emptyStateCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ready when you are")
                .font(.headline.bold())
                .foregroundStyle(textPrimary)
            Text("Enter a card and tap Run CompIQ for a live estimate.")
                .font(.subheadline)
                .foregroundStyle(textSecondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func estimateCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Fair Value")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(textSecondary)
                    Text(result.fairValue.formatted(.currency(code: "USD")))
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .foregroundStyle(accentColor)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text("Confidence")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(textSecondary)
                    Text(result.confidence.formatted(.percent.precision(.fractionLength(0))))
                        .font(.headline.bold())
                        .foregroundStyle(textPrimary)
                }
            }

            HStack(spacing: 12) {
                statPill(title: "Low", value: result.lowValue.formatted(.currency(code: "USD")), tint: .green)
                statPill(title: "High", value: result.highValue.formatted(.currency(code: "USD")), tint: .red)
            }

            Text(result.summary)
                .font(.subheadline)
                .foregroundStyle(textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(backgroundCard)
    }

    private func zonesCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "HobbyIQ Zones", subtitle: "Quick buy / hold / sell guide rails.")
            HStack(spacing: 12) {
                statPill(title: "Buy Zone", value: result.lowValue.formatted(.currency(code: "USD")), tint: .green)
                statPill(title: "Fair", value: result.fairValue.formatted(.currency(code: "USD")), tint: accentColor)
                statPill(title: "Sell Zone", value: result.highValue.formatted(.currency(code: "USD")), tint: .red)
            }
        }
        .padding(16)
        .background(backgroundCard)
    }

    private func summaryCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "What We Know", subtitle: "The short version.")
            Text(result.method.isEmpty ? "Unknown method" : result.method)
                .font(.caption.weight(.semibold))
                .foregroundStyle(textSecondary)
            Text(result.explanation.isEmpty ? "No summary provided." : result.explanation)
                .font(.subheadline)
                .foregroundStyle(textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
        .padding(16)
        .background(backgroundCard)
    }

    private func explanationCard(_ result: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "How We Comped It", subtitle: "Plain-English notes from Azure.")

            if result.explanationLines.isEmpty {
                Text("No explanation was returned for this estimate.")
                    .font(.subheadline)
                    .foregroundStyle(textSecondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(result.explanationLines, id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(accentColor)
                                .frame(width: 6, height: 6)
                                .padding(.top, 7)
                            Text(line)
                                .font(.subheadline)
                                .foregroundStyle(textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(backgroundCard)
    }

    private func errorBanner(message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.red)
            Text(message)
                .font(.footnote)
                .foregroundStyle(textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(red: 0.3, green: 0.1, blue: 0.1))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.red.opacity(0.3), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func infoCard(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader(title: title, subtitle: "Generated from the live CompIQ routes.")
            Text(body)
                .font(.subheadline)
                .foregroundStyle(textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
        }
        .padding(16)
        .background(cardColor)
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.05), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func sectionHeader(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.headline.bold())
                .foregroundStyle(textPrimary)
            Text(subtitle)
                .font(.caption.weight(.medium))
                .foregroundStyle(textSecondary)
        }
    }

    private func statPill(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(textSecondary)
            Text(value)
                .font(.subheadline.bold())
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.03))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var backgroundCard: some View {
        cardColor
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(Color.white.opacity(0.05), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func field(title: String, placeholder: String, text: Binding<String>, keyboardType: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(textSecondary)
            TextField(placeholder, text: text)
                .keyboardType(keyboardType)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .padding(12)
                .background(Color.white.opacity(0.03))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Color.white.opacity(0.06), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .foregroundStyle(textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func applyInitialQueryIfNeeded() {
        guard didApplyInitialQuery == false else { return }
        didApplyInitialQuery = true

        guard let query = initialQuery?.trimmingCharacters(in: .whitespacesAndNewlines), query.isEmpty == false else {
            return
        }

        if viewModel.playerName.isEmpty {
            viewModel.playerName = query
        }
    }
}

private struct CompIQPrimaryButtonStyle: ButtonStyle {
    let accent: Color
    let background: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.bold())
            .foregroundStyle(background)
            .padding(.vertical, 14)
            .padding(.horizontal, 16)
            .background(accent.opacity(configuration.isPressed ? 0.8 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct CompIQSecondaryButtonStyle: ButtonStyle {
    let background: Color
    let accent: Color
    let textColor: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(textColor)
            .padding(.vertical, 14)
            .padding(.horizontal, 14)
            .background(background.opacity(configuration.isPressed ? 0.85 : 1))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(accent.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

#Preview {
    NavigationStack {
        CompIQView()
    }
    .preferredColorScheme(.dark)
}
