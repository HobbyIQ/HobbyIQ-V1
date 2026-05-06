//
//  DashboardComponents.swift
//  HobbyIQ
//

import SwiftUI

struct DashboardHeaderView: View {
    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 6) {
                Text("HobbyIQ")
                    .font(.title.bold())
                    .foregroundStyle(.white)
                Text("Your Edge Today")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }

            Spacer()

            HStack(spacing: 10) {
                CircleButton(systemName: "bell.fill")
                CircleButton(systemName: "person.crop.circle")
            }
        }
    }
}

struct AppPageHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.largeTitle.bold())
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct GlobalSearchBar: View {
    @Binding var text: String
    var placeholder: String = "Search players, cards, comps..."

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.textMuted)

            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .foregroundStyle(.white)

            if text.isEmpty == false {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(HobbyIQTheme.textMuted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .background(HobbyIQTheme.card)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(HobbyIQTheme.stroke, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct DashboardSection<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }

            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SummaryStripView: View {
    let stats: [SummaryStat]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(stats) { stat in
                    SummaryMetricCard(stat: stat)
                }
            }
        }
    }
}

struct SummaryMetricCard: View {
    let stat: SummaryStat

    var body: some View {
        GlassCard(width: 150) {
            VStack(alignment: .leading, spacing: 10) {
                Text(stat.title)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
                Text(stat.value)
                    .font(.title3.bold())
                    .foregroundStyle(.white)
                Text(stat.changeText)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(stat.isPositive ? HobbyIQTheme.green : .orange)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct SingleHighlightCard: View {
    let title: String
    let value: String
    let note: String

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.green)
                Text(value)
                    .font(.title3.bold())
                    .foregroundStyle(.white)
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct TrendingNowCard: View {
    let item: TrendingItem

    var body: some View {
        GlassCard(width: 220) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    TagView(text: item.tag, style: .green)
                    Spacer()
                    Text(item.change)
                        .font(.subheadline.bold())
                        .foregroundStyle(HobbyIQTheme.green)
                }

                Text(item.name)
                    .font(.headline)
                    .foregroundStyle(.white)

                Text(item.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct OpportunityCard: View {
    let item: OpportunityItem

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.player)
                            .font(.headline)
                            .foregroundStyle(.white)
                        Text(item.card)
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }
                    Spacer()
                    TagView(text: item.tag, style: .green)
                }

                HStack(spacing: 10) {
                    SmallInfoPill(title: "Market", value: item.marketPrice)
                    SmallInfoPill(title: "Value", value: item.fairValue)
                    SmallInfoPill(title: "Gap", value: item.discountText)
                }

                Text(item.reason)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct MarketMoverCard: View {
    let mover: MarketMover

    var body: some View {
        GlassCard(width: 170) {
            VStack(alignment: .leading, spacing: 8) {
                Text(mover.title)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
                Text(mover.value)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(mover.note)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.green)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct RiskSignalCard: View {
    let item: RiskItem

    var body: some View {
        GlassCard {
            HStack(alignment: .top, spacing: 12) {
                Circle()
                    .fill(item.level.color)
                    .frame(width: 10, height: 10)
                    .padding(.top, 7)

                VStack(alignment: .leading, spacing: 6) {
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(item.detail)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                    Text(item.action)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(item.level.color)
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct TopSearchedRow: View {
    let item: SearchRankItem

    var body: some View {
        GlassCard {
            HStack(spacing: 12) {
                Text("\(item.rank)")
                    .font(.headline.bold())
                    .foregroundStyle(HobbyIQTheme.green)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(item.detail)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }

                Spacer()
                TagView(text: item.tag, style: .green)
            }
        }
    }
}

struct PortfolioWatchCard: View {
    let item: PortfolioWatchItem

    var body: some View {
        GlassCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(item.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }
                Spacer()
                TagView(text: item.tag, style: .neutral)
            }
        }
    }
}

struct DailyIQPreviewCard: View {
    let topPerformer: String
    let hobbyMover: String

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                Text(topPerformer)
                    .font(.headline)
                    .foregroundStyle(.white)
                Text(hobbyMover)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)

                Button {
                } label: {
                    Text("See Full Report")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.bg)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(HobbyIQTheme.green)
                        .clipShape(Capsule())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct QuickActionsGrid: View {
    private let actions: [(String, String)] = [
        ("plus.circle.fill", "Add Card"),
        ("magnifyingglass", "Search Card"),
        ("chart.line.uptrend.xyaxis", "Portfolio"),
        ("bell.fill", "Alerts")
    ]

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(actions, id: \.1) { action in
                GlassCard {
                    HStack(spacing: 10) {
                        Image(systemName: action.0)
                            .foregroundStyle(HobbyIQTheme.green)
                        Text(action.1)
                            .font(.headline)
                            .foregroundStyle(.white)
                        Spacer()
                    }
                }
            }
        }
    }
}

struct CompRow: View {
    let item: CompRowItem

    var body: some View {
        GlassCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(item.date)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }
                Spacer()
                Text(item.price)
                    .font(.headline.bold())
                    .foregroundStyle(HobbyIQTheme.green)
            }
        }
    }
}

struct LadderRow: View {
    let item: LadderItem

    var body: some View {
        GlassCard {
            HStack {
                Text(item.name)
                    .font(.headline)
                    .foregroundStyle(.white)
                Spacer()
                Text(item.value)
                    .font(.headline.bold())
                    .foregroundStyle(HobbyIQTheme.green)
            }
        }
    }
}

struct MiniMetricCard: View {
    let title: String
    let value: String
    let note: String

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
                Text(value)
                    .font(.headline.bold())
                    .foregroundStyle(.white)
                Text(note)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ZoneCard: View {
    let title: String
    let value: String
    let detail: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
                .foregroundStyle(.white)
            Text(value)
                .font(.title3.bold())
                .foregroundStyle(HobbyIQTheme.green)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color)
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(HobbyIQTheme.stroke, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct HoldingCard: View {
    let item: HoldingItem

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.player)
                            .font(.headline)
                            .foregroundStyle(.white)
                        Text(item.card)
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                    }
                    Spacer()
                    TagView(text: item.tag, style: .neutral)
                }

                HStack(spacing: 10) {
                    SmallInfoPill(title: "Paid", value: item.cost)
                    SmallInfoPill(title: "Now", value: item.value)
                    SmallInfoPill(title: "P/L", value: item.pnl)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct MoreRow: View {
    let item: MoreItem

    var body: some View {
        GlassCard {
            HStack(spacing: 12) {
                Image(systemName: item.icon)
                    .foregroundStyle(HobbyIQTheme.green)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(item.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .foregroundStyle(HobbyIQTheme.textMuted)
            }
        }
    }
}

struct ScoreBadge: View {
    let score: Int

    var body: some View {
        VStack(spacing: 2) {
            Text("\(score)")
                .font(.title.bold())
                .foregroundStyle(HobbyIQTheme.bg)
            Text("Score")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.bg.opacity(0.8))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.green)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct CircleButton: View {
    let systemName: String

    var body: some View {
        Button {
        } label: {
            Image(systemName: systemName)
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(HobbyIQTheme.card)
                .overlay(
                    Circle().stroke(HobbyIQTheme.stroke, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

struct SmallInfoPill: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.textMuted)
            Text(value)
                .font(.subheadline.bold())
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct GlassCard<Content: View>: View {
    var width: CGFloat? = nil
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: width ?? .infinity, alignment: .leading)
            .background(HobbyIQTheme.card)
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .stroke(HobbyIQTheme.stroke, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

struct TagView: View {
    enum Style {
        case green
        case neutral
    }

    let text: String
    let style: Style

    private var background: Color {
        switch style {
        case .green: return HobbyIQTheme.greenSoft
        case .neutral: return Color.white.opacity(0.10)
        }
    }

    private var textColor: Color {
        switch style {
        case .green: return HobbyIQTheme.green
        case .neutral: return .white.opacity(0.85)
        }
    }

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(textColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(background)
            .clipShape(Capsule())
    }
}

struct SummaryStat: Identifiable {
    let id = UUID()
    let title: String
    let value: String
    let changeText: String
    let isPositive: Bool
}

struct TrendingItem: Identifiable {
    let id = UUID()
    let name: String
    let subtitle: String
    let change: String
    let tag: String
}

struct OpportunityItem: Identifiable {
    let id = UUID()
    let player: String
    let card: String
    let marketPrice: String
    let fairValue: String
    let discountText: String
    let tag: String
    let reason: String
}

struct MarketMover: Identifiable {
    let id = UUID()
    let title: String
    let value: String
    let note: String
}

struct RiskItem: Identifiable {
    enum Level {
        case good
        case warning
        case danger

        var color: Color {
            switch self {
            case .good: return HobbyIQTheme.green
            case .warning: return .yellow
            case .danger: return .red
            }
        }
    }

    let id = UUID()
    let title: String
    let detail: String
    let action: String
    let level: Level
}

struct SearchRankItem: Identifiable {
    let id = UUID()
    let rank: Int
    let name: String
    let detail: String
    let tag: String
}

struct PortfolioWatchItem: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    let tag: String
}

struct CompRowItem: Identifiable {
    let id = UUID()
    let title: String
    let price: String
    let date: String
}

struct LadderItem: Identifiable {
    let id = UUID()
    let name: String
    let value: String
}

struct HoldingItem: Identifiable {
    let id = UUID()
    let player: String
    let card: String
    let cost: String
    let value: String
    let pnl: String
    let tag: String
}

struct MoreItem: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    let icon: String
}
