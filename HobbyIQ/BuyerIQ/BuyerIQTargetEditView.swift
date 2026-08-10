//
//  BuyerIQTargetEditView.swift
//  HobbyIQ
//
//  CF-BUYERIQ (Drew, 2026-07-31). Sheet for creating or editing a
//  card target. MVP is a manual form; Phase 2 wires this to the same
//  card-search flow the Inventory tab uses so pricing rails snap in.
//

import SwiftUI

struct BuyerIQTargetEditView: View {
    enum Mode: Equatable {
        case create(listId: String)
        case edit(target: BuyerIqTarget)
    }

    let mode: Mode
    @ObservedObject var vm: BuyerIQViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var playerName: String = ""
    @State private var cardYearString: String = ""
    @State private var setName: String = ""
    @State private var cardNumber: String = ""
    @State private var parallel: String = ""
    @State private var isAuto: Bool = false
    @State private var priority: BuyerIqTargetPriority = .medium
    @State private var maxPriceString: String = ""
    @State private var notes: String = ""
    @State private var status: BuyerIqTargetStatus = .wanted
    @State private var acquiredPriceString: String = ""
    @State private var isSaving = false
    // CF-BUYERIQ-CATALOG-SEARCH (Drew, 2026-08-10). When a target is
    // added via the catalog search sheet, capture the canonical slug +
    // image so save() can send them through to the backend — the
    // target row lands with `hobbyiqCardId` set and pricing rails
    // (canonical FMV, gap match, market movers) snap in immediately.
    @State private var showCatalogSearch: Bool = false
    @State private var pickedHobbyiqCardId: String? = nil
    @State private var pickedImageUrl: String? = nil

    private var listId: String {
        switch mode {
        case .create(let listId): return listId
        case .edit(let target): return target.listId
        }
    }

    private var isEditing: Bool {
        if case .edit = mode { return true } else { return false }
    }

    var body: some View {
        NavigationStack {
            Form {
                // CF-BUYERIQ-CATALOG-SEARCH (Drew, 2026-08-10). Catalog
                // search entry point — only shown on Create (not Edit) so
                // existing targets aren't accidentally re-slugged. Tap
                // opens the same search sheet that Inventory add uses;
                // picking a result prefills the Card section below and
                // captures the canonical slug for the save payload.
                if !isEditing {
                    Section {
                        Button {
                            showCatalogSearch = true
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "magnifyingglass.circle.fill")
                                    .font(.title3)
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(pickedHobbyiqCardId == nil ? "Search catalog" : "Card picked from catalog")
                                        .font(HobbyIQTheme.Typography.bodyEmphasis)
                                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                    Text(pickedHobbyiqCardId == nil
                                         ? "Match to canonical identity so pricing rails snap in"
                                         : "Tap to change; or edit fields below")
                                        .font(HobbyIQTheme.Typography.caption)
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                }
                                Spacer(minLength: 0)
                                if pickedHobbyiqCardId != nil {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                                } else {
                                    Image(systemName: "chevron.right")
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    } header: {
                        Text("From catalog")
                    } footer: {
                        Text("Or fill the fields below manually if the card isn't indexed yet.")
                            .font(HobbyIQTheme.Typography.caption)
                    }
                }
                Section("Card") {
                    TextField("Player name (required)", text: $playerName)
                        .textInputAutocapitalization(.words)
                    TextField("Year", text: $cardYearString)
                        .keyboardType(.numberPad)
                    TextField("Set (e.g. 2026 Bowman Chrome)", text: $setName)
                    TextField("Card # (e.g. CPA-EH)", text: $cardNumber)
                    TextField("Parallel (e.g. Gold Refractor)", text: $parallel)
                    Toggle("Autograph", isOn: $isAuto)
                }
                Section("Buying intent") {
                    Picker("Priority", selection: $priority) {
                        ForEach(BuyerIqTargetPriority.allCases) { p in
                            Text(p.display).tag(p)
                        }
                    }
                    TextField("Max price cap ($)", text: $maxPriceString)
                        .keyboardType(.decimalPad)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...4)
                }
                if isEditing {
                    Section("Status") {
                        Picker("Status", selection: $status) {
                            ForEach(BuyerIqTargetStatus.allCases) { s in
                                Text(s.display).tag(s)
                            }
                        }
                        if status == .acquired {
                            TextField("Paid price ($)", text: $acquiredPriceString)
                                .keyboardType(.decimalPad)
                        }
                    }
                }
                if let error = vm.error {
                    Section {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(HobbyIQBackground())
            .navigationTitle(isEditing ? "Edit Target" : "Add Target")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? "Save" : "Add") {
                        Task { await save() }
                    }
                    .disabled(playerName.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                }
            }
            .onAppear { hydrate() }
            .sheet(isPresented: $showCatalogSearch) {
                BuyerIQCatalogSearchSheet { hit in
                    applyCatalogPick(hit)
                }
            }
        }
    }

    // CF-BUYERIQ-CATALOG-SEARCH (Drew, 2026-08-10). Prefill the form
    // fields from a picked catalog hit. Preserves the canonical slug so
    // save() can include it in the create payload — target lands
    // hobbyiqCardId-tagged on first insert.
    private func applyCatalogPick(_ hit: CompIQVariantHit) {
        pickedHobbyiqCardId = hit.cardId
        pickedImageUrl = hit.imageUrl
        if let p = hit.player, !p.isEmpty { playerName = p }
        if let y = hit.year { cardYearString = String(y) }
        if let s = hit.set, !s.isEmpty { setName = s }
        if let n = hit.number, !n.isEmpty { cardNumber = n }
        if let v = hit.variant, !v.isEmpty { parallel = v }
        isAuto = hit.isAuto
    }

    private func hydrate() {
        guard case .edit(let target) = mode else { return }
        playerName = target.playerName
        cardYearString = target.cardYear.map { String($0) } ?? ""
        setName = target.setName ?? ""
        cardNumber = target.cardNumber ?? ""
        parallel = target.parallel ?? ""
        isAuto = target.isAuto ?? false
        priority = target.priority
        maxPriceString = target.maxPrice.map { String(format: "%.2f", $0) } ?? ""
        notes = target.notes ?? ""
        status = target.status
        acquiredPriceString = target.acquiredPrice.map { String(format: "%.2f", $0) } ?? ""
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let req = BuyerIqTargetUpsertRequest(
            listId: isEditing ? nil : listId,
            hobbyiqCardId: pickedHobbyiqCardId,
            playerName: playerName.trimmingCharacters(in: .whitespaces),
            cardYear: Int(cardYearString.trimmingCharacters(in: .whitespaces)),
            cardNumber: cardNumber.isEmpty ? nil : cardNumber,
            setName: setName.isEmpty ? nil : setName,
            parallel: parallel.isEmpty ? nil : parallel,
            isAuto: isAuto,
            gradeCompany: nil,
            gradeValue: nil,
            imageUrl: pickedImageUrl,
            maxPrice: Double(maxPriceString.replacingOccurrences(of: "$", with: "")),
            priority: priority.rawValue,
            notes: notes.isEmpty ? nil : notes,
            status: isEditing ? status.rawValue : "wanted",
            acquiredAt: nil,
            acquiredPrice: Double(acquiredPriceString.replacingOccurrences(of: "$", with: ""))
        )
        switch mode {
        case .create:
            await vm.createTarget(listId: listId, request: req)
        case .edit(let target):
            await vm.updateTarget(targetId: target.id, listId: listId, request: req)
        }
        if vm.error == nil {
            dismiss()
        }
    }
}
