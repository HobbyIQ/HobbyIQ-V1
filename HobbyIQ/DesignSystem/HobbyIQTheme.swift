//
//  HobbyIQTheme.swift
//  HobbyIQ
//

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

enum HobbyIQTheme {
    enum Colors {
        static let deepNavy = Color(hex: 0x0B1424)
        static let appBackground = Color(hex: 0x06101D)
        static let cardNavy = Color(hex: 0x101B2D)
        static let slateGray = Color(hex: 0x1A2333)
        static let steelGray = Color(hex: 0x2A3344)
        static let electricBlue = Color(hex: 0x1E90FF)
        static let brightBlue = Color(hex: 0x3DA9FF)
        static let hobbyGreen = Color(hex: 0x7CFF72)
        static let brightGreen = Color(hex: 0xB6FF4D)
        static let successGreen = Color(hex: 0x41E66F)
        static let mutedText = Color(hex: 0xA8B3C7)
        static let pureWhite = Color(hex: 0xFFFFFF)

        static let border = steelGray.opacity(0.88)
        static let softBorder = electricBlue.opacity(0.28)
        static let glow = electricBlue.opacity(0.24)
        static let successGlow = hobbyGreen.opacity(0.24)
        static let shadow = Color.black.opacity(0.35)
    }

    enum Gradients {
        static let background = LinearGradient(
            colors: [Colors.appBackground, Colors.deepNavy, Colors.appBackground],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        static let topGlow = RadialGradient(
            colors: [Colors.electricBlue.opacity(0.34), Colors.electricBlue.opacity(0.08), .clear],
            center: .top,
            startRadius: 24,
            endRadius: 340
        )

        static let centerGlow = RadialGradient(
            colors: [Colors.brightBlue.opacity(0.18), .clear],
            center: .center,
            startRadius: 30,
            endRadius: 260
        )

        static let primaryButton = LinearGradient(
            colors: [Colors.electricBlue, Colors.brightBlue],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        static let dashboardStroke = LinearGradient(
            colors: [Colors.electricBlue.opacity(0.88), Colors.hobbyGreen.opacity(0.72)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    enum Spacing {
        static let xxSmall: CGFloat = 4
        static let xSmall: CGFloat = 8
        static let small: CGFloat = 12
        static let medium: CGFloat = 16
        static let large: CGFloat = 20
        static let xLarge: CGFloat = 24
        static let xxLarge: CGFloat = 32
        static let screenPadding: CGFloat = 16
        static let cardPadding: CGFloat = 18
    }

    enum Radius {
        static let xSmall: CGFloat = 10
        static let small: CGFloat = 14
        static let medium: CGFloat = 18
        static let large: CGFloat = 24
        static let xLarge: CGFloat = 28
        static let pill: CGFloat = 999
    }

    enum Typography {
        static let hero = Font.system(size: 34, weight: .bold, design: .rounded)
        static let title = Font.system(size: 28, weight: .bold, design: .rounded)
        static let sectionTitle = Font.system(size: 22, weight: .bold, design: .rounded)
        static let cardTitle = Font.system(size: 18, weight: .semibold, design: .rounded)
        static let body = Font.system(size: 16, weight: .regular, design: .default)
        static let bodyEmphasis = Font.system(size: 16, weight: .semibold, design: .default)
        static let caption = Font.system(size: 12, weight: .regular, design: .default)
        static let captionEmphasis = Font.system(size: 12, weight: .semibold, design: .default)
        static let statNumber = Font.system(size: 30, weight: .bold, design: .rounded)
        static let statSubtle = Font.system(size: 15, weight: .semibold, design: .rounded)
    }

    @MainActor
    static func applyGlobalAppearance() {
#if canImport(UIKit)
        let tabBarAppearance = UITabBarAppearance()
        tabBarAppearance.configureWithOpaqueBackground()
        tabBarAppearance.backgroundColor = UIColor(hex: 0x06101D)
        tabBarAppearance.shadowColor = UIColor(hex: 0x2A3344)

        tabBarAppearance.stackedLayoutAppearance.normal.iconColor = UIColor(hex: 0xA8B3C7)
        tabBarAppearance.stackedLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0xA8B3C7)
        ]
        tabBarAppearance.stackedLayoutAppearance.selected.iconColor = UIColor(hex: 0x1E90FF)
        tabBarAppearance.stackedLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0x1E90FF)
        ]

        tabBarAppearance.inlineLayoutAppearance.normal.iconColor = UIColor(hex: 0xA8B3C7)
        tabBarAppearance.inlineLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0xA8B3C7)
        ]
        tabBarAppearance.inlineLayoutAppearance.selected.iconColor = UIColor(hex: 0x1E90FF)
        tabBarAppearance.inlineLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0x1E90FF)
        ]

        tabBarAppearance.compactInlineLayoutAppearance.normal.iconColor = UIColor(hex: 0xA8B3C7)
        tabBarAppearance.compactInlineLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0xA8B3C7)
        ]
        tabBarAppearance.compactInlineLayoutAppearance.selected.iconColor = UIColor(hex: 0x1E90FF)
        tabBarAppearance.compactInlineLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0x1E90FF)
        ]

        let tabBar = UITabBar.appearance()
        tabBar.standardAppearance = tabBarAppearance
        tabBar.scrollEdgeAppearance = tabBarAppearance
        tabBar.tintColor = UIColor(hex: 0x1E90FF)
        tabBar.unselectedItemTintColor = UIColor(hex: 0xA8B3C7)

        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithOpaqueBackground()
        navAppearance.backgroundColor = UIColor(hex: 0x06101D)
        navAppearance.shadowColor = UIColor(hex: 0x2A3344).withAlphaComponent(0.6)
        navAppearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        navAppearance.largeTitleTextAttributes = [.foregroundColor: UIColor.white]

        let navigationBar = UINavigationBar.appearance()
        navigationBar.standardAppearance = navAppearance
        navigationBar.scrollEdgeAppearance = navAppearance
        navigationBar.compactAppearance = navAppearance
        navigationBar.tintColor = UIColor(hex: 0x1E90FF)
#endif
    }
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

#if canImport(UIKit)
private extension UIColor {
    convenience init(hex: UInt, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}
#endif

struct HobbyIQBackground: View {
    var body: some View {
        ZStack {
            HobbyIQTheme.Gradients.background
            HobbyIQTheme.Gradients.topGlow
            HobbyIQTheme.Gradients.centerGlow
                .blendMode(.screen)
                .opacity(0.75)
        }
        .ignoresSafeArea()
    }
}

struct HobbyIQLogoHeader: View {
    var showTagline: Bool = true
    var centered: Bool = false
    var maxLogoHeight: CGFloat = 52

    var body: some View {
        VStack(alignment: centered ? .center : .leading, spacing: 8) {
            logoContent

            if showTagline {
                Text("Fast Answers for the Hobby")
                    .font(HobbyIQTheme.Typography.captionEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
    }

    @ViewBuilder
    private var logoContent: some View {
#if canImport(UIKit)
        if UIImage(named: "hobbyiq_logo") != nil {
            Image("hobbyiq_logo")
                .resizable()
                .scaledToFit()
                .frame(maxHeight: maxLogoHeight)
                .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
        } else {
            fallbackLogo
        }
#else
        fallbackLogo
#endif
    }

    private var fallbackLogo: some View {
        HStack(spacing: 10) {
            Image("hobby_icon")
                .resizable()
                .scaledToFit()
                .frame(width: maxLogoHeight * 0.72, height: maxLogoHeight * 0.72)
                .clipShape(Circle())

            Text(verbatim: "Hobby")
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            + Text(verbatim: "IQ")
                .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
        }
        .font(HobbyIQTheme.Typography.title)
        .fontWeight(.bold)
        .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
    }
}

struct HIQPrimaryButton: View {
    let title: String
    var systemImage: String?
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.subheadline.weight(.semibold))
                }
                Text(title)
                    .font(HobbyIQTheme.Typography.bodyEmphasis)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .background(HobbyIQTheme.Gradients.primaryButton)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.brightBlue.opacity(0.45), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.34), radius: 14, x: 0, y: 8)
        }
        .buttonStyle(.plain)
    }
}

struct HIQSecondaryButton: View {
    let title: String
    var systemImage: String?
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.subheadline.weight(.semibold))
                }
                Text(title)
                    .font(HobbyIQTheme.Typography.bodyEmphasis)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.92))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.hobbyGreen, lineWidth: 1.1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct HIQSearchBar: View {
    @Binding var text: String
    var placeholder: String = "Search players, cards, sets…"
    var showsFilterIcon: Bool = false
    var onFilterTap: (() -> Void)? = nil
    var onSubmit: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit?()
                }

            if showsFilterIcon {
                Button {
                    onFilterTap?()
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
}

struct HIQStatCard: View {
    let title: String
    let value: String
    let changeText: String
    let subtitle: String
    let systemImage: String
    var isPositive: Bool = true
    var accent: Color = HobbyIQTheme.Colors.hobbyGreen

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(HobbyIQTheme.Typography.captionEmphasis)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(value)
                        .font(HobbyIQTheme.Typography.statNumber)
                        .foregroundStyle(isPositive ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue)
                    Text(changeText)
                        .font(HobbyIQTheme.Typography.statSubtle)
                        .foregroundStyle(isPositive ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue)
                }

                Spacer()

                Image(systemName: systemImage)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(accent)
                    .frame(width: 30, height: 30)
                    .background(accent.opacity(0.16))
                    .clipShape(Circle())
            }

            Text(subtitle)
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            HobbyIQSparklineView(color: isPositive ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue)
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.12), radius: 14, x: 0, y: 8)
    }
}

struct HIQDashboardCard: View {
    let title: String
    let badges: [String]
    let marketValue: String
    let changeText: String
    let iqScore: String
    var cardImageName: String? = nil
    var subtitle: String? = nil
    var actionTitle: String = "View Full Analysis"
    var action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 14) {
                cardArt

                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title)
                                .font(HobbyIQTheme.Typography.cardTitle)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            if let subtitle, subtitle.isEmpty == false {
                                Text(subtitle)
                                    .font(HobbyIQTheme.Typography.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            }
                        }

                        Spacer()

                        HStack(spacing: 6) {
                            Image(systemName: "star.fill")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                            Text(iqScore)
                                .font(HobbyIQTheme.Typography.captionEmphasis)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(HobbyIQTheme.Colors.steelGray.opacity(0.75))
                        .overlay(
                            Capsule(style: .continuous)
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
                        )
                        .clipShape(Capsule(style: .continuous))
                    }

                    if badges.isEmpty == false {
                        WrapBadgesView(badges: badges)
                    }

                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Market Value")
                                .font(HobbyIQTheme.Typography.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(marketValue)
                                .font(HobbyIQTheme.Typography.statNumber)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }

                        Spacer()

                        VStack(alignment: .trailing, spacing: 4) {
                            Text("7D Change")
                                .font(HobbyIQTheme.Typography.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(changeText)
                                .font(HobbyIQTheme.Typography.bodyEmphasis)
                                .foregroundStyle(changeTextHasPositiveTone ? HobbyIQTheme.Colors.hobbyGreen : HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                }
            }

            HIQSecondaryButton(title: actionTitle, systemImage: "chart.bar.xaxis", action: action)
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.18), radius: 18, x: 0, y: 10)
    }

    private var cardArt: some View {
        ZStack {
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .fill(HobbyIQTheme.Colors.slateGray)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.28), lineWidth: 1)
                )

            if let cardImageName, UIImage(named: cardImageName) != nil {
                Image(cardImageName)
                    .resizable()
                    .scaledToFit()
                    .padding(8)
            } else if UIImage(named: "hobby_icon") != nil {
                Image("hobby_icon")
                    .resizable()
                    .scaledToFit()
                    .padding(12)
                    .opacity(0.9)
            } else {
                Image(systemName: "photo")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
        }
        .frame(width: 104, height: 138)
    }

    private var changeTextHasPositiveTone: Bool {
        let normalized = changeText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.contains("+") || normalized.contains("up") || normalized.contains("gain")
    }
}

struct HobbyIQSparklineView: View {
    var color: Color = HobbyIQTheme.Colors.hobbyGreen
    var values: [CGFloat] = [0.22, 0.36, 0.28, 0.55, 0.48, 0.72, 0.65, 0.88]

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height

            Path { path in
                guard values.count > 1 else { return }

                let step = width / CGFloat(values.count - 1)
                for (index, value) in values.enumerated() {
                    let x = CGFloat(index) * step
                    let y = height - (height * value)
                    if index == 0 {
                        path.move(to: CGPoint(x: x, y: y))
                    } else {
                        path.addLine(to: CGPoint(x: x, y: y))
                    }
                }
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .shadow(color: color.opacity(0.35), radius: 4, x: 0, y: 0)
        }
        .frame(height: 24)
        .overlay(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 999, style: .continuous)
                .fill(color.opacity(0.12))
                .frame(height: 4)
                .offset(y: 6)
        }
    }
}

private struct WrapBadgesView: View {
    let badges: [String]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(badges, id: \.self) { badge in
                Text(badge)
                    .font(HobbyIQTheme.Typography.captionEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
                    )
                    .clipShape(Capsule(style: .continuous))
            }
        }
    }
}

private struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }

        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }

            subview.place(
                at: CGPoint(x: x, y: y),
                proposal: ProposedViewSize(width: size.width, height: size.height)
            )

            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

#Preview("Brand Header") {
    ZStack {
        HobbyIQBackground()
        VStack(spacing: 24) {
            HobbyIQLogoHeader()
            HIQSearchBar(text: .constant(""), showsFilterIcon: true)
            HIQPrimaryButton(title: "Analyze Card", systemImage: "chart.bar.xaxis") {}
            HIQSecondaryButton(title: "View Trends", systemImage: "arrow.triangle.2.circlepath") {}
        }
        .padding()
    }
}

#Preview("Stat Card") {
    ZStack {
        HobbyIQBackground()
        HIQStatCard(
            title: "Market Value",
            value: "$245.00",
            changeText: "+12.5%",
            subtitle: "7D Change",
            systemImage: "dollarsign.circle.fill",
            isPositive: true,
            accent: HobbyIQTheme.Colors.hobbyGreen
        )
        .padding()
    }
}

#Preview("Dashboard Card") {
    ZStack {
        HobbyIQBackground()
        HIQDashboardCard(
            title: "Luka Dončić",
            badges: ["PSA 10", "Rookie Card"],
            marketValue: "$245.00",
            changeText: "+12.5%",
            iqScore: "82",
            cardImageName: nil,
            subtitle: "2020 Prizm #258",
            actionTitle: "View Full Analysis"
        ) {}
        .padding()
    }
}
