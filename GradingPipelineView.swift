import SwiftUI

// MARK: - Grading Pipeline Tab
struct GradingPipelineView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    @State private var showAddSubmission = false
    @State private var selectedSubmission: GradingSubmission? = nil

    private var activeSubmissions: [GradingSubmission] {
        vm.gradingSubmissions.filter { $0.status != .addedToPortfolio && $0.status != .returned }
    }
    private var completedSubmissions: [GradingSubmission] {
        vm.gradingSubmissions.filter { $0.status == .addedToPortfolio || $0.status == .returned }
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Color.black.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 20) {
                    gradingHeader
                    summaryMetrics
                    if vm.gradingSubmissions.isEmpty {
                        emptyGradingView
                    } else {
                        if !activeSubmissions.isEmpty {
                            activePipelineSection
                        }
                        if !completedSubmissions.isEmpty {
                            completedSection
                        }
                    }
                    // Grading candidates from inventory
                    gradingCandidatesSection
                    Spacer(minLength: 80)
                }
                .padding(.horizontal)
                .padding(.top, 12)
            }

            // FAB
            Button { showAddSubmission = true } label: {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .bold))
                    Text("Track Submission")
                        .font(.system(size: 14, weight: .semibold))
                }
                .foregroundColor(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Color.purple)
                .clipShape(Capsule())
                .shadow(color: .purple.opacity(0.4), radius: 10, x: 0, y: 4)
            }
            .padding(.trailing, 20)
            .padding(.bottom, 20)
        }
        .sheet(isPresented: $showAddSubmission) {
            AddGradingSubmissionSheet(vm: vm)
                .preferredColorScheme(.dark)
        }
        .sheet(item: $selectedSubmission) { sub in
            GradingSubmissionDetailSheet(submission: sub)
                .preferredColorScheme(.dark)
        }
    }

    // MARK: - Header
    private var gradingHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Grading Pipeline")
                    .font(.title2.weight(.bold))
                    .foregroundColor(.white)
                Text("\(activeSubmissions.count) active · \(completedSubmissions.count) completed")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            Spacer()
            Image(systemName: "seal.fill")
                .font(.system(size: 22))
                .foregroundColor(.purple)
        }
    }

    // MARK: - Summary Metrics
    private var summaryMetrics: some View {
        let totalCost = vm.gradingSubmissions.map { $0.gradingFee + $0.shippingCost }.reduce(0, +)
        let totalDeclared = vm.gradingSubmissions.map { $0.declaredValue }.reduce(0, +)

        return HStack(spacing: 0) {
            GradingMetricTile(label: "Submitted", value: "\(vm.gradingSubmissions.count)", color: .purple)
            Divider().frame(height: 36).background(Color(.systemGray5))
            GradingMetricTile(label: "In Progress", value: "\(activeSubmissions.count)", color: .blue)
            Divider().frame(height: 36).background(Color(.systemGray5))
            GradingMetricTile(label: "Total Fees", value: "$\(Int(totalCost))", color: .orange)
            Divider().frame(height: 36).background(Color(.systemGray5))
            GradingMetricTile(label: "Declared Value", value: "$\(Int(totalDeclared))", color: .white)
        }
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: - Active Pipeline
    private var activePipelineSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("In Progress", systemImage: "arrow.triangle.2.circlepath")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)
            ForEach(activeSubmissions) { sub in
                GradingSubmissionCard(submission: sub, onTap: { selectedSubmission = sub })
            }
        }
    }

    // MARK: - Completed
    private var completedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Completed", systemImage: "checkmark.seal.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)
            ForEach(completedSubmissions) { sub in
                GradingSubmissionCard(submission: sub, onTap: { selectedSubmission = sub })
            }
        }
    }

    // MARK: - Grading Decision Helper (raw cards worth grading)
    private var gradingCandidatesSection: some View {
        let candidates = vm.holdings.filter { $0.isRaw && $0.currentValue > 40 }
            .sorted { $0.currentValue > $1.currentValue }
        return Group {
            if !candidates.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Should I Grade This?", systemImage: "star.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(.white)
                        Text("Break-even analysis for your raw cards")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    ForEach(candidates.prefix(6)) { holding in
                        GradingDecisionCard(holding: holding, onTap: { vm.showDetail = holding })
                    }
                    if candidates.count > 6 {
                        Text("+ \(candidates.count - 6) more raw cards in inventory")
                            .font(.caption)
                            .foregroundColor(.gray)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 4)
                    }
                }
            }
        }
    }

    // MARK: - Empty
    private var emptyGradingView: some View {
        VStack(spacing: 16) {
            Image(systemName: "seal")
                .font(.system(size: 52))
                .foregroundColor(.purple.opacity(0.5))
            Text("No submissions tracked")
                .font(.headline)
                .foregroundColor(.white)
            Text("Tap the button below to start tracking a grading submission.")
                .font(.subheadline)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

// MARK: - Grading Metric Tile
struct GradingMetricTile: View {
    let label: String
    let value: String
    let color: Color
    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .foregroundColor(color)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Submission Card
struct GradingSubmissionCard: View {
    let submission: GradingSubmission
    var onTap: (() -> Void)? = nil

    var body: some View {
        Button(action: { onTap?() }) {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    // Company badge
                    VStack(spacing: 4) {
                        Text(submission.gradingCompany.rawValue.uppercased())
                            .font(.system(size: 10, weight: .black))
                            .foregroundColor(companyColor)
                        Text(submission.serviceLevel)
                            .font(.system(size: 8))
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                    .frame(width: 44)

                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(submission.playerName)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            Spacer()
                            StatusPill(text: submission.status.rawValue,
                                       color: submission.status.color)
                        }
                        Text(submission.cardTitle)
                            .font(.caption)
                            .foregroundColor(.gray)
                            .lineLimit(1)

                        // Pipeline steps
                        PipelineStepsView(currentStatus: submission.status)
                            .padding(.top, 4)
                    }
                }
                .padding(12)

                Divider().background(Color(.systemGray6))

                HStack(spacing: 12) {
                    metaItem(icon: "calendar", text: "Sent \(submission.submissionDate, style: .date)")
                    if let estReturn = submission.estimatedReturnDate {
                        metaItem(icon: "clock", text: "Est. \(estReturn, style: .date)")
                    }
                    Spacer()
                    if let grade = submission.finalGrade {
                        Text(grade)
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(.yellow)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.yellow.opacity(0.15))
                            .clipShape(Capsule())
                    }
                    Text("$\(Int(submission.gradingFee + submission.shippingCost)) total")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .background(Color(.secondarySystemBackground).opacity(0.72))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(submission.status.color.opacity(0.3), lineWidth: 1)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }

    private var companyColor: Color {
        switch submission.gradingCompany {
        case .psa: return Color(red: 0.0, green: 0.45, blue: 0.85)
        case .bgs: return Color(red: 0.85, green: 0.2, blue: 0.2)
        case .sgc: return Color(red: 0.95, green: 0.75, blue: 0.0)
        case .cgc: return Color(red: 0.15, green: 0.7, blue: 0.4)
        default:   return Color(.systemGray2)
        }
    }

    private func metaItem(icon: String, text: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 9))
            Text(text)
                .font(.system(size: 10))
        }
        .foregroundColor(.gray)
    }
}

// MARK: - Pipeline Steps
struct PipelineStepsView: View {
    let currentStatus: GradingPipelineStatus
    private let steps = GradingPipelineStatus.allCases

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                if idx > 0 {
                    Rectangle()
                        .fill(step.stepIndex <= currentStatus.stepIndex ? Color.purple : Color(.systemGray5))
                        .frame(height: 2)
                        .frame(maxWidth: .infinity)
                }
                Circle()
                    .fill(step.stepIndex <= currentStatus.stepIndex ? step.color : Color(.systemGray5))
                    .frame(width: step == currentStatus ? 10 : 7, height: step == currentStatus ? 10 : 7)
                    .overlay(
                        Circle().stroke(step == currentStatus ? step.color : Color.clear, lineWidth: 2)
                            .scaleEffect(1.6)
                    )
            }
        }
        .frame(height: 16)
    }
}


// MARK: - Grade Candidate Row (simple, used in other contexts)
struct GradeCandidateRow: View {
    let holding: PortfolioHolding
    var onTap: (() -> Void)? = nil
    var body: some View {
        Button(action: { onTap?() }) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(holding.playerName)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                    Text(holding.cardTitle)
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("$\(holding.currentValue, specifier: "%.0f")")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.white)
                    Text("Raw · \(holding.conditionEstimate ?? "Unknown")")
                        .font(.caption2)
                        .foregroundColor(Color(.systemGray2))
                }
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .padding(.leading, 4)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemBackground).opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(PlainButtonStyle())
    }
}

// MARK: - Grading Decision Card (break-even helper)
struct GradingDecisionCard: View {
    let holding: PortfolioHolding
    var onTap: (() -> Void)? = nil

    // Standard estimates: PSA economy ~$25, PSA 9 = 2.5× raw, PSA 10 = 5× raw
    private let gradingCost: Double = 25
    private var rawValue: Double { holding.currentValue }
    private var psa9Est: Double { rawValue * 2.5 }
    private var psa10Est: Double { rawValue * 5.0 }
    private var breakEvenGrade: Double {
        guard rawValue > 0 else { return 0 }
        // Simple linear: what multiple covers grading cost
        let neededPremium = rawValue + gradingCost
        return neededPremium / rawValue
    }
    private var psa10Profit: Double { psa10Est - rawValue - gradingCost }
    private var verdict: GradingVerdict {
        if psa10Profit > rawValue * 0.75 { return .strongGrade }
        if psa10Profit > gradingCost * 2  { return .worthConsidering }
        if psa10Profit > 0                { return .marginal }
        return .skipGrading
    }

    enum GradingVerdict {
        case strongGrade, worthConsidering, marginal, skipGrading
        var label: String {
            switch self {
            case .strongGrade:       return "Grade It"
            case .worthConsidering:  return "Worth Considering"
            case .marginal:          return "Marginal"
            case .skipGrading:       return "Skip Grading"
            }
        }
        var color: Color {
            switch self {
            case .strongGrade:      return .green
            case .worthConsidering: return .blue
            case .marginal:         return .orange
            case .skipGrading:      return .red
            }
        }
        var icon: String {
            switch self {
            case .strongGrade:      return "star.fill"
            case .worthConsidering: return "checkmark.circle"
            case .marginal:         return "exclamationmark.circle"
            case .skipGrading:      return "xmark.circle"
            }
        }
    }

    var body: some View {
        Button(action: { onTap?() }) {
            VStack(spacing: 0) {
                // Top: player + verdict badge
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(holding.playerName)
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Text(holding.cardTitle)
                            .font(.caption2)
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                    Spacer()
                    Label(verdict.label, systemImage: verdict.icon)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(verdict.color)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(verdict.color.opacity(0.12))
                        .clipShape(Capsule())
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)

                Divider().background(Color(.systemGray6))

                // Numbers row
                HStack(spacing: 0) {
                    decisionTile(label: "Raw Value",    value: "$\(Int(rawValue))",    color: .white)
                    decisionDivider
                    decisionTile(label: "Grade Cost",   value: "$\(Int(gradingCost))", color: .orange)
                    decisionDivider
                    decisionTile(label: "PSA 9 Est.",   value: "$\(Int(psa9Est))",     color: .blue)
                    decisionDivider
                    decisionTile(label: "PSA 10 Est.",  value: "$\(Int(psa10Est))",    color: .green)
                    decisionDivider
                    decisionTile(label: "10 Profit",
                                 value: "\(psa10Profit >= 0 ? "+" : "")$\(Int(psa10Profit))",
                                 color: psa10Profit >= 0 ? .green : .red)
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 8)
            }
            .background(Color(.secondarySystemBackground).opacity(0.72))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(verdict.color.opacity(0.3), lineWidth: 1)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }

    private var decisionDivider: some View {
        Divider().frame(width: 1, height: 34).background(Color(.systemGray5))
    }

    private func decisionTile(label: String, value: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundColor(color)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.system(size: 8, weight: .medium))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Add Submission Sheet (placeholder)
struct AddGradingSubmissionSheet: View {
    @ObservedObject var vm: PortfolioIQViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var player = ""
    @State private var cardTitle = ""
    @State private var company: GradingCompanyOption = .psa
    @State private var serviceLevel = "Economy"
    @State private var submissionDate = Date()
    @State private var estimatedReturn: Date = Calendar.current.date(byAdding: .day, value: 60, to: Date()) ?? Date()
    @State private var declaredValue = ""
    @State private var gradingFee = ""
    @State private var shippingCost = ""
    @State private var trackingNumber = ""
    @State private var notes = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Card Info") {
                    TextField("Player Name", text: $player)
                    TextField("Card Title", text: $cardTitle)
                }
                Section("Grading") {
                    Picker("Company", selection: $company) {
                        ForEach(GradingCompanyOption.allCases, id: \.self) { c in
                            Text(c.rawValue).tag(c)
                        }
                    }
                    TextField("Service Level (e.g. Economy, Standard)", text: $serviceLevel)
                    DatePicker("Submission Date", selection: $submissionDate, displayedComponents: .date)
                    DatePicker("Est. Return", selection: $estimatedReturn, displayedComponents: .date)
                }
                Section("Costs") {
                    TextField("Declared Value ($)", text: $declaredValue)
                        .keyboardType(.decimalPad)
                    TextField("Grading Fee ($)", text: $gradingFee)
                        .keyboardType(.decimalPad)
                    TextField("Shipping Cost ($)", text: $shippingCost)
                        .keyboardType(.decimalPad)
                }
                Section("Tracking") {
                    TextField("Tracking Number", text: $trackingNumber)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(3)
                }
            }
            .navigationTitle("Track Submission")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let sub = GradingSubmission(
                            id: UUID().uuidString,
                            holdingId: nil,
                            playerName: player,
                            cardTitle: cardTitle,
                            gradingCompany: company,
                            serviceLevel: serviceLevel,
                            submissionDate: submissionDate,
                            estimatedReturnDate: estimatedReturn,
                            declaredValue: Double(declaredValue) ?? 0,
                            gradingFee: Double(gradingFee) ?? 0,
                            shippingCost: Double(shippingCost) ?? 0,
                            trackingNumber: trackingNumber.isEmpty ? nil : trackingNumber,
                            status: .submitted,
                            finalGrade: nil,
                            certNumber: nil,
                            returnedDate: nil,
                            updatedValueAfterGrade: nil,
                            notes: notes.isEmpty ? nil : notes
                        )
                        vm.gradingSubmissions.append(sub)
                        dismiss()
                    }
                    .disabled(player.isEmpty || cardTitle.isEmpty)
                }
            }
            .preferredColorScheme(.dark)
        }
    }
}

// MARK: - Submission Detail Sheet (placeholder)
struct GradingSubmissionDetailSheet: View {
    let submission: GradingSubmission
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(submission.playerName)
                                .font(.title3.weight(.bold))
                                .foregroundColor(.white)
                            Text(submission.cardTitle)
                                .font(.subheadline)
                                .foregroundColor(.gray)
                        }
                        Spacer()
                        StatusPill(text: submission.status.rawValue, color: submission.status.color)
                    }
                    .padding()

                    PipelineStepsView(currentStatus: submission.status)
                        .padding(.horizontal)

                    VStack(spacing: 12) {
                        DetailRow(label: "Company",  value: "\(submission.gradingCompany.rawValue) – \(submission.serviceLevel)")
                        DetailRow(label: "Submitted", value: submission.submissionDate.formatted(.dateTime.month().day().year()))
                        if let est = submission.estimatedReturnDate {
                            DetailRow(label: "Est. Return", value: est.formatted(.dateTime.month().day().year()))
                        }
                        DetailRow(label: "Declared Value", value: "$\(submission.declaredValue, specifier: "%.2f")")
                        DetailRow(label: "Grading Fee",    value: "$\(submission.gradingFee, specifier: "%.2f")")
                        DetailRow(label: "Shipping",       value: "$\(submission.shippingCost, specifier: "%.2f")")
                        DetailRow(label: "Total Cost",     value: "$\((submission.gradingFee + submission.shippingCost), specifier: "%.2f")")
                        if let tracking = submission.trackingNumber {
                            DetailRow(label: "Tracking", value: tracking)
                        }
                        if let grade = submission.finalGrade {
                            DetailRow(label: "Final Grade", value: grade)
                        }
                        if let cert = submission.certNumber {
                            DetailRow(label: "Cert #", value: cert)
                        }
                        if let notes = submission.notes {
                            DetailRow(label: "Notes", value: notes)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("Submission Detail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct DetailRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundColor(.gray)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.medium))
                .foregroundColor(.white)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 4)
    }
}

struct GradingPipelineView_Previews: PreviewProvider {
    static var previews: some View {
        GradingPipelineView(vm: PortfolioIQViewModel())
            .preferredColorScheme(.dark)
    }
}
