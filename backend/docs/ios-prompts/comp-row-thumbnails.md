# Comp Row Thumbnails — Phase 0 of the Attribution-Quality Pipeline

**Status:** Backend shipped (this PR); iOS implementation TODO.
**Surface:** every place iOS renders a `recentComps[]` row — comp analysis, holding detail, card-detail comp panel.
**Effort:** ~30-60 min on iOS.

## Why this exists

Big-picture, Drew committed to making comp-pool attribution correctness best-in-class. The full pipeline (pHash clustering + reference library + LLM vision escalation + confidence scoring) is a multi-week Phase-1-through-Phase-5 build. This doc is **Phase 0** — the immediate value that ships before any of that infrastructure lands.

Rendering the actual eBay thumbnail alongside each comp does two things:

1. **User trust:** they see the physical listing image next to the price. If a comp visually doesn't match their card, they notice and can flag it (feeds the wrong-attestation flow already shipped in PRs #446/#460).
2. **Attribution-quality signal today:** without any ML pipeline, humans catch the attribution errors that a wrong-parallel-tagged sale surfaces. Ship this first; the ML layers layer on top later.

## What backend now emits

Every comp on the wire under `recentComps[]` has an optional `imageUrl` field:

```typescript
interface RecentComp {
  price: number;
  title: string;
  soldDate: string;
  grade: string;
  saleType?: "Buy It Now" | "Auction";   // omitted when CH didn't classify
  imageUrl?: string;                       // omitted when CH didn't include an image
  belowMarket?: boolean;                   // omitted when threshold uncomputable
  source?: string;                         // "cardhedge" | "cardsight" | "ebay-user-*" | ...
  verifiedByUser?: boolean;                // true when a HobbyIQ user attested this comp
}
```

**Verified 2026-07-16:** live CH `/cards/comps` responses carry `image` per sale (see `backend/tests/cardhedgeCompsImageUrl.test.ts` for the pin). The backend patches in this PR:

1. Added `image_url: string \| null` to the `CardHedgeSale` interface.
2. Read `s.image ?? s.image_url ?? null` in `_getCardSales` — defensive against a future CH field rename to match the daily-export's `image_url` naming.
3. Threaded through `chSalesToRawComps` → `RawComp.imageUrl` → `recentComps[].imageUrl` on the wire.
4. Threaded through the `recordSoldComp` write in `cardsight.router.ts` — so the `sold_comps` unified pool captures thumbnails too, not just the vendor's live comps.

## Render specs

### Comp row layout (baseline)

- **Thumbnail:** 60×60pt on the leading edge of the comp row.
- **Aspect ratio:** the eBay images are variable (square, portrait, landscape). Contain-fit inside a fixed square frame; letterbox the background at a neutral neutral (avoid pure white — reads as broken; use `Color.systemGray6`).
- **Corner radius:** 4pt.
- **Loading state:** placeholder rectangle in `Color.systemGray6` — same dimensions, no spinner (would flash on fast connections and read as broken on slow ones).
- **Fallback (imageUrl absent OR image fails to load):** rectangle in `Color.systemGray6` with a small system icon inside (e.g. `photo` at 24pt, tinted `Color.systemGray3`). Do NOT show "No image" text — visually noisy on a comp list.

### Comp row layout (with image)

```
┌────────┐  $42.50 · PSA 9 · Buy It Now
│  IMG   │  Sold 3 days ago
└────────┘  ▲ 12% vs 14-day median
            [CardHedge · community verified]
```

- Image on left, price + grade + saleType on top-right (existing content).
- Below that: sold-date line (existing).
- If `belowMarket === true`: existing green pill.
- If `verifiedByUser === true`: existing blue "verified" badge.

### Tap behavior

Tap the thumbnail (or the row) → open a modal/sheet showing the image at full-width. Include the eBay `listing_url` if you carry that field on iOS (backend emits it under `url` on some paths; not universally). Simple "Open in Safari" button at the bottom for cases where the URL is present.

### Grid/list contexts

Everywhere `recentComps[]` currently renders — comp analysis screen, holding detail's recent-sales section, card-detail comp panel. Same 60×60 spec across all surfaces for visual consistency.

## What NOT to do

- **Don't pre-download all thumbnails.** Use SwiftUI's async image loading (or a lightweight caching wrapper). eBay thumbnails at `s-l500` size are ~50 KB each; 10 comps on a row = 500 KB. Loads under a second on WiFi, use progressive rendering.
- **Don't fail-loud on image errors.** eBay images can 404 when the listing is delisted; the fallback square is enough. No error messages, no red UI.
- **Don't over-cache.** Images can update on eBay's side; cache TTL of ~24 hours is plenty. Longer than that and stale images accumulate.
- **Don't show images on top-level list rows** (portfolio inventory, DailyIQ). Those already show CardHedge's canonical card image via the existing `cardImageThumbUrl`. Comp images are per-sale, per-listing — they show ONLY inside the comp row context.

## Testing

Real inventory validation:

1. Open the comp analysis for a card with several recent sales — every row should show a thumbnail if CH provided one.
2. Look for at least one row where `imageUrl` is absent (older sale, delisted listing) — placeholder should render cleanly.
3. Tap a thumbnail — full-size view opens.
4. Manually flag one comp as "wrong card" — existing flow — and confirm the image goes away with the comp.
5. Scroll fast through a long comp list — images should progressively load, not block the scroll.

## What comes next (Phase 1-5)

Not this session, not immediately, but the roadmap Drew committed to:

- **Phase 1:** pHash pipeline over the daily-export bulk. Every sale gets a perceptual hash; cluster by similarity.
- **Phase 2:** reference library — canonical CH image per `(card_id, variant)`, compared against sale images.
- **Phase 3:** `attributionConfidence` field on `sold_comps`. Comps below threshold drop from hot-path pools automatically.
- **Phase 4:** confidence indicator on comp rows in the app. User feedback loop wires up.
- **Phase 5:** LLM vision as escalation for ambiguous clusters.

Phase 0 (this doc) is the human-in-the-loop foundation. Everything after adds automated attribution correctness on top.

## Related

- [[project_sold_comps_unified_pool]] — the pool this thumbnail data feeds into.
- [[project_catalog_verify_boost_hierarchy]] — the existing confidence-boost system that Phase 3 will integrate with.
- PR #446/#460/#463 — the wrong-attestation soft-delete + user reputation infrastructure this connects to.
