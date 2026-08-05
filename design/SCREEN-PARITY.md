# iOS ↔ Web Screen Parity

_Living doc. Every user-facing surface on iOS should have a matching web page (and vice versa) unless there's a documented reason otherwise. Update when you add/remove either side._

<!--
STATE values:
  🟢 parity   — both surfaces present and functionally aligned
  🟡 partial  — both present but feature or copy differs
  🔵 iOS-only — no web equivalent yet
  🟣 web-only — no iOS equivalent yet
  ⚪ auth/shell — infrastructure surface, no user feature per se
-->

## Auth + Onboarding

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| Launch / splash | `LaunchView.swift` | — | 🔵 iOS-only | Web hits marketing on cold-load; no splash needed |
| Login | `LoginView.swift` | `login/page.tsx` | 🟢 parity | |
| Register / signup | `CreateAccountView.swift` | (embedded in `login`) | 🟡 partial | Web needs a dedicated register page or expand the login page |
| Apple / OAuth | `AuthView.swift` | — | 🔵 iOS-only | Apple Sign-In native; web has no OAuth path yet |
| Verify email | (deep-link handler) | `verify-email/page.tsx` | 🟢 parity | Both consume the same verification token |
| Welcome / first-run | (in `HomeDashboardView` gate) | `app/welcome/page.tsx` | 🟢 parity | |
| Paywall / upgrade | `PaywallView.swift` | `(marketing)/pricing/page.tsx` | 🟡 partial | iOS is a modal, web is a marketing page — copy + tiers must match |

## Dashboard

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| App shell / nav | `MainAppView.swift`, `AppRootView.swift` | `app/layout.tsx`, `AppShell.tsx` | ⚪ shell | Tab bar on iOS, sidebar/topbar on web |
| Home dashboard | `HomeDashboardView.swift`, `DashboardView.swift` | `app/page.tsx` | 🟢 parity | |
| Root content router | `ContentView.swift` | (Next router) | ⚪ shell | |

## Cards / Pricing

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| Search | `CardSearchView.swift` | `app/search/page.tsx` | 🟢 parity | Product-family drill-down wired both sides (002b903a) |
| Search variant picker | `CompIQVariantPickerView.swift` | (inline in `card/[id]`) | 🟡 partial | Web handles it inside the detail page |
| Card selection (candidates) | `CompIQCardSelectionView.swift` | `app/search/page.tsx` | 🟢 parity | |
| Card detail (priced) | `CompIQPricedCardView.swift`, `CompIQView.swift` | `app/card/[cardsightId]/page.tsx` | 🟢 parity | |
| Cert resolve | `CertResolveView.swift`, `SlabCertLookupView.swift` | (inline in `card/[id]`) | 🟡 partial | iOS has a dedicated cert-lookup flow; web is inline |
| Card identify (photo scan) | `CardIdentifyView.swift` | — | 🔵 iOS-only | Camera scan — needs a web upload equivalent |
| Product overview (BCCP structure) | `ProductOverviewView.swift` | `app/product/[productKey]/page.tsx` | 🟢 parity | Shipped c3769060 |
| Price history | `PriceHistoryView.swift` | (inline in card detail) | 🟡 partial | Web renders chart inline; iOS is a dedicated screen |

## Portfolio

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| Portfolio list | `PortfolioIQView.swift` | `app/portfolio/page.tsx` | 🟢 parity | |
| Holding detail | (via PortfolioIQ modals) | `app/portfolio/[id]/page.tsx` | 🟡 partial | iOS is a modal, web is a page |
| Add card | `AddPortfolioCardView.swift`, `PortfolioAddFlowView.swift`, `QuickAddCardView.swift` | `app/portfolio/add/page.tsx` | 🟡 partial | iOS has three entry paths — quick, full, flow. Web has one. |
| CSV / bulk import | `HoldingsImportView.swift` | `app/portfolio/import/page.tsx` | 🟢 parity | |
| Sold / P&L | `ProfitListView.swift`, `ProfitIQCardDetailView.swift` | `app/portfolio/sold/page.tsx` | 🟢 parity | |
| Watchlist | `WatchlistView.swift` | `app/watchlist/page.tsx` | 🟢 parity | |

## Market / Insights

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| Market / trends | `MarketTrendView.swift` | `app/market/page.tsx` | 🟢 parity | |
| DailyIQ (daily wrap) | `DailyIQView.swift` | `DailyIQCard.tsx` component | 🟡 partial | Web only has the dashboard card, no dedicated page |
| New releases | `NewReleasesView.swift`, `NewDropsView.swift` | (part of `app/market`) | 🟡 partial | Web rolls into market page |
| Hot right now | `HotRightNowListView.swift` | (part of `app/market`) | 🟡 partial | |
| Cascade alerts | `CascadeAlertsListView.swift` | `app/alerts/page.tsx` | 🟢 parity | |
| ActionIQ / trade targets | `ActionIQView.swift`, `GradeWorthyListView.swift` | `app/trade-targets/page.tsx` | 🟡 partial | Web is one page; iOS splits action + grade-worthy |
| PlayerIQ | `PlayerIQView.swift` | `app/players/page.tsx`, `app/players/[name]/page.tsx` | 🟢 parity | |
| Insights hub | `PerformanceView.swift` | `app/insights/page.tsx` | 🟢 parity | |
| I Called It / history | `ICalledItView.swift`, `YearbookView.swift` | — | 🔵 iOS-only | Public-share receipts of past cascade calls — web could show these on `/u/[username]` |

## Pro Seller

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| Inventory analytics | `InventoryIQView.swift`, `ERPInventoryAnalyticsView.swift` | `app/erp/page.tsx` | 🟢 parity | Web has subpages: `/erp/expenses`, `/purchases`, `/tax`, `/unreconciled` |
| eBay connect | `EbayConnectView.swift` | `app/ebay/page.tsx` | 🟢 parity | |
| eBay listing draft | `EbayListingDraftView.swift`, `EbayListingManageView.swift` | (inline in `app/ebay`) | 🟡 partial | |
| BuyerIQ | `BuyerIQ/BuyerIQView.swift` + list-detail + create + target-edit | `app/buyeriq/page.tsx`, `[listId]/page.tsx` | 🟢 parity | Full CRUD on both sides; web comment even reads "Mirrors iOS BuyerIQView.swift" |
| Storefront (public profile editor) | — | `app/storefront/page.tsx` | 🟣 web-only | Pro Seller share/edit surface — needs iOS build |
| Public storefront page | — | `(marketing)/u/[username]/page.tsx` | 🟣 web-only | Deep-link viewer; iOS could share via Safari |
| Messages | — | `app/messages/page.tsx`, `[otherUserId]/page.tsx` | 🟣 web-only | No iOS chat UI |

## Admin

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| Pending review queue | `PendingReviewQueueView.swift` | `app/admin/verify/page.tsx` | 🟢 parity | |
| Data-quality dashboard | — | `app/admin/data-quality/page.tsx` | 🟣 web-only | Admin surface only — no iOS need |
| Labeler / quarantine / cleanliness / slug-audit | — | `app/admin/{labeler,quarantine,cleanliness,slug-audit}/page.tsx` | 🟣 web-only | Admin only |

## Account / Settings

| Feature | iOS View | Web Page | State | Notes |
| --- | --- | --- | --- | --- |
| Account | `AccountView.swift`, `AccountHeaderView.swift` | `app/settings/page.tsx` | 🟢 parity | |
| More / hub | `MoreView.swift` | (integrated into settings) | 🟡 partial | Web collapses "More" into settings sidebar |
| Integrations | `IntegrationsView.swift` | (part of settings) | 🟡 partial | |

## Marketing site (web-only by design)
| Page | Web | Notes |
| --- | --- | --- |
| Home | `(marketing)/page.tsx` | Public landing |
| About | `(marketing)/about/page.tsx` | |
| Contact | `(marketing)/contact/page.tsx` | |
| Pricing | `(marketing)/pricing/page.tsx` | Aligned with iOS PaywallView tiers |
| Terms | `(marketing)/terms/page.tsx` | |
| Privacy | `(marketing)/privacy/page.tsx` | |
| Public storefront | `(marketing)/u/[username]/page.tsx` | See Pro Seller row |

---

## Rollup

- 🟢 parity: **21 surfaces**
- 🟡 partial (feature/copy drift): **13 surfaces**
- 🔵 iOS-only (needs web build): **5 surfaces**
- 🟣 web-only (needs iOS build): **6 surfaces** (BuyerIQ, Storefront, Messages, 3× admin)
- ⚪ shell / router: 3

## Recommended next work (ranked)

1. **iOS ← BuyerIQ + Storefront** — Pro Seller pillar features exist on web only. Ship iOS parity so the paid tier has full mobile support.
2. **iOS ← Messages** — collaboration surface; blocks in-app negotiation on mobile.
3. **Web ← Card Identify (photo scan)** — camera scan is a killer iOS feature; web version could accept an upload/drag-and-drop.
4. **Reconcile 🟡 partials** — pass-by-pass. Start with `AddCard`, `Register`, `CertResolve`, `EbayListingDraft`, `DailyIQ` since these are user-facing every session.
5. **Web ← I Called It / Yearbook** — public-share receipts. Fold into `/u/[username]` storefront.
