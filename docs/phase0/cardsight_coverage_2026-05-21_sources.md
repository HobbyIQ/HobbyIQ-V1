# Cardsight coverage spot-check — source-data audit (2026-05-21)

Phase 0 / Objective 1.6 — STAGE 1 (data sources only).
NO Cardsight calls have been issued yet. Read-only inspection only.

## Status: HALT requested before issuing Cardsight calls

Three findings pre-empt the original 1.6 plan and require user direction.

---

## Finding 1 — `comp_logs` Cosmos writer is GONE from the codebase

- `backend/src/services/dailyiq/marketDelta.service.ts` (the READER) still
  exists and references `comp_logs` partitioned by `/player`, with fields
  `finalPrice` + `epochMs`.
- Memory note claimed writer at `src/services/compLogService.ts` — **does
  not exist**. Greps for `compLogService|logCompResult|writeCompLog|
  comp_logs.*create|items\.create.*comp` return zero hits anywhere in
  `backend/src/`.
- The Cosmos container `comp_logs` likely still has historical rows but is
  no longer being appended to from production code.
- Implication: cannot use `comp_logs` to discover top-N production queries.

## Finding 2 — `compiq_corpus` container exists but sample rate is 0

- `backend/src/services/corpus/writeCorpusEntry.ts` writes to container
  `compiq_corpus` in db `hobbyiq`.
- Both `/api/compiq/price` and `/api/compiq/price-by-id` call
  `writeCorpusEntry(...)` fire-and-forget.
- App setting on `HobbyIQ3`: `COMPIQ_CORPUS_SAMPLE_RATE = 0`.
- Implication: no production rows are being captured. Container is empty
  for our purposes.

## Finding 3 — Production traffic shape ≠ what the plan assumed

App Insights `requests` aggregated by route over last 30 days:

| Route                         | Count |
|-------------------------------|------:|
| POST /api/compiq/search       |  3510 |
| POST /api/compiq/price-by-id  |  1660 |
| POST /api/compiq/estimate     |   152 |
| POST /api/compiq/cardsearch   |    53 |
| POST /api/compiq/search-list  |    48 |
| POST /api/compiq/price        |    17 |

`/price` (the route the prior plan referenced for Axis 1) is **negligible**.
The dominant free-text path is `/search`, which logs a structured trace
on every call: `[compiq.search] parsed query="..." → player="..." year=...`

`/price-by-id` is the dominant cardId-pinned path. Its router warn
`primary_mode_cardhedge_namespace_only` only fires on **156 of 1660** calls
in 30d (~9% sampling). The other ~91% never reach the warn line — likely
because `getCardSalesRouted` is not always invoked on this path, or the
warn predates the deploy. This needs verification before claiming Site B
(returns []) fires for all `/price-by-id` traffic. Earlier 1.4b verdict
A2 must be tightened: it's "fires for the cohort that reaches the
router," not "fires for every /price-by-id call."

---

## Source data harvested (read-only)

### Axis 1 — Top 25 free-text queries from /search traces, last 30d

Counts are very tight (49–72 per query) within a 6-day window
(2026-05-14 → 2026-05-21). This pattern is consistent with a synthetic
harness or load-test, not organic user traffic. The mix includes
non-baseball cards (1986 Fleer Jordan, 2018 Prizm Luka, 2020 Prizm
Herbert) which CompIQ's `/search-list` is supposed to filter to baseball.

| n  | query | sample player |
|---:|---|---|
| 72 | 2025 Bowman Draft Chrome Green Refractor Auto Eli Willits | Eli Willits |
| 71 | 2024 Bowman Draft Chrome Blue Auto Caleb Bonemer | Caleb Bonemer |
| 70 | 1986 Fleer Michael Jordan PSA 8 | Michael Jordan |
| 70 | 2020 Panini Prizm Justin Herbert PSA 10 | Justin Herbert |
| 69 | 2023 Bowman Draft Green Refractor Auto Jacob Wilson PSA 10 | Jacob Wilson |
| 69 | 2018 Bowman Chrome Wander Franco 1st Auto | Wander Franco |
| 69 | 2018 Panini Prizm Silver Luka Doncic PSA 10 | Luka Doncic |
| 69 | 2024 Bowman Draft Chrome Refractor Auto Nick Kurtz PSA 10 | Nick Kurtz |
| 69 | 2025 Bowman Draft Chrome Green Refractor Auto Eli Willits PSA 10 | Eli Willits |
| 67 | 2024 Bowman Chrome Blue Raywave Auto Leo De Vries PSA 10 | Leo De Vries |
| 67 | 2025 Topps Transcendent Auto Shohei Ohtani /25 | Shohei Ohtani |
| 67 | 2025 Bowman Draft Chrome Gold Auto Gage Wood PSA 9 | Gage Wood |
| 67 | 2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond PSA 10 | Josh Hammond |
| 67 | 2024 Bowman Draft Chrome X-Fractor Auto Caden Bodine | Caden Bodine |
| 67 | 2025 Bowman Draft Chrome Red Lava Auto Josiah Hartshorn PSA 9 | Josiah Hartshorn |
| 67 | 2025 Bowman Draft Chrome Gold Wave Auto Josh Hammond | Josh Hammond |
| 67 | 2024 Bowman Draft Chrome Gold Wave Auto Caleb Bonemer PSA 9 | Caleb Bonemer |
| 67 | 2024 Bowman Draft Chrome Refractor Auto Nick Kurtz | Nick Kurtz |
| 67 | 2024 Bowman Draft Chrome X-Fractor Auto Caden Bodine PSA 10 | Caden Bodine |
| 67 | 2025 Bowman Draft Chrome Blue Auto Josh Hammond | Josh Hammond |
| 67 | 2025 Bowman Draft Chrome Blue Auto Josh Hammond PSA 10 | Josh Hammond |
| 67 | 2017 Topps Chrome Aaron Judge Catching RC PSA 10 | Aaron Judge |
| 52 | 2023 Topps Update Elly De La Cruz RC | Elly De La Cruz |
| 49 | 2024 Topps Chrome Paul Skenes RC | Paul Skenes |
| 49 | 1989 Upper Deck Ken Griffey Jr RC PSA 9 | Ken Griffey Jr |

### Axis 2 — Top cardIds from `primary_mode_cardhedge_namespace_only` warn, last 30d

Two ID namespaces are present:

- `\d{13}x\d{18}` → Bubble.io-style DB IDs (legacy CardHedge)
- `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` → UUIDs (newer)

| n  | cardId |
|---:|---|
| 46 | 1769294194944x719861363807160400 |
| 27 | 1736804710503x733182095750814300 |
| 23 | 1769295282056x560403074021780700 |
| 23 | 1736806089284x299374493557942800 |
| 20 | 496a7e19-b26d-4f48-9fae-e66d6961c27a |
|  4 | 1702843628240x889441068775949600 |
|  4 | 1736791720219x582648490284626000 |
|  3 | 1727395755631x391867674646985150 |
|  2 | 1715551779569x844428353245400800 |
|  2 | 1727395190137x303854485548176640 |
|  1 | fc2abed8-650b-46f6-a122-8ba2773a31cf |
|  1 | 1586812246197x228181943611293700 |

Total cohort: 156 / 12 distinct ids.
Caveat: this is only ~9% of `/price-by-id` calls (1660 in same window).

### Catalog freshness candidates (proposed, not yet executed)

Will sample 2–3 known recent baseball cards against `searchCatalog` only
after user approves Stage 2 (live Cardsight calls):

- 2025 Topps Chrome Roman Anthony RC base
- 2025 Bowman Draft Chrome Eli Willits Auto refractor
- 2026 Bowman Chrome (any base — tests catalog freshness)

---

## Decision points for the user

1. **Axis 1 source is largely synthetic.** Should the spot-check still
   target this top-25 list as-is, or seed it with a curated production-
   representative baseline (e.g. last 30d organic queries minus replayed
   harness traffic) before calling Cardsight?

2. **Axis 2 cohort is only 9% of /price-by-id traffic.** Do we accept the
   12 cardIds as the spot-check universe, or first reconcile why the warn
   isn't firing on the other 91% (could mean Site B short-circuit isn't
   the universal failure mode — earlier 1.4b verdict A2 may need to
   tighten)?

3. **Cardsight namespace problem stays unresolved.** The 12 cardIds above
   are all in CardHedge namespace. There is no CH→Cardsight ID translator
   in the repo (confirmed in 1.5). The only path to call `getPricing`
   for these is to recover structured attributes (player, year, set,
   parallel) and run them through `resolveCardId(...)`. The corpus has
   `cardIdentity` available in live responses but the writer captures
   only the whitelisted privacy-safe fields — `cardIdentity` is NOT in
   the `compiq_corpus` schema. This means: for the 12 production cardIds,
   we may have NO recoverable structured attributes from any persisted
   store.

4. **No Cardsight call has been issued** in this stage. Awaiting go/no-go
   on which list to use and whether to proceed to Stage 2.
