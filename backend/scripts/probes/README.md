# backend/scripts/probes — one-off measurement tools

**These are not ops surface.** Nothing here is wired to a workflow, a runner
choice list, or a cron. They are READ-ONLY scripts written to measure a
specific question once, kept because the numbers they produced are cited in
commit messages, source comments and test fixtures — and a cited number should
be reproducible.

`backend/scripts/` proper is the sanctioned-runner namespace: scripts there can
be selected by the backfill runner and can write. Probes live down here so the
two are never confused.

## Rules

- **Read-only.** A probe never writes. If a measurement implies a repair, the
  repair is a separate, scoped, refusing script in `backend/scripts/`.
- **Cite the run.** A probe that produced a number quoted elsewhere should say
  in its header what it measured, over what population, and when.
- **Deps resolve two levels up** (`__dirname, "..", ".."` for `dist/…`), since
  these sit one directory deeper than `backend/scripts/`.

## Current probes (TCA grade extraction, 2026-08-31)

| Probe | Measured |
|---|---|
| `probe-tca-grade-gap.cjs` | rows stored raw whose title states a grade — 47 of 2,269,714 (0.002%) |
| `probe-tca-grade-shape.cjs` | title-vs-stored agreement across graded tca-ebay rows |
| `probe-tca-grade-history.cjs` | when the price-inferred rows were written |
| `probe-tca-grade-readback.cjs` | post-repair verification read |
| `probe-tca-inferred-grades.cjs` | the price-inferred population and its live titles — source of the test fixtures in `backend/tests/tcaGradeIsStatedNeverInferred.test.ts` |
| `probe-multi-grader-titles.cjs` | titles naming two graders; the cohort behind CF-THE-GRADER-WITH-THE-NUMBER-WINS |
