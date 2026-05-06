import React from "react";
import "./AppShell.css";
import type { AuthUser } from "../api/client";

type NavPage = "home" | "compiq" | "playeriq" | "dailyiq" | "portfolioiq" | "intake" | "account";

interface Props {
  page: NavPage;
  setPage: (page: NavPage) => void;
  user: AuthUser;
  onSignOut: () => void | Promise<void>;
  children: React.ReactNode;
}

const NAV: ReadonlyArray<{ key: NavPage; label: string }> = [
  { key: "home", label: "Home" },
  { key: "compiq", label: "CompIQ" },
  { key: "playeriq", label: "PlayerIQ" },
  { key: "dailyiq", label: "DailyIQ" },
  { key: "portfolioiq", label: "PortfolioIQ" },
  { key: "intake", label: "Intake" },
  { key: "account", label: "Account" },
];

const AppShell: React.FC<Props> = ({ page, setPage, user, onSignOut, children }) => {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-top-row">
          <div>
            <div className="app-title">HobbyIQ</div>
            <div className="app-subtitle">Web experience matched to iOS visual theme</div>
          </div>
          <div className="app-userbox">
            <span>{user.email}</span>
            <button className="nav-btn" onClick={onSignOut}>Sign Out</button>
          </div>
        </div>
        <nav className="app-nav">
          {NAV.map(n => (
            <button
              key={n.key}
              type="button"
              className={page === n.key ? "nav-btn nav-btn-active" : "nav-btn"}
              onClick={() => setPage(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
};

export default AppShell;
