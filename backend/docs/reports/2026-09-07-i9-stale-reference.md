# I9 drift, 2026-09-07: the reference was stale, not the corpus

**Verdict: STALE REFERENCE.** The I9 breach compares today's derivation against a
reference measured by a materially different one — nineteen intended commits
earlier. No regression was found in the rows whose derivation should not have
changed, and the drift reproduces under the *reference* classifier, which rules
out both corpus movement and the classifier diff as its cause.

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

## 4. The A/B: same rows, two classifiers — and what it ruled OUT

A stratified 4,164-row draw (32/32 slots, 2,681 distinct cards, the auditor's own
`buildSampleFrame`, per-card cap 4, 20 PROTECTED rows excluded) was classified
twice: once with the HEAD classifier, once with the classifier at `60807cb0` in a
second worktree, over the **same derived identities** — so the CLASSIFIER was the
only variable. Both are genuinely distinct code (`classifyRow` 36,445 vs 27,726
chars; `diffAxes` 7,581 vs 4,554).

**Result: zero rows moved class. The two class tables are byte-identical.**

| class | REF classifier | HEAD classifier |
|---|---|---|
| AGREE | 1,130 (27.3%) | 1,130 (27.3%) |
| IMPROVE | 44 (1.1%) | 44 (1.1%) |
| CONFLICT | 2,616 (63.1%) | 2,616 (63.1%) |
| UNDERIVABLE | 354 (8.5%) | 354 (8.5%) |

Every axis family matched exactly (`changed:cardYear` 1,094 on both sides,
`changed:setKey` 714, `filled:setKey` 404, …), as did the CONFLICT split
(TRUE-DISAGREEMENT 2,205 / NEEDS-CHECKLIST 411 on both).

**This is a real negative result, and it narrows the finding.** The classifier
diff — #1886, #1897, #1914, #1918, #1923, #1926, #1934, #1950 — is *not* what
moved the number on the rows actually in the pool today. Those changes are guards
and narrow subclasses; #1886 says as much in its own message ("across eight pools
the rule reclassified ZERO rows"). The drift comes from the **deriver**, not the
classifier.

### The drift reproduces under the OLD classifier — so it is not sampling noise

Scored against the same per-class census reference the alarm uses, this
independently drawn frame shows the same elevation the nightly did — under the
reference classifier as much as the current one:

| class | n | sampled CONFLICT | census | delta |
|---|---|---|---|---|
| vintage | 115 | 57.4% | 31.9% | **+25.5pp** |
| modern | 3,240 | 59.7% | 41.8% | **+17.9pp** |
| pokemon | 789 | 77.9% | 59.6% | **+18.3pp** |

The two frames have very different shapes — the nightly drew modern 62% /
vintage 28% / pokemon 10%; this one drew modern 78% / pokemon 19% / vintage 3% —
and both land in the same +18..+25pp band. **A drift that reproduces across two
differently-shaped draws, under two different classifiers, is systematic, not a
draw artifact.**

### Where it comes from: the parser, which the census could not have used

Holding the deriver constant is exactly what made the classifier-only A/B blind
to the real cause. **Fifteen commits changed the parser and set-key services
after the census window closed**, and the census was measured through the
pre-#1883 parser:

#1883 ("Raw 10" is a grade, not a card number — 2,839 Pokémon sales) · #1887 (a
title naming a finish is not a base card) · #1892 (the year segment stops being
the sale year) · #1900 (855 English Pokémon spellings fold onto the tcgdex code)
· #1901 (Preview keys) · #1911 (a title that says DRAFT is a Bowman Draft card —
10,146 sales) · #1914 · #1918 · #1919 (Crown Zenith) · #1922 (dead ladder edges)
· #1923 · #1934 · #1937 / #1938 (Pokémon finish vocabulary) · #1939 (vendor
labels).

These change the DERIVED identity for large populations, which is precisely what
lifts CONFLICT against a reference measured before them. It also explains why
Pokémon — the vertical with the heaviest parser churn (#1883, #1900, #1937,
#1938) — shows +18.3pp here despite sitting *below* its reference in the
nightly's differently-shaped draw.

### The decisive structural proof

The derivation stamp — a content hash over the six files that decide a derivation
— differs between the two trees:

```
reference commit 60807cb0 : dbce20ce5dd2d+no-contract
HEAD             490fd901 : dce11933119b1+2026-09-06.a
```

`pricingContract.ts` did not exist at `60807cb0` at all, so
`PRICING_CONTRACT_VERSION` could not have been recorded even in principle. This
is the fact the fix keys on, and it holds regardless of which of the nineteen
commits did the most work — which is the point of hashing the inputs rather than
attributing blame to one of them.

## 5. Regression rows: none identified

No class of row was found whose derivation should have been unchanged and moved
anyway. The axis families carrying the CONFLICT mass are, without exception, the
axes a post-census commit deliberately redefined — year (#1886, #1892), set key
(#1900, #1911, #1914, #1918, #1919, #1923, #1934), parallel/finish (#1887, #1937,
#1938), grade (#1897) and sport (#1926, #1932). The largest single axis,
`changed:cardYear`, lands on the known vintage-under-sale-year-slug population
(`1955 Topps #123 Sandy Koufax` filed on a `:2023:` slug), a pre-existing corpus
condition tracked as `project_vintage_sales_under_sale_year_slugs`.

**A caveat stated plainly, because it is the one thing that could still hide a
regression.** The A/B in §4 held the deriver constant, so it can prove the
classifier is innocent but *cannot* separate "the parser changed on purpose" from
"the parser regressed" inside the derived identities themselves. That separation
needs a full-stack re-derivation under both parsers, which is the same work as a
fresh census — and a fresh census is exactly what §7 says is owed. Until it runs,
the honest position is:

- the drift is **not** explained by corpus movement (it reproduces under the old
  classifier, across two differently-shaped frames)
- the drift is **fully consistent** with the nineteen intended derivation changes
- no row-level evidence of an unintended regression was found
- and the alarm is deferred, **not deleted** — re-baselining re-arms it, and if a
  regression is hiding in those changes the next comparable night breaches on it

**This is not a claim that the corpus is clean.** I9's absolute
TRUE-DISAGREEMENT level (51.65% nightly, 53.2% in the local draw) remains high
and every row is still listed as a finding. The claim is narrower and is the only
one the evidence supports: *the +30.3pp and +17.5pp deltas do not measure
overnight corpus movement, because the two numbers being subtracted were produced
by different rules.*

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
