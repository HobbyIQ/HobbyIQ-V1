import SwiftUI

struct PortfolioQuickActionsRow: View {
    var onAdd: () -> Void
    var onRefresh: () -> Void
    var onSort: () -> Void
    var onFilter: () -> Void
    var isRefreshing: Bool
    var body: some View {
        HStack(spacing: 18) {
            Button(action: onAdd) {
                Label("Add Card", systemImage: "plus.circle.fill")
            }
            .buttonStyle(QuickActionButtonStyle())
            Button(action: onRefresh) {
                if isRefreshing {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .blue))
                        .frame(width: 24, height: 24)
                } else {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
            .buttonStyle(QuickActionButtonStyle())
            Button(action: onSort) {
                Label("Sort", systemImage: "arrow.up.arrow.down")
            }
            .buttonStyle(QuickActionButtonStyle())
            Button(action: onFilter) {
                Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
            }
            .buttonStyle(QuickActionButtonStyle())
        }
        .padding(.vertical, 4)
    }
}

struct QuickActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline)
            .foregroundColor(.blue)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.systemGray6).opacity(configuration.isPressed ? 0.28 : 0.18))
            .cornerRadius(12)
    }
}

struct PortfolioQuickActionsRow_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioQuickActionsRow(
            onAdd: {},
            onRefresh: {},
            onSort: {},
            onFilter: {},
            isRefreshing: false
        )
        .preferredColorScheme(.dark)
        .background(Color.black)
    }
}
