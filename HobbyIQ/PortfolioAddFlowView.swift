//
//  PortfolioAddFlowView.swift
//  HobbyIQ
//

import Combine
import SwiftUI

enum PortfolioAddRoute: Hashable {
    case verify
    case details
}

enum PurchasePlatformOption: String, CaseIterable, Identifiable, Codable {
    case ebay = "eBay"
    case fanatics = "Fanatics"
    case whatnot = "Whatnot"
    case show = "Show"
    case socialMedia = "Social Media"
    case lcs = "LCS"
    case relationship = "Relationship"

    var id: String { rawValue }
}

@MainActor
final class PortfolioAddFlowViewModel: ObservableObject {
    @Published var searchText = ""
    @Published private(set) var candidateSearchContext: CompIQCandidateSearchContext?
    @Published private(set) var candidateVariants: [CompIQResolvedVariant] = []
    @Published var selectedVariant: CompIQResolvedVariant?
    @Published var estimateResult: CardEstimateResponse?
    @Published var isGraded = false
    @Published var gradingCompany = "PSA"
    @Published var gradeValue = "10"
    @Published var purchaseDate = Date()
    @Published var purchasePlatform: PurchasePlatformOption = .ebay
    @Published var costPaid = ""
    @Published var currentValue = ""
    @Published var isLoading = false
    @Published var isSaving = false
    @Published var errorMessage: String?

    private let service: APIService

    init(service: APIService? = nil) {
        self.service = service ?? .shared
    }

    func reset() {
        searchText = ""
        candidateSearchContext = nil
        candidateVariants = []
        selectedVariant = nil
        estimateResult = nil
        isGraded = false
        gradingCompany = "PSA"
        gradeValue = "10"
        purchaseDate = .now
        purchasePlatform = .ebay
        costPaid = ""
        currentValue = ""
        isLoading = false
        isSaving = false
        errorMessage = nil
    }

    func searchCandidates(maxProducts: Int = 12) async -> [CompIQResolvedVariant] {
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else {
            errorMessage = "Enter a card to search."
            return []
        }

        let payload = candidateSearchPayload(from: trimmed, maxProducts: maxProducts)
        candidateSearchContext = payload.context

        isLoading = true
        errorMessage = nil
        candidateVariants = []
        defer { isLoading = false }

        do {
            let response = try await service.searchCompIQCandidates(request: payload.request)
            let candidates = response.candidates
            candidateVariants = candidates

            if response.available == false {
                errorMessage = response.error ?? "No exact card matches were found."
            } else if candidates.isEmpty {
                errorMessage = "No exact card matches were found."
            }

            return candidates
        } catch {
            errorMessage = portfolioUserFacingMessage(for: error, fallback: "Could not search right now.")
            return []
        }
    }

    func save() async -> Bool {
        guard let variant = selectedVariant else {
            errorMessage = "Verify the exact card first."
            return false
        }

        guard let purchaseCost = decimal(from: costPaid) else {
            errorMessage = "Enter a valid cost paid amount."
            return false
        }

        let resolvedCurrentValue = decimal(from: currentValue) ?? purchaseCost
        let cardName = preferredCardName(for: variant)
        let purchaseDateString = Self.purchaseDateFormatter.string(from: purchaseDate)

        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        let request = InventoryCard(
            playerName: variant.playerName,
            cardName: cardName,
            cost: purchaseCost,
            currentValue: resolvedCurrentValue,
            status: "active",
            year: variant.year.map(String.init) ?? "",
            setName: variant.setName ?? "",
            parallel: variant.parallel ?? "",
            grade: variant.grade ?? "",
            // CF-AUTOPRICE-GRADE-CONTRACT: pass canonical structured grade
            // to backend so autoPriceHolding requests Cardsight's
            // response.graded[company][value] bucket instead of falling
            // through to raw/ungraded comps.
            gradeCompany: variant.gradeCompany,
            gradeValue: variant.gradeValue,
            purchaseDate: purchaseDateString,
            purchasePlatform: purchasePlatform.rawValue,
            lowValue: estimateResult?.quickSaleValue,
            highValue: estimateResult?.premiumValue,
            confidence: estimateResult?.confidenceScore,
            method: estimateResult?.source,
            summary: estimateResult?.explanation?.joined(separator: " ")
        )

        do {
            try await service.addInventoryCard(request)
            return true
        } catch {
            errorMessage = portfolioUserFacingMessage(for: error, fallback: "Could not save that card right now.")
            return false
        }
    }

    private func preferredCardName(for variant: CompIQResolvedVariant) -> String {
        let details = [variant.canonicalCardName, variant.subtitle]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }

        return details.joined(separator: " • ")
    }

    private func portfolioUserFacingMessage(for error: Error, fallback: String) -> String {
        if let apiError = error as? APIError, let description = apiError.errorDescription {
            return description
        }

        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? fallback : message
    }

    private func decimal(from value: String) -> Double? {
        let sanitized = value
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Double(sanitized)
    }

    private func candidateSearchPayload(
        from rawValue: String,
        maxProducts: Int
    ) -> (request: CompIQSearchCandidatesRequest, context: CompIQCandidateSearchContext) {
        let trimmedValue = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let year = firstYear(in: trimmedValue)
        let descriptor = descriptorAfterYear(in: trimmedValue, year: year)
        let parallel = extractedParallel(from: descriptor)

        let descriptorWithoutParallel = removeParallel(parallel, from: descriptor)
        let words = descriptorWithoutParallel
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)

        let brand = words.first
        let setName = words.dropFirst().joined(separator: " ")

        let request = CompIQSearchCandidatesRequest(
            year: year,
            brand: trimmedOrNil(brand),
            setName: trimmedOrNil(setName),
            parallel: trimmedOrNil(parallel),
            maxProducts: maxProducts
        )

        let context = CompIQCandidateSearchContext(
            year: year,
            brand: trimmedOrNil(brand),
            setName: trimmedOrNil(setName),
            parallel: trimmedOrNil(parallel),
            maxProducts: maxProducts
        )

        return (request, context)
    }

    private func firstYear(in value: String) -> Int? {
        let pattern = #"\b(19|20)\d{2}\b"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              let range = Range(match.range, in: value) else {
            return nil
        }

        return Int(String(value[range]))
    }

    private func descriptorAfterYear(in value: String, year: Int?) -> String {
        guard let year,
              let range = value.range(of: String(year)) else {
            return value
        }

        return String(value[range.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-:|"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func extractedParallel(from descriptor: String) -> String? {
        let cleanedDescriptor = descriptor.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cleanedDescriptor.isEmpty == false else { return nil }

        let lowercased = cleanedDescriptor.lowercased()
        let keywords = [
            "cracked ice", "raywave", "gold wave", "blue wave", "green wave", "red wave",
            "black wave", "silver wave", "orange wave", "purple wave", "fuchsia", "nebula",
            "mojo", "atomic", "shimmer", "refractor", "superfractor", "wave", "lava",
            "diamond", "mojo", "blue", "green", "gold", "orange", "red", "silver",
            "black", "purple", "pink", "white", "aqua", "teal", "yellow"
        ]

        for keyword in keywords.sorted(by: { $0.count > $1.count }) {
            if let range = lowercased.range(of: keyword) {
                return String(cleanedDescriptor[range.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        let serialPattern = #"(?:/\d+|\d+/\d+)$"#
        if let regex = try? NSRegularExpression(pattern: serialPattern),
           let match = regex.firstMatch(in: cleanedDescriptor, range: NSRange(cleanedDescriptor.startIndex..., in: cleanedDescriptor)),
           let range = Range(match.range, in: cleanedDescriptor) {
            return String(cleanedDescriptor[range]).trimmingCharacters(in: .whitespacesAndNewlines)
        }

        return nil
    }

    private func removeParallel(_ parallel: String?, from descriptor: String) -> String {
        guard let parallel, parallel.isEmpty == false else { return descriptor }

        let trimmedDescriptor = descriptor.replacingOccurrences(
            of: parallel,
            with: "",
            options: [.caseInsensitive, .diacriticInsensitive]
        )

        return trimmedDescriptor
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-:|"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func trimmedOrNil(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static let purchaseDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct PortfolioAddFlowView: View {
    @StateObject private var viewModel: PortfolioAddFlowViewModel
    @State private var path: [PortfolioAddRoute] = []

    let onSave: (() -> Void)?
    let onDismiss: (() -> Void)?

    @MainActor
    init(
        viewModel: PortfolioAddFlowViewModel? = nil,
        onSave: (() -> Void)? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        _viewModel = StateObject(wrappedValue: viewModel ?? PortfolioAddFlowViewModel())
        self.onSave = onSave
        self.onDismiss = onDismiss
    }

    var body: some View {
        NavigationStack(path: $path) {
            PortfolioAddSearchStepView(
                viewModel: viewModel,
                onSearchSuccess: {
                    path.append(.details)
                },
                onDismiss: {
                    onDismiss?()
                }
            )
            .navigationDestination(for: PortfolioAddRoute.self) { route in
                switch route {
                case .verify:
                    CompIQCardSelectionView(
                        candidates: viewModel.candidateVariants,
                        onSelect: { variant in
                            viewModel.selectedVariant = variant
                            path.append(.details)
                        },
                        title: "Verify Card",
                        subtitle: "Tap the exact variant you own before entering clean purchase data.",
                        dismissOnSelect: false
                    )
                case .details:
                    PortfolioAddDetailsStepView(
                        viewModel: viewModel,
                        onSave: {
                            Task {
                                let didSave = await viewModel.save()
                                if didSave {
                                    onSave?()
                                    onDismiss?()
                                }
                            }
                        },
                        onCancel: {
                            onDismiss?()
                        }
                    )
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .background { HobbyIQBackground() }
        .onAppear {
            if path.isEmpty {
                viewModel.reset()
            }
        }
    }
}

private struct PortfolioAddSearchStepView: View {
    @ObservedObject var viewModel: PortfolioAddFlowViewModel
    let onSearchSuccess: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 14) {
                header
                searchCard
                conditionCard

                if viewModel.isLoading {
                    loadingCard
                }

                if let errorMessage = viewModel.errorMessage {
                    errorCard(message: errorMessage)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background { HobbyIQBackground() }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Add Card")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") {
                    onDismiss()
                }
                .foregroundStyle(HobbyIQTheme.textSecondary)
            }
        }
    }

    private var header: some View {
        HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Search once")
                    .font(.title3.bold())
                    .foregroundStyle(.white)

                Text("Type the card once. We’ll parse it, verify pricing live, and keep the purchase details clean from the start.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)

                Text("Better data leads to better ROI and trend analytics.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.greenBright)
            }
        }
    }

    private var searchCard: some View {
        HobbyIQSurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Search card")
                    .font(.headline)
                    .foregroundStyle(.white)

                Text("Start with the card title. We will search exact variants, then let you tap the one that matches.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)

                HobbyIQSearchField(
                    text: $viewModel.searchText,
                    placeholder: "Dylan Crews - 2025 Bowman Chrome Blue Auto /150",
                    onSubmit: {
                        Task { await searchAndVerify() }
                    }
                )

                if viewModel.estimateResult == nil {
                    Button {
                        Task { await searchAndVerify() }
                    } label: {
                        HStack(spacing: 8) {
                            if viewModel.isLoading {
                                ProgressView().tint(.white)
                                Text("Searching eBay sales…")
                            } else {
                                Image(systemName: "magnifyingglass")
                                Text("Search & Verify Card")
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(viewModel.isLoading || viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).count <= 2)
                }

                if let variant = viewModel.selectedVariant, viewModel.estimateResult != nil {
                    resolvedVariantChip(variant)
                }

                if let verifiedText = verifiedBannerText, viewModel.estimateResult != nil {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                        Text("Verified")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.green)
                        Spacer(minLength: 0)
                        Text(verifiedText)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    private var conditionCard: some View {
        HobbyIQSurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Condition")
                    .font(.headline)
                    .foregroundStyle(.white)

                HStack(spacing: 10) {
                    conditionPill(title: "Raw", isSelected: viewModel.isGraded == false) {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            viewModel.isGraded = false
                        }
                    }

                    conditionPill(title: "Graded", isSelected: viewModel.isGraded) {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            viewModel.isGraded = true
                        }
                    }
                }

                if viewModel.isGraded {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Grading company")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(["PSA", "BGS", "SGC", "CGC"], id: \.self) { company in
                                    conditionTag(title: company, isSelected: viewModel.gradingCompany == company) {
                                        viewModel.gradingCompany = company
                                    }
                                }
                            }
                            .padding(.vertical, 2)
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("Grade")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)

                            Picker("Grade", selection: $viewModel.gradeValue) {
                                ForEach((1...10).reversed(), id: \.self) { grade in
                                    Text("\(grade)").tag(String(grade))
                                }
                            }
                            .pickerStyle(.wheel)
                            .frame(height: 120)
                            .clipped()
                        }
                    }
                }
            }
        }
    }

    private var loadingCard: some View {
        HStack(spacing: 12) {
            ProgressView().tint(HobbyIQTheme.green)
            Text("Searching eBay sales…")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func errorCard(message: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 6) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.textSecondary)

                Button("Retry") {
                    Task { await searchAndVerify() }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.blue)
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .background(HobbyIQTheme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.orange.opacity(0.24), lineWidth: 1.6)
        )
        .cornerRadius(14)
    }

    private func resolvedVariantChip(_ variant: CompIQResolvedVariant) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(.green)

            VStack(alignment: .leading, spacing: 2) {
                Text(variant.playerName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)

                Text(resolvedVariantSubtitle(for: variant))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }

            Spacer(minLength: 0)

            Button("Edit") {
                viewModel.estimateResult = nil
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.blue)
            .buttonStyle(.plain)

            Button {
                Task { await searchAndVerify() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.blue)
                    .padding(6)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Refresh pricing")
        }
        .padding(12)
        .background(Color.green.opacity(0.10))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.green.opacity(0.30), lineWidth: 1.4)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func resolvedVariantSubtitle(for variant: CompIQResolvedVariant) -> String {
        let tags = [
            variant.year.map(String.init),
            variant.setName,
            variant.parallel
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }

        if tags.isEmpty {
            return variant.subtitle.isEmpty ? "Verified" : variant.subtitle
        }

        return tags.joined(separator: " • ")
    }

    private func conditionPill(title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(isSelected ? .white : HobbyIQTheme.textSecondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(isSelected ? HobbyIQTheme.blue.opacity(0.22) : HobbyIQTheme.bgSecondary)
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(isSelected ? HobbyIQTheme.blue.opacity(0.55) : HobbyIQTheme.stroke, lineWidth: 1.4)
                )
                .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func conditionTag(title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(isSelected ? .white : HobbyIQTheme.textSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(isSelected ? HobbyIQTheme.blue.opacity(0.22) : HobbyIQTheme.bgSecondary)
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(isSelected ? HobbyIQTheme.blue.opacity(0.55) : HobbyIQTheme.stroke, lineWidth: 1.4)
                )
                .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func searchAndVerify() async {
        let query = viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count > 2 else {
            viewModel.errorMessage = "Could not verify card — check your description and try again."
            return
        }

        let parsed = parseCardQuery(query)
        let gradeCompany = viewModel.isGraded ? viewModel.gradingCompany.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let gradeValue = viewModel.isGraded ? Int(viewModel.gradeValue) : nil
        viewModel.selectedVariant = CompIQResolvedVariant(
            playerName: parsed.playerName,
            canonicalCardName: [parsed.product, parsed.parallel]
                .compactMap { $0 }
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines),
            subtitle: viewModel.isGraded
                ? [gradeCompany, gradeValue.map(String.init)]
                    .compactMap { $0 }
                    .joined(separator: " ")
                : (parsed.isAuto ? "Auto" : ""),
            year: parsed.cardYear,
            setName: parsed.product,
            parallel: parsed.parallel,
            grade: viewModel.isGraded
                ? [gradeCompany, gradeValue.map(String.init)]
                    .compactMap { $0 }
                    .joined(separator: " ")
                : "Raw",
            // CF-AUTOPRICE-GRADE-CONTRACT: carry canonical structured grade
            // through the variant so the addInventoryCard path can populate
            // InventoryCard.gradeCompany/gradeValue for backend autoPriceHolding.
            gradeCompany: gradeCompany,
            gradeValue: gradeValue,
            serialNumber: nil,
            isAuto: parsed.isAuto
        )
        viewModel.errorMessage = nil
        viewModel.isLoading = true
        defer { viewModel.isLoading = false }

        viewModel.searchText = query
        viewModel.estimateResult = nil

        let request = CardEstimateRequest(
            playerName: parsed.playerName,
            cardYear: parsed.cardYear,
            product: parsed.product,
            parallel: parsed.parallel,
            isAuto: parsed.isAuto ? true : nil,
            gradeCompany: gradeCompany,
            gradeValue: gradeValue
        )

        do {
            let result = try await APIService.shared.estimateCardDirect(request: request)
            viewModel.estimateResult = result
            viewModel.errorMessage = nil
            onSearchSuccess()
        } catch {
            viewModel.estimateResult = nil
            viewModel.errorMessage = "Could not verify card — check your description and try again."
        }
    }

    private var verifiedBannerText: String? {
        if let parallel = viewModel.estimateResult?.pricingAnalytics?.parallelDetected?.trimmingCharacters(in: .whitespacesAndNewlines),
           parallel.isEmpty == false {
            return parallel
        }
        if let comps = viewModel.estimateResult?.pricingAnalytics?.compsUsed {
            return "\(comps) comps used"
        }
        return nil
    }
}

private struct PortfolioAddDetailsStepView: View {
    @ObservedObject var viewModel: PortfolioAddFlowViewModel
    let onSave: () -> Void
    let onCancel: () -> Void

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 14) {
                header
                selectedVariantCard
                estimateResultCard
                purchaseDetailsCard
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background { HobbyIQBackground() }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Purchase Details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") {
                    onCancel()
                }
                .foregroundStyle(HobbyIQTheme.textSecondary)
            }
        }
    }

    private var header: some View {
        HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Enter clean purchase details")
                    .font(.title3.bold())
                    .foregroundStyle(.white)

                Text("Keep the purchase date and source standardized. Cleaner data makes ROI and trend analytics easier to trust.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }
        }
    }

    @ViewBuilder
    private var selectedVariantCard: some View {
        if let variant = viewModel.selectedVariant {
            HobbyIQSurfaceCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Verified card")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                        .tracking(1.2)

                    Text(variant.playerName)
                        .font(.headline.bold())
                        .foregroundStyle(.white)

                    Text(variant.canonicalCardName)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.textSecondary)

                    if variant.subtitle.isEmpty == false {
                        Text(variant.subtitle)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.greenBright)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var estimateResultCard: some View {
        if let result = viewModel.estimateResult {
            HobbyIQSurfaceCard {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .center, spacing: 10) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Verified estimate")
                                .font(.headline.bold())
                                .foregroundStyle(.white)
                            if let verdict = result.verdict, verdict.isEmpty == false {
                                Text(verdict)
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.textSecondary)
                            }
                        }
                        Spacer(minLength: 0)
                        if let parallel = result.pricingAnalytics?.parallelDetected, parallel.isEmpty == false {
                            Text(parallel)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.greenBright)
                        } else if let comps = result.pricingAnalytics?.compsUsed {
                            Text("\(comps) comps")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.greenBright)
                        }
                    }

                    HStack(spacing: 10) {
                        estimateTile(title: "Fair Market", value: result.fairMarketValue, accent: .blue)
                        estimateTile(title: "Quick Sale", value: result.quickSaleValue, accent: .orange)
                        estimateTile(title: "Suggested List", value: result.premiumValue, accent: .purple)
                    }

                    if let verdict = result.verdict, verdict.isEmpty == false {
                        HStack {
                            Spacer(minLength: 0)
                            Text(verdict)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(verdictColor(verdict).opacity(0.18))
                                .foregroundStyle(verdictColor(verdict))
                                .clipShape(Capsule())
                        }
                    }
                }
            }
        }
    }

    private var purchaseDetailsCard: some View {
        HobbyIQSurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Purchase details")
                    .font(.headline)
                    .foregroundStyle(.white)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Purchase date")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)

                    DatePicker(
                        "Purchase date",
                        selection: $viewModel.purchaseDate,
                        displayedComponents: .date
                    )
                    .datePickerStyle(.compact)
                    .colorScheme(.dark)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Purchase location")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)

                    Picker("Purchase location", selection: $viewModel.purchasePlatform) {
                        ForEach(PurchasePlatformOption.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(HobbyIQTheme.blue)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                formField(
                    title: "Cost paid",
                    text: $viewModel.costPaid,
                    placeholder: "0.00",
                    keyboard: .decimalPad
                )

                formField(
                    title: "Current value",
                    text: $viewModel.currentValue,
                    placeholder: "Defaults to cost",
                    keyboard: .decimalPad
                )

                if let errorMessage = viewModel.errorMessage {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(HobbyIQTheme.bgSecondary.opacity(0.85))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Color.orange.opacity(0.18), lineWidth: 1.6)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                Button {
                    save()
                } label: {
                    HStack(spacing: 8) {
                        if viewModel.isSaving {
                            ProgressView().tint(.white)
                        }
                        Text(viewModel.isSaving ? "Adding..." : "Add to My Collection")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!canAddToCollection)
            }
        }
    }

    private var canAddToCollection: Bool {
        guard viewModel.estimateResult != nil else { return false }
        guard let purchaseCost = decimal(from: viewModel.costPaid), purchaseCost > 0 else { return false }
        return viewModel.isSaving == false
    }

    private func formField(
        title: String,
        text: Binding<String>,
        placeholder: String,
        keyboard: UIKeyboardType = .default
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            TextField(placeholder, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(14)
                .background(HobbyIQTheme.cardElevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(HobbyIQTheme.stroke, lineWidth: 1.6)
                )
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .foregroundStyle(.white)
        }
    }

    private func save() {
        Task {
            onSave()
        }
    }

    private func decimal(from value: String) -> Double? {
        let sanitized = value
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Double(sanitized)
    }

    private func estimateTile(title: String, value: Double?, accent: Color) -> some View {
        VStack(spacing: 3) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.textSecondary)
            Text(value.map { String(format: "$%.0f", $0) } ?? "--")
                .font(.headline.bold())
                .foregroundStyle(accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(HobbyIQTheme.bgSecondary.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(HobbyIQTheme.stroke, lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func verdictColor(_ verdict: String) -> Color {
        let s = verdict.lowercased()
        if s.contains("sell") { return .red }
        if s.contains("buy") || s.contains("hold") { return .green }
        return .orange
    }
}

private func parseCardQuery(_ query: String) -> (playerName: String, cardYear: Int?, product: String?, parallel: String?, isAuto: Bool) {
    var remaining = query

    let autoPattern = try? NSRegularExpression(pattern: "\\bauto(graph)?\\b", options: .caseInsensitive)
    var isAuto = false
    if let match = autoPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
       let range = Range(match.range, in: remaining) {
        isAuto = true
        remaining.replaceSubrange(range, with: "")
        remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    let yearPattern = try? NSRegularExpression(pattern: "\\b(19|20)\\d{2}\\b")
    var cardYear: Int? = nil
    if let match = yearPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
       let range = Range(match.range, in: remaining) {
        cardYear = Int(remaining[range])
        remaining.replaceSubrange(range, with: "")
        remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    let products = [
        "Bowman Chrome Draft", "Bowman Chrome", "Bowman Draft", "Bowman Platinum",
        "Topps Chrome", "Topps Series 1", "Topps Series 2", "Topps Update", "Topps Heritage",
        "Stadium Club", "Prizm Draft", "National Treasures", "Immaculate",
        "Contenders", "Select", "Optic", "Mosaic", "Certified", "Finest",
        "Gypsy Queen", "Allen & Ginter", "Topps"
    ]

    var product: String? = nil
    for candidate in products {
        if let range = remaining.range(of: candidate, options: .caseInsensitive) {
            product = candidate
            remaining.replaceSubrange(range, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
            break
        }
    }

    let parallels = [
        "Gold Refractor", "Blue Refractor", "Orange Refractor", "Red Refractor",
        "Green Refractor", "1st Bowman", "1st Edition", "Superfractor",
        "Gold Vinyl", "Blue Wave", "Aqua",
        "Refractor", "Prizm", "Holo",
        "Gold", "Silver", "Orange", "Blue", "Green", "Red", "Purple", "Pink", "Black"
    ]

    var parallel: String? = nil
    for candidate in parallels {
        if let range = remaining.range(of: candidate, options: .caseInsensitive) {
            parallel = candidate
            remaining.replaceSubrange(range, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
            break
        }
    }

    let playerName = remaining
        .replacingOccurrences(of: "  ", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)

    return (
        playerName: playerName.isEmpty ? query : playerName,
        cardYear: cardYear,
        product: product,
        parallel: parallel,
        isAuto: isAuto
    )
}

#Preview {
    PortfolioAddFlowView()
}
