import SwiftUI

struct EmptyPortfolioView: View {
    var onAdd: () -> Void
    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "rectangle.stack.person.crop")
                .resizable()
                .scaledToFit()
                .frame(width: 72, height: 72)
                .foregroundColor(.blue)
            Text("Start building your PortfolioIQ")
                .font(.title2)
                .fontWeight(.bold)
                .foregroundColor(.white)
            Text("Add your cards to track value, profit, and sell opportunities.")
                .font(.subheadline)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button(action: onAdd) {
                Text("Add Your First Card")
                    .font(.headline)
                    .foregroundColor(.white)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(Color.blue)
                    .cornerRadius(14)
            }
            Spacer()
        }
        .background(Color.black.ignoresSafeArea())
    }
}

struct EmptyPortfolioView_Previews: PreviewProvider {
    static var previews: some View {
        EmptyPortfolioView(onAdd: {})
            .preferredColorScheme(.dark)
    }
}
