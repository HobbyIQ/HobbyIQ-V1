import SwiftUI

struct HoldingRowCard: View {
    let holding: PortfolioHolding
    var dailyIQTrendCount: Int = 0
    var isDailyIQTrending: Bool = false
    var onTap: (() -> Void)? = nil

    var body: some View {
        Button(action: { onTap?() }) {
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    // Card type indicator
                    CardTypeBadgeColumn(holding: holding)

                    // Main content
                    VStack(alignment: .leading, spacing: 6) {
                        // Row 1: Player name + current value
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(holding.playerName)
                                    .font(.system(size: 15, weight: .bold))
                                    .foregroundColor(.white)
                                    .lineLimit(1)
                                Text(holding.cardTitle)
                                    .font(.caption)
                                    .foregroundColor(Color(.systemGray2))
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("$\(holding.currentValue, specifier: "%.0f")")
                                    .font(.system(size: 16, weight: .bold, design: .rounded))
                                    .foregroundColor(.white)
                                ProfitChangeLabel(amount: holding.totalProfitLoss, pct: holding.totalProfitLossPct)
                            }
                        }

                        // Row 2: Status chips + trend
                        HStack(spacing: 6) {
                            // Card status pill
                            HoldingStatusChip(status: holding.cardStatus)

                            // Grade badge (if graded)
                            if !holding.isRaw {
                                GradeBadge(company: holding.gradingCompany, grade: holding.grade)
                            } else {
                                RawConditionChip(condition: holding.conditionEstimate)
                            }

                            Spacer()

                            // DailyIQ streak + trend arrow
                            if isDailyIQTrending {
                                DailyIQTrendBadge(appearances: dailyIQTrendCount)
                            }
                            TrendPill(trend: holding.trend)
                        }

                        // Row 3: Metadata (quantity, days to sell, freshness)
                        HStack(spacing: 6) {
                            if holding.quantity > 1 {
                                MetaChip(text: "×\(holding.quantity)", color: Color(.systemGray2))
                            }
                            if let serial = holding.serialNumber, !serial.isEmpty {
                                MetaChip(text: serial, color: .purple)
                            }
                            if let days = holding.expectedDaysToSell, days < 60 {
                                MetaChip(
                                    text: "~\(days)d to sell",
                                    color: days <= 7 ? .red : days <= 21 ? .orange : .yellow
                                )
                            }
                            Spacer()
                            FreshnessBadge(status: holding.freshnessStatus, lastUpdated: holding.lastUpdated)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .background(cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(borderColor.opacity(0.3), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.12), radius: 5, x: 0, y: 2)
        }
        .buttonStyle(PlainButtonStyle())
    }

    // MARK: - Computed colors
    private var borderColor: Color {
        switch holding.cardStatus {
        case .listed:  return .orange
        case .grading: return .purple
        default:
            switch holding.riskLevel {
            case .high:   return .red
            case .medium: return .yellow
            default:      return .clear
            }
        }
    }

    private var cardBackground: some View {
        ZStack {
            Color(.secondarySystemBackground).opacity(0.72)
            if holding.cardStatus == .listed {
                Color.orange.opacity(0.04)
            } else if holding.cardStatus == .grading {
                Color.purple.opacity(0.04)
            } else if holding.riskLevel == .high {
                Color.red.opacity(0.04)
            }
        }
    }
}

// MARK: - Card Type Badge Column
struct CardTypeBadgeColumn: View {
    let holding: PortfolioHolding

    var body: some View {
        VStack(spacing: 4) {
            // Color bar at left edge
            RoundedRectangle(cornerRadius: 3)
                .fill(barColor)
                .frame(width: 4, height: 42)
        }
    }

    private var barColor: Color {
        if holding.cardStatus == .grading { return .purple }
        if holding.cardStatus == .listed  { return .orange }
        switch holding.sellUrgency {
        case 75...: return .red
        case 50...: return .orange
        case 25...: return .yellow
        default:    return holding.isRaw ? Color(.systemGray3) : .blue
        }
    }
}

// MARK: - Profit Change Label
struct ProfitChangeLabel: View {
    let amount: Double
    let pct: Double
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: amount >= 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.system(size: 9, weight: .bold))
            Text("\(amount >= 0 ? "+" : "")$\(abs(amount), specifier: "%.0f") (\(pct, specifier: "%.1f")%)")
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundColor(amount >= 0 ? .green : .red)
    }
}

// MARK: - Holding Status Chip
struct HoldingStatusChip: View {
    let status: CardStatus
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: status.icon)
                .font(.system(size: 9, weight: .semibold))
            Text(status.rawValue)
                .font(.system(size: 10, weight: .semibold))
        }
        .foregroundColor(status.color)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(status.color.opacity(0.14))
        .clipShape(Capsule())
    }
}

// MARK: - Grade Badge
struct GradeBadge: View {
    let company: String
    let grade: String
    var body: some View {
        HStack(spacing: 3) {
            Text(company.uppercased())
                .font(.system(size: 9, weight: .black))
                .foregroundColor(companyColor)
            Text(grade)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(.white)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(companyColor.opacity(0.18))
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(companyColor.opacity(0.4), lineWidth: 0.5)
                )
        )
    }

    private var companyColor: Color {
        switch company.uppercased() {
        case "PSA": return Color(red: 0.0, green: 0.45, blue: 0.85)
        case "BGS": return Color(red: 0.85, green: 0.2, blue: 0.2)
        case "SGC": return Color(red: 0.95, green: 0.75, blue: 0.0)
        case "CGC": return Color(red: 0.15, green: 0.7, blue: 0.4)
        default:    return Color(.systemGray2)
        }
    }
}

// MARK: - Raw Condition Chip
struct RawConditionChip: View {
    let condition: String?
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "pencil.and.scribble")
                .font(.system(size: 9))
            Text(condition?.isEmpty == false ? condition! : "Raw")
                .font(.system(size: 10, weight: .medium))
        }
        .foregroundColor(Color(.systemGray))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Color(.systemGray5).opacity(0.5))
        .clipShape(Capsule())
    }
}

// MARK: - Trend Pill
struct TrendPill: View {
    let trend: PortfolioTrend
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .bold))
            Text(label)
                .font(.system(size: 10, weight: .semibold))
        }
        .foregroundColor(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
    }

    private var icon: String {
        switch trend {
        case .rising:  return "arrow.up.right"
        case .stable:  return "arrow.right"
        case .falling: return "arrow.down.right"
        }
    }
    private var label: String {
        switch trend {
        case .rising:  return "Rising"
        case .stable:  return "Stable"
        case .falling: return "Falling"
        }
    }
    private var color: Color {
        switch trend {
        case .rising:  return .green
        case .stable:  return Color(.systemGray2)
        case .falling: return .red
        }
    }
}

// MARK: - Meta Chip
struct MetaChip: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.1))
            .clipShape(Capsule())
    }
}

// MARK: - Grid Card variant
struct HoldingGridCard: View {
    let holding: PortfolioHolding
    var dailyIQTrendCount: Int = 0
    var isDailyIQTrending: Bool = false
    var onTap: (() -> Void)? = nil

    var body: some View {
        Button(action: { onTap?() }) {
            VStack(alignment: .leading, spacing: 8) {
                // Header: grade/raw badge
                HStack {
                    if holding.isRaw {
                        RawConditionChip(condition: holding.conditionEstimate)
                    } else {
                        GradeBadge(company: holding.gradingCompany, grade: holding.grade)
                    }
                    Spacer()
                    if isDailyIQTrending {
                        DailyIQTrendBadge(appearances: dailyIQTrendCount)
                    }
                    TrendPill(trend: holding.trend)
                }

                // Player + card
                VStack(alignment: .leading, spacing: 2) {
                    Text(holding.playerName)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    Text(holding.cardTitle)
                        .font(.system(size: 10))
                        .foregroundColor(Color(.systemGray2))
                        .lineLimit(2)
                }

                Divider().background(Color(.systemGray5))

                // Value + P/L
                VStack(alignment: .leading, spacing: 2) {
                    Text("$\(holding.currentValue, specifier: "%.0f")")
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                    ProfitChangeLabel(amount: holding.totalProfitLoss, pct: holding.totalProfitLossPct)
                }

                // Status
                HoldingStatusChip(status: holding.cardStatus)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground).opacity(0.75))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(statusBorderColor.opacity(0.28), lineWidth: 1)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }

    private var statusBorderColor: Color {
        switch holding.cardStatus {
        case .listed:  return .orange
        case .grading: return .purple
        default:       return holding.riskLevel == .high ? .red : .clear
        }
    }
}

struct DailyIQTrendBadge: View {
    let appearances: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "bolt.fill")
                .font(.system(size: 8, weight: .bold))
            Text("DailyIQ x\(appearances)")
                .font(.system(size: 10, weight: .semibold))
        }
        .foregroundColor(.green)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Color.green.opacity(0.12))
        .clipShape(Capsule())
    }
}

struct HoldingRowCard_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 12) {
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[0])
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[1])
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[2])
        }
        .preferredColorScheme(.dark)
        .padding()
        .background(Color.black)
    }
}


                VStack(alignment: .leading, spacing: 5) {
                    // Row 1: Player + value
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(holding.playerName)
                                .font(.headline)
                                .foregroundColor(.white)
                            Text(holding.cardTitle)
                                .font(.caption)
                                .foregroundColor(Color(.systemGray2))
                                .lineLimit(1)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("$\(holding.currentValue, specifier: "%.0f")")
                                .font(.headline)
                                .foregroundColor(.green)
                            Text("P/L \(holding.totalProfitLoss >= 0 ? "+" : "")$\(holding.totalProfitLoss, specifier: "%.0f")")
                                .font(.caption2)
                                .foregroundColor(holding.totalProfitLoss >= 0 ? .green : .red)
                        }
                    }

                    // Row 2: Recommendation + trend + urgency badge
                    HStack(spacing: 6) {
                        StatusPill(text: holding.recommendation, color: .blue)
                        if let trend = trendIcon(for: holding.trend) {
                            Label(trend.label, systemImage: trend.icon)
                                .font(.caption2)
                                .foregroundColor(trend.color)
                        }
                        Spacer()
                        // Urgency badge — compact on the right
                        VStack(spacing: 1) {
                            Text("\(holding.sellUrgency)")
                                .font(.system(size: 13, weight: .bold, design: .rounded))
                                .foregroundColor(holding.sellUrgencyColor)
                            Text(holding.sellUrgencyLabel)
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundColor(holding.sellUrgencyColor.opacity(0.8))
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(holding.sellUrgencyColor.opacity(0.12))
                        .cornerRadius(8)
                    }

                    // Row 3: Metadata chips (only shown when there's data)
                    let hasChips = (holding.expectedDaysToSell != nil && holding.expectedDaysToSell! < 90) || holding.quantity > 1
                    if hasChips {
                        HStack(spacing: 6) {
                            if let days = holding.expectedDaysToSell, days < 90 {
                                Label("~\(days)d to sell", systemImage: "clock")
                                    .font(.caption2.weight(.medium))
                                    .foregroundColor(days <= 7 ? .red : days <= 21 ? .orange : .yellow)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background((days <= 7 ? Color.red : days <= 21 ? Color.orange : Color.yellow).opacity(0.12))
                                    .clipShape(Capsule())
                            }
                            if holding.quantity > 1 {
                                Text("×\(holding.quantity)")
                                    .font(.caption2.weight(.medium))
                                    .foregroundColor(.gray)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color(.systemGray6).opacity(0.25))
                                    .clipShape(Capsule())
                            }
                            Spacer()
                            FreshnessBadge(status: holding.freshnessStatus, lastUpdated: holding.lastUpdated)
                        }
                    }
                }
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(Color(.secondarySystemBackground).opacity(0.7))
            .cornerRadius(14)
            .shadow(color: .black.opacity(0.1), radius: 4, x: 0, y: 2)
        }
        .buttonStyle(PlainButtonStyle())
    }

    func trendIcon(for trend: PortfolioTrend) -> (icon: String, label: String, color: Color)? {
        switch trend {
        case .rising: return ("arrow.up.right", "Rising", .green)
        case .stable: return ("arrow.right", "Stable", .gray)
        case .falling: return ("arrow.down.right", "Falling", .red)
        }
    }
}

struct HoldingRowCard_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 16) {
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[0])
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[1])
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[2])
        }
        .preferredColorScheme(.dark)
        .padding()
        .background(Color.black)
    }
}
