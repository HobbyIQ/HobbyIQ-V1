import SwiftUI

struct ProfitBadge: View {
    let amount: Double
    let percent: Double
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: amount >= 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.caption)
                .foregroundColor(amount >= 0 ? .green : .red)
            Text(String(format: "$%.0f (%.1f%%)", amount, percent))
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(amount >= 0 ? .green : .red)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background((amount >= 0 ? Color.green : Color.red).opacity(0.18))
                .cornerRadius(10)
        }
    }
}

struct ProfitBadge_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 12) {
            ProfitBadge(amount: 710, percent: 40.8)
            ProfitBadge(amount: -120, percent: -8.2)
        }
        .preferredColorScheme(.dark)
        .background(Color.black)
    }
}
