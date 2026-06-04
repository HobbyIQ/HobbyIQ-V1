# iOS UI Audit — HobbyIQ

_Date: 2026-06-04 · Branch: main · Scope: read-only walk of every SwiftUI surface to drive the polish pass. Function-over-polish was the build directive — this audit is honest about where that shows._

---

## How to read this doc

For each screen I capture:
- **File** — the SwiftUI view that owns the surface
- **Renders** — what shows up top-to-bottom and which backend data populates it
- **Layout** — outermost containers and grouping
- **Styling** — which design tokens it uses; default vs custom
- **Roughness** — honest read on density / debug-ish presentation / leaks
- **Polish** — 1-2 lines on what a cleanup pass would touch

Nav order follows the actual app: shell → dashboard → 4 tab destinations → gated surfaces reachable from the dashboard or settings.

---

## Navigation map

**Tab bar (custom `LegacyTabBar` in `MainAppView.swift`)** — 4 visible tabs, pinned bottom, gradient-stroked pill:

```
[ Dashboard ] [ Daily ] [ Inventory ] [ Portfolio ]
```

Other surfaces are reached:
- **Comp / Player** — via Dashboard search and dashboard buttons (`HobbyIQView` quick-cards), or from Daily / Portfolio drill-ins
- **Account / More / Tab customization** — via the avatar button top-right of Dashboard
- **TrendIQ composite, Market Trends, ActionIQ, ERP hub, Batch Reprice, Weekly Brief, Calibration, Card Scan, Watchlist, Performance, Profit list** — via Portfolio tools row + drill-ins
- **eBay Connect, Integrations** — via Account → Integrations
- **eBay Draft / Manage** — via Portfolio card detail / Listing actions
- **Alerts (3 tabs)** — via inbox entry point
- **Paywall** — via membership row in Account, also auto-presented on gated taps

`MainTab` is defined in `CompatibilityShims.swift` (cases: dashboard, daily, comp, player, inventory, portfolio). `TabConfiguration` exists for user-reordering but the live shell uses the hard-coded 4-tab pill.

---

## Design system context (used as a yardstick throughout)

`DesignSystem/HobbyIQTheme.swift` is the source of truth and is well-built:
- **Palette** — `appBackground #06101D`, `cardNavy #101B2D`, `electricBlue #1E90FF`, `hobbyGreen #7CFF72`, `mutedText #C4CDD9`, danger red, warning orange
- **Tokens** — `Spacing` (4-32), `Radius` (10-28 + pill), `Typography` (Hero/Title/SectionTitle/CardTitle/Body/Caption/StatNumber)
- **Primitives** — `HobbyIQBackground` (gradient + radial glow), `HobbyIQLogoHeader`, `HIQPrimaryButton`, `HIQSecondaryButton`, `HIQSearchBar`, `HIQStatCard`, `HIQDashboardCard`, `HobbyIQSparklineView`, `HIQAvatarButton`, `HIQPhotoSourcePopup`, `HIQScreen`, `HIQAppContainer`, modifier `.hiqCardStyle()`

**The visual signature**, repeated 200+ times across the app: `cardNavy` fill → `dashboardStroke` gradient border (blue→green, 2pt) → rounded continuous corner → soft electric-blue glow shadow. Cohesive but heavy when stacked five-deep.

**Token discipline is uneven.** Three layers exist and overlap:
1. `HobbyIQTheme` (current)
2. `Theme` / `Theme.Colors` (legacy alias, `Theme.swift`)
3. `AppColors` (in `CompatibilityShims.swift`, partial alias)

Files like `SharedComponents.swift`, `AccountHeaderView.swift`, `ProfitListView.swift`, `WatchlistView.swift`, `PerformanceView.swift`, and `HobbyIQView.swift` reach into multiple layers in the same file. A token consolidation pass is the single biggest cleanup lever.

---

## Shell / Auth

### `HobbyIQApp.swift` — root
Push delegate, AppState env, `HobbyIQTheme.applyGlobalAppearance()` to brand UITabBar / UINavigationBar / UITableView. SwiftData container for CardItem, CardSaleRecord, SyncIntent. Clean.

### `AppRootView.swift`
Routes between Launch / Auth / Paywall / MainTab from `AppSessionViewModel.launchState`. Handles `onOpenURL` for OAuth deep links. Single-responsibility, clean.

### `LaunchView.swift` — splash
Logo with scale-in (0.85→1.0), tagline ("Fast answers for the Hobby."), three pulsing dots loader, optional auth status caption.
**Polish:** Loading copy could have a touch more hierarchy. Otherwise the most polished surface in the app.

### `AuthView.swift` / `LoginView.swift`
Logo (~306pt) → tagline → `HobbyIQSurfaceCard` containing: status banner (green/red) → Email field → Password field → "Continue with Email" (`HobbyIQBlueButtonStyle`) → "or" divider → Sign in with Apple → "Create account" link. Uses sheets for create account (large detent) and Apple username prompt (medium detent) with drag indicators.
- **Roughness:** A `.offset(y: -115)` hack overlaps the tagline with the logo — fragile.
- **Polish:** Replace offset hack with proper VStack spacing; align tagline inside the card.

### `CreateAccountView.swift`
Logo (240pt) → surface card with: heading, status/error banners, Username, Email, Password, Confirm, Age Range row (4 buttons in an HStack), "Create account" CTA, "Back to sign in".
- **Roughness:** Age tier row breaks on small screens (4 buttons crammed). Confirm-password has no inline "matches" affordance.
- **Polish:** Allow age row to wrap; add checkmark when passwords match.

---

## Dashboard tab — `DashboardView.swift`

This is the most surprising surface. Despite the name, it is **a logo + search field**, not a dashboard.

**Renders top-to-bottom:**
1. `HobbyIQBackground`
2. Logo (~306pt tall, centered)
3. Tagline ("Fast answers for the Hobby.") with the same `-115pt` offset hack
4. `HIQSearchBar` with mic icon, placeholder "Search cards, players, comps…"
5. Top-right account avatar (`ProfileImageStore.image` if present, else `person.crop.circle` on a translucent navy circle)

Submitting routes into unified search results / Comp / Player flows.

**Layout:** ScrollView + VStack; account button as ZStack top-trailing overlay.
**Styling:** Pure HobbyIQTheme.
**Roughness:** No portfolio glance, no DailyIQ peek, no quick actions, no recent searches, no onboarding hint, no empty-state copy. It's a clean search landing page rather than a true dashboard.
**Polish:** Either own the "search-first home" identity (recent searches, trending players, "try: Mahomes 2017 Prizm") or fill it with the actual Dashboard components from `DashboardComponents.swift` (see below — they exist but are unused).

### `HomeDashboardView.swift`
Thin wrapper that injects `AppSessionViewModel` and renders `DashboardView`. No-op for the audit.

### `DashboardComponents.swift` — **unused inventory of dashboard pieces**
~30 reusable cards: `GlassCard` (the base — misnamed; no blur), `SummaryMetricCard`, `SingleHighlightCard`, `TrendingNowCard`, `OpportunityCard` (player/card/market/value/gap with reason), `MarketMoverCard`, `RiskSignalCard` (level-colored dot), `TopSearchedRow`, `PortfolioWatchCard`, `DailyIQPreviewCard`, `HoldingCard`, `MoreRow`, `ScoreBadge`, `SmallInfoPill`, `TagView`, `QuickActionsGrid`, etc. All themed.
**Note:** None of these are wired into the live `DashboardView`. Either rebuild the dashboard from them, or document them as aspirational.

---

## Daily tab — `DailyIQView.swift` (1,111 lines)

**Renders top-to-bottom:**
1. **Hero card** — "DailyIQ" + a compact `DatePicker`, then a redundant calendar-icon row that repeats the same date, plus three small pills for MiLB / MLB / Watchlist counts
2. **Sync banners** — watchlist sync in-progress + sync error (conditional)
3. **Segment control** — 4 underline-style tabs: `Watchlist | MiLB | MLB | Brief`
4. **Per-tab content** (all in the same VStack inside one ScrollView):

   - **Watchlist tab** — search field + Add button, search results, "Top Watched" (taps → PlayerIQ sheet), "Suggested for You", then the user's actual tracked entries. The watchlist state for one player can appear in multiple places on the same scroll (search → suggested → tracked) which is confusing.
   - **MiLB / MLB tabs** — "Daily Brief" header, loading spinner / empty state, then a LazyVStack of `DailyPlayerStatRow` with player + position + team + a perf line (e.g. "2/4 1 HR") + a tiny watch toggle (16pt — small tap target).
   - **Brief tab (gated Investor+)** — Generated-at meta, then RISERS / FALLERS / BREAKOUTS sections with color-coded icons and mover rows.

**Layout:** Single ScrollView → VStack → segmented control → branch by tab. No pagination on stat lists (50 rows render at once).
**Styling:** HobbyIQTheme throughout; monospaced digits on stats. Segment uses electric-blue 20% bg for selected.
**Roughness:**
- Hero card duplicates the date (system DatePicker + calendar row).
- MLB/MiLB rows use bare baseball abbreviations (HR, RBI, ERA, AVG, SS, 3B) with no glossary or popover for casual users.
- Watchlist UX scatters: same entity reachable from 3 sections within one tab.
- Brief tab gated content shows a lock overlay but no value-prop upsell.
- 16pt watch toggle is a small target.

**Polish:** Collapse the date row; add MLB stat glossary popovers; consolidate watchlist sections; enlarge watch toggle; sort/filter controls for MLB/MiLB tables.

---

## Inventory tab — `InventoryIQView.swift` (645 lines)

**Renders top-to-bottom:**
1. **Header card** — "InventoryIQ" + portfolio value badges (total cards, total value, mini stat row: Spent / Profit / Return all in ALL CAPS)
2. **Cap-limit banner** — subscription cap + upgrade CTA (conditional)
3. **Error / warning banner** with retry (conditional)
4. **Snapshot pills row** — 4 buttons: Up (count), Down (count), Outdated (count), Return (avg %). Tapping filters the collection.
5. **Stacked value-breakdown bar** — green/red proportional bar via GeometryReader showing gains-by-value vs losses-by-value, with legend below.
6. **Collection section** — section header w/ blue lines → count + "Add Card" CTA → search field + filter menu + sort menu + rows/grid toggle + reset → empty state OR rows-with-dividers list OR 2-col LazyVGrid.

**Layout:** NavigationView → ZStack background → ScrollView → VStack. Sort/filter/mode-toggle are icon-only.
**Styling:** Clean HobbyIQTheme. No charts beyond the breakdown bar.
**Roughness:** Mini stats ALL CAPS reads slightly shouty. Rows/grid toggle has no label. Value-breakdown legend is meaningful but takes domain knowledge to parse.
**Polish:** Label the mode toggle (or use a tooltip on first use). Add a short legend caption for the breakdown bar ("by current value at risk").

---

## Portfolio tab — `PortfolioIQView.swift` (1,789 lines)

The single densest top-of-tab in the app — many distinct cards stack inside one ScrollView.

**Renders top-to-bottom:**
1. **Hero card** — "PortfolioIQ" title + green "live" dot + Ledger button; portfolio value at 36pt; P&L + % + ROI (color-coded); cost basis + card count.
2. **Movement Pulse card** (conditional, when movement signals are present) — implied % direction, three trend chips (rising/falling/stable counts), portfolio composite as a raw float `1.234`.
3. **Portfolio Health card** — health score 0-100 + score bar + three risk pills (Concentration / Stale Data / Downside) as percentages.
4. **Portfolio Tools** — 2×2 grid of action buttons: Weekly Brief, Calibration, Reprice All, Scan Card, Business/ERP.
5. **Top Movers section** — section header → "TRENDING UP" / "TRENDING DOWN" subheaders → up to 3 rows per direction (player + card + delta + dollar impact). No "see more N of M".
6. **Priority Actions section** — up to 3 rows (Sell-watch / High Risk / Stale Pricing) with icon + title + count badge + chevron.
7. **Performance section** — Month/Year capsule segmented control → net profit + margin % + sold value + fees.

**Layout:** NavigationView → ScrollView → VStack(spacing: 16).
**Styling:** HobbyIQTheme. ALL-CAPS section headers with 1.2 tracking are repeated heavily.
**Roughness:**
- **Portfolio Composite is shown as a raw `1.234` with no legend.** Power-user metric leaked to UI.
- **Risk pills** show percentages with no axis explanation — what does "Concentration: 42%" mean to the user?
- Top movers and priority actions are silently capped at 3 — no "View all".
- Everything renders at once; no collapsible groups for an info-dense surface.

**Polish:** Tooltip / `?` chip on Composite + each risk dimension; "See all" footer rows for movers/actions; consider grouping the surface into collapsible disclosure sections to reduce first-view density.

### Portfolio add flow

- **`PortfolioAddFlowView.swift`** — Two-step `NavigationStack` (verify → details). Header card → Search card (text + "Search & Verify Card" + resolved-variant chip + verified banner) → Condition card (Raw/Graded toggle, grading company scroll, grade wheel picker 1-10 reversed) → loading / error.
- **`AddPortfolioCardView.swift`** — The heavy form: Header → PSA Cert Lookup → Search & Verify (with 3-tile pricing readout: FAIR MARKET / QUICK SALE / SUGGESTED — all caps, assumed knowledge) → Card Photos (front/back tiles with camera/library alert) → Condition (Raw/Graded + autograph toggle + grader + grade text fields) → Purchase (price / current value / location) → "More Details" collapsible (player, title, year, set, parallel, serial, quantity, purchase date toggle, notes) → success/error banners → Save button (disabled silently when invalid).
- **`AddCardFlow.swift`** — Infra only (PSA models, photo picker UIVC representable). No UI.
- **`QuickAddCardView.swift`** — 28-line wrapper around AddPortfolioCardView.

**Roughness:** Save button disabling is silent (no inline validation messages). PSA cert lookup is subtle. Pricing tiles use ALL CAPS jargon.
**Polish:** Inline validation messages; add icons (PSA, BGS, SGC, CGC) to grading-company pills; tooltip "PSA 10 = Gem Mint" on grade wheel.

### Portfolio detail + photo

- **`PortfolioDetailPhotosCard.swift`** — Photos section header → description → two photo tiles (Front/Back) with checkmark when populated → error message → action sheet (Camera/Library/Remove). Smooth AsyncImage with ProgressView. Clean.

### Portfolio advanced — `PortfolioAdvancedViews.swift` (734 lines)

Hosts gated power surfaces. Tone shifts here from "card detail" to "analyst output":
- **`PortfolioHealthCard`** — health score + bar + 3 risk pills (same as in main view). Raw numbers, no axis labels.
- **`CalibrationView`** (gated) — "Pricing Calibration" + Sample Count + Mean Absolute % Error (MAPE displayed as `12.3%` with no human-readable interpretation).
- **`WeeklyBriefView`** (gated) — Headline card → Summary card (Holdings / Alerts / Critical Alerts / Feedback Events / Follow Rate) → Top Winners → Top Losers → Recommendations (text-only with small Follow / Dismiss pill buttons; feedback ephemeral, locally tracked).
- **`BatchRepriceView`** (gated) — Hero text → "Reprice All" button with spinner → error/success → result card. Very minimal.

**Roughness flags** (these are the "data-dump risk" zones called out in the brief, confirmed):
- MAPE, "Feedback Events", "portfolio composite" leak technical analyst vocabulary.
- Recommendations are text-only — no severity color, no icons, no rationale grouping.
- BatchReprice's result card is read-only; no per-card override or "review N changes" step.
- Top winners/losers truncated with no "more" disclosure.

**Polish:** Plain-English labels (or `?` popovers) for MAPE / composite / feedback rate; promote recs into colored severity cards; before/after summary on Batch Reprice.

### Profit list + detail

- **`ProfitListView.swift`** — Header → loading/error/empty → 4 grouped sections (Sell Now / Watch / Hold / CompIQ) → rows: player + card + signal badge + ROI %, with right-side P&L (signed currency) + List Price. Uses `AppCardStyle` (legacy theme set).
- **`ProfitIQCardDetailView.swift`** (504 lines, **trade-detail-style data dump**) — `PortfolioInsightCardView` header → Metrics card with bare label-value rows (Signal / Cost / Min Acceptable Offer / Quick Sale Price / Format / Date Sold as ISO string) → action buttons (Mark Sold + Reprice + optional refresh badge) → Price History section (date + source + value rows, with source as a raw API token like `api_auto_pricing`).

**Roughness:** Dates as ISO strings ("2026-05-19T14:22:00Z"). "Format" field is ambiguous. "Source" leaks API enum strings. Six metric rows with equal weight — no hierarchy.
**Polish:** Relative timestamps, formatted source names, group metrics into "Position" / "Targets" / "Activity" subgroups, add one-line "why this signal" explainer.

### `WatchlistView.swift`
Loading / error / empty → List (insetGrouped, hidden bg) of `WatchlistRow` (name, subtitle, ActionBadgeView, type + alerts pills, ConfidenceMetaRow) → tap into PlayerIQView, swipe to delete. Uses `Theme.Colors.card` (legacy).
**Polish:** Header alerts summary; clarify "Type" with a label or icon.

### `PerformanceView.swift`
Loading / error / empty → Summary card (Portfolio Return %, Benchmark Return %, Recommendation Accuracy % + RefreshMetaView) → Portfolio Curve card with `PositionPerformanceChartView` (path-based 7-point line, 180pt tall, no axis labels, no data point markers, no time scale).
**Polish:** Tap-to-reveal point values; explicit Y-axis min/max labels; explain what the 7 points span.

---

## CompIQ surface (reached from Dashboard / search / Portfolio drill-ins)

### `CompIQView.swift` (791 lines) — **the single roughest data surface in the app**

**Renders top-to-bottom on a successful query:** Hero card → Tools card (Market Trends / Bulk Estimate / Card Database Search) → Search card → Ready card → then **15+ stacked cards in a single ScrollView**:

1. Estimate card (Fair Value + Confidence % + Low/High range pills + summary)
2. Zones card (Buy Zone / Fair / Sell Zone reference)
3. Summary card ("What We Know" + method + explanation)
4. Explanation card (bulleted comping logic)
5. Verdict row (Buy/Hold/Sell + Deal Score)
6. Variant warning row (yellow, if grade/parallel mismatch flagged)
7. Buy Window row (seasonal timing + score)
8. Broader Trend row
9. Exit Strategy row (gated)
10. Freshness row (timestamp + stale warning)
11. Action buttons (Insight LLM + Listing copy)
12. Insight card (if LLM returned)
13. Listing Copy card (generated eBay title + description)
14. **Parsed Card card** — exposes the internal Azure NLP step (playerName, cardName, parallel, grade — backend jargon in UI)

**Layout:** ScrollView → VStack with `.large` spacing. Each section is its own conditional ViewBuilder, so modularity is good but visual density is high when they all fire.
**Styling:** Pure HobbyIQTheme + the standard cardNavy + dashboardStroke stack. Section headers use `title.uppercased()` + 1.2 tracking — repeats often enough to feel shouty.
**Roughness:**
- **`Parsed Card` block leaks NLP internals** to end users.
- Confidence (`87%`) and Deal Score (`75`) have no legend.
- `cached` / `cacheAge` ("Cached 1203s ago") appears in some advanced result cards — dev jargon visible to users.
- No collapsible sections; the user sees the entire pipeline on success.
- No empty-state illustration when no result yet — just blank scroll space.

**Polish:** Group into 3 collapsible disclosures (Estimate / Reasoning / Listing); hide Parsed Card behind a "Debug" disclosure or remove from production; tooltips on Confidence / Deal Score / Buy Window; convert cache age to "Updated 20 min ago".

### `CompIQVariantPickerView.swift`
Search card → after first search, collapsed search field → status (error banner / 4-row shimmer skeletons) → results section: "{count} VARIANTS" header → LazyVStack of rows (40×56 thumbnail + player/year/set/variant + chevron + 1pt steelGray divider).
**Roughness:** No pagination/load-more; long set names truncate without a hint; "Searching…" text missing during load.
**Polish:** "Showing X of Y" header; explicit searching state; tap-to-retry on broken thumbnails.

### `CompIQPricedCardView.swift` (1,926 lines) — **second-roughest surface**
Header card with card label → **Grade picker** (Raw / PSA 9 / PSA 10 / BGS 9.5) as 4 capsule buttons → loading → Price Overlay (fair / market / quick-sale grid) → Grade Lanes card → TrendIQ Layer Breakdown (gated) → "Layer Breakdown" button → **Advanced Tools row of 4 buttons crammed into one HStack**: Grade Premium / Sell Window / Comps by Player / What-If → Metadata card (raw label-value rows: gradeUsed, compsUsed, source, dealScore).
**Roughness:** 4 buttons in a row overflow on small screens; no skeleton when any modal opens; grade switch has a 350ms debounce that feels sluggish; metadata is a database-style label-value dump; multiple gating overlays per surface inside the same screen.
**Polish:** 2×2 advanced-tools grid with labels; skeleton states in all modals; collapse Metadata behind "Details"; unify gating UX.

### `CompIQAdvancedViews.swift` (861 lines) — **5 modals, mostly data dumps**
- **GradePremiumView** — verdict ✓/✗, rawFmv, psa10Fmv, premiumDollars, premiumPct, worthGrading. No explanation of *why*.
- **SellWindowView** — verdict, inWindowNow, activeWindow, nextWindow, allWindows expanded list. Each window: monthRange + raw reason text ("Post-rookie surge expected"). "ALL WINDOWS" in caps.
- **CompsByPlayerView** — comp rows with date + source + price + **`Cached 1203s ago` timestamp leaking**.
- **WhatIfView** — 10+ fields in one VStack (fairMarketValue, marketValue, predictedPrice, quickSaleValue, premium, gradeUsed, compsUsed, dealScore, source, action, explanation bullets). No grouping.
- **`BulkEstimateView`** — text-area paste UI ("Dylan Crews 2025 Bowman Chrome\nFrancisco Lindor 2023 Prizm"), parse buttons, result rows with price ranges. No CSV import/export, no copy-to-clipboard.

**Polish:** Add "why this verdict" line per modal; group What-If into Pricing / Source / Reasoning; format cache age; CSV import/export on Bulk Estimate.

### `HobbyIQCleanSearchView.swift` / `CardSearchView.swift` / `CardIdentifyView.swift`
Unified search variants and card-scan entry point. CardIdentifyView wraps the device camera and image-recognition pipeline (referenced from Portfolio "Scan Card" tile). Card-scan is exposed via Portfolio tools row.
**Polish:** Scan view needs a clear success/edit-before-add step in the flow rather than dumping directly into Add Card form.

---

## PlayerIQ surface — `PlayerIQView.swift` (933 lines)

**Renders top-to-bottom:**
1. (If presented modally) Back button + Watchlist toggle
2. Header — "PlayerIQ" + "Get a live player answer first"
3. Search section
4. Loading / error cards (conditional)
5. Top Players section (when ungated and no result yet) — trending players + scores + direction badges
6. **Bio card** — 72×72 headshot (MLB API AsyncImage) + name + level badge + nickname + 2-column LazyVGrid bio (Position, B/T, Height, Weight, Age, Birth, Debut, Status, HS, College)
7. Draft block (if applicable) — Year, Round, Pick #, Team, School
8. **Stats tables** — `HittingStatsTable` and `PitchingStatsTable` rendering year-by-year + career totals (AVG, HR, RBI, W, ERA, etc.) with caption-weight headers
9. Report section — PlayerIQ Score + Call + Direction badge + performance line
10. **Card Market card** — Market Score, Direction, Avg Trend %, Samples, Top Card, Confidence — flat label-value dump
11. Score History — 100pt line chart (no axis labels, no markers) + last-10 list with direction icons

**Layout:** ScrollView → VStack `.large` spacing.
**Roughness:**
- Bio LazyVGrid is cramped on iPhone-SE width.
- Stats tables are dense; column headers barely distinguishable from data rows.
- No "best season" highlight, no sparkline-per-row, no trend hint.
- Card Market card flattens performance / market / data-quality fields into one table.
- Score chart has no Y axis or tap-to-reveal.

**Polish:** Tabs for Bio / Draft / Stats; emphasize season bests; group Card Market into 3 subsections; add tap markers to the score chart.

---

## TrendIQ composite / Market / Action

### `HobbyIQView.swift` (780 lines) — TrendIQ composite home
"HIQ" badge → Welcome card → search section with mic + clear → **Quick Access Cards** (4 entries: CompIQ / PlayerIQ / PortfolioIQ / DailyIQ) → Featured Brief card ("MLB Daily Brief") → conditional search results section with `HomeCompResultCard` and `HomePlayerResultCard` (both collapsible, "See More" expands LabeledGroups: Price Range / What to do, then Talent Snapshot / Card Market / Risk / Player Score / FinalTake).

**Roughness:**
- **Color namespace pollution** — file mixes `AppColors.accent` with `HobbyIQTheme.Colors.electricBlue` line-by-line.
- HomeCompResultCard shows "Low / Mid / High" as labels with no actual prices visible.
- "See More" expansion has no chevron — silent expand.
- Featured Brief looks static/ad-like with no last-updated timestamp.
- LabeledGroup is a raw "label : value" table — no icons, no sparklines.

**Polish:** Pick one color namespace; surface actual prices; chevrons on collapsibles; freshness on Featured Brief.

### `MarketTrendView.swift` (424 lines)
Hero card → window picker (1d / 7d / 30d capsule segment) → error banner → **Top Movers section** (icon + title + pool size "127 tracked" + window label, then rows: player name + confidence badge + 1d/7d/30d delta pills + 7d volume) → Player Search section → single trend result section (deltas + 3 avg prices + 3 volumes + window label).

**Roughness:**
- "Pool size" and "Confidence" badge are unexplained (confidence is the raw API string: "Very High", "Medium", …).
- Delta pills use caption2 — hard to scan.
- Single-trend result is 7 label-value rows with equal weight.

**Polish:** Replace delta pills with mini sparklines or ↑/↓ icons; tooltip for pool size and confidence; group single-trend results into Deltas / Prices / Volumes.

### `ActionIQView.swift` (276 lines)
Header → Refresh Plan button → status / loading → **Plan Snapshot** card (timestamp + Sell Now / Watch / Hold stat pills) → 3 sections (Sell Now / Watch / Hold) each with rows: player + card + ROI % (color-coded) + Value + List Price + reasoning bullets (first 2, truncated).

**Roughness:** All three sections look visually identical — Sell Now should feel urgent, Hold should feel calm. ROI shown without timeframe context. Reasoning truncated with no "show more". Empty-state copy ("Nothing here right now") doesn't say when the plan refreshes.
**Polish:** Distinct accent color per action tier; show-more on reasoning; "Updates every N hours" hint.

---

## ERP Hub — `ERPViews.swift` (5 tabs) — **flagged as the biggest data-dump zone, confirmed**

Tabs presented as pill segmented control: **Reconciliation / P&L / Expenses / Trades / Tax**.

### Tab 1 — Reconciliation
Auto-reconcile banner → aging buckets section (label / totalGross / count rows + cutoff warning) → Refresh button → unreconciled entries list. Each unreconciled tap opens a manual override sheet with two modes: "Net Payout" (simple) or "Granular Fees" (6 fee fields). Override history shown as a narrow table with field names + old/new values + reason.
**Polish rating: 3/5.** Bare columns; no transaction grouping; override audit trail is dev-flavored. **Polish:** Reconciliation rate by week; group txns by date/player; timeline for override history.

### Tab 2 — P&L / Analytics (sub-picker: P&L / Analytics / Timeseries / Valuation) — **roughest sub-surface**
- **P&L** — Totals card (grossProceeds, totalFees, netProceeds, costBasis, realizedPnL, totalExpenses, netPnL) → grouped rows by month/player/source/category. Values monospaced but unaligned; columns unlabeled.
- **Analytics** — Per-group: Margin / ROI / Sell-Thru / Avg Days / Count in small box row, unlabeled, no benchmarking.
- **Timeseries** — Period / Revenue / Cost / PnL / Count rows. No chart. Dates as `"2024-01"` strings.
- **Valuation** — Totals card → holdings list with player + card + freshness pill + "full position" badge + current value + unrealized PnL.

**Polish rating: 4/5 — JSON-to-UI data dump.** **Polish:** Proper table component with sortable headers + conditional formatting; sparklines for timeseries; YoY filter; search on Valuation.

### Tab 3 — Expenses (sub-picker: List / Report)
List: expense cards (category / description / date / amount). Report: groups by category with totals + entry count. Modal form for add (category dropdown, amount, description, date, conditional "other" notes).
**Polish rating: 2/5.** Form is clean; report is shallow. **Polish:** Tax-category presets, receipt photos, MoM trends.

### Tab 4 — Trades
"Record Trade" button → trade transaction rows (date, out/in count, cash, realized G/L) → tap into structured detail (totals → outgoing items → incoming items → notes). Record form: outgoing (holding ID, FMV, source — source is a hard-coded string), incoming (card title, FMV, source), cash, date. Free-text card title on incoming.
**Polish rating: 2/5.** Form is heavy and assumes you know what "FMV at Trade" means.
**Polish:** Card search picker for incoming items, inline help on FMV source, visual balance diagram in detail view.

### Tab 5 — Tax
Year picker → Filings section (rows per "rail" with computed vs reported 1099-K gross + delta + txn count, tap to edit reported) → Export buttons (Accounting CSV / Tax CSV) with no completion feedback.
**Roughness:** "rail" is unexplained jargon; delta not visually highlighted; export gives no toast/sheet.
**Polish rating: 3/5.** Tooltips on rail/delta, red highlight on discrepancies, export-success toast.

**ERP Hub overall:** Strong feature surface, weakest visual surface in the app. **The P&L / Analytics / Timeseries sub-tabs together are the #1 polish target.**

---

## eBay surfaces

### `EbayConnectView.swift`
Connection status text → Connect button → Reconnect / Sign Out (when connected) → error message. No status dot/badge.
**Polish rating: 2/5.** Add green-dot status badge, success toasts, friendlier button labels.

### `EbayListingDraftView.swift` — **the most polished form in the app**
Card header → listing format picker (Buy It Now / Auction) → Photos (front/back tiles, camera/library alert, checkmark overlays) → fields (title, price, quantity, condition menu, brand, player/year/set/parallel, grade, autograph toggle, description) → Policies picker → Auction schedule (if auction) → Preview section (read-only table of the listing values) → Preview / List on eBay buttons. Wrapped in `.listingCard()` modifier for consistency.
**Polish rating: 2/5.** Solid; missing image crop/rotate, title (80) / description (4000) char counters, real-time eBay availability check.

### `EbayListingManageView.swift`
Card header → status card (status, listing ID, price, quantity, eBay link) with 92pt fixed-width labels → Refresh / Revise / End Listing buttons. End uses confirmation dialog.
**Polish rating: 2/5.** Add price-history chart, Relist, activity log (views/questions/orders).

### `IntegrationsView.swift`
Per provider: section card with status / configured / last-sync pills (relative dates), recent sync runs list, "Run Manual Sync" button.
**Polish rating: 2/5.** Add error-detail modals (why a sync failed), entity-level retry, sync history timeline.

### `EBayOAuthCoordinator.swift`
Pure state-machine logic; no UI.

---

## Alerts — `AlertsViews.swift` (3 tabs)

### Inbox tab (free)
Sticky horizontal-scrolling filter chips (All / Buy / Trim-Sell / Risk / Player / Card) → LazyVStack of alert rows → tap → detail. Empty state with emoji icon + retry.
**Roughness:** Rows are sparse — no inline card name, price move, or signal type visible from the list. No sort, no group-by-date, no "mark all read".
**Polish:** Inline alert summary, sort, date groups (Today / This Week / Older), read state.

### Price Alerts tab (Collector+)
Cap-locked upsell card (when at limit) → "Create" button → list cards (player + card + target price in electric blue + status badge + trash button) → modal create form (player / card / threshold).
**Polish rating: 2/5.** Add edit, bulk delete, current-price-vs-target column, CSV import.

### Advanced Rules tab (Investor+) — **densest sub-surface**
Upsell when capped → list cards: name + active/paused badge + scope (e.g. "player") + scope value + conditions count + combinator (AND/OR) + cooldown minutes + delete button. Conditions inline as tiny pills ("predicted_direction: up", "trendiq_composite gte 1.5"). **No edit, only delete.** Create sheet is a complex builder (scope segmented picker, conditional scope value field, combinator, cooldown, dynamic conditions with menu picker for type + conditional inputs per type).
**Polish rating: 4/5.** **Polish:** Dedicated rule detail view; edit support; surface condition-type plain-language descriptions from the model into the UI; reduce inline pill density.

---

## Paywall — `PaywallView.swift`

Loading state → header (logo + title + subtitle) → tier cards (Free / Collector / Investor / ProSeller) with selection highlight (gradient borders — yellow for ProSeller, green for others when selected; "CURRENT" badge for current tier; checkmark for selected) → Purchase / Restore / Manage / Log Out buttons → minimal legal footer.
**Polish rating: 1/5 — most polished gated surface in the app.** **Polish:** Optional feature-matrix table below the cards; clearer entitlement copy ("10 alerts" vs "unlimited").

---

## Account / More / Tab customization

### `AccountView.swift` — comprehensive settings hub
Presented as a sheet from Dashboard.
Profile card (PhotosPicker avatar + name/email + edit pencil) → Username row (editable) → Membership card (tier title + Restore + Manage capsule buttons) → **Settings section** (header w/ decorative blue lines; toggles for DailyIQ Alerts, Price Alerts, Portfolio Movement Digest; Age Range row of 4 buttons) → **Integrations section** (header + `EbayConnectView`) → **About section** (Version, Build, Contact Support, Send Feedback, Privacy Policy, Terms of Use) → Sign Out (red bg 0.1, danger stroke) → Delete Account (red bg 0.05). Optional success status banner on actions.
**Roughness:** Two of three notification toggles have no description; only "Portfolio Movement Digest" was annotated — the pattern was started, not finished. ALL CAPS section headers ("SETTINGS", "INTEGRATIONS", "ABOUT", "USERNAME") feel overwrought.
**Polish:** Finish toggle descriptions; auto-dismiss success banners; member tier expiration date if available; visual grouping for sections beyond header.

### `AccountHeaderView.swift`
Small badge: name + account suffix + Sign Out pill. **Uses legacy `AppColors` instead of `HobbyIQTheme.Colors` — token-consistency outlier.**
**Polish:** Migrate to HobbyIQTheme.

### `MoreView.swift` — secondary help/info screen
Header card → 5 NavigationLink rows (Settings / Help / Privacy / Terms / About). Each leads to `MoreDetailView` with static text. **`Privacy` and `Terms` contain literal placeholder strings**: "Privacy details will live here when the final policy is ready" / "Terms of service will live here when the final release copy is ready" — pre-launch polish gap visible in production code.
**Polish:** Replace placeholder text; consider routing Settings to AccountView directly.

### `TabCustomizationView.swift`
insetGrouped List → instruction text section → Visible Tabs (with `.onMove` reordering + Hide button) → Hidden Tabs (with Show button) → Reset Default Layout. EditButton in toolbar.
**Polish:** Discoverability hint ("Hold and drag to reorder"); confirmation alert on Reset Default; first instruction section would feel cleaner as a List header.

---

## Shared infrastructure

### `SharedComponents.swift` (338 lines)
`SearchBarView`, `SectionCardView`, `MetricPillView`, `ActionBadgeView` (Buy/Hold/Trim/Sell/Watch color-coded), `ConfidenceMetaRow`, `RefreshMetaView`, `EmptyStateView`, `ErrorStateView`, `LoadingCardView`, `ActivityIndicatorView`, `PortfolioInsightCardView`.
**Roughness:** Mixes legacy `Theme.Colors.textSecondary` with `HobbyIQTheme.Colors.electricBlue` in the same file; `Text(title.uppercased())` baked into the view; raw `"\(confidence)% confidence"` formatting.

### `Theme.swift` (legacy alias layer, 88 lines)
Aliases to HobbyIQTheme + extra `xLarge = 28pt` + duplicate `cardStyle()` modifier that reimplements `hiqCardStyle()`. Consolidation target.

### `CompatibilityShims.swift` (3,204 lines — **too large**)
Contains `AppColors`, `AppSpacing`, `AppCardRadius`, `Theme.Colors` extensions, `HobbyIQTheme` shorthand aliases, `AuthSession`, `MainTab`, `TabConfiguration`, `AccountViewModel`, `AccountHeaderCard`, `SettingsSectionCard`, `SettingsRow`, `ToggleSettingsRow`, `HobbyIQSurfaceCard`, `HobbyIQDisclosureSection`, `HobbyIQSnapshotCard`, `HobbyIQPreviewRow`, `HobbyIQTrendChip`, `PortfolioSummaryTile`, `PortfolioStatBlock`, and many more. Lots of repeated card patterns.
**Polish:** Split into SettingsComponents.swift / AccountComponents.swift / PortfolioComponents.swift / UIShims.swift.

### Loading / error / empty-state patterns
Four different loading conventions exist: shimmer skeletons (CompIQVariantPicker), spinner + label (PlayerIQ), `LoadingCardView` (Performance / Watchlist), bare `ProgressView()` (a few places). Empty states are inconsistently present (some surfaces show nothing).

### Utility infra (non-UI but supports UI)
- `SpeechRecognizer.swift` — `@Observable`; views bind to `.transcript`, `.isRecording`, `.errorMessage`. Used by HIQSearchBar mic affordance.
- `ProfileImageStore.swift` — `@MainActor ObservableObject` singleton; crops to square + disk persists.
- `SwipeBackModifier.swift` — re-enables interactive pop with `.navigationBarBackButtonHidden(true)`.
- `HobbyIQSpellSupport.swift` — autocorrect dictionary; no UI.
- `AppSupport.swift` (867 lines) — `AppState`, `OperationalDataService`, domain models (HomeSnapshot, AlertItem, PortfolioPosition, PerformanceSnapshot).

---

## Cross-cutting findings

### Token-system fragmentation (the biggest cleanup lever)
Three layers active simultaneously: **HobbyIQTheme** (canonical), **Theme/Theme.Colors** (legacy alias), **AppColors** (in CompatibilityShims). Files visibly straddle them:
- `AccountHeaderView.swift` — all `AppColors`
- `SharedComponents.swift` — mixes Theme + HobbyIQTheme in the same view
- `HobbyIQView.swift` — same file references both `AppColors.accent` and `HobbyIQTheme.Colors.electricBlue`
- `ProfitListView.swift`, `WatchlistView.swift`, `PerformanceView.swift` — `Theme.Colors.card`, `AppCardStyle`
- `AuthButtonStyles.swift` — uses `cornerRadius: 14` literal instead of `Radius.small`

### Repeated card pattern
The `cardNavy + dashboardStroke + clipShape + shadow` chain appears 200+ times across files. A single `.hiqCardStyle()` modifier already exists but is not consistently used.

### ALL CAPS section headers everywhere
Pattern `Text(title.uppercased())` + `tracking(1.2)` recurs across CompIQView, PortfolioIQView, DailyIQView, MarketTrendView, AccountView. Visually shouty on already-dense surfaces. Some are pre-uppercased in `Labels.swift` ("TOP MOVERS", "COLLECTION VALUE", "PORTFOLIO INSIGHTS").

### Technical jargon leaking
- **Portfolio Composite** rendered as raw float `1.234` (PortfolioIQView)
- **MAPE** ("Mean Absolute % Error") raw decimal (CalibrationView)
- **Pool Size**, **Confidence** ("Very High" raw API string) (MarketTrendView)
- **Parsed Card** debug block exposing NLP fields (CompIQView)
- **"Cached 1203s ago"** in advanced comp views
- **"rail"** unexplained in ERP Tax
- **API source enums** like `api_auto_pricing` in price history rows
- **ISO timestamps** raw in ProfitIQ detail

### Empty / error / loading inconsistency
- **Empty states:** missing in CompIQView, MarketTrendView, several DailyIQ sub-tabs.
- **Loading:** 4 different conventions in use; pick one (`LoadingCardView` is the strongest).
- **Errors:** raw `APIService.errorMessage()` strings ("Decoding error: expected key 'playerName'") surface in some flows.

### Placeholder copy in production
`MoreView` Privacy / Terms detail strings literally say "will live here when the final policy is ready". Pre-launch polish gap.

### Form validation
Save buttons silently disable rather than surfacing inline reasons (AddPortfolioCardView, PortfolioAddFlowView, AdvancedRules create sheet).

### Truncation without affordance
- PortfolioIQ top movers / priority actions capped at 3 with no "see more"
- ActionIQ reasoning truncated at 2 bullets with no expand
- WeeklyBrief recommendations capped without count
- DailyIQ MLB/MiLB lists render 50 rows without pagination

### Layout fragility
- `LoginView` + `DashboardView` both apply `.offset(y: -115)` to overlap tagline with logo
- Age Range row crams 4 buttons in HStack — breaks on small screens
- CompIQPricedCardView's 4-button advanced-tools row overflows on small screens

### Code hygiene
- All `print()` calls (~42, mostly in APIService + PushNotificationManager) are properly gated `#if DEBUG`. ✅
- Two `// TODO: post-diagnosis decision — raw percentage for now` in `CompIQPricedCardView.swift` lines 652 and 1661.
- No live `FIXME` / `HACK` markers.

### Unused but available
`DashboardComponents.swift` exposes 30+ rich card components (`OpportunityCard`, `TrendingNowCard`, `RiskSignalCard`, `HoldingCard`, `MarketMoverCard`, `TopSearchedRow`, etc.) that are **not wired into the live DashboardView**. Either harvest them to fill the empty dashboard or document them as future.

---

## Roughest screens (priority list for the polish pass)

Ordered worst-first:

1. **ERP P&L / Analytics / Timeseries sub-tabs (`ERPViews.swift`)** — raw monospaced floats in unlabeled columns, no charts, no drill-down. Biggest visible data dump.
2. **CompIQView result section (`CompIQView.swift`)** — 15+ stacked cards on success including `Parsed Card` NLP-internals leak. Needs collapsible disclosure groups.
3. **MarketTrendView (`MarketTrendView.swift`)** — tiny delta pills, unexplained "Pool Size" and "Confidence", verbose 7-row single-trend result.
4. **TrendIQ full / HobbyIQView (`HobbyIQView.swift`)** — color-namespace mixing in one file; hidden prices in Comp result card; silent collapsibles; static-looking Featured Brief.
5. **CompIQPricedCardView advanced tools + modals (`CompIQPricedCardView.swift` + `CompIQAdvancedViews.swift`)** — overflowing 4-button row, "Cached 1203s ago" leak, What-If 10-field VStack with no grouping, raw metadata table.
6. **ProfitIQCardDetailView (`ProfitIQCardDetailView.swift`)** — trade-detail equivalent: ISO timestamps, API-enum sources, flat metric rows.
7. **PortfolioAdvancedViews (`PortfolioAdvancedViews.swift`)** — MAPE / Composite / Risk pills shown as raw numbers; text-only recommendations; BatchReprice "review N changes" step missing.
8. **AdvancedRules tab in Alerts (`AlertsViews.swift`)** — dense inline pills, no edit support, opaque condition vocabulary.
9. **PortfolioIQView (`PortfolioIQView.swift`)** — too much on one scroll, "Portfolio Composite 1.234" leak, silent caps on Top Movers / Priority Actions.
10. **DailyIQ MLB/MiLB lists (`DailyIQView.swift`)** — 50-row dense abbreviation tables with no pagination or stat glossary.
11. **Dashboard (`DashboardView.swift`)** — extreme minimalism; logo+search only on the screen labeled "dashboard" while `DashboardComponents.swift` sits unused.

---

## What a cleanup pass should touch first

Top leverage moves (in dependency order):

1. **Token unification** — collapse `AppColors` and legacy `Theme` into `HobbyIQTheme`; replace `.cardStyle()` and ad-hoc card chains with a single `.hiqCardStyle()`. Single biggest polish win because it propagates.
2. **Section-header detox** — stop calling `.uppercased()` in views; use mixed-case section headers with the existing `HIQSectionHeader` typography. Removes the "shouty" feel on dense surfaces.
3. **Plain-English layer for analyst metrics** — single `HIQMetricLabel(title:, value:, help:)` component that takes a `?` popover. Apply to Portfolio Composite, MAPE, Pool Size, Confidence, Deal Score, Buy Window, "rail", "Feedback Events".
4. **Hide debug artifacts** — Parsed Card block, `Cached Xs ago`, raw API source enums, ISO timestamps. Either format or move behind a Debug disclosure.
5. **Consistent loading/empty/error** — keep `LoadingCardView` / `EmptyStateView` / `ErrorStateView` as the only three, and audit each surface for all three states.
6. **Collapsible disclosures on data-heavy surfaces** — CompIQView result, PortfolioIQView, ERP P&L, What-If. Group into 3-4 sections each.
7. **Real tables for ERP** — extract a `HIQTable` with sortable, labeled, aligned columns and conditional cell formatting. The whole ERP hub benefits.
8. **Fill the Dashboard** — wire `OpportunityCard` / `TrendingNowCard` / `DailyIQPreviewCard` / `HoldingCard` / `RiskSignalCard` into the live `DashboardView`. The components exist.
9. **Form validation surfacing** — inline message under fields instead of silent disable on AddPortfolioCardView, PortfolioAddFlowView, AdvancedRules create.
10. **Polish-debt closeout** — placeholder Privacy/Terms strings; offset `-115pt` taglines; small-screen breakage on Age Range row and CompIQ advanced tools row; auto-dismiss success banners; chevrons on every collapsible.

---

## TL;DR

- **Design system is solid.** Three-layer token fragmentation is the biggest mechanical debt.
- **Cards are over-stacked.** Every dense surface needs collapsible disclosures, not new components.
- **Analyst vocabulary leaks** (Composite 1.234, MAPE 12.3%, Pool Size, "rail", Cached 1203s, Parsed Card). One `HIQMetricLabel` component fixes 80% of it.
- **Dashboard is empty** while a full set of dashboard cards sits unused. Either build it or own the search-first identity.
- **ERP P&L is the worst data dump.** Table component + sparklines + filters change the feel of the whole hub.
- **Most-polished surfaces:** LaunchView, PaywallView, EbayListingDraftView, AccountView, PortfolioAddFlowView. Use these as the visual bar for the rest.
