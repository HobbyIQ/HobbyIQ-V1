//
//  PortfolioIQView.swift
//  HobbyIQ
//

import SwiftUI
import UIKit

struct PortfolioIQView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    let onSwitchToInventory: (PortfolioInventoryFilter) -> Void

    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    /// P0.7 delta (2026-07-16): consumes `appState.pendingRoute` so a
    /// `hobbyiq://holding/<uuid>` deep-link (e.g. from a verdict-flip
    /// push notification) pushes the holding detail sheet.
    @EnvironmentObject private var appState: AppState
    @State private var selectedCard: InventoryCard?
    @State private var showingLedger = false
    @State private var showCalibration = false
    @State private var showWeeklyBrief = false
    @State private var showBatchReprice = false
    @State private var showCardIdentify = false
    @State private var topMoversExpanded = false
    /// S3.5 (2026-07-17): Going Up vs Going Down toggle on the Biggest
    /// Changes section. Default = Up.
    @State private var moversDirection: MoversDirection = .up

    enum MoversDirection: String, CaseIterable, Identifiable {
        case up, down
        var id: String { rawValue }
        var label: String { self == .up ? "Going Up" : "Going Down" }
    }
    @State private var priorityActionsExpanded = false
    /// CF-PRIORITY-DRILLDOWN (2026-07-06): tapping a priority action
    /// pushes a dedicated `PriorityActionListView` for that action's
    /// filtered card subset instead of switching to the Inventory tab.
    @State private var selectedPriorityAction: PortfolioPriorityAction?

    // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): scoped to this view because
    // the card's loading/error/refresh story is independent of the hot
    // inventory path. The hero renders immediately from `vm.inventoryCards`
    // via `InventoryDisplayAggregate`; the card lazy-loads its own data.
    @StateObject private var collectionValueViewModel = CollectionValueViewModel()

    // CF-IOS-EXPORT-BUILD (2026-06-21): holdings export state.
    // `isExporting` gates the format chooser to prevent double-fire
    // while the request is in flight. `exportFileURL` is the temp file
    // the share sheet presents (reuses the file-system / temp dir
    // idiom from the ERP exports); cleared on share-sheet dismiss.
    @State private var showExportFormatChooser = false
    @State private var isExporting = false
    @State private var exportFileURL: URL?
    @State private var showExportShareSheet = false
    @State private var exportErrorMessage: String?
    @State private var showExportError = false

    // CF-IOS-IMPORT-BUILD (2026-06-21): holdings import sheet state.
    @State private var showHoldingsImport = false

    // CF-EBAY-REVIEW-QUEUE (backend PRs #383-#388): pending-review queue
    // pushed from the "Review needed (N)" header entry.
    @State private var showPendingReview = false

    // PR #425 (2026-07-13): Supply/Demand aggregates for the two new
    // Portfolio Home cards. Both load on task; nil / empty responses
    // suppress the card entirely.
    @State private var supplyDemandSummary: SupplyDemandSummaryResponse?
    @State private var signalWeightedTotals: SignalWeightedTotalsResponse?
    /// Corpus signals (2026-07-17, PR #518): gate the drill-down push
    /// from the grade-worthy banner.
    @State private var showGradeWorthyList = false
    /// Phase 2.6 (2026-07-17, PR #529): value-weighted portfolio-level
    /// momentum. Loaded on portfolio open with a 6h TTL; nil / thin
    /// response hides the hero.
    @State private var portfolioMomentum: PortfolioMomentumResponse?
    /// Phase 3.8 (2026-07-17, PR #527): cascade events for players Drew
    /// owns. Loaded on portfolio open with a 30-min TTL. Empty events
    /// array hides the banner.
    @State private var cascadeAlerts: CascadeAlertsResponse?
    /// Phase 3.8: gate the drill-down push from the cascade banner.
    @State private var showCascadeList = false
    /// PR #548 (2026-07-17): engine-accuracy trust badge under the total
    /// portfolio value. 6h in-memory TTL — only re-fetches when the
    /// timestamp is nil or older than the window.
    @State private var backtestAccuracy: PredictedPriceAccuracyResponse?
    @State private var backtestAccuracyLoadedAt: Date?
    @State private var showBacktestSheet = false
    private static let backtestAccuracyTTL: TimeInterval = 6 * 60 * 60

    var body: some View {
        // CF-BACK-NAV-FIX (2026-07-06): removed a nested NavigationView here.
        // MainAppView already wraps PortfolioIQView in a NavigationStack, so
        // the inner NavigationView double-nested the navigation containers —
        // pushing into `.navigationDestination(item:)` and then tapping back
        // was popping past the tab root (perceived as jumping to Dashboard).
        // Matches the pattern InventoryIQView already follows for the same
        // reason (see its CF-TABBAR-PERSISTENT comment).
        ZStack {
                background

                if vm.summary == nil && vm.isLoading {
                    loadingState
                } else if vm.summary == nil, let errorMessage = vm.errorMessage {
                    errorState(message: errorMessage)
                } else {
                    ScrollView(showsIndicators: false) {
                        VStack(spacing: 16) {
                            header

                            // PR #548 (2026-07-17): engine-accuracy trust
                            // badge sits directly under the total portfolio
                            // value. Self-suppresses on insufficient sample
                            // or nil response.
                            backtestAccuracyBadge

                            // PR #554 (2026-07-17): per-verdict hit-rate
                            // pill. Self-suppresses until 5+ verdicts have
                            // been logged and the read route is live.
                            EngineHitRatePill()

                            if let errorMessage = vm.errorMessage {
                                warningBanner(message: errorMessage)
                            }

                            if vm.pendingReviewHoldings.isEmpty == false {
                                PendingReviewEntryButton(count: vm.pendingReviewHoldings.count) {
                                    showPendingReview = true
                                }
                            }

                            // PR #425: portfolio-wide supply/demand read
                            // + verdict-class-weighted totals. Each card
                            // self-suppresses on empty / thin data.
                            supplyDemandDashboardCard
                            signalWeightedTotalsCard

                            // Corpus signals (2026-07-17, PR #518):
                            // portfolio-wide grade-worthy scan banner.
                            // Self-suppresses when count is zero or the
                            // backend hasn't returned yet.
                            gradeWorthyBanner

                            // Phase 2.6 (2026-07-17, PR #529): value-
                            // weighted portfolio momentum hero.
                            portfolioMomentumHero

                            // Phase 3.8 (2026-07-17, PR #527): cascade
                            // banner — only shows when there's a fired event.
                            cascadeBanner

                            portfolioToolsRow

                            topMoversSection

                            if !vm.priorityActions.isEmpty {
                                priorityActionsSection
                            }

                            valueTrendSection
                        }
                        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                        .padding(.top, 8)
                        .padding(.bottom, 24)
                    }
                    .refreshable {
                        await vm.refresh()
                        await collectionValueViewModel.refresh()
                        await loadSupplyDemandAggregates()
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 88)
            }
            .toolbar(.hidden, for: .navigationBar)
            .task {
                await collectionValueViewModel.load()
                await loadSupplyDemandAggregates()
                await loadBacktestAccuracyIfStale()
                // 2026-07-19 (card-show batch): push permission ask
                // moved here from DailyIQ per spec — Portfolio is the
                // first paint that carries clear value for sell-side
                // alerts, so it's the honest moment to ask.
                await PushNotificationManager.shared.askIfFirstMeaningfulUse()
            }
            .sheet(isPresented: $showBacktestSheet) {
                if let response = backtestAccuracy {
                    BacktestAccuracySheet(response: response)
                }
            }
            // P0.7 delta (2026-07-16, verdict-history-flip-surfaces.md):
            // consume `appState.pendingRoute` when it names a holding UUID.
            // Fires on initial deep-link land AND on subsequent pushes
            // received while the app is running. Awaits `vm.inventoryCards`
            // being non-empty via `.onChange` so a cold-launch deep-link
            // opens the sheet after the initial portfolio fetch completes.
            .onChange(of: appState.pendingRoute) { _, newRoute in
                consumePendingRoute(newRoute)
            }
            .onChange(of: vm.inventoryCards) { _, _ in
                consumePendingRoute(appState.pendingRoute)
            }
            .onAppear {
                consumePendingRoute(appState.pendingRoute)
            }
            .navigationDestination(isPresented: $showingLedger) {
                PortfolioLedgerSheet(viewModel: vm)
            }
            // CF-ENV-OBJECT-FIX (2026-07-04): `.navigationDestination`
            // doesn't propagate `@EnvironmentObject` to the pushed view.
            .navigationDestination(item: $selectedCard) { card in
                PortfolioHoldingDetailSheet(
                    viewModel: vm,
                    card: card,
                    onUpdated: {
                        Task { await vm.refresh() }
                    },
                    onBack: { selectedCard = nil }
                )
                .environmentObject(sessionViewModel)
            }
            // CF-PRIORITY-DRILLDOWN (2026-07-06): push a dedicated page
            // for the tapped priority action instead of jumping tabs.
            // Uses `isPresented:` (not `item:`) because SwiftUI misbehaves
            // when multiple `.navigationDestination(item:)` modifiers are
            // stacked with different item types on the same NavigationStack.
            .navigationDestination(
                isPresented: Binding(
                    get: { selectedPriorityAction != nil },
                    set: { if !$0 { selectedPriorityAction = nil } }
                )
            ) {
                if let action = selectedPriorityAction {
                    PriorityActionListView(vm: vm, action: action)
                        .environmentObject(sessionViewModel)
                }
            }
            .navigationDestination(isPresented: $showCalibration) {
                CalibrationView()
                    .environmentObject(sessionViewModel)
            }
            .navigationDestination(isPresented: $showGradeWorthyList) {
                GradeWorthyListView(vm: vm)
                    .environmentObject(sessionViewModel)
            }
            .navigationDestination(isPresented: $showCascadeList) {
                CascadeAlertsListView(alerts: cascadeAlerts)
                    .environmentObject(sessionViewModel)
            }
            .navigationDestination(isPresented: $showWeeklyBrief) {
                WeeklyBriefView()
                    .environmentObject(sessionViewModel)
            }
            .navigationDestination(isPresented: $showBatchReprice) {
                BatchRepriceView()
                    .environmentObject(sessionViewModel)
            }
            // CF-IOS-EXPORT-BUILD (2026-06-21): share-sheet present after
            // the export bytes are written to a temp file. Reuses the
            // existing private LedgerShareSheet wrapper :1441 — generic
            // UIActivityViewController(activityItems: [url]).
            .sheet(isPresented: $showExportShareSheet) {
                if let url = exportFileURL {
                    LedgerShareSheet(url: url)
                }
            }
            .confirmationDialog(
                "Export holdings",
                isPresented: $showExportFormatChooser,
                titleVisibility: .visible
            ) {
                Button("Excel (.xlsx)") { Task { await runHoldingsExport(format: "xlsx") } }
                Button("CSV (.csv)") { Task { await runHoldingsExport(format: "csv") } }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("Choose the export format. The file will be written and shared via the system share sheet.")
            }
            .alert("Export failed", isPresented: $showExportError, presenting: exportErrorMessage) { _ in
                Button("OK", role: .cancel) { }
            } message: { message in
                Text(message)
            }
            // CF-IOS-IMPORT-BUILD (2026-06-21): import sheet.
            .navigationDestination(isPresented: $showHoldingsImport) {
                HoldingsImportView()
                    .environmentObject(sessionViewModel)
            }
            // CF-EBAY-REVIEW-QUEUE (backend PRs #383-#388): review queue.
            .navigationDestination(isPresented: $showPendingReview) {
                PendingReviewQueueView(viewModel: vm)
                    .environmentObject(sessionViewModel)
            }
            .scanFlow(isPresented: $showCardIdentify, sessionViewModel: sessionViewModel)
            .onAppear {
                if vm.summary == nil {
                    Task { await vm.load() }
                } else {
                    // CF-EBAY-REVIEW-QUEUE: refresh the pending queue
                    // on every appear so the badge stays honest across
                    // tab switches even when `summary` is cached and
                    // full `load()` is skipped.
                    Task { await vm.fetchPendingReview() }
                }
            }
    }

    // S3.4 (2026-07-17): consolidated CTAs — primary "Reprice All" pill
    // + 3 icon secondaries (Scan / Import / Export). Weekly Brief +
    // Calibration moved to a kebab overflow menu in the top-right of
    // the tools row so they're one tap from discovery without competing
    // with the primary flow.
    private var portfolioToolsRow: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                // Primary — full-width accent pill.
                HIQActionPill(
                    title: "Reprice All",
                    icon: "arrow.triangle.2.circlepath",
                    action: { showBatchReprice = true }
                )
                // Overflow — Weekly Brief + Calibration
                Menu {
                    Button {
                        showWeeklyBrief = true
                    } label: {
                        Label("Weekly Brief", systemImage: "newspaper")
                    }
                    Button {
                        showCalibration = true
                    } label: {
                        Label("Calibration", systemImage: "scope")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .frame(width: 40, height: 44)
                        .background(HobbyIQTheme.Colors.cardNavy)
                        .overlay(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
                }
                .accessibilityLabel("More portfolio actions")
            }

            // Secondary — 3 evenly-spaced icon + caption tiles.
            HStack(alignment: .top, spacing: 8) {
                portfolioSecondaryTile(icon: "camera.viewfinder", caption: "Scan Card") {
                    showCardIdentify = true
                }
                portfolioSecondaryTile(icon: "square.and.arrow.down", caption: "Import file") {
                    showHoldingsImport = true
                }
                portfolioSecondaryTile(
                    icon: isExporting ? "hourglass" : "square.and.arrow.up",
                    caption: isExporting ? "Exporting…" : "Export"
                ) {
                    guard isExporting == false else { return }
                    showExportFormatChooser = true
                }
            }
        }
    }

    /// S3.4 (2026-07-17): shared icon-and-caption secondary tile for
    /// the portfolio-home tools row. Icon-primary treatment with 11pt
    /// caption so the buttons read as secondary vs the Reprice All pill.
    @ViewBuilder
    private func portfolioSecondaryTile(icon: String, caption: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(width: 40, height: 40)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(Circle())
                Text(caption)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // CF-IOS-EXPORT-BUILD (2026-06-21): run the export request, write
    // the bytes verbatim to a temp file, present the share sheet. iOS
    // never inspects the body — it's transport only.
    private func runHoldingsExport(format: String) async {
        isExporting = true
        defer { isExporting = false }
        do {
            let payload = try await APIService.shared.fetchExportFile(format: format)
            let filename = payload.suggestedFilename ?? defaultExportFilename(for: format)
            let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
            // .write(to:options:) replaces silently — repeated exports
            // overwrite the same temp slot rather than accumulating
            // garbage in tmpdir.
            try payload.data.write(to: tempURL, options: .atomic)
            exportFileURL = tempURL
            showExportShareSheet = true
        } catch {
            exportErrorMessage = APIService.errorMessage(from: error)
            showExportError = true
        }
    }

    /// Fallback filename when the backend's `Content-Disposition` header
    /// is missing or malformed. Uses YYYY-MM-DD in UTC so two devices
    /// exporting on the same day produce the same name. The extension
    /// must match the requested format so the share sheet's "Open in
    /// Numbers" affordance picks the right UTType.
    private func defaultExportFilename(for format: String) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let datestamp = formatter.string(from: Date())
        let ext = format == "csv" ? "csv" : "xlsx"
        return "hobbyiq-holdings-\(datestamp).\(ext)"
    }

    // CF-SHARED-CARDS-2026-07-11: `portfolioToolButton` moved to
    // `HIQActionPill` in `DesignSystem/HIQSharedCards.swift` so Financials
    // (and any future tab) can render the same pill without forking.

    private var background: some View {
        HobbyIQBackground()
    }

    private var loadingState: some View {
        ProgressView()
            .tint(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(.orange)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color(hex: 0xD1D5DB))
                .multilineTextAlignment(.center)

            Button("Retry") {
                Task { await vm.load() }
            }
            .buttonStyle(.bordered)
            .tint(Color(hex: 0x3B82F6))
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Hero Card

    private var header: some View {
        let summary = vm.heroSummary
        // Reaggregate at render time on the priced subset so the displayed
        // dollar number, P/L, and ROI reconcile honestly. The producer sums
        // on `summary` are left untouched for non-hero consumers (P/L logic
        // stays stable across the seven sum sites — this is display-only).
        let agg = InventoryDisplayAggregate(holdings: vm.inventoryCards)
        // 2026-07-18 canonical-FMV migration: sum via `vm.marketValue(for:)`
        // so the hero total tracks the canonical cache as it fills.
        // Falls back to `displayValueIncludingEstimated` (legacy priced +
        // estimated bucket) when inventory hasn't loaded yet AND the
        // cached-first-paint total is stale.
        let canonicalTotal = vm.inventoryCards.reduce(0.0) { sum, card in
            sum + vm.marketValue(for: card)
        }
        let heroValue: Double = {
            if canonicalTotal > 0 { return canonicalTotal }
            if let cached = vm.cachedPortfolioTotal, cached > 0 { return cached }
            return agg.displayValueIncludingEstimated
        }()
        let heroCost = agg.displayCostIncludingEstimated
        // Recompute P/L against the actual displayed heroValue so the
        // delta chip stays consistent with the headline number.
        let heroPL = heroValue - heroCost
        let heroROI = heroCost > 0 ? ((heroValue - heroCost) / heroCost) * 100 : 0
        let pnlColor: Color = heroPL >= 0 ? .green : .red
        let hasCostBasis = heroCost > 0
        // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): split unpriced into
        // "N estimated · M pending" via the aggregate helper.
        let unpricedSuffix = agg.unpricedSubtitleSuffix
        let pricedQualifier = agg.unpricedCount > 0 ? " (of \(agg.pricedCount) priced)" : ""

        // S3.6 (2026-07-17): statusDate → relative "Updated 2h ago" style
        // instead of a "Jul 17" absolute stamp.
        let statusLabel = relativeUpdatedLabel(from: summary.lastRefreshText)

        return HIQHeroCard(
            title: "Portfolio", // S3.1 rename — matches the tab
            statusDate: statusLabel,
            heroValue: heroValue.portfolioCurrencyText,
            trailing: {
                // S3.7: labelled Learn button around the book icon so
                // users know what it opens.
                VStack(spacing: 3) {
                    Button {
                        showingLedger = true
                    } label: {
                        Image(systemName: "book.closed")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .frame(width: 40, height: 40)
                            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
                            .clipShape(Circle())
                            .overlay(
                                Circle()
                                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
                            )
                    }
                    .buttonStyle(.plain)
                    Text("Ledger")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .accessibilityLabel("Open ledger")
            },
            delta: {
                // S3.2 (2026-07-17): unrealized delta stays here as the
                // change hero indicator. The full two-column table lives
                // in `meta` below so we can be explicit about the priced
                // vs unpriced scope.
                if hasCostBasis {
                    HStack(spacing: 4) {
                        Image(systemName: heroPL >= 0 ? "arrow.up.right" : "arrow.down.right")
                            .font(.caption2.weight(.bold))
                        Text(heroPL.portfolioSignedCurrencyText)
                            .font(.subheadline.weight(.semibold))
                        Text("•")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(heroROI.portfolioSignedPercentText + " " + Labels.roi)
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(pnlColor)
                }
            },
            meta: {
                // S3.2 (2026-07-17): explicit two-column breakdown so
                // users see cost basis + unrealized alongside the
                // priced/est/pending scope. The old one-line caption
                // implied the ROI figure covered everything — it doesn't.
                if hasCostBasis {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Cost basis")
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Spacer()
                            Text(portfolioCurrencyString(heroCost))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        HStack {
                            Text("Unrealized")
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Spacer()
                            HStack(spacing: 4) {
                                Text(heroPL.portfolioSignedCurrencyText)
                                    .font(.caption.weight(.semibold))
                                Text("(\(heroROI.portfolioSignedPercentText))")
                                    .font(.caption2)
                            }
                            .foregroundStyle(pnlColor)
                        }
                        Text("Priced \(agg.pricedCount) · Est \(agg.estimatedCount) · Pending \(agg.pendingCount) · Total \(agg.totalCards)")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                            .padding(.top, 2)
                    }
                } else {
                    HStack(spacing: 8) {
                        Text("Cost basis not set · \(agg.totalCards) cards\(unpricedSuffix)")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Button {
                            onSwitchToInventory(.all)
                        } label: {
                            Text("Add cost basis")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                .padding(.horizontal, 8)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open inventory to add cost basis to your cards")
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            }
        )
    }

    /// S3.6 (2026-07-17): parse the summary's `lastRefreshText` and
    /// convert to relative time via `RelativeDateTimeFormatter`. Falls
    /// back to the original string when parsing fails so we never render
    /// a broken caption.
    private func relativeUpdatedLabel(from raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        // Try common backend date shapes — ISO-8601 with or without fractional seconds.
        let parsers: [ISO8601DateFormatter] = [
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return f
            }(),
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime]
                return f
            }()
        ]
        guard let parsed = parsers.compactMap({ $0.date(from: trimmed) }).first else {
            return trimmed
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return "Updated \(formatter.localizedString(for: parsed, relativeTo: Date()))"
    }

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): movementPulseCard +
    // portfolioTrendLabel + pulseChip removed. The pulse card was the
    // trigger for PortfolioMovementDetailView (also removed) and
    // rendered portfolioImpliedPct / portfolioComposite — both direction
    // derivations from predicted-vs-FMV gaps. Backtest established
    // direction is at-chance.

    // Performance block (realized Sold/Fees/margin with period toggle) now
    // lives in ERPPnlView. Portfolio shows unrealized value trend below instead.

    // MARK: - Collection Value Card
    //
    // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): replaces the parked
    // "Building value history" placeholder. The card's headline is the
    // honest est. collection value (observed + estimated) — wider than
    // the hero by design under sparse comp coverage. See
    // CollectionValueCard.swift for the surface contract.

    private var valueTrendSection: some View {
        CollectionValueCard(viewModel: collectionValueViewModel)
    }

    /// P0.7 delta (2026-07-16): match the pending route against the loaded
    /// inventory and push the detail sheet. Clears `pendingRoute` on
    /// consume so a re-appear doesn't re-open the sheet. Only fires when
    /// the target holding is loaded — a deep-link that arrives before
    /// the initial fetch is honored once holdings settle (via the
    /// `.onChange(of: vm.inventoryCards)` observer).
    private func consumePendingRoute(_ route: AppRoute?) {
        guard case .portfolio(let uuid) = route else { return }
        guard let card = vm.inventoryCards.first(where: { $0.id == uuid }) else { return }
        selectedCard = card
        appState.pendingRoute = nil
    }

    // MARK: - Corpus signals grade-worthy banner (2026-07-17, PR #518)

    /// Compact banner surfaced above the holdings list when the portfolio
    /// scan returned at least one grade-worthy candidate. Tap pushes
    /// `GradeWorthyListView` for the full drill-down. Self-suppresses
    /// entirely when there are zero candidates or the fetch hasn't
    /// returned yet.
    @ViewBuilder
    private var gradeWorthyBanner: some View {
        if let alerts = vm.gradeWorthyAlerts,
           let count = alerts.gradeWorthyCount, count > 0,
           let candidates = alerts.candidates, candidates.isEmpty == false {
            Button {
                showGradeWorthyList = true
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Text("\u{1F48E}")
                        .font(.title2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(count) card\(count == 1 ? "" : "s") worth grading")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        // CF-GRADING-UPLIFT-VERIFY (2026-07-17): dollar
                        // figure hidden pending backend probability-
                        // weighting audit. If the summed uplift is
                        // meaningful in a probability-weighted sense we
                        // can restore the number.
                        HStack(spacing: 4) {
                            Text("Review each")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            Image(systemName: "arrow.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(HobbyIQTheme.Spacing.medium)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.45), lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Phase 2.6: Portfolio Momentum hero (2026-07-17, PR #529)

    /// Value-weighted portfolio trend hero. Renders below the grade-worthy
    /// banner. Self-suppresses when the response is nil, direction is
    /// flat, or `holdingsWithTrend == 0` (nothing to say).
    @ViewBuilder
    private var portfolioMomentumHero: some View {
        if let response = portfolioMomentum,
           let withTrend = response.holdingsWithTrend, withTrend > 0,
           let pct = response.momentumPercentString {
            let direction = response.direction?.lowercased() ?? ""
            let color: Color = {
                switch direction {
                case "up": return HobbyIQTheme.Colors.successGreen
                case "down": return HobbyIQTheme.Colors.danger
                default: return HobbyIQTheme.Colors.warning
                }
            }()
            let glyph: String = {
                switch direction {
                case "up": return "\u{25B2}"
                case "down": return "\u{25BC}"
                default: return "\u{2500}"
                }
            }()

            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("PORTFOLIO MOMENTUM")
                        .font(.caption.weight(.bold))
                        .tracking(0.6)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(glyph)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(color)
                    Text(pct)
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(color)
                    Text("this month")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                Text(momentumCountsCaption(response))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                if let top = response.topMovers?.first {
                    portfolioMoverLine(label: "Top mover", mover: top)
                }
                if let worst = response.worstMovers?.first,
                   worst.holdingId != response.topMovers?.first?.holdingId {
                    portfolioMoverLine(label: "Worst", mover: worst)
                }

                if let delta = response.impliedPortfolioDelta, abs(delta) >= 1 {
                    Divider().overlay(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                    let prefix = delta > 0 ? "+" : "\u{2212}"
                    Text("Implied gain: \(prefix)\(portfolioCurrencyString(abs(delta)))")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(color.opacity(0.4), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func momentumCountsCaption(_ response: PortfolioMomentumResponse) -> String {
        let up = response.cardsUp ?? 0
        let flat = response.cardsFlat ?? 0
        let down = response.cardsDown ?? 0
        return "\(up) up · \(flat) flat · \(down) down"
    }

    @ViewBuilder
    private func portfolioMoverLine(label: String, mover: PortfolioMoverEntry) -> some View {
        let dir = mover.direction?.lowercased() ?? ""
        let color: Color = {
            switch dir {
            case "up": return HobbyIQTheme.Colors.successGreen
            case "down": return HobbyIQTheme.Colors.danger
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()
        let glyph: String = {
            switch dir {
            case "up": return "\u{25B2}"
            case "down": return "\u{25BC}"
            default: return "\u{2500}"
            }
        }()
        HStack(spacing: 6) {
            Text("\(label):")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .frame(width: 84, alignment: .leading)
            Text(mover.playerName ?? "—")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
                .truncationMode(.tail)
            Text(glyph)
                .font(.caption.weight(.bold))
                .foregroundStyle(color)
            if let pct = mover.momentumPercentString {
                Text(pct)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
            }
            if let usd = mover.contributionUsd, abs(usd) >= 1 {
                let prefix = usd > 0 ? "+" : "\u{2212}"
                Text("(\(prefix)\(portfolioCurrencyString(abs(usd))))")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Phase 3.8: Cascade Alerts banner (2026-07-17, PR #527)

    /// Compact banner surfaced when Drew has any fired cascade event on a
    /// player he owns. Tap opens a full drill-down list. Hidden when
    /// events is empty or the fetch failed.
    @ViewBuilder
    private var cascadeBanner: some View {
        if let alerts = cascadeAlerts,
           let events = alerts.events, events.isEmpty == false {
            // Top event = highest severity, then most recent.
            let sorted = events.sorted { lhs, rhs in
                if lhs.severityRank != rhs.severityRank {
                    return lhs.severityRank > rhs.severityRank
                }
                return (lhs.detectedAt ?? "") > (rhs.detectedAt ?? "")
            }
            if let top = sorted.first {
                Button {
                    showCascadeList = true
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text(cascadeGlyph(for: top.severity))
                            .font(.title2)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Cascade signal: \(top.player ?? "—")")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .lineLimit(1)
                            if let reason = top.reason?.trimmingCharacters(in: .whitespaces),
                               reason.isEmpty == false {
                                Text(reason)
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                    .lineLimit(2)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            HStack(spacing: 4) {
                                Text("See details")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                Image(systemName: "arrow.right")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(HobbyIQTheme.Spacing.medium)
                    .background(HobbyIQTheme.Colors.cardNavy)
                    .overlay(
                        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                            .stroke(cascadeSeverityColor(for: top.severity).opacity(0.45), lineWidth: 1.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Severity → color mapping per spec (insider red-orange, emerging
    /// amber, confirmed green).
    private func cascadeSeverityColor(for severity: String?) -> Color {
        switch severity?.lowercased() {
        case "insider": return HobbyIQTheme.Colors.danger
        case "emerging": return HobbyIQTheme.Colors.warning
        case "confirmed": return HobbyIQTheme.Colors.successGreen
        default: return HobbyIQTheme.Colors.mutedText
        }
    }

    /// Severity → emoji glyph per spec (🚨 / ⚡ / 📈). Kept as inline
    /// emoji so it renders identically across iOS versions.
    private func cascadeGlyph(for severity: String?) -> String {
        switch severity?.lowercased() {
        case "insider": return "\u{1F6A8}"
        case "emerging": return "\u{26A1}"
        case "confirmed": return "\u{1F4C8}"
        default: return "\u{1F3AF}"
        }
    }

    /// Best-effort "Player · CardNumber" caption for the banner's top card.
    /// Falls back to just the player name when the card number is absent.
    private func gradeWorthyTopLabel(_ candidate: GradeAnalysisResponse) -> String {
        let player = candidate.player?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let number = candidate.cardNumber?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if player.isEmpty == false, number.isEmpty == false {
            return "\(player) \(number)"
        }
        return player.isEmpty ? "your top card" : player
    }

    // MARK: - PR #548 Engine-Accuracy Trust Badge

    /// Loads the backtest response when the cache is nil or older than
    /// `backtestAccuracyTTL`. Silent failure — badge suppresses on nil.
    private func loadBacktestAccuracyIfStale() async {
        if let loadedAt = backtestAccuracyLoadedAt,
           Date().timeIntervalSince(loadedAt) < Self.backtestAccuracyTTL,
           backtestAccuracy != nil {
            return
        }
        do {
            backtestAccuracy = try await APIService.shared.fetchBacktestPredictedPriceAccuracy(windowDays: 90)
            backtestAccuracyLoadedAt = Date()
        } catch {
            backtestAccuracy = nil
        }
    }

    /// Renders the trust badge. Three states:
    ///   - `.trustworthy`: green dot + hit-rate copy
    ///   - `.developing`: yellow dot + "still calibrating (N matched sales)"
    ///   - `.insufficientSample` / nil verdict / nil accuracy: hidden
    @ViewBuilder
    private var backtestAccuracyBadge: some View {
        if let accuracy = backtestAccuracy?.accuracy,
           let verdict = accuracy.verdict,
           verdict != .insufficientSample {
            Button {
                showBacktestSheet = true
            } label: {
                HStack(spacing: 8) {
                    Circle()
                        .fill(verdict == .trustworthy ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.warning)
                        .frame(width: 8, height: 8)
                    Text(backtestBadgeCopy(verdict: verdict, accuracy: accuracy))
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                        .stroke(Color.white.opacity(0.06), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    private func backtestBadgeCopy(verdict: BacktestVerdict, accuracy: PredictedPriceAccuracy) -> String {
        switch verdict {
        case .trustworthy:
            let pct = accuracy.hitRateWithin20Pct.map { Int(($0 * 100).rounded()) } ?? 0
            return "Engine accuracy: \(pct)% within \u{00B1}20% over last 90d"
        case .developing:
            let pairs = accuracy.matchedPairs ?? 0
            return "Engine accuracy: still calibrating (\(pairs) matched sales)"
        case .insufficientSample:
            return ""
        }
    }

    // MARK: - PR #425 Supply/Demand Dashboard

    private func loadSupplyDemandAggregates() async {
        async let summaryTask = try? APIService.shared.fetchSupplyDemandSummary()
        async let totalsTask = try? APIService.shared.fetchSignalWeightedTotals()
        // Phase 2.6 + 3.8 (2026-07-17): fetch portfolio momentum + cascade
        // alerts in parallel with the supply/demand aggregates so the
        // whole dashboard settles in one round trip.
        async let momentumTask = try? APIService.shared.fetchPortfolioMomentum()
        async let cascadeTask = try? APIService.shared.fetchCascadeAlerts()
        let (summary, totals, momentum, cascade) = await (summaryTask, totalsTask, momentumTask, cascadeTask)
        await MainActor.run {
            self.supplyDemandSummary = summary
            self.signalWeightedTotals = totals
            self.portfolioMomentum = momentum
            self.cascadeAlerts = cascade
        }
    }

    @ViewBuilder
    private var supplyDemandDashboardCard: some View {
        if let summary = supplyDemandSummary,
           (summary.totalHoldings ?? 0) > 0,
           VerdictStyle.isRenderable(summary.portfolioBias) {
            let style = VerdictStyle.from(summary.portfolioBias)
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Portfolio Signal")
                        .font(.caption.weight(.bold))
                        .tracking(0.8)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
                HStack(spacing: 8) {
                    Text(style.emoji)
                        .font(.system(size: 22))
                    Text(style.label)
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundStyle(style.color)
                    Spacer()
                }
                if let breakdown = summary.breakdown {
                    supplyDemandBreakdownRow(breakdown: breakdown)
                }
                if let movers = summary.topMovers, movers.isEmpty == false {
                    Divider().overlay(Color.white.opacity(0.08))
                    Text("Top movers")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    VStack(spacing: 8) {
                        ForEach(movers.prefix(3)) { mover in
                            supplyDemandMoverRow(mover: mover)
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func supplyDemandBreakdownRow(breakdown: SupplyDemandSummaryResponse.Breakdown) -> some View {
        HStack(spacing: 10) {
            supplyDemandCountChip(count: breakdown.up ?? 0, label: "up", tint: .green)
            supplyDemandCountChip(count: breakdown.mixed ?? 0, label: "mixed", tint: .orange)
            supplyDemandCountChip(count: breakdown.bear ?? 0, label: "bear", tint: .red)
            supplyDemandCountChip(count: breakdown.unknown ?? 0, label: "unknown", tint: HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
    }

    private func supplyDemandCountChip(count: Int, label: String, tint: Color) -> some View {
        HStack(spacing: 4) {
            Text("\(count)")
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
            Text(label)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private func supplyDemandMoverRow(mover: SupplyDemandSummaryResponse.TopMover) -> some View {
        let style = VerdictStyle.from(mover.verdict)
        let slope = formatSlopePerMonth(mover.listingsSlopePerMonthPct)
        return HStack(spacing: 10) {
            Text(style.emoji)
                .font(.system(size: 16))
            Text(mover.playerName ?? "—")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer(minLength: 6)
            if let slope {
                Text("\(slope) listings")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(style.color)
            }
        }
    }

    @ViewBuilder
    private var signalWeightedTotalsCard: some View {
        if let response = signalWeightedTotals,
           let totals = response.totals,
           (totals.gross ?? 0) > 0 || (totals.trendAdjusted ?? 0) > 0 {
            VStack(alignment: .leading, spacing: 14) {
                Text("Portfolio Value")
                    .font(.caption.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                HStack(alignment: .top, spacing: 12) {
                    signalWeightedTotalColumn(title: "Gross", value: totals.gross)
                    signalWeightedTotalColumn(title: "Trend-Adj", value: totals.trendAdjusted)
                    signalWeightedTotalColumn(title: "Net", value: totals.feesAdjusted)
                }

                if let byClass = response.byVerdictClass {
                    Divider().overlay(Color.white.opacity(0.08))
                    Text("by verdict class")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    VStack(spacing: 6) {
                        signalWeightedClassRow(emoji: "🔥", label: "Bull", bucket: byClass.bull)
                        signalWeightedClassRow(emoji: "→", label: "Static", bucket: byClass.staticBucket)
                        signalWeightedClassRow(emoji: "🐻", label: "Bear", bucket: byClass.bear)
                        signalWeightedClassRow(emoji: "?", label: "Unknown", bucket: byClass.unavailable)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    private func signalWeightedTotalColumn(title: String, value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value.map { $0.formatted(.currency(code: "USD").precision(.fractionLength(0))) } ?? "—")
                .font(.system(size: 18, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func signalWeightedClassRow(emoji: String, label: String, bucket: SignalWeightedTotalsResponse.ByVerdictClass.Bucket?) -> some View {
        HStack(spacing: 10) {
            Text(emoji).font(.system(size: 14))
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer(minLength: 6)
            Text(bucket?.trendAdjusted.map { $0.formatted(.currency(code: "USD").precision(.fractionLength(0))) } ?? "—")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("(\(bucket?.holdings ?? 0))")
                .font(.caption.monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    // MARK: - Priority Actions

    private var priorityActionsSection: some View {
        let collapseLimit = 3
        let totalCount = vm.priorityActions.count
        let visibleActions = priorityActionsExpanded
            ? vm.priorityActions
            : Array(vm.priorityActions.prefix(collapseLimit))
        let canExpand = totalCount > collapseLimit

        return VStack(alignment: .leading, spacing: 10) {
            sectionHeader(Labels.priorityActions)

            VStack(spacing: 0) {
                ForEach(Array(visibleActions.enumerated()), id: \.element.id) { index, action in
                    Button {
                        selectedPriorityAction = action
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: actionIconName(for: action.kind))
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(actionColor(for: action.kind))
                                .frame(width: 32, height: 32)
                                .background(actionColor(for: action.kind).opacity(0.15))
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                            Text(action.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                            Spacer()

                            Text("\(action.cardCount)")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Color(hex: 0x232937))
                                .clipShape(Capsule(style: .continuous))

                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)

                    if index < visibleActions.count - 1 {
                        Divider()
                            .overlay(Color.white.opacity(0.06))
                            .padding(.leading, 56)
                    }
                }

                if canExpand {
                    Divider()
                        .overlay(Color.white.opacity(0.06))
                    seeAllRow(
                        isExpanded: priorityActionsExpanded,
                        hiddenCount: max(0, totalCount - collapseLimit),
                        totalCount: totalCount,
                        noun: "actions"
                    ) {
                        withAnimation(.easeInOut(duration: 0.22)) { priorityActionsExpanded.toggle() }
                    }
                }
            }
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    // MARK: - Top Movers

    private var topMoversSection: some View {
        // S3.5 (2026-07-17): segmented Going Up / Going Down picker
        // swaps the row list between gainers and losers. Both share the
        // same data source (vm.topMovers) — direction determined by
        // profitLoss sign. When one side is empty, the picker still
        // renders but the empty side shows a "Nothing dropped
        // significantly" (or up) placeholder.
        let allRising = vm.topMovers.filter { $0.profitLoss >= 0 }
        let allFalling = vm.topMovers.filter { $0.profitLoss < 0 }
        let active = (moversDirection == .up) ? allRising : allFalling
        let collapseLimit = 5
        let visible = topMoversExpanded ? active : Array(active.prefix(collapseLimit))
        let hiddenCount = max(0, active.count - collapseLimit)
        let canExpand = hiddenCount > 0 || (topMoversExpanded && active.count > collapseLimit)

        return VStack(alignment: .leading, spacing: 10) {
            sectionHeader(Labels.topMovers)

            Picker("Direction", selection: $moversDirection) {
                ForEach(MoversDirection.allCases) { d in
                    Text(d.label).tag(d)
                }
            }
            .pickerStyle(.segmented)

            if vm.topMovers.isEmpty {
                portfolioEmptyState
                    .padding(.vertical, 4)
            } else if active.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: moversDirection == .up ? "arrow.up.forward" : "arrow.down.forward")
                        .font(.title3)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                    Text(moversDirection == .up
                         ? "Nothing rising significantly."
                         : "Nothing dropped significantly.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity, minHeight: 100)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, mover in
                        Button {
                            selectedCard = vm.inventoryCards.first { $0.playerName == mover.playerName && $0.cardName == mover.cardName }
                        } label: {
                            moverRow(mover: mover)
                        }
                        .buttonStyle(.plain)

                        if index < visible.count - 1 {
                            Divider()
                                .overlay(Color.white.opacity(0.06))
                                .padding(.leading, 12)
                        }
                    }

                    if canExpand {
                        Divider().overlay(Color.white.opacity(0.06))
                        seeAllRow(
                            isExpanded: topMoversExpanded,
                            hiddenCount: hiddenCount,
                            totalCount: active.count,
                            noun: "movers"
                        ) {
                            withAnimation(.easeInOut(duration: 0.22)) { topMoversExpanded.toggle() }
                        }
                    }
                }
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(Color.white.opacity(0.08), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
        }
    }

    // MARK: - See-all footer

    private func seeAllRow(isExpanded: Bool, hiddenCount: Int, totalCount: Int, noun: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(isExpanded
                     ? "Show less"
                     : "See all \(totalCount) \(noun)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Spacer()
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Show less" : "See all \(totalCount) \(noun)")
    }

    private func moverSubheader(title: String, icon: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private func moverRow(mover: PortfolioMover) -> some View {
        // CF-IOS-DIRECTION-SWEEP (2026-06-18): up/down derives from
        // profitLoss sign only — historical P/L. The prior hasSignals
        // branch read movementDirection (direction-class) when the
        // backend movement signal was present.
        let isUp: Bool = mover.profitLoss >= 0
        let valueColor: Color = isUp ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
        let arrowIcon = isUp ? "arrow.up.right" : "arrow.down.right"

        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 10) {
                // CF-PORTFOLIO-MOVER-THUMB (2026-07-05): mover rows on
                // the portfolio page now show the same card-art
                // thumbnail the inventory rows use (same helper, same
                // comp-card structure — .scaledToFit + .scaleEffect(0.85)
                // inside a fixed card-aspect frame).
                inventoryRowThumbnail(urlString: mover.imageUrl, playerName: mover.playerName)

                VStack(alignment: .leading, spacing: 2) {
                    Text(mover.playerName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(mover.cardName)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                    if let rec = mover.actionRecommendation,
                       rec.verdict != .insufficientData {
                        moverActionBadge(rec: rec)
                    }
                }

                Spacer(minLength: 12)

                HStack(spacing: 6) {
                    Image(systemName: arrowIcon)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(valueColor)
                    Text(mover.profitLoss.portfolioSignedCurrencyText)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(valueColor)
                }
            }

            moverRowSecondaryLine(mover: mover)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
    }

    /// CF-ACTION-BADGES (2026-07-06, backend §1): compact verdict pill
    /// for the mover row. Uses `ActionBadgeStyle` so it matches the
    /// comp-card action block visually.
    @ViewBuilder
    private func moverActionBadge(rec: CardPanelGradeEntry.ActionRecommendation) -> some View {
        let style = ActionBadgeStyle(verdict: rec.verdict, urgency: rec.urgency)
        HStack(spacing: 4) {
            Image(systemName: style.icon)
                .font(.system(size: 9, weight: .bold))
            Text(style.label)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(0.5)
            if rec.verdict == .list, let t = rec.targetPrice, t > 0 {
                Text("· \(t.currencyStringNoCents)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .foregroundStyle(style.foreground)
        .background(style.background)
        .overlay(
            Capsule(style: .continuous)
                .stroke(style.tint, lineWidth: style.strokeWidth)
        )
        .clipShape(Capsule(style: .continuous))
    }

    /// CF-IOS-PORTFOLIO-ROW-SECONDARY (2026-06-27): compact ROI% +
    /// current-value line under the mover row's primary content. ROI is
    /// derived from the row's profitLoss / cost basis (cost = currentValue
    /// - profitLoss), so the line uses only fields already on
    /// `PortfolioMover`. Segments self-suppress: ROI hides when cost
    /// rounds to zero; current value hides when the row carries no value.
    @ViewBuilder
    private func moverRowSecondaryLine(mover: PortfolioMover) -> some View {
        let cost = mover.currentValue - mover.profitLoss
        let roiPct: Double? = cost > 0 ? (mover.profitLoss / cost) * 100 : nil
        let roiColor: Color = {
            guard let roiPct else { return HobbyIQTheme.Colors.mutedText }
            if roiPct > 0 { return HobbyIQTheme.Colors.successGreen }
            if roiPct < 0 { return AppColors.danger }
            return HobbyIQTheme.Colors.mutedText
        }()

        HStack(spacing: 6) {
            if let roiPct {
                Text(roiPct.portfolioPercentString)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(roiColor)
            }
            if mover.currentValue > 0 {
                if roiPct != nil {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(AppColors.textSecondary)
                }
                Text(mover.currentValue.portfolioCurrencyString)
                    .font(.caption)
                    .foregroundStyle(AppColors.textSecondary)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Helpers

    private var portfolioEmptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            Text("No data yet.")
                .font(.headline.bold())
                .foregroundStyle(.white)

            Text("Add cards to your inventory to see actions and movers.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func warningBanner(message: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 6) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0xD1D5DB))

                Button {
                    Task { await vm.refresh() }
                } label: {
                    Text("Retry")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color(hex: 0x3B82F6))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry loading portfolio")
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color(hex: 0x1A1D24))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.orange.opacity(0.24), lineWidth: 1.6)
        )
        .cornerRadius(14)
        .padding(.horizontal)
    }

    private func sectionHeader(_ title: String) -> some View {
        // CF-UNIFY-SECTION-HEADERS (2026-06-17): delegates to the shared
        // HIQSectionHeader so the Portfolio screen's "Portfolio value
        // trend", "Priority actions", "Top movers" sections share the
        // same hairline chrome as the rest of the app.
        HIQSectionHeader(title)
    }

    private func actionIconName(for kind: PortfolioPriorityActionKind) -> String {
        switch kind {
        case .sellWatch: return "exclamationmark.circle.fill"
        case .highRisk: return "flame.fill"
        case .stalePricing: return "clock.arrow.circlepath"
        }
    }

    private func actionColor(for kind: PortfolioPriorityActionKind) -> Color {
        switch kind {
        case .sellWatch: return .orange
        case .highRisk: return .red
        case .stalePricing: return Color(hex: 0x3B82F6)
        }
    }
}

// MARK: - Value Trend Range

// MARK: - Supporting Views

private enum LedgerTab: String, CaseIterable {
    case entries = "Entries"
    case pnl = "P&L"
}

private enum LedgerPnLGrouping: String, CaseIterable {
    case month = "Month"
    case player = "Player"
    case source = "Source"
}

private struct PortfolioLedgerSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    @State private var showExportOptions = false
    @State private var includeUnreconciled = false
    @State private var exportFileURL: URL?
    @State private var showShareSheet = false
    @State private var selectedTab: LedgerTab = .entries
    @State private var pnlGrouping: LedgerPnLGrouping = .month
    @State private var pnlIncludeUnreconciled = false
    @State private var entryToDismiss: PortfolioLedgerEntry?
    @State private var dismissReason = ""
    @State private var dismissError: String?

    private var entries: [PortfolioLedgerEntry] { viewModel.ledgerEntries }
    private var totals: PortfolioLedgerTotals? { viewModel.ledgerTotals }

    var body: some View {
        VStack(spacing: 0) {
            if !entries.isEmpty {
                Picker("View", selection: $selectedTab) {
                    ForEach(LedgerTab.allCases, id: \.self) { tab in
                        Text(tab.rawValue).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 4)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if entries.isEmpty {
                        PortfolioLedgerEmptyState()
                    } else if selectedTab == .entries {
                        if let totals {
                            ledgerTotalsCard(totals)
                        }

                        let reconciliation = entries.filter { $0.needsReconciliation == true && $0.dismissedAt == nil }
                        if !reconciliation.isEmpty {
                            ledgerAttentionSection(reconciliation)
                        }

                        ForEach(entries) { entry in
                            NavigationLink(value: entry) {
                                ledgerRow(entry)
                            }
                            .buttonStyle(.plain)
                        }
                    } else {
                        pnlView
                    }
                }
                .padding(16)
            }
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Ledger")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if !entries.isEmpty {
                    Button { showExportOptions = true } label: {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                }
            }
        }
        .navigationDestination(for: PortfolioLedgerEntry.self) { entry in
            LedgerEntryDetailSheet(entry: entry, viewModel: viewModel)
        }
        .confirmationDialog("Export Tax CSV", isPresented: $showExportOptions) {
            Button("Export (exclude unreconciled)") {
                exportFileURL = viewModel.exportLedgerCSV(includeUnreconciled: false)
                if exportFileURL != nil { showShareSheet = true }
            }
            Button("Export (include unreconciled, flagged)") {
                exportFileURL = viewModel.exportLedgerCSV(includeUnreconciled: true)
                if exportFileURL != nil { showShareSheet = true }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showShareSheet) {
            if let url = exportFileURL {
                LedgerShareSheet(url: url)
            }
        }
    }

    // MARK: - P&L View

    private var pnlFilteredEntries: [PortfolioLedgerEntry] {
        pnlIncludeUnreconciled ? entries : entries.filter { $0.needsReconciliation != true }
    }

    @ViewBuilder
    private var pnlView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("Group by", selection: $pnlGrouping) {
                    ForEach(LedgerPnLGrouping.allCases, id: \.self) { g in
                        Text(g.rawValue).tag(g)
                    }
                }
                .pickerStyle(.segmented)
            }

            Toggle(isOn: $pnlIncludeUnreconciled) {
                HStack(spacing: 4) {
                    Text("Include unreconciled")
                        .font(.caption)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    if pnlIncludeUnreconciled {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.orange)
                    }
                }
            }
            .tint(HobbyIQTheme.Colors.electricBlue)

            let grouped = groupedPnL(pnlFilteredEntries, by: pnlGrouping)
            ForEach(grouped, id: \.key) { group in
                pnlGroupCard(group)
            }

            if pnlFilteredEntries.isEmpty {
                Text("No entries match the current filter.")
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
            }
        }
    }

    private struct PnLGroup {
        let key: String
        let count: Int
        let grossProceeds: Double
        let totalFees: Double
        let netProceeds: Double
        let costBasis: Double
        let realizedPnL: Double
        let hasUnreconciled: Bool
    }

    private func groupedPnL(_ entries: [PortfolioLedgerEntry], by grouping: LedgerPnLGrouping) -> [PnLGroup] {
        let dict = Dictionary(grouping: entries) { entry -> String in
            switch grouping {
            case .month:
                return monthKey(from: entry)
            case .player:
                return entry.playerName.isEmpty ? "Unknown" : entry.playerName
            case .source:
                return (entry.source ?? "manual").capitalized
            }
        }

        return dict.map { key, items in
            PnLGroup(
                key: key,
                count: items.count,
                grossProceeds: items.compactMap(\.grossProceeds).reduce(0, +),
                totalFees: items.compactMap(\.totalGranularFees).reduce(0, +),
                netProceeds: items.compactMap(\.netProceeds).reduce(0, +),
                costBasis: items.compactMap(\.costBasisSold).reduce(0, +),
                realizedPnL: items.compactMap(\.realizedProfitLoss).reduce(0, +),
                hasUnreconciled: items.contains { $0.needsReconciliation == true }
            )
        }
        .sorted { $0.key > $1.key }
    }

    private func monthKey(from entry: PortfolioLedgerEntry) -> String {
        guard let soldAt = entry.soldAt, !soldAt.isEmpty else { return entry.dateText }
        let fmtFrac = ISO8601DateFormatter()
        fmtFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmtStd = ISO8601DateFormatter()
        fmtStd.formatOptions = [.withInternetDateTime]
        guard let date = fmtFrac.date(from: soldAt) ?? fmtStd.date(from: soldAt) else { return entry.dateText }
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM"
        return df.string(from: date)
    }

    private func pnlGroupCard(_ group: PnLGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                HStack(spacing: 6) {
                    Text(group.key)
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                    if group.hasUnreconciled && pnlIncludeUnreconciled {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.orange)
                    }
                }
                Spacer()
                Text("\(group.count) sale\(group.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }

            HStack(spacing: 0) {
                pnlMetric(label: "Revenue", value: group.grossProceeds)
                Spacer(minLength: 0)
                pnlMetric(label: "Fees", value: group.totalFees)
                Spacer(minLength: 0)
                pnlMetric(label: "Cost", value: group.costBasis)
                Spacer(minLength: 0)
                VStack(spacing: 2) {
                    Text("P&L")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    Text(group.realizedPnL.portfolioSignedCurrencyText)
                        .font(.caption.bold())
                        .foregroundStyle(group.realizedPnL >= 0 ? .green : .red)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func pnlMetric(label: String, value: Double) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Text(value.portfolioCurrencyText)
                .font(.caption.bold())
                .foregroundStyle(.white)
        }
    }

    private func ledgerTotalsCard(_ totals: PortfolioLedgerTotals) -> some View {
        HStack(spacing: 0) {
            ledgerTotalItem(label: "Gross", value: totals.grossProceeds)
            Spacer(minLength: 0)
            ledgerTotalItem(label: "Net", value: totals.netProceeds)
            Spacer(minLength: 0)
            ledgerTotalItem(label: "P&L", value: totals.realizedProfitLoss, signed: true)
        }
        .frame(maxWidth: .infinity)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func ledgerTotalItem(label: String, value: Double?, signed: Bool = false) -> some View {
        VStack(spacing: 4) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            if let value {
                Text(signed ? value.portfolioSignedCurrencyText : value.portfolioCurrencyText)
                    .font(.subheadline.bold())
                    .foregroundStyle(signed ? (value >= 0 ? Color.green : Color.red) : .white)
            } else {
                Text("—")
                    .font(.subheadline.bold())
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }
        }
    }

    private func ledgerAttentionSection(_ entries: [PortfolioLedgerEntry]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Text("Needs your attention")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                Text("(\(entries.count))")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.orange.opacity(0.7))
            }

            ForEach(entries) { entry in
                HStack(spacing: 8) {
                    NavigationLink(value: entry) {
                        HStack(spacing: 8) {
                            Image(systemName: "cart.badge.questionmark")
                                .font(.caption)
                                .foregroundStyle(.orange)
                            Text(entry.playerName)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white)
                            Spacer(minLength: 0)
                            Text("Incomplete fees")
                                .font(.caption2)
                                .foregroundStyle(.orange.opacity(0.8))
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(Color(hex: 0x9CA3AF))
                        }
                    }
                    .buttonStyle(.plain)

                    Button {
                        dismissReason = ""
                        entryToDismiss = entry
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(Color(hex: 0x9CA3AF).opacity(0.6))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
        .alert("Dismiss Entry", isPresented: Binding(
            get: { entryToDismiss != nil },
            set: { if !$0 { entryToDismiss = nil } }
        )) {
            TextField("Reason (optional)", text: $dismissReason)
            Button("Dismiss") {
                guard let entry = entryToDismiss else { return }
                Task {
                    do {
                        try await viewModel.dismissLedgerEntry(id: entry.id, reason: dismissReason)
                    } catch {
                        dismissError = error.localizedDescription
                    }
                    entryToDismiss = nil
                }
            }
            Button("Cancel", role: .cancel) { entryToDismiss = nil }
        } message: {
            Text("Acknowledge this entry's incomplete fees. You can undo this from the sale details.")
        }
        .alert("Dismiss Failed", isPresented: Binding(
            get: { dismissError != nil },
            set: { if !$0 { dismissError = nil } }
        )) {
            Button("OK") { dismissError = nil }
        } message: {
            Text(dismissError ?? "")
        }
    }

    private func ledgerRow(_ entry: PortfolioLedgerEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(entry.playerName)
                            .font(.subheadline.bold())
                            .foregroundStyle(.white)
                        if entry.isEbaySource {
                            Text("eBay")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color(hex: 0x3665F3).opacity(0.8))
                                .clipShape(Capsule())
                        }
                        if entry.needsReconciliation == true {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(.orange)
                        }
                    }
                    Text(entry.cardName)
                        .font(.caption)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                }

                Spacer(minLength: 0)

                VStack(alignment: .trailing, spacing: 4) {
                    Text(entry.salePrice.portfolioCurrencyText)
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                    Text(entry.profit.portfolioSignedCurrencyText)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(entry.profit >= 0 ? .green : .red)
                }
            }

            HStack(spacing: 8) {
                Text(entry.dateText)
                    .font(.caption2)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                if entry.isEbaySource, let total = entry.totalGranularFees {
                    Text("Fees: \(total.portfolioCurrencyText)")
                        .font(.caption2)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }
}

// MARK: - Ledger Entry Detail

private struct LedgerEntryDetailSheet: View {
    let entry: PortfolioLedgerEntry
    let viewModel: PortfolioIQViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var gradingCostText = ""
    @State private var suppliesCostText = ""
    @State private var isSavingCosts = false
    @State private var costSaveError: String?
    @State private var isUndismissing = false
    @State private var undismissError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerSection
                // PR #554 (2026-07-17): post-sale attribution outcome
                // badge. Self-suppresses for no_verdict + before the
                // read route lands (returns 404 -> hidden).
                SaleOutcomeBadge(soldEntryId: entry.id)
                transactionSection
                if entry.isEbaySource {
                    ebayFeeBreakdownSection
                }
                costBasisEditSection
                profitSection
                // CF-EBAY-BROWSE-ENRICHMENT (backend PRs #384/#385):
                // sold-listing photo gallery + seller line for the
                // sold entry. Self-suppresses when the wire fields
                // are absent (manual sales, legacy rows).
                futureCompsSection
                if entry.dismissedAt != nil {
                    undismissSection
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Sale Details")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .onAppear {
            gradingCostText = entry.gradingCost.map { String(format: "%.2f", $0) } ?? ""
            suppliesCostText = entry.suppliesCost.map { String(format: "%.2f", $0) } ?? ""
        }
    }

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(entry.playerName)
                    .font(.title3.bold())
                    .foregroundStyle(.white)
                if entry.isEbaySource {
                    Text("eBay")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color(hex: 0x3665F3).opacity(0.8))
                        .clipShape(Capsule())
                }
            }
            if !entry.cardName.isEmpty {
                Text(entry.cardName)
                    .font(.subheadline)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }
            if entry.needsReconciliation == true && entry.dismissedAt == nil {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                    Text("Needs reconciliation — some fees are pending")
                        .font(.caption2)
                }
                .foregroundStyle(.orange)
                .padding(.top, 2)
            }
            if entry.dismissedAt != nil {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption2)
                    Text("Dismissed")
                        .font(.caption2.weight(.semibold))
                    if let reason = entry.dismissedReason, !reason.isEmpty {
                        Text("— \(reason)")
                            .font(.caption2)
                    }
                }
                .foregroundStyle(Color(hex: 0x9CA3AF))
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var transactionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("Transaction")
            detailRow("Sale Price", value: entry.salePrice.portfolioCurrencyText)
            if let gross = entry.grossProceeds {
                detailRow("Gross Proceeds", value: gross.portfolioCurrencyText)
            }
            if let net = entry.netProceeds {
                detailRow("Net Proceeds", value: net.portfolioCurrencyText)
            }
            if let netPayout = entry.netPayout {
                detailRow("eBay Net Payout", value: netPayout.portfolioCurrencyText)
            }
            detailRow("Date", value: entry.dateText)
            if let orderId = entry.ebayOrderId {
                detailRow("eBay Order", value: orderId)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var ebayFeeBreakdownSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("eBay Fee Breakdown")
            feeRow("Final Value Fee", fee: entry.finalValueFee)
            feeRow("Payment Processing", fee: entry.paymentProcessingFee)
            feeRow("Promoted Listing", fee: entry.promotedListingFee)
            feeRow("Ad Fee", fee: entry.adFee)
            feeRow("Shipping Cost", fee: entry.actualShippingCost)
            feeRow("Other Fees", fee: entry.otherFees)

            if let total = entry.totalGranularFees {
                Divider().overlay(Color(hex: 0x9CA3AF).opacity(0.3))
                detailRow("Total Known Fees", value: total.portfolioCurrencyText, bold: true)
            }

            if entry.hasAnyNullFee {
                HStack(spacing: 4) {
                    Image(systemName: "clock.fill")
                        .font(.system(size: 10))
                    Text("Some fees are pending — eBay has not reported them yet")
                        .font(.caption2)
                }
                .foregroundStyle(.orange.opacity(0.8))
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var costBasisEditSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("Cost Basis")
            if let cost = entry.costBasisSold {
                detailRow("Purchase Cost", value: cost.portfolioCurrencyText)
            }
            costEditRow("Grading Cost", text: $gradingCostText) {
                await saveCost(field: "gradingCost", text: gradingCostText, original: entry.gradingCost)
            }
            costEditRow("Supplies Cost", text: $suppliesCostText) {
                await saveCost(field: "suppliesCost", text: suppliesCostText, original: entry.suppliesCost)
            }
            if isSavingCosts {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text("Saving...")
                        .font(.caption2)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                }
            }
            if let err = costSaveError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func costEditRow(_ label: String, text: Binding<String>, onCommit: @escaping () async -> Void) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Spacer()
            HStack(spacing: 2) {
                Text("$")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                TextField("—", text: text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 80)
                    .onSubmit { Task { await onCommit() } }
            }
        }
    }

    private func saveCost(field: String, text: String, original: Double?) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let newValue: Double?? = trimmed.isEmpty ? .some(nil) : {
            guard let v = Double(trimmed), v >= 0 else { return nil }
            return .some(v)
        }()

        guard let patchValue = newValue else {
            costSaveError = "Enter a valid amount (0 or greater)"
            return
        }

        let originalFormatted = original.map { String(format: "%.2f", $0) } ?? ""
        if trimmed == originalFormatted { return }

        isSavingCosts = true
        costSaveError = nil
        do {
            if field == "gradingCost" {
                try await viewModel.updateLedgerEntryCosts(id: entry.id, gradingCost: patchValue, suppliesCost: nil)
            } else {
                try await viewModel.updateLedgerEntryCosts(id: entry.id, gradingCost: nil, suppliesCost: patchValue)
            }
        } catch {
            costSaveError = error.localizedDescription
            if field == "gradingCost" {
                gradingCostText = originalFormatted
            } else {
                suppliesCostText = originalFormatted
            }
        }
        isSavingCosts = false
    }

    // MARK: - Future comps section (backend PRs #384/#385)

    private var futureCompsImages: [String] {
        var urls: [String] = entry.ebaySoldImages ?? []
        if let primary = entry.ebayImageUrl, primary.isEmpty == false, urls.contains(primary) == false {
            urls.insert(primary, at: 0)
        }
        return urls
    }

    @ViewBuilder
    private var futureCompsSection: some View {
        if futureCompsImages.isEmpty == false || entry.ebaySellerUsername != nil {
            VStack(alignment: .leading, spacing: 10) {
                HIQSectionHeader("Future comps")
                Text("This is one of your future comps.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                if futureCompsImages.isEmpty == false {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Array(futureCompsImages.enumerated()), id: \.offset) { _, urlString in
                                if let url = URL(string: urlString) {
                                    AsyncImage(url: url) { phase in
                                        switch phase {
                                        case .success(let image):
                                            image.resizable().scaledToFit()
                                        case .empty:
                                            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                                        case .failure:
                                            Image(systemName: "photo.badge.exclamationmark")
                                                .font(.system(size: 20))
                                                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                                        @unknown default: EmptyView()
                                        }
                                    }
                                    .frame(width: 110, height: 140)
                                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                }
                            }
                        }
                    }
                }

                if let seller = entry.ebaySellerUsername, seller.isEmpty == false {
                    HStack(spacing: 8) {
                        Image(systemName: "person.crop.circle.fill")
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text("Sold as @\(seller)")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                    }
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
    }

    private var undismissSection: some View {
        VStack(spacing: 8) {
            Button {
                Task {
                    isUndismissing = true
                    undismissError = nil
                    do {
                        try await viewModel.undismissLedgerEntry(id: entry.id)
                        dismiss()
                    } catch {
                        undismissError = error.localizedDescription
                    }
                    isUndismissing = false
                }
            } label: {
                HStack(spacing: 6) {
                    if isUndismissing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.uturn.backward.circle")
                            .font(.caption)
                    }
                    Text("Undo Dismiss")
                        .font(.subheadline.weight(.medium))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .disabled(isUndismissing)
            if let err = undismissError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var profitSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("Profit / Loss")
            HStack {
                Text("Realized P&L")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                Spacer()
                Text(entry.profit.portfolioSignedCurrencyText)
                    .font(.headline.bold())
                    .foregroundStyle(entry.profit >= 0 ? .green : .red)
            }
            if let pct = entry.realizedProfitLossPct {
                HStack {
                    Text("ROI")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    Spacer()
                    Text(String(format: "%+.1f%%", pct))
                        .font(.subheadline.bold())
                        .foregroundStyle(pct >= 0 ? .green : .red)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func detailSectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .textCase(.uppercase)
    }

    private func detailRow(_ label: String, value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Spacer()
            Text(value)
                .font(.subheadline.weight(bold ? .bold : .medium))
                .foregroundStyle(.white)
        }
    }

    private func feeRow(_ label: String, fee: Double?) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Spacer()
            if let fee {
                Text(fee.portfolioCurrencyText)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
            } else {
                Text("Pending")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.orange.opacity(0.15))
                    .clipShape(Capsule())
            }
        }
    }
}

private struct PortfolioLedgerEmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "book.closed")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Text("No sales yet.")
                .font(.headline.bold())
                .foregroundStyle(.white)
            Text("When you mark cards sold, the ledger will appear here.")
                .font(.caption)
                .foregroundStyle(Color(hex: 0x9CA3AF))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(Color(hex: 0x1A1D24))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

// MARK: - Share Sheet

private struct LedgerShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Preview Data

private extension PortfolioSummaryResponse {
    static var previewSample: PortfolioSummaryResponse {
        PortfolioSummaryResponse(
            inventory: PortfolioInventorySummary(
                totalCost: 960,
                totalCurrentValue: 1240,
                totalProfitLoss: 280,
                roi: 29.2,
                activeCount: 4
            ),
            accountSnapshot: PortfolioAccountSnapshot(
                userId: "demo",
                totalCards: 4,
                totalValue: 1240,
                totalCost: 960,
                totalProfitLoss: 280,
                roi: 29.2,
                generatedAt: "2024-04-29T14:22:00Z"
            ),
            inventoryDetails: [
                PortfolioCardDetail(
                    id: "1",
                    playerName: "Dylan Crews",
                    cardName: "2025 Bowman Chrome Blue Auto /150",
                    cost: 220,
                    currentValue: 310,
                    profitLoss: 90,
                    roi: 40.9,
                    purchasePlatform: "eBay",
                    notes: nil,
                    lastPricedAt: "2024-04-29T14:22:00Z",
                    signal: "hold",
                    format: "Chrome",
                    sellReason: nil
                ),
                PortfolioCardDetail(
                    id: "2",
                    playerName: "Paul Skenes",
                    cardName: "2024 Topps Chrome Refractor",
                    cost: 180,
                    currentValue: 260,
                    profitLoss: 80,
                    roi: 44.4,
                    purchasePlatform: "Whatnot",
                    notes: nil,
                    lastPricedAt: "2024-04-29T14:22:00Z",
                    signal: "strong_hold",
                    format: "Refractor",
                    sellReason: nil
                )
            ],
            bestCardsToSellNow: [
                PortfolioBestSellCard(
                    id: "best-1",
                    playerName: "Dylan Crews",
                    cardName: "2025 Bowman Chrome Blue Auto /150",
                    cost: 220,
                    currentValue: 310,
                    profitLoss: 90,
                    roi: 40.9,
                    signal: "strong_sell",
                    format: "Chrome",
                    recommendation: "Take the offer if you see one in range."
                ),
                PortfolioBestSellCard(
                    id: "best-2",
                    playerName: "Riley Greene",
                    cardName: "2024 Topps Finest Gold /50",
                    cost: 120,
                    currentValue: 170,
                    profitLoss: 50,
                    roi: 41.7,
                    signal: "sell",
                    format: "Finest",
                    recommendation: "Good spot to trim into strength."
                )
            ],
            month: SummaryPeriod(
                totalSold: 1240,
                totalProfit: 280,
                totalExpenses: 32,
                netProfit: 248,
                margin: 20.0
            ),
            year: SummaryPeriod(
                totalSold: 6410,
                totalProfit: 1320,
                totalExpenses: 180,
                netProfit: 1140,
                margin: 17.8
            )
        )
    }
}

// CF-IOS-DIRECTION-SWEEP (2026-06-18): PortfolioMovementDetailView
// removed entirely. The modal listed cards by movement direction
// (Rising / Falling / All) sorted by magnitude / $ Impact / value /
// name, with per-row movementChipText + dollarImpact + stale icon —
// all direction surfaces. The trigger (movementPulseCard) is also
// gone; nothing else opened this modal.

#Preview {
    PortfolioIQView(
        vm: PortfolioIQViewModel(initialSummary: .previewSample),
        onSwitchToInventory: { _ in }
    )
    .environmentObject(AppState())
}

// MARK: - Priority Action List (CF-PRIORITY-DRILLDOWN, 2026-07-06)

/// Dedicated push destination for a single Priority Action tap.
/// Shows the subset of `vm.inventoryCards` that matches the action's
/// kind, in the same row style as InventoryIQ. Tapping a card pushes
/// the standard `PortfolioHoldingDetailSheet`.
struct PriorityActionListView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    let action: PortfolioPriorityAction
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var selectedCard: InventoryCard?

    var body: some View {
        ZStack {
            HobbyIQBackground()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 12) {
                    header
                    if matchingCards.isEmpty {
                        emptyState
                    } else {
                        cardList
                    }
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
        }
        .safeAreaInset(edge: .bottom) { Color.clear.frame(height: 88) }
        .navigationTitle(action.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationDestination(item: $selectedCard) { card in
            PortfolioHoldingDetailSheet(
                viewModel: vm,
                card: card,
                onUpdated: { Task { await vm.refresh() } },
                onBack: { selectedCard = nil }
            )
            .environmentObject(sessionViewModel)
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: iconName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 40, height: 40)
                .background(tint.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(action.title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(action.subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Text("\(matchingCards.count)")
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(tint.opacity(0.2))
                .clipShape(Capsule())
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var cardList: some View {
        VStack(spacing: 0) {
            ForEach(Array(matchingCards.enumerated()), id: \.element.id) { index, card in
                Button {
                    selectedCard = card
                } label: {
                    PortfolioCardRow(
                        card: card,
                        resolvedValue: vm.marketValue(for: card),
                        latestFlip: vm.recentFlip(for: card),
                        playerTrend: vm.playerTrend(for: card)
                    )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if index < matchingCards.count - 1 {
                    Divider().overlay(Color.white.opacity(0.08))
                }
            }
        }
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("Nothing to action here")
                .font(.headline.bold())
                .foregroundStyle(.white)
            Text("No holdings currently match this priority.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Derived

    private var matchingCards: [InventoryCard] {
        vm.inventoryCards.filter { card in
            switch action.kind {
            case .sellWatch:
                return card.profitLoss < 0 || card.status.lowercased().contains("sell")
            case .highRisk:
                return card.profitLoss < 0
            case .stalePricing:
                return card.freshnessChipText == "Stale"
            }
        }
    }

    private var iconName: String {
        switch action.kind {
        case .sellWatch: return "exclamationmark.circle.fill"
        case .highRisk: return "flame.fill"
        case .stalePricing: return "clock.arrow.circlepath"
        }
    }

    private var tint: Color {
        switch action.kind {
        case .sellWatch: return .orange
        case .highRisk: return .red
        case .stalePricing: return Color(hex: 0x3B82F6)
        }
    }
}
