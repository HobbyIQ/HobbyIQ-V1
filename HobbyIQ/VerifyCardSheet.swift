//
//  VerifyCardSheet.swift
//  HobbyIQ
//
//  PR #441 (2026-07-14): Verify Card sheet — the pre-commit checkpoint
//  the auto-import pipeline hands off to. User cleans the parsed
//  fields, sees live suggester feedback (best match, alternatives,
//  what the normalizer cleaned), and confirms the cardId that
//  ships to the confirm endpoint.
//
//  v1 scope:
//    - Manual open only (backend `verificationStatus` gate lands in a
//      follow-up PR; the auto-open trigger will hook into that).
//    - No rule-toggling — the normalized-changes block is display-only.
//    - No bulk verify — one holding at a time.
//    - Debounced dry-run calls (500ms) fire on every field edit.
//

import SwiftUI

struct VerifyCardSheet: View {
    let holding: InventoryCard
    let onConfirmed: () -> Void

    @Environment(\.dismiss) private var dismiss

    // Editable field state — seeded from the holding on init.
    @State private var playerName: String
    @State private var cardYearText: String
    @State private var setName: String
    @State private var parallel: String
    @State private var cardNumber: String
    @State private var isAuto: Bool

    // Suggester state. `selectedCardId` starts as the best match's
    // cardId; tapping an alternative points it at that alternative
    // instead. Confirm commits whichever is selected.
    @State private var response: DryRunSuggestResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedCardId: String?
    @State private var debounceTask: Task<Void, Never>?

    // Confirm state.
    @State private var isConfirming = false
    @State private var confirmError: String?

    init(holding: InventoryCard, onConfirmed: @escaping () -> Void) {
        self.holding = holding
        self.onConfirmed = onConfirmed
        _playerName = State(initialValue: holding.playerName)
        _cardYearText = State(initialValue: holding.year)
        _setName = State(initialValue: holding.setName)
        _parallel = State(initialValue: holding.parallel)
        _cardNumber = State(initialValue: "")
        _isAuto = State(initialValue: holding.isAuto)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    yourCardSection
                    normalizedChangesSection
                    searchAgainButton
                    Divider().overlay(Color.white.opacity(0.08))
                    bestMatchSection
                    alternativesSection

                    if let confirmError {
                        Text(confirmError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, 16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Verify Card")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await confirm() }
                    } label: {
                        if isConfirming {
                            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        } else {
                            Text("Confirm")
                                .foregroundStyle(selectedCardId == nil ? HobbyIQTheme.Colors.mutedText : HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                    .disabled(selectedCardId == nil || isConfirming)
                }
            }
            .task { await runSuggest(force: true) }
        }
    }

    // MARK: - Section: Your Card (editable fields)

    private var yourCardSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Your Card")
            VStack(spacing: 10) {
                verifyField("Player", text: $playerName)
                    .onChange(of: playerName) { _, _ in scheduleSuggest() }
                verifyField("Year", text: $cardYearText, keyboard: .numberPad)
                    .onChange(of: cardYearText) { _, _ in scheduleSuggest() }
                verifyField("Set", text: $setName)
                    .onChange(of: setName) { _, _ in scheduleSuggest() }
                verifyField("Parallel", text: $parallel)
                    .onChange(of: parallel) { _, _ in scheduleSuggest() }
                verifyField("Card #", text: $cardNumber, keyboard: .default)
                    .onChange(of: cardNumber) { _, _ in scheduleSuggest() }
                HStack {
                    Text("Auto")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white)
                    Spacer()
                    Toggle("", isOn: $isAuto)
                        .labelsHidden()
                        .tint(HobbyIQTheme.Colors.electricBlue)
                        .onChange(of: isAuto) { _, _ in scheduleSuggest() }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    // MARK: - Section: Normalized changes

    @ViewBuilder
    private var normalizedChangesSection: some View {
        if let changes = response?.normalized?.changes, changes.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("Cleaned by normalizer")
                        .font(.caption.weight(.bold))
                        .tracking(0.6)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(changes) { change in
                        normalizedChangeRow(change: change)
                    }
                }
                .padding(12)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.white.opacity(0.06), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func normalizedChangeRow(change: NormalizedChange) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(change.displayLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            HStack(spacing: 6) {
                Text("\"\(change.before ?? "")\"")
                    .font(.caption.monospaced())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .strikethrough()
                Image(systemName: "arrow.right")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("\"\(change.after ?? "")\"")
                    .font(.caption.monospaced())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
        }
    }

    // MARK: - Search again button

    private var searchAgainButton: some View {
        Button {
            Task { await runSuggest(force: true) }
        } label: {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                } else {
                    Image(systemName: "magnifyingglass")
                        .font(.caption.weight(.semibold))
                }
                Text(isLoading ? "Searching…" : "Search Again")
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.10))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
    }

    // MARK: - Section: Best match

    @ViewBuilder
    private var bestMatchSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionHeader("Best Match")
                Spacer()
                tierBadge(SuggestionTier.from(response?.suggestion?.confidenceTier))
            }
            if let suggestion = response?.suggestion {
                suggestionRow(suggestion: suggestion, isBestMatch: true)
            } else if isLoading {
                HStack {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Finding a match…")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .padding(.vertical, 12)
            } else if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            } else {
                Text("No candidate found. Edit the fields above and search again.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    // MARK: - Section: Alternatives

    @ViewBuilder
    private var alternativesSection: some View {
        if let alternatives = response?.suggestion?.alternatives, alternatives.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Or Pick an Alternative")
                VStack(spacing: 8) {
                    ForEach(alternatives) { alt in
                        suggestionRow(suggestion: alt, isBestMatch: false)
                    }
                }
            }
        }
    }

    // MARK: - Suggestion row

    private func suggestionRow(suggestion: CardIdSuggestion, isBestMatch: Bool) -> some View {
        let isSelected = selectedCardId == suggestion.cardId
        return Button {
            selectedCardId = suggestion.cardId
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18))
                    .foregroundStyle(isSelected ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText)

                suggestionThumbnail(imageUrl: suggestion.candidate?.image)

                VStack(alignment: .leading, spacing: 4) {
                    Text(suggestionTitleLine(suggestion))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let variant = suggestion.candidate?.variant,
                       variant.isEmpty == false {
                        Text("\(variant)\(suggestion.candidate?.number.map { " · #\($0)" } ?? "")")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(1)
                    }
                    suggestionMatchLine(suggestion: suggestion, isBestMatch: isBestMatch)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(isSelected ? HobbyIQTheme.Colors.electricBlue.opacity(0.6) : Color.white.opacity(0.06), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func suggestionTitleLine(_ suggestion: CardIdSuggestion) -> String {
        if let title = suggestion.candidate?.title, title.isEmpty == false {
            return title
        }
        let parts: [String] = [
            suggestion.candidate?.year.map { String($0) },
            suggestion.candidate?.set,
            suggestion.candidate?.number.map { "#\($0)" }
        ].compactMap { $0 }.filter { $0.isEmpty == false }
        return parts.isEmpty ? "Candidate" : parts.joined(separator: " ")
    }

    private func suggestionThumbnail(imageUrl: String?) -> some View {
        Group {
            if let url = imageUrl.flatMap(URL.init) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                    default:
                        Image(systemName: "rectangle.portrait")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(width: 42, height: 56)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.25))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private func suggestionMatchLine(suggestion: CardIdSuggestion, isBestMatch: Bool) -> some View {
        let breakdown = suggestion.matchBreakdown
        let matched = breakdown?.fieldsMatched ?? 0
        let checked = breakdown?.fieldsChecked ?? 0
        let source = suggestion.sourceLabel
        let confidence = suggestion.confidence.map { String(format: "%.2f", $0) }
        return HStack(spacing: 6) {
            if checked > 0 {
                Image(systemName: matched == checked ? "checkmark.circle.fill" : "info.circle")
                    .font(.caption2)
                    .foregroundStyle(matched == checked ? .green : .orange)
                Text("\(matched) of \(checked) fields match")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Text("· \(source)")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if isBestMatch == false, let confidence {
                Text("· \(confidence)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    // MARK: - Tier badge

    private func tierBadge(_ tier: SuggestionTier) -> some View {
        let (icon, label, color): (String, String, Color) = {
            switch tier {
            case .high: return ("checkmark.seal.fill", "HIGH", .green)
            case .medium: return ("exclamationmark.triangle.fill", "MEDIUM", .orange)
            case .low: return ("xmark.octagon.fill", "LOW", Color(red: 1.0, green: 0.4, blue: 0.4))
            case .none: return ("questionmark.circle", "NO MATCH", .gray)
            }
        }()
        return HStack(spacing: 4) {
            Image(systemName: icon).font(.caption2)
            Text(label)
                .font(.caption2.weight(.bold))
                .tracking(0.5)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(color.opacity(0.15))
        .clipShape(Capsule(style: .continuous))
    }

    // MARK: - Field

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .tracking(0.8)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }

    private func verifyField(_ label: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .frame(width: 76, alignment: .leading)
            TextField("", text: text)
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(10)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }

    // MARK: - Debounced suggest

    private func scheduleSuggest() {
        debounceTask?.cancel()
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return }
            await runSuggest(force: false)
        }
    }

    private func runSuggest(force: Bool) async {
        // Cancel any pending debounce when the caller wants an immediate
        // fire (`force = true`) so we don't fire twice.
        if force { debounceTask?.cancel() }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let request = DryRunSuggestRequest(
            playerName: nilIfEmpty(playerName),
            cardYear: Int(cardYearText.trimmingCharacters(in: .whitespaces)),
            setName: nilIfEmpty(setName),
            parallel: nilIfEmpty(parallel),
            cardNumber: nilIfEmpty(cardNumber),
            isAuto: isAuto,
            isRookie: nil
        )
        do {
            let result = try await APIService.shared.dryRunSuggest(request)
            await MainActor.run {
                response = result
                // Default selection tracks the best-match cardId
                // whenever a new suggestion arrives, unless the user
                // has explicitly picked an alternative already.
                if let best = result.suggestion?.cardId,
                   selectedCardId == nil || result.suggestion?.alternatives?.contains(where: { $0.cardId == selectedCardId }) != true {
                    selectedCardId = best
                }
            }
        } catch {
            await MainActor.run {
                errorMessage = "Couldn't reach the suggester. Try again in a moment."
            }
        }
    }

    private func nilIfEmpty(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Confirm

    private func confirm() async {
        guard let cardId = selectedCardId else { return }
        // Use `backendId` (raw wire string) when present — the confirm
        // endpoint keys off the backend's stable id, not the local
        // deterministic UUID iOS derives from it.
        let holdingId: String = holding.backendId?.trimmingCharacters(in: .whitespaces).nonEmpty
            ?? holding.id.uuidString

        isConfirming = true
        confirmError = nil
        defer { isConfirming = false }

        var request = HoldingConfirmRequest.empty
        request.playerName = nilIfEmpty(playerName)
        request.cardYear = Int(cardYearText.trimmingCharacters(in: .whitespaces))
        request.setName = nilIfEmpty(setName)
        request.parallel = nilIfEmpty(parallel)
        request.cardNumber = nilIfEmpty(cardNumber)
        request.isAuto = isAuto
        request.cardId = cardId

        do {
            _ = try await APIService.shared.confirmPendingHolding(id: holdingId, patch: request)
            await MainActor.run {
                onConfirmed()
                dismiss()
            }
        } catch {
            await MainActor.run {
                confirmError = "Couldn't confirm. \(error.localizedDescription)"
            }
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
