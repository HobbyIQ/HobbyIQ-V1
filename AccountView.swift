import SwiftUI

struct AccountView: View {
    @Environment(\.dismiss) var dismiss
    @StateObject private var auth = AuthManager.shared
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    private enum Field {
        case username
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
                    }
                } else {
                    Section(header: Text("Sign In")) {
                        TextField("Email or Username", text: $username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .submitLabel(.next)
                            .focused($focusedField, equals: .username)
                            .onSubmit {
                                focusedField = .password
                            }

                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .submitLabel(.go)
                            .focused($focusedField, equals: .password)
                            .onSubmit {
                                Task {
                                    await auth.signIn(username: username, password: password)
                                    if auth.isAuthenticated {
                                        password = ""
                                    }
                                }
                            }

                        Button {
                            Task {
                                await auth.signIn(username: username, password: password)
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
                        .disabled(auth.isLoading || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)

                        Text("Use the admin/testing login HobbyIQ with password Baseball25.")
                            .font(.caption)
                            .foregroundColor(.gray)
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
            .onAppear {
                if username.isEmpty {
                    username = auth.username
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
