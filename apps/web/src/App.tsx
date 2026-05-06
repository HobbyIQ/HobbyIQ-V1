import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./App.css";

import CompIQ from "./pages/CompIQ";
import DailyIQ from "./pages/DailyIQ";
import IntakePage from "./pages/IntakePage";
import PlayerIQ from "./pages/PlayerIQ";

import AppShell from "./components/AppShell";
import Button from "./components/Button";
import Card from "./components/Card";
import Input from "./components/Input";
import PricingSection from "./components/PricingSection";
import SectionHeader from "./components/SectionHeader";

import {
  clearStoredSessionId,
  fetchSessionUser,
  getStoredSessionId,
  signIn,
  signOut,
  type AuthUser,
} from "./api/client";

type PageKey = "home" | "compiq" | "playeriq" | "dailyiq" | "portfolioiq" | "intake" | "account";
type AuthStatus = "checking" | "signed-out" | "signed-in";

function LoadingScreen() {
  return (
    <div className="auth-layout">
      <Card className="auth-card">
        <SectionHeader>Restoring Session</SectionHeader>
        <p className="auth-copy">Checking your HobbyIQ account session...</p>
      </Card>
    </div>
  );
}

function SignedOutScreen({
  username,
  password,
  setUsername,
  setPassword,
  loading,
  error,
  onSubmit,
}: {
  username: string;
  password: string;
  setUsername: (value: string) => void;
  setPassword: (value: string) => void;
  loading: boolean;
  error: string;
  onSubmit: (event: FormEvent) => Promise<void>;
}) {
  return (
    <div className="auth-layout">
      <Card className="auth-card">
        <SectionHeader>HobbyIQ</SectionHeader>
        <p className="auth-copy">Sign in with your existing mobile account. Web uses the same backend auth and account data.</p>

        <form className="auth-form" onSubmit={onSubmit}>
          <label className="auth-label" htmlFor="username">
            Username
          </label>
          <Input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="HobbyIQ"
            autoComplete="username"
            disabled={loading}
          />

          <label className="auth-label" htmlFor="password">
            Password
          </label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            disabled={loading}
          />

          {error ? <div className="auth-error">{error}</div> : null}

          <Button type="submit" disabled={loading || !username.trim() || !password.trim()}>
            {loading ? "Signing In..." : "Sign In"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function HomePage({ user }: { user: AuthUser }) {
  return (
    <div className="app-page-stack">
      <Card>
        <SectionHeader>Dashboard</SectionHeader>
        <p className="auth-copy">Welcome back, {user.email}. Your web session is connected to the same account and backend as iOS.</p>
      </Card>
      <PricingSection />
    </div>
  );
}

function PortfolioPlaceholder() {
  return (
    <Card style={{ width: "100%", maxWidth: 680 }}>
      <SectionHeader>PortfolioIQ</SectionHeader>
      <p className="auth-copy">PortfolioIQ web layout is active with shared account auth. Portfolio screens can be expanded here while keeping the same backend account scope.</p>
    </Card>
  );
}

function AccountPage({ user, onSignOut }: { user: AuthUser; onSignOut: () => Promise<void> }) {
  const created = useMemo(() => new Date(user.createdAt).toLocaleString(), [user.createdAt]);

  return (
    <Card style={{ width: "100%", maxWidth: 680 }}>
      <SectionHeader>Account</SectionHeader>
      <div className="account-grid">
        <div>
          <span className="account-label">Email / Username</span>
          <div className="account-value">{user.email}</div>
        </div>
        <div>
          <span className="account-label">Plan</span>
          <div className="account-value">{user.plan}</div>
        </div>
        <div>
          <span className="account-label">User ID</span>
          <div className="account-value">{user.userId}</div>
        </div>
        <div>
          <span className="account-label">Created</span>
          <div className="account-value">{created}</div>
        </div>
      </div>
      <div className="account-actions">
        <Button onClick={onSignOut}>Sign Out</Button>
      </div>
    </Card>
  );
}

function App() {
  const [page, setPage] = useState<PageKey>("home");
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<AuthUser | null>(null);

  const [username, setUsername] = useState("HobbyIQ");
  const [password, setPassword] = useState("Baseball25");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    const sessionId = getStoredSessionId();
    if (!sessionId) {
      setAuthStatus("signed-out");
      return;
    }

    fetchSessionUser()
      .then((sessionUser) => {
        setUser(sessionUser);
        setAuthStatus("signed-in");
      })
      .catch(() => {
        clearStoredSessionId();
        setAuthStatus("signed-out");
      });
  }, []);

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      const auth = await signIn(username.trim(), password.trim());
      setUser(auth.user);
      setAuthStatus("signed-in");
      setPage("home");
    } catch (error: any) {
      setAuthError(error?.message || "Unable to sign in");
      setAuthStatus("signed-out");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setUser(null);
    setAuthStatus("signed-out");
    setPage("home");
  }

  if (authStatus === "checking") {
    return <LoadingScreen />;
  }

  if (authStatus === "signed-out" || !user) {
    return (
      <SignedOutScreen
        username={username}
        password={password}
        setUsername={setUsername}
        setPassword={setPassword}
        loading={authLoading}
        error={authError}
        onSubmit={handleSignIn}
      />
    );
  }

  return (
    <AppShell page={page} setPage={(nextPage) => setPage(nextPage as PageKey)} user={user} onSignOut={handleSignOut}>
      {page === "home" && <HomePage user={user} />}
      {page === "compiq" && <CompIQ />}
      {page === "playeriq" && <PlayerIQ />}
      {page === "dailyiq" && <DailyIQ />}
      {page === "portfolioiq" && <PortfolioPlaceholder />}
      {page === "intake" && <IntakePage />}
      {page === "account" && <AccountPage user={user} onSignOut={handleSignOut} />}
    </AppShell>
  );
}

export default App;
