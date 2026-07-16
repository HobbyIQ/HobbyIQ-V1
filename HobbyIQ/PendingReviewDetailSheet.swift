//
//  PendingReviewDetailSheet.swift
//  HobbyIQ
//
//  Single-holding review surface (backend PRs #383-#388). Left column
//  = editable extracted fields; right column = read-only
//  `ebayItemAspects` reference so the user has the raw eBay data next
//  to what the parser inferred. Bottom = confirm / reject actions.
//
//  Confirm request MUST omit unchanged fields — the request body is
//  built by diffing user input against the holding's decoded values.
//

import SwiftUI

struct PendingReviewDetailSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let holding: InventoryCard
    let onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss

    // Editable fields — seeded from the holding, overwritten by the user.
    @State private var playerName: String
    @State private var cardYearText: String
    @State private var setName: String
    @State private var parallel: String
    @State private var cardNumber: String     // holding doesn't carry a first-class field yet; keep local
    @State private var gradeCompany: String
    @State private var gradeValueText: String
    @State private var team: String
    @State private var sport: String
    @State private var isAuto: Bool

    // Async state.
    @State private var isConfirming = false
    @State private var isRejecting = false
    @State private var errorMessage: String?
    @State private var photoIndex: Int = 0

    init(viewModel: PortfolioIQViewModel, holding: InventoryCard, onFinished: @escaping () -> Void) {
        self.viewModel = viewModel
        self.holding = holding
        self.onFinished = onFinished
        _playerName = State(initialValue: holding.playerName)
        _cardYearText = State(initialValue: holding.year)
        _setName = State(initialValue: holding.setName)
        _parallel = State(initialValue: holding.parallel)
        _cardNumber = State(initialValue: "")
        _gradeCompany = State(initialValue: holding.gradeCompany ?? "")
        _gradeValueText = State(initialValue: holding.gradeValue.map { formatGrade($0) } ?? "")
        _team = State(initialValue: holding.team ?? "")
        _sport = State(initialValue: holding.sport ?? "")
        _isAuto = State(initialValue: holding.isAuto)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                photoGallery
                if let desc = holding.ebayShortDescription?.trimmingCharacters(in: .whitespacesAndNewlines),
                   desc.isEmpty == false {
                    Text(desc)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                }
                if let seller = holding.ebaySeller {
                    sellerFooter(seller)
                }
                sideBySide
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                }
                actionRow
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Confirm holding")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    // MARK: Photo gallery

    private var galleryUrls: [String] {
        var urls: [String] = holding.photos ?? []
        if let front = holding.imageFrontUrl, front.isEmpty == false, urls.contains(front) == false {
            urls.append(front)
        }
        if urls.isEmpty, let ebay = holding.ebayImageUrl, ebay.isEmpty == false {
            urls.append(ebay)
        }
        return urls
    }

    @ViewBuilder
    private var photoGallery: some View {
        if galleryUrls.isEmpty {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                .frame(height: 220)
                .overlay(
                    Image(systemName: "rectangle.portrait")
                        .font(.system(size: 32, weight: .light))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                )
        } else {
            TabView(selection: $photoIndex) {
                ForEach(Array(galleryUrls.enumerated()), id: \.offset) { idx, urlString in
                    if let url = URL(string: urlString) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().scaledToFit()
                            case .empty:
                                ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                            case .failure:
                                Image(systemName: "photo.badge.exclamationmark")
                                    .font(.system(size: 28))
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                            @unknown default:
                                EmptyView()
                            }
                        }
                        .tag(idx)
                        .padding(4)
                    }
                }
            }
            .tabViewStyle(.page)
            .frame(height: 260)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: Left = editable / Right = read-only aspects

    private var sideBySide: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 10) {
                    HIQSectionHeader("Extracted")
                    editableFields
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 10) {
                    HIQSectionHeader("From eBay")
                    aspectsList
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var editableFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            editableField(label: "Player", text: $playerName)
            editableField(label: "Year", text: $cardYearText, keyboard: .numberPad)
            editableField(label: "Set", text: $setName)
            editableField(label: "Parallel", text: $parallel)
            editableField(label: "Card #", text: $cardNumber)
            editableField(label: "Grader", text: $gradeCompany)
            editableField(label: "Grade", text: $gradeValueText, keyboard: .decimalPad)
            editableField(label: "Team", text: $team)
            editableField(label: "Sport", text: $sport)
            Toggle(isOn: $isAuto) {
                Text("Autograph")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .tint(HobbyIQTheme.Colors.electricBlue)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func editableField(label: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.4)
            TextField(label, text: text)
                .keyboardType(keyboard)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }

    @ViewBuilder
    private var aspectsList: some View {
        let aspects = holding.ebayItemAspects ?? [:]
        if aspects.isEmpty {
            Text("eBay didn't send item specifics for this listing.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .padding(HobbyIQTheme.Spacing.medium)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        } else {
            let orderedKeys = aspects.keys.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(orderedKeys, id: \.self) { key in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(key)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.4)
                        Text(aspects[key] ?? "")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    // MARK: Seller footer

    private func sellerFooter(_ seller: EbaySeller) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "person.crop.circle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let fb = seller.feedbackScore {
                Text("Bought from @\(seller.username) (\(fb))")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            } else {
                Text("Bought from @\(seller.username)")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
    }

    // MARK: Actions

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button(role: .destructive) {
                Task { await reject() }
            } label: {
                HStack(spacing: 6) {
                    if isRejecting {
                        ProgressView().tint(HobbyIQTheme.Colors.danger).controlSize(.small)
                    } else {
                        Image(systemName: "trash.fill")
                    }
                    Text(isRejecting ? "Rejecting…" : "Reject")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.danger)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(HobbyIQTheme.Colors.danger.opacity(0.14))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.danger.opacity(0.35), lineWidth: 1)
                )
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isConfirming || isRejecting)

            Button {
                Task { await confirm() }
            } label: {
                HStack(spacing: 8) {
                    if isConfirming {
                        ProgressView().tint(HobbyIQTheme.Colors.pureWhite).controlSize(.small)
                    } else {
                        Image(systemName: "checkmark.seal.fill")
                    }
                    Text(isConfirming ? "Confirming…" : "Confirm")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isConfirming || isRejecting)
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
    }

    // MARK: Backend I/O

    private var identifier: String {
        holding.cardId ?? holding.id.uuidString
    }

    private func confirm() async {
        errorMessage = nil
        isConfirming = true
        defer { isConfirming = false }

        // Diff each field against the seed — only send what changed.
        var patch = HoldingConfirmRequest.empty
        if playerName != holding.playerName {
            patch.playerName = playerName
        }
        if cardYearText != holding.year, let y = Int(cardYearText) {
            patch.cardYear = y
        }
        if setName != holding.setName {
            patch.setName = setName
        }
        if parallel != holding.parallel {
            patch.parallel = parallel
        }
        if cardNumber.isEmpty == false {
            patch.cardNumber = cardNumber
        }
        if gradeCompany != (holding.gradeCompany ?? "") {
            patch.gradeCompany = gradeCompany.isEmpty ? nil : gradeCompany
        }
        let originalGradeText = holding.gradeValue.map { formatGrade($0) } ?? ""
        if gradeValueText != originalGradeText {
            patch.gradeValue = Double(gradeValueText)
        }
        if team != (holding.team ?? "") {
            patch.team = team.isEmpty ? nil : team
        }
        if sport != (holding.sport ?? "") {
            patch.sport = sport.isEmpty ? nil : sport
        }
        if isAuto != holding.isAuto {
            patch.isAuto = isAuto
        }

        let didSave = await viewModel.confirmPendingHolding(id: identifier, patch: patch)
        if didSave {
            onFinished()
            dismiss()
        } else {
            errorMessage = viewModel.errorMessage ?? "Couldn't confirm. Try again."
        }
    }

    private func reject() async {
        errorMessage = nil
        isRejecting = true
        defer { isRejecting = false }
        let didReject = await viewModel.rejectPendingHolding(id: identifier)
        if didReject {
            onFinished()
            dismiss()
        } else {
            errorMessage = viewModel.errorMessage ?? "Couldn't reject. Try again."
        }
    }
}

/// Formats a Double grade back into the string the user expects
/// ("9.5" instead of "9.500000", "10" instead of "10.0").
private func formatGrade(_ value: Double) -> String {
    if value.truncatingRemainder(dividingBy: 1) == 0 {
        return String(Int(value))
    }
    return String(format: "%.1f", value)
}
