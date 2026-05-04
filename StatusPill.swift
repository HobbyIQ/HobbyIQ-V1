import SwiftUI

struct StatusPill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundColor(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(color.opacity(0.18))
            .cornerRadius(8)
    }
}

struct StatusPill_Previews: PreviewProvider {
    static var previews: some View {
        HStack(spacing: 8) {
            StatusPill(text: "Hold", color: .blue)
            StatusPill(text: "Sell Watch", color: .orange)
            StatusPill(text: "Risk", color: .red)
        }
        .preferredColorScheme(.dark)
        .background(Color.black)
    }
}
