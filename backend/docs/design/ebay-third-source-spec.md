# eBay as Third Sold-Comps Source

Author: Drew, 2026-08-10.
Status: **SPEC — pending scoping approval**.

## Goal

Add eBay as our third independent sold-comps source (alongside TCA and CardHedge). Rationale:

- **Ownership**: Both TCA and CH are third-party. TCA had a silent key rotation
  + webhook-entitlement gap this week; CH runs erratically (feast/famine ingest
  cadence). We depend on vendors we don't control.
- **Freshness**: TCA nightly cron has ~15-30 min latency; CH is batchy at
  multi-hour scale. Direct eBay ingest could match webhook-tier freshness.
- **Data quality**: TCA/CH parse eBay titles for us — we inherit their errors.
  Owning the parse means we can iterate on identity extraction quality.
- **Moat**: "Persist-vendor-lookups architecture" — every eBay sold row that
  passes through us builds our owned pool.

## NOT the goal (yet)

**Replace TCA/CH**. This is a THIRD source, run in parallel. TCA + CH stay as
fallbacks + coverage-diff signal. Retire vendors only after eBay source
demonstrates ≥ TCA-parity for 90+ days.

## Options ranked

### 1. eBay Marketplace Insights API *(recommended)*
- **What**: eBay's official completed-listings API. Returns sold-price
  history with structured title/price/date/seller/image/listing-URL fields.
- **Coverage**: 90-day lookback per query, plus real-time completed items.
- **Auth**: OAuth 2.0 with a business seller account + application approval.
  Approval is non-trivial — eBay requires a business use-case pitch and can
  reject or throttle.
- **Cost**: Currently ~$0.005 per call at scale (100-item response). At 4M
  sales/year target = ~$200/yr per full corpus refresh. Delta pulls are
  effectively free.
- **Legality**: 100% sanctioned. No ToS risk.
- **Timeline**: Application submission → approval typically 2-4 weeks.
  Implementation once approved: ~1 week.

### 2. eBay Browse API + Finding API
- **What**: Browse for active listings; Finding for completed. Finding's
  completed-item support was deprecated in 2019 and no longer returns sold
  data. Browse API only covers active listings, not sold history.
- **Verdict**: Not viable for sold-comps use case alone. Can supplement for
  active-listing counterparts.

### 3. Direct HTML scraping of `www.ebay.com/sch/...` sold listings
- **What**: Fetch the "Sold Items" search results page, parse HTML.
- **Coverage**: 90-day rolling window, same as Marketplace Insights.
- **Auth**: None (public pages).
- **Cost**: Server-side compute + IP-rotation infrastructure.
- **Legality**: **Violates eBay ToS for commercial use.** eBay actively
  fingerprints + blocks scrapers (Cloudflare fingerprinting, CAPTCHA gates).
  Also legally risky — hiQ v. LinkedIn established public data scraping is
  legal *for open pages* but eBay's login-gated sold-history pages likely
  cross that line.
- **Verdict**: Do not recommend as primary path. Could be a stopgap while
  waiting for Marketplace Insights approval, but budget for 30% breakage
  overhead.

### 4. Hybrid: Marketplace Insights + user-eBay-account backfill
- Users optionally link their eBay account via eBay Partner Network OAuth.
- We can then pull *their own* purchase + sale history via authenticated
  Trading API (fully legal, per-user quota).
- Enriches the pool with grade/parallel context the user's own listings had.
- Complements Marketplace Insights (which is anonymous).

## Recommended plan

1. **This week**: Submit eBay Developer Program application for
   Marketplace Insights API access. Business pitch: "authoritative pricing
   for sports card collectors, sub-15-minute latency on completed sales".
2. **While waiting for approval** (est. 2-4 weeks):
   - Build the `ebay-sold-adapter` module in `backend/src/services/ebay/`
     with a mock provider so we can wire it into `persistVendorSalesToPool`
     end-to-end and unit-test the identity-parse + slug flow.
   - Sign up for the sandbox tier (free) to develop against real API shapes.
3. **On approval**: Switch mock to live provider, run first firehose (a
   single 24hr window; measure quota + accuracy vs TCA/CH).
4. **Coverage phase** (weeks 4-8): Backfill 90 days. Monitor delta pulls
   run < 200 API calls / hour.
5. **Parity gate**: 90-day observation with all three sources active. Track
   per-slug coverage: eBay vs TCA vs CH row counts, and the percentage of
   rows only ONE source captured (each vendor's blind spots). Retire the
   weakest source based on data.

## Architecture

```
             ┌─────────────────┐
             │ ebay-sold        │  new
             │ adapter          │
             └────────┬─────────┘
                      │
┌──────────────┐      │        ┌───────────────────────────┐
│ tca-firehose │──────┼───────▶│ persistVendorSalesToPool  │──▶  sold_comps
│ cron         │      │        │   • identity parse         │
└──────────────┘      │        │   • slug compute           │
                      │        │   • contentHash dedup      │
┌──────────────┐      │        │   • catalog match          │
│ cardhedge    │──────┘        └───────────────────────────┘
│ ingest       │
└──────────────┘
```

Existing pipeline handles dedup + slug + catalog match. New source plugs
in behind `persistVendorSalesToPool` — no changes to downstream code.

## Metrics / success criteria

- **Coverage delta**: `(eBay row count - TCA row count) / TCA row count` per
  week. Target: eBay ≥ TCA within 90 days.
- **Latency P50**: time from eBay listing marked "sold" to appearing in our
  sold_comps. Target: < 15 min.
- **Blind-spot rate**: percentage of sold_comps rows captured by only ONE
  source (eBay, TCA, or CH). Target: minimize the "only-CH" and "only-TCA"
  columns; they represent our exposure to vendor outages.

## Open questions

- Business entity for eBay Developer application: HobbyIQ LLC vs Just The Boys?
- Rate-limit budget: Marketplace Insights is currently 5000 calls/day free tier;
  we'd blow through that on a full corpus refresh. Need paid tier from day 1.
- Image mirroring: eBay listings return CDN URLs — do we mirror to our blob
  (as we do for TCA/CH) to guarantee availability, or link back?
- Sport filtering: TCA/CH have category filters. eBay Marketplace Insights
  accepts eBay category IDs — we'd need to map "Baseball" → category ID 261328
  etc. Also filter by keywords for our sports vs collectibles-adjacent.
