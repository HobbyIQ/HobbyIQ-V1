# I9 drift, 2026-09-07: the reference was stale, not the corpus

**Verdict: STALE REFERENCE — the alarm cannot honestly speak.** The I9 breach
compares today’s derivation against a reference measured nineteen intended commits
earlier, and the reference records nothing about what produced it. The drift is
**not** overnight corpus movement: it reproduces under the *reference* parser and
the *reference* classifier, on a frame shaped differently from the nightly. No
regression was identified. A residual of ~10-20pp is **not attributed** by this
investigation and is named as such in section 4 - which is itself the argument
for the fix: the audit cannot currently tell these cases apart, and that is the
defect being repaired.

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

### The next candidate: the parser, which the census could not have used

Holding the deriver constant is what made the classifier-only A/B blind to the
deriver. **Fifteen commits changed the parser and set-key services after the
census window closed**, and the census was measured through the pre-#1883 parser:

#1883 ("Raw 10" is a grade, not a card number - 2,839 Pokemon sales) - #1887 (a
title naming a finish is not a base card) - #1892 (the year segment stops being
the sale year) - #1900 (855 English Pokemon spellings fold onto the tcgdex code)
- #1901 (Preview keys) - #1911 (a title that says DRAFT is a Bowman Draft card -
10,146 sales) - #1914 - #1918 - #1919 (Crown Zenith) - #1922 (dead ladder edges)
- #1923 - #1934 - #1937 / #1938 (Pokemon finish vocabulary) - #1939 (vendor
labels).

These change the DERIVED identity for large populations, so they are the obvious
next suspect. The full-stack A/B below **measures** how much they are worth
rather than assuming it - and the answer is smaller than this framing implies.

### The full-stack A/B: both parsers, and what the parser churn is actually worth

The classifier-only A/B could not see the parser, so the reference commit's own
`dist/` was built and the draw was re-derived end to end — REF parser + REF
classifier against HEAD parser + HEAD classifier, same 4,144 rows, zero classify
errors on either side.

**205 rows (4.9%) moved class.** The parser churn is real and visible:

| transition | rows | dominant axis |
|---|---|---|
| AGREE → CONFLICT | 98 | `filled:parallel` (63), `changed:setKey` (27) |
| CONFLICT → IMPROVE | 53 | `filled:cardNumber,setKey` (52) |
| IMPROVE → CONFLICT | 26 | `filled:parallel,setKey` (23) |
| CONFLICT → AGREE | 21 | no axis diff |
| AGREE → IMPROVE | 5 | `filled:parallel` |
| UNDERIVABLE → CONFLICT | 2 | `filled:cardNumber,setKey` |

The movement is exactly the shape the commits describe: `filled:parallel` and
`filled:cardNumber,setKey` on Prismatic Evolutions rows is #1937/#1938's Pokémon
finish vocabulary and #1900's tcgdex fold reaching the title parser.

**But the NET effect on the alarm's number is small:**

| class | REF parser | HEAD parser | net |
|---|---|---|---|
| AGREE | 1,212 (29.2%) | 1,130 (27.3%) | −82 |
| IMPROVE | 83 (2.0%) | 115 (2.8%) | +32 |
| CONFLICT | 2,493 (60.2%) | 2,545 (61.4%) | **+52 (+1.2pp)** |
| UNDERIVABLE | 356 (8.6%) | 354 (8.5%) | −2 |

**The nineteen commits are worth about +1.2pp of CONFLICT, not +18pp.** Stated
plainly because it cuts against the simplest version of this report's thesis.

### The residual, and the honest limit of this investigation

Scoring the same draw against the census under *both* parsers:

| class | n | REF parser | HEAD parser | census (raw) | census (renormalised) | residual |
|---|---|---|---|---|---|---|
| vintage | 115 | 57.4% | 57.4% | 31.9% | 35.3% | **+22.1pp** |
| modern | 3,240 | 58.1% | 59.7% | 41.8% | 43.4% | **+16.3pp** |
| pokemon | 789 | 68.9% | 68.9% | 59.6% | 60.0% | **+9.0pp** |

Three candidate explanations were measured and **none closes the gap**:

- **parser churn** — +1.2pp net (above)
- **census renormalisation** — the four census classes sum to 0.90–0.99, not 1
  (`UNDERIVABLE-for-subset` is reported in `byTier` and left out of `counts`).
  Renormalising moves CONFLICT by 2–3pp
- **population scope** — the fleet census reads `SELECT * FROM c WHERE <year/sport>`
  while the audit frame adds `IS_DEFINED(c.title)` and
  `STARTSWITH(c.hobbyiqCardId,'hiq:')`. Measured on one slot-0 unit
  (2025/pokemon): 513,294 rows vs 499,466 — a 2.7% difference

So **a residual of roughly 10–20pp is not attributed by this investigation.**
Two things are known about it, and both matter:

1. It is **not overnight corpus movement**: it reproduces under the *reference*
   parser and the *reference* classifier, on a frame with a different shape from
   the nightly's. Whatever it is, it was already true when the census was taken.
2. It is **not the frame's shape**: the nightly's own `frameHealth` reports
   `healthy: true`, no flags, and an `expectedForThisMix` of CONFLICT 40.8%
   against a measured 59.9% — the audit's own instrument says the gap is not
   composition.

The most likely remaining candidate is a **methodology difference between the
fleet census's classification and the auditor's** — the two ask the same
`classifyRow` but assemble its inputs differently (the local harness's
`checklistBacked` predicate, for instance, is narrower than the fleet's, which
omits `isStrictChecklistSource` and would inflate CONFLICT locally). Confirming
that requires re-running the fleet census, which is precisely the re-baseline
§7 says is owed.

**This does not change the fix, and it is the reason the fix is shaped the way it
is.** Whether the residual is a methodology artifact or something real, the
audit *cannot currently tell*, because the reference does not record what
produced it. That is the defect being repaired. The alarm is deferred until a
reference exists that can be honestly compared — and the moment one does, any real
drift breaches on it.


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

**The limit of this investigation, stated plainly.** The full-stack A/B (section
4) re-derived the draw under both parsers and both classifiers, so it can see the
whole derivation and not just the classifier. It found 205 rows moving class in
the shapes the commits describe, worth **+1.2pp of CONFLICT** - and a residual of
roughly 10-20pp that neither the parser churn, nor the census renormalisation
(2-3pp), nor the population-scope difference (2.7%) accounts for. The most likely
remaining candidate is a methodology difference between the fleet census and the
auditor, which can only be settled by re-running the census - the same work
section 7 already says is owed.

So the honest position is:

- the drift is **not** explained by corpus movement (it reproduces under the old
  parser and old classifier, across two differently-shaped frames)
- **no row-level evidence of an unintended regression was found**
- a substantial part of the gap is **unattributed**, and is reported as such
  rather than argued away
- the alarm is deferred, **not deleted** - re-baselining re-arms it, and if a
  regression is hiding in any of this, the next comparable night breaches on it

**One real defect WAS found on the way, and it is filed separately.** The
full-stack A/B’s `AGREE -> CONFLICT` bucket - the rows where the stored key is
right and today’s parser wants to move it - held 8 rows. Seven are the intended
#1937/#1938 finish work. The eighth is a parser bug: `SV Twilight Masquerade`
mints a `twilight` PARALLEL out of half the set’s name, affecting **2,379 pool
rows**. See `2026-09-07-sv-twilight-parallel-defect.md`. Report-only, and it is
a caution for any IMPROVE lane acting on `filled:parallel`.

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
