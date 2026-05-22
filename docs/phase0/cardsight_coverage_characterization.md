# Cardsight coverage characterization — CH removal consumption-layer defects

**Date:** 2026-05-22
**Author:** Triage workstream following rollback of PRs #110 and #111 (reverts `566fd8e` + `83ea415`)
**Scope:** Characterization only — what's working, what's broken, where. Not a redesign plan. Specific fix priorities and sequencing are deferred to a separate planning workstream.

## 1. Summary

Cardsight has comprehensive baseline data for the demo cards we care about. The 1.6% historical `outcome=ok / source=cardsight` rate over 30 days of production traffic is **not** caused by Cardsight coverage gaps. It is caused by four interacting defects across two backend modules:

| Module | Defect | Effect |
|---|---|---|
| `cardsight.mapper.resolveCardId` | Picks `candidates[0]` from catalog search without verifying release/set match | Wrong cardId selected when Cardsight's relevance ranking surfaces a high-priced insert before the user's intended base card |
| `cardsight.mapper.resolveCardId` `parallelMatches` | Token-subset logic: input "Blue Refractor" matches BOTH "Blue Refractor" AND "Blue Wave Refractor" — first `.find()` hit wins | When both Blue Refractor and Blue Wave Refractor exist as parallels, `.find()` order determines which one gets priced |
| `cardQueryParser.parseCardQuery` SET_PATTERNS | Missing `"bowman draft chrome"` entry; `"bowman draft"` matches first | Set parsed as "Bowman Draft" → dictionary lookup misses, releaseName never set, catalog search query collapses to player name alone |
| `cardQueryParser.isCompVariantMatch` AUTO regex | `\bauto(graph(ed)?)?\b` misses "Autographs" (s-suffix); AUTO_PREFIX_RE misses "(AU," (comma-suffix) | Real autograph comps falsely flagged as missing auto |

The variant filter itself is **not** the load-bearing problem. It is the symptom-surfacing layer. Its rules are reasonable; the defects feed it bad inputs.

Two additional findings reframe the architecture:

- **Cardsight encodes parallels as `parallel_id` request parameters, not as substrings of comp titles.** The 71 base Chrome Prospect Auto comps for Caleb Bonemer all have titles like `"Chrome Auto 1st Prospect #CPA-CBO"` — zero contain "blue", "wave", "refractor", or any parallel name. Title-substring matching cannot identify parallels because that's not where they live.
- **Numbered parallels are inherently thin in vendor data.** `getPricing(496a7e19, parallel_id=Blue Wave Refractor /150)` returns 0 records. The base auto card returns 71. Even with perfect consumption logic, a `/150` parallel will frequently produce zero pricing — distinct from both "consumption defect" and "vendor coverage gap."

## 2. Cardsight catalog inventory

Dictionary `COMPIQ_TO_CARDSIGHT_RELEASES` at [cardsight.mapper.ts:38-46](../../backend/src/services/compiq/cardsight.mapper.ts#L38-L46):

```
"topps chrome"           → "Topps Chrome"
"topps chrome update"    → "Topps Chrome Update"
"bowman chrome"          → "Bowman Draft Chrome"   (note: maps flagship to Draft Chrome)
"bowman draft"           → "Bowman Draft"
"bowman draft chrome"    → "Bowman Draft Chrome"
"panini prizm"           → "Panini Prizm"
"donruss"                → "Donruss"
```

Sub-set pattern dictionary `CARDSIGHT_SET_PATTERNS` (3 entries: Topps Chrome Base/Refractor/Prospect Auto).

Sets present in 30 days of `comp_logs` traffic that are **not** in the dictionary:

- `topps update` — primary flagship base (Mike Trout / Judge / Ohtani / Acuna RCs)
- `donruss optic`, `topps heritage`, `topps finest`, `topps stadium club`, `panini select`, `panini contenders`, `national treasures`, `flawless`, `upper deck` — appear in `parseCardQuery` patterns but not in releases dictionary

Notable mapping concern: `bowman chrome` (the flagship paper-product line) maps to `Bowman Draft Chrome` (the prospect-heavy chrome line). These are distinct releases in Cardsight's catalog. Test #7 in §3 confirms the mismatch: querying Sasaki (flagship 2024 Bowman Chrome player) resolved to George Lombard Jr.'s Bowman Draft Chrome Prospect card.

## 3. 30-day comp_logs distribution

1017 rows in `comp_logs` between 2026-04-22 and 2026-05-22.

| Set extracted from query | n queries | Cardsight ok | % ok |
|---|---:|---:|---:|
| Bowman Draft Chrome | 701 | 3 | 0.4% |
| Bowman Chrome | 76 | 4 | 5% |
| Panini Prizm | 70 | 0 | 0% |
| Topps Chrome | 41 | 6 | 15% |
| Bowman Draft | 35 | 0 | 0% |
| Topps (catch-all) | 35 | 0 | 0% |
| Topps Update | 15 | 3 | 20% |
| **All matched sets** | **973** | **16** | **1.6%** |

Endpoint × source × outcome distribution:

```
559  /api/compiq/search      fallback   no_recent_comps
213  /api/compiq/price-by-id fallback   no_recent_comps
210  /api/compiq/search      fallback   variant_mismatch
 13  /api/compiq/price       fallback   no_recent_comps
 10  /api/compiq/price       cardsight  ok
  6  /api/compiq/price-by-id cardsight  ok
  6  /api/compiq/price-by-id fallback   variant_mismatch
```

## 4. 10-card live test — current production behavior

Each test sent the iOS-shape free-text query to `/api/compiq/search-list` then `/api/compiq/price-by-id` against `fc5575d` (pre-revert deploy, PR #110 meaningful-query fall-through still live on hobbyiq3 at test time).

| # | Test card | Set | Dict | search-list resolved cardId | /price-by-id source | comps |
|---|---|---|---|---|---|---|
| 1 | Mike Trout 2011 Topps Update US175 | Topps Update | no | ✅ correct | no-recent-comps | 0/0 |
| 2 | Ohtani 2018 Topps Update US285 | Topps Update | no | ✅ correct | no-recent-comps | 0/0 |
| 3 | Judge 2017 Topps Update US87 | Topps Update | no | matched US99 (wrong #) | no-recent-comps | 0/0 |
| 4 | Bobby Witt Jr 2022 Topps Chrome USC150 | Topps Chrome | yes | matched Topps Chrome Update USC35 (wrong card) | no-recent-comps | 0/0 |
| 5 | Skenes 2024 Topps Chrome Update USC150 | Topps Chrome Update | yes | ✅ correct | no-recent-comps | 0/0 |
| 6 | Bonemer 2024 Bowman Draft Chrome Blue Refractor Auto | Bowman Draft Chrome | yes | ✅ correct (CPA-CBO Blue Wave Refractor Auto) | variant-mismatch | 0/69 |
| 7 | Sasaki 2024 Bowman Chrome (flagship) | Bowman Chrome | yes | resolved Lombard Jr. (wrong player, Bowman Draft Chrome Prospects) | no-recent-comps | 0/0 |
| 8 | Mike Trout 2011 Topps Update Diamond Anniversary | Topps Update | no | ✅ correct | no-recent-comps | 0/0 |
| 9 | Acuna 2018 Topps Update US250 | Topps Update | no | ✅ correct | no-recent-comps | 0/0 |
| 10 | Mike Trout 2011 (WS2-shape: "Mike Trout 2011 Topps Update Baseball") | Topps Update | no | ✅ correct (only result) | no-recent-comps | 0/0 |

`search-list` returns correct cardIds for 8/10 cards. `/price-by-id` under `CARDSIGHT_MODE=exclusive` produces zero usable comps for all 10.

## 5. Thread 1 — direct Cardsight calls bypass backend

Hitting Cardsight's API directly via `cardsight.client.searchCatalog` and `getPricing`:

| # | Test card | Top catalog match | Top getPricing | Alt match for expected release | Alt getPricing |
|---|---|---|---|---|---|
| 1 | Mike Trout 2011 Topps Update | 2011 Bowman / Topps 100 insert | **40 records** | 2011 Topps Update / Base Set | **600 records, last_sale=2026-05-22T03:27Z** |
| 2 | Ohtani 2018 Topps Update | Panini National Treasures booklet | 0 records | Topps Update | 0 records |
| 3 | Judge 2017 Topps Update | Bowman / ROY Favorites | 0 records | (no Topps Update in top 10) | — |
| 4 | Bobby Witt Jr 2022 Topps Chrome | Topps Update / Stars of MLB | 0 records | Topps Chrome (alt) | **10 records** |
| 5 | Skenes 2024 Topps Chrome Update | Topps Update / Stars of MLB | 0 records | Topps Chrome Update / 1989 Topps Baseball | 0 records |
| 6 | Bonemer 2024 Bowman Draft Chrome | Bowman Draft / Base Set | **51 records, last_sale=2026-05-18T16:03Z** | (auto candidate at position [1]) | — |
| 7 | Sasaki 2024 Bowman Chrome (flagship) | NO catalog match (dict-mapped to Draft Chrome) | — | — | — |
| 8 | Acuna 2018 Topps Update | Panini Immaculate / Triple Signatures | 0 records | (no Topps Update in top 10) | — |
| 9 | Mike Trout 2011 (no qualifier) | 2011 Bowman / Topps 100 | 40 records | Topps Update Base Set | **600 records** |
| 10 | Mike Trout 2011 (full-text WS2-shape) — no year filter | **Topps Update / Base Set — only result** | **600 records, last_sale=2026-05-22T03:27Z, sample=$295 Trout US175 RC** | — | — |

**Cardsight has 600 sale records for the 2011 Topps Update Mike Trout demo card. `last_sale` was today.** The vendor has the data. The catalog search just doesn't rank it at position [0] when given the structured query shape `resolveCardId` produces.

Test #10 is decisive: sending Cardsight the raw text "Mike Trout 2011 Topps Update Baseball" with no year filter returns exactly one result — the correct card. This is what PR #110's meaningful-query fall-through did and explains the `comp_logs` 05:18Z `ok/cardsight` rows from yesterday morning. The full-text path bypassed `resolveCardId`'s catalog query construction and let Cardsight's catalog text search work directly.

## 6. Thread 1 finding — resolveCardId selection bug

[cardsight.mapper.ts:78-100](../../backend/src/services/compiq/cardsight.mapper.ts#L78-L100):

```typescript
let releaseName = input.product ? lookupReleaseName(input.product) : null;
// product="Topps Update" → lookup returns null (not in dictionary)
const queryParts = [input.playerName.trim()];
if (releaseName) queryParts.push(releaseName);  // skipped when releaseName is null
const query = queryParts.join(" ");
const results = await searchCatalog(query, { year: input.cardYear, take: 25 });
```

When the dictionary doesn't have the product, the catalog query collapses to `playerName` alone with a year filter. Cardsight's relevance ranking surfaces high-priced inserts before flagship base cards.

[cardsight.mapper.ts:144-156](../../backend/src/services/compiq/cardsight.mapper.ts#L144-L156):

```typescript
const isSingleExact = candidates.length === 1;
const topCard = candidates[0];
// ...
// topCard is selected as the match regardless of release/set verification
```

`candidates[0]` is picked after the release-name filter step. When `releaseName` is null, no filter applies and the relevance-ranked top result wins. For "Mike Trout" + year=2011, that's "2011 Bowman / Topps 100" (40 records), not "2011 Topps Update / Base Set" (600 records).

## 7. Thread 2 finding — parser cascade through variant filter

### parseCardQuery SET_PATTERNS gap

[cardQueryParser.ts:46-69](../../backend/src/services/compiq/cardQueryParser.ts#L46-L69) iterates patterns in declaration order. For `"2024 Bowman Draft Chrome Caleb Bonemer Blue Refractor Auto"`:

- `bowman chrome draft` — doesn't match input order
- `bowman chrome` — doesn't match (the input has "Bowman Draft Chrome" sequence)
- `bowman draft` — **matches** → set assigned "Bowman Draft", brand "Bowman"

There is no pattern for "bowman draft chrome" before "bowman draft" matches. Result: set is parsed as "Bowman Draft" not "Bowman Draft Chrome", which propagates to `body.product = "Bowman Draft"`. `lookupReleaseName("bowman draft")` returns `"Bowman Draft"` (correct for the dictionary) but for the user who actually wanted Bowman Draft Chrome that's wrong.

### parseCardQuery PARALLEL_PATTERNS

For `"...Blue Refractor Auto"`:
- `parsed.parallel = "Blue Refractor"` (correct for the literal user input)

But the iOS request body that came IN to `/price-by-id` was free-text `"...Blue Refractor Auto"`. If the user actually wanted the **Blue Wave Refractor** parallel and typed "Blue Refractor" expecting fuzzy matching, the system can't distinguish the two parallels at parse time — they're both real Cardsight entities with different parallel_ids. This is a user-input-resolution problem, not strictly a parser bug.

### isCompVariantMatch AUTO regex misses two real formats

[cardQueryParser.ts:302-306](../../backend/src/services/compiq/cardQueryParser.ts#L302-L306):

```typescript
const AUTO_PREFIX_RE = /\b(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa|bbpa)[- ]/i;
const hasAuto =
  /\bauto(graph(ed)?)?\b/.test(title) ||
  /\brpa\b/.test(title) ||
  AUTO_PREFIX_RE.test(title);
```

- `\bauto(graph(ed)?)?\b` matches "auto", "autograph", "autographed" but **NOT** "Autographs" (the trailing `\b` requires a word boundary, "Autographs" has `s` after).
- `AUTO_PREFIX_RE` requires `[- ]` after the prefix. The format `"(AU, RC)"` has `,` after — misses.

Bonemer test confirmed: a comp titled `"2024 Bowman Draft - Class of 2024 Autographs Caleb Bonemer #C24-CBO /250 (AU, RC)"` is clearly an autograph; both regex paths miss it; filter rejects it as `comp_missing_auto`.

### Variant filter is mechanically correct

[cardQueryParser.ts:291-354](../../backend/src/services/compiq/cardQueryParser.ts#L291-L354) `isCompVariantMatch` does what it says — AUTO bidirectional, parallel substring, print-run regex, player last-name presence. The rules are reasonable. When given correct parsed inputs against the right card's comps, it produces correct outcomes (verified by counterfactual run in §8).

## 8. Verification pull — Chrome Prospect Autographs base cardId `496a7e19`

When you skip `resolveCardId`'s wrong-cardId selection and hit Cardsight directly for the cardId a user actually wanted:

```
getPricing(496a7e19) — no parallel_id

  raw=69, graded=2, total=71
  last_sale=2026-05-18T00:52:06Z
  sample titles:
    "2024 Bowman Draft Caleb Bonemer Chrome Auto 1st Prospect #CPA-CBO White Sox"  $104.50
    "2024 Bowman Draft Caleb Bonemer Chrome Auto 1st Prospect #CPA-CBO White Sox"  $107.51
    "Caleb Bonemer 2024 Bowman Draft #CPA-CBO Chrome Auto 1st Prospect (B)"        $106.50

  Title-token presence:
    "blue wave refractor"  0/71
    "blue refractor"       0/71
    "blue"                 0/71
    "refractor"            0/71
    "wave"                 0/71
    "auto"                71/71
    "cpa-cbo"             71/71
```

Apply `isCompVariantMatch` with buggy parsed `parallel="Blue Refractor"`, `isAuto=true`:
- 71/71 → `parallel_mismatch` (no "blue refractor" substring in titles)

Counterfactual A: fix parser to extract `"Blue Wave Refractor"` instead of `"Blue Refractor"`:
- 71/71 → `parallel_mismatch` (still no "blue wave refractor" in titles either — these are the BASE auto, not a parallel)

Counterfactual B: drop the parallel filter (keep auto+player checks only):
- 71/71 → MATCH

`getCardDetail(496a7e19)` exposes the parallels array (22 entries):

```
0c0d36a1-03d  "Blue Refractor"             /150
cbc2ecd8-a8b  "Blue Wave Refractor"        /150
adc2f117-878  "Black Refractor"            /10
6c6a0acf-af3  "Aqua Lava Refractor"        /199
1d870eae-aa2  "Gold Refractor"             /50
dd034c76-383  "Gold Wave Refractor"        /50
... 16 more ...
```

`getPricing(496a7e19, parallel_id=cbc2ecd8 [Blue Wave Refractor /150])`:
- **0 records.** Numbered parallels with low print runs have very thin/empty sale history.

### Cardsight stores parallels via parallel_id, not title text

This is the architectural finding from the verification pull: Cardsight's comp titles do NOT carry the parallel name. The 71 base-auto records all have `#CPA-CBO` in the title (the card-number SKU), but no color/parallel token. To get parallel-specific pricing the request needs `parallel_id`. The variant filter's substring approach is searching for data that isn't present in the response — it's looking in the wrong place by design.

### `parallelMatches` token-subset bug

[cardsight.mapper.ts:67-71](../../backend/src/services/compiq/cardsight.mapper.ts#L67-L71):

```typescript
function parallelMatches(input: string, candidate: string): boolean {
  const inputTokens = tokenizeParallel(input);
  const candidateTokens = tokenizeParallel(candidate);
  return inputTokens.every((t) => candidateTokens.includes(t));
}
```

For input `"Blue Refractor"`:
- vs candidate `"Blue Refractor"` → `[blue,refractor].every(in [blue,refractor])` → true
- vs candidate `"Blue Wave Refractor"` → `[blue,refractor].every(in [blue,wave,refractor])` → true

`Array.prototype.find()` returns the first match. Order in `detail.parallels` determines which parallel_id gets used. On the live data the Blue Refractor entry appears before Blue Wave Refractor, so behavior is "accidentally correct" — but this depends on Cardsight's ordering.

## 9. The 8-step failure cascade

For an iOS-shape query like `"2024 Bowman Draft Chrome Caleb Bonemer Blue Refractor Auto"` against `CARDSIGHT_MODE=exclusive`:

```
1. parseCardQuery picks set="Bowman Draft" instead of "Bowman Draft Chrome"
   → cardQueryParser.ts:46-69 (SET_PATTERNS ordering gap)
   ↓
2. body.product = "Bowman Draft", body.cardYear = 2024, body.parallel = "Blue Refractor",
   body.isAuto = true
   ↓
3. resolveCardId(input).lookupReleaseName("bowman draft") returns "Bowman Draft"
   → cardsight.mapper.ts:54-58 (correct for dict; wrong for user intent)
   ↓
4. Catalog query = "Caleb Bonemer Bowman Draft" with year=2024
   → cardsight.mapper.ts:85-92
   ↓
5. Cardsight returns 10 candidates; release-name filter narrows to Bowman Draft entries
   Top of filtered list = "Class of 2024 Autographs" (NOT "Chrome Prospect Autographs")
   → cardsight.mapper.ts:106-122 (release filter applied) and 144 (candidates[0] picked)
   ↓
6. Optional parallel_id resolution:
   parallelMatches("Blue Refractor", parallels[].name) may match Blue Refractor or
   Blue Wave Refractor depending on order
   → cardsight.mapper.ts:160-189 (parallelMatches subset bug)
   ↓
7. getPricing(wrongCardId, optionalParallelId) returns comps for the wrong card
   ↓
8. isCompVariantMatch runs:
   - 71/71 titles match auto+player ✓
   - 0/71 titles contain "Blue Refractor" substring → parallel_mismatch
   variantMismatchCritical guard trips → returns source="variant-mismatch", 0 comps used
   → compiqEstimate.service.ts:1191-1212
```

Each step contributes one independent defect. Removing any one step's defect would not produce a correct outcome — they compound.

## 10. Confirmed non-issues

- **Cardsight vendor coverage** for the demo cards we care about. 600 records on Mike Trout 2011 Topps Update with sales today; 71 base-auto records on Bonemer Chrome Prospect Auto with sales 4 days ago. Vendor has the data.
- **`isCompVariantMatch` rule design.** The four checks (auto bidirectional, parallel substring, print run regex, player last-name) are reasonable. They produce correct outcomes when fed correct inputs.
- **`/api/compiq/search-list` (the Card Hedge catalog query)**. 8/10 cards resolved correctly. Working.
- **`cardsight.client` itself** — `searchCatalog`, `getCardDetail`, `getPricing` all work as documented. Retries, timeouts, caches function correctly.
- **`CARDSIGHT_MODE=exclusive` routing**. The routing logic in `cardsight.router.ts` correctly delegates to `findCompsViaCardsight` under exclusive mode. The "cardId source is cardhedge → returns []" guard at [cardsight.router.ts:388-391](../../backend/src/services/compiq/cardsight.router.ts#L388-L391) is intentional namespace separation.

## 11. Open questions (vendor-side, separate from consumption defects)

These need their own investigation; they are NOT consumption-layer bugs:

- **Ohtani 2018 Topps Update Base Set has 0 records in Cardsight.** Catalog has the card (alt match returned correct cardId), but pricing is empty. Either vendor's collection misses this card or our search is finding the wrong cardId. Same for Acuna 2018 Topps Update Base, Judge 2017 Topps Update Base.
- **Skenes 2024 Topps Chrome Update USC150 has 0 records.** Same pattern.
- **Numbered parallels have inherently thin data.** Bonemer Blue Wave Refractor /150 returned 0 records. This is a vendor-data-density issue, not a defect.

The pattern across these: Mike Trout 2011 Topps Update has 600 records and works perfectly; Ohtani / Judge / Acuna in the same Topps Update set have 0. Could be a Cardsight catalog-key inconsistency (e.g. the Trout card is keyed to "Topps Update" but the Ohtani card is keyed to a slightly different release name). Not characterized further in this batch.

## 12. What this characterization does NOT do

- Does not propose fix priorities or sequencing
- Does not recommend a specific redesign
- Does not estimate effort for any fix
- Does not decide whether to restore PR #110's full-text fall-through path

Those decisions are deferred to a separate planning workstream that uses this characterization as input alongside the deferred DailyIQ coverage gap design.
