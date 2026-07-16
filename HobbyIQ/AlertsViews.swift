//
//  AlertsViews.swift
//  HobbyIQ
//

import Combine
import SwiftUI

@MainActor
final class AlertsInboxViewModel: ObservableObject {
    @Published private(set) var alerts: [AlertItem] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var selectedFilter: AlertFilter = .all

    private let service: OperationalDataService

    init(service: OperationalDataService? = nil) {
        self.service = service ?? OperationalDataService.shared
    }

    var filteredAlerts: [AlertItem] {
        switch selectedFilter {
        case .all:
            return alerts
        case .buy:
            return alerts.filter { $0.severity == .buy }
        case .risk:
            return alerts.filter { $0.severity == .risk }
        case .player:
            return alerts.filter { $0.category == .player }
        case .card:
            return alerts.filter { $0.category == .card }
        }
    }

    func load() async {
        isLoading = true
        errorMessage = nil

        do {
            alerts = try await service.fetchAlerts()
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }
}

@MainActor
final class AlertSettingsViewModel: ObservableObject {
    @Published var preferences = AlertPreferences(
        inAppEnabled: true,
        emailEnabled: false,
        pushEnabled: true,
        watchlistAlertsEnabled: true,
        portfolioAlertsEnabled: true,
        moverAlertsEnabled: true,
        minimumSeverity: .caution
    )
    @Published private(set) var isSaving = false
    @Published var statusMessage: String?

    private let service: OperationalDataService

    init(service: OperationalDataService? = nil) {
        self.service = service ?? OperationalDataService.shared
    }

    func save() async {
        isSaving = true
        statusMessage = nil

        do {
            preferences = try await service.saveAlertPreferences(preferences)
            statusMessage = "Alert preferences saved."
        } catch {
            statusMessage = error.localizedDescription
        }

        isSaving = false
    }
}

struct AlertsInboxView: View {
    @StateObject private var viewModel = AlertsInboxViewModel()
    @State private var alertTab: AlertsTab = .inbox

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                alertsTabControl

                switch alertTab {
                case .inbox:
                    inboxContent
                case .priceAlerts:
                    PriceAlertsView()
                case .advancedRules:
                    AdvancedRulesView()
                }
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Alerts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                NavigationLink {
                    AlertSettingsView()
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .foregroundStyle(Theme.Colors.accent)
                }
            }
            .themedNavigationSurface()
            .task {
                guard viewModel.alerts.isEmpty else { return }
                await viewModel.load()
            }
            .refreshable {
                await viewModel.load()
            }
        }
    }

    private var alertsTabControl: some View {
        HStack(spacing: 4) {
            ForEach(AlertsTab.allCases) { tab in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { alertTab = tab }
                } label: {
                    Text(tab.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(alertTab == tab ? Theme.Colors.textPrimary : Theme.Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background {
                            if alertTab == tab {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(Theme.Colors.accent.opacity(0.18))
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(AppColors.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.vertical, 8)
    }

    private var inboxContent: some View {
        Group {
            if viewModel.isLoading && viewModel.alerts.isEmpty {
                LoadingCardView(
                    title: "Refreshing alerts",
                    message: "Checking for fresh card, player, and portfolio signals."
                )
                .padding(Theme.Spacing.medium)
            } else if let errorMessage = viewModel.errorMessage, viewModel.alerts.isEmpty {
                ErrorStateView(
                    title: "Alerts unavailable",
                    message: errorMessage,
                    retry: { Task { await viewModel.load() } }
                )
                .padding(Theme.Spacing.medium)
            } else if viewModel.filteredAlerts.isEmpty {
                EmptyStateView(
                    title: "No alerts in this filter",
                    message: "Try another filter or wait for the next batch of high-signal market and portfolio changes.",
                    systemImage: "bell.slash",
                    actionTitle: "Refresh"
                ) {
                    Task { await viewModel.load() }
                }
                .padding(Theme.Spacing.medium)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: Theme.Spacing.small) {
                                ForEach(AlertFilter.allCases) { filter in
                                    FilterChipView(
                                        title: filter.rawValue,
                                        isSelected: viewModel.selectedFilter == filter
                                    ) {
                                        viewModel.selectedFilter = filter
                                    }
                                }
                            }
                            .padding(.horizontal, Theme.Spacing.medium)
                        }

                        LazyVStack(spacing: Theme.Spacing.small) {
                            ForEach(viewModel.filteredAlerts) { alert in
                                NavigationLink {
                                    AlertDetailView(alert: alert)
                                } label: {
                                    AlertRow(alert: alert)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, Theme.Spacing.medium)
                        .padding(.bottom, Theme.Spacing.large)
                    }
                }
            }
        }
    }
}

private enum AlertsTab: String, CaseIterable, Identifiable {
    case inbox = "Inbox"
    case priceAlerts = "Alerts"
    case advancedRules = "Rules"

    var id: String { rawValue }
    var title: String { rawValue }
}

// MARK: - Price Alerts CRUD (gated by priceAlerts cap — free=0)

struct PriceAlertsView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var alerts: [PriceAlertItem] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showCreateSheet = false

    private var isCapLocked: Bool {
        if case .limited(0) = sessionViewModel.subscriptionManager.cap(for: .priceAlerts) { return true }
        return false
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                if isCapLocked {
                    VStack(spacing: 10) {
                        Image(systemName: "bell.badge")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(Theme.Colors.accent)
                        Text("Price Alerts")
                            .font(.headline)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Text("Upgrade to Collector+ to create price alerts and get notified when cards hit your target price.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.Colors.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(20)
                    .cardStyle()
                } else {
                    HStack {
                        Text("Price Alerts")
                            .font(.headline)
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Spacer()
                        Button {
                            showCreateSheet = true
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "plus")
                                Text("New Alert")
                            }
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Theme.Colors.accent)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.medium)

                    if isLoading && alerts.isEmpty {
                        LoadingCardView(title: "Loading alerts", message: "Fetching your price alerts…")
                            .padding(.horizontal, Theme.Spacing.medium)
                    } else if let err = errorMessage, alerts.isEmpty {
                        ErrorStateView(title: "Error", message: err, retry: { Task { await loadAlerts() } })
                            .padding(.horizontal, Theme.Spacing.medium)
                    } else if alerts.isEmpty {
                        EmptyStateView(
                            title: "No price alerts",
                            message: "Create a price alert to get notified when a card hits your target price.",
                            systemImage: "bell.slash",
                            actionTitle: "Create Alert"
                        ) {
                            showCreateSheet = true
                        }
                        .padding(.horizontal, Theme.Spacing.medium)
                    } else {
                        LazyVStack(spacing: Theme.Spacing.small) {
                            ForEach(alerts) { alert in
                                PriceAlertRow(alert: alert) {
                                    Task { await deleteAlertItem(alert) }
                                }
                            }
                        }
                        .padding(.horizontal, Theme.Spacing.medium)
                    }
                }
            }
            .padding(.top, Theme.Spacing.small)
            .padding(.bottom, Theme.Spacing.large)
        }
        .task { await loadAlerts() }
        // CF-PAGES-NOT-SHEETS (2026-07-04): create-alert now pushes.
        .navigationDestination(isPresented: $showCreateSheet) {
            CreatePriceAlertSheet { await loadAlerts() }
        }
    }

    private func loadAlerts() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await APIService.shared.fetchPriceAlerts()
            alerts = response.alerts ?? []
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func deleteAlertItem(_ alert: PriceAlertItem) async {
        do {
            _ = try await APIService.shared.deletePriceAlert(alertId: alert.id)
            alerts.removeAll { $0.id == alert.id }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

private struct PriceAlertRow: View {
    let alert: PriceAlertItem
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                if let player = alert.playerName {
                    Text(player)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
                if let card = alert.cardName {
                    Text(card)
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                if let threshold = alert.threshold {
                    Text("Target: \(threshold.currencyStringNoCents)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.Colors.accent)
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                if alert.active == true {
                    Text("Active")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.Colors.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.Colors.accent.opacity(0.12))
                        .clipShape(Capsule())
                } else if alert.triggeredAt != nil {
                    Text("Triggered")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.Colors.caution)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.Colors.caution.opacity(0.12))
                        .clipShape(Capsule())
                }

                Button(action: onDelete) {
                    Image(systemName: "trash")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Colors.negative)
                }
                .buttonStyle(.plain)
            }
        }
        .cardStyle()
    }
}

private struct CreatePriceAlertSheet: View {
    let onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var playerName = ""
    @State private var cardName = ""
    @State private var thresholdText = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Create Price Alert")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.Colors.textPrimary)

                    alertField(title: "Player Name", text: $playerName)
                    alertField(title: "Card Name", text: $cardName)
                    alertField(title: "Target Price", text: $thresholdText, keyboard: .decimalPad)

                    if let err = errorMessage {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(Theme.Colors.negative)
                    }

                    Button("Save Alert") {
                        Task { await save() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isSaving)
                }
                .padding(16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("New Alert")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }

    private func alertField(title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
            TextField(title, text: text)
                .keyboardType(keyboard)
                .padding(12)
                .background(AppColors.surfaceElevated)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(AppColors.border, lineWidth: 1.4))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
    }

    private func save() async {
        guard let threshold = Double(thresholdText.trimmingCharacters(in: .whitespacesAndNewlines)), threshold > 0 else {
            errorMessage = "Enter a valid target price."
            return
        }
        let trimmedPlayer = playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPlayer.isEmpty else {
            errorMessage = "Enter a player name."
            return
        }

        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let request = CreateAlertRequest(
                type: "price",
                playerName: trimmedPlayer,
                cardName: cardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : cardName.trimmingCharacters(in: .whitespacesAndNewlines),
                threshold: threshold
            )
            _ = try await APIService.shared.createAlert(request)
            await onSaved()
            dismiss()
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Advanced Alert Rules (gated advancedAlerts / investor+)

struct AdvancedRulesView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var rules: [AdvancedAlertRule] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showCreateSheet = false
    @State private var showUpgradePaywall = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                HStack {
                    Text("Advanced Rules")
                        .font(.headline)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Spacer()
                    Button {
                        showCreateSheet = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus")
                            Text("New Rule")
                        }
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.Colors.accent)
                    }
                }
                .padding(.horizontal, Theme.Spacing.medium)

                if isLoading && rules.isEmpty {
                    LoadingCardView(title: "Loading rules", message: "Fetching advanced alert rules…")
                        .padding(.horizontal, Theme.Spacing.medium)
                } else if let err = errorMessage, rules.isEmpty {
                    ErrorStateView(title: "Error", message: err, retry: { Task { await loadRules() } })
                        .padding(.horizontal, Theme.Spacing.medium)
                } else if rules.isEmpty {
                    EmptyStateView(
                        title: "No advanced rules",
                        message: "Create rules to get alerts based on predicted direction, TrendIQ signals, and confidence thresholds.",
                        systemImage: "bolt.shield",
                        actionTitle: "Create Rule"
                    ) {
                        showCreateSheet = true
                    }
                    .padding(.horizontal, Theme.Spacing.medium)
                } else {
                    LazyVStack(spacing: Theme.Spacing.small) {
                        ForEach(rules) { rule in
                            AdvancedRuleRow(rule: rule, onDelete: { Task { await deleteRule(rule) } })
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.medium)
                }
            }
            .padding(.top, Theme.Spacing.small)
            .padding(.bottom, Theme.Spacing.large)
        }
        .lockedOverlay(
            feature: GatedFeature.advancedAlerts,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(sessionViewModel: sessionViewModel)
        }
        .task { await loadRules() }
        // CF-PAGES-NOT-SHEETS (2026-07-04): create-rule now pushes.
        .navigationDestination(isPresented: $showCreateSheet) {
            CreateAdvancedRuleSheet { await loadRules() }
        }
    }

    private func loadRules() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await APIService.shared.fetchAdvancedRules()
            rules = response.rules ?? []
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func deleteRule(_ rule: AdvancedAlertRule) async {
        do {
            _ = try await APIService.shared.deleteAdvancedRule(ruleId: rule.id)
            rules.removeAll { $0.id == rule.id }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

private struct AdvancedRuleRow: View {
    let rule: AdvancedAlertRule
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(rule.name ?? "Untitled Rule")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Theme.Colors.textPrimary)
                Spacer()
                if rule.active == true {
                    Text("Active")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.Colors.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.Colors.accent.opacity(0.12))
                        .clipShape(Capsule())
                } else {
                    Text("Paused")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.Colors.textSecondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.Colors.textSecondary.opacity(0.12))
                        .clipShape(Capsule())
                }
            }

            HStack(spacing: 6) {
                if let scope = rule.scope {
                    Text("Scope: \(scope)")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                if let scopeVal = rule.scopeValue {
                    Text("(\(scopeVal))")
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }

            if let conditions = rule.conditions, !conditions.isEmpty {
                let combLabel = rule.combinator?.uppercased() ?? "AND"
                Text("\(conditions.count) condition\(conditions.count == 1 ? "" : "s") (\(combLabel))")
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.accent)

                ForEach(Array(conditions.enumerated()), id: \.offset) { _, cond in
                    conditionLabel(cond)
                }
            }

            HStack {
                if let cooldown = rule.cooldownMinutes {
                    Text("Cooldown: \(cooldown)m")
                        .font(.caption2)
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
                Spacer()
                Button(action: onDelete) {
                    Image(systemName: "trash")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Colors.negative)
                }
                .buttonStyle(.plain)
            }
        }
        .cardStyle()
    }

    private func conditionLabel(_ cond: AdvancedAlertCondition) -> some View {
        let label: String = {
            if let eq = cond.equals { return "\(cond.type): \(eq)" }
            if let op = cond.op, let val = cond.value { return "\(cond.type) \(op) \(val)" }
            if let val = cond.value { return "\(cond.type): \(val)" }
            return cond.type
        }()
        return Text(label)
            .font(.caption2.weight(.medium))
            .foregroundStyle(Theme.Colors.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(AppColors.surfaceElevated)
            .clipShape(Capsule())
    }
}

// MARK: - Create Advanced Rule Sheet

private struct CreateAdvancedRuleSheet: View {
    let onSaved: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var scope: AdvancedAlertScope = .player
    @State private var scopeValue = ""
    @State private var combinator = "AND"
    @State private var cooldownText = "60"
    @State private var conditions: [EditableCondition] = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Create Advanced Rule")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.Colors.textPrimary)

                    ruleField(title: "Rule Name", text: $name)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Scope")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Picker("Scope", selection: $scope) {
                            ForEach(AdvancedAlertScope.allCases) { s in
                                Text(s.displayName).tag(s)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    if scope == .card || scope == .player {
                        ruleField(title: scope == .card ? "Card Name" : "Player Name", text: $scopeValue)
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Combinator")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.Colors.textPrimary)
                        Picker("Combinator", selection: $combinator) {
                            Text("AND").tag("AND")
                            Text("OR").tag("OR")
                        }
                        .pickerStyle(.segmented)
                    }

                    ruleField(title: "Cooldown (minutes)", text: $cooldownText, keyboard: .numberPad)

                    // Conditions
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Conditions")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.Colors.textPrimary)
                            Spacer()
                            Button {
                                conditions.append(EditableCondition())
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "plus")
                                    Text("Add")
                                }
                                .font(.caption.weight(.bold))
                                .foregroundStyle(Theme.Colors.accent)
                            }
                        }

                        if conditions.isEmpty {
                            Text("Add at least one condition.")
                                .font(.caption)
                                .foregroundStyle(Theme.Colors.textSecondary)
                        }

                        ForEach(Array(conditions.enumerated()), id: \.element.id) { idx, _ in
                            ConditionEditor(condition: $conditions[idx]) {
                                conditions.remove(at: idx)
                            }
                        }
                    }

                    if let err = errorMessage {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(Theme.Colors.negative)
                    }

                    Button("Create Rule") {
                        Task { await save() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isSaving || conditions.isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("New Rule")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.Colors.textSecondary)
                }
            }
        }
    }

    private func ruleField(title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.Colors.textPrimary)
            TextField(title, text: text)
                .keyboardType(keyboard)
                .padding(12)
                .background(AppColors.surfaceElevated)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(AppColors.border, lineWidth: 1.4))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .foregroundStyle(Theme.Colors.textPrimary)
        }
    }

    private func save() async {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            errorMessage = "Enter a rule name."
            return
        }
        guard !conditions.isEmpty else {
            errorMessage = "Add at least one condition."
            return
        }

        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        let apiConditions = conditions.map { c in
            AdvancedAlertCondition(
                type: c.type.rawValue,
                equals: c.type.usesEquals ? c.equalsValue : nil,
                op: c.type.usesOp ? c.opValue : nil,
                value: (c.type.usesOp || c.type.usesValueOnly) ? Double(c.valueText) : nil
            )
        }

        let request = AdvancedAlertCreateRequest(
            name: trimmedName,
            scope: scope.rawValue,
            scopeValue: (scope == .card || scope == .player) ? scopeValue.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            conditions: apiConditions,
            combinator: combinator,
            cooldownMinutes: Int(cooldownText)
        )

        do {
            _ = try await APIService.shared.createAdvancedRule(request)
            await onSaved()
            dismiss()
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

private struct EditableCondition: Identifiable {
    let id = UUID()
    var type: AdvancedAlertConditionType = .predictedDirection
    var equalsValue: String = "up"
    var opValue: String = "gte"
    var valueText: String = ""
}

private struct ConditionEditor: View {
    @Binding var condition: EditableCondition
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("Type", selection: $condition.type) {
                    ForEach(AdvancedAlertConditionType.allCases) { t in
                        Text(t.displayName).tag(t)
                    }
                }
                .pickerStyle(.menu)

                Spacer()

                Button(action: onRemove) {
                    Image(systemName: "minus.circle.fill")
                        .foregroundStyle(Theme.Colors.negative)
                }
                .buttonStyle(.plain)
            }

            switch condition.type {
            case .predictedDirection:
                Picker("Direction", selection: $condition.equalsValue) {
                    Text("Up").tag("up")
                    Text("Down").tag("down")
                }
                .pickerStyle(.segmented)

            case .predictedPctMove, .trendiqComposite:
                HStack(spacing: 10) {
                    Picker("Op", selection: $condition.opValue) {
                        Text("≥").tag("gte")
                        Text("≤").tag("lte")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 100)

                    TextField("Value", text: $condition.valueText)
                        .keyboardType(.decimalPad)
                        .padding(10)
                        .background(AppColors.surfaceElevated)
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(AppColors.border, lineWidth: 1.2))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }

                Text(condition.type.configDescription)
                    .font(.caption2)
                    .foregroundStyle(Theme.Colors.textSecondary)

            case .trendiqCoverageMin, .confidenceMin:
                HStack(spacing: 10) {
                    TextField("Value", text: $condition.valueText)
                        .keyboardType(.decimalPad)
                        .padding(10)
                        .background(AppColors.surfaceElevated)
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(AppColors.border, lineWidth: 1.2))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .foregroundStyle(Theme.Colors.textPrimary)
                }

                Text(condition.type.configDescription)
                    .font(.caption2)
                    .foregroundStyle(Theme.Colors.textSecondary)
            }
        }
        .padding(12)
        .background(AppColors.surfaceElevated)
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(AppColors.border, lineWidth: 1.2))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct AlertRow: View {
    let alert: AlertItem

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(alert.title)
                        .font(.headline)
                        .foregroundStyle(Theme.Colors.textPrimary)
                    Text(alert.summary)
                        .font(.subheadline)
                        .secondaryTextStyle()
                }

                Spacer()

                severityPill
            }

            HStack(spacing: Theme.Spacing.small) {
                if let actionLabel = alert.actionLabel {
                    // CF-IOS-DIRECTION-SWEEP (2026-06-18): pill relabeled
                    // "Action" → "Comp basis" so the label agrees with
                    // the new value (card.method — comp-status fact,
                    // not action recommendation).
                    MetricPillView(title: "Comp basis", value: actionLabel, accent: severityColor)
                }
                MetricPillView(
                    title: "Time",
                    value: RelativeDateTimeFormatter().localizedString(for: alert.triggeredAt, relativeTo: Date())
                )
            }
        }
        .cardStyle()
    }

    private var severityPill: some View {
        Text(alert.severity.rawValue)
            .font(.caption.weight(.bold))
            .foregroundStyle(severityColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(severityColor.opacity(0.14))
            .clipShape(Capsule())
    }

    private var severityColor: Color {
        switch alert.severity {
        case .buy:
            return Theme.Colors.accent
        case .caution:
            return Theme.Colors.caution
        case .risk:
            return Theme.Colors.negative
        case .info:
            return Theme.Colors.textSecondary
        }
    }
}

struct AlertDetailView: View {
    let alert: AlertItem

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.medium) {
                SectionCardView(title: alert.title, subtitle: alert.summary) {
                    HStack {
                        Text(alert.severity.rawValue)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(severityColor)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(severityColor.opacity(0.14))
                            .clipShape(Capsule())

                        Spacer()

                        if let confidence = alert.confidence {
                            MetricPillView(title: Labels.confidence, value: "\(confidence)%", accent: Theme.Colors.accent)
                        }
                    }

                    Text(alert.detail)
                        .font(.subheadline)
                        .secondaryTextStyle()
                }

                if let changeSummary = alert.changeSummary {
                    SectionCardView(title: "What Changed") {
                        Text(changeSummary)
                            .font(.subheadline)
                            .secondaryTextStyle()
                    }
                }

                SectionCardView(title: "Why Now") {
                    VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                        if let significance = alert.significance {
                            MetricPillView(title: "Significance", value: significance, accent: severityColor)
                        }
                        if let actionLabel = alert.actionLabel {
                            // CF-IOS-DIRECTION-SWEEP (2026-06-18): pill
                            // relabeled "Suggested Action" → "Comp basis".
                            MetricPillView(title: "Comp basis", value: actionLabel, accent: severityColor)
                        }
                        Text(RelativeDateTimeFormatter().localizedString(for: alert.triggeredAt, relativeTo: Date()))
                            .font(.caption)
                            .secondaryTextStyle()
                    }
                }
            }
            .padding(Theme.Spacing.medium)
            .padding(.bottom, Theme.Spacing.large)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Alert")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    private var severityColor: Color {
        switch alert.severity {
        case .buy:
            return Theme.Colors.accent
        case .caution:
            return Theme.Colors.caution
        case .risk:
            return Theme.Colors.negative
        case .info:
            return Theme.Colors.textSecondary
        }
    }
}

struct AlertSettingsView: View {
    @StateObject private var viewModel = AlertSettingsViewModel()

    var body: some View {
        Form {
            Section("Channels") {
                Toggle("In-App", isOn: $viewModel.preferences.inAppEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Email", isOn: $viewModel.preferences.emailEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Push", isOn: $viewModel.preferences.pushEnabled)
                    .tint(Theme.Colors.accent)
            }

            Section("Scopes") {
                Toggle("Watchlist alerts", isOn: $viewModel.preferences.watchlistAlertsEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Portfolio alerts", isOn: $viewModel.preferences.portfolioAlertsEnabled)
                    .tint(Theme.Colors.accent)
                Toggle("Mover alerts", isOn: $viewModel.preferences.moverAlertsEnabled)
                    .tint(Theme.Colors.accent)
            }

            Section("Minimum Severity") {
                Picker("Minimum Severity", selection: $viewModel.preferences.minimumSeverity) {
                    ForEach(AlertSeverity.allCases) { severity in
                        Text(severity.rawValue).tag(severity)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section {
                Button(viewModel.isSaving ? "Saving..." : "Save Preferences") {
                    Task { await viewModel.save() }
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isSaving)
            }

            if let statusMessage = viewModel.statusMessage {
                Section {
                    Text(statusMessage)
                        .font(.subheadline)
                        .foregroundStyle(Theme.Colors.textPrimary)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background { HobbyIQBackground() }
        .navigationTitle("Alert Settings")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }
}

#Preview {
    AlertsInboxView()
}
