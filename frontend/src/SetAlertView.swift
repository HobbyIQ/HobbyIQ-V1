//  SetAlertView.swift
//  HobbyIQ — Sheet that lets a user create a price alert for a specific card.
//  Presented from CardDetailView via a "Set price alert" button.

import SwiftUI

@MainActor
struct SetAlertView: View {
    let cardId: String
    let playerName: String
    let currentPrice: Double?
    let cardSnapshot: PriceAlertCardSnapshot?

    init(
        cardId: String,
        playerName: String,
        currentPrice: Double?,
        cardSnapshot: PriceAlertCardSnapshot? = nil
    ) {
        self.cardId = cardId
        self.playerName = playerName
        self.currentPrice = currentPrice
        self.cardSnapshot = cardSnapshot
    }

    @EnvironmentObject private var alertService: PriceAlertService
    @Environment(\.dismiss) private var dismiss

    @State private var direction: PriceAlertDirection = .above
    @State private var targetPriceText: String = ""
    @State private var isSaving: Bool = false
    @State private var localError: String?

    private var targetPrice: Double? {
        let cleaned = targetPriceText
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespaces)
        return Double(cleaned)
    }

    private var canSave: Bool {
        guard let price = targetPrice else { return false }
        return price > 0 && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Text("Card")
                        Spacer()
                        Text(playerName)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let cp = currentPrice {
                        HStack {
                            Text("Current price")
                            Spacer()
                            Text(currencyString(cp))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                } header: {
                    Text("Card")
                }

                Section {
                    Picker("Direction", selection: $direction) {
                        ForEach(PriceAlertDirection.allCases) { d in
                            Label(d.displayName, systemImage: d.systemImage).tag(d)
                        }
                    }
                    .pickerStyle(.segmented)

                    HStack {
                        Text("$")
                            .foregroundStyle(.secondary)
                        TextField("Target price", text: $targetPriceText)
                            .keyboardType(.decimalPad)
                            .textInputAutocapitalization(.never)
                    }
                } header: {
                    Text("Trigger")
                } footer: {
                    Text("We'll send a push when the predicted price \(direction.displayName.lowercased()) this target.")
                }

                if let err = localError ?? alertService.lastError {
                    Section {
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Set price alert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .disabled(!canSave)
                    }
                }
            }
            .task {
                // Make sure permission is asked at the moment of clearest
                // intent — when the user is actually setting an alert.
                await alertService.requestPermissionAndRegister()
            }
        }
    }

    private func save() async {
        guard let price = targetPrice, price > 0 else {
            localError = "Enter a positive number"
            return
        }
        localError = nil
        isSaving = true
        defer { isSaving = false }

        let created = await alertService.createAlert(
            cardId: cardId,
            playerName: playerName,
            targetPrice: price,
            direction: direction,
            currentPrice: currentPrice,
            cardSnapshot: cardSnapshot
        )
        if created != nil {
            dismiss()
        }
    }

    private func currencyString(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: value)) ?? "$\(value)"
    }
}
