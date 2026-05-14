// CardDetailView.swift
// PortfolioIQ — detail view for a real saved CardItem.
// Supports inline value editing and marks cards sold.

import SwiftUI
import SwiftData

struct CardDetailView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    @Bindable var card: CardItem
    var onMarkSold: (() -> Void)?

    @State private var isEditing: Bool = false
    @State private var showSellSheet: Bool = false
    @State private var showDeleteConfirm: Bool = false
    @State private var showSetAlertSheet: Bool = false

    // Photo management (Bug #3 + #4)
    @State private var pendingPhotoDeleteIndex: Int? = nil
    @State private var isResolvingImages: Bool = false

    // CompIQ
    @State private var isFetchingMarketValue: Bool = false
    @State private var compIQResult: CompIQMarketResult? = nil
    @State private var compIQError: String? = nil
    @State private var compIQFallbackComps: [CompEstimateRecentComp] = []
    @State private var showCompIQResult: Bool = false

    // Editable copies
    @State private var editPlayerName: String = ""
    @State private var editCardTitle: String = ""
    @State private var editYearText: String = ""
    @State private var editSetName: String = ""
    @State private var editCardNumber: String = ""
    @State private var editParallel: String = ""
    @State private var editSerialNumber: String = ""
    @State private var editIsRaw: Bool = true
    @State private var editIsAuto: Bool = false
    @State private var editGradingCompany: String = ""
    @State private var editGrade: String = ""
    @State private var editCertNumber: String = ""
    @State private var editPurchasePriceText: String = ""
    @State private var editCurrentValueText: String = ""
    @State private var editStatus: CardStatus = .owned
    @State private var editNotes: String = ""

    private var gainColor: Color {
        card.gainLoss > 0 ? .green : card.gainLoss < 0 ? .red : .secondary
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if isEditing {
                    editForm
                } else {
                    detailContent
                }
            }
            .navigationTitle(card.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: CardItem.self) { listingCard in
                ListingComposerView(card: listingCard)
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    if isEditing {
                        Button("Save") { saveEdits() }
                            .fontWeight(.semibold)
                    } else {
                        Button("Edit") { startEditing() }
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    if !isEditing {
                        Button {
                            showSetAlertSheet = true
                        } label: {
                            Image(systemName: "bell.badge")
                        }
                        .accessibilityLabel("Set price alert")
                    }
                }
            }
            .task { await autoResolveImagesIfNeeded() }
            .sheet(isPresented: $showSellSheet) {
                SellCardSheet(card: card)
            }
            .sheet(isPresented: $showSetAlertSheet) {
                SetAlertView(
                    cardId: card.id.uuidString,
                    playerName: card.playerName,
                    currentPrice: compIQResult?.predictedPrice,
                    cardSnapshot: PriceAlertCardSnapshot(
                        playerName: card.playerName,
                        year: card.year,
                        setName: card.setName.isEmpty ? nil : card.setName,
                        cardNumber: card.cardNumber.isEmpty ? nil : card.cardNumber,
                        grade: card.isRaw ? nil : (card.grade.isEmpty ? nil : card.grade),
                        variant: card.parallel.isEmpty ? nil : card.parallel,
                        printRun: nil,
                        isRookie: nil
                    )
                )
            }
            .confirmationDialog("Delete this card?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    context.delete(card)
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This cannot be undone.")
            }
            .confirmationDialog(
                "Remove this photo?",
                isPresented: Binding(
                    get: { pendingPhotoDeleteIndex != nil },
                    set: { if !$0 { pendingPhotoDeleteIndex = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) {
                    if let idx = pendingPhotoDeleteIndex,
                       card.photoURLs.indices.contains(idx) {
                        card.photoURLs.remove(at: idx)
                        card.updatedAt = Date()
                    }
                    pendingPhotoDeleteIndex = nil
                }
                Button("Cancel", role: .cancel) {
                    pendingPhotoDeleteIndex = nil
                }
            } message: {
                Text("This removes the image from this card. The card itself is kept.")
            }
        }
    }

    // MARK: - Detail View

    private var detailContent: some View {
        VStack(spacing: 20) {
            // Hero value card
            valueSummaryCard

            // Photo gallery (auto-resolved + user uploaded)
            photoGallerySection

            // Card info
            infoSection

            // Sale record if sold
            if card.isSold, let sale = card.saleRecord {
                saleInfoSection(sale)
            }

            // Grading info
            if !card.isRaw {
                gradingInfoSection
            }

            // Notes
            if !card.notes.isEmpty {
                notesSection
            }

            // Actions
            if !card.isSold {
                actionButtons
            } else {
                soldPriceLabel
            }

            // Danger zone
            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                Label("Delete Card", systemImage: "trash")
                    .font(.subheadline)
                    .foregroundStyle(.red)
            }
            .padding(.bottom, 32)
        }
        .padding(.horizontal)
        .padding(.top, 12)
    }

    // MARK: Photo Gallery (Bug #3 + #4)

    private var photoGallerySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Photos")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .tracking(0.5)
                Spacer()
                if isResolvingImages {
                    ProgressView().scaleEffect(0.8)
                }
            }

            if card.photoURLs.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .foregroundStyle(.secondary)
                    Text(isResolvingImages
                         ? "Searching for card image…"
                         : "No image found yet — auto-lookup runs whenever this card opens.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 12) {
                        ForEach(Array(card.photoURLs.enumerated()), id: \.offset) { idx, urlString in
                            ZStack(alignment: .topTrailing) {
                                CardRemoteImage(urlString: urlString, contentMode: .fill)
                                    .frame(width: 180, height: 240)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 12)
                                            .stroke(Color.black.opacity(0.08), lineWidth: 1)
                                    )

                                Button {
                                    pendingPhotoDeleteIndex = idx
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.title2)
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.55))
                                }
                                .padding(8)
                                .accessibilityLabel("Remove photo")
                            }
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .frame(height: 240)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Auto image resolution

    @MainActor
    private func autoResolveImagesIfNeeded() async {
        // Never wipe existing photos. Only run when the card has none yet.
        guard card.photoURLs.isEmpty, !isResolvingImages else { return }
        isResolvingImages = true
        defer { isResolvingImages = false }

        let resolved = await CompIQImageResolver.shared.resolve(for: card)
        // Re-check on main actor: only commit if the user didn't add photos
        // while we were resolving, and only if we found something.
        guard card.photoURLs.isEmpty, !resolved.isEmpty else { return }
        card.photoURLs = resolved
        card.updatedAt = Date()
    }

    // MARK: Value Summary Card

    private var valueSummaryCard: some View {
        VStack(spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.displayTitle)
                        .font(.title3)
                        .fontWeight(.bold)
                        .lineLimit(2)
                    if !card.shortDescription.isEmpty {
                        Text(card.shortDescription)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                statusBadge
            }

            Divider()

            HStack(spacing: 0) {
                metricBlock(label: "Current Value", value: card.currentValue.currencyString, highlight: false)
                Spacer()
                metricBlock(label: "Cost Basis",    value: card.purchasePrice.currencyString, highlight: false)
                Spacer()
                VStack(spacing: 3) {
                    Text("Gain/Loss")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(card.gainLoss.currencyString)
                        .font(.subheadline)
                        .fontWeight(.bold)
                        .foregroundColor(gainColor)
                    Text(String(format: "%.1f%%", card.gainLossPct))
                        .font(.caption)
                        .foregroundColor(gainColor)
                }
            }
        }
        .padding(18)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private func metricBlock(label: String, value: String, highlight: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline)
                .fontWeight(.semibold)
        }
    }

    private var statusBadge: some View {
        Text(card.cardStatus.rawValue)
            .font(.caption)
            .fontWeight(.semibold)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(card.cardStatus.color.opacity(0.15))
            .foregroundColor(card.cardStatus.color)
            .clipShape(Capsule())
    }

    // MARK: Info Section

    private var infoSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Card Info")
            infoRow("Type",   value: card.isRaw ? "Raw" : "Graded")
            if card.isAuto { infoRow("Autograph", value: "Yes ✓") }
            if let year = card.year { infoRow("Year", value: "\(year)") }
            if !card.setName.isEmpty     { infoRow("Set",         value: card.setName) }
            if !card.cardNumber.isEmpty  { infoRow("Card #",      value: card.cardNumber) }
            if !card.parallel.isEmpty    { infoRow("Parallel",    value: card.parallel) }
            if !card.serialNumber.isEmpty { infoRow("Serial #",   value: card.serialNumber) }
            infoRow("Added", value: card.createdAt.formatted(date: .abbreviated, time: .omitted))
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var gradingInfoSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Grading")
            infoRow("Company", value: card.gradingCompany)
            infoRow("Grade",   value: card.grade)
            if !card.certNumber.isEmpty { infoRow("Cert #", value: card.certNumber) }
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func saleInfoSection(_ sale: CardSaleRecord) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Sale Record")
            infoRow("Sale Price",  value: sale.salePrice.currencyString)
            infoRow("Platform",    value: sale.sellingPlatform.isEmpty ? "—" : sale.sellingPlatform)
            infoRow("Date Sold",   value: sale.saleDate.formatted(date: .abbreviated, time: .omitted))
            infoRow("Fees",        value: sale.fees.currencyString)
            infoRow("Shipping",    value: sale.shippingCost.currencyString)
            infoRow("Net Profit",  value: sale.netProfit.currencyString)
            infoRow("ROI",         value: String(format: "%.1f%%", sale.roi))
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var notesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Notes")
            Text(card.notes)
                .font(.subheadline)
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .tracking(0.5)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }

    private func infoRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline)
                .fontWeight(.medium)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: Action Buttons

    private var actionButtons: some View {
        VStack(spacing: 12) {
            // CompIQ market value refresh
            Button {
                Task { await fetchCompIQValue() }
            } label: {
                HStack(spacing: 8) {
                    if isFetchingMarketValue {
                        ProgressView().scaleEffect(0.85)
                        Text("Fetching market value…")
                    } else {
                        Image(systemName: "chart.line.uptrend.xyaxis")
                        Text("Refresh Market Value (CompIQ)")
                    }
                }
                .font(.subheadline)
                .fontWeight(.medium)
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.blue.opacity(0.12))
                .foregroundColor(.blue)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(isFetchingMarketValue)

            if showCompIQResult {
                if let result = compIQResult {
                    CompIQPredictionCard(result: result)
                    if !result.recentComps.isEmpty {
                        RecentCompsListView(
                            comps: result.recentComps,
                            title: "Comps Used",
                            subtitle: nil
                        )
                    }
                } else if let error = compIQError {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text(error).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(Color.orange.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    if !compIQFallbackComps.isEmpty {
                        RecentCompsListView(
                            comps: compIQFallbackComps,
                            title: "Recent Sales on File",
                            subtitle: "Not enough recent data to build a confident prediction — here’s what Card Hedge has on file."
                        )
                    }
                }
            }

            Button {
                showSellSheet = true
            } label: {
                Label("Mark as Sold", systemImage: "dollarsign.circle.fill")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.green)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .fontWeight(.semibold)
            }

            // eBay listing CTA — hidden once card is listed/sold.
            // "Mark as Sold" above already gates on isSold, but this view is
            // also rendered standalone in the listed branch.
            listingCTA

            Button {
                startEditing()
            } label: {
                Label("Edit Card", systemImage: "pencil")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .foregroundColor(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    // MARK: eBay Listing CTA

    /// Renders one of:
    /// - "View Listing" (opens external eBay URL) when ebayListingStatus == "listed"
    /// - "List on eBay" (NavigationLink → ListingComposerView) otherwise,
    ///   gated so already-listed/sold cards do NOT show the compose CTA.
    @ViewBuilder
    private var listingCTA: some View {
        if card.ebayListingStatus == "listed" {
            Button {
                guard let url = URL(string: card.ebayListingURL),
                      !card.ebayListingURL.isEmpty else { return }
                UIApplication.shared.open(url)
            } label: {
                Label("View Listing", systemImage: "arrow.up.right.square")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.indigo.opacity(0.12))
                    .foregroundColor(.indigo)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .fontWeight(.semibold)
            }
            .disabled(card.ebayListingURL.isEmpty)
        } else if card.status != CardStatus.listed.rawValue,
                  card.status != CardStatus.sold.rawValue {
            NavigationLink(value: card) {
                Label("List on eBay", systemImage: "tag.fill")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.purple)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .fontWeight(.semibold)
            }
        }
    }

    /// Read-only "Sold for $X" label shown in place of action buttons when
    /// the card has been marked sold. CardItem has no direct `soldPrice`
    /// field; the sale price lives on `card.saleRecord?.salePrice`.
    private var soldPriceLabel: some View {
        HStack {
            Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
            Text("Sold for \((card.saleRecord?.salePrice ?? 0).currencyString)")
                .font(.subheadline)
                .fontWeight(.semibold)
            Spacer()
        }
        .padding()
        .background(Color.green.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - CompIQ Fetch

    @MainActor
    private func fetchCompIQValue() async {
        compIQError = nil
        compIQResult = nil
        compIQFallbackComps = []
        showCompIQResult = false
        isFetchingMarketValue = true
        defer { isFetchingMarketValue = false }

        do {
            let result = try await CompIQService.fetchMarketValue(
                playerName: card.playerName,
                year: card.year,
                setName: card.setName,
                cardNumber: card.cardNumber,
                parallel: card.parallel,
                isAuto: card.isAuto,
                isRaw: card.isRaw,
                gradingCompany: card.gradingCompany,
                grade: card.grade
            )
            compIQResult = result
            card.currentValue = result.nextSaleEstimate
            card.updatedAt = Date()
        } catch CompIQServiceError.insufficientWithComps(let comps) {
            compIQFallbackComps = comps
            compIQError = CompIQServiceError.insufficientWithComps(comps).errorDescription
        } catch {
            compIQError = error.localizedDescription
        }
        showCompIQResult = true
    }

    // MARK: - Edit Form

    private var editForm: some View {
        Form {
            Section("Required") {
                TextField("Player name or card title", text: $editPlayerName)
                Toggle(isOn: $editIsRaw) {
                    Text(editIsRaw ? "Raw card" : "Graded card")
                }
                .tint(.blue)
            }
            Section("Card Details") {
                TextField("Card title", text: $editCardTitle)
                TextField("Year", text: $editYearText).keyboardType(.numberPad)
                TextField("Set name", text: $editSetName)
                TextField("Card number", text: $editCardNumber)
                TextField("Parallel", text: $editParallel)
                TextField("Serial number", text: $editSerialNumber)
                Toggle(isOn: $editIsAuto) {
                    Text("Autograph")
                }
                .tint(.blue)
            }
            if !editIsRaw {
                Section("Grading") {
                    TextField("Grading company", text: $editGradingCompany)
                    TextField("Grade", text: $editGrade).keyboardType(.decimalPad)
                    TextField("Cert number", text: $editCertNumber).keyboardType(.numberPad)
                }
            }
            Section("Price") {
                HStack {
                    Text("$").foregroundStyle(.secondary)
                    TextField("Purchase price", text: $editPurchasePriceText).keyboardType(.decimalPad)
                }
                HStack {
                    Text("$").foregroundStyle(.secondary)
                    TextField("Current value", text: $editCurrentValueText).keyboardType(.decimalPad)
                }
            }
            Section("Status & Notes") {
                Picker("Status", selection: $editStatus) {
                    ForEach(CardStatus.allCases, id: \.self) { s in
                        Text(s.rawValue).tag(s)
                    }
                }
                TextField("Notes", text: $editNotes, axis: .vertical)
                    .lineLimit(3, reservesSpace: true)
            }
        }
    }

    // MARK: - Editing Helpers

    private func startEditing() {
        editPlayerName      = card.playerName
        editCardTitle       = card.cardTitle
        editYearText        = card.year.map { "\($0)" } ?? ""
        editSetName         = card.setName
        editCardNumber      = card.cardNumber
        editParallel        = card.parallel
        editSerialNumber    = card.serialNumber
        editIsRaw           = card.isRaw
        editIsAuto          = card.isAuto
        editGradingCompany  = card.gradingCompany
        editGrade           = card.grade
        editCertNumber      = card.certNumber
        editPurchasePriceText = card.purchasePrice > 0 ? String(card.purchasePrice) : ""
        editCurrentValueText  = card.currentValue  > 0 ? String(card.currentValue)  : ""
        editStatus          = card.cardStatus
        editNotes           = card.notes
        isEditing           = true
    }

    private func saveEdits() {
        card.playerName     = editPlayerName.trimmingCharacters(in: .whitespaces)
        card.cardTitle      = editCardTitle.trimmingCharacters(in: .whitespaces)
        card.year           = Int(editYearText)
        card.setName        = editSetName.trimmingCharacters(in: .whitespaces)
        card.cardNumber     = editCardNumber.trimmingCharacters(in: .whitespaces)
        card.parallel       = editParallel.trimmingCharacters(in: .whitespaces)
        card.serialNumber   = editSerialNumber.trimmingCharacters(in: .whitespaces)
        card.isRaw          = editIsRaw
        card.isAuto         = editIsAuto
        card.gradingCompany = editIsRaw ? "" : editGradingCompany.trimmingCharacters(in: .whitespaces)
        card.grade          = editIsRaw ? "" : editGrade.trimmingCharacters(in: .whitespaces)
        card.certNumber     = editIsRaw ? "" : editCertNumber.trimmingCharacters(in: .whitespaces)
        card.purchasePrice  = Double(editPurchasePriceText) ?? card.purchasePrice
        card.currentValue   = Double(editCurrentValueText) ?? card.currentValue
        card.status         = editStatus.rawValue
        card.notes          = editNotes.trimmingCharacters(in: .whitespaces)
        card.updatedAt      = Date()
        isEditing           = false
    }
}

// MARK: - CompIQ Prediction Card

private struct CompIQPredictionCard: View {
    let result: CompIQMarketResult

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Headline
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Market value updated to \(result.nextSaleEstimate.currencyString)")
                    .font(.caption).fontWeight(.semibold).foregroundStyle(.green)
                Spacer()
                if let conf = result.confidence {
                    Text("\(conf)% conf")
                        .font(.caption2).fontWeight(.semibold)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(confidenceColor(conf).opacity(0.18))
                        .foregroundStyle(confidenceColor(conf))
                        .clipShape(Capsule())
                }
            }

            // Forecast row
            HStack(spacing: 12) {
                if let p72 = result.predicted72h {
                    forecastCell(label: "72h", value: p72)
                }
                if let p7 = result.predicted7d {
                    forecastCell(label: "7d", value: p7)
                }
                if let dir = result.predictedDirection {
                    HStack(spacing: 4) {
                        Image(systemName: directionIcon(dir))
                        Text(dir.capitalized).font(.caption2).fontWeight(.medium)
                    }
                    .foregroundStyle(directionColor(dir))
                }
                Spacer()
            }

            // Range + sample size
            Text(String(format: "Range: $%.0f – $%.0f  •  %d sales", result.rangeLow, result.rangeHigh, result.sampleSize))
                .font(.caption2).foregroundStyle(.secondary)

            // Best time to sell + recommendation
            HStack(spacing: 8) {
                if let best = result.bestTimeToSell {
                    Label("Sell: \(best)", systemImage: "clock.fill")
                        .font(.caption2).fontWeight(.medium)
                        .foregroundStyle(.blue)
                }
                Text("Rec: \(result.recommendation.capitalized)")
                    .font(.caption2).fontWeight(.medium)
                    .foregroundStyle(result.recommendation == "move" ? .orange : .secondary)
            }

            // Catalyst
            if result.catalystDetected == true, let detail = result.catalystDetail, !detail.isEmpty {
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: "bolt.fill").foregroundStyle(.yellow)
                    Text(detail).font(.caption2).foregroundStyle(.primary)
                }
            }

            // Key drivers
            if !result.keyDrivers.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Key drivers").font(.caption2).fontWeight(.semibold).foregroundStyle(.secondary)
                    ForEach(result.keyDrivers.prefix(3), id: \.self) { d in
                        Text("• \(d)").font(.caption2).foregroundStyle(.primary)
                    }
                }
            }

            // Risk flags
            if !result.riskFlags.isEmpty {
                FlowChips(items: Array(result.riskFlags.prefix(4)), tint: .orange)
            }

            // Confidence reason
            if let reason = result.confidenceReason, !reason.isEmpty {
                Text(reason)
                    .font(.caption2).italic().foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(Color.green.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func forecastCell(label: String, value: Double) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value.currencyString).font(.caption).fontWeight(.semibold)
        }
    }

    private func directionIcon(_ d: String) -> String {
        switch d.lowercased() {
        case "rising":   return "arrow.up.right"
        case "falling":  return "arrow.down.right"
        case "volatile": return "waveform.path"
        default:         return "arrow.right"
        }
    }

    private func directionColor(_ d: String) -> Color {
        switch d.lowercased() {
        case "rising":   return .green
        case "falling":  return .red
        case "volatile": return .orange
        default:         return .secondary
        }
    }

    private func confidenceColor(_ c: Int) -> Color {
        switch c {
        case 80...: return .green
        case 60..<80: return .blue
        case 40..<60: return .orange
        default: return .red
        }
    }
}

private struct FlowChips: View {
    let items: [String]
    let tint: Color

    var body: some View {
        // Simple wrapping HStack via LazyVGrid
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 6)], alignment: .leading, spacing: 6) {
            ForEach(items, id: \.self) { item in
                Text(item.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption2)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(tint.opacity(0.15))
                    .foregroundStyle(tint)
                    .clipShape(Capsule())
            }
        }
    }
}

// MARK: - Preview
#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: CardItem.self, CardSaleRecord.self, configurations: config)
    let card = PreviewSampleCards.makeSampleCards()[1]
    container.mainContext.insert(card)
    return CardDetailView(card: card)
        .modelContainer(container)
}
