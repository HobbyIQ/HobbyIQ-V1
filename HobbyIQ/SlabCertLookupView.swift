//
//  SlabCertLookupView.swift
//  HobbyIQ
//
//  CF-CERT-LOOKUP (2026-07-04, backend batch §2): direct cert-number path
//  for graded slabs. User enters cert + picks grader; we POST to
//  /api/compiq/lookup-by-cert and render a summary + recent comps.
//  "See full pricing →" pushes CompIQPricedCardView using the returned
//  cardId. Complements the image-scan flow (GradedSlabScanFlow.swift)
//  for the case when the user has the cert typed but no photo.
//

import SwiftUI
import VisionKit

// MARK: - Wire Models (POST /api/compiq/lookup-by-cert)

struct LookupByCertRequest: Encodable {
    let cert: String
    let grader: String
    let days: Int?
}

struct LookupByCertResponse: Decodable {
    let success: Bool
    let cert: String?
    let grader: String?
    let grade: String?
    let card: LookupByCertCard?
    let referencePrice: Double?
    let prices: [LookupByCertPriceSample]?
    let matchConfidence: Double?
    let windowDays: Int?
    let error: String?
}

struct LookupByCertCard: Decodable, Hashable {
    let cardId: String?
    let description: String?
    let player: String?
    let set: String?
    let number: String?
    let variant: String?
    let imageUrl: String?
}

struct LookupByCertPriceSample: Decodable, Identifiable, Hashable {
    let price: Double?
    let date: String?
    let saleType: String?
    let title: String?

    var id: String { "\(date ?? "?")-\(price ?? 0)-\(title ?? "")" }
}

// MARK: - View

struct SlabCertLookupView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

    @State private var cert: String = ""
    @State private var grader: Grader = .psa
    @State private var isLoading = false
    @State private var result: LookupByCertResponse?
    @State private var errorMessage: String?
    @State private var pushToPriced = false
    @State private var showBarcodeScanner = false
    /// CF-CERT-ADD-TO-INVENTORY (2026-07-06): purchase-details form
    /// state shown alongside the preview. All local to this view;
    /// backend receives the composed body via `addHoldingByCert`.
    @State private var quantityText: String = "1"
    @State private var purchasePriceText: String = ""
    @State private var purchaseDate: Date = Date()
    @State private var purchaseSourceText: String = ""
    @State private var notesText: String = ""
    @State private var isAdding = false
    @State private var addError: String?

    enum Grader: String, CaseIterable, Identifiable {
        case psa = "PSA"
        case bgs = "BGS"
        case sgc = "SGC"
        case cgc = "CGC"
        var id: String { rawValue }
    }

    var body: some View {
        ZStack {
            HobbyIQBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
                    heroCopy
                    lookupForm
                    if isLoading {
                        loadingCard
                    } else if let response = result, response.success {
                        successCard(response)
                    } else if let msg = errorMessage {
                        notFoundCard(msg)
                    }
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, HobbyIQTheme.Spacing.medium)
            }
        }
        .navigationTitle("Look up by cert #")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationDestination(isPresented: $pushToPriced, destination: destinationForPush)
        .sheet(isPresented: $showBarcodeScanner) {
            BarcodeScannerView { scannedValue in
                cert = scannedValue
                showBarcodeScanner = false
            } onDismiss: {
                showBarcodeScanner = false
            }
        }
    }

    // MARK: Hero copy

    private var heroCopy: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Cert-number lookup")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Type the cert from the slab label and pick the grader. We'll find the card and price it at its grade.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.6)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    // MARK: Form

    private var lookupForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Cert #")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.4)
                HStack(spacing: 10) {
                    TextField("e.g. 74206113 or 0016523480", text: $cert)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .padding(12)
                        .background(HobbyIQTheme.Colors.steelGray.opacity(0.18))
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
                        )
                    // CF-CERT-BARCODE-SCAN (2026-07-04): PSA/BGS slab
                    // backs print barcodes that encode the cert. On
                    // devices supporting VisionKit's DataScanner, this
                    // button opens a camera sheet that auto-populates
                    // the cert field. On unsupported devices, the
                    // button is hidden so the manual text field stays
                    // the only path.
                    if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                        Button {
                            showBarcodeScanner = true
                        } label: {
                            Image(systemName: "barcode.viewfinder")
                                .font(.system(size: 22, weight: .semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                .frame(width: 46, height: 46)
                                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Scan slab barcode")
                    }
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Grader")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.4)
                Picker("Grader", selection: $grader) {
                    ForEach(Grader.allCases) { g in
                        Text(g.rawValue).tag(g)
                    }
                }
                .pickerStyle(.segmented)
            }

            Button(action: lookup) {
                HStack(spacing: 8) {
                    if isLoading {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "magnifyingglass")
                            .font(.subheadline.weight(.bold))
                    }
                    Text(isLoading ? "Looking up…" : "Look up")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isLookupDisabled)
            .opacity(isLookupDisabled ? 0.5 : 1.0)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private var isLookupDisabled: Bool {
        cert.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading
    }

    // MARK: Loading

    private var loadingCard: some View {
        HStack(spacing: 12) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Looking up cert…")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    // MARK: Success

    @ViewBuilder
    private func successCard(_ response: LookupByCertResponse) -> some View {
        let card = response.card
        VStack(alignment: .leading, spacing: 14) {
            // CF-CERT-ADD-TO-INVENTORY (2026-07-06): catalog card art
            // — same aspect-locked treatment the comp-card hero uses
            // (scaledToFit + .scaleEffect(0.85), fixed card-aspect
            // frame). Only renders when the lookup returned an
            // imageUrl.
            if let urlString = card?.imageUrl, let url = URL(string: urlString) {
                HStack {
                    Spacer(minLength: 0)
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit().scaleEffect(0.85)
                        case .empty, .failure:
                            RoundedRectangle(cornerRadius: 8)
                                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.15))
                        @unknown default:
                            EmptyView()
                        }
                    }
                    .frame(width: 145, height: 202)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity)
            }

            VStack(alignment: .leading, spacing: 6) {
                if let player = card?.player, player.isEmpty == false {
                    Text(player)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                if let description = card?.description, description.isEmpty == false {
                    Text(description)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 8) {
                    if let grade = response.grade {
                        infoPill("\(grader.rawValue) \(grade)", tint: HobbyIQTheme.Colors.electricBlue)
                    }
                    if let certValue = response.cert, certValue.isEmpty == false {
                        infoPill("Cert #\(certValue)", tint: HobbyIQTheme.Colors.mutedText)
                    }
                }
                .flexibleWrap()

                HStack(spacing: 8) {
                    if let refPrice = response.referencePrice, refPrice > 0 {
                        infoPill("Reference: \(refPrice.currencyStringNoCents)", tint: HobbyIQTheme.Colors.successGreen)
                    }
                    if let conf = response.matchConfidence {
                        infoPill(String(format: "Match %.0f%%", conf * 100), tint: HobbyIQTheme.Colors.mutedText)
                    }
                }
                .flexibleWrap()
            }

            // CF-CERT-ADD-TO-INVENTORY (2026-07-06): thin-match
            // warning. Backend `matchConfidence` under 0.7 means the
            // cert resolved but the card mapping is soft — user
            // should eyeball the art + description before adding.
            if let conf = response.matchConfidence, conf < 0.7 {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(HobbyIQTheme.Colors.warning)
                    Text("Verify this is the right card — match confidence is under 70%.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite.opacity(0.9))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(10)
                .background(HobbyIQTheme.Colors.warning.opacity(0.12))
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            }

            if let prices = response.prices?.prefix(3), prices.isEmpty == false {
                Divider().background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                Text("Recent sales")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.4)
                VStack(spacing: 6) {
                    ForEach(Array(prices)) { comp in
                        priceRow(comp)
                    }
                }
            }

            Divider().background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
            purchaseDetailsForm(response: response)

            if let msg = addError {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Primary CTA: add to inventory. Requires cardId.
            if let cardId = card?.cardId, cardId.isEmpty == false {
                Button {
                    Task { await addToInventory(response: response, cardId: cardId) }
                } label: {
                    HStack(spacing: 8) {
                        if isAdding {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "plus.circle.fill")
                                .font(.subheadline.weight(.bold))
                        }
                        Text(isAdding ? "Adding…" : "Add to inventory")
                            .font(.subheadline.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isAdding || isAddDisabled)
                .opacity(isAdding || isAddDisabled ? 0.6 : 1)

                Button(action: { pushToPriced = true }) {
                    HStack(spacing: 6) {
                        Text("See full pricing")
                            .font(.subheadline.weight(.semibold))
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.4)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .onAppear { seedPurchasePriceFromReference(response) }
    }

    /// Default the purchase price to the backend's `referencePrice`
    /// when the field is still blank — a saner starting number than
    /// $0 or nothing.
    private func seedPurchasePriceFromReference(_ response: LookupByCertResponse) {
        guard purchasePriceText.isEmpty else { return }
        if let ref = response.referencePrice, ref > 0 {
            purchasePriceText = String(format: "%.2f", ref)
        }
    }

    // MARK: Purchase details form

    @ViewBuilder
    private func purchaseDetailsForm(response: LookupByCertResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Purchase details")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.4)

            formRow(label: "Quantity") {
                TextField("1", text: $quantityText)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 60)
            }

            formRow(label: "Purchase price") {
                HStack(spacing: 2) {
                    Text("$")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    TextField("0.00", text: $purchasePriceText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 80)
                }
            }

            formRow(label: "Purchase date") {
                DatePicker("", selection: $purchaseDate, displayedComponents: .date)
                    .labelsHidden()
            }

            formRow(label: "Source") {
                TextField("Optional (e.g. eBay)", text: $purchaseSourceText)
                    .multilineTextAlignment(.trailing)
            }

            formRow(label: "Notes") {
                TextField("Optional", text: $notesText)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    private func formRow<Content: View>(
        label: String,
        @ViewBuilder trailing: () -> Content
    ) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            trailing()
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.vertical, 4)
    }

    private var isAddDisabled: Bool {
        guard let response = result, response.success, response.card?.cardId?.isEmpty == false else { return true }
        let qty = Double(quantityText.trimmingCharacters(in: .whitespaces)) ?? 0
        return qty <= 0
    }

    // MARK: Add-to-inventory action

    /// Composes the /lookup-by-cert response + user form values into
    /// the canonical `AddHoldingByCertRequest` wire shape and POSTs.
    /// On success, fires the shared `inventoryHoldingSaved`
    /// notification (existing pattern used by CardIdentifyView) which
    /// switches the tab bar to Inventory and refreshes the list.
    private func addToInventory(response: LookupByCertResponse, cardId: String) async {
        guard isAdding == false else { return }
        addError = nil
        let quantity = max(1.0, Double(quantityText.trimmingCharacters(in: .whitespaces)) ?? 1.0)
        let purchasePrice = Double(purchasePriceText.trimmingCharacters(in: .whitespaces)) ?? 0
        let totalCostBasis = purchasePrice * quantity
        let gradeValue: Double = {
            let raw = (response.grade ?? "").trimmingCharacters(in: .whitespaces)
            return Double(raw) ?? 0
        }()
        let (year, product) = Self.splitYearAndProduct(from: response.card?.set)
        let cardTitle = Self.composeCardTitle(
            year: year,
            product: product,
            number: response.card?.number
        )
        let parallelSanitized: String? = {
            guard let raw = response.card?.variant?.trimmingCharacters(in: .whitespaces),
                  raw.isEmpty == false,
                  raw.lowercased() != "base" else { return nil }
            return raw
        }()
        let sourceSanitized: String? = {
            let trimmed = purchaseSourceText.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? nil : trimmed
        }()
        let notesSanitized: String? = {
            let trimmed = notesText.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? nil : trimmed
        }()

        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.dateFormat = "yyyy-MM-dd"

        let request = AddHoldingByCertRequest(
            id: UUID().uuidString,
            cardId: cardId,
            playerName: response.card?.player ?? "",
            cardYear: year,
            product: product,
            cardTitle: cardTitle,
            cardNumber: response.card?.number,
            parallel: parallelSanitized,
            gradeCompany: grader.rawValue,
            gradeValue: gradeValue,
            certNumber: response.cert ?? cert,
            certGrader: grader.rawValue,
            quantity: quantity,
            purchasePrice: purchasePrice,
            totalCostBasis: totalCostBasis,
            purchaseDate: dateFormatter.string(from: purchaseDate),
            purchaseSource: sourceSanitized,
            notes: notesSanitized
        )

        isAdding = true
        defer { isAdding = false }
        do {
            _ = try await APIService.shared.addHoldingByCert(request)
            NotificationCenter.default.post(name: .inventoryHoldingSaved, object: nil)
            dismiss()
        } catch {
            addError = APIService.errorMessage(from: error)
        }
    }

    /// CH ships `set` as "2011 Topps Update" / "2026 Bowman Chrome".
    /// Split off the leading 4-digit year; return the remainder as
    /// product. Fallback: whole string is the product, year nil.
    static func splitYearAndProduct(from set: String?) -> (year: Int?, product: String) {
        guard let raw = set?.trimmingCharacters(in: .whitespaces), raw.isEmpty == false else {
            return (nil, "")
        }
        let parts = raw.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        if parts.count == 2, let year = Int(parts[0]), (1900...2100).contains(year) {
            return (year, String(parts[1]))
        }
        return (nil, raw)
    }

    static func composeCardTitle(year: Int?, product: String, number: String?) -> String {
        var parts: [String] = []
        if let year { parts.append(String(year)) }
        if product.isEmpty == false { parts.append(product) }
        if let number, number.isEmpty == false { parts.append(number) }
        return parts.joined(separator: " ")
    }

    private func priceRow(_ sample: LookupByCertPriceSample) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                if let title = sample.title, title.isEmpty == false {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(2)
                }
                HStack(spacing: 6) {
                    if let date = sample.date {
                        Text(date)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    if let saleType = sample.saleType, saleType.isEmpty == false {
                        Text("· \(saleType)")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
            Spacer(minLength: 8)
            if let price = sample.price {
                Text(price.currencyStringNoCents)
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: Not found

    private func notFoundCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                Text("Not found")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            Text(message)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
            Text("Try scanning the slab image instead — go back and use the camera or photo library.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.warning.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Push

    @ViewBuilder
    private func destinationForPush() -> some View {
        if let card = result?.card, let cardId = card.cardId {
            CompIQPricedCardView(
                hit: CompIQVariantHit(
                    cardId: cardId,
                    player: card.player,
                    set: card.set,
                    year: nil,
                    number: card.number,
                    variant: card.variant,
                    title: card.description,
                    imageUrl: card.imageUrl,
                    brand: card.set
                ),
                initialGrade: gradeOptionFromResult()
            )
            .environmentObject(sessionViewModel)
        }
    }

    /// If the backend returned "PSA 10" as the grade string, feed the
    /// priced-card view a matching GradeOption so it lands grade-matched.
    private func gradeOptionFromResult() -> CompIQPricedCardView.GradeOption? {
        guard let grade = result?.grade?.trimmingCharacters(in: .whitespaces),
              grade.isEmpty == false else { return nil }
        let parts = grade.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2, let value = Double(parts[1]) else { return nil }
        return CompIQPricedCardView.gradeOption(forCompany: String(parts[0]), value: value)
    }

    // MARK: Chrome helpers

    private func infoPill(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tint.opacity(0.14))
            .clipShape(Capsule())
    }

    // MARK: Action

    private func lookup() {
        errorMessage = nil
        result = nil
        let trimmed = cert.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }
        isLoading = true
        Task {
            do {
                let response = try await APIService.shared.fetchCertLookup(
                    cert: trimmed,
                    grader: grader.rawValue,
                    days: 90
                )
                await MainActor.run {
                    if response.success {
                        result = response
                    } else {
                        errorMessage = response.error ?? "That cert didn't match any card in our catalog. Double-check the number and grader."
                    }
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    errorMessage = APIService.errorMessage(from: error)
                    isLoading = false
                }
            }
        }
    }
}

/// Very-small flex-wrap for the info pills row so they wrap to the next
/// line on narrow screens instead of overflowing.
private extension View {
    func flexibleWrap() -> some View {
        self.frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Barcode Scanner (VisionKit)

/// CF-CERT-BARCODE-SCAN (2026-07-04): thin wrapper around VisionKit's
/// `DataScannerViewController` that surfaces the first barcode payload
/// string it recognises and dismisses. Caller checks
/// `DataScannerViewController.isSupported && .isAvailable` before
/// presenting — devices without a compatible camera or with iOS < 16
/// simply won't see the entry-point button.
private struct BarcodeScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onDismiss: () -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode()],
            qualityLevel: .accurate,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        DispatchQueue.main.async {
            try? scanner.startScanning()
        }
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan, onDismiss: onDismiss)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        let onDismiss: () -> Void
        private var didReport = false

        init(onScan: @escaping (String) -> Void, onDismiss: @escaping () -> Void) {
            self.onScan = onScan
            self.onDismiss = onDismiss
        }

        func dataScanner(_ dataScanner: DataScannerViewController,
                         didAdd addedItems: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            guard !didReport else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item,
                   let value = barcode.payloadStringValue,
                   value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                    didReport = true
                    onScan(value)
                    return
                }
            }
        }
    }
}
