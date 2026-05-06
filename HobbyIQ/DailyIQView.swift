//
//  DailyIQView.swift
//  HobbyIQ
//

import SwiftUI

struct DailyIQView: View {
    private let milbHitters = DailyIQMockPlayer.milbHitters
    private let milbPitchers = DailyIQMockPlayer.milbPitchers
    private let mlbHitters = DailyIQMockPlayer.mlbHitters
    private let mlbPitchers = DailyIQMockPlayer.mlbPitchers
    private let milbWatch = DailyIQMockNote.milbWatch
    private let mlbWatch = DailyIQMockNote.mlbWatch
    private let milbMovers = DailyIQMockNote.milbMovers
    private let mlbMovers = DailyIQMockNote.mlbMovers
    private let milbTracker = DailyIQAppearance.milb
    private let mlbTracker = DailyIQAppearance.mlb

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: AppSpacing.large) {
                header
                buySignalsSection
                milbSection
                mlbSection
            }
            .padding(AppSpacing.screenPadding)
            .padding(.bottom, 32)
        }
        .background(AppColors.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .accountToolbar()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
            Text("DailyIQ")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(AppColors.textPrimary)

            Text("Top MLB and MiLB performers from yesterday")
                .font(.subheadline)
                .foregroundStyle(AppColors.textSecondary)

            Text(Date.now.formatted(date: .abbreviated, time: .omitted))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(AppColors.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var buySignalsSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Text("Top Buy Signals")
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            VStack(spacing: AppSpacing.medium) {
                BuySignalCard(signal: .milb)
                BuySignalCard(signal: .mlb)
            }
        }
    }

    private var milbSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.large) {
            SectionTitleCard(
                title: "MiLB Daily Prospect Brief",
                subtitle: "Top minor league performances from yesterday"
            )

            DailyPlayerSection(title: "Verified Top Prospect Performances", subtitle: "Hitters", players: milbHitters)
            DailyPlayerSection(title: "", subtitle: "Pitchers", players: milbPitchers)
            DailyNoteSection(title: "Prospect Watch", notes: milbWatch)
            DailyNoteSection(title: "PerformanceIQ - Hobby Movers", notes: milbMovers)
            AppearanceTrackerSection(title: "MiLB Multi-Appearance Tracker", appearances: milbTracker)
        }
    }

    private var mlbSection: some View {
        VStack(alignment: .leading, spacing: AppSpacing.large) {
            SectionTitleCard(
                title: "MLB Daily Brief",
                subtitle: "Top MLB performances from yesterday"
            )

            DailyPlayerSection(title: "Verified Top MLB Performances", subtitle: "Hitters", players: mlbHitters)
            DailyPlayerSection(title: "", subtitle: "Pitchers", players: mlbPitchers)
            DailyNoteSection(title: "MLB Watch", notes: mlbWatch)
            DailyNoteSection(title: "PerformanceIQ - MLB Hobby Movers", notes: mlbMovers)
            AppearanceTrackerSection(title: "MLB Multi-Appearance Tracker", appearances: mlbTracker)
        }
    }
}

private struct BuySignalCard: View {
    enum SignalType {
        case milb
        case mlb

        var title: String {
            switch self {
            case .milb: return "Top MiLB Buy Signal"
            case .mlb: return "Top MLB Buy Signal"
            }
        }

        var playerName: String {
            switch self {
            case .milb: return "Leo De Vries"
            case .mlb: return "Gunnar Henderson"
            }
        }

        var team: String {
            switch self {
            case .milb: return "San Diego • A+"
            case .mlb: return "Baltimore • MLB"
            }
        }

        var appearances: String {
            switch self {
            case .milb: return "4 appearances in the past 2 weeks"
            case .mlb: return "3 appearances in the past 2 weeks"
            }
        }

        var label: String {
            switch self {
            case .milb: return "Top Buy Watch"
            case .mlb: return "Watch"
            }
        }

        var reason: String {
            switch self {
            case .milb: return "Momentum is building after multiple strong showings."
            case .mlb: return "Cards may get more attention if the power stays hot."
            }
        }

        var takeaway: String {
            switch self {
            case .milb: return "Still risky - watch pricing."
            case .mlb: return "Short-term buzz looks real, but do not chase too high."
            }
        }
    }

    let signal: SignalType

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Text(signal.title)
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
                    Text(signal.playerName)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppColors.textPrimary)
                    Text(signal.team)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)
                }

                Spacer(minLength: 12)

                Text(signal.label)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppColors.background)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(AppColors.accent)
                    .clipShape(Capsule())
            }

            Text(signal.appearances)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.accent)

            Text(signal.reason)
                .font(.subheadline)
                .foregroundStyle(AppColors.textSecondary)

            Text(signal.takeaway)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(AppColors.textPrimary)
        }
        .appGlassCardStyle(radius: AppCardRadius.large)
    }
}

private struct SectionTitleCard: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(AppColors.textPrimary)

            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(AppColors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DailyPlayerSection: View {
    let title: String
    let subtitle: String
    let players: [DailyIQMockPlayer]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            if title.isEmpty == false {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(AppColors.textPrimary)
            }

            Text(subtitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.accent)

            ForEach(players) { player in
                DailyPlayerCard(player: player)
            }
        }
    }
}

private struct DailyPlayerCard: View {
    let player: DailyIQMockPlayer
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                VStack(alignment: .leading, spacing: AppSpacing.small) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(player.name)
                                .font(.headline)
                                .foregroundStyle(AppColors.textPrimary)
                            Text(player.topLine)
                                .font(.subheadline)
                                .foregroundStyle(AppColors.textSecondary)
                        }

                        Spacer()

                        Text(isExpanded ? "See Less" : "See More")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(AppColors.accent)
                    }

                    Text(player.statLine)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppColors.accent)

                    Text(player.performanceNote)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)

                    Text(player.hobbyTakeaway)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(AppColors.textPrimary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: AppSpacing.xSmall) {
                    if let firstBowmanYear = player.firstBowmanYear {
                        DailyDetailRow(title: "First Bowman", value: firstBowmanYear)
                    }

                    if let rankingNote = player.rankingNote {
                        DailyDetailRow(title: "Ranking note", value: rankingNote)
                    }

                    if let rookieNote = player.rookieNote {
                        DailyDetailRow(title: "Key card note", value: rookieNote)
                    }

                    DailyDetailRow(title: "Why it matters", value: player.whyItMatters)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .appGlassCardStyle(radius: AppCardRadius.large)
    }
}

private struct DailyDetailRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: AppSpacing.small) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppColors.textSecondary)
            Spacer(minLength: 12)
            Text(value)
                .font(.subheadline)
                .foregroundStyle(AppColors.textPrimary)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct DailyNoteSection: View {
    let title: String
    let notes: [DailyIQMockNote]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            ForEach(notes) { note in
                VStack(alignment: .leading, spacing: AppSpacing.small) {
                    Text(note.title)
                        .font(.headline)
                        .foregroundStyle(AppColors.textPrimary)

                    Text(note.note)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)

                    Text(note.takeaway)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(AppColors.accent)
                }
                .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.large)
            }
        }
    }
}

private struct AppearanceTrackerSection: View {
    let title: String
    let appearances: [DailyIQAppearance]

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.medium) {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            ForEach(appearances) { appearance in
                HStack {
                    Text(appearance.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppColors.textPrimary)
                    Spacer()
                    Text("\(appearance.count)x")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(AppColors.accent)
                }
                .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.medium)
            }
        }
    }
}

private struct DailyIQMockPlayer: Identifiable {
    let id = UUID()
    let name: String
    let topLine: String
    let statLine: String
    let performanceNote: String
    let hobbyTakeaway: String
    let whyItMatters: String
    let firstBowmanYear: String?
    let rankingNote: String?
    let rookieNote: String?

    static let milbHitters: [DailyIQMockPlayer] = [
        DailyIQMockPlayer(
            name: "Leo De Vries",
            topLine: "San Diego • A+ • SS",
            statLine: "3-for-5, HR, 2 RBI, SB",
            performanceNote: "Strong game with impact at the plate and on the bases.",
            hobbyTakeaway: "Buy interest rising",
            whyItMatters: "Multiple strong showings are building hobby momentum.",
            firstBowmanYear: "2024",
            rankingNote: "Top 20 overall prospect",
            rookieNote: nil
        ),
        DailyIQMockPlayer(
            name: "Walker Jenkins",
            topLine: "Minnesota • A • OF",
            statLine: "2-for-4, 2B, 3 RBI",
            performanceNote: "Barreled the ball all night.",
            hobbyTakeaway: "Strong game",
            whyItMatters: "Another loud night keeps him on the watch list.",
            firstBowmanYear: "2024",
            rankingNote: "Top 10 system rank",
            rookieNote: nil
        )
    ]

    static let milbPitchers: [DailyIQMockPlayer] = [
        DailyIQMockPlayer(
            name: "Chase Burns",
            topLine: "Cincinnati • AA • SP",
            statLine: "5 IP, 9 K, 1 ER",
            performanceNote: "Missed bats all outing.",
            hobbyTakeaway: "Watch list",
            whyItMatters: "Fast-rising stuff keeps his best cards in focus.",
            firstBowmanYear: "2025",
            rankingNote: "Fast-rising arm",
            rookieNote: nil
        )
    ]

    static let mlbHitters: [DailyIQMockPlayer] = [
        DailyIQMockPlayer(
            name: "Gunnar Henderson",
            topLine: "Baltimore • MLB • INF",
            statLine: "3-for-5, HR, 2 RBI",
            performanceNote: "Big game with loud contact.",
            hobbyTakeaway: "Cards may get more attention",
            whyItMatters: "When the bat heats up, his premium cards move fast.",
            firstBowmanYear: nil,
            rankingNote: nil,
            rookieNote: "Key rookie chrome cards still lead the market"
        ),
        DailyIQMockPlayer(
            name: "Bobby Witt Jr.",
            topLine: "Kansas City • MLB • SS",
            statLine: "2-for-4, 2B, 3 R",
            performanceNote: "Fast start and all-around impact.",
            hobbyTakeaway: "Momentum is building",
            whyItMatters: "Power and speed nights keep him in hobby talk.",
            firstBowmanYear: nil,
            rankingNote: nil,
            rookieNote: "Flagship rookies still get the most eyes"
        )
    ]

    static let mlbPitchers: [DailyIQMockPlayer] = [
        DailyIQMockPlayer(
            name: "Paul Skenes",
            topLine: "Pittsburgh • MLB • SP",
            statLine: "6 IP, 10 K, 0 ER",
            performanceNote: "Power stuff looked real again.",
            hobbyTakeaway: "Still risky - watch pricing",
            whyItMatters: "Pitching hype and results together can move the market fast.",
            firstBowmanYear: nil,
            rankingNote: nil,
            rookieNote: "Top rookie and debut cards still lead demand"
        )
    ]
}

private struct DailyIQMockNote: Identifiable {
    let id = UUID()
    let title: String
    let note: String
    let takeaway: String

    static let milbWatch: [DailyIQMockNote] = [
        DailyIQMockNote(
            title: "Sebastian Walcott",
            note: "Big upside profile. A few strong games can move hobby talk fast.",
            takeaway: "Watch list"
        ),
        DailyIQMockNote(
            title: "Jesús Made",
            note: "Quiet box score, but the tools still make him worth tracking.",
            takeaway: "More data needed"
        )
    ]

    static let mlbWatch: [DailyIQMockNote] = [
        DailyIQMockNote(
            title: "Jackson Merrill",
            note: "A hot week could bring more eyes back to his top rookie cards.",
            takeaway: "Watch list"
        )
    ]

    static let milbMovers: [DailyIQMockNote] = [
        DailyIQMockNote(
            title: "Leo De Vries",
            note: "A loud game can bring more eyes to his first key cards.",
            takeaway: "Buy interest rising"
        )
    ]

    static let mlbMovers: [DailyIQMockNote] = [
        DailyIQMockNote(
            title: "Gunnar Henderson",
            note: "Strong production can lift short-term hobby buzz.",
            takeaway: "Cards may get more attention"
        ),
        DailyIQMockNote(
            title: "Paul Skenes",
            note: "Premium arms can move fast after another dominant outing.",
            takeaway: "Still risky - watch pricing"
        )
    ]
}

private struct DailyIQAppearance: Identifiable {
    let id = UUID()
    let name: String
    let count: Int

    static let milb: [DailyIQAppearance] = [
        DailyIQAppearance(name: "Leo De Vries", count: 4),
        DailyIQAppearance(name: "Walker Jenkins", count: 3),
        DailyIQAppearance(name: "Chase Burns", count: 2)
    ]

    static let mlb: [DailyIQAppearance] = [
        DailyIQAppearance(name: "Gunnar Henderson", count: 3),
        DailyIQAppearance(name: "Paul Skenes", count: 3),
        DailyIQAppearance(name: "Bobby Witt Jr.", count: 2)
    ]
}

#Preview {
    NavigationStack {
        DailyIQView()
    }
}
