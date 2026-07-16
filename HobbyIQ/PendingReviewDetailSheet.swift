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

    // CF-CARDID-SUGGEST (backend PR #389): the accepted / user-picked
    // cardId that flows into the confirm body when set. Seeded from
    // the holding's existing `cardId` so users who already picked a
    // match don't lose the reference on re-open.
    @State private var acceptedCardId: String?

    // Async state.
    @State private var isConfirming = false
    @State private var isRejecting = false
    @State private var isSearchingCatalog = false
    @State private var errorMessage: String?
    @State private var photoIndex: Int = 0
    @State private var showCatalogSearch = false
    /// Overrides `holding.suggestionCandidate` when the user picks a
    /// row from the catalog search sheet — so the review card renders
    /// the fresh pick instead of the stale server suggestion.
    @State private var pickedCandidate: (cardId: String, candidate: SuggestionCandidate)?

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
        _acceptedCardId = State(initialValue: holding.cardId)
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
                stepHeader(number: 1, title: "Match card", subtitle: "Pick the correct catalog card so pricing is accurate.")
                suggestedMatchCard
                stepHeader(number: 2, title: "Grade & details", subtitle: "Confirm the fields below. Values from your pick auto-fill on the left.")
                sideBySide
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
                }
                stepHeader(number: 3, title: "Confirm", subtitle: "Sends the clean row to your inventory.")
                actionRow
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Confirm holding")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .sheet(isPresented: $showCatalogSearch) {
            CatalogMatchSearchSheet(holding: holding) { hit in
                applyCatalogPick(hit)
            }
        }
    }

    /// Populates the review sheet's editable fields with the canonical
    /// values from the picked catalog card so the row lands in
    /// inventory with clean data. Every field the pick populated
    /// overwrites what the parser extracted; blank fields on the
    /// pick fall through to whatever was already in the form.
    private func applyCatalogPick(_ hit: CompIQVariantHit) {
        pickedCandidate = (
            cardId: hit.cardId,
            candidate: SuggestionCandidate(
                title: hit.title ?? hit.resolvedLabel,
                set: hit.set,
                year: hit.year.map(String.init),
                number: hit.number,
                variant: hit.variant,
                image: hit.imageUrl
            )
        )
        acceptedCardId = hit.cardId

        // Overwrite editable fields with the canonical pick so Confirm
        // sends clean player/year/set/parallel/cardNumber deltas and
        // the row shows up in inventory with the catalog's names.
        if let player = hit.player, player.isEmpty == false {
            playerName = player
        }
        if let y = hit.year {
            cardYearText = String(y)
        }
        if let set = hit.set, set.isEmpty == false {
            setName = set
        }
        if let variant = hit.variant, variant.isEmpty == false, variant.lowercased() != "base" {
            parallel = variant
        }
        if let number = hit.number, number.isEmpty == false {
            cardNumber = number
        }
        // Autograph flag isn't user-editable via a picker in the
        // catalog search results, but the hit tells us whether the
        // catalog card is autographed — sync so the confirm diff
        // reflects the pick.
        isAuto = hit.isAuto
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
            graderPickerField
            gradeValuePickerField
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

    // MARK: Grade dropdowns (CF-CLEAN-DATA-GRADES, 2026-07-12)
    //
    // Grade must be canonical for the backend to bucket the holding
    // into the right grade rail. Freetext lets things like "psa10",
    // "PSA-10", "10 gem mint" leak in, and the pricing pipeline can't
    // resolve those. Menu pickers force clean tokens: grader ∈
    // {Raw, PSA, BGS, SGC, CGC}, value ∈ standard 1.0–10.0 half-steps.

    private static let graderOptions: [String] = ["Raw", "PSA", "BGS", "SGC", "CGC"]
    /// CF-PROGRESSIVE-BUCKETS (backend PR #393): full half-step set so
    /// SGC / CGC / BGS half-grades below 8 are pickable without
    /// forcing free-text entry.
    private static let gradeValueOptions: [String] = [
        "10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6",
        "5.5", "5", "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"
    ]

    private var normalizedGrader: String {
        gradeCompany.trimmingCharacters(in: .whitespaces).uppercased()
    }

    /// User-visible grader label; "Raw" for ungraded, otherwise the
    /// company code.
    private var graderDisplay: String {
        if normalizedGrader.isEmpty { return "Raw" }
        if Self.graderOptions.contains(normalizedGrader) { return normalizedGrader }
        return normalizedGrader
    }

    private var graderPickerField: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Grader")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.4)
            Menu {
                ForEach(Self.graderOptions, id: \.self) { option in
                    Button(option) {
                        if option == "Raw" {
                            gradeCompany = ""
                            gradeValueText = ""
                        } else {
                            gradeCompany = option
                        }
                    }
                }
            } label: {
                HStack {
                    Text(graderDisplay)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
    }

    private var gradeValuePickerField: some View {
        let isRaw = graderDisplay == "Raw"
        return VStack(alignment: .leading, spacing: 3) {
            Text("Grade")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.4)
            Menu {
                ForEach(Self.gradeValueOptions, id: \.self) { option in
                    Button(option) {
                        gradeValueText = option
                    }
                }
                if gradeValueText.isEmpty == false {
                    Divider()
                    Button("Clear") { gradeValueText = "" }
                }
            } label: {
                HStack {
                    Text(isRaw ? "—" : (gradeValueText.isEmpty ? "Select" : gradeValueText))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(isRaw
                                         ? HobbyIQTheme.Colors.mutedText
                                         : (gradeValueText.isEmpty
                                            ? HobbyIQTheme.Colors.mutedText
                                            : HobbyIQTheme.Colors.pureWhite))
                    Spacer()
                    if isRaw == false {
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .disabled(isRaw)
        }
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

    // MARK: Step headers

    /// Compact "1. Match card" / "2. Grade & details" / "3. Confirm"
    /// section label. Ordered numeric prefix so the review flow reads
    /// linearly on scroll.
    private func stepHeader(number: Int, title: String, subtitle: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Text("\(number)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(width: 22, height: 22)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
        .padding(.top, 4)
    }

    // MARK: Suggested match card (CF-CARDID-SUGGEST, backend PR #389)

    @ViewBuilder
    private var suggestedMatchCard: some View {
        if let picked = pickedCandidate {
            // The user picked a specific catalog match — render it as
            // an already-accepted card so they can see the pick + still
            // change their mind via "Different card".
            acceptedMatchCard(
                cardId: picked.cardId,
                candidate: picked.candidate,
                confidence: 1.0,     // treat manual pick as 100%
                isUserPick: true
            )
        } else if holding.suggestedCardId == nil {
            noSuggestionCard
        } else if let suggestedId = holding.suggestedCardId,
                  let candidate = holding.suggestionCandidate {
            let alreadyAccepted = acceptedCardId == suggestedId
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .font(.caption.weight(.bold))
                    Text("Suggested match")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(1.0)
                    Spacer()
                    if let conf = holding.suggestionConfidence {
                        Text(String(format: "%.0f%%", conf * 100))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                            .clipShape(Capsule(style: .continuous))
                    }
                }

                HStack(alignment: .top, spacing: 12) {
                    candidateThumbnail(candidate)
                    VStack(alignment: .leading, spacing: 6) {
                        if let title = candidate.title, title.isEmpty == false {
                            Text(title)
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .lineLimit(3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        candidateDetailsGrid(candidate)
                    }
                    Spacer(minLength: 4)
                }

                HStack(spacing: 8) {
                    Button {
                        // Accept = pick + confirm in one tap. Previously
                        // this only staged the cardId and left the user
                        // to scroll to the Confirm button in step 3;
                        // when the suggested match is high-confidence
                        // (which is when Accept fires), the two-step
                        // dance is friction the user shouldn't see.
                        acceptedCardId = suggestedId
                        Task { await confirm() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: alreadyAccepted ? "checkmark.circle.fill" : "checkmark")
                                .font(.caption.weight(.bold))
                            Text(alreadyAccepted ? "Accepted" : "Accept")
                                .font(.caption.weight(.bold))
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(alreadyAccepted ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.electricBlue)
                        .clipShape(Capsule(style: .continuous))
                    }
                    .buttonStyle(.plain)

                    Button {
                        showCatalogSearch = true
                    } label: {
                        HStack(spacing: 6) {
                            Text("Different card")
                                .font(.caption.weight(.semibold))
                            Image(systemName: "arrow.right")
                                .font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(HobbyIQTheme.Colors.cardNavy)
                        .overlay(
                            Capsule(style: .continuous)
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
                        )
                        .clipShape(Capsule(style: .continuous))
                    }
                    .buttonStyle(.plain)
                    Spacer()
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .padding(.horizontal, HobbyIQTheme.Spacing.medium)
        }
    }

    /// Render used when the user has an active pick (from either the
    /// backend suggestion or the catalog-search sheet). Shows the
    /// selected card + a "Different card" affordance to re-open the
    /// search.
    private func acceptedMatchCard(
        cardId: String,
        candidate: SuggestionCandidate,
        confidence: Double,
        isUserPick: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: isUserPick ? "hand.point.up.left.fill" : "sparkles")
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .font(.caption.weight(.bold))
                Text(isUserPick ? "You picked" : "Suggested match")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.0)
                Spacer()
                Text(String(format: "%.0f%%", confidence * 100))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(Capsule(style: .continuous))
            }
            HStack(alignment: .top, spacing: 12) {
                candidateThumbnail(candidate)
                VStack(alignment: .leading, spacing: 6) {
                    if let title = candidate.title, title.isEmpty == false {
                        Text(title)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    candidateDetailsGrid(candidate)
                }
                Spacer(minLength: 4)
            }
            HStack(spacing: 8) {
                Label(acceptedCardId == cardId ? "Accepted" : "Accept", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(HobbyIQTheme.Colors.successGreen)
                    .clipShape(Capsule(style: .continuous))
                    .onTapGesture { acceptedCardId = cardId }
                Button {
                    showCatalogSearch = true
                } label: {
                    HStack(spacing: 6) {
                        Text("Different card")
                            .font(.caption.weight(.semibold))
                        Image(systemName: "arrow.right")
                            .font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(HobbyIQTheme.Colors.cardNavy)
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
                    )
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                Spacer()
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
    }

    /// Rendered when the row has no `suggestedCardId` yet. Gives the
    /// user a manual affordance to re-fire the backend suggestion
    /// pass — useful for high-value rows (like a Gold parallel) where
    /// the initial auto-match failed but the user knows a good match
    /// exists in the catalog.
    private var noSuggestionCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .font(.caption.weight(.bold))
                Text("Suggested match")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.0)
                Spacer()
            }
            Text("No catalog match yet — tap to search HobbyIQ's card database for this holding.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                showCatalogSearch = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.caption.weight(.bold))
                    Text("Search catalog")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
    }

    private func candidateSubtitle(_ c: SuggestionCandidate) -> String? {
        var parts: [String] = []
        if let set = c.set, set.isEmpty == false { parts.append(set) }
        if let year = c.year, year.isEmpty == false { parts.append(year) }
        if let n = c.number, n.isEmpty == false { parts.append("#\(n)") }
        if let v = c.variant, v.isEmpty == false, v.lowercased() != "base" { parts.append(v) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Detailed labeled-row list of every catalog field on the
    /// candidate. Rendered on the suggested-match + user-picked cards
    /// so the user sees Year / Set / Card # / Variant explicitly
    /// before hitting Accept — the compact "subtitle" pill hid enough
    /// detail that wrong matches were slipping through.
    @ViewBuilder
    private func candidateDetailsGrid(_ c: SuggestionCandidate) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            candidateDetailRow(label: "Year", value: c.year)
            candidateDetailRow(label: "Set", value: c.set)
            candidateDetailRow(label: "Card #", value: c.number.map { "#\($0)" })
            candidateDetailRow(
                label: "Variant",
                value: {
                    guard let v = c.variant, v.isEmpty == false else { return nil }
                    return v.lowercased() == "base" ? "Base" : v
                }()
            )
        }
    }

    @ViewBuilder
    private func candidateDetailRow(label: String, value: String?) -> some View {
        if let value, value.isEmpty == false {
            HStack(alignment: .top, spacing: 8) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(width: 60, alignment: .leading)
                Text(value)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
        }
    }

    private func candidateThumbnail(_ c: SuggestionCandidate) -> some View {
        Group {
            if let urlString = c.image, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .empty, .failure:
                        Image(systemName: "rectangle.portrait")
                            .font(.system(size: 20, weight: .light))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                    @unknown default: EmptyView()
                    }
                }
            } else {
                Image(systemName: "rectangle.portrait")
                    .font(.system(size: 20, weight: .light))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
            }
        }
        .frame(width: 54, height: 72)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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

    /// CF-BACKEND-ID (2026-07-12): mutations (/confirm, /reject) need
    /// the RAW wire id — not the derived UUID from `holding.id`, and
    /// definitely not the Cardsight catalog `cardId` (that's a
    /// different entity). Preserved on decode as `backendId`.
    private var identifier: String {
        holding.backendId ?? holding.id.uuidString
    }

    private func confirm() async {
        errorMessage = nil
        isConfirming = true
        defer { isConfirming = false }

        // CF-CLEAN-DATA (2026-07-12): when the user has accepted a
        // catalog cardId (either the auto-suggestion or a manual
        // pick), send EVERY field that has a value — not just diffs.
        // Backend then persists the full canonical row rather than
        // an incremental patch, which guarantees the holding lands
        // in inventory with the clean matched data even if a field
        // happens to equal what the parser had already extracted.
        // When the user hasn't picked a match, fall back to the
        // diff-only behavior (respects the "send only changed
        // fields" backend contract for lightweight edits).
        let sendFullRow = acceptedCardId != nil

        var patch = HoldingConfirmRequest.empty

        if sendFullRow || playerName != holding.playerName {
            let trimmed = playerName.trimmingCharacters(in: .whitespacesAndNewlines)
            patch.playerName = trimmed.isEmpty ? nil : trimmed
        }
        if let y = Int(cardYearText), sendFullRow || y != Int(holding.year) {
            patch.cardYear = y
        }
        if sendFullRow || setName != holding.setName {
            let trimmed = setName.trimmingCharacters(in: .whitespacesAndNewlines)
            patch.setName = trimmed.isEmpty ? nil : trimmed
        }
        if sendFullRow || parallel != holding.parallel {
            let trimmed = parallel.trimmingCharacters(in: .whitespacesAndNewlines)
            patch.parallel = trimmed.isEmpty ? nil : trimmed
        }
        if cardNumber.isEmpty == false {
            patch.cardNumber = cardNumber
        }
        if sendFullRow || gradeCompany != (holding.gradeCompany ?? "") {
            patch.gradeCompany = gradeCompany.isEmpty ? nil : gradeCompany
        }
        let originalGradeText = holding.gradeValue.map { formatGrade($0) } ?? ""
        if sendFullRow || gradeValueText != originalGradeText {
            patch.gradeValue = Double(gradeValueText)
        }
        if sendFullRow || team != (holding.team ?? "") {
            patch.team = team.isEmpty ? nil : team
        }
        if sendFullRow || sport != (holding.sport ?? "") {
            patch.sport = sport.isEmpty ? nil : sport
        }
        if sendFullRow || isAuto != holding.isAuto {
            patch.isAuto = isAuto
        }
        // Always send the accepted cardId — this is the load-bearing
        // field that ties the holding to the canonical Cardsight
        // catalog card for pricing downstream.
        if let accepted = acceptedCardId {
            patch.cardId = accepted
        }

        #if DEBUG
        print("[Confirm] id=\(identifier) patch=\(describe(patch: patch))")
        #endif
        let didSave = await viewModel.confirmPendingHolding(id: identifier, patch: patch)
        if didSave {
            onFinished()
            dismiss()
        } else {
            errorMessage = viewModel.errorMessage ?? "Couldn't confirm. Try again."
        }
    }

    /// Human-readable summary of the diff that's about to be POST'd —
    /// used in DEBUG only so we can eyeball what's being sent when a
    /// row doesn't seem to propagate to backend.
    private func describe(patch: HoldingConfirmRequest) -> String {
        var bits: [String] = []
        if let v = patch.playerName { bits.append("playerName=\(v)") }
        if let v = patch.cardYear { bits.append("cardYear=\(v)") }
        if let v = patch.setName { bits.append("setName=\(v)") }
        if let v = patch.parallel { bits.append("parallel=\(v)") }
        if let v = patch.cardNumber { bits.append("cardNumber=\(v)") }
        if let v = patch.gradeCompany { bits.append("gradeCompany=\(v)") }
        if let v = patch.gradeValue { bits.append("gradeValue=\(v)") }
        if let v = patch.isAuto { bits.append("isAuto=\(v)") }
        if let v = patch.team { bits.append("team=\(v)") }
        if let v = patch.sport { bits.append("sport=\(v)") }
        if let v = patch.cardId { bits.append("cardId=\(v)") }
        return bits.isEmpty ? "(empty)" : bits.joined(separator: ", ")
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
