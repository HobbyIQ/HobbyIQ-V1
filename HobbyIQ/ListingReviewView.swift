//
//  ListingReviewView.swift
//  HobbyIQ
//
//  2026-07-20: full-screen review-and-edit surface presented from
//  any "List on eBay" tap. Fetches a pre-filled payload from
//  `POST /api/ebay/listings/prepare`, renders every eBay-required
//  field editable inline, and publishes the user-edited shape to
//  `POST /api/ebay/listings/publish`.
//
//  Six sections: Photos, Card Identity, Condition, Category
//  Aspects, Listing, Category & Policies. Bottom action bar with
//  a "Preview payload" JSON expander (always available — no
//  settings gate; users need this trust surface when their
//  publish just failed) and a "Publish" button that's disabled
//  when `validation.requiredMissing` is non-empty.
//
//  Draft persistence lives in `ListingDraftStore`. Retry-from-
//  error field highlighting deferred until we have live server
//  error shapes to key against.
//

import SwiftUI

struct ListingReviewView: View {
    let holdingId: String

    @Environment(\.dismiss) private var dismiss

    @State private var listing: PreparedListing?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var isPublishing = false
    @State private var publishError: String?
    @State private var publishedToast: String?
    @State private var showPreviewPayload = false
    @State private var categoryAspectsExpanded: Bool = false
    @State private var advancedExpanded: Bool = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading, listing == nil {
                    loadingState
                } else if let listing {
                    form(for: listing)
                } else if let loadError {
                    errorState(loadError)
                }
            }
            .navigationTitle("Review listing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                await load()
            }
            .sheet(isPresented: $showPreviewPayload) {
                previewPayloadSheet
            }
            .overlay(alignment: .top) {
                if let publishedToast {
                    toastBanner(publishedToast, tint: HobbyIQTheme.Colors.hobbyGreen)
                        .padding(.top, 8)
                } else if let publishError {
                    toastBanner(publishError, tint: HobbyIQTheme.Colors.danger)
                        .padding(.top, 8)
                }
            }
        }
    }

    // MARK: - Form

    private func form(for listing: PreparedListing) -> some View {
        let listingBinding = Binding<PreparedListing>(
            get: { self.listing ?? listing },
            set: { newValue in
                self.listing = newValue
                // Persist edits so leaving the screen doesn't lose work.
                ListingDraftStore.save(holdingId: holdingId, listing: newValue)
            }
        )
        return Form {
            if let validation = listing.validation {
                validationBanner(validation)
            }
            photosSection(listingBinding)
            identitySection(listingBinding)
            conditionSection(listingBinding)
            categoryAspectsSection(listingBinding)
            listingSection(listingBinding)
            advancedSection(listingBinding)
        }
        .safeAreaInset(edge: .bottom) {
            bottomActionBar(listing)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: - Validation banner

    @ViewBuilder
    private func validationBanner(_ validation: ListingValidation) -> some View {
        if validation.requiredMissing.isEmpty == false {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Label("\(validation.requiredMissing.count) field\(validation.requiredMissing.count == 1 ? "" : "s") still needed before publish", systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                    Text(validation.requiredMissing.joined(separator: " \u{00B7} "))
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .padding(.vertical, 4)
            }
        }
        if validation.warnings.isEmpty == false {
            Section {
                ForEach(validation.warnings, id: \.self) { w in
                    Label(w, systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
    }

    // MARK: - Section 1: Photos

    private func photosSection(_ listing: Binding<PreparedListing>) -> some View {
        Section("Photos") {
            if listing.wrappedValue.photos.isEmpty {
                Label("eBay requires at least one photo.", systemImage: "photo.badge.plus")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(listing.wrappedValue.photos.enumerated()), id: \.offset) { idx, url in
                        photoTile(url: url, index: idx, listing: listing)
                    }
                    addPhotoTile()
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func photoTile(url: String, index: Int, listing: Binding<PreparedListing>) -> some View {
        AsyncImage(url: URL(string: url)) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            default:
                Color.gray.opacity(0.2)
            }
        }
        .frame(width: 84, height: 108)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Button {
                var updated = listing.wrappedValue
                updated.photos.remove(at: index)
                listing.wrappedValue = updated
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.white, .black.opacity(0.55))
                    .font(.title3)
                    .padding(2)
            }
            .buttonStyle(.plain)
        }
    }

    private func addPhotoTile() -> some View {
        // MVP: renders the affordance but hooks a full picker in a
        // follow-up commit (PhotosPicker + ImageUploadService).
        // Tapping today is a no-op — surfaced as disabled visually.
        VStack(spacing: 4) {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
            Text("Add")
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        .frame(width: 84, height: 108)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.4))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(HobbyIQTheme.Colors.mutedText.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [4]))
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: - Section 2: Card Identity

    private func identitySection(_ listing: Binding<PreparedListing>) -> some View {
        Section("Card identity") {
            TextField("Player", text: Binding(
                get: { listing.wrappedValue.identity.playerName ?? "" },
                set: { listing.wrappedValue.identity.playerName = $0.isEmpty ? nil : $0 }
            ))
            TextField("Year", text: Binding(
                get: { listing.wrappedValue.identity.cardYear.map(String.init) ?? "" },
                set: { listing.wrappedValue.identity.cardYear = Int($0) }
            ))
            .keyboardType(.numberPad)
            TextField("Set", text: Binding(
                get: { listing.wrappedValue.identity.setName ?? "" },
                set: { listing.wrappedValue.identity.setName = $0.isEmpty ? nil : $0 }
            ))
            TextField("Parallel", text: Binding(
                get: { listing.wrappedValue.identity.parallel ?? "" },
                set: { listing.wrappedValue.identity.parallel = $0.isEmpty ? nil : $0 }
            ))
            TextField("Card #", text: Binding(
                get: { listing.wrappedValue.identity.cardNumber ?? "" },
                set: { listing.wrappedValue.identity.cardNumber = $0.isEmpty ? nil : $0 }
            ))
            TextField("Team", text: Binding(
                get: { listing.wrappedValue.identity.team ?? "" },
                set: { listing.wrappedValue.identity.team = $0.isEmpty ? nil : $0 }
            ))
            Picker("Sport", selection: Binding(
                get: { ListingSport(rawValue: listing.wrappedValue.identity.sport) ?? .baseball },
                set: { listing.wrappedValue.identity.sport = $0.rawValue }
            )) {
                ForEach(ListingSport.allCases) { s in
                    Text(s.rawValue).tag(s)
                }
            }
            Toggle("Rookie card", isOn: listing.identity.isRookie)
            Toggle("Autograph", isOn: listing.identity.isAuto)
        }
    }

    // MARK: - Section 3: Condition

    private func conditionSection(_ listing: Binding<PreparedListing>) -> some View {
        Section("Condition") {
            Picker("Grading", selection: listing.condition.isGraded) {
                Text("Raw").tag(false)
                Text("Graded").tag(true)
            }
            .pickerStyle(.segmented)

            if listing.wrappedValue.condition.isGraded {
                Picker("Grading company", selection: Binding(
                    get: { listing.wrappedValue.condition.gradingCompany.flatMap(GradingCompany.init(rawValue:)) ?? .psa },
                    set: { listing.wrappedValue.condition.gradingCompany = $0.rawValue }
                )) {
                    ForEach(GradingCompany.allCases) { c in
                        Text(c.rawValue).tag(c)
                    }
                }
                TextField("Grade", text: Binding(
                    get: { listing.wrappedValue.condition.grade ?? "" },
                    set: { listing.wrappedValue.condition.grade = $0.isEmpty ? nil : $0 }
                ))
                .keyboardType(.decimalPad)
                TextField("Cert #", text: Binding(
                    get: { listing.wrappedValue.condition.certNumber ?? "" },
                    set: { listing.wrappedValue.condition.certNumber = $0.isEmpty ? nil : $0 }
                ))
            } else {
                Picker("Condition", selection: Binding(
                    get: { listing.wrappedValue.condition.conditionEstimate.flatMap(RawConditionEstimate.init(rawValue:)) ?? .nearMint },
                    set: { listing.wrappedValue.condition.conditionEstimate = $0.rawValue }
                )) {
                    ForEach(RawConditionEstimate.allCases) { c in
                        Text(c.rawValue).tag(c)
                    }
                }
                TextField("Notes", text: Binding(
                    get: { listing.wrappedValue.condition.conditionNotes ?? "" },
                    set: { listing.wrappedValue.condition.conditionNotes = $0.isEmpty ? nil : $0 }
                ), axis: .vertical)
                .lineLimit(2 ... 5)
            }
        }
    }

    // MARK: - Section 4: Category Aspects (eBay-required)

    private func categoryAspectsSection(_ listing: Binding<PreparedListing>) -> some View {
        Section(isExpanded: $categoryAspectsExpanded) {
            TextField("League", text: Binding(
                get: { listing.wrappedValue.categoryAspects.league ?? "" },
                set: { listing.wrappedValue.categoryAspects.league = $0.isEmpty ? nil : $0 }
            ))
            TextField("Type", text: Binding(
                get: { listing.wrappedValue.categoryAspects.type ?? "Sports Trading Card" },
                set: { listing.wrappedValue.categoryAspects.type = $0.isEmpty ? nil : $0 }
            ))
            TextField("Country/Region of Manufacture", text: Binding(
                get: { listing.wrappedValue.categoryAspects.countryOfManufacture ?? "United States" },
                set: { listing.wrappedValue.categoryAspects.countryOfManufacture = $0.isEmpty ? nil : $0 }
            ))
            TextField("Year Manufactured", text: Binding(
                get: { listing.wrappedValue.categoryAspects.yearManufactured.map(String.init) ?? "" },
                set: { listing.wrappedValue.categoryAspects.yearManufactured = Int($0) }
            ))
            .keyboardType(.numberPad)
            TextField("Season", text: Binding(
                get: { listing.wrappedValue.categoryAspects.season.map(String.init) ?? "" },
                set: { listing.wrappedValue.categoryAspects.season = Int($0) }
            ))
            .keyboardType(.numberPad)
            TextField("Language", text: Binding(
                get: { listing.wrappedValue.categoryAspects.language ?? "English" },
                set: { listing.wrappedValue.categoryAspects.language = $0.isEmpty ? nil : $0 }
            ))
        } header: {
            HStack {
                Text("Category aspects (eBay-required)")
                Spacer()
                if listing.wrappedValue.validation?.requiredMissing.contains(where: { $0.hasPrefix("categoryAspects") }) == true {
                    Text("Missing").font(.caption2.weight(.bold)).foregroundStyle(HobbyIQTheme.Colors.warning)
                }
            }
        }
    }

    // MARK: - Section 5: Listing

    private func listingSection(_ listing: Binding<PreparedListing>) -> some View {
        Section("Listing") {
            titleField(listing)
            TextField("Description", text: listing.listing.description, axis: .vertical)
                .lineLimit(4 ... 12)
            priceField(listing)
            Toggle("Best offer", isOn: listing.listing.bestOfferEnabled)
            if listing.wrappedValue.listing.bestOfferEnabled {
                TextField("Min offer ($)", text: Binding(
                    get: {
                        listing.wrappedValue.listing.bestOfferMinPriceCents.map {
                            String(format: "%.2f", Double($0) / 100)
                        } ?? ""
                    },
                    set: { newValue in
                        if let dollars = Double(newValue) {
                            listing.wrappedValue.listing.bestOfferMinPriceCents = Int((dollars * 100).rounded())
                        } else {
                            listing.wrappedValue.listing.bestOfferMinPriceCents = nil
                        }
                    }
                ))
                .keyboardType(.decimalPad)
            }
            Stepper(
                "Quantity: \(listing.wrappedValue.listing.quantity)",
                value: listing.listing.quantity,
                in: 1 ... 99
            )
        }
    }

    private func titleField(_ listing: Binding<PreparedListing>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("Title", text: listing.listing.titleSuggested)
                .font(.body.monospaced())
            let count = listing.wrappedValue.listing.titleSuggested.count
            Text("\(count) / 80")
                .font(.caption2.monospaced())
                .foregroundStyle(count > 80 ? HobbyIQTheme.Colors.danger : HobbyIQTheme.Colors.mutedText)
        }
    }

    private func priceField(_ listing: Binding<PreparedListing>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("$")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                TextField("Price", text: Binding(
                    get: { String(format: "%.2f", listing.wrappedValue.listing.priceDollars) },
                    set: { newValue in
                        if let dollars = Double(newValue) {
                            listing.wrappedValue.listing.priceDollars = dollars
                        }
                    }
                ))
                .keyboardType(.decimalPad)
            }
        }
    }

    // MARK: - Section 6: Category & Policies (advanced)

    private func advancedSection(_ listing: Binding<PreparedListing>) -> some View {
        Section(isExpanded: $advancedExpanded) {
            // Category ID + policy dropdowns land in a follow-up
            // commit once the policies endpoint is exposed on
            // APIService. Placeholder ensures the section renders
            // an editable surface today.
            Text("Category ID and payment/return/fulfillment policies use eBay defaults for now. Edit surface coming soon.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text("Category & policies")
        }
    }

    // MARK: - Bottom action bar

    private func bottomActionBar(_ listing: PreparedListing) -> some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    showPreviewPayload = true
                } label: {
                    Label("Preview payload", systemImage: "curlybraces")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)

                Spacer()

                Button {
                    Task { await publish(listing) }
                } label: {
                    HStack(spacing: 6) {
                        if isPublishing {
                            ProgressView().tint(.white)
                        }
                        Text(isPublishing ? "Publishing\u{2026}" : "Publish to eBay")
                    }
                }
                .buttonStyle(.appPrimary)
                .disabled(isPublishing || publishBlocked(listing))
                .opacity(publishBlocked(listing) ? 0.5 : 1)
            }
            if let missing = listing.validation?.requiredMissing, missing.isEmpty == false {
                Text("\(missing.count) field\(missing.count == 1 ? "" : "s") still missing.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(.thinMaterial)
    }

    private func publishBlocked(_ listing: PreparedListing) -> Bool {
        if listing.photos.isEmpty { return true }
        if listing.listing.titleSuggested.isEmpty { return true }
        if listing.listing.titleSuggested.count > 80 { return true }
        if listing.listing.priceCents <= 0 { return true }
        if let ready = listing.validation?.readyToPublish { return ready == false }
        return false
    }

    // MARK: - Preview payload sheet

    private var previewPayloadSheet: some View {
        NavigationStack {
            ScrollView {
                if let listing, let data = try? JSONEncoder.pretty.encode(listing),
                   let text = String(data: data, encoding: .utf8) {
                    Text(text)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .padding()
                } else {
                    Text("No payload to preview.")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .padding()
                }
            }
            .navigationTitle("Publish payload")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showPreviewPayload = false }
                }
            }
        }
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Preparing listing\u{2026}")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.8))
            Text("Couldn't prepare this listing.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
            Button("Retry") {
                Task { await load() }
            }
            .buttonStyle(.bordered)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func toastBanner(_ message: String, tint: Color) -> some View {
        Text(message)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(tint.opacity(0.9))
            .clipShape(Capsule(style: .continuous))
            .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 4)
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: - Load / publish

    private func load() async {
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        // Prefer a fresh local draft (< 24h) so partial edits survive
        // an app relaunch. Fall back to a fresh /prepare fetch.
        if let draft = ListingDraftStore.load(holdingId: holdingId) {
            listing = draft.listing
        }
        do {
            let fetched = try await APIService.shared.fetchPreparedListing(holdingId: holdingId)
            // Prefer the just-fetched payload's validation block —
            // even when we restore a draft, the freshest validation
            // signal is what the backend just computed.
            if let current = listing {
                // Replace only the validation block on the draft so
                // in-flight user edits aren't clobbered.
                let merged = PreparedListing(
                    success: fetched.success,
                    holdingId: fetched.holdingId,
                    identity: current.identity,
                    condition: current.condition,
                    categoryAspects: current.categoryAspects,
                    photos: current.photos,
                    listing: current.listing,
                    validation: fetched.validation
                )
                listing = merged
            } else {
                listing = fetched
            }
            // Default-expand Category Aspects when required-missing
            // includes any category field (spec §Section 4).
            if let missing = fetched.validation?.requiredMissing,
               missing.contains(where: { $0.hasPrefix("categoryAspects") }) {
                categoryAspectsExpanded = true
            }
        } catch {
            if listing == nil {
                loadError = "The server didn't respond in time."
            }
            // If a draft loaded, keep it — the user can still work
            // offline. Just don't overwrite with a fetch failure.
        }
    }

    private func publish(_ listing: PreparedListing) async {
        isPublishing = true
        publishError = nil
        defer { isPublishing = false }
        do {
            _ = try await APIService.shared.publishPreparedListing(listing)
            ListingDraftStore.clear(holdingId: holdingId)
            publishedToast = "Listing sent to eBay."
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run { dismiss() }
        } catch {
            publishError = "Publish failed. Fix any flagged fields and try again."
            scheduleErrorClear()
        }
    }

    private func scheduleErrorClear() {
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await MainActor.run { publishError = nil }
        }
    }
}

// MARK: - Encoder helper

private extension JSONEncoder {
    /// Pretty-printed encoder for the Preview Payload sheet.
    static var pretty: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }
}
