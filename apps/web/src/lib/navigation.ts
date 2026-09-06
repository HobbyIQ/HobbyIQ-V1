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

// CF-SIDEBAR-TRIM (Drew, 2026-07-27). Cut from 15 → 10 items after the
// UX audit + Drew's "keep only what is really important" ask. Every
// removed page still exists at its URL and is reachable from cross-
// links on parent surfaces:
//
//   Insights       → linked from DailyIQ (editorial content lives there)
//   Players        → linked from Search results + player names elsewhere
//   Watchlist      → linked from Players page + portfolio row context
//   Trade targets  → linked from DailyIQ
//   Sold history   → linked from Financials page grid + Portfolio
//                    (SoldHistoryLink card added in DailyIQCard when
//                    a user has any sold events)
//
// eBay stays because it's a live-listings surface Pro Sellers hit
// daily. Storefront stays for the same reason — active management +
// per-card picker.
// CF-SIDEBAR-ORDER (Drew, 2026-08-02). Explicit order: Search, Portfolio,
// BuyerIQ, Financials, Storefront — then fill the rest. DailyIQ stays at
// the top since it's the app home surface + brand entry point.
export const APP_NAV: NavItem[] = [
  {
    href: "/app",
    label: "DailyIQ",
    // CF-DAILYIQ-SUN-ICON (Drew, 2026-08-11). Prior down-arrow icon
    // had zero semantic connection to a "daily briefing" product.
    // Sun-with-8-rays reads as "morning brief" — universally understood
    // dawn iconography, matches the DailyIQ = start-of-day product.
    iconPath: "M12 7a5 5 0 100 10 5 5 0 000-10zm0 2a3 3 0 110 6 3 3 0 010-6zm-1-7h2v3h-2V2zm0 17h2v3h-2v-3zM4.22 5.64l1.42-1.42 2.12 2.12-1.41 1.41-2.13-2.11zm12.02 12.02l1.42-1.42 2.12 2.12-1.42 1.42-2.12-2.12zM2 11h3v2H2v-2zm17 0h3v2h-3v-2zM4.22 18.36l2.13-2.11 1.41 1.41-2.12 2.12-1.42-1.42zm12.02-12.02l2.12-2.12 1.42 1.42-2.12 2.12-1.42-1.42z",
  },
  {
    href: "/app/search",
    label: "Search",
    iconPath: "M10 2a8 8 0 016.32 12.9l5.39 5.4-1.42 1.4-5.39-5.39A8 8 0 1110 2zm0 2a6 6 0 100 12 6 6 0 000-12z",
  },
  {
    href: "/app/portfolio",
    label: "Portfolio",
    iconPath: "M3 5h18v14H3V5zm2 2v10h14V7H5zm2 2h4v4H7V9zm6 0h4v2h-4V9zm0 4h4v2h-4v-2z",
    prefixMatch: true,
  },
  {
    href: "/app/buyeriq",
    label: "BuyerIQ",
    iconPath: "M7 4h10l1 3h3v2h-1l-1 12H5L4 9H3V7h3l1-3zm2 2v1h6V6H9zm-2 5v9h10v-9H7z",
    prefixMatch: true,
  },
  {
    // CF-PRO-SELLER-WORKSPACE (Drew, 2026-09-02). Sits directly above
    // Financials: both are seller-business surfaces, and this one is the
    // "what do I do today" read that Financials then explains after the fact.
    // Entitlement-gated server-side on every backing route — a non-Pro-Seller
    // who follows this link gets the upsell page, which is the same treatment
    // Financials has always given them, so the nav does not need to hide it.
    href: "/app/seller",
    label: "Seller",
    iconPath: "M3 13h2v8H3v-8zm4-5h2v13H7V8zm4-6h2v19h-2V2zm4 9h2v10h-2V11zm4-4h2v14h-2V7z",
  },
  {
    href: "/app/erp",
    label: "Financials",
    iconPath: "M3 3h18v4H3V3zm0 6h18v4H3V9zm0 6h18v4H3v-4z",
  },
  {
    href: "/app/storefront",
    label: "Storefront",
    iconPath: "M4 4h16l-1 4H5L4 4zm1 6h14l-1 10H6L5 10zm4 3v5h6v-5H9z",
  },
  {
    href: "/app/market",
    label: "Market",
    iconPath: "M3 3h2v18H3V3zm4 12h2v6H7v-6zm4-4h2v10h-2V11zm4-6h2v16h-2V5zm4 8h2v8h-2v-8z",
  },
  {
    href: "/app/messages",
    label: "Messages",
    iconPath: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z",
    prefixMatch: true,
  },
  {
    href: "/app/alerts",
    label: "Alerts",
    iconPath: "M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 00-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1l-2-2z",
  },
  {
    href: "/app/ebay",
    label: "eBay",
    iconPath: "M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zM12 15l-6-6h4V6h4v3h4l-6 6z",
  },
  // CF-WEB-GUIDE (2026-08-22). "How HobbyIQ works" — the teaching layer.
  // Sits directly above Settings, at the bottom of the nav, because it is a
  // reference people return to rather than a daily surface. It is in the NAV
  // and not buried inside Settings because the thing it teaches — FMV is a
  // projected next sale, not a median — was previously explained ONLY on the
  // public marketing site. Signed-in users had no way to learn it at all.
  {
    href: "/app/guide",
    label: "Guide",
    // Open book.
    iconPath: "M12 6.5C10.5 5.5 8.5 5 6 5H2v13h4c2.5 0 4.5.5 6 1.5 1.5-1 3.5-1.5 6-1.5h4V5h-4c-2.5 0-4.5.5-6 1.5zm-1 10.2c-1.4-.6-3-.9-5-.9H4V7h2c2 0 3.6.3 5 .9v8.8zm9-.9c-2 0-3.6.3-5 .9V7.9c1.4-.6 3-.9 5-.9h2v8.8h-2z",
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
