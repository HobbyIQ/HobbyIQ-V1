// CF-STOREFRONT iOS parity (Drew, 2026-08-05).
//
// Mirrors apps/web/src/app/app/storefront/page.tsx. Investor/Pro Seller
// tier only. Two states inside the gate:
//   1. Whole-storefront visibility toggle (calls setPublicShareEnabled)
//   2. Per-card picker — each eligible holding gets a checkmark toggle
//      that PATCHes /api/portfolio/holdings/:id { showOnStorefront: bool }
//
// Prerequisites (gated in order, each blocks the next):
//   A. Plan tier: investor OR pro_seller (entitlementOverride overrides plan)
//   B. Email verified
//   C. Username claimed
//
// MVP scope: gates + toggle + per-card checkbox. Bulk select/clear-all,
// public-URL copy, and share sheet are followups.

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct StorefrontView: View {
    private static let investorCap = 50
    private static let proSellerCap = 200

    @State private var user: BackendAuthUser?
    @State private var holdings: [StorefrontHolding] = []
    @State private var loading = true
    @State private var errorMessage: String?
    @State private var togglingShare = false
    @State private var filterText: String = ""
    @State private var busyHoldingIds: Set<String> = []
    @State private var bulkBusy: BulkOperation? = nil
    @State private var showingCopiedToast: Bool = false

    private enum BulkOperation { case selecting, clearing }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.large) {
                header
                if loading {
                    ProgressView().padding(.top, HobbyIQTheme.Spacing.large)
                } else if let msg = errorMessage {
                    Text(msg)
                        .font(HobbyIQTheme.Typography.body)
                        .foregroundStyle(.red)
                        .padding(HobbyIQTheme.Spacing.medium)
                } else if let user {
                    body(for: user)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xxLarge)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Storefront")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    // ─── header ────────────────────────────────────────────────

    private var header: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.xSmall) {
            Text("Storefront")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Pick which cards appear on your public shop at hobby-iq.com/u/<username>. Nothing shows until you add it here.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    // ─── gates → body ──────────────────────────────────────────

    @ViewBuilder
    private func body(for user: BackendAuthUser) -> some View {
        let effectivePlan = user.entitlementOverride ?? user.plan
        let cap = Self.capFor(plan: effectivePlan)
        let canHave = effectivePlan == "investor" || effectivePlan == "pro_seller"
        let emailVerified = user.emailVerified ?? false
        let username = user.username ?? ""
        let enabled = user.publicShareEnabled ?? false

        if !canHave {
            upgradeCard(currentPlan: effectivePlan)
        } else if !emailVerified {
            emailVerifyCard()
        } else if username.isEmpty {
            claimUsernameCard()
        } else {
            visibilityCard(enabled: enabled)
            if enabled {
                publicUrlCard(username: username)
            }
            pickerCard(cap: cap, username: username)
        }
    }

    private func upgradeCard(currentPlan: String) -> some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            Text("Upgrade to unlock")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("The public storefront is included with Investor (up to 50 cards) and Pro Seller (up to 200). Your current plan is \(Self.planLabel(currentPlan)).")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func emailVerifyCard() -> some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            Text("Verify your email first")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Your storefront URL is public. Verify your email in Settings before publishing anything.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func claimUsernameCard() -> some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            Text("Pick a username first")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Your storefront URL is /u/<username>. Claim one in Settings before enabling.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func visibilityCard(enabled: Bool) -> some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Storefront visibility")
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("When on, anyone with the link can browse your selected cards. Cost basis + P/L never appear.")
                        .font(HobbyIQTheme.Typography.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button {
                    Task { await onToggleShare(!enabled) }
                } label: {
                    Text(togglingShare ? "Saving…" : (enabled ? "Turn off" : "Turn on"))
                        .font(HobbyIQTheme.Typography.bodyEmphasis)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(enabled ? HobbyIQTheme.Colors.danger : HobbyIQTheme.Colors.electricBlue)
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(togglingShare)
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func publicUrlCard(username: String) -> some View {
        let publicUrl = "https://hobby-iq.com/u/\(username)"
        return VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your public URL")
                        .font(HobbyIQTheme.Typography.captionEmphasis)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(publicUrl)
                        .font(HobbyIQTheme.Typography.body)
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Button {
                    #if canImport(UIKit)
                    UIPasteboard.general.string = publicUrl
                    #endif
                    showingCopiedToast = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        await MainActor.run { showingCopiedToast = false }
                    }
                } label: {
                    Image(systemName: showingCopiedToast ? "checkmark" : "doc.on.doc")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(showingCopiedToast ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showingCopiedToast ? "Copied" : "Copy public storefront URL")
            }
            #if canImport(UIKit)
            // System share sheet — iMessage, AirDrop, Mail, Twitter, etc.
            // Pro Sellers push their shop URL out through the channel that
            // makes sense for their audience without leaving the app.
            ShareLink(item: URL(string: publicUrl) ?? URL(string: "https://hobby-iq.com")!) {
                HStack(spacing: 6) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                    Text("Share storefront")
                        .font(HobbyIQTheme.Typography.bodyEmphasis)
                }
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.electricBlue)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            }
            .buttonStyle(.plain)
            #endif
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    // ─── picker ────────────────────────────────────────────────

    private func pickerCard(cap: Int?, username _: String) -> some View {
        let eligible = holdings.filter(\.isEligible)
        let selected = holdings.filter { $0.showOnStorefront == true }
        let capText = cap.map { "\(selected.count) / \($0) selected" } ?? "\(selected.count) selected"
        let filtered: [StorefrontHolding] = {
            let q = filterText.trimmingCharacters(in: .whitespaces).lowercased()
            guard !q.isEmpty else { return eligible }
            return eligible.filter { h in
                (h.cardTitle ?? "").lowercased().contains(q)
                    || (h.playerName ?? "").lowercased().contains(q)
                    || (h.parallel ?? "").lowercased().contains(q)
            }
        }()

        return VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.small) {
            HStack {
                Text("Storefront picker")
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                Text(capText)
                    .font(HobbyIQTheme.Typography.captionEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            Text("Only cards with a photo and an identity are eligible. Add a photo in the portfolio to unlock the rest.")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)

            bulkActionsRow(eligible: eligible, selected: selected, cap: cap)

            TextField("Filter cards…", text: $filterText)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(HobbyIQTheme.Colors.appBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1.2)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            if filtered.isEmpty {
                Text(eligible.isEmpty
                     ? "No eligible cards yet. Add a photo to any holding to unlock it here."
                     : "Nothing matches your filter.")
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, HobbyIQTheme.Spacing.small)
            } else {
                LazyVStack(spacing: HobbyIQTheme.Spacing.xSmall) {
                    ForEach(filtered) { h in
                        row(for: h, cap: cap, currentSelectedCount: selected.count)
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }

    private func row(for h: StorefrontHolding, cap: Int?, currentSelectedCount: Int) -> some View {
        let isOn = h.showOnStorefront == true
        let busy = busyHoldingIds.contains(h.id)
        // Reuse the same HoldingRowView the Portfolio inventory uses so
        // the storefront picker looks identical to what users already
        // know. The whole row becomes the toggle target (onTap) with a
        // selection badge overlaid on the corner of the card image.
        return HoldingRowView(model: h.rowModel) {
            if !busy {
                Task { await onToggleCard(h, on: !isOn, cap: cap, currentSelectedCount: currentSelectedCount) }
            }
        }
        .overlay(alignment: .topLeading) {
            selectionBadge(on: isOn, busy: busy)
                .padding(.leading, HobbyIQTheme.Spacing.medium + 32)   // sit on the top-right of the 48pt card image
                .padding(.top, HobbyIQTheme.Spacing.small)
        }
        .overlay(alignment: .bottomTrailing) {
            if isOn {
                Text("ON STOREFRONT")
                    .font(.caption2.weight(.bold))
                    .tracking(0.5)
                    .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(HobbyIQTheme.Colors.hobbyGreen.opacity(0.14))
                    .clipShape(Capsule(style: .continuous))
                    .padding(.trailing, HobbyIQTheme.Spacing.medium)
                    .padding(.bottom, HobbyIQTheme.Spacing.xSmall)
            }
        }
        .opacity(busy ? 0.55 : 1)
        .accessibilityLabel(isOn ? "Remove from storefront" : "Add to storefront")
    }

    // ─── bulk actions (CF-STOREFRONT-BULK 2026-08-05) ─────────
    // Mirrors apps/web/src/app/app/storefront/page.tsx bulkSelectAll +
    // bulkClearAll. "Select all" fills the cap with highest-FMV
    // not-yet-selected cards. "Clear all" removes every selected card.
    // Optimistic UI with per-card rollback on failure.

    private func bulkActionsRow(eligible: [StorefrontHolding], selected: [StorefrontHolding], cap: Int?) -> some View {
        let hasSelectable = eligible.contains(where: { $0.showOnStorefront != true })
        let hasSelected = !selected.isEmpty
        let selecting = bulkBusy == .selecting
        let clearing = bulkBusy == .clearing
        return HStack(spacing: HobbyIQTheme.Spacing.xSmall) {
            Button {
                Task { await bulkSelectAll(eligible: eligible, selected: selected, cap: cap) }
            } label: {
                Text(selecting ? "Adding…" : "Select all (highest value)")
                    .font(HobbyIQTheme.Typography.captionEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.15))
                    .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(bulkBusy != nil || !hasSelectable)
            .opacity(bulkBusy != nil || !hasSelectable ? 0.55 : 1)

            Button {
                Task { await bulkClearAll(selected: selected) }
            } label: {
                Text(clearing ? "Clearing…" : "Clear all")
                    .font(HobbyIQTheme.Typography.captionEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.danger.opacity(0.15))
                    .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(bulkBusy != nil || !hasSelected)
            .opacity(bulkBusy != nil || !hasSelected ? 0.55 : 1)

            Spacer(minLength: 0)
        }
    }

    private func bulkSelectAll(eligible: [StorefrontHolding], selected: [StorefrontHolding], cap: Int?) async {
        guard bulkBusy == nil else { return }
        errorMessage = nil
        bulkBusy = .selecting
        defer { bulkBusy = nil }

        // Sort not-yet-selected by displayValue DESC (mirrors web —
        // "highest-FMV wins the last slots"). Then trim to cap headroom.
        let notSelected = eligible
            .filter { $0.showOnStorefront != true }
            .sorted { $0.displayValue > $1.displayValue }
        let headroom = cap.map { max(0, $0 - selected.count) } ?? notSelected.count
        let toAdd = Array(notSelected.prefix(headroom))
        guard !toAdd.isEmpty else {
            errorMessage = (cap != nil && selected.count >= (cap ?? 0))
                ? "Cap reached. Remove some before selecting more."
                : "Nothing new to add — every eligible card is already selected."
            return
        }

        // Optimistic — flip local state for everything we're about to add.
        let toAddIds = Set(toAdd.map(\.id))
        holdings = holdings.map { h in
            guard toAddIds.contains(h.id) else { return h }
            return StorefrontHolding(
                id: h.id, playerName: h.playerName, cardTitle: h.cardTitle,
                cardYear: h.cardYear, setName: h.setName, cardNumber: h.cardNumber,
                parallel: h.parallel, gradeCompany: h.gradeCompany, gradeValue: h.gradeValue,
                imageUrl: h.imageUrl, photos: h.photos, fairMarketValue: h.fairMarketValue,
                estimatedValue: h.estimatedValue, showOnStorefront: true
            )
        }

        // Concurrency-capped fan-out — 6 in-flight PATCHes at a time so
        // 200-card adds don't hammer /api/portfolio/holdings but aren't
        // molasses-slow either. Matches the web bulkSelectAll's spirit.
        var failedIds = Set<String>()
        await withTaskGroup(of: (String, Bool).self) { group in
            let chunkSize = 6
            for chunk in stride(from: 0, to: toAdd.count, by: chunkSize) {
                let batch = Array(toAdd[chunk..<min(chunk + chunkSize, toAdd.count)])
                for h in batch {
                    group.addTask {
                        do {
                            try await APIService.shared.updateHoldingShowOnStorefront(holdingId: h.id, show: true)
                            return (h.id, true)
                        } catch {
                            return (h.id, false)
                        }
                    }
                }
                for await (id, ok) in group where !ok {
                    failedIds.insert(id)
                }
            }
        }

        if !failedIds.isEmpty {
            // Rollback failures
            holdings = holdings.map { h in
                guard failedIds.contains(h.id) else { return h }
                return StorefrontHolding(
                    id: h.id, playerName: h.playerName, cardTitle: h.cardTitle,
                    cardYear: h.cardYear, setName: h.setName, cardNumber: h.cardNumber,
                    parallel: h.parallel, gradeCompany: h.gradeCompany, gradeValue: h.gradeValue,
                    imageUrl: h.imageUrl, photos: h.photos, fairMarketValue: h.fairMarketValue,
                    estimatedValue: h.estimatedValue, showOnStorefront: false
                )
            }
            let done = toAdd.count - failedIds.count
            errorMessage = "Added \(done). \(failedIds.count) failed — try again."
        }

        if let cap, notSelected.count > headroom {
            let leftOut = notSelected.count - headroom
            // If we hit the cap, tell the user
            let addedCount = toAdd.count - failedIds.count
            errorMessage = "Added \(addedCount). \(leftOut) more eligible cards weren't added — cap of \(cap) reached."
        }
    }

    private func bulkClearAll(selected: [StorefrontHolding]) async {
        guard bulkBusy == nil else { return }
        guard !selected.isEmpty else { return }
        errorMessage = nil
        bulkBusy = .clearing
        defer { bulkBusy = nil }

        let toClearIds = Set(selected.map(\.id))
        // Optimistic
        holdings = holdings.map { h in
            guard toClearIds.contains(h.id) else { return h }
            return StorefrontHolding(
                id: h.id, playerName: h.playerName, cardTitle: h.cardTitle,
                cardYear: h.cardYear, setName: h.setName, cardNumber: h.cardNumber,
                parallel: h.parallel, gradeCompany: h.gradeCompany, gradeValue: h.gradeValue,
                imageUrl: h.imageUrl, photos: h.photos, fairMarketValue: h.fairMarketValue,
                estimatedValue: h.estimatedValue, showOnStorefront: false
            )
        }
        var failedIds = Set<String>()
        await withTaskGroup(of: (String, Bool).self) { group in
            let chunkSize = 6
            for chunk in stride(from: 0, to: selected.count, by: chunkSize) {
                let batch = Array(selected[chunk..<min(chunk + chunkSize, selected.count)])
                for h in batch {
                    group.addTask {
                        do {
                            try await APIService.shared.updateHoldingShowOnStorefront(holdingId: h.id, show: false)
                            return (h.id, true)
                        } catch {
                            return (h.id, false)
                        }
                    }
                }
                for await (id, ok) in group where !ok {
                    failedIds.insert(id)
                }
            }
        }
        if !failedIds.isEmpty {
            holdings = holdings.map { h in
                guard failedIds.contains(h.id) else { return h }
                return StorefrontHolding(
                    id: h.id, playerName: h.playerName, cardTitle: h.cardTitle,
                    cardYear: h.cardYear, setName: h.setName, cardNumber: h.cardNumber,
                    parallel: h.parallel, gradeCompany: h.gradeCompany, gradeValue: h.gradeValue,
                    imageUrl: h.imageUrl, photos: h.photos, fairMarketValue: h.fairMarketValue,
                    estimatedValue: h.estimatedValue, showOnStorefront: true
                )
            }
            let done = selected.count - failedIds.count
            errorMessage = "Cleared \(done). \(failedIds.count) failed — try again."
        }
    }

    private func selectionBadge(on: Bool, busy: Bool) -> some View {
        let symbol: String
        if busy { symbol = "circle.dotted" }
        else if on { symbol = "checkmark.circle.fill" }
        else { symbol = "circle" }
        let tint = on ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue
        return Image(systemName: symbol)
            .font(.title3.weight(.semibold))
            .foregroundStyle(tint)
            .background(HobbyIQTheme.Colors.appBackground.opacity(0.95))
            .clipShape(Circle())
    }

    // ─── actions ───────────────────────────────────────────────

    private func load() async {
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            async let sessionTask = APIService.shared.fetchSession()
            async let holdingsTask = APIService.shared.fetchStorefrontHoldings()
            let (session, hs) = try await (sessionTask, holdingsTask)
            self.user = session.user
            self.holdings = hs
        } catch {
            errorMessage = "Couldn't load storefront — \(error.localizedDescription)"
        }
    }

    private func onToggleShare(_ next: Bool) async {
        guard !togglingShare else { return }
        togglingShare = true
        defer { togglingShare = false }
        do {
            let ok = try await APIService.shared.setPublicShareEnabled(next)
            if ok, let current = user {
                // Rebuild with the new visibility since BackendAuthUser is a struct
                // with `let` fields.
                self.user = BackendAuthUser(
                    userId: current.userId,
                    email: current.email,
                    plan: current.plan,
                    createdAt: current.createdAt,
                    username: current.username,
                    fullName: current.fullName,
                    publicShareEnabled: next,
                    emailVerified: current.emailVerified,
                    emailVerificationPending: current.emailVerificationPending,
                    entitlementOverride: current.entitlementOverride
                )
            }
        } catch {
            errorMessage = "Couldn't update visibility — \(error.localizedDescription)"
        }
    }

    private func onToggleCard(_ h: StorefrontHolding, on: Bool, cap: Int?, currentSelectedCount: Int) async {
        // Cap check on add only (removes always OK)
        if on, let cap, currentSelectedCount >= cap {
            errorMessage = "Tier cap: \(cap) cards. Remove one before adding another, or upgrade to Pro Seller for a higher cap."
            return
        }
        errorMessage = nil
        busyHoldingIds.insert(h.id)
        defer { busyHoldingIds.remove(h.id) }

        // Optimistic
        let originalIndex = holdings.firstIndex(where: { $0.id == h.id })
        if let originalIndex {
            var updated = holdings
            let old = updated[originalIndex]
            updated[originalIndex] = StorefrontHolding(
                id: old.id, playerName: old.playerName, cardTitle: old.cardTitle,
                cardYear: old.cardYear, setName: old.setName, cardNumber: old.cardNumber,
                parallel: old.parallel, gradeCompany: old.gradeCompany, gradeValue: old.gradeValue,
                imageUrl: old.imageUrl, photos: old.photos, fairMarketValue: old.fairMarketValue,
                estimatedValue: old.estimatedValue, showOnStorefront: on
            )
            holdings = updated
        }
        do {
            try await APIService.shared.updateHoldingShowOnStorefront(holdingId: h.id, show: on)
        } catch {
            // Rollback
            if let originalIndex {
                holdings[originalIndex] = h
            }
            errorMessage = "Update failed — \(error.localizedDescription)"
        }
    }

    // ─── helpers ───────────────────────────────────────────────

    private static func planLabel(_ plan: String) -> String {
        switch plan {
        case "free": return "Free"
        case "collector": return "Collector"
        case "investor": return "Investor"
        case "pro_seller": return "Pro Seller"
        default: return plan
        }
    }

    private static func capFor(plan: String) -> Int? {
        switch plan {
        case "investor": return investorCap
        case "pro_seller": return proSellerCap
        default: return nil
        }
    }
}

// BackendAuthUser is Decodable-only; give it a memberwise init so
// StorefrontView can rebuild it after a local mutation. Kept in an
// extension to preserve the strict init the decoder synthesizes.
extension BackendAuthUser {
    init(
        userId: String, email: String, plan: String, createdAt: String,
        username: String?, fullName: String?,
        publicShareEnabled: Bool?, emailVerified: Bool?,
        emailVerificationPending: Bool?, entitlementOverride: String?
    ) {
        self.userId = userId
        self.email = email
        self.plan = plan
        self.createdAt = createdAt
        self.username = username
        self.fullName = fullName
        self.publicShareEnabled = publicShareEnabled
        self.emailVerified = emailVerified
        self.emailVerificationPending = emailVerificationPending
        self.entitlementOverride = entitlementOverride
    }
}
