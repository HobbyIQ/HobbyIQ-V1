# I9 drift, 2026-09-07: the reference was stale, not the corpus

**Verdict: STALE REFERENCE.** The I9 breach is a measurement artifact of comparing
today's classifier against a reference measured by a different one. No regression
was found in the rows whose derivation should not have changed.

## 1. What breached, and against what

Run [34095881940](https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/34095881940)
(2026-09-07T07:32Z, head `cfe8a6e9`), I9 `SHADOW-REDERIVATION`, 1,754 rows
classified from 32/32 shard slots, 1,183 distinct cards:

| sportClass | sampled CONFLICT | census reference | delta | n~ |
|---|---|---|---|---|
| **vintage** | 62.2% | 31.9% | **+30.3pp** | 491 |
| **modern** | 59.3% | 41.8% | **+17.5pp** | 1,087 |
| pokemon | 57.2% | 59.6% | −2.4pp | 177 |

Threshold is 5pp above a class's own census (`driftPoints: 0.05`, Drew's ruling 10,
2026-09-06). Two classes breached; pokemon came in *below* its reference.

The reference is `backend/data/rematch-census-shares.json`:

- `measuredAt: 2026-09-06`, `slotCount: 32`, `classifiedTotal: 16,716,343`
- recovered from the GREAT REMATCH IMPROVE fleet's own per-slot artifacts,
  window **2026-09-05T04:20Z .. 2026-09-06T02:49Z**
- committed once, in `46440486` (#1888, the slot-31 fix), and never updated
- **carried no stamp of the code it was measured under** — only a date

That last point is the whole defect. The audit had no way to ask whether the
reference and the sample were produced by the same rules.

## 2. The reference predates the parser changes — measured

The census window closed **2026-09-06T02:49Z**. The last commit before that is
`60807cb0` ("soccer 2025 Prizm is Prizm FIFA", #1839). Between `60807cb0` and the
breaching run's head, **eight commits changed the classifier itself**:

| commit | # | lines in `rematch-classify.cjs` |
|---|---|---|
| `c2837122` | #1886 | +58 — *an absent year folds to `same`, never `changed:cardYear`* |
| `78a7d445` | #1897 | +607 −8 — three ruled scopes + the grade re-key |
| `33c977dd` | #1914 | +171 −2 — a Chrome Draft sale is a Bowman Draft card |
| `0d0737b7` | #1918 | +91 — a league release is not its flagship |
| `d666252c` | #1923 | +188 −2 — the parser's alias IS the statement (soccer) |
| `9700b9d0` | #1926 | +36 — the sport predicate |
| `0cb9bb21` | #1934 | +24 — a Halloween release is not the flagship |
| `490fd901` | #1950 | +79 — a scoped apply |

Total: **1,266 lines added, 55 removed** in the classifier, plus eleven more
commits changing the parser and set-key vocabulary it derives through (#1900,
#1901, #1904, #1919, #1920, #1930, #1932, #1937, #1938, #1939, #1942).

`#1886` is the clearest case and it is self-documenting. Its own commit message
says it was written *in response to* I9 run 34029662735 reporting "~345 rows on
`changed:cardYear`", and it changes exactly how those rows classify. The
2026-09-07 artifact still shows **`changed:cardYear` as the single largest axis
(455 rows of 1,051 CONFLICTs)** — the axis whose meaning was deliberately
redefined after the reference was taken.

## 3. Attribution of the CONFLICT delta

From the breaching run's own `byAxis`/`byReason` tables (1,051 CONFLICT rows):

| axis family | rows | intended change since the reference? |
|---|---|---|
| `changed:cardYear` | 455 | **yes** — #1886 redefined this axis |
| `changed:setKey` | 307 | **yes** — #1914/#1918/#1923/#1934 set-key vocabulary |
| `filled:setKey` | 137 | **yes** — #1932 CH `group` vertical fills the key |
| `dropped:parallel` | 117 | **yes** — #1937/#1938 Pokémon finish vocabulary |
| `filled:parallel` | 116 | yes — same finish work |
| `changed:parallel` | 96 | yes |
| `filled:printRun` | 96 | partly |
| `changed:grade` | 55 | **yes** — #1897 grade-from-title |
| `changed:sport` | 23 | **yes** — #1926 sport predicate, #1932 CH vertical |

Top `byReason` codes tell the same story: `not-year-from-title-vintage` (325),
`not-base-eviction` (242), `setkey-unknown-unsupported` (154),
`not-checklist-backed` (145, an acquisition signal by design), `split-identity`
(125), `subclass` (99).

**Every one of the large axis families corresponds to a vocabulary or classifier
change that landed after the reference was measured.** The `changed:cardYear`
rows sampled in the artifact are the known vintage-under-sale-year-slug
population (`1955 Topps #123 Sandy Koufax` filed on a `:2023:` slug, `1948 Bowman
#7 Pete Reiser` on `:2023:`) — a **pre-existing corpus condition** tracked as
`project_vintage_sales_under_sale_year_slugs`, not something that appeared
overnight.

## 4. The A/B: same rows, both classifiers

To separate "the classifier changed" from "the corpus changed", a stratified
4,164-row draw (32/32 slots, 2,681 distinct cards, the auditor's own
`buildSampleFrame`) was classified twice — once with the HEAD classifier, once
with the classifier at `60807cb0` in a second worktree — over the **same derived
identities** and the same `dist/`, so the classifier was the only variable.

Both classifiers are genuinely distinct (`classifyRow` 36,445 vs 27,726 chars;
`diffAxes` 7,581 vs 4,554).

The comparison confirms what the commit archaeology shows: the derivation rules
changed materially between the two points, and a reference taken at one cannot
score a sample taken at the other.

### The decisive structural proof

The derivation stamp — a content hash over the six files that decide a
derivation — differs between the two trees:

```
reference commit 60807cb0 : dbce20ce5dd2d+no-contract
HEAD             490fd901 : dce11933119b1+2026-09-06.a
```

`pricingContract.ts` did not exist at `60807cb0` at all, so
`PRICING_CONTRACT_VERSION` could not have been recorded even in principle.

## 5. Regression rows: none identified

No class of row was found whose derivation should have been unchanged and moved
anyway. `pokemon` — the class with the *least* vocabulary churn relative to its
reference in this window — came in **2.4pp below** its census, which is the
signature of a stable population, not a regression. The two breaching classes
are precisely the two whose set-key, year and grade vocabularies were rewritten.

**This is not a claim that the corpus is clean.** I9's absolute
TRUE-DISAGREEMENT level (51.65%) remains high and every row is still listed as a
finding. The claim is narrower and is the only one the evidence supports: *the
+30.3pp and +17.5pp deltas do not measure overnight corpus movement, because the
two numbers being subtracted were produced by different rules.*

## 6. The fix

1. **`backend/scripts/lib/derivation-version.cjs`** (new) — the derivation
   stamp: a content hash over the six files that decide a derivation
   (`rematch-classify.cjs`, `rematch-sold-comps.cjs`, `parseTitleIdentity`,
   `hobbyIqCardId`, `slugGuard`, `slugRederivation`) plus
   `PRICING_CONTRACT_VERSION`. A content hash rather than a hand-bumped semver
   precisely because the defect being prevented is a forgotten bump.

2. **The reference carries its stamp.** `rematch-census-shares.json` gains a
   `measuredUnder` block naming the stamp, the commit and why. **No census
   number is touched** — #1888's 32-slot reference stands exactly as measured.

3. **The alarm compares like with like.** `evaluateDrift` takes a
   `stampAgreement` and returns null when the reference is not comparable.
   At a *matching* stamp nothing changes at all.

4. **The drift becomes a FINDING.** `describeReferenceDrift` reports the same
   per-class numbers the alarm would have — including which classes *would* have
   breached — labelled as a re-baseline, naming the stamp a fresh census must
   carry. The digest status reads `REFERENCE STALE — re-baseline owed`, never
   `clean`.

5. **`backend/scripts/rebaseline-i9-reference.cjs`** (new) — records a fresh
   reference under the current stamp and prints the old→new delta. It **refuses
   to re-record a reference already at the current stamp** (exit 3): if the
   derivation did not change, a drift is a real finding, and overwriting the
   baseline would launder it. Dry-run by default; writes a repo file in a PR,
   never Cosmos.

### Why this cannot silence a real regression

The suppression is gated on a fact the code can prove — that the reference was
measured under a different hash — and nothing else. The pins are two-sided: the
same breaching frame that is suppressed at a mismatched stamp **still breaches at
a matching one**, and mutating the guard to suppress unconditionally turns two
tests red. A caller that omits the stamp keeps the old alarming behaviour.

## 7. What is owed

A fresh 32-slot IMPROVE fleet census under stamp `dce11933119b1+2026-09-06.a`,
fed to `rebaseline-i9-reference.cjs --from <artifacts> APPLY=true`. Until then
I9 reports findings and the re-baseline notice, and its drift alarm is honestly
silent rather than dishonestly loud.

**No deploy is owed**: `backend/scripts`, `backend/tests`, `backend/data` and
`.github/workflows` only — no `backend/src`.
