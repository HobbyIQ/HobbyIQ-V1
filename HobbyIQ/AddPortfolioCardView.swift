//
//  AddPortfolioCardView.swift
//  HobbyIQ
//

import SwiftUI

struct AddPortfolioCardView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject var viewModel: AddPortfolioCardViewModel
    var onSave: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 16) {
                    header
                    requiredFields
                    recommendedFields
                    moreDetailsSection

                    if let errorMessage = viewModel.errorMessage {
                        HobbyIQErrorStateView(title: "Could not save card", message: errorMessage) {
                            Task { _ = await viewModel.save() }
                        }
                    }

                    HobbyIQPrimaryButton(title: viewModel.isSaving ? "Saving..." : viewModel.primaryButtonTitle) {
                        save()
                    }
                }
                .padding(16)
                .padding(.bottom, 32)
            }
            .background(HobbyIQTheme.bg.ignoresSafeArea())
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(viewModel.mode.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }
            }
        }
    }

    private var header: some View {
        HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
            VStack(alignment: .leading, spacing: 8) {
                Text(viewModel.mode.title)
                    .font(.title3.bold())
                    .foregroundStyle(.white)
                Text("Keep it fast. Add the basics first, then open more details only if you need them.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }
        }
    }

    private var requiredFields: some View {
        HobbyIQSurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                sectionTitle("Required")
                formField("Player Name", text: $viewModel.playerName)
                formField("Card Title", text: $viewModel.cardTitle)
                formField("Purchase Price", text: $viewModel.purchasePrice, keyboard: .decimalPad)
            }
        }
    }

    private var recommendedFields: some View {
        HobbyIQSurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                sectionTitle("Recommended")
                formField("Year", text: $viewModel.year, keyboard: .numbersAndPunctuation)
                formField("Set Name", text: $viewModel.setName)
                formField("Parallel", text: $viewModel.parallel)

                HStack(spacing: 12) {
                    formField("Grader", text: $viewModel.grader)
                    formField("Grade", text: $viewModel.grade)
                }
            }
        }
    }

    private var moreDetailsSection: some View {
        HobbyIQDisclosureSection(
            title: "More Details",
            subtitle: "Optional fields for deeper tracking",
            isExpanded: $viewModel.showMoreDetails
        ) {
            VStack(spacing: 12) {
                formField("Serial Number", text: $viewModel.serialNumber)
                formField("Quantity", text: $viewModel.quantity, keyboard: .numberPad)

                Toggle(isOn: $viewModel.includePurchaseDate) {
                    Text("Add Purchase Date")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                }
                .tint(HobbyIQTheme.green)

                if viewModel.includePurchaseDate {
                    DatePicker(
                        "Purchase Date",
                        selection: $viewModel.purchaseDate,
                        displayedComponents: .date
                    )
                    .datePickerStyle(.compact)
                    .colorScheme(.dark)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Notes")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)

                    TextEditor(text: $viewModel.notes)
                        .frame(minHeight: 96)
                        .padding(12)
                        .background(HobbyIQTheme.cardElevated)
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(HobbyIQTheme.stroke, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .foregroundStyle(.white)
                }
            }
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func formField(_ title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)

            TextField(title, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.words)
                .disableAutocorrection(true)
                .padding(14)
                .background(HobbyIQTheme.cardElevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(HobbyIQTheme.stroke, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .foregroundStyle(.white)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func save() {
        Task {
            let didSave = await viewModel.save()
            if didSave {
                onSave?()
                dismiss()
            }
        }
    }
}

#Preview {
    AddPortfolioCardView(viewModel: AddPortfolioCardViewModel())
}
