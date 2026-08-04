//
//  UnifiedSparkline.swift
//  HobbyIQ
//
//  CF-UNIFIED-PRICING-IOS-REBUILD Session 2 (Drew, 2026-08-04).
//
//  Small stateless sparkline used inside the Grade Curve disclosure
//  and on the hero card. Renders a path over the min-max range of the
//  supplied series, colored per trend direction.
//
//  Self-contained SwiftUI Path — no Charts framework dependency so
//  it works identically on every iOS 17+ device without an import.
//

import SwiftUI

struct UnifiedSparkline: View {
    let points: [Double]
    let color: Color
    let height: CGFloat

    init(points: [Double], color: Color = HobbyIQTheme.Colors.electricBlue, height: CGFloat = 44) {
        self.points = points
        self.color = color
        self.height = height
    }

    var body: some View {
        GeometryReader { geo in
            if points.count >= 2 {
                let path = sparklinePath(in: geo.size)
                ZStack {
                    // Faint fill under the line
                    path
                        .fill(
                            LinearGradient(
                                colors: [color.opacity(0.24), color.opacity(0.02)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                    // Stroke on top
                    path
                        .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                }
            } else {
                Text("Not enough sales")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: height)
    }

    private func sparklinePath(in size: CGSize) -> Path {
        guard let minVal = points.min(), let maxVal = points.max(), maxVal > minVal else {
            // Flat line at midpoint when all values equal
            return Path { p in
                let y = size.height / 2
                p.move(to: CGPoint(x: 0, y: y))
                p.addLine(to: CGPoint(x: size.width, y: y))
            }
        }
        let range = maxVal - minVal
        let stepX = points.count > 1 ? size.width / CGFloat(points.count - 1) : size.width
        var path = Path()
        for (i, value) in points.enumerated() {
            let x = CGFloat(i) * stepX
            let normalized = CGFloat((value - minVal) / range)
            let y = size.height - normalized * size.height
            if i == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        return path
    }
}

#Preview("Up trend") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        VStack(spacing: 20) {
            UnifiedSparkline(
                points: [2100, 2199, 2201, 2199, 2299, 2350, 2400, 2500, 2596, 2700],
                color: HobbyIQTheme.Colors.hobbyGreen
            )
            .padding()

            UnifiedSparkline(
                points: [2700, 2600, 2500, 2400, 2300, 2200, 2100],
                color: HobbyIQTheme.Colors.danger
            )
            .padding()

            UnifiedSparkline(points: [], color: HobbyIQTheme.Colors.mutedText)
                .padding()
        }
    }
}
