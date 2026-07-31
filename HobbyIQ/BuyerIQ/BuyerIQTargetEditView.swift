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
        }
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
            hobbyiqCardId: nil,
            playerName: playerName.trimmingCharacters(in: .whitespaces),
            cardYear: Int(cardYearString.trimmingCharacters(in: .whitespaces)),
            cardNumber: cardNumber.isEmpty ? nil : cardNumber,
            setName: setName.isEmpty ? nil : setName,
            parallel: parallel.isEmpty ? nil : parallel,
            isAuto: isAuto,
            gradeCompany: nil,
            gradeValue: nil,
            imageUrl: nil,
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
