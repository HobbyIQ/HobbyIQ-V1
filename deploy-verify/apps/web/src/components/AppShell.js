"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./AppShell.css");
const NAV = [
    { key: "home", label: "Home" },
    { key: "compiq", label: "CompIQ" },
    { key: "playeriq", label: "PlayerIQ" },
    { key: "portfolioiq", label: "PortfolioIQ" },
    { key: "dailyiq", label: "DailyIQ" },
    { key: "intake", label: "Intake" },
    { key: "settings", label: "Settings" },
];
const AppShell = ({ page, setPage, children }) => {
    return (<div className="app-shell">
      <header className="app-header">
        <div className="app-title">HobbyIQ</div>
        <nav className="app-nav">
          {NAV.map(n => (<button key={n.key} className={page === n.key ? "nav-btn nav-btn-active" : "nav-btn"} onClick={() => setPage(n.key)}>
              {n.label}
            </button>))}
        </nav>
      </header>
      <main className="app-main">{children}</main>
    </div>);
};
exports.default = AppShell;
