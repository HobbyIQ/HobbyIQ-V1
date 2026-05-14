import SwiftUI
import UIKit

// MARK: - EbayListingDraftView

/// Sheet shown when the user taps "List on eBay" from PortfolioHoldingDetailView.
/// Flow:
///   1. Pre-fill fields from PortfolioHolding.
///   2. "Preview" call validates the title/description without posting to eBay.
///   3. "List on eBay" publishes via POST /api/ebay/listings/publish.
///   4. On success, parent holding's listingUrl / listingPrice are updated.
struct EbayListingDraftView: View {
    let holding: PortfolioHolding
    /// Called on successful publish with the returned listing URL and final list price.
    var onPublished: ((String?, Double) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    // Form state
    @State private var cardDraft: ListingCardDraft
    @State private var listingPrice: Double
    @State private var bestOfferEnabled = false
    @State private var bestOfferMinPrice: Double = 0
    @State private var quantity = 1

    // Preview
    @State private var previewData: EbayListingPreview? = nil
    @State private var previewLoading = false
    @State private var previewError: String? = nil

    // Publish
    @State private var publishLoading = false
    @State private var publishError: String? = nil
    @State private var publishedListing: EbayPublishResponse? = nil
    @State private var publishedOfferStatus: EbayOfferStatusResponse? = nil

    // eBay connection gate
    @State private var showEbayConnect = false
    @StateObject private var ebayStore = EbayAccountStore.shared

    // Seller policies (auto-loaded on appear)
    @State private var paymentPolicyId: String? = nil
    @State private var returnPolicyId: String? = nil
    @State private var fulfillmentPolicyId: String? = nil
    @State private var policiesLoaded = false

    init(holding: PortfolioHolding, onPublished: ((String?, Double) -> Void)? = nil) {
        self.holding = holding
        self.onPublished = onPublished
        _cardDraft = State(initialValue: ListingCardDraft(
            playerName: holding.playerName,
            cardTitle: holding.cardTitle,
            cardYear: String(holding.cardYear),
            brand: holding.brand,
            setName: holding.setName,
            product: holding.product,
            sport: holding.sport ?? "",
            cardNumber: holding.cardNumber ?? "",
            parallel: holding.parallel ?? "",
            serialNumber: holding.serialNumber ?? "",
            printRun: holding.printRun.map(String.init) ?? "",
            variation: holding.variation ?? "",
            grade: holding.grade,
            gradingCompany: holding.gradingCompany,
            certNumber: holding.certNumber ?? "",
            conditionEstimate: holding.conditionEstimate ?? "",
            conditionNotes: holding.conditionNotes ?? ""
        ))
        _listingPrice = State(initialValue: holding.suggestedListPrice ?? holding.fairMarketValue ?? holding.listingPrice ?? holding.currentValue)
        _quantity = State(initialValue: max(1, holding.quantity))
    }

    private var sessionId: String? {
        UserDefaults.standard.string(forKey: "auth.sessionId")
    }

    var body: some View {
        NavigationStack {
            Group {
                if publishedListing?.success == true {
                    successView
                } else {
                    draftForm
                }
            }
            .navigationTitle("List on eBay")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .sheet(isPresented: $showEbayConnect) {
            EbayConnectView()
                .task { await ebayStore.refresh() }
        }
        .task {
            await ebayStore.refresh()
            if ebayStore.isConnected { await loadPolicies() }
        }
    }

    // MARK: Draft form

    private var draftForm: some View {
        ScrollView {
            VStack(spacing: 20) {
                // --- Connection banner ---
                if !ebayStore.isConnected {
                    notConnectedBanner
                } else {
                    connectedBanner
                }

                // --- Card info (read-only) ---
                cardInfoSection

                // --- Listing params ---
                listingParamsSection

                // --- Preview button ---
                if previewLoading {
                    HStack { ProgressView(); Text("Generating preview…").foregroundColor(.gray) }
                } else {
                    Button { Task { await runPreview() } } label: {
                        Label("Generate Preview", systemImage: "eye")
                            .frame(maxWidth: .infinity)
                            .padding(12)
                            .background(Color.white.opacity(0.07))
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(!canRunListingActions)
                }

                if let previewErr = previewError {
                    errorLabel(previewErr)
                }

                // --- Preview card ---
                if let preview = previewData {
                    previewCard(preview)
                }

                // --- Publish button ---
                publishButton

                if let pubErr = publishError {
                    errorLabel(pubErr)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Color.black.ignoresSafeArea())
    }

    // MARK: Not-connected banner

    private var notConnectedBanner: some View {
        VStack(spacing: 10) {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
                Text("eBay account not connected")
                    .font(.subheadline.weight(.semibold))
                Spacer()
            }
            Button {
                showEbayConnect = true
            } label: {
                Text("Connect eBay Account →")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.blue)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.orange.opacity(0.25), lineWidth: 1))
    }

    private var connectedBanner: some View {
        VStack(spacing: 8) {
            HStack {
                Image(systemName: "checkmark.seal.fill").foregroundColor(.green)
                Text("Connected to eBay")
                    .font(.subheadline.weight(.semibold))
                Spacer()
            }
            HStack {
                Text("Account")
                    .font(.caption)
                    .foregroundColor(.gray)
                Spacer()
                Text(ebayStore.ebayUserId.flatMap { $0.isEmpty || $0 == "unknown" ? nil : $0 } ?? "Unknown")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.white)
            }
        }
        .padding(14)
        .background(Color.green.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.green.opacity(0.25), lineWidth: 1))
    }

    // MARK: Card info

    private var cardInfoSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Card Details")
            editableFieldRow("Player", text: $cardDraft.playerName, placeholder: "Player name")
            editableFieldRow("Card Title", text: $cardDraft.cardTitle, placeholder: "Card title")
            editableFieldRow("Year", text: $cardDraft.cardYear, placeholder: "2024", keyboard: .numberPad)
            editableFieldRow("Brand", text: $cardDraft.brand, placeholder: "Topps")
            editableFieldRow("Set", text: $cardDraft.setName, placeholder: "Bowman Chrome Draft")
            editableFieldRow("Product", text: $cardDraft.product, placeholder: "Bowman Chrome Draft")
            editableFieldRow("Sport", text: $cardDraft.sport, placeholder: "Baseball")
            editableFieldRow("Card #", text: $cardDraft.cardNumber, placeholder: "123")
            editableFieldRow("Parallel", text: $cardDraft.parallel, placeholder: "Gold /99")
            editableFieldRow("Serial #", text: $cardDraft.serialNumber, placeholder: "/99")
            editableFieldRow("Print Run", text: $cardDraft.printRun, placeholder: "99", keyboard: .numberPad)
            editableFieldRow("Variation", text: $cardDraft.variation, placeholder: "Image variation")

            Divider().overlay(Color.white.opacity(0.12))

            if holding.isRaw {
                editableFieldRow("Condition Est.", text: $cardDraft.conditionEstimate, placeholder: "NM-MT")
                editableFieldRow("Condition Notes", text: $cardDraft.conditionNotes, placeholder: "Centering, corners, surface")
            } else {
                editableFieldRow("Grading Co.", text: $cardDraft.gradingCompany, placeholder: "PSA")
                editableFieldRow("Grade", text: $cardDraft.grade, placeholder: "10")
                editableFieldRow("Cert #", text: $cardDraft.certNumber, placeholder: "12345678")
            }

            infoRow("Status", missingRequiredFields.isEmpty ? "Ready to list" : "Missing: \(missingRequiredFields.joined(separator: ", "))")
            if let img = holding.imageFrontUrl {
                AsyncImage(url: URL(string: img)) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFit().frame(maxHeight: 160)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    default: EmptyView()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .padding(14)
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: Listing params

    private var listingParamsSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader("Listing Settings")

            HStack {
                Text("List Price").foregroundColor(.gray)
                Spacer()
                HStack(spacing: 4) {
                    Text("$").foregroundColor(.gray)
                    TextField("0.00", value: $listingPrice, format: .number)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                        .foregroundColor(.white)
                }
            }

            HStack {
                Text("Quantity").foregroundColor(.gray)
                Spacer()
                Stepper("\(quantity)", value: $quantity, in: 1...99)
                    .labelsHidden()
                Text("\(quantity)").foregroundColor(.white).frame(width: 30, alignment: .trailing)
            }

            Toggle("Best Offer", isOn: $bestOfferEnabled)
                .tint(.blue)

            if bestOfferEnabled {
                HStack {
                    Text("Min Offer $").foregroundColor(.gray)
                    Spacer()
                    TextField("0.00", value: $bestOfferMinPrice, format: .number)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                        .foregroundColor(.white)
                }
            }
        }
        .padding(14)
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: Preview card

    private func previewCard(_ preview: EbayListingPreview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("Listing Preview")
            infoRow("Title", preview.title)
            infoRow("Price", String(format: "$%.2f", preview.price))
            infoRow("Category ID", preview.categoryId)
            infoRow("Marketplace", preview.marketplaceId)
            infoRow("Qty", "\(preview.quantity)")
            if preview.bestOfferEnabled { infoRow("Best Offer", "Enabled") }
        }
        .padding(14)
        .background(Color.blue.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(Color.blue.opacity(0.18), lineWidth: 1))
    }

    // MARK: Publish button

    private var publishButton: some View {
        Button {
            guard ebayStore.isConnected else {
                showEbayConnect = true
                return
            }
            Task { await runPublish() }
        } label: {
            HStack(spacing: 10) {
                if publishLoading {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: "cart.fill")
                }
                Text(publishLoading ? "Listing…" : "List on eBay")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .padding()
            .background(ebayStore.isConnected ? Color.green : Color.gray)
            .foregroundColor(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .disabled(publishLoading || !canRunListingActions)
    }

    // MARK: Success view

    private var successView: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundColor(.green)
            Text("Listed Successfully!")
                .font(.title2.weight(.bold))
            if let status = publishedOfferStatus {
                VStack(spacing: 6) {
                    Text("Offer Status: \(status.status)")
                        .font(.subheadline.weight(.semibold))
                    if let marketplaceId = status.marketplaceId {
                        Text("Marketplace: \(marketplaceId)")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                }
            }
            if let url = publishedListing?.listingUrl {
                Text("View on eBay:")
                    .foregroundColor(.gray).font(.subheadline)
                Link(url, destination: URL(string: url)!)
                    .font(.caption)
                    .foregroundColor(.blue)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            Button("Done") {
                onPublished?(publishedListing?.listingUrl, listingPrice)
                dismiss()
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding()
            .background(Color.green)
            .foregroundColor(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 40)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color.black.ignoresSafeArea())
    }

    // MARK: Actions

    private func loadPolicies() async {
        guard !policiesLoaded, let sid = sessionId else { return }
        do {
            let resp = try await APIService.shared.ebayGetPolicies(sessionId: sid)
            paymentPolicyId     = resp.paymentPolicies.first?.policyId
            fulfillmentPolicyId = resp.fulfillmentPolicies.first?.policyId
            returnPolicyId      = resp.returnPolicies.first?.policyId
            policiesLoaded = true
        } catch {
            // Non-fatal — backend falls back to env-var defaults
        }
    }

    private func runPreview() async {
        guard let sid = sessionId else { return }
        guard canRunListingActions else {
            previewError = missingRequiredFieldsMessage
            return
        }
        previewLoading = true
        previewError = nil
        defer { previewLoading = false }
        do {
            let resp = try await APIService.shared.ebayPreviewListing(body: buildRequest(), sessionId: sid)
            previewData = resp.preview
        } catch {
            previewError = error.localizedDescription
        }
    }

    private func runPublish() async {
        guard let sid = sessionId else { return }
        guard canRunListingActions else {
            publishError = missingRequiredFieldsMessage
            return
        }
        publishLoading = true
        publishError = nil
        publishedOfferStatus = nil
        defer { publishLoading = false }
        do {
            let resp = try await APIService.shared.ebayPublishListing(body: buildRequest(), sessionId: sid)
            if resp.success {
                publishedListing = resp
                if let offerId = resp.offerId {
                    // Verify listing status from eBay immediately after publish.
                    if let statusResp = try? await APIService.shared.ebayListingStatus(offerId: offerId, sessionId: sid) {
                        publishedOfferStatus = statusResp
                    }
                }
            } else {
                publishError = resp.error ?? "Unknown error from eBay"
            }
        } catch {
            publishError = error.localizedDescription
        }
    }

    private func buildRequest() -> EbayListingRequest {
        let resolvedYear = Int(cardDraft.cardYear.trimmingCharacters(in: .whitespacesAndNewlines)) ?? holding.cardYear
        let resolvedPrintRun = Int(cardDraft.printRun.trimmingCharacters(in: .whitespacesAndNewlines))
        EbayListingRequest(
            holdingId:        holding.id.uuidString,
            playerName:       trimmed(cardDraft.playerName) ?? holding.playerName,
            cardTitle:        trimmed(cardDraft.cardTitle) ?? holding.cardTitle,
            cardYear:         resolvedYear,
            brand:            trimmed(cardDraft.brand) ?? holding.brand,
            setName:          trimmed(cardDraft.setName) ?? holding.setName,
            product:          trimmed(cardDraft.product) ?? holding.product,
            sport:            trimmed(cardDraft.sport) ?? holding.sport,
            cardNumber:       trimmed(cardDraft.cardNumber) ?? holding.cardNumber,
            parallel:         trimmed(cardDraft.parallel) ?? holding.parallel,
            serialNumber:     trimmed(cardDraft.serialNumber) ?? holding.serialNumber,
            printRun:         resolvedPrintRun ?? holding.printRun,
            isAuto:           holding.isAuto,
            isPatch:          holding.isPatch,
            isRookie:         holding.isRookie,
            variation:        trimmed(cardDraft.variation) ?? holding.variation,
            grade:            holding.isRaw ? nil : (trimmed(cardDraft.grade) ?? holding.grade),
            gradingCompany:   holding.isRaw ? nil : (trimmed(cardDraft.gradingCompany) ?? holding.gradingCompany),
            certNumber:       trimmed(cardDraft.certNumber) ?? holding.certNumber,
            conditionNotes:   holding.isRaw ? trimmed(cardDraft.conditionNotes) : holding.conditionNotes,
            conditionEstimate: holding.isRaw ? trimmed(cardDraft.conditionEstimate) : holding.conditionEstimate,
            quantity:         quantity,
            listingPrice:     listingPrice,
            bestOfferEnabled: bestOfferEnabled,
            bestOfferMinPrice: bestOfferEnabled && bestOfferMinPrice > 0 ? bestOfferMinPrice : nil,
            imageFrontUrl:    holding.imageFrontUrl,
            imageBackUrl:     holding.imageBackUrl,
            description:         nil,
            paymentPolicyId:     paymentPolicyId,
            returnPolicyId:      returnPolicyId,
            fulfillmentPolicyId: fulfillmentPolicyId,
            categoryId:          nil
        )
    }

    private var canRunListingActions: Bool {
        ebayStore.isConnected && listingPrice > 0 && missingRequiredFields.isEmpty
    }

    private var missingRequiredFields: [String] {
        var fields: [String] = []
        if trimmed(cardDraft.playerName) == nil { fields.append("Player") }
        if trimmed(cardDraft.cardTitle) == nil { fields.append("Card Title") }
        if Int(cardDraft.cardYear.trimmingCharacters(in: .whitespacesAndNewlines)) == nil { fields.append("Year") }
        if trimmed(cardDraft.brand) == nil { fields.append("Brand") }
        if trimmed(cardDraft.setName) == nil { fields.append("Set") }
        if trimmed(cardDraft.product) == nil { fields.append("Product") }
        if holding.isRaw {
            if trimmed(cardDraft.conditionEstimate) == nil { fields.append("Condition Est.") }
        } else {
            if trimmed(cardDraft.gradingCompany) == nil { fields.append("Grading Co.") }
            if trimmed(cardDraft.grade) == nil { fields.append("Grade") }
        }
        return fields
    }

    private var missingRequiredFieldsMessage: String {
        missingRequiredFields.isEmpty ? "" : "Fill in required card details before listing: " + missingRequiredFields.joined(separator: ", ")
    }

    // MARK: Helpers

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundColor(.gray)
            .textCase(.uppercase)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundColor(.gray).font(.subheadline)
            Spacer()
            Text(value).foregroundColor(.white).font(.subheadline).multilineTextAlignment(.trailing)
        }
    }

    private func editableFieldRow(
        _ label: String,
        text: Binding<String>,
        placeholder: String,
        keyboard: UIKeyboardType = .default
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Text(label)
                .foregroundColor(.gray)
                .font(.subheadline)
                .frame(width: 110, alignment: .leading)
            TextField(placeholder, text: text)
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.words)
                .foregroundColor(.white)
                .multilineTextAlignment(.trailing)
        }
    }

    private func errorLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundColor(.red)
            .padding(.horizontal, 4)
    }

    private func trimmed(_ value: String) -> String? {
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? nil : result
    }
}

private struct ListingCardDraft {
    var playerName: String
    var cardTitle: String
    var cardYear: String
    var brand: String
    var setName: String
    var product: String
    var sport: String
    var cardNumber: String
    var parallel: String
    var serialNumber: String
    var printRun: String
    var variation: String
    var grade: String
    var gradingCompany: String
    var certNumber: String
    var conditionEstimate: String
    var conditionNotes: String
}
