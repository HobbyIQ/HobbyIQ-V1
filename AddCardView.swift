// AddCardView.swift
// PortfolioIQ — form for adding a real card to local storage.
// Saves directly to SwiftData ModelContext.
// Mock data is NEVER injected here.

import SwiftUI
import SwiftData

struct AddCardView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    // Callback so parent can react (e.g. navigate to new card)
    var onSaved: ((CardItem) -> Void)? = nil

    // MARK: - Required fields
    @State private var playerName: String = ""
    @State private var isRaw: Bool = true

    // MARK: - Optional card details
    @State private var cardTitle: String = ""
    @State private var yearText: String = ""
    @State private var setName: String = ""
    @State private var cardNumber: String = ""
    @State private var parallel: String = ""
    @State private var serialNumber: String = ""
    @State private var isAuto: Bool = false

    // MARK: - Grading (shown only when !isRaw)
    @State private var gradingCompany: String = "PSA"
    @State private var grade: String = ""
    @State private var certNumber: String = ""

    // MARK: - Financial
    @State private var purchasePriceText: String = ""

    // MARK: - Status & Notes
    @State private var selectedStatus: CardStatus = .owned
    @State private var notes: String = ""

    // MARK: - UI State
    @State private var showAdvanced: Bool = false
    @State private var showValidationError: Bool = false

    private let gradingCompanies = ["PSA", "BGS", "SGC", "CGC", "TAG", "CSG", "Other"]

    var body: some View {
        NavigationStack {
            Form {
                requiredSection
                cardDetailsSection
                if !isRaw { gradingSection }
                financialSection
                statusNotesSection
                advancedToggleSection
            }
            .navigationTitle("Add Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save Card") { saveCard() }
                        .fontWeight(.semibold)
                        .disabled(playerName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .alert("Missing required field", isPresented: $showValidationError) {
                Button("OK") {}
            } message: {
                Text("Please enter a player name or card title.")
            }
        }
    }

    // MARK: - Sections

    private var requiredSection: some View {
        Section {
            TextField("Player name or card title", text: $playerName)
                .textContentType(.name)

            Toggle(isOn: $isRaw) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(isRaw ? "Raw card" : "Graded card")
                        .fontWeight(.medium)
                    Text(isRaw ? "Ungraded / in sleeve or binder" : "Professionally graded in a slab")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tint(.blue)
        } header: {
            Text("Required")
        }
    }

    private var cardDetailsSection: some View {
        Section {
            TextField("Card title (optional, e.g. 2024 Bowman Chrome Auto)", text: $cardTitle)
            TextField("Year", text: $yearText)
                .keyboardType(.numberPad)
            TextField("Set name", text: $setName)
            TextField("Card number", text: $cardNumber)
            TextField("Parallel (e.g. Refractor, Silver)", text: $parallel)
            TextField("Serial number (e.g. 47/99)", text: $serialNumber)

            Toggle(isOn: $isAuto) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Autograph")
                        .fontWeight(.medium)
                    Text(isAuto ? "Signed card" : "Not an autograph")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .tint(.blue)

        } header: {
            Text("Card Details")
        } footer: {
            Text("All fields are optional.")
                .font(.caption)
        }
    }

    private var gradingSection: some View {
        Section {
            Picker("Grading company", selection: $gradingCompany) {
                ForEach(gradingCompanies, id: \.self) { Text($0) }
            }
            TextField("Grade (e.g. 10, 9.5, 9)", text: $grade)
                .keyboardType(.decimalPad)
            TextField("Cert number", text: $certNumber)
                .keyboardType(.numberPad)
        } header: {
            Text("Grading Info")
        }
    }

    private var financialSection: some View {
        Section {
            HStack {
                Text("$").foregroundStyle(.secondary)
                TextField("Purchase price", text: $purchasePriceText)
                    .keyboardType(.decimalPad)
            }
        } header: {
            Text("Price")
        } footer: {
            Text("CompIQ will automatically fetch the predicted market value when you save.")
                .font(.caption2)
        }
    }

    private var statusNotesSection: some View {
        Section {
            Picker("Status", selection: $selectedStatus) {
                ForEach([CardStatus.owned, .listed, .grading, .consigned, .archived], id: \.self) { s in
                    Label(s.rawValue, systemImage: s.icon).tag(s)
                }
            }
            TextField("Notes", text: $notes, axis: .vertical)
                .lineLimit(3, reservesSpace: true)
        } header: {
            Text("Status & Notes")
        }
    }

    private var advancedToggleSection: some View {
        Section {
            Button {
                withAnimation { showAdvanced.toggle() }
            } label: {
                Label(showAdvanced ? "Hide advanced fields" : "Show advanced fields",
                      systemImage: showAdvanced ? "chevron.up" : "chevron.down")
                    .foregroundStyle(.blue)
                    .font(.subheadline)
            }
        }
    }

    // MARK: - Save

    private func saveCard() {
        let name = playerName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { showValidationError = true; return }

        let purchasePrice = Double(purchasePriceText) ?? 0
        let year          = Int(yearText)

        let card = CardItem(
            playerName: name,
            isRaw: isRaw,
            cardTitle: cardTitle.trimmingCharacters(in: .whitespaces),
            year: year,
            setName: setName.trimmingCharacters(in: .whitespaces),
            cardNumber: cardNumber.trimmingCharacters(in: .whitespaces),
            parallel: parallel.trimmingCharacters(in: .whitespaces),
            serialNumber: serialNumber.trimmingCharacters(in: .whitespaces),
            isAuto: isAuto,
            gradingCompany: isRaw ? "" : gradingCompany,
            grade: isRaw ? "" : grade.trimmingCharacters(in: .whitespaces),
            certNumber: isRaw ? "" : certNumber.trimmingCharacters(in: .whitespaces),
            purchasePrice: purchasePrice,
            currentValue: purchasePrice,
            status: selectedStatus.rawValue,
            notes: notes.trimmingCharacters(in: .whitespaces)
        )

        context.insert(card)
        onSaved?(card)
        dismiss()

        // Auto-fetch CompIQ market value in the background.
        // Card is already persisted — the Task writes currentValue directly
        // and SwiftData propagates the update live to all views.
        let playerNameCopy   = name
        let yearCopy         = year
        let setNameCopy      = setName.trimmingCharacters(in: .whitespaces)
        let cardNumberCopy   = cardNumber.trimmingCharacters(in: .whitespaces)
        let parallelCopy     = parallel.trimmingCharacters(in: .whitespaces)
        let isAutoCopy       = isAuto
        let isRawCopy        = isRaw
        let gradingComp      = isRaw ? "" : gradingCompany
        let gradeCopy        = isRaw ? "" : grade.trimmingCharacters(in: .whitespaces)

        Task { @MainActor in
            do {
                let result = try await CompIQService.fetchMarketValue(
                    playerName: playerNameCopy,
                    year: yearCopy,
                    setName: setNameCopy,
                    cardNumber: cardNumberCopy,
                    parallel: parallelCopy,
                    isAuto: isAutoCopy,
                    isRaw: isRawCopy,
                    gradingCompany: gradingComp,
                    grade: gradeCopy
                )
                card.currentValue = result.nextSaleEstimate
                card.updatedAt = Date()
            } catch {
                // Fetch failed — currentValue stays as purchase price.
                // User can refresh from CardDetailView later.
            }
        }
}

// MARK: - Preview
#Preview {
    AddCardView()
        .modelContainer(for: [CardItem.self, CardSaleRecord.self], inMemory: true)
}
