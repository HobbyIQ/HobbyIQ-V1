# `panini-score` → `score`: the ingest fix and its repair

**Status:** ingest fix merged; **repair is report-first and NOT yet applied.**
**Opened by:** open question #3 of `alias-reslug-2026-09-05.md`.
**Ruling it enforces:** `ERA_SPLIT_TABLE` (`setKeyReconciliation.ts`) — Score takes the
**bare** key in every year (`makerKey: null`, "no synthetic products").

---

## 1. The cause

`ERA_SPLIT_TABLE` **had no code consumer.** It was evidence for a boundary, read only by
`build-reconciliation.cjs`, while the actual spelling decision lived in `spellForEra`
(`productSetKeys.ts`) — which knew about Donruss and Fleer-Tiffany **and nothing else**.
A ruling with no call site is a comment.

So nothing stopped the vocabulary from minting the key the table forbids. In
`normalizeSetKey`, the strict Panini tier runs first:

```
[/panini-score/, "panini-score"]     <- line 657, strict tier
...
[/(?:^|-)score/, "score"]            <- line 830, bare tier
```

and `spellForEra` passed `panini-score` straight through. The checklist lane then fed it
that exact text:

```
hobbymonitor page title   "2025 Panini Score Football"
  -> setKeyFor()          slugify, strip year + sport suffix  -> "panini-score"
  -> manifest --set-key   "panini-score"
  -> ingest-scraped-checklist: setKey = manifest.setKey, authoritativeSetKey: true
  -> deriveCatalogEntry -> computeHobbyIqCardId -> resolveSetKeyForSlug -> spellForEra
                                                                          (no-op)
  -> hiq:football:2025:panini-score:...
```

**`authoritativeSetKey` was NOT the bug.** It suppresses only the chrome-prefix repair; the
era seam was always on the path. The checklist row and the sale ran the same deriver — the
deriver simply did not carry the ruling. So this is one deriver gaining a rule, **not** a
second vocabulary.

`setKeyFor` in the driver slugifies a display name with no vocabulary at all, which is why
the maker prefix survived to the manifest. Correcting it in `spellForEra` fixes the sale
path and the checklist path together, which is the point.

## 2. What is on the wrong key (measured on prod, 2026-09-05)

| | rows |
|---|---:|
| `card_catalog` `panini-score` | **3,702** |
| — `hobbymonitor-2026-09-04` (STRICT checklist) | 3,300 |
| — `ingest-auto-seed-graded` | 399 |
| — `ingest-auto-seed` / `-graded-graded` | 3 |
| `card_catalog` `score` | 58,985 |
| — of which 2025 football | 19,418 (19,395 `checklistinsider-2026-08-27`) |
| `sold_comps` on a `:panini-score:` slug | **35,193** |

`panini-score` is football-only in substance (3,700 of 3,702; 1 hockey, 1 soccer) and
2025-heavy (3,343). Years present: 2010–2025.

**Other era-split keys — `panini-score` is the only one defective:**

| maker key | rows | bare key | rows | verdict |
|---|---:|---|---:|---|
| `panini-score` | **3,702** | `score` | 58,985 | **DEFECTIVE** |
| `panini-leaf` | 0 | `leaf` | 41,365 | clean |
| `panini-fleer` | 0 | `fleer` | 118,756 | clean |
| `panini-skybox` | 0 | `skybox` | 6,564 | clean |
| `panini-donruss` | 292,792 | `donruss` | 116,723 | **not a defect** — the one real two-owner split (`makerKey: panini-donruss`), spelled by the 2009 boundary |

The three clean ones are pinned by the fix anyway, so the next source that writes one is
corrected at mint instead of found in a census months later — which is how this was found.

## 3. THE COMPLICATION — read before dispatching anything

The `panini-score` rows carry a **second, independent defect: the card numbers are wrong.**

2,811 of 3,702 rows have a twin at the identical slug on `score`, and **2,571 of those name
a DIFFERENT PLAYER.** Verified against the published checklist
(checklistcenter.com/2025-score-nfl-football-card-checklist, and Beckett):

| player | hobbymonitor | checklistinsider | published truth |
|---|---:|---:|---:|
| Drake London | 4 | 17 | **17** |
| Trey McBride | 17 | 5 | **5** |
| Keon Coleman | 4 | 4 | **4** |
| Greg Rousseau | 239 | 239 | **239** |
| T.J. Hockenson | 101 | 101 | **101** |
| Jalon Walker | 30 | 30 | **30** |

Where both sources name the same player, they **disagree on the number 343 times against
376 agreements** — roughly half. checklistinsider is right every time it was checked;
hobbymonitor is right only sometimes. The hobbymonitor lane also emits **two different
players at the same (number, parallel, isAuto)** on 32 keys, which is internally
inconsistent regardless of the other source.

**So these rows must NOT be moved onto `score` wholesale.** A move carries a wrong player
onto a correct checklist identity.

### Simulated outcome of a naive `MODE=catalog` sweep

Running `chooseSurvivor`'s rules against the live rows:

| outcome | rows | safe? |
|---|---:|---|
| FOLD (incumbent `score` row wins, hobbymonitor row discarded) | 2,807 | **yes** — the correct row keeps the address |
| REPLACE (hobbymonitor row wins) | 4 | **yes** — all 4 are the *same player*, checked individually |
| MOVE (no twin; the row lands on a fresh `score` slug) | 891 | **NO** — 310 of the 500 hobbymonitor movers name a player `score` already holds at a *different* number, so the move mints a duplicate identity for a card that already exists |

The fold majority is safe and self-correcting. **The 891 movers are the hazard**, and they
are the reason this repair is staged rather than dispatched.

## 4. Repair plan

**Report first, every lane. No APPLY in this PR.** Ordered.

### Lane A — the pool (SAFE, do this one first)

35,193 `sold_comps` rows. These are **real sales whose own titles say "Panini Score"**
("2025 Panini Score Football #18 Base") — correctly identified cards sitting on the wrong
*spelling*. Segment surgery only; the number, parallel, auto flag and print run are carried
across byte for byte. No identity is recomputed, so the checklist disagreement above cannot
reach these rows.

`panini-score`→`score` is an **ERA SPLIT, not a ruled alias** — it belongs in
`ERA_SPLIT_TABLE` (where it already is), **not** in `RULED_ALIASES`. So
`reslug-ruled-alias.cjs` is the *wrong lane*: it reads `ruledAliases()` and would refuse
this pair, correctly. Declaring a flat alias to satisfy it would put a second, weaker copy
of an era ruling in the alias table — exactly the "never a second vocabulary" failure this
PR fixes. **`rekey-product-setkey.cjs MODE=pool` needs no alias declaration** (it takes
SPORT / SETKEY / TO_SETKEY directly) and is the right lane. No lane change is required.

`MODE=pool` requires a year axis, and football is the only sport with substance, so run
football with the year list:

```bash
# REPORT (dispatch this first, read the log)
gh workflow run backfill-runner.yml --ref main \
  -f script=rekey-product-setkey \
  -f apply=false \
  -f mode=pool \
  -f sports=football \
  -f setkey_like=panini-score \
  -f titles=score \
  -f years=2010,2011,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025
```

`titles` is the runner input that carries `TO_SETKEY` (the workflow maps
`BCP_TITLES: inputs.titles`, and the script reads `TO_SETKEY || BCP_TITLES`);
`setkey_like` carries the FROM key. Both are existing inputs — no workflow change.

APPLY is the identical command with `-f apply=true`, **after** the report is read.

### Lane B — the catalog (STAGED, needs the numbering question settled)

Do **not** dispatch the catalog lane as a plain move. Report it first:

```bash
# REPORT ONLY
gh workflow run backfill-runner.yml --ref main \
  -f script=rekey-product-setkey \
  -f apply=false \
  -f mode=catalog \
  -f sports=football \
  -f setkey_like=panini-score \
  -f titles=score
```

Read `MOVED / FOLDED / REPLACED` in the log and confirm they match the simulation in §3
(≈891 / ≈2,807 / ≈4). Then, for the three groups:

- **the 2,807 folds** — safe to apply as-is. The correct checklistinsider row keeps its
  address and the hobbymonitor row is discarded.
- **the 4 replaces** — same player on both sides; harmless.
- **the 891 movers** — **DREW RULED 2026-09-05: RETIRE.** They are never moved onto
  `score`. Each is labelled in place with `identityUnverified` plus
  `retiredReason: 'source-unreliable:hobbymonitor-2025-score'`, and its graded children
  follow. `score` is left to the checklistinsider rows.

  The lane is `rekey-product-setkey MODE=catalog` with `RETIRE_UNTWINNED=true`, added in
  the PR that carries this ruling. It diverts **only** the MOVE branch, **only** for a row
  whose source the dispatch named — so a checklistinsider row scanned by the same run
  moves normally. A label, never a delete: `sold_comps` rows reference these ids and a
  delete would orphan real sales with no way back (`retire-self-derived-identities`'s
  reasoning verbatim), and the write goes through `patchCatalogRowFields` rather than a
  raw patch (#1614 left rows unfindable that way).

  ```bash
  # REPORT (dispatch first, read MOVED / FOLDED / REPLACED / RETIRED in the log)
  gh workflow run backfill-runner.yml --ref main \
    -f script=rekey-product-setkey \
    -f apply=false \
    -f mode=catalog \
    -f sports=football \
    -f setkey_like=panini-score \
    -f titles=score \
    -f sources=hobbymonitor \
    -f scope=source-unreliable:hobbymonitor-2025-score
  ```

  `RETIRE_UNTWINNED=true` is exported by the runner for this script; `sources` carries the
  distrusted source list and `scope` the reason. Both are existing inputs (24 of GitHub's
  25 are used) — no workflow change. Expect `MOVED 0`, `FOLDED ≈2,807`, `REPLACED ≈4`,
  `RETIRED ≈891`. **APPLY is the identical command with `-f apply=true`, after the report
  is read**; a `MOVED` that is not 0 means the diversion did not bind and the run must not
  be applied.

### Lane C — the 399 `ingest-auto-seed-graded` rows

Graded children. `moveCatalogRow` retires rather than moves them (they are regenerable
from their parents by `materialize-graded-identities`). They ride along with Lane B; no
separate dispatch.

### Deploy

`backend/src` changed, so after merge the **"Daily 5AM ET Refresh & Deploy"** workflow must
be dispatched — merging alone does not deploy. Verify with `curl /api/health` and check
`build.shaShort`.

## 5. Verifying

Read-only. Both counts should move together and in opposite directions:

```
SELECT VALUE COUNT(1) FROM c WHERE c.setKey = 'panini-score'                    -- 3,702 -> 0
SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(c.hobbyiqCardId, ':panini-score:')  -- 35,193 -> 0
```

A green workflow is not a data flow — verify the write by reading the count, not by the run
being green.
