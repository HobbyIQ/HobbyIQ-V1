import SwiftUI

struct AccountView: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var auth = AuthManager.shared
    @StateObject private var ebayStore = EbayAccountStore.shared
    @State private var email = "HobbyIQ"
    @State private var password = "Baseball25"
    @State private var showEbayConnect = false
    @State private var showUsernameSheet = false
    @FocusState private var focusedField: Field?

    private enum Field {
        case email
        case password
    }

    var body: some View {
        NavigationStack {
            List {
                if auth.isAuthenticated {
                    Section(header: Text("Profile")) {
                        HStack {
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .frame(width: 44, height: 44)
                                .foregroundColor(.blue)
                            VStack(alignment: .leading) {
                                HStack(spacing: 8) {
                                    Text(auth.username)
                                        .font(.headline)
                                    if auth.isAdminTestingAccount {
                                        Text(auth.accountRoleLabel)
                                            .font(.caption2)
                                            .fontWeight(.semibold)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(Color.blue.opacity(0.18))
                                            .foregroundColor(.blue)
                                            .clipShape(Capsule())
                                    }
                                }
                                Text("Signed in")
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                                Text("Role: \(auth.accountRoleLabel)")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                                Text("Subscription: \(auth.planLabel)")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                        }

                        if !auth.hasUsername {
                            // Apple Sign-In users land here without a claimed
                            // username. Surface a prompt so they can pick one.
                            Button {
                                showUsernameSheet = true
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "at.badge.plus")
                                        .foregroundColor(.blue)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("Choose a Username")
                                            .font(.subheadline)
                                            .fontWeight(.medium)
                                        Text("Pick a handle that identifies you in HobbyIQ.")
                                            .font(.caption)
                                            .foregroundColor(.gray)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .foregroundColor(.gray)
                                }
                            }
                            .buttonStyle(.plain)
                        } else {
                            Button {
                                showUsernameSheet = true
                            } label: {
                                HStack {
                                    Text("Change Username")
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundColor(.gray)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } else {
                    Section(header: Text("Sign In")) {
                        TextField("Email or Username", text: $email)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .submitLabel(.next)
                            .focused($focusedField, equals: .email)
                            .onSubmit {
                                focusedField = .password
                            }

                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .submitLabel(.go)
                            .focused($focusedField, equals: .password)
                            .onSubmit {
                                Task {
                                    await auth.signIn(email: email, password: password)
                                    if auth.isAuthenticated {
                                        password = ""
                                    }
                                }
                            }

                        Button {
                            Task {
                                await auth.signIn(email: email, password: password)
                                if auth.isAuthenticated {
                                    password = ""
                                }
                            }
                        } label: {
                            HStack {
                                if auth.isLoading {
                                    ProgressView()
                                } else {
                                    Text("Sign In")
                                }
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .disabled(auth.isLoading || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)

                        Button("Quick Access: Sign in as HobbyIQ Test") {
                            email = "HobbyIQ"
                            password = "Baseball25"
                            Task {
                                await auth.signIn(email: "HobbyIQ", password: "Baseball25")
                            }
                        }
                        .font(.caption)
                        .foregroundColor(.blue)
                        .disabled(auth.isLoading)
                    }
                }

                if let errorMessage = auth.errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundColor(.red)
                    }
                }

                Section(header: Text("Preferences")) {
                    Toggle("Flip Mode", isOn: .constant(false))
                    Toggle("Hold Mode", isOn: .constant(true))
                    Toggle("Alerts", isOn: .constant(true))
                    Toggle("Watchlist Notifications", isOn: .constant(false))
                    HStack {
                        Text("Theme")
                        Spacer()
                        Text("Dark")
                            .foregroundColor(.gray)
                    }
                }
                Section(header: Text("Portfolio Settings")) {
                    HStack {
                        Text("Default Fees")
                        Spacer()
                        Text("10%")
                            .foregroundColor(.gray)
                    }
                    HStack {
                        Text("Default Grading")
                        Spacer()
                        Text("PSA")
                            .foregroundColor(.gray)
                    }
                    HStack {
                        Text("Currency")
                        Spacer()
                        Text("USD")
                            .foregroundColor(.gray)
                    }
                }
                Section(header: Text("eBay Account")) {
                    if ebayStore.isConnected {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(.green)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Connected")
                                    .font(.subheadline)
                                    .fontWeight(.medium)
                                if let userId = ebayStore.ebayUserId {
                                    Text(userId)
                                        .font(.caption)
                                        .foregroundColor(.gray)
                                }
                            }
                        }
                        Button("Disconnect eBay") {
                            Task {
                                guard let sid = UserDefaults.standard.string(forKey: "auth.sessionId") else { return }
                                try? await APIService.shared.ebayDisconnect(sessionId: sid)
                                await ebayStore.refresh()
                            }
                        }
                        .foregroundColor(.red)
                    } else {
                        Button {
                            showEbayConnect = true
                        } label: {
                            HStack {
                                Image(systemName: "link.badge.plus")
                                Text("Connect eBay Account")
                            }
                        }
                        if ebayStore.isLoading {
                            ProgressView()
                        }
                        if let err = ebayStore.errorMessage {
                            Text(err).font(.caption).foregroundColor(.red)
                        }
                    }
                }

                Section(header: Text("About")) {
                    HStack {
                        Text("App Version")
                        Spacer()
                        Text("1.0.0")
                            .foregroundColor(.gray)
                    }
                    Text("Privacy Policy")
                        .foregroundColor(.blue)
                    Text("Terms of Service")
                        .foregroundColor(.blue)
                }
                Section {
                    if auth.isAuthenticated {
                        Button("Sign Out") {
                            Task {
                                await auth.signOut()
                                password = ""
                            }
                        }
                        .foregroundColor(.red)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Account")
            .task { await ebayStore.refresh() }
            .sheet(isPresented: $showEbayConnect) {
                EbayConnectView()
            }
            .sheet(isPresented: $showUsernameSheet) {
                ChooseUsernameSheet()
                    .environmentObject(auth)
                    .preferredColorScheme(.dark)
            }
            .onAppear {
                if email.isEmpty {
                    email = auth.username.isEmpty ? "HobbyIQ" : auth.username
                }
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct AccountView_Previews: PreviewProvider {
    static var previews: some View {
        AccountView()
            .preferredColorScheme(.dark)
    }
}

/// Bottom sheet shown from AccountView so a signed-in user (typically an
/// Apple Sign-In user with no claimed handle yet) can pick a username.
/// Calls `AuthManager.setUsername` which POSTs to `/api/auth/username`.
@MainActor
struct ChooseUsernameSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthManager
    @State private var username: String = ""

    private static let usernameRegex = #"^[a-zA-Z0-9_.-]{3,30}$"#

    private var isValid: Bool {
        username.range(of: Self.usernameRegex, options: .regularExpression) != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Choose Your Username")
                } footer: {
                    Text(username.isEmpty
                         ? "3–30 chars · letters, numbers, . _ -"
                         : (isValid ? "Looks good" : "Must be 3–30 chars (letters, numbers, . _ -)"))
                        .foregroundColor(username.isEmpty
                                         ? .gray
                                         : (isValid ? .green : .red))
                }

                if let message = auth.errorMessage, !message.isEmpty {
                    Section {
                        Text(message).foregroundColor(.red)
                    }
                }
            }
            .navigationTitle("Username")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task {
                            let ok = await auth.setUsername(username)
                            if ok { dismiss() }
                        }
                    } label: {
                        if auth.isLoading {
                            ProgressView()
                        } else {
                            Text("Save").bold()
                        }
                    }
                    .disabled(!isValid || auth.isLoading)
                }
            }
            .onAppear {
                username = auth.currentUser?.username ?? ""
                auth.errorMessage = nil
            }
        }
    }
}
