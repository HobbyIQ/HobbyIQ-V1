//
//  BuyerIQCreateListView.swift
//  HobbyIQ
//
//  CF-BUYERIQ (Drew, 2026-07-31). Sheet for creating a new BuyerIQ
//  list (edit mode arrives in a follow-up; MVP is create-only).
//

import SwiftUI

struct BuyerIQCreateListView: View {
    @ObservedObject var vm: BuyerIQViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var description: String = ""
    @State private var showLocation: String = ""
    @State private var showDate: Date = Date()
    @State private var includeDate = false
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("List") {
                    TextField("Name (e.g. National 2026)", text: $name)
                        .textInputAutocapitalization(.words)
                    TextField("Description (optional)", text: $description, axis: .vertical)
                        .lineLimit(2...4)
                }
                Section("Show details (optional)") {
                    TextField("Location (e.g. Chicago, IL)", text: $showLocation)
                        .textInputAutocapitalization(.words)
                    Toggle("Include show date", isOn: $includeDate)
                    if includeDate {
                        DatePicker("Date", selection: $showDate, displayedComponents: .date)
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
            .navigationTitle("New List")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await save() }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let iso: String? = includeDate ? isoDate(showDate) : nil
        await vm.createList(
            name: name.trimmingCharacters(in: .whitespaces),
            description: description.isEmpty ? nil : description,
            showDate: iso,
            showLocation: showLocation.isEmpty ? nil : showLocation
        )
        if vm.error == nil {
            dismiss()
        }
    }

    private func isoDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
}
