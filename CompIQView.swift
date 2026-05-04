// CompIQView.swift
// Two-layer CompIQ pricing UI:
//   Layer 1 — Clean answer card (fair value, range, confidence, outlook)
//   Layer 2 — "How CompIQ Calculated This" disclosure with full pricing breakdown

import SwiftUI

// MARK: - Main View

struct CompIQView: View {
    @StateObject private var vm = HobbyIQViewModel.shared
    @State private var showDetails = false
    @FocusState private var focusedField: Field?

    enum Field { case player, card, parallel, cost }

    private let grades = ["Raw", "PSA 9", "PSA 10", "BGS 9.5", "BGS 10", "SGC 10", "CGC 10"]

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 20) {
                    inputFormAndButton
                    if vm.isLoading { loadingView }
                    if let err = vm.errorMessage { errorView(err) }
                    if let result = vm.estimateResult { resultSection(result) }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .navigationTitle("CompIQ")
            .navigationBarTitleDisplayMode(.large)
            .background(Color(.systemGroupedBackground))
            .onTapGesture { focusedField = nil }
        }
    }

    // MARK: - Input Section

    private var inputFormAndButton: some View {
        VStack(spacing: 12) {
        VStack(spacing: 0) {
            inputRow {
                TextField("Player Name", text: $vm.playerName)
                    .focused($focusedField, equals: .player)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .card }
            }
            Divider().padding(.leading, 16)
            inputRow {
                TextField("Card Name  (e.g. 2025 Bowman Chrome Blue Auto /150)", text: $vm.cardName)
                    .focused($focusedField, equals: .card)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .parallel }
            }
            Divider().padding(.leading, 16)
            inputRow {
                TextField("Parallel  (optional)", text: $vm.parallel)
                    .focused($focusedField, equals: .parallel)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .cost }
            }
            Divider().padding(.leading, 16)
            inputRow {
                Picker("Grade", selection: $vm.grade) {
                    ForEach(grades, id: \.self) { Text($0) }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider().padding(.leading, 16)
            inputRow {
                HStack {
                    Text("$").foregroundColor(.secondary)
                    TextField("Your Cost or Recent Comp", text: $vm.costInput)
                        .keyboardType(.decimalPad)
                        .focused($focusedField, equals: .cost)
                }
            }
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        priceButton
        }
        .padding(.top, 8)
    }

    private func inputRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        HStack {
            content()
                .font(.body)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private var priceButton: some View {
        Button {
            focusedField = nil
            showDetails = false
            Task { await vm.priceCard() }
        } label: {
            HStack {
                Image(systemName: "sparkle")
                Text(vm.isLoading ? "Pricing…" : "Price This Card")
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(vm.isLoading ? Color.blue.opacity(0.6) : Color.blue)
            .foregroundColor(.white)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .disabled(vm.isLoading)
    }

    // MARK: - Loading

    private var loadingView: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text("Analyzing comps and market signals…")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Error

    private func errorView(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.red)
            Text(message)
                .font(.subheadline)
                .foregroundColor(.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Result Section

    private func resultSection(_ r: CompIQEstimateResult) -> some View {
        VStack(spacing: 16) {
            // Layer 1 — Fair value card
            fairValueCard(r)
            // Decision policy
            actionPolicyCard(r)
            // Evidence ledger
            if let evidence = r.evidenceComps, !evidence.isEmpty {
                evidenceLedgerCard(evidence)
            }
            // Layer 2 — Breakdown (disclosure)
            breakdownSection(r)
        }
    }

    private func actionPolicyCard(_ r: CompIQEstimateResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Recommended Action")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                if let action = r.recommendedAction {
                    Text(action.uppercased())
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(actionColor(action).opacity(0.14))
                        .foregroundColor(actionColor(action))
                        .clipShape(Capsule())
                }
            }

            if let rationale = r.actionRationale {
                Text(rationale)
                    .font(.subheadline)
                    .foregroundColor(.primary)
            }

            HStack(spacing: 12) {
                if let entry = r.actionEntryMax {
                    actionCell(label: "Entry Max", value: entry.currencyFormatted, tone: .green)
                }
                if let trim = r.actionTrimMin {
                    actionCell(label: "Trim Min", value: trim.currencyFormatted, tone: .orange)
                }
                if let stop = r.actionStopLoss {
                    actionCell(label: "Stop", value: stop.currencyFormatted, tone: .red)
                }
            }

            HStack {
                if let quality = r.evidenceQualityScore {
                    Text("Evidence: \(Int(quality))% \((r.evidenceQualityLevel ?? "").uppercased())")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                if let days = r.actionRecheckDays {
                    Text("Recheck in \(days)d")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.secondary)
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    private func actionCell(label: String, value: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(tone)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func evidenceLedgerCard(_ evidence: [CompIQEvidenceComp]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Top Comparable Evidence")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(evidence.count) comps")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            ForEach(Array(evidence.prefix(3).enumerated()), id: \.offset) { idx, comp in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("#\(idx + 1)")
                            .font(.caption.weight(.bold))
                            .foregroundColor(.secondary)
                        priorityPill(comp.priority)
                        Spacer()
                        Text(comp.salePrice.currencyFormatted)
                            .font(.subheadline.weight(.semibold))
                        Text("→")
                            .foregroundColor(.secondary)
                        Text(comp.normalizedPrice.currencyFormatted)
                            .font(.subheadline.weight(.bold))
                            .foregroundColor(.blue)
                    }

                    HStack(spacing: 10) {
                        if let parallel = comp.parallel {
                            Text(parallel)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        if let grade = comp.grade {
                            Text(grade.uppercased())
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                        if let daysAgo = comp.daysAgo {
                            Text("\(daysAgo)d ago")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }

                    Text(comp.trace)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
                .padding(10)
                .background(Color(.tertiarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    private func priorityPill(_ priority: Int) -> some View {
        Text(priority == 1 ? "High" : priority == 2 ? "Medium" : "Low")
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background((priority == 1 ? Color.green : priority == 2 ? Color.orange : Color.red).opacity(0.14))
            .foregroundColor(priority == 1 ? .green : priority == 2 ? .orange : .red)
            .clipShape(Capsule())
    }

    private func actionColor(_ action: String) -> Color {
        switch action.lowercased() {
        case "strong-buy": return .green
        case "buy": return .blue
        case "hold": return .indigo
        case "reduce": return .orange
        case "sell": return .red
        default: return .secondary
        }
    }

    // MARK: - Layer 1: Fair Value Card

    private func fairValueCard(_ r: CompIQEstimateResult) -> some View {
        VStack(spacing: 20) {

            HStack {
                Text("Your Pricing Plan")
                    .font(.headline)
                    .foregroundColor(.primary)
                Spacer()
            }

            // ── Header: outlook + confidence ────────────────────────────
            HStack {
                if let outlook = r.outlook { OutlookPill(outlook: outlook) }
                Spacer()
                ConfidenceBar(score: r.confidenceScore ?? (r.confidence * 100))
            }

            HStack(spacing: 6) {
                Image(systemName: "checkmark.shield")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text(trustContextLine(r))
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
            }

            HStack(spacing: 6) {
                Image(systemName: "info.circle")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text(confidenceMeaningLine(r))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
            }

            // ── 1. Value — hero number ───────────────────────────────────
            VStack(spacing: 4) {
                Text((r.value).currencyFormatted)
                    .font(.system(size: 52, weight: .bold, design: .rounded))
                    .foregroundColor(.primary)
                Text("Fair Market Value")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                // Grade + parallel context badges
                if r.gradeDetected != nil || r.parallelDetected != nil {
                    HStack(spacing: 6) {
                        if let grade = r.gradeDetected {
                            Text(grade.uppercased().replacingOccurrences(of: "_", with: " "))
                                .font(.caption.weight(.bold))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(Color.purple.opacity(0.13))
                                .foregroundColor(.purple)
                                .clipShape(Capsule())
                        }
                        if let par = r.parallelDetected {
                            Text(par.capitalized)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(Color.blue.opacity(0.10))
                                .foregroundColor(.blue)
                                .clipShape(Capsule())
                        }
                    }
                }
            }

            HStack(spacing: 8) {
                Image(systemName: "arrow.left.and.right")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text("Expected range: \(r.lowValue.currencyFormatted) to \(r.highValue.currencyFormatted)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
            }

            // ── 2. Market pulse: regime + 24h momentum + trend ───────────
            if r.marketRegimeLabel != nil || r.signal24hMomentum != nil ||
               (r.compTrendPctPerWeek.map { abs($0) >= 0.01 } ?? false) {
                HStack(spacing: 8) {
                    if let regime = r.marketRegimeLabel {
                        MarketRegimePill(label: regime)
                    }
                    if let momentum = r.signal24hMomentum {
                        MomentumPill(momentum: momentum)
                    }
                    if let pct = r.compTrendPctPerWeek, abs(pct) >= 0.01 {
                        let absPct = Int(abs(pct * 100))
                        let arrow = pct > 0 ? "↑" : "↓"
                        let trendColor: Color = pct > 0 ? .green : .red
                        Text("\(arrow) \(absPct)%/wk")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(trendColor.opacity(0.12))
                            .foregroundColor(trendColor)
                            .clipShape(Capsule())
                    }
                    Spacer()
                }
            }

            // ── 3. Freshness warning ──────────────────────────────────────
            if let warning = r.dataFreshnessWarning {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundColor(.orange)
                    Text(warning)
                        .font(.caption)
                        .foregroundColor(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.orange.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            if let penalty = r.stalenessPenalty, penalty < 1 {
                let pct = Int((1 - penalty) * 100)
                HStack(spacing: 8) {
                    Image(systemName: "clock.badge.exclamationmark")
                        .font(.caption)
                        .foregroundColor(.orange)
                    Text("Applied \(pct)% freshness discount due to older comps")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // ── 4–6. Seller price stack ───────────────────────────────────
            VStack(spacing: 0) {
                sellerPriceRow(
                    icon: "tag.fill",
                    label: "Suggested List Price",
                    value: r.suggestedListPrice,
                    color: .blue,
                    note: suggestedListNote(r)
                )
                Divider().padding(.leading, 52)
                sellerPriceRow(
                    icon: "hand.raised.fill",
                    label: "Min Acceptable Offer",
                    value: r.minAcceptableOffer,
                    color: .orange,
                    note: "Don't accept below this"
                )
            }
            .background(Color(.tertiarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))

            // ── 5. Format to sell online ─────────────────────────────────
            let listingFormat = r.sellFormat ?? "eBay BIN w/ Best Offer"
            let listingReason = r.sellFormatReason ?? "Defaulting to BIN + Best Offer for flexibility while market data builds."
            HStack(spacing: 12) {
                Image(systemName: "storefront.fill")
                    .font(.title3)
                    .foregroundColor(.purple)
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Format to Sell Online")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text(listingFormat)
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.primary)
                    Text(listingReason)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
                Spacer()
            }
            .padding(14)
            .background(Color(.tertiarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))

            // ── Supply context ─────────────────────────────────────────────
            if let supplyNote = r.supplySignalNote {
                HStack(spacing: 6) {
                    Image(systemName: "chart.bar.fill")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text(supplyNote)
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 2)
            }

            // ── How we got this price (consumer summary) ──────────────────
            VStack(alignment: .leading, spacing: 6) {
                Text("How We Got This Price")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
                Text(pricingSummary(r))
                    .font(.subheadline)
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color(.tertiarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            // ── 30d projection (compact) ─────────────────────────────────
            if let bear = r.bearValue30d, let bull = r.bullValue30d {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.right").font(.caption2).foregroundColor(.red)
                    Text("Bear \(bear.currencyFormatted)").font(.caption).foregroundColor(.secondary)
                    Text("·").foregroundColor(.secondary)
                    Image(systemName: "arrow.up.right").font(.caption2).foregroundColor(.green)
                    Text("Bull \(bull.currencyFormatted)").font(.caption).foregroundColor(.secondary)
                }
            }
        }
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    private func suggestedListNote(_ r: CompIQEstimateResult) -> String {
        guard let markup = r.listingMarkupPct, markup >= 1 else {
            return "Listed at fair market value"
        }
        return "+\(Int(markup))% above fair value — room to negotiate"
    }

    private func pricingSummary(_ r: CompIQEstimateResult) -> String {
        let method = methodLabel(r.method)
        let comps = "\(r.compCount) comp\(r.compCount == 1 ? "" : "s")"
        let regime: String
        if let label = r.marketRegimeLabel {
            regime = label.replacingOccurrences(of: "-", with: " ")
        } else {
            regime = "neutral"
        }
        return "Based on \(comps) using \(method.lowercased()), with current market regime: \(regime)."
    }

    private func trustContextLine(_ r: CompIQEstimateResult) -> String {
        let compText = "Based on \(r.compCount) recent comp\(r.compCount == 1 ? "" : "s")"
        if let age = r.newestCompAge {
            return "\(compText), newest sale \(age)d ago."
        }
        return "\(compText)."
    }

    private func confidenceMeaningLine(_ r: CompIQEstimateResult) -> String {
        let score = r.confidenceScore ?? (r.confidence * 100)
        let label = confidenceLabel(score)

        if let age = r.newestCompAge, age > 21 {
            return "Confidence: \(label) (older comp data lowers certainty)."
        }
        if r.compCount <= 1 {
            return "Confidence: \(label) (limited comp sample)."
        }
        if r.compCount >= 4 {
            return "Confidence: \(label) (enough recent comps for a stable estimate)."
        }
        return "Confidence: \(label)."
    }

    private func confidenceLabel(_ score: Double) -> String {
        if score >= 72 { return "High" }
        if score >= 45 { return "Medium" }
        return "Low"
    }

    private func sellerPriceRow(icon: String, label: String, value: Double?, color: Color, note: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundColor(color)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text(note)
                    .font(.caption2)
                    .foregroundColor(.secondary.opacity(0.7))
            }
            Spacer()
            Text(value?.currencyFormatted ?? "—")
                .font(.title3.weight(.bold))
                .foregroundColor(color)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }


    // Strip the internal tech noise from the summary for display
    private func summaryClean(_ s: String) -> String {
        // Show just the first sentence (up to first " | Method:")
        if let range = s.range(of: " | Method:") {
            return String(s[..<range.lowerBound])
        }
        if let range = s.range(of: " Method:") {
            return String(s[..<range.lowerBound])
        }
        return s
    }

    // MARK: - Layer 2: Breakdown

    private func breakdownSection(_ r: CompIQEstimateResult) -> some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) { showDetails.toggle() }
            } label: {
                HStack {
                    Image(systemName: "function")
                        .font(.body)
                        .foregroundColor(.blue)
                    Text("Detailed Pricing Breakdown")
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(.blue)
                    Spacer()
                    Image(systemName: showDetails ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }

            if showDetails {
                Divider().padding(.leading, 16)

                VStack(spacing: 0) {
                    // Pricing method
                    DetailRow(
                        icon: "doc.text.magnifyingglass",
                        label: "Method",
                        value: methodLabel(r.method),
                        note: r.compCount > 0 ? "\(r.compCount) comp\(r.compCount == 1 ? "" : "s") used" : nil
                    )

                    // Anchor parallel (when not using exact comps)
                    if let anchor = r.anchorParallel, anchor != r.targetParallel {
                        Divider().padding(.leading, 52)
                        DetailRow(
                            icon: "arrow.triangle.2.circlepath",
                            label: "Anchor",
                            value: anchor,
                            note: "converted to \(r.targetParallel)"
                        )
                    }

                    // Neighboring comps note
                    if r.usedNeighboringComps == true, let reason = r.neighborCompReason {
                        Divider().padding(.leading, 52)
                        DetailRow(
                            icon: "arrow.left.arrow.right",
                            label: "Neighbors",
                            value: reason,
                            note: nil,
                            valueFont: .footnote,
                            valueColor: .orange
                        )
                    }

                    // Parallel multiplier
                    if r.multiplierUsed != 1 {
                        Divider().padding(.leading, 52)
                        DetailRow(
                            icon: "arrow.up.left.and.arrow.down.right",
                            label: "Parallel",
                            value: "\(r.multiplierUsed.multiplierFormatted)× multiplier",
                            note: r.targetParallel
                        )
                    }

                    // Grade adjustment
                    if r.gradeAdjustment != 1 {
                        Divider().padding(.leading, 52)
                        DetailRow(
                            icon: "rosette",
                            label: "Grade",
                            value: "\(r.gradeAdjustment.multiplierFormatted)× premium",
                            note: nil
                        )
                    }

                    // Scarcity
                    if abs(r.scarcityAdjustment - 1) >= 0.02 {
                        Divider().padding(.leading, 52)
                        let pct = Int((r.scarcityAdjustment - 1) * 100)
                        DetailRow(
                            icon: "seal",
                            label: "Scarcity",
                            value: "\(pct > 0 ? "+" : "")\(pct)%",
                            note: "numbered card premium"
                        )
                    }

                    // Trend
                    if r.trending == true, let dir = r.trendDirection, let str = r.trendStrength {
                        Divider().padding(.leading, 52)
                        let velStr = r.trendVelocityPct.map { "\(String(format: "%.1f", $0 * 100))% velocity" }
                        DetailRow(
                            icon: dir == "up" ? "arrow.up.right" : "arrow.down.right",
                            label: "Trend",
                            value: "\(dir.capitalized) — \(str)",
                            note: velStr,
                            valueColor: dir == "up" ? .green : .red
                        )
                    }

                    // ML correction
                    if let mlFactor = r.mlCorrectionFactor, abs(mlFactor - 1) >= 0.01,
                       let samples = r.mlSampleCount, samples > 0 {
                        Divider().padding(.leading, 52)
                        let pct = Int((mlFactor - 1) * 100)
                        DetailRow(
                            icon: "brain",
                            label: "ML Model",
                            value: "\(pct > 0 ? "+" : "")\(pct)% correction",
                            note: "\(samples) learned sale\(samples == 1 ? "" : "s")"
                        )
                    }

                    // Player / news signals
                    if let ps = r.playerSignal, ps != "neutral" {
                        Divider().padding(.leading, 52)
                        DetailRow(
                            icon: "person.badge.clock",
                            label: "Player Signal",
                            value: ps.capitalized,
                            note: r.newsSignal.map { $0 != "neutral" ? "\($0.capitalized) news" : nil } ?? nil,
                            valueColor: ps == "positive" ? .green : .red
                        )
                    }

                    // Data freshness
                    if let age = r.newestCompAge, age > 0 {
                        Divider().padding(.leading, 52)
                        let freshLabel = age <= 7 ? "Fresh (< 1 week)" : age <= 14 ? "Recent (\(age)d ago)" : "Stale (\(age)d ago)"
                        DetailRow(
                            icon: "clock",
                            label: "Comp Age",
                            value: freshLabel,
                            note: nil,
                            valueColor: age <= 14 ? .primary : .orange
                        )
                    }

                    // Pricing path bullets
                    if let path = r.pricingPath, !path.isEmpty {
                        Divider().padding(.leading, 16)
                        PricingPathView(steps: path)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.04), radius: 8, x: 0, y: 2)
    }

    private func methodLabel(_ method: String) -> String {
        switch method {
        case "exact-recent-comps":         return "Exact sales found"
        case "anchor-parallel-conversion": return "Cross-parallel conversion"
        case "known-comp-value":           return "Known comp value"
        case "baseline-multiplier-fallback": return "Baseline estimate"
        default: return method.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }
}

// MARK: - Rebuilt Body (solves SwiftUI inputSection / button placement issue)

// MARK: - Supporting Components

struct OutlookPill: View {
    let outlook: String

    var body: some View {
        Text(outlookLabel)
            .font(.caption.weight(.bold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.15))
            .foregroundColor(color)
            .clipShape(Capsule())
    }

    private var outlookLabel: String {
        switch outlook.lowercased() {
        case "buy":   return "BUY"
        case "sell":  return "SELL"
        case "watch": return "WATCH"
        default:      return "HOLD"
        }
    }

    private var color: Color {
        switch outlook.lowercased() {
        case "buy":   return .green
        case "sell":  return .red
        case "watch": return .orange
        default:      return .blue
        }
    }
}

struct InvestmentScoreBadge: View {
    let score: Double
    let rating: String?

    var body: some View {
        VStack(spacing: 1) {
            Text("\(Int(score))")
                .font(.headline.bold())
                .foregroundColor(scoreColor)
            Text(rating?.components(separatedBy: " ").first ?? "Score")
                .font(.system(size: 9))
                .foregroundColor(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(scoreColor.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var scoreColor: Color {
        score >= 75 ? .green : score >= 55 ? .blue : score >= 40 ? .orange : .red
    }
}

struct ConfidenceBar: View {
    let score: Double   // 0–100

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text("Confidence")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Text("\(Int(score))%")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(barColor)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color(.tertiarySystemGroupedBackground))
                        .frame(height: 6)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(barColor)
                        .frame(width: geo.size.width * CGFloat(min(score, 100) / 100), height: 6)
                }
            }
            .frame(height: 6)
        }
    }

    private var barColor: Color {
        score >= 80 ? .green : score >= 60 ? Color(red: 0.85, green: 0.6, blue: 0.1) : .red
    }
}

struct DetailRow: View {
    let icon: String
    let label: String
    let value: String
    let note: String?
    var valueFont: Font = .subheadline
    var valueColor: Color = .primary

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundColor(.secondary)
                .frame(width: 24)
                .padding(.leading, 16)

            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text(value)
                    .font(valueFont)
                    .foregroundColor(valueColor)
                if let note = note {
                    Text(note)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            Spacer()
        }
        .padding(.vertical, 12)
    }
}

struct PricingPathView: View {
    let steps: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "list.number")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Text("Pricing Path")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)

            ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                HStack(alignment: .top, spacing: 10) {
                    if step.hasPrefix("→") {
                        // Final value — highlight it
                        Text(step)
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.primary)
                    } else {
                        Text("  \(idx + 1).")
                            .font(.caption.monospacedDigit())
                            .foregroundColor(.secondary)
                            .frame(width: 28, alignment: .trailing)
                        Text(step)
                            .font(.subheadline)
                            .foregroundColor(.primary)
                    }
                }
                .padding(.horizontal, step.hasPrefix("→") ? 16 : 10)
                .padding(.vertical, 6)
                if idx < steps.count - 1 {
                    Divider().padding(.leading, step.hasPrefix("→") ? 16 : 38)
                }
            }
        }
        .padding(.bottom, 12)
    }
}

// MARK: - Formatting Helpers

private extension Double {
    var currencyFormatted: String {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 0
        return f.string(from: NSNumber(value: self)) ?? "$\(self)"
    }

    var multiplierFormatted: String {
        String(format: "%.2f", self)
            .trimmingCharacters(in: CharacterSet(charactersIn: "0"))
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
    }
}

// MARK: - Market Signal Chips

struct MarketRegimePill: View {
    let label: String

    var body: some View {
        Text(friendlyLabel)
            .font(.caption.weight(.bold))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(pillColor.opacity(0.14))
            .foregroundColor(pillColor)
            .clipShape(Capsule())
    }

    private var friendlyLabel: String {
        switch label.lowercased() {
        case "strong-bull": return "🔥 Hot Market"
        case "bull":        return "↑ Rising Market"
        case "bear":        return "↓ Cooling"
        case "strong-bear": return "❄️ Cold Market"
        default:            return "— Neutral"
        }
    }

    private var pillColor: Color {
        switch label.lowercased() {
        case "strong-bull": return .green
        case "bull":        return Color(red: 0.2, green: 0.65, blue: 0.3)
        case "bear":        return .orange
        case "strong-bear": return .red
        default:            return .secondary
        }
    }
}

struct MomentumPill: View {
    let momentum: String

    var body: some View {
        Text(momentum.lowercased() == "hot" ? "🔥 Active 24h" : "❄️ Slow 24h")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(pillColor.opacity(0.12))
            .foregroundColor(pillColor)
            .clipShape(Capsule())
    }

    private var pillColor: Color {
        momentum.lowercased() == "hot" ? .green : Color(red: 0.3, green: 0.5, blue: 0.9)
    }
}

// MARK: - Preview

#Preview {
    CompIQView()
}
