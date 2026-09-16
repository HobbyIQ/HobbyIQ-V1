# Where the 60 s Cosmos timeouts come from

Read-only follow-up to `cosmos-60s-failures-2026-09-15.md`, which established
the census (2.13M / 30 d, ~97% `card_catalog`, duration ≈ 60,000 ms = the SDK's
default `requestTimeout`). This attributes them to call sites.

## By operation (7 d, `est` = rows × itemCount, i.e. un-sampled)

| operation_Name | est. failures |
|---|---:|
| **`POST /api/tca/webhook`** | **1,411,860** |
| *(blank — no request context)* | 289,365 |
| `POST /api/staging/auto-triage` | 12,380 |
| `POST /api/compiq/price` | 4,700 |
| `POST /api/staging/image-verify` | 4,540 |
| `POST /api/daily/publish-market` | 2,050 |
| `GET /api/compiq/market-trend/top-movers` | 1,060 |
| everything else | < 1,000 |

**The TCA webhook is 82%.** User pricing (`/api/compiq/price`, `/search`,
`/price-by-id`) is together **under 0.3%**.

## By container and verb

| operation | container | verb | est. |
|---|---|---|---:|
| `POST /api/tca/webhook` | **card_catalog** | `POST …/docs` (query) | **1,387,420** |
| *(blank)* | card_catalog | `POST …/docs` (query) | 248,800 |
| *(blank)* | daily_price_series | `POST …/docs` | 15,340 |
| *(blank)* | comps_staging | `POST …/docs` | 14,010 |
| `POST /api/tca/webhook` | card_catalog | `GET …/docs` (point read) | 9,730 |
| `POST /api/tca/webhook` | sold_comps | `POST …/docs` | 6,630 |

So: **one operation, one container, one verb — cross-partition query execution
against `card_catalog` from the TCA webhook — is the whole story.**

## The call sites

`persistVendorSalesToPool` is what the webhook routes every row through
(`tcaWebhook.routes.ts:27`, `:393`), and it issues two `card_catalog` queries
per sale in `narrowCardNumberFromChecklist`:

**Site 1 — `persistVendorSalesToPool.service.ts:93-100`**

```sql
SELECT TOP 200 ... FROM c
WHERE c.playerName = @p AND c.year = @y AND c.source IN (...)
```

**Site 2 — `persistVendorSalesToPool.service.ts:118-125`** (only when site 1
returns nothing)

```sql
SELECT TOP 100 ... FROM c
WHERE c.year = @y AND CONTAINS(LOWER(c.playerName ?? ''), @last) AND c.source IN (...)
```

Both are **inherently cross-partition**: `card_catalog` partitions on
`/cardId`, and neither `playerName` nor `year` is the partition key. The file's
own comment says so at `:88-91`. Site 2 additionally uses
`CONTAINS(LOWER(...))`, which no range index can serve, so it scans.

## Why the obvious fix does not apply

The brief asks for "the right partition key (card_catalog pk is /cardId;
cardId-less rows live under None)". **These queries cannot be partition-keyed.**
They are a reverse lookup — *given a player and a year, which card is this?* —
and the partition key is the answer being sought, not an input. There is no
`cardId` to supply; finding one is the point.

That also rules out the None-partition angle: this is not a point read at the
wrong key (the failure mode fixed in #2165), it is a genuine fan-out.

## What is actually wrong, and it is not the query

Neither query is unbounded — both carry `TOP`, added by
CF-CHECKLIST-NARROW-SCHEMA-FIX. The defect is **volume**: TCA delivers
1,000-row batches, and this runs **per sale**, so one webhook call can issue up
to 2,000 cross-partition queries against a container that is also serving user
pricing. That is what saturates RU and pushes individual calls past 60 s.

The same file already records this exact shape causing "~145k RU/s on
`card_catalog` and 130k+ 429s per 5 minutes" (`:84-86`) when the query was
broken. It is no longer broken, but it is still per-sale.

## Recommended fix — batching, not timeouts

A per-site `requestTimeout` would convert a 60 s failure into a faster failure.
It would not reduce the number of queries, would not lower RU, and on this path
a failed narrow means the sale is written without a resolved `cardNumber` —
i.e. **a tighter timeout makes the data worse, not better**.

The smallest correct fix is to **batch the lookup per webhook call rather than
per sale**: collect the distinct `(playerName, year)` pairs in the batch, issue
one query per distinct pair (or one `IN`-clause query per year), and resolve
every sale from the result. A 1,000-row batch typically covers far fewer
distinct players than rows, so this is a large constant-factor reduction with
identical results.

Expected effect, stated as a prediction to be measured rather than a claim:
queries per webhook call fall from ~1–2 per sale to ~1 per distinct
`(player, year)`; RU on `card_catalog` falls proportionally; the 60 s
population — 82% of all such failures — should largely disappear.

**This changes the ingest write path, which the r32 wave is running on.** It is
not a safe change to make under the current freeze, and it wants a canary
(compare resolved-`cardNumber` rates before and after on the same batch) rather
than a merge on green. Flagged for scheduling rather than built.

## Global client defaults

Not proposed. A global `requestTimeout` would affect every lane including the
rematch, and #2164 already established the pattern for that (gated to the web
process, opt-in). The per-site issue here is call volume, which no timeout
setting addresses.
