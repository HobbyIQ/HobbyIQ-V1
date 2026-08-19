# Slug integrity backlog

Opened 2026-08-19, from the session that started with a user's mis-priced
1997 Skybox Metal Universe Chipper Jones #31 and became a slug-integrity pass
over the whole comp pool. Merged as #1142 (`75802d4`), deployed and verified.

Everything here is **measured**, not estimated. Numbers are as of 2026-08-19 and
the query that produced each is named, so nothing needs re-deriving from scratch.

---

## Done — applied and verified

| repair | rows | verification |
|---|---|---|
| 2026 CPA- setKey split | 6,180 | gold tier reachable again: $51 /75, $76 /50, $725 /15 |
| card-number hyphen (`bcp109` → `bcp-109`) | 21,753 | `bcp25` → 0, all 570 on `bcp-25` |
| sport leaks | 48,536 | **0** Shannon Sharpe rows left on the baseball #31 slug |
| setKey punctuation (catalog) | 87,884 | 745 spellings; 76 naming questions deliberately held back |

All reversible: `hobbyiqCardIdBefore`, `sportBefore`, `setKeyBefore`,
`reslugReason`.

Shipped in `backend/src`: the `Non Auto` parser fix (`AUTO_NEGATIVE_RE`) and the
`compiq.routes.ts` display-name-as-setKey leak. Live on `75802d4`.

---

## 1. Conformance apply — STOPPED, needs a dry run at the widened scope

`audit-checklist-conformance.cjs --apply`

Bowman scope was dry-run and is trustworthy:

```
comps judged  1,516,913
CONFORMANT      983,091   64.8%
MOVE            176,869   11.7%   <- provable, safe to write
AMBIGUOUS       160,781   10.6%   <- never written
ORPHAN          196,031   12.9%   <- never written
```

Top proven moves:

```
70,619  bowman-chrome -> bowman        e.g. 2026 #bp-102 Eric Hartman
33,728  bowman -> bowmans-best         e.g. 2025 #bs-12 Shohei Ohtani
25,839  bowman-chrome -> bowman-draft
23,249  bowman-paper -> bowman         (bowman-paper is not a product key)
 7,425  bowman-draft -> bowman-draft-picks-and-prospects
```

**Why it is stopped.** The `--family` default was edited to "all" while the job
sat queued. Node reads the file at process start, so step 2 launched against
EVERY baseball family rather than the Bowman scope that had been dry-run.
Stopped in the index phase with **0 rows written**.

**Next:** dry-run `--sport=baseball` with no family, confirm the number, then
apply. Two rules that came out of this — never apply at a scope that was not
dry-run, and do not edit a script that a queued job will later load.

## 2. The other five sports

Conformance and the hyphen repair now scope by SPORT rather than family, because
`topps` alone is 22,047,574 catalog rows against bowman's 3,415,852, across 3,451
distinct families.

```
baseball    6,831,646 comps    (bowman done; rest of the sport pending)
pokemon     2,427,233
football    2,287,136
basketball  1,979,377
hockey        222,009
soccer         70,259
```

## 3. audit-title-contradicts-slug — built, never executed

Committed but has never touched real data. Finds comps whose own listing title
states a serial, auto status or parallel that contradicts their slug. Known to
exist: 12 wrong-serial comps and 1 `Non Auto` in a single Walker Jenkins pool,
which is what made a user's /499 refractor auto price wrongly. Scale unknown.

Built on `parseListingIdentity` deliberately — a hand-rolled colour matcher
during this work scored "Red Sox", "Redemption" and "Stickered" as RED, and
"Choice" as ICE, then reported 6.3% of a pool as recoverable when the true
figure was near zero.

## 4. ORPHAN → checklist acquisition, and a dead source

196,031 Bowman comps sit under a number no checklist covers. **That is an
acquisition list, not a defect list** — and it will not shrink on its own:

> Cardboard Connection went DNS-dead on 2026-08-17 and was the ONLY checklist
> source wired into gap-fill, so acquisition has been silently doing nothing.

Fixing that source (or replacing it) is upstream of every ORPHAN number here.

## 5. Held back on purpose — need a human or a checklist

- **76 word-boundary setKey pairs.** `turbo-charged` vs `turbocharged`,
  `light-speed` vs `lightspeed`, `topps-town` vs `toppstown`,
  `breakout-autographs` vs `break-out-autographs`. Both spellings are valid
  slugs, so this is a naming question. A script must not settle it by vote.
- **160,781 AMBIGUOUS comps** — several setKeys legitimately list the number.
- **`bowman-chrome` vs `bowman-draft`** and the Sapphire / Mega Box clusters:
  candidates from `audit-multihome-slugs`, unconfirmed. Ohtani #17 exists in
  bowman, bowman-chrome, mega-box AND sapphire as four REAL cards — merging on
  shared player+number would flatten a $500 Sapphire into a $5 paper base.

## 6. Smaller measured defects

- **`isAuto`**: 838 Bowman comps titled AUTO slugged `:no-auto`; 155 titled
  NON-AUTO slugged `:auto`. The root parser bug is fixed and deployed, so these
  are history; container-wide count not yet measured.
- **507** Bowman comps with the literal string `null` in the cardNumber segment.
- **`mma` from a card-number suffix**: `88BA-MMA` → sport `mma` for Manny
  Machado. The sport sweep corrected the rows; the parser path was not chased.
- **Walker Jenkins residue**: 12 wrong-serial comps + 1 Non-Auto still in the
  CPA-WJ pool.

## 7. Colour recovery — text is exhausted

The 253 plain-refractor CPA-MG comps run $1.25 to $725 and are ALL raw, so grade
is not the driver. The $725, the $255 and the $1.25 sales carry the IDENTICAL
title `"2026 2026 Bowman Baseball #CPA-MG Base"`. The parallel is absent at the
SOURCE, which is why re-running the parser over 20,000 such rows improved 6.

So the only remaining path is the image. `cardColourHue.service.ts` exists but is
deliberately NOT committed to `src`: measured on real eBay photos it returns 1%
saturated border, because the card does not fill the frame. It needs card-edge
detection before it is worth anything.

## 8. Ops / unresolved

- **Page timeout** — a card page reported "Request timed out after 30s". Two
  theories disproven; API measures healthy (0.2–0.36s). Needs a tester repro
  with the network tab.
- **Chronic CI reds** — `observedGradeCurve` ×2 (trend-cap assertion),
  `signalFetchObservability` timeout, `compiqRoutePredictionShape`. Verified
  2026-08-19 as pre-existing: reverting the parser to `origin/main` reproduces
  them exactly, and none of the three files reference the parser.
- **`backfill-parallel-enrichment` must not be run broadly.** Its dry run showed
  it rewriting the WHOLE slug via `computeHobbyIqCardId`, pushing
  `bowman:cpa-eha` back to `bowman-chrome:cpa-eha` — it would re-split the pool
  this work merged.

---

## The pattern worth keeping

Six times in one session the mechanism was right and the DIRECTION or SCOPE was
wrong. Every one was caught by checking against an independent authority before
writing, and several were caught only because the target side was measured
first.

- Blanket hyphenation would have corrupted `BDPP` — 61,756 checklist rows, never
  hyphenated. `bdpp19` is correct as it stands.
- "Same player = safe to merge" would have flattened a $500 Sapphire.
- Majority-wins on setKey elected `x's-and-o's`, `all-out!` and `bbm-` as
  canonical, entrenching punctuation into slugs.
- An exact source allowlist reported 6.1% checklist coverage when the truth is
  **87.8%** — it discarded baseballcardpedia's 918,828 rows.
- Widening that same allowlist for the HYPHEN question flipped 51 prefixes to
  blocked on wiki-transcription noise. **Source quality is question-dependent:**
  coverage and precision need different source sets.
- Requiring literal unanimity then blocked BCP on 6 bare rows out of 81,291.
  Real conventions are nowhere near that line — `BDPP` is 100% bare.

And twice the defect was one I introduced while fixing the others: a second copy
of `slugify()` inside the repair script, and a cluster key that silently
swallowed word-boundary variants.
