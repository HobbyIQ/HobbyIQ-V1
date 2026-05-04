import SwiftUI

enum FreshnessBadgeStyle: String {
    case live, updatedToday, yesterday, needsRefresh
    var color: Color {
        switch self {
        case .live: return .green
        case .updatedToday: return .blue
        case .yesterday: return .yellow
        case .needsRefresh: return .red
        }
    }
}

struct FreshnessBadge: View {
    let status: FreshnessStatus
    let lastUpdated: Date
    var style: FreshnessBadgeStyle {
        switch status {
        case .live: return .live
        case .updatedToday: return .updatedToday
        case .yesterday: return .yesterday
        case .needsRefresh: return .needsRefresh
        }
    }
    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(style.color)
                .frame(width: 8, height: 8)
            Text(style.rawValue.capitalized)
                .font(.caption2)
                .foregroundColor(style.color)
            Text("·")
                .font(.caption2)
                .foregroundColor(.gray)
            Text(lastUpdated, style: .relative)
                .font(.caption2)
                .foregroundColor(.gray)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(.systemGray6).opacity(0.18))
        .cornerRadius(10)
    }
}

struct FreshnessBadge_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 12) {
            FreshnessBadge(status: .live, lastUpdated: Date())
            FreshnessBadge(status: .updatedToday, lastUpdated: Date().addingTimeInterval(-3600))
            FreshnessBadge(status: .yesterday, lastUpdated: Date().addingTimeInterval(-86400))
            FreshnessBadge(status: .needsRefresh, lastUpdated: Date().addingTimeInterval(-172800))
        }
        .preferredColorScheme(.dark)
        .background(Color.black)
    }
}
