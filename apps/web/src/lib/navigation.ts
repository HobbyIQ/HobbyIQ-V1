// Central catalog of authenticated /app routes for the sidebar.
// Add new dashboard surfaces here — the nav shell renders from this list.

export interface NavItem {
  href: string;
  label: string;
  // Inline SVG path (24×24 viewBox) — keeps the bundle self-contained,
  // no icon library dependency.
  iconPath: string;
  // If true, activeMatch treats /app/portfolio and /app/portfolio/anything
  // as active. Otherwise exact match only.
  prefixMatch?: boolean;
}

export const APP_NAV: NavItem[] = [
  {
    href: "/app",
    label: "DailyIQ",
    iconPath: "M4 12l1.4-1.4L11 16.2V4h2v12.2l5.6-5.6L20 12l-8 8-8-8z",
  },
  {
    href: "/app/portfolio",
    label: "Portfolio",
    iconPath: "M3 5h18v14H3V5zm2 2v10h14V7H5zm2 2h4v4H7V9zm6 0h4v2h-4V9zm0 4h4v2h-4v-2z",
    prefixMatch: true,
  },
  {
    href: "/app/search",
    label: "Search",
    iconPath: "M10 2a8 8 0 016.32 12.9l5.39 5.4-1.42 1.4-5.39-5.39A8 8 0 1110 2zm0 2a6 6 0 100 12 6 6 0 000-12z",
  },
  {
    href: "/app/market",
    label: "Market",
    iconPath: "M3 3h2v18H3V3zm4 12h2v6H7v-6zm4-4h2v10h-2V11zm4-6h2v16h-2V5zm4 8h2v8h-2v-8z",
  },
  {
    href: "/app/insights",
    label: "Insights",
    iconPath: "M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z",
  },
  {
    href: "/app/players",
    label: "Players",
    iconPath: "M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6z",
    prefixMatch: true,
  },
  {
    href: "/app/alerts",
    label: "Alerts",
    iconPath: "M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 00-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1l-2-2z",
  },
  {
    href: "/app/messages",
    label: "Messages",
    iconPath: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z",
    prefixMatch: true,
  },
  // Watchlist removed from sidebar 2026-07-27 per Drew — surface is still
  // live at /app/watchlist for anyone with a saved link but no longer
  // occupies a nav slot.
  {
    href: "/app/trade-targets",
    label: "Trade targets",
    iconPath: "M3 12l4-4v3h9V8l4 4-4 4v-3H7v3l-4-4z",
  },
  {
    href: "/app/erp",
    label: "Financials",
    iconPath: "M3 3h18v4H3V3zm0 6h18v4H3V9zm0 6h18v4H3v-4z",
  },
  {
    href: "/app/ebay",
    label: "eBay",
    iconPath: "M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zM12 15l-6-6h4V6h4v3h4l-6 6z",
  },
  {
    href: "/app/settings",
    label: "Settings",
    iconPath: "M19.4 15a1.7 1.7 0 00.4 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.4 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.4-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.4-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.4H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.4l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.4 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1zM12 15a3 3 0 100-6 3 3 0 000 6z",
  },
];

// Which nav item is active for a given URL path.
export function activeNavItem(pathname: string): NavItem | undefined {
  // Prefer exact match first, fall back to prefix-match items
  const exact = APP_NAV.find((n) => n.href === pathname);
  if (exact) return exact;
  return APP_NAV.filter((n) => n.prefixMatch).find((n) =>
    pathname.startsWith(n.href + "/"),
  );
}
