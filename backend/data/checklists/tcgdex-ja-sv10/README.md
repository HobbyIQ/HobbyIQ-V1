# tcgdex-ja-sv10 — a single-package scope directory

**This directory is disposable. It exists only to scope one ingest, and may be
deleted once that APPLY has landed.**

## Why it exists

`ingest-checklist-csv-to-catalog.cjs` takes a whole **directory**, not a file
list. The backfill runner wires it as:

```yaml
DIR: ${{ inputs.scope }}
SOURCE: ${{ inputs.sources }}
```

and the script's own selection is `fs.readdirSync(DIR)` plus shard maths —
there is no per-file or glob filter, and the `.ingested` skip-marker is
runner-local scratch that a fresh checkout never has.

So pointing `scope` at the 52-file lane directory `tcgdex-ja-modern/` to land
the **one** new `ja-sv10` product would sweep all 52:

```
would ingest 7,182 rows   <- scope=.../tcgdex-ja-modern   (52 files)
would ingest   132 rows   <- scope=.../tcgdex-ja-sv10     (this directory)
```

That sweep is **not** a harmless re-run. `upsertCatalogEntry` calls
`c.items.upsert(merged)` unconditionally — no equality check, no early return —
and `mergeCatalogEntries` stamps `lastSeenAt: now` on every merge. The ~7,050
unrelated rows would each take a fresh timestamp and a new ETag, which is the
churn that preceded the 2026-09-14 Bush/Mantle incident (re-upserts re-derive
identity; dedup then migrates pools).

## Why a copy and not a move

The package is **also** still in `data/checklists/tcgdex-ja-modern/`, and must
stay there. Both R65 class guards iterate that directory:

- *no staged JA manifest declares a setKey an ENGLISH set owns*
- *the staged FILENAME carries the same ruled key as its manifest*

Moving `ja-sv10` out would drop the lane to 51 files, force the `stages 52
products` pin to be weakened, and remove the very product those guards were
written for from the sweep that protects it.

The cost of a copy is drift, so that is pinned: `tests/jaSv10ScopeDirIsACopy.test.ts`
requires every file here to be **byte-identical** to its `tcgdex-ja-modern/`
counterpart, and re-applies the class rules here directly.

## How it is dispatched

```
script  ingest-checklist-csv-to-catalog
scope   backend/data/checklists/tcgdex-ja-sv10
sources tcgdex-ja-modern
gate    BACKFILL_APPLY=true   (omit for REPORT)
```

Expect **132 rows under `ja-sv10`, 0 under `sv10`** — English `sv10` is
Destined Rivals, a different product (ruling R65 / #1959, #2259).

## Deleting it

After the APPLY lands, delete this directory **and**
`backend/tests/jaSv10ScopeDirIsACopy.test.ts`. That test is written to skip
itself if the directory is already gone, so the order does not matter and the
suite never goes red mid-deletion.
