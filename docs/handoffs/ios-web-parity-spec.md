# iOS ↔ Web Visual Parity — Full Spec (self-contained handoff)

**Owner:** Drew Vabulas
**Deadline:** iOS parity build submitted to TestFlight by **Aug 24, 2026**, App Store by **Aug 25**, live **Sept 14**.
**Prepared:** 2026-08-08 (Claude session 44ed1a3b)
**Repo root:** `c:\Users\dvabu\OneDrive - Just the Boys and Cards LLC\Desktop\HobbyIQ-V1\`

---

## 1. Goal (one sentence)

Bring the iOS app's visual treatment into 1:1 parity with the current `apps/web` marketing + app pages so that a user switching between iPhone and desktop sees the same brand, the same layouts, the same components, the same colors — down to gradient stops, radius values, and micro-motion.

**Why now:** Web app has been polished during the 2026-08 pre-launch sprint and is now the canonical visual identity. iOS predates this polish and diverges in several places. Launch is Sept 14 — parity has to land in the App Store build.

---

## 2. Design system source of truth

**One file drives everything: `design/tokens.json`.**

- Web consumes via `node design/gen-tokens.mjs` → `apps/web/src/app/tokens.generated.css` (CSS custom properties, `--hiq-*`)
- iOS consumes via the same generator → `HobbyIQ/DesignSystem/HobbyIQTokens.generated.swift` (Swift static structs)

**Rule:** Any color/spacing/radius edit MUST go through `design/tokens.json`. Never hand-edit either generated file. The `hobbyiq-design-system` memory (in `~/.claude/projects/.../memory/reference_hobbyiq_design_system.md`) reflects an older snapshot — always verify against `tokens.generated.css`.

### Current token values (as of 2026-08-08)

```
COLORS
  --hiq-app-background   #06101D    (root bg)
  --hiq-deep-navy        #0B1424    (mid-gradient stop)
  --hiq-card-navy        #101B2D    (card surface)
  --hiq-slate-gray       #1A2333    (elevated surface, hover)
  --hiq-steel-gray       #2A3344    (borders)
  --hiq-electric-blue    #1E90FF    (primary accent, CTA)
  --hiq-bright-blue      #3DA9FF    (hover/secondary accent)
  --hiq-hobby-green      #7CFF72    (positive signal, upside)
  --hiq-bright-green     #B6FF4D    (chart peaks)
  --hiq-success-green    #41E66F    (success state)
  --hiq-muted-text       #C4CDD9    (body text)
  --hiq-pure-white       #FFFFFF    (headlines)
  --hiq-warning          #FFA500    (caution)
  --hiq-danger           #FF3B30    (destructive)

ALPHA-DERIVED
  --hiq-subtle-surface   rgba(255,255,255,0.05)
  --hiq-border           rgba(42,51,68,0.88)
  --hiq-soft-border      rgba(30,144,255,0.28)
  --hiq-glow             rgba(30,144,255,0.24)
  --hiq-success-glow     rgba(124,255,114,0.24)
  --hiq-shadow           rgba(0,0,0,0.35)

GRADIENTS
  --hiq-gradient-brand   linear-gradient(135deg, #2A6A9E 0%, #2C8F66 100%)
                         (signature blue→green — hero strokes, CTA emphasis)

SPACING (px)
  xxs 4  ·  xs 8  ·  sm 12  ·  md 16  ·  lg 20  ·  xl 24  ·  xxl 32
  screen-pad 16  ·  card-pad 18

RADIUS (px)
  xs 10  ·  sm 14  ·  md 18  ·  lg 24  ·  xl 28  ·  pill 999

TYPOGRAPHY (SF Pro Rounded for display, system for body)
  hero            700 34/1.15 rounded
  title           700 28/1.20 rounded
  section-title   700 22/1.25 rounded
  card-title      600 18/1.30 rounded
  body            400 16/1.40 body
  body-emph       600 16/1.40 body
  caption         400 13/1.35 body
  caption-emph    600 13/1.35 body
  stat-number     700 30/1.10 rounded
  stat-subtle     600 15/1.30 rounded

MOTION
  press-scale     0.985 → 1.0
  press-fade      0.96 → 1.0
  duration        120ms (--duration-press), 160ms ease-in-out for transitions
```

### The body-background layered gradient

`apps/web/src/app/globals.css` line 76-80. iOS should replicate — it's the reason the app "glows" instead of feeling flat:

```
radial(50% 50% blue 18% alpha → transparent at 60%)  +
radial(50% 0%  blue 34% alpha → 8% at 20% → transparent 55%)  +
linear(135°, #06101D 0% → #0B1424 50% → #06101D 100%)
```

On iOS this is 3 stacked `LinearGradient`/`RadialGradient` layers in a `ZStack` behind every root view.

---

## 3. Screen mapping — iOS view → web equivalent

Every iOS view that has a web counterpart should visually mirror it. If they diverge, **web wins** — update iOS to match.

### App-shell / navigation

| iOS view | Web equivalent | Notes |
|---|---|---|
| `AppRootView.swift` | `apps/web/src/app/app/layout.tsx` | Root shell, tab bar / sidebar wrapper. iOS uses bottom tab; web uses top nav — different form factors, same brand treatment (hero gradient bar). |
| `MainAppView.swift` | `apps/web/src/app/app/page.tsx` | Home dashboard |
| `AccountHeaderView.swift` | avatar/menu in web top nav | Dropdown with tier badge, sign-out |
| `MoreView.swift` | `apps/web/src/app/app/settings/page.tsx` | Settings surface |

### Core surfaces

| iOS view | Web equivalent | Priority |
|---|---|---|
| `DashboardView.swift` / `HomeDashboardView.swift` | `apps/web/src/app/app/page.tsx` | P0 — first-run view |
| `DailyIQView.swift` | `apps/web/src/app/app/daily/page.tsx` | P0 — daily update ritual |
| `CompIQView.swift` / `CompIQCardSelectionView.swift` / `CompIQPricedCardView.swift` | `apps/web/src/app/app/search/page.tsx` + `apps/web/src/app/app/card/[cardsightId]/page.tsx` | P0 — pricing lookup, the app's core loop |
| `PortfolioIQView.swift` (search "PortfolioIQ" in Swift) | `apps/web/src/app/app/portfolio/page.tsx` | P0 — portfolio home |
| `HoldingsImportView.swift` | `apps/web/src/app/app/portfolio/import/page.tsx` | P0 — CSV / eBay import |
| `AddPortfolioCardView.swift` / `AddCardFlow.swift` | `apps/web/src/app/app/portfolio/add/page.tsx` | P1 — manual add |
| `HoldingRowView.swift` | portfolio table row in web | P0 |

### Market + insight surfaces

| iOS view | Web equivalent | Priority |
|---|---|---|
| `MarketTrendView.swift` | `apps/web/src/app/app/market/page.tsx` | P1 |
| `HotRightNowListView.swift` | `apps/web/src/app/app/market/page.tsx` (hot-right-now section) | P1 |
| `ActionIQView.swift` | `apps/web/src/app/app/insights/page.tsx` | P1 |
| `GradeWorthyListView.swift` | inside insights page | P1 |
| `ICalledItView.swift` | inside insights page | P2 |

### Alerts + notifications

| iOS view | Web equivalent | Priority |
|---|---|---|
| `AlertsViews.swift` (`AlertsCenterView`, `AlertRowView`) | `apps/web/src/app/app/alerts/page.tsx` | P1 |
| `CascadeAlertsListView.swift` | inside alerts page | P1 |
| `MessagesView.swift` | `apps/web/src/app/app/messages/page.tsx` + `[otherUserId]/page.tsx` | P2 |

### Pro Seller / Storefront

| iOS view | Web equivalent | Priority |
|---|---|---|
| `EbayListingDraftView.swift` / `EbayListingManageView.swift` | `apps/web/src/app/app/ebay/page.tsx` | P1 (Pro Seller only) |
| `EbayConnectView.swift` / `IntegrationsView.swift` | inside settings / ebay page | P1 |
| `InventoryIQView.swift` | `apps/web/src/app/app/erp/page.tsx` + `purchases/`, `expenses/`, `tax/`, `unreconciled/` | P1 (Pro Seller only) |
| `ERPInventoryAnalyticsView.swift` | inside erp page | P1 |
| (no direct iOS view yet) | `apps/web/src/app/app/storefront/page.tsx` | P2 — public storefront (web-only for launch is OK) |

### BuyerIQ

| iOS view | Web equivalent | Priority |
|---|---|---|
| `BuyerIQView.swift` | `apps/web/src/app/app/buyeriq/page.tsx` | P1 |
| `BuyerIQCreateListView.swift` | `apps/web/src/app/app/buyeriq/[listId]/page.tsx` (create modal) | P1 |
| `BuyerIQListDetailView.swift` | `apps/web/src/app/app/buyeriq/[listId]/page.tsx` | P1 |
| `BuyerIQTargetEditView.swift` | (inline edit within list detail) | P2 |

### Identify / cert

| iOS view | Web equivalent | Priority |
|---|---|---|
| `CardIdentifyView.swift` | `apps/web/src/app/app/identify/page.tsx` | P1 |
| `CertResolveView.swift` | inside identify flow | P1 |
| `CardSearchView.swift` | `apps/web/src/app/app/search/page.tsx` | P0 (same as CompIQ) |
| `CompIQVariantPickerView.swift` | picker component in card detail | P1 |

### Auth / onboarding

| iOS view | Web equivalent | Priority |
|---|---|---|
| `LaunchView.swift` / `LoginView.swift` | (marketing) landing + sign-in modal | P0 |
| `CreateAccountView.swift` / `AuthView.swift` | Stripe checkout flow OR native Apple Sign-In | P0 |
| `AccountView.swift` | `apps/web/src/app/app/settings/page.tsx` | P0 |

### Iron out or delete

| iOS view | Status | Action |
|---|---|---|
| `AppLaunchState.swift` | non-visual | no design work |
| `AppButtonStyle.swift` | style helper | needs to consume tokens |
| `AppSupport.swift` | non-visual | no design work |
| `PortfolioArchitecture.swift` / `PortfolioWorkspaceViewModel.swift` | view-model | no design work |

---

## 4. Component patterns to standardize

Every one of these appears across the app. Get them right ONCE in the shared component/style layer, then use throughout.

### 4.1 Card surface

Web: `.hiq-card` in globals.css — `#101B2D` bg, `border: 1px solid rgba(42,51,68,0.88)`, `border-radius: 14px`, `padding: 18px`.

iOS: reuse `HobbyIQTheme.Card` if it exists, or create it. Must use `HobbyIQTokens.CardNavy` for bg, `HobbyIQTokens.Border` for stroke, `HobbyIQTokens.RadiusSm` for corner.

### 4.2 Hero-stroke gradient (blue → green)

Reserved for: Dashboard hero value card, DailyIQ header, key CTAs, marketing hero sections.

Web: `background: var(--hiq-gradient-brand)`
iOS: `LinearGradient(colors: [Color(hex: "#2A6A9E"), Color(hex: "#2C8F66")], startPoint: .topLeading, endPoint: .bottomTrailing)`

### 4.3 Primary button (electric blue)

Web: bg `#1E90FF`, hover `#3DA9FF`, shadow `0 6px 12px rgba(30,144,255,0.24)`, radius `999px` (pill), padding `12px 24px`, font `body-emph white`.

iOS: Update `AppButtonStyle.swift` — same color, same pill radius, add the glow shadow. Press animation: `scale 0.985 opacity 0.96` over `160ms`.

### 4.4 Empty state

Every list surface (holdings, alerts, watchlist, buyerIQ, portfolio) needs an empty state that matches web's pattern:

- Centered container with subtle icon (SF Symbol on iOS, Lucide on web)
- Title (`.hiq-section-title`)
- Body copy (`.hiq-body`, muted)
- Primary CTA button linking to the "start here" flow

Web reference: check any `page.tsx` that has "No X yet" text.

### 4.5 Stat tile

Big number over caption. Used everywhere (dashboard, market movers, insight cards).

- Number: `.hiq-stat-number` (700 30px rounded)
- Label: `.hiq-caption-emph` (600 13px), muted color
- Change indicator: green if positive (`#7CFF72`), red if negative (`#FF3B30`), with small arrow

### 4.6 Tab bar / nav

iOS bottom tab bar: solid `#0B1424` background, top border `rgba(30,144,255,0.28)`, active tab tinted `#1E90FF`, inactive `#C4CDD9`.

Web top nav: same colors, horizontal layout. Logo on left, nav items center, avatar/menu right.

### 4.7 Comp row (recent sales list)

Web reference: `apps/web/src/components/RecentCompsList.tsx` — price left-aligned bold, meta line below (date · grader · marketplace), flag button on far right.

iOS should mirror row-for-row.

### 4.8 Grade curve

Web reference: `apps/web/src/components/GradeCurveView.tsx` — per-grade rows with market value, prediction, confidence bar.

iOS should have identical shape.

### 4.9 Search bar

Web: full-width pill input with search icon, placeholder `Search any card, player, or cert #...`, big blue "Search" button on right.

iOS: same styling adapted for keyboard, same placeholder, same button treatment.

---

## 5. Assets to grab

### Icons

Web uses Lucide React (via `lucide-react` package). iOS uses SF Symbols.

**Rule:** the SEMANTIC icon must match — if web uses `TrendingUp`, iOS must use the closest SF Symbol equivalent (`chart.line.uptrend.xyaxis`). Not literal pixel match, but semantic parity.

### Images

- **Logo**: `apps/web/public/hobbyiq-logo.png` — already used in email templates, should be iOS launch screen asset too. Check `HobbyIQ/HobbyIQ/Assets.xcassets/` for current version.
- **Card placeholders**: web has SVG placeholders when `imageUrl` is null; iOS should have equivalent (dashed border rectangle, muted "No image" text).

### Fonts

- **Display**: SF Pro Rounded (system, no download needed on iOS; web uses `ui-rounded` fallback stack)
- **Body**: system-ui
- **Mono**: SF Mono (for prices in tabular columns) — iOS default; web uses `--font-geist-mono`

### App Store screenshots

Web app's marketing pages (`apps/web/src/app/(marketing)/page.tsx` + `pricing/page.tsx`) are polished. Take screenshots of the WEB app at iPhone-sized viewports for App Store screenshots — hero page, pricing, sample dashboard, sample card detail. All the visual language should already be aligned.

---

## 6. Field remap contract (backend ↔ iOS)

Backend response shapes changed during the 2026-08-08 sprint. iOS needs to adapt to:

### `POST /api/search/cards` response

```typescript
{
  input: { raw: string, detectedMode: "freetext" | "cert" },
  candidates: CardIdentity[],  // may be empty
  warnings: string[]           // now includes "catalog_no_matches" (new)
                               //   removed "no_freetext_matches" (old, CH-era)
}
```

- Handle `warnings: ["catalog_no_matches"]` as "no results" state (empty result UI)
- Response titles now cleaner: "2018 Topps Chrome Update Shohei Ohtani #HMT1" instead of the old "Shohei Ohtani 2018 2018 Topps Chrome Update Baseball Base #HMT1"

### `POST /api/compiq/price-by-id` response

Backend now falls through to canonical-fmv when the cardId is an hiq: slug. Response shape unchanged (`PriceByIdResponse` interface in `apps/web/src/lib/api.ts:730`), but the values are now:

- `fairMarketValueLive` — always populated for hiq: slugs
- `source` — new values include `"direct-comp"`, `"canonical-fmv"` (in addition to old CH-era values)
- `compsUsed` / `compsAvailable` — now reflect the ACTUAL comp count from our own pool, not a legacy CH cache
- `buyZone` / `holdZone` / `sellZone` — always populated as `[low, high]` tuples

Confirm iOS handles all `source` values in its display logic (or falls back to "Live pricing" for unknown values).

### `POST /api/compiq/canonical-fmv` (recommended endpoint)

For fresh iOS work, prefer this endpoint over `price-by-id`. Response shape:

```typescript
{
  fmv: number,
  method: string,            // "direct-comp" | "product-family-projection" | ...
  confidence: number,        // 0-1
  provenance: {
    summary: string,         // human-readable e.g. "718 same-parallel user comps"
    comps: RawComp[],        // recent sales
    trendPctPerMonth: number | null
  },
  gradeLadder: {
    tiers: Array<{ grader: string, medianRatio: number, fmv: number }>
  },
  recentRange: { n, min, p25, median, p75, max },
  buyPrice: { buyPrice, confidence, economics }
}
```

### Subscription entitlement mapping

Backend `entitlements.ts` maps both old product IDs and `.v2` product IDs to the same tier. iOS should send whichever product ID the user is actually subscribed to — backend handles the mapping.

Product IDs (App Store Connect, already configured):
- `com.hobbyiq.collector.monthly.v2` → Collector
- `com.hobbyiq.investor.monthly.v2` → Investor
- `com.hobbyiq.proseller.monthly.v2` → Pro Seller

Old IDs (grandfathered users): map to same tier without `.v2` suffix.

---

## 7. Payment integration (Stripe web + Apple iOS)

**Split-channel intent:** Push new signups to web (Stripe) to save 30% Apple cut. iOS in-app purchase supported for users who want to sign up on-device.

### Stripe (web)
- Code exists in the repo per Drew — integration is set, just not flipped on
- Product: verify the Stripe products exist with matching price points ($12.99/$24.99/$49.99)
- Webhook handler: verify `checkout.session.completed` grants entitlement in the same `entitlements.ts` used by iOS
- Flip on: set whatever env flag gates it (search backend for `STRIPE_ENABLED` or similar)

### Apple (iOS)
- `@apple/app-store-server-library` already in backend deps
- App Store Server API creds already in HobbyIQ3 App Settings (`APPLE_API_ISSUER_ID`, `APPLE_API_KEY_ID`, `APPLE_API_PRIVATE_KEY_B64`, `APPLE_BUNDLE_ID`)
- v2 product IDs registered in App Store Connect (confirmed by Drew)
- Flow to verify end-to-end with sandbox account before submission

**Cross-channel rule:** if a user signs up on web via Stripe then opens iOS, they see their subscription — same account, same tier, no double-charge. Backend entitlement is the single source of truth.

---

## 8. Acceptance criteria

For each iOS screen listed in section 3, "done" means:

1. **Colors match web exactly** — screenshot side-by-side, no hue difference. Both drawing from `tokens.generated.css` / `HobbyIQTokens.generated.swift` should guarantee this.
2. **Spacing matches** — same padding on cards, same gaps between sections, same screen-edge padding (16px).
3. **Typography matches** — same weight, size, line-height per role.
4. **Radius matches** — cards at 14px, buttons at pill (999px), hero at 24px.
5. **Motion matches** — press-scale + press-fade on all tappable elements at 120-160ms.
6. **Empty state matches** — same wording, same icon semantic, same CTA.
7. **Hero-stroke gradient present** on the same screens as web (dashboard hero, DailyIQ header, primary CTAs).
8. **Layered background gradient** on every screen root — not flat.

---

## 9. Testing plan

### Visual QA
- Physical device screenshot vs web (Safari on iPhone) side-by-side for every P0 screen
- Difference tool (Kaleidoscope or similar) — accept if pixel diff < 3% on non-content areas
- Both light-mode inspection (iOS defaults dark) and edge cases (empty portfolio, error state, loading)

### Interaction QA
- Every tappable element has the press animation
- Every list scrolls smoothly at 120fps on ProMotion devices
- Rotate device: layouts don't break

### Cross-channel QA
- Sign up on web via Stripe → open iOS → see subscribed state
- Sign up on iOS via Apple IAP → open web → see subscribed state
- Cancel on web → iOS reflects within 5min
- Cancel on iOS → web reflects within 5min

### Backend contract QA
- Search "2018 topps chrome update ohtani" on iOS — should show HMT1 as top hit with real FMV
- Card detail for HMT1 shows "$375 · 718 comps · direct-comp" (not "no-recent-comps")
- Portfolio import a 500-card CSV — no memory issues, dedup works, all rows render

### App Store submission QA
- Screenshots (6.5" and 6.7" required) captured from POLISHED web app views
- Review notes explain the app's purpose (card pricing + portfolio tracking)
- Sandbox account for Apple reviewer to test IAP
- Privacy policy URL points to `hobby-iq.com/privacy` (live)
- Terms URL points to `hobby-iq.com/terms` (live)

---

## 10. What NOT to do

- **Don't hand-edit `HobbyIQTokens.generated.swift` or `tokens.generated.css`.** They're both generated from `design/tokens.json`. Edit the source, regenerate both.
- **Don't invent new colors.** If a color isn't in tokens.json, add it there first with a semantic name.
- **Don't skip the layered background gradient.** Flat backgrounds are the #1 tell that iOS diverged from web.
- **Don't build custom iOS-only components** if a web analogue exists — port the web component semantics.
- **Don't add Apple IAP hover states or web-only interactions to iOS.** Respect platform conventions where it matters (nav paradigm, gestures, keyboard) but hold the line on visual language.
- **Don't skip empty states.** Missing empty states = amateur launch. Every list surface needs one.

---

## 11. Reference files

Read these first before touching anything:

**Design tokens**
- `design/tokens.json` (source of truth)
- `apps/web/src/app/tokens.generated.css` (web output)
- `HobbyIQ/HobbyIQ/DesignSystem/HobbyIQTokens.generated.swift` (iOS output)
- `HobbyIQ/HobbyIQ/DesignSystem/HobbyIQTheme.swift` (iOS component library)

**Web pages (canonical visual reference)**
- `apps/web/src/app/globals.css` — root styles + gradients
- `apps/web/src/app/app/page.tsx` — dashboard home
- `apps/web/src/app/app/daily/page.tsx` — DailyIQ
- `apps/web/src/app/app/search/page.tsx` — search
- `apps/web/src/app/app/card/[cardsightId]/page.tsx` — card detail
- `apps/web/src/app/app/portfolio/page.tsx` — portfolio home
- `apps/web/src/components/CardPriceDetail.tsx` — pricing card component
- `apps/web/src/components/RecentCompsList.tsx` — comp list component
- `apps/web/src/components/GradeCurveView.tsx` — grade breakdown

**Backend API contracts**
- `apps/web/src/lib/api.ts` — every response type used by web (iOS should adapt equivalents)
- `backend/src/routes/compiq.routes.ts` — /price-by-id, /canonical-fmv routes
- `backend/src/routes/search.routes.ts` — /api/search/cards route
- `backend/src/routes/canonicalFmv.routes.ts` — canonical FMV endpoints

**iOS project entry points**
- `HobbyIQ/HobbyIQ.xcodeproj` — Xcode project
- `HobbyIQ/HobbyIQ/AppRootView.swift` — root
- `HobbyIQ/HobbyIQ/MainAppView.swift` — main shell
- `HobbyIQ/HobbyIQ/APIClient.swift` / `APIConfig.swift` / `APIService.swift` — network layer

---

## 12. Milestone dates

| Milestone | Date | Owner |
|---|---|---|
| Field remap contract finalized | Aug 12 | Drew + backend session |
| Design tokens re-verified | Aug 13 | iOS session |
| Component library update (buttons, cards, empty states) | Aug 15 | iOS session |
| Screen migration wave 1 (dashboard, daily, search, card detail) | Aug 18 | iOS session |
| Screen migration wave 2 (portfolio, alerts, buyerIQ) | Aug 21 | iOS session |
| Screen migration wave 3 (settings, integrations, everything else) | Aug 24 | iOS session |
| Full-visual QA (side-by-side vs web) | Aug 25 | Drew |
| App Store submission | **Aug 25 (hard deadline)** | Drew |
| Apple review + fixes if rejected | Aug 26 – Sept 5 | Drew + iOS session |
| Buffer for regressions | Sept 6-13 | any session |
| **Launch** | **Sept 14** | Drew |

---

## 13. Emergency contacts + escalation

- Backend/pricing engine questions: reference `backend/CLAUDE.md` + memory records in `~/.claude/projects/.../memory/`
- Design decisions Drew needs to make: SMS Drew — every open question gets an ANSWER, not a "let me get back to you"
- If iOS build breaks and iOS session can't unblock: revert to previous TestFlight build immediately, fix in a follow-up

---

**End of spec.** This document is self-contained — a fresh Claude session with only this doc + repo access should be able to execute the iOS parity build to completion.
