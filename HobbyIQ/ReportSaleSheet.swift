//
//  ReportSaleSheet.swift
//  HobbyIQ
//
//  "Report a sale" sheet — user attests they saw a comp for the card
//  they're viewing. Backend stores as `manual-user-entry`; feeds the
//  canonical pipeline on next compute. Client-side rate-limit: after
//  3 submissions in 60s, disable Submit for 15s (backend has no rate
//  limit yet — this is UX politeness per the spec).
//

import Combine
import SwiftUI

/// Fires after a successful add so the parent can invalidate the
/// canonical-FMV cache for this card and bump its recent-sales feed
/// refresh token.
typealias ManualCompAddedHandler = (ManualCompAddResponse) -> Void

struct ReportSaleSheet: View {
    let card: InventoryCard
    let onAdded: ManualCompAddedHandler

    @Environment(\.dismiss) private var dismiss

    @State private var priceText: String = ""
    @State private var soldAt: Date = Date()
    @State private var titleText: String = ""
    @State private var overrideGradeCompany: String
    @State private var overrideGradeValueText: String
    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String?
    @State private var rateLimitReleaseAt: Date?

    /// Sliding 60s window of submit timestamps used by the client-side
    /// rate-limit gate. See `evaluateRateLimit`.
    @State private var recentSubmissionTimes: [Date] = []
    /// Ticks each second when the rate-limit gate is active so the
    /// countdown copy updates.
    @State private var tick: Date = Date()

    private static let rateLimitWindow: TimeInterval = 60
    private static let rateLimitThreshold: Int = 3
    private static let rateLimitCooldown: TimeInterval = 15

    init(card: InventoryCard, onAdded: @escaping ManualCompAddedHandler) {
        self.card = card
        self.onAdded = onAdded
        // Default the grade fields to the currently-viewed grade so
        // the user only has to enter price + date.
        _overrideGradeCompany = State(initialValue: card.gradeCompany ?? "")
        _overrideGradeValueText = State(initialValue: card.gradeValue.map { formatGrade($0) } ?? "")
    }

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                Form {
                    Section("Sale") {
                        HStack {
                            Text("$")
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            TextField("Price", text: $priceText)
                                .keyboardType(.decimalPad)
                        }
                        DatePicker("Date", selection: $soldAt, in: ...Date().addingTimeInterval(24 * 60 * 60), displayedComponents: [.date])
                    }
                    Section("Grade (optional)") {
                        TextField("Grader (PSA, BGS, SGC, CGC)", text: $overrideGradeCompany)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.characters)
                        TextField("Grade value (e.g. 10, 9.5)", text: $overrideGradeValueText)
                            .keyboardType(.decimalPad)
                    }
                    Section("Listing title (optional)") {
                        TextField("Where you saw it", text: $titleText, axis: .vertical)
                            .lineLimit(1...3)
                    }
                    if let errorMessage {
                        Section {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.danger)
                        }
                    }
                    if let cooldownCopy {
                        Section {
                            Text(cooldownCopy)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.warning)
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Report a sale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(submitLabel) {
                        Task { await submit() }
                    }
                    .disabled(isSubmitDisabled)
                }
            }
            .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now in
                tick = now
            }
        }
    }

    private var submitLabel: String { isSubmitting ? "Adding…" : "Submit" }

    private var isSubmitDisabled: Bool {
        if isSubmitting { return true }
        if cooldownActive { return true }
        return Double(priceText.trimmingCharacters(in: .whitespaces)).map { $0 <= 0 } ?? true
    }

    private var cooldownActive: Bool {
        guard let release = rateLimitReleaseAt else { return false }
        return tick < release
    }

    private var cooldownCopy: String? {
        guard let release = rateLimitReleaseAt, tick < release else { return nil }
        let seconds = max(0, Int(release.timeIntervalSince(tick).rounded(.up)))
        return "Give the pool a moment — you're contributing fast! (\(seconds)s)"
    }

    // MARK: - Submit

    private func submit() async {
        errorMessage = nil
        let trimmedPrice = priceText.trimmingCharacters(in: .whitespaces)
        guard let price = Double(trimmedPrice), price > 0 else {
            errorMessage = "Price must be greater than $0."
            return
        }
        if soldAt.timeIntervalSince(Date()) > 24 * 60 * 60 {
            errorMessage = "Date can't be more than a day in the future."
            return
        }
        guard let cardId = card.cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
              cardId.isEmpty == false else {
            errorMessage = "This holding isn't linked to a catalog card yet."
            return
        }
        let cardYear = Int(card.year.trimmingCharacters(in: .whitespaces))
        let overrideCompany: String? = {
            let raw = overrideGradeCompany.trimmingCharacters(in: .whitespacesAndNewlines)
            return raw.isEmpty ? nil : raw.uppercased()
        }()
        let overrideValue: Double? = Double(overrideGradeValueText.trimmingCharacters(in: .whitespaces))
        let request = ManualCompAddRequest(
            cardId: cardId,
            playerName: card.playerName,
            price: price,
            soldAt: Self.isoFormatter.string(from: soldAt),
            cardYear: cardYear,
            setName: card.setName.isEmpty ? nil : card.setName,
            parallel: card.parallel.isEmpty ? nil : card.parallel,
            cardNumber: nil,
            isAuto: card.isAuto,
            gradeCompany: overrideCompany,
            gradeValue: overrideValue,
            title: titleText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : titleText
        )
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let response = try await APIService.shared.addManualComp(request)
            recordSubmission()
            evaluateRateLimit()
            onAdded(response)
            dismiss()
        } catch let error as APIServiceError {
            switch error {
            case .httpError(_, let body) where body.isEmpty == false:
                errorMessage = body
            default:
                errorMessage = APIService.errorMessage(from: error)
            }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func recordSubmission() {
        let now = Date()
        recentSubmissionTimes.append(now)
        recentSubmissionTimes = recentSubmissionTimes.filter { now.timeIntervalSince($0) <= Self.rateLimitWindow }
    }

    private func evaluateRateLimit() {
        if recentSubmissionTimes.count >= Self.rateLimitThreshold {
            rateLimitReleaseAt = Date().addingTimeInterval(Self.rateLimitCooldown)
        }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

private func formatGrade(_ value: Double) -> String {
    if value.truncatingRemainder(dividingBy: 1) == 0 {
        return String(format: "%.0f", value)
    }
    return String(format: "%.1f", value)
}
