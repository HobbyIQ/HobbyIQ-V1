//
//  CertResolveView.swift
//  HobbyIQ
//

import SwiftUI
import os

/// Coordinator that takes either a cert-like query (Dashboard) or a unified-
/// search candidate (CardSearchView tap) and lands the user on a COMPED
/// CompIQPricedCardView. Pipeline:
///
///   1. If no candidate was supplied, POST `/api/search/cards` to classify
///      the input (this is the path the backend already uses to recognise
///      PSA cert numbers and surface their metadata).
///   2. Future-proof: if the candidate ever carries a `cardsightCardId`,
///      route to pricing directly. (Backend gap filed: SearchCandidate
///      currently does not carry one — see HALT report.)
///   3. Build a loose variant-search query from the candidate's PSA fields
///      (`year`, `setName`, `player`, `cardNumber`, `parallel`) and POST
///      `/api/compiq/cardsearch` to resolve the Cardsight id.
///   4. Dispatch 0 / 1 / many:
///        - **1 hit**:  CompIQPricedCardView with grade pre-fill.
///        - **N hits**: CompIQVariantPickerView preloaded with the hits +
///                      grade pre-fill carried through.
///        - **0 hits**: render the PSA card metadata that the candidate
///                      DID return + a manual "Refine search" affordance.
///                      Explicitly NOT a silent "No variants found".
struct CertResolveView: View {
    private let initialInput: String?
    private let preloadedCandidate: SearchCandidate?

    @State private var status: Status = .loading
    @Environment(\.dismiss) private var dismiss
    /// Held explicitly so the EO chain doesn't drop when this view renders
    /// CompIQPricedCardView (or CompIQVariantPickerView, then deeper) inside
    /// a navigationDestination from DashboardView. In the multi-NavigationStack
    /// ZStack shell, intermediate views that don't hold the EO can lose the
    /// chain on push — re-injecting at every render site closes the gap.
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

    private let logger = Logger(subsystem: "com.hobbyiq.app", category: "cert-resolve")

    enum Status {
        case loading
        case routedToPriced(CompIQVariantHit, CompIQPricedCardView.GradeOption?)
        case routedToPicker([CompIQVariantHit], CompIQPricedCardView.GradeOption?)
        case noMatch(candidate: SearchCandidate?, query: String)
        case error(String)
    }

    init(input: String) {
        self.initialInput = input
        self.preloadedCandidate = nil
    }

    init(candidate: SearchCandidate) {
        self.initialInput = candidate.certNumber ?? candidate.title
        self.preloadedCandidate = candidate
    }

    var body: some View {
        Group {
            switch status {
            case .loading:
                loadingView
            case .routedToPriced(let hit, let grade):
                CompIQPricedCardView(hit: hit, initialGrade: grade)
                    .environmentObject(sessionViewModel)
            case .routedToPicker(let hits, let grade):
                CompIQVariantPickerView(initialHits: hits, initialGrade: grade)
                    .environmentObject(sessionViewModel)
            case .noMatch(let candidate, let query):
                noMatchView(candidate: candidate, query: query)
            case .error(let message):
                errorView(message: message)
            }
        }
        .task { await resolve() }
    }

    // MARK: - Resolve pipeline

    private func resolve() async {
        var candidate: SearchCandidate? = preloadedCandidate

        // 1. Classify input if we didn't get a candidate up front.
        if candidate == nil, let input = initialInput?.trimmingCharacters(in: .whitespacesAndNewlines), input.isEmpty == false {
            do {
                let response = try await APIService.shared.searchCards(input: input)
                candidate = response.candidates?.first
            } catch {
                logger.error("searchCards failed: \(error.localizedDescription, privacy: .public)")
                status = .error(APIService.errorMessage(from: error))
                return
            }
        }

        guard let c = candidate else {
            status = .noMatch(candidate: nil, query: initialInput ?? "")
            return
        }

        // 2. Future-proof Cardsight-id pickup. SearchCandidate currently has
        //    no cardsightCardId field, so this branch is dormant today. When
        //    the backend gap closes (see HALT report), add the field to
        //    SearchCandidate and dispatch here without the variant-search
        //    hop. The grade pre-fill remains identical.

        // 3. Build a loose variant-search query from PSA metadata.
        let variantQuery = buildVariantQuery(from: c)
        guard variantQuery.isEmpty == false else {
            status = .noMatch(candidate: c, query: initialInput ?? "")
            return
        }

        // 4. Resolve via variant search → dispatch by count.
        do {
            let hits = try await CompIQSearchService.shared.searchVariants(query: variantQuery)
            let grade = CompIQPricedCardView.gradeOption(forCompany: c.gradeCompany, value: c.gradeValue)

            switch hits.count {
            case 0:
                status = .noMatch(candidate: c, query: variantQuery)
            case 1:
                status = .routedToPriced(hits[0], grade)
            default:
                status = .routedToPicker(hits, grade)
            }
        } catch {
            logger.error("variant resolve failed: \(error.localizedDescription, privacy: .public)")
            status = .error(APIService.errorMessage(from: error))
        }
    }

    private func buildVariantQuery(from c: SearchCandidate) -> String {
        let parts: [String?] = [
            c.year,
            c.setName,
            c.player,
            c.cardNumber.map { "#\($0)" } ?? c.cardNumber,
            c.parallel,
            c.variation
        ]
        return parts
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    // MARK: - Loading

    private var loadingView: some View {
        ZStack {
            HobbyIQBackground()
            VStack(spacing: HobbyIQTheme.Spacing.medium) {
                ProgressView()
                    .tint(HobbyIQTheme.Colors.electricBlue)
                    .controlSize(.large)
                Text("Looking up this card…")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .navigationTitle("Cert lookup")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - No-match state (shows PSA info, never silent)

    private func noMatchView(candidate: SearchCandidate?, query: String) -> some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.large) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Couldn't price this cert yet")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("We have the card metadata but couldn't match it to a priceable variant. Refine the search and we'll try again.")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let c = candidate {
                    psaInfoCard(c)
                }

                NavigationLink {
                    CompIQVariantPickerView(initialQuery: query)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.subheadline.weight(.semibold))
                        Text("Refine search")
                            .font(.subheadline.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Capsule(style: .continuous))
                    .contentShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refine the search manually")
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Cert lookup")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func psaInfoCard(_ c: SearchCandidate) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "rosette")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("From PSA cert")
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                if let cert = c.certNumber, cert.isEmpty == false {
                    Text("#\(cert)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                infoRow("Player", value: c.player)
                infoRow("Year", value: c.year)
                infoRow("Set", value: [c.brand, c.setName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " "))
                infoRow("Card #", value: c.cardNumber)
                infoRow("Parallel", value: c.parallel)
                infoRow("Grade", value: [c.gradeCompany, c.grade].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " "))
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    @ViewBuilder
    private func infoRow(_ label: String, value: String?) -> some View {
        if let value, value.isEmpty == false {
            HStack {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(value)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .multilineTextAlignment(.trailing)
            }
        }
    }

    // MARK: - Error

    private func errorView(message: String) -> some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text("Couldn't look up this cert")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, HobbyIQTheme.Spacing.large)
            Button {
                status = .loading
                Task { await resolve() }
            } label: {
                Text("Try again")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Try the cert lookup again")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(HobbyIQTheme.Spacing.large)
        .background(HobbyIQBackground())
        .navigationTitle("Cert lookup")
        .navigationBarTitleDisplayMode(.inline)
    }
}
