import SwiftUI

struct PortfolioInsightCard: View {
    let title: String
    let subtitle: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
                .foregroundColor(color)
            Text(subtitle)
                .font(.subheadline)
                .foregroundColor(.gray)
        }
        .padding()
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .cornerRadius(14)
        .shadow(color: color.opacity(0.12), radius: 6, x: 0, y: 2)
    }
}

struct PortfolioInsightCard_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 16) {
            PortfolioInsightCard(title: "Blake Burke Orange Wave is up 32%", subtitle: "This card may be near a strong sell window.", color: .green)
            PortfolioInsightCard(title: "After fees, profit is smaller than it looks.", subtitle: "Strong value gain with healthy demand.", color: .blue)
        }
        .preferredColorScheme(.dark)
        .background(Color.black)
    }
}
