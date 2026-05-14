import SwiftUI
import UIKit

struct AddCardFlow: View {
    @Environment(\.dismiss) var dismiss
    @State private var mode: AddCardMode = .search
    @State private var quickForm = QuickAddFormModel()
    @State private var fullForm = FullAddFormModel()
    @State private var searchForm = SearchAddFormModel()
    @State private var frontPhotoPreview: UIImage? = nil
    @State private var backPhotoPreview: UIImage? = nil
    @State private var frontPhotoUrl: String? = nil
    @State private var backPhotoUrl: String? = nil
    @State private var photoTarget: CardPhotoSide? = nil
    @State private var photoPickerSource: UIImagePickerController.SourceType = .photoLibrary
    @State private var showPhotoSourceDialog = false
    @State private var showPhotoPicker = false
    @State private var isUploadingPhoto = false
    @State private var photoUploadError: String? = nil

    var onAdd: (PortfolioHolding) -> Void
    var existingHoldings: [PortfolioHolding] = []
    var isAuthenticated: Bool = true

    private enum CardPhotoSide {
        case front
        case back
    }

    private var sessionId: String? {
        let sid = UserDefaults.standard.string(forKey: "auth.sessionId")
        return (sid?.isEmpty == false) ? sid : nil
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Auth warning banner
                if !isAuthenticated {
                    HStack(spacing: 8) {
                        Image(systemName: "lock.fill")
                            .foregroundColor(.orange)
                        Text("Sign in to save cards to your collection.")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity)
                    .background(Color.orange.opacity(0.12))
                }

                Picker("Mode", selection: $mode) {
                    ForEach(AddCardMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .padding()

                cardPhotoSection

                Divider()

                if mode == .search {
                    SearchAddForm(form: $searchForm, existingHoldings: existingHoldings) { holding in
                        onAdd(enrichedHolding(holding))
                        dismiss()
                    }
                } else if mode == .quick {
                    QuickAddForm(form: $quickForm) { holding in
                        onAdd(enrichedHolding(holding))
                        dismiss()
                    }
                } else {
                    FullAddForm(form: $fullForm) { holding in
                        onAdd(enrichedHolding(holding))
                        dismiss()
                    }
                }
            }
            .navigationTitle("Add Card")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Cancel") { dismiss() }
                }
            }
            .confirmationDialog("Add Card Photo", isPresented: $showPhotoSourceDialog, titleVisibility: .visible) {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Take Photo") {
                        photoPickerSource = .camera
                        showPhotoPicker = true
                    }
                }
                Button("Choose From Library") {
                    photoPickerSource = .photoLibrary
                    showPhotoPicker = true
                }
                Button("Cancel", role: .cancel) { }
            }
            .sheet(isPresented: $showPhotoPicker) {
                HobbyIQImagePicker(sourceType: photoPickerSource) { image in
                    Task { await handlePickedImage(image) }
                }
            }
        }
    }

    private var cardPhotoSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Card Photos")
                .font(.caption)
                .foregroundColor(.secondary)
                .textCase(.uppercase)

            HStack(spacing: 12) {
                photoTile(title: "Front", image: frontPhotoPreview, remoteUrl: frontPhotoUrl) {
                    photoTarget = .front
                    showPhotoSourceDialog = true
                }
                photoTile(title: "Back", image: backPhotoPreview, remoteUrl: backPhotoUrl) {
                    photoTarget = .back
                    showPhotoSourceDialog = true
                }
            }

            if isUploadingPhoto {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Uploading photo…")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            if let err = photoUploadError {
                Text(err)
                    .font(.caption)
                    .foregroundColor(.red)
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 8)
    }

    private func photoTile(title: String, image: UIImage?, remoteUrl: String?, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            VStack(spacing: 6) {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 120, height: 80)
                        .clipped()
                        .cornerRadius(8)
                } else {
                    ZStack {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.gray.opacity(0.12))
                        Image(systemName: "camera.fill")
                            .foregroundColor(.secondary)
                    }
                    .frame(width: 120, height: 80)
                }

                Text(remoteUrl == nil ? "Add \(title)" : "Replace \(title)")
                    .font(.caption2)
                    .foregroundColor(.blue)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    private func handlePickedImage(_ image: UIImage?) async {
        guard let image, let target = photoTarget else { return }
        photoUploadError = nil

        if target == .front {
            frontPhotoPreview = image
        } else {
            backPhotoPreview = image
        }

        guard let sid = sessionId else {
            photoUploadError = "Please sign in before uploading photos."
            return
        }
        guard let data = image.jpegData(compressionQuality: 0.82) else {
            photoUploadError = "Could not process selected image."
            return
        }

        isUploadingPhoto = true
        defer { isUploadingPhoto = false }

        do {
            let payload = data.base64EncodedString()
            let resp = try await APIService.shared.uploadCardPhoto(
                sessionId: sid,
                imageBase64: payload,
                side: target == .front ? "front" : "back"
            )
            if resp.success, let url = resp.url {
                if target == .front {
                    frontPhotoUrl = url
                } else {
                    backPhotoUrl = url
                }
            } else {
                photoUploadError = resp.error ?? "Photo upload failed."
            }
        } catch {
            photoUploadError = "Photo upload failed: \(error.localizedDescription)"
        }
    }

    private func enrichedHolding(_ holding: PortfolioHolding) -> PortfolioHolding {
        var copy = holding
        copy.imageFrontUrl = frontPhotoUrl
        copy.imageBackUrl = backPhotoUrl
        return copy
    }
}

private struct HobbyIQImagePicker: UIViewControllerRepresentable {
    let sourceType: UIImagePickerController.SourceType
    let onImagePicked: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = sourceType
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) { }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let parent: HobbyIQImagePicker

        init(_ parent: HobbyIQImagePicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
            let image = info[.originalImage] as? UIImage
            parent.onImagePicked(image)
            picker.dismiss(animated: true)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onImagePicked(nil)
            picker.dismiss(animated: true)
        }
    }
}

enum AddCardMode: String, CaseIterable {
    case search = "Search"
    case quick = "Quick Add"
    case full = "Full Add"
}

// MARK: - Quick Add
struct QuickAddFormModel {
    var playerName: String = ""
    var cardYear: String = ""
    var brand: String = ""
    var product: String = ""
    var parallel: String = ""
    var grade: String = "Raw"
    var gradingCompany: String = ""
    var purchasePrice: String = ""
    var quantity: String = "1"
    var purchaseDate: Date = Date()
    var notes: String = ""
}

struct QuickAddForm: View {
    @Binding var form: QuickAddFormModel
    var onSave: (PortfolioHolding) -> Void

    var body: some View {
        Form {
            Section(header: Text("Card Info")) {
                TextField("Player Name", text: $form.playerName)
                TextField("Year", text: $form.cardYear)
                    .keyboardType(.numberPad)
                TextField("Brand", text: $form.brand)
                TextField("Product", text: $form.product)
                TextField("Parallel", text: $form.parallel)
                TextField("Grade", text: $form.grade)
                TextField("Grading Company", text: $form.gradingCompany)
            }

            Section(header: Text("Purchase Info")) {
                TextField("Purchase Price", text: $form.purchasePrice)
                    .keyboardType(.decimalPad)
                TextField("Quantity", text: $form.quantity)
                    .keyboardType(.numberPad)
                DatePicker("Purchase Date", selection: $form.purchaseDate, displayedComponents: .date)
                TextField("Notes", text: $form.notes)
            }

            Button("Save") {
                guard let year = Int(form.cardYear),
                      let price = Double(form.purchasePrice),
                      let qty = Int(form.quantity) else { return }

                let holding = PortfolioHolding(
                    id: UUID(),
                    playerName: form.playerName,
                    cardTitle: "\(form.cardYear) \(form.brand) \(form.product) \(form.parallel) \(form.grade)",
                    cardYear: year,
                    brand: form.brand,
                    setName: form.product,
                    product: form.product,
                    sport: nil,
                    cardNumber: nil,
                    parallel: form.parallel.isEmpty ? nil : form.parallel,
                    serialNumber: nil,
                    printRun: nil,
                    isAuto: false,
                    isPatch: false,
                    isRookie: false,
                    variation: nil,
                    bowmanFirst: false,
                    grade: form.grade,
                    gradingCompany: form.gradingCompany,
                    certNumber: nil,
                    subgrades: nil,
                    gradingCost: nil,
                    dateGraded: nil,
                    conditionNotes: nil,
                    conditionEstimate: nil,
                    quantity: qty,
                    purchasePrice: price,
                    totalCostBasis: price * Double(qty),
                    purchaseDate: form.purchaseDate,
                    purchaseSource: nil,
                    storageLocation: nil,
                    feesPaid: 0,
                    taxPaid: 0,
                    shippingPaid: 0,
                    cardStatus: .owned,
                    listingUrl: nil,
                    listingPrice: nil,
                    suggestedListPrice: nil,
                    currentValue: price,
                    quickSaleValue: nil,
                    fairMarketValue: nil,
                    premiumValue: nil,
                    netEstimatedValue: nil,
                    forecast: nil,
                    totalProfitLoss: 0,
                    totalProfitLossPct: 0,
                    verdict: "",
                    recommendation: "Hold",
                    trend: .stable,
                    riskLevel: .medium,
                    marketSpeed: "",
                    marketPressure: "",
                    expectedDaysToSell: nil,
                    confidence: nil,
                    compsUsed: nil,
                    parallelDetected: nil,
                    explanationBullets: [],
                    freshnessStatus: .live,
                    lastUpdated: Date(),
                    statusCategory: .normal,
                    tags: [],
                    notes: form.notes.isEmpty ? nil : form.notes,
                    imageFrontUrl: nil,
                    imageBackUrl: nil
                )
                onSave(holding)
            }
        }
    }
}

// MARK: - Search Add  (3-step wizard: Player Search → Card Details → Verify & Purchase)
struct SearchAddFormModel {
    // Step
    var step: Int = 1
    // Step 1 — Player
    var searchQuery: String = ""
    var playerName: String = ""
    var playerSuggestions: [DailyWatchSuggestion] = []
    var isFetchingSuggestions: Bool = false
    // Step 2 — Card Details
    var cardYear: String = ""
    var product: String = ""
    var parallel: String = ""
    var isAuto: Bool = false
    var isRookie: Bool = false
    var isPatch: Bool = false
    var isGraded: Bool = false
    var gradingCompany: String = "PSA"
    var gradeValue: String = "10"
    // Step 3 — Verify + Purchase
    var searchResult: CardEstimateResponse? = nil
    var isSearching: Bool = false
    var searchError: String? = nil
    var purchasePrice: String = ""
    var quantity: String = "1"
    var purchaseDate: Date = Date()
    var notes: String = ""
}

private let psaGrades  = ["10", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"]
private let bgsGrades  = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3.5", "3", "2.5", "2", "1.5", "1"]
private let sgcGrades  = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5.5", "5", "4.5", "4", "3", "2", "1"]
private let cgcGrades  = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6.5", "6", "5", "4", "3", "2", "1"]
private let gradingCompanies = ["PSA", "BGS", "SGC", "CGC"]

private func gradesFor(_ company: String) -> [String] {
    switch company {
    case "BGS": return bgsGrades
    case "SGC": return sgcGrades
    case "CGC": return cgcGrades
    default:    return psaGrades
    }
}

private let popularSets = [
    "Bowman Chrome", "Bowman Draft", "Bowman Platinum",
    "Topps Chrome", "Topps Update", "Topps Heritage",
    "Prizm", "Select", "Optic", "Mosaic",
    "National Treasures", "Immaculate", "Finest",
    "Stadium Club", "Contenders"
]

private let refractorParallels = [
    "Base", "Refractor", "Gold Refractor", "Blue Refractor",
    "Green Refractor", "Orange Refractor", "Red Refractor",
    "Superfractor", "1st Edition", "Gold Vinyl"
]
private let prizmParallels = [
    "Base", "Silver Prizm", "Gold Prizm", "Blue Prizm",
    "Red Prizm", "Green Prizm", "Purple Prizm", "Orange Prizm", "Black Prizm"
]
private let genericParallels = [
    "Base", "Gold", "Silver", "Blue", "Red", "Green", "Purple", "Orange", "Black"
]

private func parallelsFor(_ product: String) -> [String] {
    let p = product.lowercased()
    if p.contains("prizm") || p.contains("optic") || p.contains("select") || p.contains("mosaic") {
        return prizmParallels
    }
    if p.contains("bowman") || p.contains("chrome") || p.contains("finest") {
        return refractorParallels
    }
    return genericParallels
}

struct SearchAddForm: View {
    @Binding var form: SearchAddFormModel
    var onSave: (PortfolioHolding) -> Void
    var existingHoldings: [PortfolioHolding] = []
    @State private var suggestionTask: Task<Void, Never>? = nil

    // MARK: - Computed
    private var gradeDisplay: String {
        form.isGraded ? "\(form.gradingCompany) \(form.gradeValue)" : "Raw"
    }
    private var resolvedParallel: String {
        let p = form.parallel.trimmingCharacters(in: .whitespaces)
        return (p == "Base") ? "" : p
    }
    private var canProceedToStep2: Bool {
        !form.playerName.trimmingCharacters(in: .whitespaces).isEmpty
    }
    private var canProceedToStep3: Bool {
        !form.cardYear.isEmpty && !form.product.isEmpty
    }
    private var canAdd: Bool {
        form.searchResult != nil && Double(form.purchasePrice) != nil
    }
    private var isDuplicate: Bool {
        let year = Int(form.cardYear) ?? 0
        let player = form.playerName.trimmingCharacters(in: .whitespaces).lowercased()
        let product = form.product.trimmingCharacters(in: .whitespaces).lowercased()
        return existingHoldings.contains { h in
            h.playerName.lowercased() == player &&
            h.cardYear == year &&
            (h.product ?? "").lowercased() == product &&
            h.grade.lowercased() == gradeDisplay.lowercased()
        }
    }

    // MARK: - Body
    var body: some View {
        VStack(spacing: 0) {
            stepProgressHeader
            ScrollView {
                VStack(spacing: 0) {
                    switch form.step {
                    case 1:  step1PlayerSearch
                    case 2:  step2CardDetails
                    default: step3VerifyPurchase
                    }
                }
            }
        }
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Step Progress Header
    private var stepProgressHeader: some View {
        VStack(spacing: 8) {
            HStack(spacing: 0) {
                ForEach([1, 2, 3], id: \.self) { i in
                    HStack(spacing: 0) {
                        ZStack {
                            Circle()
                                .fill(i <= form.step ? Color.accentColor : Color(.systemGray4))
                                .frame(width: 28, height: 28)
                            if i < form.step {
                                Image(systemName: "checkmark")
                                    .font(.caption.weight(.bold))
                                    .foregroundColor(.white)
                            } else {
                                Text("\(i)")
                                    .font(.caption.weight(.bold))
                                    .foregroundColor(i <= form.step ? .white : .secondary)
                            }
                        }
                        if i < 3 {
                            Rectangle()
                                .fill(i < form.step ? Color.accentColor : Color(.systemGray4))
                                .frame(height: 2)
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            .padding(.horizontal, 32)
            Text([1: "Search Player", 2: "Card Details", 3: "Verify & Purchase"][form.step] ?? "")
                .font(.subheadline.weight(.semibold))
        }
        .padding(.top, 16)
        .padding(.bottom, 12)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Step 1: Player Search
    private var step1PlayerSearch: some View {
        VStack(spacing: 16) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.secondary)
                        TextField("Search player name…", text: $form.searchQuery)
                            .autocorrectionDisabled()
                            .submitLabel(.search)
                            .onChange(of: form.searchQuery) { newValue in
                                fetchSuggestions(query: newValue)
                            }
                            .onSubmit {
                                if form.playerSuggestions.isEmpty && !form.searchQuery.isEmpty {
                                    selectPlayer(name: form.searchQuery)
                                }
                            }
                        if !form.searchQuery.isEmpty {
                            Button {
                                form.searchQuery = ""
                                form.playerName = ""
                                form.playerSuggestions = []
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                        }
                        if form.isFetchingSuggestions {
                            ProgressView().scaleEffect(0.75)
                        }
                    }
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                    // Suggestions dropdown
                    if !form.playerSuggestions.isEmpty {
                        VStack(spacing: 0) {
                            ForEach(form.playerSuggestions) { suggestion in
                                Button { selectPlayer(name: suggestion.playerName) } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "person.fill")
                                            .foregroundColor(.accentColor)
                                            .frame(width: 20)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(suggestion.playerName)
                                                .font(.subheadline.weight(.medium))
                                                .foregroundColor(.primary)
                                            if let team = suggestion.team {
                                                Text(team + (suggestion.league.map { " · \($0)" } ?? ""))
                                                    .font(.caption)
                                                    .foregroundColor(.secondary)
                                            }
                                        }
                                        Spacer()
                                        Image(systemName: "arrow.right")
                                            .font(.caption2)
                                            .foregroundColor(.secondary)
                                    }
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 10)
                                }
                                if suggestion.id != form.playerSuggestions.last?.id {
                                    Divider().padding(.leading, 44)
                                }
                            }
                        }
                        .background(Color(.secondarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .shadow(color: .black.opacity(0.1), radius: 8, y: 4)
                    }
                }
                .padding(.horizontal)
                .padding(.top, 16)

                // Selected player confirmation chip
                if !form.playerName.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                        Text(form.playerName)
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Button {
                            form.playerName = ""
                            form.searchQuery = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundColor(.secondary)
                        }
                    }
                    .padding(12)
                    .background(Color.green.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)
                }

                Spacer(minLength: 32)

                // Next button
                Button { withAnimation { form.step = 2 } } label: {
                    Text("Next: Card Details")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(canProceedToStep2 ? Color.accentColor : Color(.systemGray4))
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(!canProceedToStep2)
                .padding(.horizontal)
                .padding(.bottom, 32)
            }
            .padding(.top, 8)
        }
    }

    // MARK: - Step 2: Card Details
    private var step2CardDetails: some View {
        VStack(spacing: 0) {
            // Player header (read-only)
            HStack(spacing: 10) {
                Image(systemName: "person.circle.fill")
                    .foregroundColor(.accentColor)
                    .font(.title3)
                Text(form.playerName)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button("Change") { withAnimation { form.step = 1 } }
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.accentColor)
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            .padding(.top, 8)
            .padding(.bottom, 20)

            // Year
            sectionLabel("YEAR")
            TextField("e.g. 2024", text: $form.cardYear)
                .keyboardType(.numberPad)
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)
                .padding(.bottom, 20)

            // Set / Product chips + custom field
            sectionLabel("SET / PRODUCT")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(popularSets, id: \.self) { set in
                        chipButton(label: set, selected: form.product == set) {
                            form.product = (form.product == set) ? "" : set
                            form.parallel = ""
                        }
                    }
                }
                .padding(.horizontal)
            }
            .padding(.bottom, 8)
            TextField("Or type a set name…", text: $form.product)
                .autocorrectionDisabled()
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)
                .padding(.bottom, 20)

            // Parallel chips + custom field
            if !form.product.isEmpty {
                sectionLabel("PARALLEL")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(parallelsFor(form.product), id: \.self) { par in
                            chipButton(label: par, selected: form.parallel == par) {
                                form.parallel = (form.parallel == par) ? "" : par
                            }
                        }
                    }
                    .padding(.horizontal)
                }
                .padding(.bottom, 8)
                TextField("Or type parallel…", text: $form.parallel)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)
                    .padding(.bottom, 20)
            }

            // Attributes
            sectionLabel("ATTRIBUTES")
            HStack(spacing: 10) {
                attributeToggle(label: "Auto", icon: "pencil", active: form.isAuto) { form.isAuto.toggle() }
                attributeToggle(label: "Rookie", icon: "star", active: form.isRookie) { form.isRookie.toggle() }
                attributeToggle(label: "Patch", icon: "rectangle.badge.checkmark", active: form.isPatch) { form.isPatch.toggle() }
            }
            .padding(.horizontal)
            .padding(.bottom, 20)

            // Condition
            sectionLabel("CONDITION")
            HStack(spacing: 0) {
                conditionPill(label: "Raw",    selected: !form.isGraded) { form.isGraded = false }
                conditionPill(label: "Graded", selected:  form.isGraded) { form.isGraded = true  }
            }
            .background(Color(.systemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
            if form.isGraded {
                HStack(spacing: 8) {
                    ForEach(gradingCompanies, id: \.self) { co in
                        Button {
                            form.gradingCompany = co
                            if !gradesFor(co).contains(form.gradeValue) { form.gradeValue = gradesFor(co).first ?? "10" }
                        } label: {
                            Text(co)
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(form.gradingCompany == co ? Color.accentColor : Color(.secondarySystemGroupedBackground))
                                .foregroundColor(form.gradingCompany == co ? .white : .primary)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.top, 10)
                Picker("Grade", selection: $form.gradeValue) {
                    ForEach(gradesFor(form.gradingCompany), id: \.self) { g in Text(g).tag(g) }
                }
                .pickerStyle(.wheel)
                .frame(height: 120)
                .clipped()
                .padding(.horizontal)
            }

            Spacer().frame(height: 28)

            // Navigation
            HStack(spacing: 12) {
                Button { withAnimation { form.step = 1 } } label: {
                    Text("Back")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(Color(.secondarySystemGroupedBackground))
                        .foregroundColor(.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                Button {
                    withAnimation { form.step = 3 }
                    runSearch()
                } label: {
                    Text("Search & Price")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(canProceedToStep3 ? Color.accentColor : Color(.systemGray4))
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(!canProceedToStep3)
            }
            .padding(.horizontal)
            .padding(.bottom, 32)
        }
    }

    // MARK: - Step 3: Verify & Purchase
    private var step3VerifyPurchase: some View {
        VStack(spacing: 0) {
            // Card identity summary (read-only)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(form.playerName)
                            .font(.title3.weight(.bold))
                        HStack(spacing: 4) {
                            if !form.cardYear.isEmpty {
                                Text(form.cardYear).font(.subheadline).foregroundColor(.secondary)
                            }
                            if !form.product.isEmpty {
                                Text("·").foregroundColor(.secondary)
                                Text(form.product).font(.subheadline).foregroundColor(.secondary)
                            }
                        }
                        HStack(spacing: 6) {
                            if !resolvedParallel.isEmpty {
                                tagBadge(resolvedParallel, color: .purple)
                            }
                            if form.isAuto   { tagBadge("Auto",   color: .blue)   }
                            if form.isRookie { tagBadge("RC",     color: .orange)  }
                            if form.isPatch  { tagBadge("Patch",  color: .green)   }
                            tagBadge(gradeDisplay, color: .secondary)
                        }
                    }
                    Spacer()
                    Button("Edit") { withAnimation { form.step = 2 } }
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.accentColor)
                }
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal)
            .padding(.top, 8)
            .padding(.bottom, 16)

            // Pricing area
            if form.isSearching {
                VStack(spacing: 10) {
                    ProgressView()
                    Text("Searching recent sales…")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
            } else if let result = form.searchResult {
                VStack(spacing: 12) {
                    // Price tiles
                    HStack(spacing: 0) {
                        PriceTile(label: "Fair Market", value: result.fairMarketValue, accent: .blue)
                        Divider().frame(height: 48)
                        PriceTile(label: "Quick Sale",  value: result.quickSaleValue,  accent: .orange)
                        Divider().frame(height: 48)
                        PriceTile(label: "Premium",     value: result.premiumValue,     accent: .purple)
                    }
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                    // Comps + verdict row
                    HStack {
                        if let comps = result.pricingAnalytics?.compsUsed, comps > 0 {
                            Label("\(comps) recent sales", systemImage: "chart.bar.fill")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        if let verdict = result.verdict, !verdict.isEmpty {
                            Text(verdict)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(verdictColor(verdict).opacity(0.15))
                                .foregroundColor(verdictColor(verdict))
                                .clipShape(Capsule())
                        }
                    }
                    // Trend + refresh row
                    HStack {
                        if let trend = result.marketDNA?.trend, !trend.isEmpty {
                            Label(trend.capitalized, systemImage: trendIcon(trend))
                                .font(.caption.weight(.medium))
                                .foregroundColor(.secondary)
                        }
                        Spacer()
                        Button { runSearch() } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                                .font(.caption.weight(.semibold))
                                .foregroundColor(.accentColor)
                        }
                    }

                    // Recent comps list — always shown when backend provides
                    // them. Especially valuable when FMV is nil (insufficient
                    // / variant-mismatch) because the user still gets a clear
                    // picture of what the market has on file.
                    if let comps = result.recentComps, !comps.isEmpty {
                        let insufficient = result.fairMarketValue == nil
                        RecentCompsListView(
                            comps: comps,
                            title: insufficient ? "Recent Sales on File" : "Comps Used",
                            subtitle: insufficient
                                ? "Not enough recent data to compute a price — here's every comp Card Hedge has."
                                : nil
                        )
                        .padding(.top, 8)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 16)
            } else if let err = form.searchError {
                VStack(spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Could not fetch pricing")
                                .font(.subheadline.weight(.semibold))
                            Text(err).font(.caption).foregroundColor(.secondary)
                        }
                        Spacer()
                    }
                    .padding(12)
                    .background(Color.orange.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    Button(action: runSearch) {
                        Label("Try Again", systemImage: "arrow.clockwise")
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundColor(.accentColor)
                }
                .padding(.horizontal)
                .padding(.bottom, 16)
            }

            Divider()

            // Purchase details
            VStack(alignment: .leading, spacing: 12) {
                Text("PURCHASE DETAILS")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)

                HStack(spacing: 10) {
                    HStack {
                        Text("$").foregroundColor(.secondary)
                        TextField("Purchase Price", text: $form.purchasePrice)
                            .keyboardType(.decimalPad)
                    }
                    .padding(10)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                    HStack {
                        Text("Qty").foregroundColor(.secondary).font(.subheadline)
                        TextField("1", text: $form.quantity)
                            .keyboardType(.numberPad)
                            .frame(width: 40)
                    }
                    .padding(10)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                DatePicker("Date Purchased", selection: $form.purchaseDate, displayedComponents: .date)
                    .font(.subheadline)

                TextField("Notes (optional)", text: $form.notes, axis: .vertical)
                    .lineLimit(2...4)
                    .padding(10)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .font(.subheadline)
            }
            .padding(.horizontal)
            .padding(.vertical, 14)

            if isDuplicate {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
                    Text("This card is already in your collection.")
                        .font(.caption).foregroundColor(.orange)
                }
                .padding(.horizontal)
                .padding(.bottom, 4)
            }

            // Action row
            HStack(spacing: 12) {
                Button { withAnimation { form.step = 2 } } label: {
                    Text("Back")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: 80)
                        .padding(.vertical, 13)
                        .background(Color(.secondarySystemGroupedBackground))
                        .foregroundColor(.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                Button(action: saveCard) {
                    Text("Add to Collection")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(canAdd ? Color.accentColor : Color(.systemGray4))
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(!canAdd)
            }
            .padding(.horizontal)
            .padding(.bottom, 32)
        }
    }

    // MARK: - Sub-views
    @ViewBuilder
    private func tagBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15))
            .foregroundColor(color)
            .clipShape(Capsule())
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundColor(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.bottom, 6)
    }

    @ViewBuilder
    private func chipButton(label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(selected ? Color.accentColor : Color(.secondarySystemGroupedBackground))
                .foregroundColor(selected ? .white : .primary)
                .clipShape(Capsule())
        }
    }

    @ViewBuilder
    private func attributeToggle(label: String, icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: active ? "\(icon).fill" : icon)
                    .font(.subheadline)
                Text(label)
                    .font(.caption.weight(.medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(active ? Color.accentColor.opacity(0.12) : Color(.secondarySystemGroupedBackground))
            .foregroundColor(active ? Color.accentColor : .secondary)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(active ? Color.accentColor : Color.clear, lineWidth: 1.5))
        }
    }

    @ViewBuilder
    private func conditionPill(label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(selected ? Color.accentColor : Color.clear)
                .foregroundColor(selected ? .white : .secondary)
                .clipShape(RoundedRectangle(cornerRadius: 9))
        }
        .padding(3)
    }

    // MARK: - Actions
    private func selectPlayer(name: String) {
        form.playerName = name
        form.searchQuery = name
        form.playerSuggestions = []
        form.isFetchingSuggestions = false
    }

    private func fetchSuggestions(query: String) {
        suggestionTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            form.playerSuggestions = []
            return
        }
        form.isFetchingSuggestions = true
        suggestionTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            defer { form.isFetchingSuggestions = false }
            do {
                let response = try await APIService.shared.fetchDailyWatchSuggestions(query: trimmed, limit: 6)
                guard !Task.isCancelled else { return }
                form.playerSuggestions = response.suggestions
            } catch {
                form.playerSuggestions = []
            }
        }
    }

    private func runSearch() {
        let playerName = form.playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        let product    = form.product.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !playerName.isEmpty, !product.isEmpty else { return }

        form.isSearching = true
        form.searchError = nil
        form.searchResult = nil

        let request = CardEstimateRequest(
            playerName: playerName,
            cardYear: Int(form.cardYear.trimmingCharacters(in: .whitespacesAndNewlines)),
            product: product,
            parallel: resolvedParallel.isEmpty ? nil : resolvedParallel,
            isAuto: form.isAuto ? true : nil,
            gradeCompany: form.isGraded ? form.gradingCompany : nil,
            gradeValue: form.isGraded ? Int(form.gradeValue) : nil
        )
        Task { @MainActor in
            defer { form.isSearching = false }
            do {
                let result = try await APIService.shared.estimateCardDirect(request: request)
                form.searchResult = result
                if form.purchasePrice.isEmpty, let qsv = result.quickSaleValue {
                    form.purchasePrice = String(format: "%.2f", qsv)
                }
            } catch {
                form.searchError = "Could not fetch pricing — check your details and try again."
            }
        }
    }

    private func saveCard() {
        guard let price = Double(form.purchasePrice) else { return }
        let playerName = form.playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        let product    = form.product.trimmingCharacters(in: .whitespacesAndNewlines)
        let quantity   = Int(form.quantity) ?? 1
        let year       = Int(form.cardYear) ?? 0
        let fmv        = form.searchResult?.fairMarketValue ?? price
        let cost       = price * Double(quantity)
        let pnl        = fmv - cost
        let pnlPct     = cost > 0 ? (pnl / cost) * 100 : 0
        let trend      = portfolioTrend(from: form.searchResult?.marketDNA?.trend)
        let cardTitle  = [form.cardYear, product, playerName,
                          resolvedParallel, form.isAuto ? "Auto" : "",
                          form.isGraded ? gradeDisplay : ""]
            .filter { !$0.isEmpty }.joined(separator: " ")

        let holding = PortfolioHolding(
            id: UUID(),
            playerName: playerName,
            cardTitle: cardTitle,
            cardYear: year,
            brand: "",
            setName: product,
            product: product,
            sport: nil,
            cardNumber: nil,
            parallel: resolvedParallel.isEmpty ? nil : resolvedParallel,
            serialNumber: nil,
            printRun: nil,
            isAuto: form.isAuto,
            isPatch: form.isPatch,
            isRookie: form.isRookie,
            variation: nil,
            bowmanFirst: false,
            grade: gradeDisplay,
            gradingCompany: form.isGraded ? form.gradingCompany : "",
            certNumber: nil,
            subgrades: nil,
            gradingCost: nil,
            dateGraded: nil,
            conditionNotes: nil,
            conditionEstimate: nil,
            quantity: quantity,
            purchasePrice: price,
            totalCostBasis: cost,
            purchaseDate: form.purchaseDate,
            purchaseSource: nil,
            storageLocation: nil,
            feesPaid: 0,
            taxPaid: 0,
            shippingPaid: 0,
            cardStatus: .owned,
            listingUrl: nil,
            listingPrice: nil,
            suggestedListPrice: form.searchResult?.suggestedListPrice,
            currentValue: fmv,
            quickSaleValue: form.searchResult?.quickSaleValue,
            fairMarketValue: fmv,
            premiumValue: form.searchResult?.premiumValue,
            netEstimatedValue: nil,
            forecast: nil,
            totalProfitLoss: pnl,
            totalProfitLossPct: pnlPct,
            verdict: form.searchResult?.verdict ?? "",
            recommendation: form.searchResult?.recommendation ?? form.searchResult?.action ?? "Hold",
            trend: trend,
            riskLevel: .medium,
            marketSpeed: form.searchResult?.marketDNA?.speed ?? "",
            marketPressure: form.searchResult?.marketDNA?.liquidity ?? "",
            expectedDaysToSell: form.searchResult?.exitStrategy?.expectedDaysToSell,
            confidence: nil,
            compsUsed: form.searchResult?.pricingAnalytics?.compsUsed,
            parallelDetected: form.searchResult?.pricingAnalytics?.parallelDetected,
            explanationBullets: form.searchResult?.explanation ?? [],
            freshnessStatus: .live,
            lastUpdated: Date(),
            statusCategory: .normal,
            tags: [],
            notes: form.notes.isEmpty ? nil : form.notes,
            imageFrontUrl: nil,
            imageBackUrl: nil
        )
        onSave(holding)
    }

    // MARK: - Helpers
    private func portfolioTrend(from rawTrend: String?) -> PortfolioTrend {
        let s = (rawTrend ?? "").lowercased()
        if s.contains("up") || s.contains("rise") || s.contains("bull") { return .rising }
        if s.contains("down") || s.contains("fall") || s.contains("bear") { return .falling }
        return .stable
    }
    private func trendIcon(_ trend: String) -> String {
        let s = trend.lowercased()
        if s.contains("up") || s.contains("rise") || s.contains("bull") { return "arrow.up.right" }
        if s.contains("down") || s.contains("fall") || s.contains("bear") { return "arrow.down.right" }
        return "minus"
    }
    private func verdictColor(_ verdict: String) -> Color {
        let s = verdict.lowercased()
        if s.contains("sell") { return .red }
        if s.contains("buy") || s.contains("hold") { return .green }
        return .orange
    }
}

private struct PriceTile: View {
    let label: String
    let value: Double?
    let accent: Color

    var body: some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.secondary)
            Text(value.map { String(format: "$%.0f", $0) } ?? "--")
                .font(.headline)
                .foregroundColor(accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

// MARK: - Card Query Parser
/// Parses a free-text card description into structured fields.
/// E.g. "2024 Bowman Chrome Dylan Crews Auto" →
///   playerName: "Dylan Crews", cardYear: 2024, product: "Bowman Chrome", isAuto: true
private func parseCardQuery(_ query: String) -> (playerName: String, cardYear: Int?, product: String?, parallel: String?, isAuto: Bool) {
    var remaining = query

    // 1. Extract isAuto
    let autoPattern = try? NSRegularExpression(pattern: "\\bauto(graph)?\\b", options: .caseInsensitive)
    var isAuto = false
    if let m = autoPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
       let r = Range(m.range, in: remaining) {
        isAuto = true
        remaining.replaceSubrange(r, with: "")
        remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    // 2. Extract year
    let yearPattern = try? NSRegularExpression(pattern: "\\b(19|20)\\d{2}\\b")
    var cardYear: Int? = nil
    if let m = yearPattern?.firstMatch(in: remaining, range: NSRange(remaining.startIndex..., in: remaining)),
       let r = Range(m.range, in: remaining) {
        cardYear = Int(remaining[r])
        remaining.replaceSubrange(r, with: "")
        remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    // 3. Extract product (longest-match first)
    let products = [
        "Bowman Chrome Draft", "Bowman Chrome", "Bowman Draft", "Bowman Platinum",
        "Topps Chrome", "Topps Series 1", "Topps Series 2", "Topps Update", "Topps Heritage",
        "Stadium Club", "Prizm Draft", "National Treasures", "Immaculate",
        "Contenders", "Select", "Optic", "Mosaic", "Certified", "Finest",
        "Gypsy Queen", "Allen & Ginter", "Topps"
    ]
    var product: String? = nil
    for p in products {
        if let r = remaining.range(of: p, options: .caseInsensitive) {
            product = p
            remaining.replaceSubrange(r, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
            break
        }
    }

    // 4. Extract parallel (longest-match first)
    let parallels = [
        "Gold Refractor", "Blue Refractor", "Orange Refractor", "Red Refractor",
        "Green Refractor", "1st Bowman", "1st Edition", "Superfractor",
        "Gold Vinyl", "Blue Wave", "Aqua",
        "Refractor", "Prizm", "Holo",
        "Gold", "Silver", "Orange", "Blue", "Green", "Red", "Purple", "Pink", "Black"
    ]
    var parallel: String? = nil
    for par in parallels {
        if let r = remaining.range(of: par, options: .caseInsensitive) {
            parallel = par
            remaining.replaceSubrange(r, with: "")
            remaining = remaining.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
            break
        }
    }

    // 5. Remaining text = player name
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

// MARK: - Full Add
struct FullAddFormModel {
    var playerName: String = ""
    var cardYear: String = ""
    var brand: String = ""
    var setName: String = ""
    var product: String = ""
    var cardNumber: String = ""
    var parallel: String = ""
    var serialNumber: String = ""
    var isAuto: Bool = false
    var isPatch: Bool = false
    var variation: String = ""
    var bowmanFirst: Bool = false
    var grade: String = "Raw"
    var gradingCompany: String = ""
    var quantity: String = "1"
    var purchasePrice: String = ""
    var totalCostBasis: String = ""
    var purchaseDate: Date = Date()
    var purchaseSource: String = ""
    var feesPaid: String = ""
    var taxPaid: String = ""
    var shippingPaid: String = ""
    var notes: String = ""
}

struct FullAddForm: View {
    @Binding var form: FullAddFormModel
    var onSave: (PortfolioHolding) -> Void
    var body: some View {
        Form {
            Section(header: Text("Card Identity")) {
                TextField("Player Name", text: $form.playerName)
                TextField("Year", text: $form.cardYear)
                    .keyboardType(.numberPad)
                TextField("Brand", text: $form.brand)
                TextField("Set/Product", text: $form.setName)
                TextField("Card Number", text: $form.cardNumber)
                TextField("Parallel", text: $form.parallel)
                TextField("Serial Number", text: $form.serialNumber)
                Toggle("Auto", isOn: $form.isAuto)
                Toggle("Patch", isOn: $form.isPatch)
                TextField("Variation", text: $form.variation)
                Toggle("Bowman 1st", isOn: $form.bowmanFirst)
            }
            Section(header: Text("Grade")) {
                TextField("Grade", text: $form.grade)
                TextField("Grading Company", text: $form.gradingCompany)
            }
            Section(header: Text("Ownership")) {
                TextField("Quantity", text: $form.quantity)
                    .keyboardType(.numberPad)
                TextField("Purchase Price", text: $form.purchasePrice)
                    .keyboardType(.decimalPad)
                TextField("Total Cost Basis", text: $form.totalCostBasis)
                    .keyboardType(.decimalPad)
                DatePicker("Purchase Date", selection: $form.purchaseDate, displayedComponents: .date)
                TextField("Purchase Source", text: $form.purchaseSource)
                TextField("Fees Paid", text: $form.feesPaid)
                    .keyboardType(.decimalPad)
                TextField("Tax Paid", text: $form.taxPaid)
                    .keyboardType(.decimalPad)
                TextField("Shipping Paid", text: $form.shippingPaid)
                    .keyboardType(.decimalPad)
                TextField("Notes", text: $form.notes)
            }
            Button("Save") {
                guard let year = Int(form.cardYear),
                      let price = Double(form.purchasePrice),
                      let qty = Int(form.quantity) else { return }
                let holding = PortfolioHolding(
                    id: UUID(),
                    playerName: form.playerName,
                    cardTitle: "\(form.cardYear) \(form.brand) \(form.setName) \(form.parallel) \(form.grade)",
                    cardYear: year,
                    brand: form.brand,
                    setName: form.setName,
                    product: form.product,
                    sport: nil,
                    cardNumber: form.cardNumber,
                    parallel: form.parallel,
                    serialNumber: form.serialNumber,
                    printRun: nil,
                    isAuto: form.isAuto,
                    isPatch: form.isPatch,
                    isRookie: false,
                    variation: form.variation,
                    bowmanFirst: form.bowmanFirst,
                    grade: form.grade,
                    gradingCompany: form.gradingCompany,
                    certNumber: nil,
                    subgrades: nil,
                    gradingCost: nil,
                    dateGraded: nil,
                    conditionNotes: nil,
                    conditionEstimate: nil,
                    quantity: qty,
                    purchasePrice: price,
                    totalCostBasis: Double(form.totalCostBasis) ?? price * Double(qty),
                    purchaseDate: form.purchaseDate,
                    purchaseSource: form.purchaseSource,
                    storageLocation: nil,
                    feesPaid: Double(form.feesPaid) ?? 0,
                    taxPaid: Double(form.taxPaid) ?? 0,
                    shippingPaid: Double(form.shippingPaid) ?? 0,
                    cardStatus: .owned,
                    listingUrl: nil,
                    listingPrice: nil,
                    suggestedListPrice: nil,
                    currentValue: price,
                    quickSaleValue: nil,
                    fairMarketValue: nil,
                    premiumValue: nil,
                    netEstimatedValue: nil,
                    forecast: nil,
                    totalProfitLoss: 0,
                    totalProfitLossPct: 0,
                    verdict: "",
                    recommendation: "Hold",
                    trend: .stable,
                    riskLevel: .medium,
                    marketSpeed: "",
                    marketPressure: "",
                    expectedDaysToSell: nil,
                    confidence: nil,
                    compsUsed: nil,
                    parallelDetected: nil,
                    explanationBullets: [],
                    freshnessStatus: .live,
                    lastUpdated: Date(),
                    statusCategory: .normal,
                    tags: [],
                    notes: form.notes.isEmpty ? nil : form.notes,
                    imageFrontUrl: nil,
                    imageBackUrl: nil
                )
                onSave(holding)
            }
        }
    }
}
