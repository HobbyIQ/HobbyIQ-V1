import SwiftUI

struct LoadingSkeletonPortfolioView: View {
    var body: some View {
        VStack(spacing: 24) {
            RoundedRectangle(cornerRadius: 18)
                .fill(Color(.systemGray5).opacity(0.18))
                .frame(height: 110)
                .shimmer()
            HStack(spacing: 18) {
                ForEach(0..<4) { _ in
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(.systemGray5).opacity(0.18))
                        .frame(width: 80, height: 36)
                        .shimmer()
                }
            }
            ForEach(0..<3) { _ in
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color(.systemGray5).opacity(0.18))
                    .frame(height: 72)
                    .shimmer()
            }
            Spacer()
        }
        .padding()
        .background(Color.black.ignoresSafeArea())
    }
}

// Simple shimmer effect
extension View {
    func shimmer() -> some View {
        self
            .redacted(reason: .placeholder)
            .overlay(
                LinearGradient(gradient: Gradient(colors: [Color.clear, Color.white.opacity(0.18), Color.clear]), startPoint: .leading, endPoint: .trailing)
                    .rotationEffect(.degrees(20))
                    .offset(x: 60)
                    .blendMode(.plusLighter)
            )
    }
}

struct LoadingSkeletonPortfolioView_Previews: PreviewProvider {
    static var previews: some View {
        LoadingSkeletonPortfolioView()
            .preferredColorScheme(.dark)
    }
}
