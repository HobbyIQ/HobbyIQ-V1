import SwiftUI

struct PortfolioMetricTile: View {
    let label: String
    let value: Double
    let color: Color
    var body: some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.gray)
            Text(value == floor(value) ? "\(Int(value))" : String(format: "%.1f", value))
                .font(.headline)
                .foregroundColor(color)
        }
        .frame(width: 64)
        .padding(6)
        .background(Color(.systemGray6).opacity(0.18))
        .cornerRadius(10)
    }
}

struct PortfolioMetricTile_Previews: PreviewProvider {
    static var previews: some View {
        HStack {
            PortfolioMetricTile(label: "Cost Basis", value: 1740, color: .gray)
            PortfolioMetricTile(label: "Cards", value: 3, color: .blue)
            PortfolioMetricTile(label: "Avg Gain", value: 236.7, color: .green)
        }
        .preferredColorScheme(.dark)
        .background(Color.black)
    }
}
