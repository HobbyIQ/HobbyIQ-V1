//
//  HobbyIQTheme.swift
//  HobbyIQ
//

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

enum HobbyIQTheme {
    static let heroSubtitle = "Fast answers for the Hobby."

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
        static let mutedText = Color(hex: 0xC4CDD9)
        static let pureWhite = Color(hex: 0xFFFFFF)
        static let warning = Color.orange
        static let danger = Color.red
        static let subtleSurface = Color.white.opacity(0.05)

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
            colors: [Colors.electricBlue, Colors.electricBlue],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        // Muted blue→green: single shared accent for hero/value cards across screens.
        // Tune here to restyle every consumer (PortfolioIQ value hero, Movement pulse, DailyIQ header).
        static let dashboardStroke = LinearGradient(
            colors: [Color(hex: 0x2A6A9E), Color(hex: 0x2C8F66)],
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
        static let caption = Font.system(size: 13, weight: .regular, design: .default)
        static let captionEmphasis = Font.system(size: 13, weight: .semibold, design: .default)
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

        tabBarAppearance.stackedLayoutAppearance.normal.iconColor = UIColor(hex: 0xC4CDD9)
        tabBarAppearance.stackedLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0xC4CDD9)
        ]
        tabBarAppearance.stackedLayoutAppearance.selected.iconColor = UIColor(hex: 0x1E90FF)
        tabBarAppearance.stackedLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0x1E90FF)
        ]

        tabBarAppearance.inlineLayoutAppearance.normal.iconColor = UIColor(hex: 0xC4CDD9)
        tabBarAppearance.inlineLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0xC4CDD9)
        ]
        tabBarAppearance.inlineLayoutAppearance.selected.iconColor = UIColor(hex: 0x1E90FF)
        tabBarAppearance.inlineLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0x1E90FF)
        ]

        tabBarAppearance.compactInlineLayoutAppearance.normal.iconColor = UIColor(hex: 0xC4CDD9)
        tabBarAppearance.compactInlineLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0xC4CDD9)
        ]
        tabBarAppearance.compactInlineLayoutAppearance.selected.iconColor = UIColor(hex: 0x1E90FF)
        tabBarAppearance.compactInlineLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: UIColor(hex: 0x1E90FF)
        ]

        let tabBar = UITabBar.appearance()
        tabBar.standardAppearance = tabBarAppearance
        tabBar.scrollEdgeAppearance = tabBarAppearance
        tabBar.tintColor = UIColor(hex: 0x1E90FF)
        tabBar.unselectedItemTintColor = UIColor(hex: 0xC4CDD9)

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

        // Global backgrounds for common containers
        UITableView.appearance().backgroundColor = UIColor(hex: 0x06101D)
        UITableViewCell.appearance().backgroundColor = UIColor(hex: 0x06101D)
        UICollectionView.appearance().backgroundColor = UIColor(hex: 0x06101D)
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
                Text(HobbyIQTheme.heroSubtitle)
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
            .background(HobbyIQTheme.Colors.electricBlue)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.45), lineWidth: 1.6)
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
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.92))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue, lineWidth: 1.6)
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
    var showsMicIcon: Bool = false
    var isListening: Bool = false
    var onFilterTap: (() -> Void)? = nil
    var onSubmit: (() -> Void)? = nil
    var onMicTap: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.body.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(.body)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit?()
                }

            if showsMicIcon {
                Button {
                    onMicTap?()
                } label: {
                    Image(systemName: isListening ? "mic.fill" : "mic")
                        .font(.body.weight(.bold))
                        .foregroundStyle(isListening ? HobbyIQTheme.Colors.danger : HobbyIQTheme.Colors.electricBlue)
                        .symbolEffect(.pulse, isActive: isListening)
                }
                .buttonStyle(.plain)
            }

            if showsFilterIcon {
                Button {
                    onFilterTap?()
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.body.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 18)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(isListening ? AnyShapeStyle(HobbyIQTheme.Colors.danger.opacity(0.6)) : AnyShapeStyle(HobbyIQTheme.Gradients.dashboardStroke), lineWidth: 3.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .shadow(color: Color.black.opacity(0.3), radius: 10, x: 0, y: 4)
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
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
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
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.6)
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
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
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
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.28), lineWidth: 1.6)
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
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.6)
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

struct HIQAvatarButton: View {
    enum Source {
        case asset(name: String)
        case system(symbol: String)
    }

    var source: Source = .asset(name: "hobby_icon")
    var size: CGFloat = 40
    var showsShadow: Bool = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))

                avatarContent
                    .clipShape(Circle())
            }
            .frame(width: size, height: size)
            .overlay(
                Circle()
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1.6)
            )
            .shadow(color: showsShadow ? HobbyIQTheme.Colors.shadow : .clear, radius: showsShadow ? 6 : 0, x: 0, y: showsShadow ? 3 : 0)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Account")
    }

    @ViewBuilder
    private var avatarContent: some View {
        switch source {
        case .asset(let name):
            #if canImport(UIKit)
            if let _ = UIImage(named: name) {
                Image(name)
                    .resizable()
                    .scaledToFill()
            } else if let _ = UIImage(named: "hobbyiq_logo") {
                Image("hobbyiq_logo")
                    .resizable()
                    .scaledToFill()
                    .padding(6)
            } else {
                defaultSymbol
            }
            #else
            Image(name)
                .resizable()
                .scaledToFill()
            #endif
        case .system(let symbol):
            Image(systemName: symbol)
                .font(.system(size: size * 0.48, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private var defaultSymbol: some View {
        Image(systemName: "person.circle.fill")
            .font(.system(size: size * 0.52, weight: .semibold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

struct HIQPhotoSourcePopup: View {
    @Binding var isPresented: Bool
    var onTakePhoto: () -> Void
    var onPhotoLibrary: () -> Void

    var body: some View {
        ZStack {
            // Dimmed background
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            // Centered card
            VStack(spacing: 16) {
                Text("Add Photo")
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                VStack(spacing: 10) {
                    HIQPrimaryButton(title: "Take a Photo", systemImage: "camera") {
                        isPresented = false
                        onTakePhoto()
                    }
                    HIQSecondaryButton(title: "Photo Library", systemImage: "photo.on.rectangle") {
                        isPresented = false
                        onPhotoLibrary()
                    }
                }

                Button {
                    isPresented = false
                } label: {
                    Text("Cancel")
                        .font(HobbyIQTheme.Typography.bodyEmphasis)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
            .padding(HobbyIQTheme.Spacing.cardPadding)
            .frame(maxWidth: 360)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.22), radius: 20, x: 0, y: 10)
        }
        .accessibilityAddTraits(.isModal)
    }
}

extension View {
    func hiqPhotoSourcePopup(isPresented: Binding<Bool>, onTakePhoto: @escaping () -> Void, onPhotoLibrary: @escaping () -> Void) -> some View {
        ZStack {
            self
            if isPresented.wrappedValue {
                HIQPhotoSourcePopup(isPresented: isPresented, onTakePhoto: onTakePhoto, onPhotoLibrary: onPhotoLibrary)
                    .transition(.opacity.combined(with: .scale))
                    .zIndex(1)
            }
        }
    }
}

// Added Components and Extensions as per instructions

struct HIQScreen<Content: View>: View {
    var alignment: Alignment = .topLeading
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack(alignment: alignment) {
            HobbyIQBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.large) {
                    content()
                }
                .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                .padding(.vertical, HobbyIQTheme.Spacing.large)
            }
        }
        .ignoresSafeArea(edges: .top)
    }
}

struct HIQAppContainer<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                content()
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .hiqAppStyle()
    }
}

extension View {
    /// Apply HobbyIQ look-and-feel across the app. Use at your app root.
    /// Example: RootView().hiqAppStyle()
    func hiqAppStyle() -> some View {
        self
            // Global tint for controls and navigation items
            .tint(HobbyIQTheme.Colors.electricBlue)
            // Default foreground for text when not explicitly styled
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            // Unify background on all screens
            .background(HobbyIQTheme.Colors.appBackground)
            // Preferred color scheme for dark styling
            .preferredColorScheme(.dark)
    }
}

extension View {
    func hiqCardStyle(cornerRadius: CGFloat = HobbyIQTheme.Radius.xLarge, stroke: some ShapeStyle = HobbyIQTheme.Gradients.dashboardStroke, lineWidth: CGFloat = 1.6, shadow: Color = HobbyIQTheme.Colors.electricBlue.opacity(0.18)) -> some View {
        self
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(stroke, lineWidth: lineWidth)
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .shadow(color: shadow, radius: 18, x: 0, y: 10)
    }
}

struct HIQSectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(HobbyIQTheme.Typography.sectionTitle)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.top, HobbyIQTheme.Spacing.large)
    }
}

/// Small inline "?" button that surfaces a short plain-English explanation
/// next to an existing inline label/pill where a full HIQMetricLabel VStack
/// wouldn't fit. Used wherever analyst-jargon terms (Pool Size, Confidence,
/// "rail", etc.) need an explainer without restructuring the host layout.
struct HIQHelpButton: View {
    let title: String
    let message: String

    @State private var showHelp = false

    var body: some View {
        Button {
            showHelp.toggle()
        } label: {
            Image(systemName: "questionmark.circle")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("What does \(title) mean?")
        .popover(isPresented: $showHelp, attachmentAnchor: .point(.center), arrowEdge: .top) {
            Text(message)
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .padding(12)
                .frame(maxWidth: 260)
                .presentationCompactAdaptation(.popover)
        }
    }
}

/// Plain-English metric label + value with an optional "?" popover that explains
/// the metric in user-facing terms. Use anywhere an analyst-leak number or term
/// appears in the UI (Portfolio Composite, MAPE, Pool Size, Deal Score, etc.).
struct HIQMetricLabel: View {
    let title: String
    let value: String
    var help: String? = nil
    var alignment: HorizontalAlignment = .leading
    var valueColor: Color = HobbyIQTheme.Colors.pureWhite
    var valueFont: Font = HobbyIQTheme.Typography.bodyEmphasis

    @State private var showHelp = false

    var body: some View {
        VStack(alignment: alignment, spacing: 4) {
            HStack(spacing: 4) {
                Text(title)
                    .font(HobbyIQTheme.Typography.captionEmphasis)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                if help != nil {
                    Button {
                        showHelp.toggle()
                    } label: {
                        Image(systemName: "questionmark.circle")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("What does \(title) mean?")
                    .popover(isPresented: $showHelp, attachmentAnchor: .point(.center), arrowEdge: .top) {
                        Text(help ?? "")
                            .font(HobbyIQTheme.Typography.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .padding(12)
                            .frame(maxWidth: 260)
                            .presentationCompactAdaptation(.popover)
                    }
                }
            }
            Text(value)
                .font(valueFont)
                .foregroundStyle(valueColor)
        }
    }
}

#Preview("Avatar Button") {
    ZStack {
        HobbyIQBackground()
        HIQAvatarButton(source: .asset(name: "hobby_icon"), size: 48, showsShadow: true) {}
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
#Preview("Photo Source Popup") {
    @Previewable @State var show = true
    return ZStack {
        HobbyIQBackground()
        Color.clear
            .hiqPhotoSourcePopup(isPresented: .constant(true), onTakePhoto: {}, onPhotoLibrary: {})
    }
}

#Preview("HIQScreen + Card Style") {
    HIQScreen {
        HIQSectionHeader(title: "Overview")
        VStack(alignment: .leading, spacing: 8) {
            Text("This is standardized content")
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Cards now share borders, radius, and shadow")
                .font(HobbyIQTheme.Typography.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(HobbyIQTheme.Spacing.cardPadding)
        .hiqCardStyle()
    }
}

