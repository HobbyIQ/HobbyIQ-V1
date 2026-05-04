import SwiftUI

struct AccountView: View {
    @Environment(\.dismiss) var dismiss
    @ObservedObject private var auth = AuthManager.shared
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
                        HStack(spacing: 12) {
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .frame(width: 44, height: 44)
                                .foregroundColor(.blue)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 8) {
                                    Text(auth.username)
                                        .font(.headline)
                                    Text(auth.accountRoleLabel)
                                        .font(.caption2)
                                        .fontWeight(.semibold)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(Color.blue.opacity(0.18))
                                        .foregroundColor(.blue)
                                        .clipShape(Capsule())
                                }
                                Text("Subscription: \(auth.planLabel)")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                        }
                        .padding(.vertical, 4)
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
                                    if auth.isAuthenticated { password = "" }
                                }
                            }

                        Button {
                            Task {
                                await auth.signIn(username: username, password: password)
                                if auth.isAuthenticated { password = "" }
                            }
                        } label: {
                            HStack {
                                Spacer()
                                if auth.isLoading {
                                    ProgressView()
                                } else {
                                    Text("Sign In").fontWeight(.semibold)
                                }
                                Spacer()
                            }
                        }
                        .disabled(auth.isLoading ||
                                  username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                  password.isEmpty)

                        Text("Admin login: HobbyIQ / Baseball25")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                if let msg = auth.errorMessage {
                    Section {
                        Text(msg)
                            .foregroundColor(.red)
                            .font(.subheadline)
                    }
                }

                Section(header: Text("About")) {
                    HStack {
                        Text("App Version")
                        Spacer()
                        Text("1.0.0").foregroundColor(.gray)
                    }
                }

                if auth.isAuthenticated {
                    Section {
                        Button("Sign Out", role: .destructive) {
                            Task {
                                await auth.signOut()
                                password = ""
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Account")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                Task {
                    await auth.restoreSessionIfNeeded()
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

#Preview {
    AccountView()
}
