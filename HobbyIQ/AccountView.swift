//
//  AccountView.swift
//  HobbyIQ
//

import SwiftUI
import PhotosUI

struct AccountView: View {
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @StateObject private var viewModel = AccountViewModel()
    @StateObject private var profileImageStore = ProfileImageStore.shared
    @State private var selectedAgeTier: AgeTier = AgeTier.current
    @State private var selectedPhotoItem: PhotosPickerItem?
    @State private var showDeleteWarning = false
    @State private var showFinalDeleteConfirmation = false
    @State private var showUsernameSheet = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 14) {
                    profileCard
                    // CF-NEW-RELEASES-ENTRY (2026-07-04, backend batch §3):
                    // "New Releases" catalog-additions feed placed directly
                    // under the main profile/account tile so it reads as
                    // the primary "browse" affordance from the account
                    // screen.
                    newReleasesRow
                    usernameRow
                    membershipCard
                    settingsSection
                    CommunitySettingsSection()
                    integrationsSection
                    dataSection
                    recapSection
                    appInfoSection
                    signOutSection
                    deleteAccountSection

                    if let statusMessage = viewModel.statusMessage {
                        statusBanner(statusMessage)
                            .onTapGesture { viewModel.clearStatus() }
                    }
                }
                .padding(16)
                .padding(.bottom, 32)
            }
            .background(HobbyIQBackground())
            .task { await viewModel.loadNotificationPreferences() }
            .task { await viewModel.loadPortfolioPreferences() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Text("Account")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 20))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    .buttonStyle(.plain)
                }
            }
            .toolbarBackground(HobbyIQTheme.Colors.cardNavy, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    // MARK: - New Releases entry

    private var newReleasesRow: some View {
        NavigationLink {
            NewReleasesView()
                .environmentObject(sessionViewModel)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "sparkles.rectangle.stack")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(width: 40, height: 40)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("New Releases")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("Latest catalog additions across every sport")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Profile Card

    private var profileCard: some View {
        let currentImage = profileImageStore.image
        return HStack(spacing: 14) {
            PhotosPicker(selection: $selectedPhotoItem, matching: .images) {
                if let uiImage = currentImage {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 2)
                        )
                        .overlay(alignment: .bottomTrailing) {
                            Image(systemName: "pencil.circle.fill")
                                .font(.system(size: 16))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                .background(Circle().fill(HobbyIQTheme.Colors.cardNavy).padding(-1))
                                .offset(x: 2, y: 2)
                        }
                } else {
                    ZStack {
                        Circle()
                            .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.15))
                            .frame(width: 48, height: 48)
                            .overlay(
                                Circle()
                                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 2)
                            )
                        Image(systemName: "camera.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                }
            }
            .buttonStyle(.plain)
            .onChange(of: selectedPhotoItem) { _, newItem in
                guard let newItem else { return }
                Task {
                    if let data = try? await newItem.loadTransferable(type: Data.self),
                       let uiImage = UIImage(data: data) {
                        profileImageStore.setImage(uiImage)
                    }
                    selectedPhotoItem = nil
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(sessionViewModel.currentUser?.displayName ?? sessionViewModel.currentUser?.email ?? "User")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)

                if let email = sessionViewModel.currentUser?.email {
                    Text(email)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
            }

            Spacer()
        }
        .accountCard()
    }

    // MARK: - Username

    private var usernameRow: some View {
        Button {
            showUsernameSheet = true
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("USERNAME")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(1.0)
                    Text(sessionViewModel.currentUser?.displayName ?? "Not set")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                Spacer()
                Image(systemName: "pencil")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .accountCard()
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showUsernameSheet) {
            UsernameChangeSheet(sessionViewModel: sessionViewModel, onChanged: {
                viewModel.statusMessage = "Username updated."
            })
        }
    }

    // MARK: - Membership Card

    private var membershipCard: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("MEMBERSHIP")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.0)

                Text(sessionViewModel.activeTier.title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 6) {
                Button {
                    Task { await viewModel.restorePurchases(using: sessionViewModel) }
                } label: {
                    Text("Restore")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.2))
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)

                Button {
                    viewModel.manageSubscription()
                } label: {
                    Text("Manage")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.white.opacity(0.05))
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(HobbyIQTheme.Colors.mutedText.opacity(0.3), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .accountCard()
    }

    // MARK: - Settings

    private var settingsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            accountSectionHeader("SETTINGS")

            VStack(spacing: 0) {
                Toggle(isOn: Binding(
                    get: { viewModel.dailyIQAlerts },
                    set: { newValue in Task { await viewModel.updateDailyIQAlerts(newValue) } }
                )) {
                    Text("DailyIQ Alerts")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                .tint(HobbyIQTheme.Colors.electricBlue)
                .padding(.vertical, 8)
                accountDivider
                Toggle(isOn: Binding(
                    get: { viewModel.priceAlerts },
                    set: { newValue in Task { await viewModel.updatePriceAlerts(newValue) } }
                )) {
                    Text("Price Alerts")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                .tint(HobbyIQTheme.Colors.electricBlue)
                .padding(.vertical, 8)
                accountDivider
                Toggle(isOn: Binding(
                    get: { viewModel.portfolioMovementAlerts },
                    set: { newValue in Task { await viewModel.updatePortfolioMovementAlerts(newValue) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Portfolio Movement Digest")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text("Daily summary of card movement signals")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                .tint(HobbyIQTheme.Colors.electricBlue)
                .padding(.vertical, 8)
                accountDivider
                // P0.7 (2026-07-16, verdict-history-flip-surfaces.md +
                // backend PR #501): opt-in for the major-flip push.
                Toggle(isOn: Binding(
                    get: { viewModel.verdictFlipAlerts },
                    set: { newValue in Task { await viewModel.updateVerdictFlipAlerts(newValue) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Major flips")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text("Get pinged when a holding you own moves from HOLD to SELL_NOW or similar.")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .tint(HobbyIQTheme.Colors.electricBlue)
                .padding(.vertical, 8)
                accountDivider
                // Phase 3.9 (2026-07-17, PR #531): cascade signal push.
                // Default OFF — explicit opt-in per spec because this
                // is a lower-signal firehose vs. verdict flips.
                Toggle(isOn: Binding(
                    get: { viewModel.cascadeAlerts },
                    set: { newValue in Task { await viewModel.updateCascadeAlerts(newValue) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Cascade signals")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text("Get pinged when a player's graded market is moving ahead of the raw market — insider early-signal, before wider prices catch on.")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .tint(HobbyIQTheme.Colors.electricBlue)
                .padding(.vertical, 8)
                // APNs registration caption sits below both push toggles
                // since it applies to any push (both use the same token).
                apnsRegistrationCaption
                // Phase 3.9 footer: pushes fire during the nightly cron.
                Text("Notifications delivered nightly at ~1am ET when signals fire on players you own.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 4)
                accountDivider
                accountToggle("Haptics", isOn: $viewModel.settings.hapticsEnabled)
                accountDivider
                VStack(alignment: .leading, spacing: 8) {
                    Text("Age Range")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    HStack(spacing: 10) {
                        ForEach(AgeTier.allCases) { tier in
                            Button {
                                selectedAgeTier = tier
                                AgeTier.current = tier
                            } label: {
                                Text(tier.displayName)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(selectedAgeTier == tier ? HobbyIQTheme.Colors.appBackground : HobbyIQTheme.Colors.pureWhite)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                                    .background(selectedAgeTier == tier ? HobbyIQTheme.Colors.electricBlue : Color.white.opacity(0.05))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            .stroke(selectedAgeTier == tier ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText.opacity(0.3), lineWidth: 1.4)
                                    )
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.vertical, 8)
            }
            .accountCard()
        }
    }

    // MARK: - Integrations

    private var integrationsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            accountSectionHeader("INTEGRATIONS")

            VStack(spacing: 0) {
                EbayConnectView()
            }
            .accountCard()
        }
    }

    // MARK: - Data (2026-07-20 spec)

    /// Portfolio data-portability entry point: download holdings +
    /// comp contributions, bulk-import from a spreadsheet.
    /// Full flow lives in `PortfolioDataView`.
    private var dataSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            accountSectionHeader("DATA")
            VStack(spacing: 0) {
                NavigationLink {
                    PortfolioDataView()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Portfolio import / export")
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            Text("Download holdings, edit in Excel, re-upload changes")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .accountCard()
        }
    }

    // MARK: - Phase 4 (2026-07-17): Recap surfaces

    private var recapSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            accountSectionHeader("RECAP")
            VStack(spacing: 0) {
                NavigationLink {
                    ICalledItView()
                } label: {
                    HStack {
                        Text("Recent flexes")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                accountDivider

                yearbookLink

                accountDivider

                // Batch 2 (2026-07-17, PR #538): portfolio attribution
                // health. Lazy-loads on tap so the account screen doesn't
                // spend rate-limit budget just being viewed.
                AttributionHealthRow()
            }
            .accountCard()
        }
    }

    /// Yearbook is a year-end surface — per spec "Available after Dec 15".
    /// Before that date, the row still renders but reads as informational
    /// so users know it's coming. Tapping opens the current year's view
    /// with whatever partial data the backend has assembled.
    @ViewBuilder
    private var yearbookLink: some View {
        let year = Calendar.current.component(.year, from: Date())
        let isAvailable = isYearbookAvailable()
        NavigationLink {
            YearbookView(year: year)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your \(String(year)) Yearbook")
                        .font(.subheadline)
                        .foregroundStyle(isAvailable ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.pureWhite.opacity(0.55))
                    if isAvailable == false {
                        Text("Full recap available after Dec 15")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func isYearbookAvailable() -> Bool {
        let cal = Calendar.current
        let now = Date()
        let month = cal.component(.month, from: now)
        let day = cal.component(.day, from: now)
        return month > 12 || (month == 12 && day >= 15)
    }

    // MARK: - App Info

    private var appInfoSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            accountSectionHeader("ABOUT")

            VStack(spacing: 0) {
                accountInfoRow("Version", value: viewModel.appVersionText)
                accountDivider
                accountInfoRow("Build", value: viewModel.buildNumber)
                accountDivider
                accountActionRow("Contact Support") { viewModel.contactSupport() }
                accountDivider
                accountActionRow("Send Feedback") { viewModel.sendFeedback() }
                accountDivider
                accountActionRow("Privacy Policy") {}
                accountDivider
                accountActionRow("Terms of Use") {}
            }
            .accountCard()
        }
    }

    // MARK: - Sign Out

    private var signOutSection: some View {
        Button {
            Task { await sessionViewModel.signOut() }
        } label: {
            HStack {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.subheadline.weight(.semibold))
                Text("Sign Out")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.danger)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(HobbyIQTheme.Colors.danger.opacity(0.1))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.danger.opacity(0.3), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Delete Account

    private var deleteAccountSection: some View {
        Button {
            showDeleteWarning = true
        } label: {
            HStack {
                Image(systemName: "trash.fill")
                    .font(.subheadline.weight(.semibold))
                Text("Delete Account")
                    .font(.subheadline.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.danger)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(HobbyIQTheme.Colors.danger.opacity(0.05))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.danger.opacity(0.2), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(sessionViewModel.isLoading)
        .alert("Delete Your Account?", isPresented: $showDeleteWarning) {
            Button("Continue", role: .destructive) {
                showFinalDeleteConfirmation = true
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This is permanent and cannot be undone. All your data — portfolio, watchlist, alerts, and preferences — will be deleted.\n\nIf you have an active subscription, you must cancel it separately in iOS Settings → Subscriptions. Deleting your account does not stop billing.")
        }
        .alert("Are you sure?", isPresented: $showFinalDeleteConfirmation) {
            Button("Delete My Account", role: .destructive) {
                Task { await sessionViewModel.deleteAccount() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This action cannot be reversed.")
        }
    }

    // MARK: - Helpers

    private func accountSectionHeader(_ title: String) -> some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)

            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.2)
                .fixedSize()

            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)
        }
    }

    private func accountToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .tint(HobbyIQTheme.Colors.electricBlue)
        .padding(.vertical, 8)
    }

    private func accountInfoRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.vertical, 8)
    }

    private func accountActionRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    private var accountDivider: some View {
        Divider()
            .overlay(HobbyIQTheme.Colors.electricBlue.opacity(0.1))
    }

    /// P1 (2026-07-16, iOS delta): APNs registration status caption below
    /// the Verdict Flip Alerts toggle. Three states:
    ///   - Registered: "Notifications registered · updated 3m ago"
    ///   - Not registered but iOS permission may be enabled: tappable row
    ///     that deep-links into iOS Settings → HobbyIQ so the user can
    ///     turn notifications on.
    ///   - Unknown (fetch hasn't completed yet): renders nothing.
    @ViewBuilder
    private var apnsRegistrationCaption: some View {
        if let device = viewModel.apnsDeviceStatus {
            if device.registered == true {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    Text("Notifications registered")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    if let ago = Self.apnsFreshnessLabel(device.registeredAt) {
                        Text("· updated \(ago)")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 2)
            } else {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "gearshape.fill")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        Text("Enable in iOS Settings → Notifications → HobbyIQ")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// "3m ago" / "2h ago" / "5d ago" style relative time for the APNs
    /// caption. Returns nil when the wire timestamp is missing or the
    /// ISO string is malformed.
    private static func apnsFreshnessLabel(_ iso: String?) -> String? {
        guard let iso else { return nil }
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
        let date = parsers.compactMap { $0.date(from: iso) }.first
        guard let date else { return nil }
        let delta = Date().timeIntervalSince(date)
        if delta < 60 { return "just now" }
        if delta < 3_600 { return "\(Int(delta / 60))m ago" }
        if delta < 86_400 { return "\(Int(delta / 3_600))h ago" }
        return "\(Int(delta / 86_400))d ago"
    }

    private func statusBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.successGreen)
            Text(message)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
        }
        .accountCard()
    }
}

// MARK: - Attribution Health row (2026-07-17, PR #538)

/// Row lives at the bottom of the Recap section. Fetches on tap so we
/// don't preload for every account-screen open. Renders a subhead of the
/// suspect count (or "all clear") next to the chevron.
struct AttributionHealthRow: View {
    @State private var response: AttributionHealthResponse?
    @State private var isLoading = false
    @State private var showList = false

    var body: some View {
        Button {
            Task { await loadIfNeeded() }
            showList = true
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Attribution health")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if let suspectCount = response?.suspectCount,
                       let scanned = response?.scannedHoldings, scanned > 0 {
                        if suspectCount > 0 {
                            Text("\(suspectCount) of \(scanned) flagged")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.warning)
                        } else {
                            Text("\(scanned) holdings · all clear")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    } else {
                        Text("Check community identity confidence for your holdings")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(2)
                    }
                }
                Spacer()
                if isLoading {
                    ProgressView().controlSize(.mini).tint(HobbyIQTheme.Colors.mutedText)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .navigationDestination(isPresented: $showList) {
            AttributionHealthListView(response: response)
        }
        .task {
            // Prefetch so the row's subhead shows real state on first
            // render — one call per account-open is well within budget.
            await loadIfNeeded()
        }
    }

    private func loadIfNeeded() async {
        guard response == nil, isLoading == false else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchAttributionHealth()
        } catch {
            // Silent — row renders default subhead on failure.
        }
    }
}

// MARK: - Card Modifier

private extension View {
    func accountCard() -> some View {
        self
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

// MARK: - Username Change Sheet

struct UsernameChangeSheet: View {
    @ObservedObject var sessionViewModel: AppSessionViewModel
    var onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var newUsername = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Choose a new username")
                        .font(.headline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("Letters, numbers, and underscores only. 3–30 characters.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                TextField("Username", text: $newUsername)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(14)
                    .background(Color(hex: 0x1A1D24))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 1.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .foregroundStyle(.white)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(isSaving ? "Saving…" : "Update Username") {
                    Task { await saveUsername() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSaving || newUsername.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)

                Spacer()
            }
            .padding(16)
            .background(HobbyIQBackground())
            .navigationTitle("Change Username")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
    }

    private func saveUsername() async {
        let trimmed = newUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else {
            errorMessage = "Username must be at least 3 characters."
            return
        }

        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let response = try await APIService.shared.changeUsername(username: trimmed)
            if response.success == true {
                onChanged()
                dismiss()
            } else {
                errorMessage = response.error ?? "Could not update username."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

#Preview {
    AccountView(sessionViewModel: AppSessionViewModel())
}
