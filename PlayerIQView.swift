import SwiftUI

struct PlayerIQView: View {
    @State private var showAccount = false
    var onAccount: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            VStack {
                HStack {
                    Text("PlayerIQ")
                        .font(.title2)
                        .fontWeight(.bold)
                        .foregroundColor(.blue)
                    Spacer()
                    AccountButton {
                        if let onAccount {
                            onAccount()
                        } else {
                            showAccount = true
                        }
                    }
                }
                .padding(.horizontal)
                Spacer()
                Text("Player analysis coming soon...")
                    .foregroundColor(.gray)
                Spacer()
            }
            .background(Color.black.ignoresSafeArea())
            .sheet(isPresented: $showAccount) {
                AccountView()
                    .preferredColorScheme(.dark)
            }
        }
    }
}

struct PlayerIQView_Previews: PreviewProvider {
    static var previews: some View {
        PlayerIQView(onAccount: {})
            .preferredColorScheme(.dark)
    }
}
