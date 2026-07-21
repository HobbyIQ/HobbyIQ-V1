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

import PhotosUI
import SwiftUI
import UIKit

/// 2026-07-20 (spec §Retry-from-error): symbolic tag naming the
/// section that eBay's most recent error was about. Drives the
/// red left-border + inline error message treatment.
enum ListingReviewSection: String, Hashable {
    case photos, identity, condition, categoryAspects, listing
}

struct ListingReviewView: View {
    let holdingId: String

    @Environment(\.dismiss) private var dismiss

    @State private var listing: PreparedListing?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var isPublishing = false
    @State private var publishError: String?
    @State private var missingPolicy: MissingPolicy?
    @State private var publishSuccess: PublishResult?
    @State private var showPreviewPayload = false
    @State private var categoryAspectsExpanded: Bool = false
    @State private var advancedExpanded: Bool = false
    /// 2026-07-20 (spec §Retry-from-error): section that eBay
    /// flagged; drives the red left-border treatment. Cleared when
    /// the user edits the flagged section.
    @State private var highlightedSection: ListingReviewSection?
    @State private var highlightedSectionMessage: String?
    /// 2026-07-20 (photo picker): PhotosPicker selection + camera
    /// sheet gate + upload state.
    @State private var pickerItem: PhotosPickerItem?
    @State private var showCamera: Bool = false
    @State private var presentPhotosPicker: Bool = false
    @State private var isUploadingPhoto: Bool = false
    /// Analytics: track which fields the user actually touched so
    /// `listing_review_published` can report edited-field count.
    @State private var editedFieldNames: Set<String> = []
    /// 2026-07-20: FMV snapshot captured at load time. Used as the
    /// suggestion pill above the Price field so the user can snap
    /// back to backend's recommended value after tweaking.
    @State private var fmvSuggestionCents: Int?
    /// 2026-07-20: debounce ticket for `recomputeValidation()`. A
    /// rapid keystroke run bumps this repeatedly; the sleep task
    /// only proceeds when its captured value still matches — same
    /// pattern as a classic setTimeout+clearTimeout debounce.
    @State private var debounceToken: Int = 0

    var body: some View {
        NavigationStack {
            Group {
                if let publishSuccess {
                    successView(publishSuccess)
                } else if isLoading, listing == nil {
                    loadingState
                } else if let listing {
                    form(for: listing)
                } else if let loadError {
                    errorState(loadError)
                }
            }
            .navigationTitle(publishSuccess == nil ? "Review listing" : "Listed on eBay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if publishSuccess == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
            }
            .task {
                await load()
            }
            .sheet(isPresented: $showPreviewPayload) {
                previewPayloadSheet
            }
            // 2026-07-20 (spec §Photos): PhotosPicker for library,
            // UIKit-bridged UIImagePickerController for camera.
            // Both funnel into `uploadPickedImage(_:)` which does
            // the SAS handshake then appends `blobUrl` to photos[].
            .photosPicker(
                isPresented: $presentPhotosPicker,
                selection: $pickerItem,
                matching: .images
            )
            .onChange(of: pickerItem) { _, newItem in
                guard let item = newItem else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let image = UIImage(data: data) {
                        await uploadPickedImage(image)
                    }
                    pickerItem = nil
                }
            }
            .sheet(isPresented: $showCamera) {
                CameraCapturePicker { image in
                    showCamera = false
                    if let image {
                        Task { await uploadPickedImage(image) }
                    }
                }
            }
            .overlay(alignment: .top) {
                if let publishError {
                    toastBanner(publishError, tint: HobbyIQTheme.Colors.danger)
                        .padding(.top, 8)
                }
            }
        }
    }

    // MARK: - Success screen (spec §3 published state)

    private func successView(_ result: PublishResult) -> some View {
        VStack(spacing: 18) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 56))
                .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
            Text("Listed on eBay")
                .font(.title2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let id = result.listingId {
                Text("Item # \(id)")
                    .font(.footnote.monospaced())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .textSelection(.enabled)
            }
            VStack(spacing: 10) {
                if let urlString = result.listingUrl, let url = URL(string: urlString) {
                    Link(destination: url) {
                        Label("View on eBay", systemImage: "arrow.up.forward.square")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.appPrimary)
                }
                Button("Done") { dismiss() }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
            }
            .padding(.top, 8)
            Spacer()
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Form

    private func form(for listing: PreparedListing) -> some View {
        let listingBinding = Binding<PreparedListing>(
            get: { self.listing ?? listing },
            set: { newValue in
                self.listing = newValue
                // Persist edits so leaving the screen doesn't lose work.
                ListingDraftStore.save(holdingId: holdingId, listing: newValue)
                // 2026-07-20 (spec §4): debounced client-side
                // revalidation so the Publish gate reflects the
                // user's edits without waiting for the next server
                // round-trip. 200ms window per spec.
                scheduleRevalidation()
            }
        )
        return Form {
            if let missingPolicy {
                missingPolicyBanner(missingPolicy)
            }
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

    // MARK: - Missing-policy banner (spec §Publish failure)

    private func missingPolicyBanner(_ policy: MissingPolicy) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Label("eBay \(policy.policyType.capitalized) policy needed", systemImage: "exclamationmark.octagon.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                Text(policy.reason)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Set this up in your eBay Seller Hub, then retry.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
            }
            .padding(.vertical, 4)
        }
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

    // MARK: - Section highlight helper (spec §Retry-from-error)

    /// Inline red banner rendered as the first row of a section
    /// when `highlightedSection` matches. Tapping any field in the
    /// section clears the highlight (see `clearHighlightIfNeeded`).
    @ViewBuilder
    private func highlightBanner(for section: ListingReviewSection) -> some View {
        if highlightedSection == section, let msg = highlightedSectionMessage {
            HStack(alignment: .top, spacing: 8) {
                Rectangle()
                    .fill(HobbyIQTheme.Colors.danger)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 2) {
                    Text("eBay flagged this section")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                    Text(msg)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// Called from a section's edit binding — clears the flag once
    /// the user starts fixing it. Fires the field-edit analytic
    /// event alongside.
    private func markEdited(section: ListingReviewSection, field: String) {
        if highlightedSection == section {
            highlightedSection = nil
            highlightedSectionMessage = nil
        }
        editedFieldNames.insert(field)
        ListingReviewAnalytics.fieldEdited(holdingId: holdingId, field: field)
    }

    // MARK: - Section 1: Photos

    private func photosSection(_ listing: Binding<PreparedListing>) -> some View {
        Section("Photos") {
            highlightBanner(for: .photos)
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
        // 2026-07-20: two-affordance add tile — Photos library
        // (PhotosPicker) + Camera (UIImagePickerController bridge).
        // Both flow through the same SAS upload path so the
        // resulting `blobUrl` gets pushed into `review.photos[]`
        // once the upload completes.
        Menu {
            Button {
                showCamera = true
            } label: {
                Label("Take photo", systemImage: "camera")
            }
            // PhotosPicker doesn't nest inside a Menu directly —
            // work around by driving `pickerItem` through a
            // separate always-mounted `PhotosPicker` below and
            // just flip a sentinel from the menu.
            Button {
                Task { presentPhotosPicker = true }
            } label: {
                Label("Choose from library", systemImage: "photo.on.rectangle.angled")
            }
        } label: {
            VStack(spacing: 4) {
                if isUploadingPhoto {
                    ProgressView()
                        .tint(HobbyIQTheme.Colors.electricBlue)
                } else {
                    Image(systemName: "plus")
                        .font(.title2.weight(.semibold))
                }
                Text(isUploadingPhoto ? "Uploading" : "Add")
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .frame(width: 84, height: 108)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.4))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(HobbyIQTheme.Colors.electricBlue.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4]))
            )
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .disabled(isUploadingPhoto)
    }

    // MARK: - Section 2: Card Identity

    private func identitySection(_ listing: Binding<PreparedListing>) -> some View {
        Section("Card identity") {
            highlightBanner(for: .identity)
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
            highlightBanner(for: .condition)
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
            highlightBanner(for: .categoryAspects)
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
            highlightBanner(for: .listing)
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
        VStack(alignment: .leading, spacing: 6) {
            // 2026-07-20: FMV suggestion chip above the price field.
            // Snaps the price back to backend's recommended value.
            // Only shows when the current price differs meaningfully
            // from the FMV — no point suggesting what's already set.
            if let fmvCents = fmvSuggestionCents,
               fmvCents > 0,
               abs(fmvCents - listing.wrappedValue.listing.priceCents) > 100 {
                Button {
                    listing.wrappedValue.listing.priceCents = fmvCents
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                        Text("FMV: $\(Int(Double(fmvCents) / 100))")
                            .font(.caption.weight(.semibold))
                        Text("· tap to use")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
            }
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

    /// 2026-07-20 (spec §4): 200ms debouncer for client-side
    /// revalidation. Each edit bumps `debounceToken`; the task's
    /// captured value only matches after the sleep completes, which
    /// means rapid keystrokes coalesce into a single recompute.
    private func scheduleRevalidation() {
        debounceToken &+= 1
        let expected = debounceToken
        Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard expected == debounceToken else { return }
            await MainActor.run {
                if var current = listing {
                    current.recomputeValidation()
                    listing = current
                }
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
                    // Fire the analytics event when the user tries
                    // to publish while blocked — surfaces which
                    // required fields keep users stuck.
                    if publishBlocked(listing),
                       let missing = listing.validation?.requiredMissing,
                       missing.isEmpty == false {
                        ListingReviewAnalytics.validationBlocked(
                            holdingId: holdingId,
                            missingFields: missing
                        )
                    }
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
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title2)
                        .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.8))
                    Text("Couldn't prepare this listing.")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                Text(message)
                    .font(.footnote.monospaced())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Retry") {
                        Task { await load() }
                    }
                    .buttonStyle(.bordered)
                    Button("Copy error") {
                        UIPasteboard.general.string = message
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
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
        // Fire once per screen open — subsequent loads from a retry
        // still count as the same session.
        ListingReviewAnalytics.opened(holdingId: holdingId)
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
            // 2026-07-20: capture the server's original price as the
            // FMV suggestion so the price chip can snap back to it
            // after the user tweaks.
            if fmvSuggestionCents == nil, fetched.listing.priceCents > 0 {
                fmvSuggestionCents = fetched.listing.priceCents
            }
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
                loadError = diagnosticErrorMessage(from: error)
            }
            // If a draft loaded, keep it — the user can still work
            // offline. Just don't overwrite with a fetch failure.
        }
    }

    /// Build a copy-pasteable error string that tells you which side
    /// of the wire is broken. Prefers a parsed `{ success:false,
    /// error:"..." }` body over the generic status-code framing —
    /// that shape is what our backends return when they want to
    /// tell the caller something specific (e.g. "Holding not found"
    /// on a 404 means the endpoint IS deployed, the holdingId just
    /// isn't in the DB). `endpoint` names which HobbyIQ endpoint
    /// hit the failure so screenshots are unambiguous when the
    /// review flow chains prepare → publish.
    private func diagnosticErrorMessage(
        from error: Error,
        endpoint: String = "/api/ebay/listings/prepare"
    ) -> String {
        if let apiError = error as? APIServiceError {
            switch apiError {
            case .httpError(let statusCode, let body):
                let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
                // Try to parse a structured error body first.
                if let parsed = parsedBackendError(from: trimmed) {
                    return "POST \(endpoint) returned \(statusCode): \(parsed)"
                }
                let bodyPreview = trimmed.isEmpty
                    ? ""
                    : "\n\n" + String(trimmed.prefix(300))
                switch statusCode {
                case 404:
                    return "POST \(endpoint) returned 404 with no parseable body \u{2014} likely the endpoint isn't deployed yet.\(bodyPreview)"
                case 401, 403:
                    return "POST \(endpoint) returned \(statusCode) \u{2014} auth issue.\(bodyPreview)"
                default:
                    return "POST \(endpoint) returned \(statusCode).\(bodyPreview)"
                }
            case .invalidURL:
                return "APIConfig.baseURL isn't set. Fix in APIConfig.swift."
            default:
                return apiError.errorDescription ?? String(describing: apiError)
            }
        }
        return error.localizedDescription
    }

    /// Best-effort `{ success:false, error:"..." }` body parser.
    /// Returns just the `error` string when present, nil otherwise
    /// so the caller can fall back to the raw-body preview path.
    private func parsedBackendError(from body: String) -> String? {
        guard let data = body.data(using: .utf8) else { return nil }
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let message = dict["error"] as? String, message.isEmpty == false {
            return message
        }
        if let message = dict["message"] as? String, message.isEmpty == false {
            return message
        }
        return nil
    }

    private func publish(_ listing: PreparedListing) async {
        isPublishing = true
        publishError = nil
        missingPolicy = nil
        defer { isPublishing = false }
        do {
            let result = try await APIService.shared.publishPreparedListing(listing)
            if result.success {
                // Successful publish — clear draft, swap the whole
                // view over to the success state (View on eBay +
                // Done). No auto-dismiss; user gets to tap through
                // to their live listing.
                ListingDraftStore.clear(holdingId: holdingId)
                publishSuccess = result
                ListingReviewAnalytics.published(
                    holdingId: holdingId,
                    editedFieldsCount: editedFieldNames.count
                )
            } else {
                // Backend rejected the payload without a thrown
                // error. Surface the reason + any missingPolicy
                // block so the user knows exactly what to fix.
                let errMsg = result.error ?? "Publish failed — see eBay for details."
                publishError = errMsg
                missingPolicy = result.missingPolicy
                // 2026-07-20 (spec §Retry-from-error): best-effort
                // parse of the eBay error message → identify the
                // offending section → drive a red left-border on
                // that section. Server error strings aren't
                // machine-readable but tend to mention field names
                // verbatim ("League", "photos", "Year"…).
                highlightedSection = sectionFromErrorMessage(errMsg)
                highlightedSectionMessage = highlightedSection == nil ? nil : errMsg
                ListingReviewAnalytics.publishFailed(holdingId: holdingId, ebayError: errMsg)
                scheduleErrorClear()
            }
        } catch {
            let diag = diagnosticErrorMessage(from: error, endpoint: "/api/ebay/listings/publish")
            publishError = diag
            ListingReviewAnalytics.publishFailed(holdingId: holdingId, ebayError: diag)
            scheduleErrorClear()
        }
    }

    /// Heuristic map from an eBay error string to the review
    /// section that owns the flagged field. Not exhaustive — kept
    /// to the fields eBay reliably names in Sports Trading Cards
    /// category validation failures.
    private func sectionFromErrorMessage(_ msg: String) -> ListingReviewSection? {
        let lower = msg.lowercased()
        if lower.contains("photo") || lower.contains("image") { return .photos }
        if lower.contains("league") || lower.contains("country") ||
           lower.contains("manufactured") || lower.contains("season") ||
           lower.contains("language") || lower.contains("type") {
            return .categoryAspects
        }
        if lower.contains("grade") || lower.contains("cert") ||
           lower.contains("condition") {
            return .condition
        }
        if lower.contains("title") || lower.contains("price") ||
           lower.contains("description") {
            return .listing
        }
        if lower.contains("player") || lower.contains("year") ||
           lower.contains("set") {
            return .identity
        }
        return nil
    }

    private func scheduleErrorClear() {
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await MainActor.run { publishError = nil }
        }
    }

    // MARK: - Photo upload (2026-07-20 spec §Photos)

    /// SAS-upload handshake: request a writable URL from
    /// `/api/uploads/card-photo`, PUT the JPEG-compressed bytes,
    /// then append the returned `blobUrl` to `review.photos[]` so
    /// the next publish payload carries it. Silent on any failure —
    /// user just doesn't see a new tile.
    private func uploadPickedImage(_ image: UIImage) async {
        guard var current = listing else { return }
        guard current.photos.count < 12 else {
            publishError = "eBay caps listings at 12 photos."
            scheduleErrorClear()
            return
        }
        isUploadingPhoto = true
        defer { isUploadingPhoto = false }
        do {
            let compressed = image.jpegData(compressionQuality: 0.85) ?? Data()
            guard compressed.isEmpty == false else { return }
            let sas = try await APIService.shared.requestCardPhotoSAS(fileExtension: "jpg")
            guard let uploadUrl = sas.uploadUrl, let blobUrl = sas.blobUrl else { return }
            try await APIService.shared.uploadImageToSAS(
                uploadUrl: uploadUrl,
                imageData: compressed,
                contentType: sas.contentType ?? "image/jpeg"
            )
            current.photos.append(blobUrl)
            current.recomputeValidation()
            listing = current
            ListingDraftStore.save(holdingId: holdingId, listing: current)
            ListingReviewAnalytics.fieldEdited(holdingId: holdingId, field: "photos")
            editedFieldNames.insert("photos")
        } catch {
            publishError = "Couldn't upload the photo. Try again."
            scheduleErrorClear()
        }
    }
}

// MARK: - Camera bridge (2026-07-20)

/// UIKit `UIImagePickerController` wrapped for SwiftUI. Used by
/// `ListingReviewView` when the user picks "Take photo" — SwiftUI
/// doesn't have a first-class camera equivalent to `PhotosPicker`
/// yet on iOS 17.
private struct CameraCapturePicker: UIViewControllerRepresentable {
    let onFinish: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        controller.allowsEditing = false
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void
        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let image = info[.originalImage] as? UIImage
            onFinish(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(nil)
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
