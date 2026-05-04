import SwiftUI

struct AccountButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "person.crop.circle")
                .resizable()
                .frame(width: 28, height: 28)
                .foregroundColor(.gray)
                .accessibilityLabel("Account")
        }
        .buttonStyle(PlainButtonStyle())
        .padding(.trailing, 8)
    }
}

struct AccountButton_Previews: PreviewProvider {
    static var previews: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            AccountButton(action: {})
        }
        .preferredColorScheme(.dark)
    }
}
