//
//  CertLookupResultView.swift
//  HobbyIQ
//
//  2026-07-19 (spec §2): result surface pushed from
//  `CertNumberInputSheet` after a successful POST to
//  /api/compiq/lookup-by-cert. Renders card identity, the canonical
//  FMV headline (with reference-price fallback when the pipeline
//  returned `no-basis`), the grade ladder embedded in the response,
//  and an "Add to Portfolio" flow that prefills a lightweight
//  cost-basis form with the `readyToAdd` block, then POSTs to
//  /api/portfolio/holdings.
//

import SwiftUI

struct CertLookupResultView: View {
    let response: LookupByCertResponse

    @State private var showAddSheet = false
    @State private var addPurchasePrice: String = ""
    @State private var addPurchaseDate: Date = Date()
    @State private var addQuantity: String = "1"
    @State private var addIsSubmitting = false
    @State private var addErrorMessage: String?
    @State private var addSuccessToast: String?
    @State private var navigatePlayerName: String?
    @State private var navigateToCompSheet = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                identityCard
                fmvHeadline
                gradeLadderSection
                addButton
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        // 2026-07-19: single-color background — themedNavigationSurface
        // already paints appBackground on both content + toolbar, so
        // the previous HobbyIQBackground() gradient overlay is what
        // was causing the nav bar to read darker than the scroll area.
        .navigationTitle("Cert result")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .sheet(isPresented: $showAddSheet) {
            addToPortfolioSheet
                .presentationDetents([.medium])
        }
        .navigationDestination(item: $navigatePlayerName) { name in
            PlayerDetailView(playerName: name)
        }
        .navigationDestination(isPresented: $navigateToCompSheet) {
            if let cardId = response.card?.cardId {
                CompIQPricedCardView(hit: CompIQVariantHit(cardId: cardId))
            }
        }
        .overlay(alignment: .top) {
            if let addSuccessToast {
                toast(addSuccessToast)
                    .padding(.top, 8)
            }
        }
    }

    // MARK: - Identity card

    private var identityCard: some View {
        HStack(spacing: 12) {
            if let urlString = response.card?.imageUrl, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                    default:
                        Color.clear
                    }
                }
                .frame(width: 84, height: 118)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            VStack(alignment: .leading, spacing: 4) {
                if let player = response.card?.player {
                    // 2026-07-19 (spec §5): player name is a tap-target
                    // that pushes `PlayerDetailView` for pricing summary
                    // + top cards + by-year rollups.
                    Button {
                        navigatePlayerName = player
                    } label: {
                        HStack(spacing: 4) {
                            Text(player)
                                .font(.headline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if let description = response.card?.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(3)
                }
                HStack(spacing: 6) {
                    if let grader = response.grader {
                        chip(text: grader, tint: HobbyIQTheme.Colors.electricBlue)
                    }
                    if let grade = response.grade {
                        chip(text: grade, tint: HobbyIQTheme.Colors.hobbyGreen)
                    }
                    if let cert = response.cert {
                        chip(text: "#\(cert)", tint: HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func chip(text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.14))
            .clipShape(Capsule(style: .continuous))
    }

    // MARK: - FMV headline

    private var fmvHeadline: some View {
        // 2026-07-19: whole card is tappable — routes to Comp Sheet
        // for the resolved cardId. Disabled when we don't have a
        // cardId to hand off (rare — success paths always ship one).
        Button {
            if response.card?.cardId != nil {
                navigateToCompSheet = true
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("MARKET VALUE")
                        .font(.caption.weight(.bold))
                        .tracking(0.6)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer(minLength: 0)
                    if response.card?.cardId != nil {
                        HStack(spacing: 3) {
                            Text("Open Comp Sheet")
                                .font(.caption2.weight(.semibold))
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(headlineFmvString)
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if let confidence = response.canonicalFmv?.confidence {
                        Text("\(Int((confidence * 100).rounded()))% confidence")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                if response.canonicalFmv?.fmv == nil, response.referencePrice != nil {
                    Text("Reference price (canonical FMV unavailable)")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(response.card?.cardId == nil)
    }

    private var headlineFmvString: String {
        if let fmv = response.canonicalFmv?.fmv, fmv > 0 {
            return dollars(fmv)
        }
        if let ref = response.referencePrice, ref > 0 {
            return dollars(ref)
        }
        return "\u{2014}"
    }

    // MARK: - Grade ladder

    @ViewBuilder
    private var gradeLadderSection: some View {
        if let ladder = response.canonicalFmv?.gradeLadder, ladder.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                Text("Grade ladder")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                ForEach(ladder) { entry in
                    HStack {
                        Text(entry.grade ?? "\u{2014}")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .frame(width: 80, alignment: .leading)
                        Spacer(minLength: 0)
                        Text(entry.value.map { dollars($0) } ?? "\u{2014}")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 12)
                    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.4))
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
                }
            }
        }
    }

    // MARK: - Add button

    private var addButton: some View {
        // 2026-07-19: use the app-wide primary button style so the
        // CTA reads consistently with other primary actions (rounded
        // accent fill, dark text, subtle shadow) instead of a
        // one-off hobbyGreen slab.
        Button {
            addErrorMessage = nil
            showAddSheet = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle.fill")
                Text("Add to Portfolio")
            }
        }
        .buttonStyle(.appPrimary)
        .disabled(response.readyToAdd?.cardId == nil)
        .opacity(response.readyToAdd?.cardId == nil ? 0.5 : 1)
    }

    // MARK: - Add sheet

    private var addToPortfolioSheet: some View {
        NavigationStack {
            Form {
                Section("Cost basis") {
                    TextField("Purchase price", text: $addPurchasePrice)
                        .keyboardType(.decimalPad)
                    DatePicker("Purchase date", selection: $addPurchaseDate, in: ...Date(), displayedComponents: .date)
                    TextField("Quantity", text: $addQuantity)
                        .keyboardType(.numberPad)
                }
                if let addErrorMessage {
                    Section {
                        Text(addErrorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Button {
                        Task { await submitAdd() }
                    } label: {
                        HStack {
                            Spacer()
                            if addIsSubmitting {
                                ProgressView()
                            }
                            Text(addIsSubmitting ? "Adding\u{2026}" : "Save holding")
                                .fontWeight(.bold)
                            Spacer()
                        }
                    }
                    .disabled(addIsSubmitting || Double(addPurchasePrice) == nil)
                }
            }
            .navigationTitle("Add to Portfolio")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showAddSheet = false }
                }
            }
        }
    }

    private func submitAdd() async {
        guard let ready = response.readyToAdd, let cardId = ready.cardId else {
            addErrorMessage = "Missing card identity — try again from the search flow."
            return
        }
        guard let price = Double(addPurchasePrice), price > 0 else {
            addErrorMessage = "Enter a purchase price above 0."
            return
        }
        let qty = max(1, Int(addQuantity) ?? 1)
        addIsSubmitting = true
        defer { addIsSubmitting = false }

        // `purchaseDate` isn't part of the wire body today — backend
        // stamps a receivedAt on the add path. `certNumber` /
        // `photos` / `source` come along on `readyToAdd` but the
        // Add endpoint doesn't carry them; they'd need a follow-up
        // extension on `AddHoldingRequest` if product wants them
        // preserved.
        let request = AddHoldingRequest(
            playerName: ready.playerName ?? "\u{2014}",
            cardId: cardId,
            parallel: ready.parallel,
            parallelId: nil,
            isAuto: ready.isAuto,
            gradeCompany: ready.gradeCompany,
            gradeValue: ready.gradeValue,
            purchasePrice: price,
            quantity: qty,
            graderStatus: nil,
            year: ready.cardYear.map { String($0) },
            setName: ready.setName ?? ready.product,
            cardNumber: ready.cardNumber,
            cardTitle: ready.cardTitle
        )

        do {
            _ = try await APIService.shared.addPortfolioHolding(request)
            showAddSheet = false
            addSuccessToast = "Added to your portfolio."
            // Fade the toast after 2 seconds.
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await MainActor.run { addSuccessToast = nil }
            }
        } catch {
            addErrorMessage = "Couldn't add the holding. Try again."
        }
    }

    // MARK: - Toast

    private func toast(_ message: String) -> some View {
        Text(message)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(HobbyIQTheme.Colors.hobbyGreen.opacity(0.9))
            .clipShape(Capsule(style: .continuous))
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Formatting

    private func dollars(_ value: Double) -> String {
        "$\(Int(value.rounded()).formatted(.number.grouping(.automatic)))"
    }
}
