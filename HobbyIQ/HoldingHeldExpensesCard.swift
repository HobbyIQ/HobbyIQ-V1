//
//  HoldingHeldExpensesCard.swift
//  HobbyIQ
//
//  Scope 3 (2026-07-12) surface #5 — the "Costs added while holding"
//  section on every holding detail sheet. Wraps
//  `/api/portfolio/holdings/:id/expenses` (GET/POST/DELETE).
//
//  Backend semantics (critical): each POST returns
//  `newTotalCostBasis` — the holding's updated cost basis with the
//  fresh expense rolled in. iOS surfaces that number verbatim; do NOT
//  double-subtract client-side.
//

import SwiftUI

struct HoldingHeldExpensesCard: View {
    let holdingId: String
    /// Fired every time the backend returns a new totalCostBasis (add
    /// or delete). Detail sheets use this to trigger a refresh so the
    /// row upstream reflects the delta.
    let onCostBasisChanged: (Double) -> Void

    @State private var expenses: [HoldingHeldExpense] = []
    @State private var totalSpent: Double = 0
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showAdd = false
    @State private var pendingDeleteId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            VStack(alignment: .leading, spacing: 8) {
                if isLoading && expenses.isEmpty {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 40)
                } else if expenses.isEmpty {
                    emptyState
                } else {
                    ForEach(expenses) { expense in
                        row(expense)
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .task { await load() }
        .sheet(isPresented: $showAdd) {
            HoldingHeldExpenseAddSheet(holdingId: holdingId) { response in
                if let expense = response.expense {
                    expenses.append(expense)
                    totalSpent += expense.amount
                }
                if let cb = response.newTotalCostBasis {
                    onCostBasisChanged(cb)
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Costs added while holding")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(headerSubtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
            Button {
                showAdd = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(width: 32, height: 32)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add expense")
        }
    }

    private var headerSubtitle: String {
        if expenses.isEmpty {
            return "Grading, supplies, insurance — tracked into cost basis."
        }
        return "\(expenses.count) item\(expenses.count == 1 ? "" : "s") · \(totalSpent.portfolioCurrencyText)"
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No costs added yet.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.vertical, 4)
    }

    private func row(_ expense: HoldingHeldExpense) -> some View {
        let kind = HoldingHeldExpenseKind(rawValue: expense.kind) ?? .other
        return HStack(alignment: .center, spacing: 10) {
            Image(systemName: kind.iconName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .frame(width: 28, height: 28)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 1) {
                Text(kind.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let notes = expense.notes, notes.isEmpty == false {
                    Text(notes)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(expense.amount.portfolioCurrencyText)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            Button {
                Task { await delete(expenseId: expense.id) }
            } label: {
                Image(systemName: pendingDeleteId == expense.id ? "hourglass" : "trash")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.85))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .disabled(pendingDeleteId != nil)
            .accessibilityLabel("Delete expense")
        }
        .padding(.vertical, 4)
    }

    // MARK: Data

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchHoldingExpenses(holdingId: holdingId)
            expenses = response.expenses ?? []
            totalSpent = response.total ?? expenses.reduce(0) { $0 + $1.amount }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func delete(expenseId: String) async {
        pendingDeleteId = expenseId
        defer { pendingDeleteId = nil }
        do {
            let response = try await APIService.shared.deleteHoldingExpense(holdingId: holdingId, expenseId: expenseId)
            if let removed = expenses.first(where: { $0.id == expenseId }) {
                totalSpent -= removed.amount
            }
            expenses.removeAll { $0.id == expenseId }
            if let cb = response.newTotalCostBasis {
                onCostBasisChanged(cb)
            }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Add expense sheet

struct HoldingHeldExpenseAddSheet: View {
    let holdingId: String
    let onCreated: (HoldingHeldExpenseCreateResponse) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedKind: HoldingHeldExpenseKind = .grading
    @State private var amountText: String = ""
    @State private var incurredAt: Date = Date()
    @State private var notes: String = ""
    @State private var invoiceRef: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var amount: Double { Double(amountText.trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var canSave: Bool { amount > 0 && isSaving == false }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    kindPicker
                    amountField
                    dateField
                    notesField
                    invoiceField
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                    }
                    saveButton
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, 16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Add expense")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
    }

    private var kindPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Type")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.1)
            let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(HoldingHeldExpenseKind.allCases) { kind in
                    Button {
                        selectedKind = kind
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: kind.iconName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(selectedKind == kind ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.electricBlue)
                            Text(kind.displayName)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(selectedKind == kind ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.pureWhite.opacity(0.85))
                            Spacer()
                        }
                        .padding(12)
                        .background(selectedKind == kind ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.steelGray.opacity(0.2))
                        .overlay(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                                .stroke(selectedKind == kind ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var amountField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Amount")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.1)
            HStack(spacing: 6) {
                Text("$")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                TextField("0.00", text: $amountText)
                    .keyboardType(.decimalPad)
                    .font(.body.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.white.opacity(0.1), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private var dateField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Date")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.1)
            DatePicker("", selection: $incurredAt, in: ...Date(), displayedComponents: .date)
                .datePickerStyle(.compact)
                .labelsHidden()
                .tint(HobbyIQTheme.Colors.electricBlue)
        }
    }

    private var notesField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Notes")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.1)
            TextField("Optional", text: $notes, axis: .vertical)
                .lineLimit(2...5)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private var invoiceField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Invoice / reference")
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.1)
            TextField("Optional", text: $invoiceRef)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            HStack(spacing: 8) {
                if isSaving {
                    ProgressView().tint(HobbyIQTheme.Colors.pureWhite).controlSize(.small)
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.subheadline.weight(.bold))
                }
                Text(isSaving ? "Saving…" : "Save expense")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(canSave ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.electricBlue.opacity(0.4))
            .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(canSave == false)
    }

    private func save() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }

        let request = HoldingHeldExpenseCreateRequest(
            kind: selectedKind.rawValue,
            amount: amount,
            incurredAt: ISO8601DateFormatter().string(from: incurredAt),
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes,
            invoiceRef: invoiceRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : invoiceRef
        )

        do {
            let response = try await APIService.shared.createHoldingExpense(holdingId: holdingId, request: request)
            onCreated(response)
            dismiss()
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}
