#!/usr/bin/env node
/**
 * audit-pricing-invariants-corpus.cjs — the nightly CORPUS auditor.
 *
 * CF-FINDINGS-ARE-DATA-NEVER-FIXES (Drew, 2026-09-02: "nightly shadow
 * re-derivation + invariant asserts + mutation-CI replaces eyeball discovery;
 * findings are data, never auto-fixes").
 *
 * WHAT 2026-09-05 COST. Five defects found that day, each by a person noticing
 * a number, each of them an assertion a read-only job could have made the night
 * before:
 *
 *   the deploy smoke had been red since 09-03 and the nightly all-users reprice
 *     silently SKIPPED for two days — a skipped job is quiet         -> I7
 *   a Gold Shimmer sale sat in a Gold Refractor pool                 -> I6
 *   12 rekeyed sales were duplicated at two addresses                -> I5
 *   19,867 catalog rows had a setKey field disagreeing with the stem -> I3
 *   holdings carried a published stamp and a withheld block at once  -> I1
 *
 * THIS LANE NEVER WRITES. Not "writes only under APPLY" — there is NO write
 * path in this file or in lib/corpus-invariants.cjs: not one of the five Cosmos
 * mutation calls appears anywhere in either. That is a stronger claim than a
 * guarded branch, and it is the claim the mutation check makes — a recording
 * fake Cosmos container asserts ZERO write calls of any kind after a full run,
 * and the workflow gate refuses `apply=true` outright the way the read-only
 * CH-label census does. An auditor that could write is an auditor that could
 * "fix" a finding, and a finding it fixed is a finding nobody read.
 *
 * (The five call names are deliberately NOT spelled out here. The governance
 * net in tests/everyWriteJobReconciles.test.ts matches WRITE_CALL against raw
 * source WITHOUT stripping comments — its own documented false positive #1 —
 * so a comment naming them would enrol this read-only lane in the cron-writer
 * registry and demand a reconciliation banner for writes it never makes. The
 * pin in tests/corpusInvariantAuditor.test.ts asserts the absence properly,
 * against comment-stripped source.)
 *
 * WHY IT IS SEPARATE FROM audit-pricing-invariants.cjs. That job is the SHADOW
 * PRICER: one holding, one pool, is the NUMBER defensible. This one asks
 * whether the CORPUS is internally consistent — a different subject, sampled at
 * a different granularity, over populations whose costs differ by three orders
 * of magnitude. Merging them would force one budget and one digest onto ten
 * checks that need ten. The shadow keeps its nightly slot; this runs beside it.
 *
 * OUTPUT SINK. NO Cosmos container is created — that is prod config, and a
 * read-only auditor must not ask for one. Findings go to (1) the run log,
 * (2) a JSON artifact, (3) the runner's step summary, and (4) a GitHub issue
 * opened from the workflow with the existing GH_TOKEN when any invariant
 * breaches its threshold. A grep of backend/src for an existing audit/report
 * container found none: `sold_comps`, `ch_daily_sales`, `portfolio`,
 * `card_catalog`, `verify_queue` and the insights containers are all
 * domain-owned. So the sink is an artifact plus an issue, and the day a report
 * container legitimately exists this job gains four lines.
 *
 * EXIT CODE. Always 0 on findings, whatever they are — a red X here means the
 * AUDITOR broke, never that the corpus has a defect. A breach prints a
 * `::warning`; nothing turns anything red. Nonzero exits are reserved for
 * machinery: 2 = no connection string / refused apply, 3 = an unhandled throw.
 *
 * BUDGET. lib/runner-budget.cjs, the same three constants every budgeted lane
 * declares, sized for the 45-minute workflow ceiling with margin. Each
 * invariant is a UNIT and the pre-check runs BEFORE it, never at the loop top:
 * an invariant that cannot finish inside the reserve does not start, and says
 * so, rather than being killed mid-query and reporting nothing at all
 * (feedback_a_killed_job_cannot_report_progress).
 *
 * SHARDING is OPT-IN via lib/runner-shard-scope.cjs. An inherited `slot=0
 * slots=16` sweeps EVERYTHING; only a non-zero slot or an explicit SHARD=true
 * fans out. A nightly audit that silently sampled 1/16 of its intended sample
 * would report a sixteenth of the corpus's breaches and reconcile honestly
 * while doing it.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required (read-only use)
 *   COSMOS_DATABASE           default "hobbyiq"
 *   INVARIANTS                comma list of ids to run (default: all)
 *   SAMPLE_SCALE              multiply every default sample size (default 1)
 *   DEPLOY_HEALTH_JSON        path to the `gh api` payload for I7 (workflow
 *                             writes it; absent = I7 reports "not supplied")
 *   OUT_JSON                  findings artifact path (default audit-findings.json)
 *   MAX_ROWS_PER_FINDING      row-level ids listed per invariant (default 25)
 *   APPLY / BACKFILL_APPLY    REFUSED. This lane has no write path; a dispatch
 *                             that sets one is a dispatch whose author believed
 *                             it would change something.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const INV = require(path.join(__dirname, "lib", "corpus-invariants.cjs"));
const { budget } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const CLASSIFY = require(path.join(__dirname, "lib", "rematch-classify.cjs"));

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const SAMPLE_SCALE = Math.max(0, Number(process.env.SAMPLE_SCALE ?? 1) || 1);
const OUT_JSON = process.env.OUT_JSON || path.join(__dirname, "..", "audit-findings.json");
const MAX_ROWS_PER_FINDING = Number(process.env.MAX_ROWS_PER_FINDING ?? 25);
const DEPLOY_HEALTH_JSON = process.env.DEPLOY_HEALTH_JSON || "";

const WANTED = String(process.env.INVARIANTS || "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const wants = (id) => WANTED.length === 0 || WANTED.includes(id);

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(2)}%` : "n/a");

// ── THE APPLY REFUSAL ───────────────────────────────────────────────────────
// The workflow gate refuses `apply=true` before this file runs, exactly as the
// read-only CH-label census's gate does. This is the SECOND line of the same
// refusal, here rather than only in YAML, because a lane invoked by hand or by
// a future workflow must refuse on its own account: a gate that lives only in
// the caller is a gate the next caller does not have.
const AFFIRMATIVE = /^(1|true|yes|on)$/i;
function refuseApply() {
  const set = ["APPLY", "BACKFILL_APPLY", "RESLUG_APPLY", "APPROVE_APPLY"]
    .filter((k) => AFFIRMATIVE.test(String(process.env[k] ?? "").trim()));
  if (!set.length) return;
  console.error(
    `::error::audit-pricing-invariants-corpus is READ ONLY — it has no write path, and `
    + `${set.join(", ")} is set. Re-dispatch with apply=false. Findings are DATA: the repair for `
    + `any finding here is a separate audited lane that names the rows it moves.`,
  );
  process.exit(2);
}

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 15000);
    }
  }
};

/** One invariant's accumulated result. Row-level ALWAYS: a count with no ids
 *  is a number nobody can act on (feedback_never_dismiss_small_numbers_as_noise
 *  — a targeted list, not an aggregate explanation). */
function makeResult(id) {
  const inv = INV.INVARIANT_BY_ID.get(id);
  return {
    id, name: inv.name, subject: inv.subject, summary: inv.summary,
    sample: 0, breaches: 0, rows: [], byKind: {}, notes: [], ran: false,
    threshold: typeof inv.rate === "number" ? inv.rate : Number(inv.threshold ?? 0),
    thresholdKind: typeof inv.rate === "number" ? "rate" : "count",
  };
}

/**
 * THE ADDRESSING FIELDS A FINDING CARRIES ARE PART OF THE FINDING.
 *
 * `record` used to keep only `kind` and `detail` off the finding, so the
 * addresses the predicates had already computed — I5's `partitions` list above
 * all — were thrown away before reaching the artifact, and a repair lane had to
 * re-derive them by re-querying. These are copied through explicitly (rather
 * than spreading the whole finding) so an unrelated field a predicate adds
 * later does not silently enlarge every artifact row.
 */
const FINDING_ADDRESS_FIELDS = ["partitions", "rekeyedAt", "unstatedFinish", "backing", "shown", "retained", "source"];

function record(res, findings, rowRef) {
  for (const fi of findings) {
    res.breaches++;
    res.byKind[fi.kind] = (res.byKind[fi.kind] ?? 0) + 1;
    if (res.rows.length < MAX_ROWS_PER_FINDING) {
      const row = { ...rowRef, kind: fi.kind, detail: fi.detail };
      for (const k of FINDING_ADDRESS_FIELDS) {
        if (fi[k] !== undefined && fi[k] !== null) row[k] = fi[k];
      }
      // A finding that names its own id (I5 groups by sale id) wins over the
      // caller's ref, which may be the loop variable rather than the document.
      if (fi.id) row.id = fi.id;
      res.rows.push(row);
    }
  }
}

const sizeOf = (id) => Math.max(0, Math.round((INV.INVARIANT_BY_ID.get(id)?.defaultSample ?? 0) * SAMPLE_SCALE));

// ── I1 / I2 / I10 — one walk of the holdings map ────────────────────────────
/**
 * All three holdings invariants share ONE walk. Reading the portfolio three
 * times to ask three questions of the same document is three times the RU for
 * no additional evidence.
 *
 * THE HOLDINGS ARE A MAP. Walk the map, print the count, refuse on zero
 * (feedback_holdings_is_a_map_join_iterates_nothing): a JOIN over it iterates
 * nothing and returns a clean audit over an empty set, which is the one
 * outcome an auditor must never report.
 */
async function auditHoldings(db, results, shard) {
  const portfolio = db.container("portfolio");
  const catalog = db.container("card_catalog");
  const backing = INV.loadIdentityBacking();

  const { resources: docs } = await retry(() => portfolio.items.query({
    query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)",
  }).fetchAll());

  const rows = [];
  for (const d of docs) {
    for (const [hid, h] of Object.entries(d.holdings || {})) {
      rows.push({ userId: d.userId, holding: { ...h, id: h?.id ?? hid } });
    }
  }
  console.log(`  walked ${f(docs.length)} portfolio docs -> ${f(rows.length)} holdings`);
  if (rows.length === 0) {
    console.error("FATAL: zero holdings walked — the holdings map iterated nothing; refusing to report a clean audit");
    process.exit(2);
  }

  const mine = rows.filter((_, i) => shard.mine(i % Math.max(1, shard.SLOTS)));
  const i1 = results.get("I1"), i2 = results.get("I2"), i10 = results.get("I10");

  // I10 needs a catalog read per DISTINCT slug, so the slugs are collected
  // first and read once each — a per-holding read would issue the same query
  // for every copy of a card a user owns.
  const slugsNeeded = new Set();
  if (i10) {
    for (const { holding } of mine) {
      const shown = typeof holding?.fairMarketValue === "number" || typeof holding?.estimatedValue === "number";
      const slug = String(holding?.hobbyiqCardId ?? holding?.cardId ?? "").trim();
      if (shown && slug) slugsNeeded.add(slug);
    }
  }
  const backingBySlug = new Map();
  if (i10 && slugsNeeded.size) {
    let read = 0;
    for (const slug of slugsNeeded) {
      const { resources } = await retry(() => catalog.items.query({
        query: "SELECT TOP 25 c.id, c.source FROM c WHERE c.id = @s OR STARTSWITH(c.id, @pfx)",
        parameters: [{ name: "@s", value: slug }, { name: "@pfx", value: `${slug}:` }],
      }).fetchAll());
      backingBySlug.set(slug, resources);
      read++;
    }
    i10.notes.push(`catalog read for ${f(read)} distinct priced identities`);
  }

  const byUser = new Map();
  for (const { userId, holding } of mine) {
    if (i1) { i1.sample++; record(i1, INV.checkOneStampPerHolding(holding), { userId, holdingId: holding.id, slug: holding.hobbyiqCardId ?? holding.cardId ?? null }); }
    if (i2) { i2.sample++; record(i2, INV.checkWithheldValueExplained(holding), { userId, holdingId: holding.id, slug: holding.hobbyiqCardId ?? holding.cardId ?? null }); }
    if (i10) {
      i10.sample++;
      const slug = String(holding?.hobbyiqCardId ?? holding?.cardId ?? "").trim();
      const found = INV.checkPricedOnUnbackedIdentity(holding, backingBySlug.get(slug) ?? [], backing);
      record(i10, found, { userId, holdingId: holding.id, slug: slug || null });
      if (found.length) byUser.set(userId, (byUser.get(userId) ?? 0) + found.length);
    }
  }
  if (i10) {
    // COUNT BY USER — the blast radius. One user with 300 is a bad import;
    // 300 users with one each is a matcher gap, and the same total means two
    // entirely different days of work.
    const top = [...byUser].sort((a, b) => b[1] - a[1]).slice(0, 10);
    i10.byUser = Object.fromEntries(top);
    i10.notes.push(`${f(byUser.size)} distinct users affected; top ${top.length} recorded`);
  }
  for (const r of [i1, i2, i10]) if (r) r.ran = true;
}

// ── I3 — catalog setKey field, sampled per (sport, year) ────────────────────
async function auditCatalogSetKey(db, res, bud) {
  const catalog = db.container("card_catalog");
  const invariant = INV.loadSetKeyFieldInvariant();
  const target = sizeOf("I3");
  if (target === 0) { res.notes.push("sample size 0 — skipped"); return; }

  // PER (sport, year), because the 2026-09-05 census found the breach
  // concentrated in ONE cell (2026 baseball, 19,867 rows) while the corpus as a
  // whole looked healthy. A flat random sample reports a fraction of a percent
  // and buries it.
  const { resources: cells } = await retry(() => catalog.items.query({
    query: "SELECT TOP 40 c.sport, c.cardYear, COUNT(1) AS n FROM c WHERE STARTSWITH(c.id, 'hiq:') "
      + "GROUP BY c.sport, c.cardYear ORDER BY COUNT(1) DESC",
  }).fetchAll()).catch(() => ({ resources: [] }));

  const perCell = cells.length ? Math.max(20, Math.floor(target / cells.length)) : target;
  const byCell = {};

  if (!cells.length) {
    // GROUP BY is not universally supported; a flat sample still measures the
    // corpus, and the note says the axis was lost so nobody reads the number as
    // per-cell evidence.
    res.notes.push("per-(sport,year) axis unavailable (GROUP BY unsupported) — flat sample");
    const { resources } = await retry(() => catalog.items.query({
      query: "SELECT TOP @n c.id, c.setKey FROM c WHERE STARTSWITH(c.id, 'hiq:') AND IS_DEFINED(c.setKey)",
      parameters: [{ name: "@n", value: target }],
    }).fetchAll());
    for (const row of resources) {
      res.sample++;
      record(res, INV.checkSetKeyFieldRow(row, invariant), { id: row.id, setKey: row.setKey, cell: INV.catalogCellOf(row) });
    }
    return;
  }

  for (const cell of cells) {
    if (bud.outOfClock()) { res.notes.push(`stopped early at cell ${cell.sport}:${cell.cardYear} — ${bud.stoppedAtBudget()}`); break; }
    const { resources } = await retry(() => catalog.items.query({
      query: "SELECT TOP @n c.id, c.setKey FROM c WHERE STARTSWITH(c.id, 'hiq:') AND IS_DEFINED(c.setKey) "
        + "AND c.sport = @sport AND c.cardYear = @year",
      parameters: [
        { name: "@n", value: perCell },
        { name: "@sport", value: cell.sport ?? null },
        { name: "@year", value: cell.cardYear ?? null },
      ],
    }).fetchAll());
    const key = `${cell.sport ?? "(none)"}:${cell.cardYear ?? "(none)"}`;
    let cellBreaches = 0;
    for (const row of resources) {
      res.sample++;
      const found = INV.checkSetKeyFieldRow(row, invariant);
      cellBreaches += found.length;
      record(res, found, { id: row.id, setKey: row.setKey, cell: key });
    }
    if (resources.length) byCell[key] = { sampled: resources.length, breaches: cellBreaches };
  }
  // The per-cell table is the finding. A corpus-wide rate would have called
  // 19,867 rows "0.3%" and nobody would have looked.
  res.byCell = Object.fromEntries(
    Object.entries(byCell).sort((a, b) => (b[1].breaches / b[1].sampled) - (a[1].breaches / a[1].sampled)).slice(0, 15),
  );
}

// ── I4 — slug grammar over sold_comps ───────────────────────────────────────
async function auditSlugGrammar(db, res) {
  const pool = db.container("sold_comps");
  const target = sizeOf("I4");
  if (target === 0) { res.notes.push("sample size 0 — skipped"); return; }
  const { resources } = await retry(() => pool.items.query({
    query: "SELECT TOP @n c.id, c.cardId, c.hobbyiqCardId FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')",
    parameters: [{ name: "@n", value: target }],
  }).fetchAll());
  for (const row of resources) {
    res.sample++;
    record(res, INV.checkSlugGrammar(row.hobbyiqCardId), { id: row.id, slug: row.hobbyiqCardId, cardId: row.cardId });
  }
}

// ── I5 — one sale, one address (sampled by recent rekeyedAt) ────────────────
/**
 * A copy-instead-of-move is created BY A REKEY, so the sample is drawn from the
 * rows a rekey most recently touched — the population where the defect can
 * exist at all. Sampling the whole pool at random would spend the budget on
 * 16M rows no rekey has been near.
 *
 * The pool is partitioned on /cardId, so the same `id` under two partition keys
 * is two documents. The check reads each sampled id back CROSS-PARTITION and
 * counts the residences.
 */
async function auditOneSaleOneAddress(db, res, bud) {
  const pool = db.container("sold_comps");
  const target = sizeOf("I5");
  if (target === 0) { res.notes.push("sample size 0 — skipped"); return; }

  const { resources: recent } = await retry(() => pool.items.query({
    query: "SELECT TOP @n c.id, c.cardId, c.rekeyedAt FROM c WHERE IS_DEFINED(c.rekeyedAt) ORDER BY c.rekeyedAt DESC",
    parameters: [{ name: "@n", value: target }],
  }).fetchAll());
  if (!recent.length) { res.notes.push("no rows carry rekeyedAt — nothing recently rekeyed to check"); return; }
  res.notes.push(`sampled the ${f(recent.length)} most recently rekeyed rows (newest ${recent[0]?.rekeyedAt ?? "?"})`);

  const ids = [...new Set(recent.map((r) => String(r.id)).filter(Boolean))];
  const CHUNK = 60;
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (bud.outOfClock()) { res.notes.push(`stopped at id ${i}/${ids.length} — ${bud.stoppedAtBudget()}`); break; }
    const chunk = ids.slice(i, i + CHUNK);
    const params = chunk.map((v, k) => ({ name: `@i${k}`, value: v }));
    const { resources } = await retry(() => pool.items.query({
      query: `SELECT c.id, c.cardId, c.rekeyedAt FROM c WHERE c.id IN (${params.map((p) => p.name).join(",")})`,
      parameters: params,
    }).fetchAll());
    const byId = new Map();
    for (const r of resources) {
      const k = String(r.id);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(r);
    }
    for (const id of chunk) {
      res.sample++;
      record(res, INV.checkOneSaleOneAddress(id, byId.get(id) ?? []), { id });
    }
  }
}

// ── I6 — pool identity coherence ────────────────────────────────────────────
async function auditPoolCoherence(db, res, bud) {
  const pool = db.container("sold_comps");
  const target = sizeOf("I6");
  if (target === 0) { res.notes.push("sample size 0 — skipped"); return; }

  // Rows whose slug NAMES a parallel are the only ones the predicate can fire
  // on — a base row has no finish word in its address to contradict. Sampling
  // the whole pool would spend most of the budget on rows the check exempts by
  // construction.
  const { resources } = await retry(() => pool.items.query({
    query: "SELECT TOP @n c.id, c.cardId, c.hobbyiqCardId, c.title, c.parallel, c.setKey, c.cardYear "
      + "FROM c WHERE IS_DEFINED(c.title) AND STARTSWITH(c.hobbyiqCardId, 'hiq:') ORDER BY c.soldAt DESC",
    parameters: [{ name: "@n", value: target }],
  }).fetchAll());

  const poolSizes = new Map();
  const perRow = [];
  for (const row of resources) {
    if (bud.outOfClock()) { res.notes.push(`stopped at ${res.sample}/${resources.length} — ${bud.stoppedAtBudget()}`); break; }
    res.sample++;
    const addr = String(row.hobbyiqCardId ?? row.cardId ?? "");
    poolSizes.set(addr, (poolSizes.get(addr) ?? 0) + 1);
    const found = INV.checkPoolIdentityCoherence(row, CLASSIFY);
    for (const fi of found) perRow.push(fi);
    record(res, found, { id: row.id, slug: addr, title: String(row.title ?? "").slice(0, 120) });
  }
  // RATE PER POOL, top 20. One mislabelled sale in a 400-row pool moves FMV by
  // a fraction of a percent; three in a pool of five is the pool's identity
  // being wrong, and a corpus count cannot tell them apart.
  res.topPools = INV.poolCollisionRates(perRow, poolSizes).slice(0, 20).map((p) => ({
    pool: p.pool, breaches: p.breaches, sampledInPool: p.poolSize,
    rate: Number(p.rate.toFixed(4)), sampleIds: p.samples,
  }));
}

// ── I7 — deploy health (payload supplied by the workflow) ───────────────────
/**
 * The workflow shells `gh api` and writes the payload to DEPLOY_HEALTH_JSON;
 * this reads and JUDGES it. The split is deliberate: `gh` needs a token this
 * script has no business holding, and a pure judge is a judge the pins can
 * drive with a fixture of the exact 2026-09-05 run.
 */
function auditDeployHealth(res) {
  if (!DEPLOY_HEALTH_JSON) {
    res.notes.push("DEPLOY_HEALTH_JSON not supplied — I7 needs the workflow's `gh api` payload; not run locally");
    return;
  }
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(DEPLOY_HEALTH_JSON, "utf8"));
  } catch (e) {
    res.notes.push(`deploy health payload unreadable (${String(e?.message ?? e).slice(0, 120)})`);
    return;
  }
  res.ran = true;
  res.sample = 1;
  const run = payload?.run ?? null;
  const jobs = payload?.jobs ?? [];
  record(res, INV.checkDeployHealth(run, jobs), {
    runId: run?.id ?? null, conclusion: run?.conclusion ?? null, url: run?.html_url ?? null,
  });
  if (run) res.notes.push(`last run ${run.id} (${run.created_at}) concluded "${run.conclusion}" over ${jobs.length} jobs`);
}

// ── I8 — freshness (reuse, do not duplicate the canary) ─────────────────────
async function auditFreshness(db, res, nowMs) {
  const pool = db.container("sold_comps");
  // NO `ORDER BY COUNT(1)` HERE. Measured against prod 2026-09-05: Cosmos
  // accepts `GROUP BY c.source` with COUNT + MAX perfectly well, and rejects
  // the same query the moment an ORDER BY over the aggregate is added ("One of
  // the input values is invalid"). The first draft ordered server-side, caught
  // the error, and reported I8 as a clean zero-sample — a check that cannot
  // fire reading exactly like a check that found nothing. The ordering is
  // cosmetic; it is done client-side below.
  const { resources } = await retry(() => pool.items.query({
    query: "SELECT c.source, COUNT(1) AS rows, MAX(c.soldAt) AS newestSoldAt FROM c GROUP BY c.source",
  }).fetchAll()).catch((e) => {
    res.notes.push(`per-source GROUP BY unavailable (${String(e?.message ?? e).slice(0, 100)})`);
    return { resources: [] };
  });
  res.sample = resources.length;
  res.sources = resources.map((s) => ({
    source: s.source ?? "(none)", rows: Number(s.rows ?? 0), newestSoldAt: s.newestSoldAt ?? null,
    ageHours: Number.isFinite(Date.parse(String(s.newestSoldAt)))
      ? Number(((nowMs - Date.parse(String(s.newestSoldAt))) / 3600000).toFixed(1)) : null,
  })).sort((a, b) => b.rows - a.rows);
  record(res, INV.checkSourceFreshness(res.sources, nowMs), { source: null });
  res.notes.push("the freshness CANARY owns the alert (sold-comps-freshness-canary.yml, every 6h); this is the digest line");
}

// ── I9 — shadow re-derivation ───────────────────────────────────────────────

/**
 * The REAL deriver, assembled exactly as rematch-sold-comps.cjs assembles it —
 * `deriveIdentity` and `storedIdentity` are exported from that script, and the
 * dist/ services they need are wired here in the same shape.
 *
 * REUSED, NOT REIMPLEMENTED. The whole value of I9 is that it re-derives with
 * the SAME code the census and the apply lane use: a nightly disagreement rate
 * measured by a different deriver would be a rate about the auditor, and the
 * repair lanes could not act on it. Requiring the script for its exports must
 * not run it — it guards on `require.main === module`, like this lane does.
 *
 * Throws when dist/ is absent. The caller reports that as NOT RUN rather than
 * as a clean zero (feedback: a missing key is a finding).
 */
function buildDeriver() {
  const RM = require(path.join(__dirname, "rematch-sold-comps.cjs"));
  const d = (...p) => require(path.join(__dirname, "..", "dist", "services", ...p));
  const pti = d("portfolioiq", "parseTitleIdentity.service.js");
  const hic = d("portfolioiq", "hobbyIqCardId.service.js");
  const guard = d("portfolioiq", "slugGuard.service.js");
  const pvs = d("portfolioiq", "persistVendorSalesToPool.service.js");
  const slugRe = d("portfolioiq", "slugRederivation.service.js");
  if (typeof RM.deriveIdentity !== "function" || typeof RM.storedIdentity !== "function") {
    throw new Error("rematch-sold-comps.cjs does not export deriveIdentity/storedIdentity");
  }
  return {
    deriveIdentity: RM.deriveIdentity,
    storedIdentity: RM.storedIdentity,
    deps: {
      parseListingIdentity: pti.parseListingIdentity,
      isCardNumberAutoSubset: pti.isCardNumberAutoSubset,
      inferSetKeyFromTitle: pti.inferSetKeyFromTitle,
      inferSportFromTitle: pti.inferSportFromTitle,
      ingestGradeFromTitle: pvs.ingestGradeFromTitle,
      isMultiCardLot: pti.isMultiCardLot,
      normalizeSetKey: hic.normalizeSetKey,
      computeHobbyIqCardId: hic.computeHobbyIqCardId,
      guardSlugInputs: guard.guardSlugInputs,
      normalizeSportStrict: guard.normalizeSportStrict,
      extractYearFromTitle: slugRe.extractYearFromTitle,
    },
  };
}
/**
 * A RANDOM sample, not a recent one: recency correlates with whichever ingest
 * ran last, and a class rate measured on one source's output is that source's
 * rate, not the corpus's. Cosmos has no RANDOM(), so the sample is drawn across
 * an offset the run's own clock chooses — good enough for a nightly delta,
 * which is what this invariant is for.
 */
async function auditRederivation(db, res, bud, nowMs) {
  const pool = db.container("sold_comps");
  const target = sizeOf("I9");
  if (target === 0) { res.notes.push("sample size 0 — skipped"); return; }

  const offset = Math.floor((nowMs / 86400000) % 50) * 500;
  const { resources } = await retry(() => pool.items.query({
    query: "SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.source, c.parallel, c.setKey, "
      + "c.cardYear, c.cardNumber, c.printRun FROM c WHERE IS_DEFINED(c.title) "
      + "AND STARTSWITH(c.hobbyiqCardId, 'hiq:') OFFSET @off LIMIT @n",
    parameters: [{ name: "@off", value: offset }, { name: "@n", value: target }],
  }).fetchAll()).catch(async (e) => {
    res.notes.push(`offset sample unavailable (${String(e?.message ?? e).slice(0, 90)}) — head sample`);
    return retry(() => pool.items.query({
      query: "SELECT TOP @n c.id, c.cardId, c.hobbyiqCardId, c.title, c.source, c.parallel, c.setKey, "
        + "c.cardYear, c.cardNumber, c.printRun FROM c WHERE IS_DEFINED(c.title) AND STARTSWITH(c.hobbyiqCardId, 'hiq:')",
      parameters: [{ name: "@n", value: target }],
    }).fetchAll());
  });

  // THE REAL DERIVER, or the invariant does not run. The first prod run passed
  // `derived: null` and got 160/160 UNDERIVABLE with a 0.00% CONFLICT rate — a
  // check that cannot fire, reported as a clean corpus. Loading the deriver can
  // fail (it needs dist/); when it does, this says so and reports NOTHING,
  // because an unrun check must never print a zero.
  let deriver = null;
  try {
    deriver = buildDeriver();
  } catch (e) {
    res.notes.push(`NOT RUN — the deriver could not be loaded (${String(e?.message ?? e).slice(0, 120)}); `
      + "a re-derivation check with no deriver reports 100% UNDERIVABLE, which reads like a clean corpus");
    return;
  }

  const verdicts = [];
  const needsChecklistRows = [];
  for (const row of resources) {
    if (bud.outOfClock()) { res.notes.push(`stopped at ${verdicts.length}/${resources.length} — ${bud.stoppedAtBudget()}`); break; }
    res.sample++;
    try {
      const v = INV.classifyStoredRow(row, CLASSIFY, {
        deriveIdentity: deriver.deriveIdentity,
        storedIdentity: deriver.storedIdentity,
        deriveDeps: deriver.deps,
      });
      verdicts.push(v);
      // A CONFLICT is the row-level finding. IMPROVE and UNDERIVABLE are
      // counted in the class table but are not breaches: IMPROVE is a queue,
      // UNDERIVABLE is absence, and PROTECTED is report-only forever.
      // ONLY A TRUE DISAGREEMENT IS RECORDED AS A BREACH. A CONFLICT the
      // checklist gate produced (a pure fill onto an unbacked destination) is
      // an ACQUISITION signal, listed separately below with its axes.
      if (INV.BREACHING_CLASSES.has(String(v?.klass))) {
        const kind = INV.conflictKind(v);
        const ref = {
          id: row.id, slug: row.hobbyiqCardId, cardId: row.cardId ?? null,
          title: String(row.title ?? "").slice(0, 120),
          axes: INV.axisSignature(v), conflictKind: kind,
        };
        if (kind === "TRUE-DISAGREEMENT") {
          record(res, [{
            kind: "rederivation-true-disagreement",
            detail: `stored slug "${row.hobbyiqCardId}" re-derives as a DIFFERENT card — `
              + `${INV.axisSignature(v)} (${(v.reasons ?? []).slice(0, 3).join("; ") || "no reason given"})`,
          }], ref);
        } else if (kind === "NEEDS-CHECKLIST" && needsChecklistRows.length < MAX_ROWS_PER_FINDING) {
          // Not a breach — a queue. Carried in the artifact so the acquisition
          // lane can take it without re-querying.
          needsChecklistRows.push({
            ...ref,
            filled: (v.axes?.filled ?? []).slice().sort(),
            detail: `derivation agrees but is more specific (${INV.axisSignature(v)}); no checklist `
              + "backs the destination — an acquisition, not a disagreement",
          });
        }
      }
    } catch (e) {
      res.notes.push(`classifier threw on ${row.id}: ${String(e?.message ?? e).slice(0, 90)}`);
    }
  }
  const rates = INV.rederivationRates(verdicts);
  res.byClass = rates.byClass;
  res.byConflictKind = rates.byConflictKind;
  res.byAxis = rates.byAxis;
  res.byReason = rates.byReason;
  res.needsChecklistAxes = rates.needsChecklistAxes;
  res.needsChecklistRows = needsChecklistRows;
  // THE THRESHOLD MEASURES TRUE DISAGREEMENTS. Both numbers are printed, and
  // the note says which one the threshold reads — a threshold that quietly
  // starts measuring something else is indistinguishable from a corpus that
  // improved overnight.
  res.notes.push(
    `TRUE-DISAGREEMENT rate ${pct(rates.breaching, rates.total)} of ${f(rates.total)} classified `
    + `(${f(rates.breaching)} rows) — this is what the threshold reads`,
  );
  res.notes.push(
    `NEEDS-CHECKLIST ${f(rates.needsChecklist)} (${pct(rates.needsChecklist, rates.total)}) — the `
    + "derivation AGREES and is more specific; no checklist backs the destination. An ACQUISITION "
    + "signal, deliberately outside the threshold (#1796: the checklist gate returns these as CONFLICT)",
  );
  if (rates.parserArtifact) {
    res.notes.push(`PARSER-ARTIFACT ${f(rates.parserArtifact)} — known classifier noise, contained from writes`);
  }
  res.notes.push(
    `all-CONFLICT rate would be ${pct(rates.conflicts, rates.total)} — reported so the change in what `
    + "the threshold measures is visible, never silent",
  );
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  refuseApply();

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const nowMs = Date.now();
  // Sized for the workflow's 45-minute ceiling: 30m loop + 5m unit reserve +
  // 3m verify cap + startup leaves >= 15 minutes of margin, which is what
  // tests/runnerBudgetMargin.test.ts requires of every budgeted lane.
  const bud = budget({ minutes: 30, reserveMs: 5 * 60 * 1000, verifyMs: 3 * 60 * 1000, startedAt: nowMs });
  const shard = runnerShardScope({ label: "audit-pricing-invariants-corpus" });

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database(DB_NAME);

  console.log("audit-pricing-invariants-corpus  READ ONLY — this lane has NO write path");
  console.log(`  db=${DB_NAME}  ${bud.describe()}  sampleScale=${SAMPLE_SCALE}`);
  console.log(`  ${shard.banner()}`);
  console.log(`  invariants: ${WANTED.length ? WANTED.join(",") : "all 10"}`);
  console.log("  findings are DATA, never fixes — the repair for any finding is a separate audited lane\n");

  const results = new Map();
  for (const inv of INV.INVARIANTS) if (wants(inv.id)) results.set(inv.id, makeResult(inv.id));

  // Each invariant is a UNIT and the pre-check runs BEFORE it, never at the
  // loop top: a unit that cannot finish inside the reserve does not start and
  // SAYS SO. A killed step reports nothing at all — not its counts, not its
  // exit code (feedback_a_killed_job_cannot_report_progress).
  const units = [
    { ids: ["I1", "I2", "I10"], label: "holdings (one stamp / withheld value / unbacked identity)", run: () => auditHoldings(db, results, shard) },
    { ids: ["I3"], label: "catalog setKey field vs id stem", run: () => auditCatalogSetKey(db, results.get("I3"), bud) },
    { ids: ["I4"], label: "sold_comps slug grammar", run: () => auditSlugGrammar(db, results.get("I4")) },
    { ids: ["I5"], label: "one sale one address", run: () => auditOneSaleOneAddress(db, results.get("I5"), bud) },
    { ids: ["I6"], label: "pool identity coherence", run: () => auditPoolCoherence(db, results.get("I6"), bud) },
    { ids: ["I7"], label: "deploy health", run: async () => auditDeployHealth(results.get("I7")) },
    { ids: ["I8"], label: "source freshness", run: () => auditFreshness(db, results.get("I8"), nowMs) },
    { ids: ["I9"], label: "shadow re-derivation", run: () => auditRederivation(db, results.get("I9"), bud, nowMs) },
  ];

  for (const unit of units) {
    const active = unit.ids.filter((id) => results.has(id));
    if (!active.length) continue;
    if (bud.outOfClock()) {
      for (const id of active) results.get(id).notes.push(`not started — ${bud.stoppedAtBudget()}`);
      console.log(`  SKIP  ${unit.label} — ${bud.stoppedAtBudget()}`);
      continue;
    }
    const t0 = Date.now();
    console.log(`  RUN   ${unit.label}`);
    try {
      await unit.run();
      for (const id of active) results.get(id).ran = true;
    } catch (e) {
      // ONE invariant failing must not cost the other nine their run. The
      // failure is recorded as a note on that invariant, never as a clean pass:
      // an unrun check reporting zero breaches is the worst output available.
      const msg = String(e?.stack ?? e?.message ?? e).slice(0, 300);
      for (const id of active) results.get(id).notes.push(`ERRORED — ${msg}`);
      console.log(`  ERROR ${unit.label}: ${msg.split("\n")[0]}`);
    }
    console.log(`        ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // ── Digest ────────────────────────────────────────────────────────────────
  const list = [...results.values()];
  const warnings = [];
  for (const r of list) {
    const w = INV.evaluateThreshold(r.id, { breaches: r.breaches, sample: r.sample });
    if (w) warnings.push(w);
  }

  console.log(`\n${"=".repeat(76)}\nCORPUS INVARIANT DIGEST  ${new Date(nowMs).toISOString()}\n${"=".repeat(76)}`);
  console.log(`  ${"id".padEnd(4)}${"invariant".padEnd(30)}${"sampled".padStart(10)}${"breaches".padStart(10)}   status`);
  for (const r of list) {
    const status = !r.ran ? "NOT RUN"
      : warnings.some((w) => w.id === r.id) ? "BREACH"
        : r.breaches > 0 ? "findings (under threshold)" : "clean";
    console.log(`  ${r.id.padEnd(4)}${r.name.padEnd(30)}${f(r.sample).padStart(10)}${f(r.breaches).padStart(10)}   ${status}`);
  }

  for (const r of list) {
    if (!r.rows.length && !r.notes.length) continue;
    console.log(`\n${"-".repeat(76)}\n${r.id} ${r.name}  —  ${r.summary}\n${"-".repeat(76)}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    if (Object.keys(r.byKind).length) {
      console.log("  by kind:");
      for (const [k, n] of Object.entries(r.byKind).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(44)} ${f(n)}`);
    }
    if (r.byCell) { console.log("  worst (sport,year) cells:"); for (const [c, v] of Object.entries(r.byCell)) console.log(`    ${c.padEnd(28)} ${v.breaches}/${v.sampled}`); }
    if (r.byClass) { console.log("  by class:"); for (const [c, n] of Object.entries(r.byClass)) console.log(`    ${c.padEnd(28)} ${f(n)}`); }
    if (r.byConflictKind) {
      console.log("  CONFLICT split (only TRUE-DISAGREEMENT is a breach):");
      for (const [c, n] of Object.entries(r.byConflictKind)) console.log(`    ${c.padEnd(28)} ${f(n)}`);
    }
    if (r.byAxis) {
      console.log("  by axis signature:");
      for (const [c, n] of Object.entries(r.byAxis).slice(0, 12)) console.log(`    ${String(c).slice(0, 56).padEnd(56)} ${f(n)}`);
    }
    if (r.byReason) {
      console.log("  by reason code:");
      for (const [c, n] of Object.entries(r.byReason).slice(0, 15)) console.log(`    ${String(c).slice(0, 56).padEnd(56)} ${f(n)}`);
    }
    if (r.needsChecklistAxes && Object.keys(r.needsChecklistAxes).length) {
      // THE ACQUISITION SIGNAL. Which axes a checklist would settle, and how
      // many rows each would unblock — this feeds the checklist queue, not the
      // alarm.
      console.log("  NEEDS-CHECKLIST by filled axes (acquisition signal, not a breach):");
      for (const [c, n] of Object.entries(r.needsChecklistAxes).slice(0, 10)) console.log(`    ${String(c).padEnd(40)} ${f(n)}`);
    }
    if (r.needsChecklistRows?.length) {
      console.log(`  NEEDS-CHECKLIST rows (${r.needsChecklistRows.length}):`);
      for (const row of r.needsChecklistRows) {
        console.log(`    id ${row.id}`);
        console.log(`      slug ${row.slug}  filled ${row.filled?.join(",") || "?"}`);
      }
    }
    if (r.byUser) { console.log("  by user (top):"); for (const [u, n] of Object.entries(r.byUser)) console.log(`    ${String(u).slice(0, 28).padEnd(28)} ${f(n)}`); }
    if (r.topPools?.length) {
      console.log("  worst pools by rate:");
      for (const p of r.topPools.slice(0, 10)) console.log(`    ${String(p.pool).slice(0, 56).padEnd(56)} ${p.breaches}/${p.sampledInPool}`);
    }
    if (r.sources?.length) {
      console.log("  per-source freshness:");
      for (const s of r.sources) console.log(`    ${String(s.source).padEnd(24)} ${f(s.rows).padStart(12)} rows  newest ${s.newestSoldAt ?? "?"} (${s.ageHours ?? "?"}h)`);
    }
    // ROW-LEVEL, always. A count with no ids is a number nobody can act on.
    if (r.rows.length) {
      // THE REPAIR LANE MUST BE ABLE TO TAKE THESE WITHOUT RE-QUERYING
      // (2026-09-05). The first version printed `holding a560c983` — an
      // 8-character prefix and no userId — so anyone acting on a finding had to
      // go back to Cosmos to find the document, and `portfolio` is partitioned
      // on /userId, which the digest did not carry. A row-level finding whose
      // ids are abbreviated is not a row-level finding.
      //
      // Full ids now, plus the partition key each container needs:
      //   holdings   userId + holding id  (portfolio is /userId)
      //   sales      sale id + EVERY partition it was found under (/cardId)
      console.log(`  rows (${r.rows.length} of ${f(r.breaches)}):`);
      for (const row of r.rows) {
        const ref = row.holdingId
          ? `holding ${row.holdingId}  user ${row.userId ?? "(none)"}`
          : `id ${row.id ?? row.runId ?? "?"}`;
        console.log(`    ${ref}  [${row.kind}]`);
        if (row.slug) console.log(`      slug ${row.slug}`);
        if (row.partitions?.length) {
          for (const p of row.partitions) console.log(`      partition ${p}`);
        } else if (row.cardId && row.cardId !== row.slug) {
          console.log(`      partition ${row.cardId}`);
        }
        console.log(`      ${row.detail}`);
      }
    }
  }

  // The `::warning` block. Each names its threshold, so a reader knows what
  // number would have to change for the warning to go away.
  console.log(`\n${"=".repeat(76)}`);
  if (warnings.length) {
    for (const w of warnings) console.log(`::warning::${w.message}`);
  } else {
    console.log("  no invariant breached its threshold tonight.");
  }
  console.log("\nfindings are DATA, not failures — this job exits 0 whatever it found.");
  console.log("a red X here means the AUDITOR broke. The repair for any finding is a");
  console.log("separate audited lane that names the rows it moves.");

  const artifact = {
    at: new Date(nowMs).toISOString(),
    db: DB_NAME,
    readOnly: true,
    sampleScale: SAMPLE_SCALE,
    shard: { sharded: shard.SHARDED, slot: shard.SLOT, slots: shard.SLOTS },
    warnings,
    invariants: list.map((r) => ({
      id: r.id, name: r.name, subject: r.subject, summary: r.summary,
      ran: r.ran, sample: r.sample, breaches: r.breaches,
      threshold: r.threshold, thresholdKind: r.thresholdKind,
      byKind: r.byKind, notes: r.notes,
      ...(r.byCell ? { byCell: r.byCell } : {}),
      ...(r.byClass ? { byClass: r.byClass } : {}),
      ...(r.byConflictKind ? { byConflictKind: r.byConflictKind } : {}),
      ...(r.byAxis ? { byAxis: r.byAxis } : {}),
      ...(r.byReason ? { byReason: r.byReason } : {}),
      ...(r.needsChecklistAxes ? { needsChecklistAxes: r.needsChecklistAxes } : {}),
      ...(r.needsChecklistRows ? { needsChecklistRows: r.needsChecklistRows } : {}),
      ...(r.byUser ? { byUser: r.byUser } : {}),
      ...(r.topPools ? { topPools: r.topPools } : {}),
      ...(r.sources ? { sources: r.sources } : {}),
      rows: r.rows,
    })),
  };
  try {
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(artifact, null, 2));
    console.log(`\nfindings JSON -> ${OUT_JSON}`);
  } catch (e) {
    console.log(`\nfindings JSON NOT written (${String(e?.message ?? e).slice(0, 120)})`);
  }
}

module.exports = { makeResult, record, auditDeployHealth, refuseApply };

if (require.main === module) {
  main().then(
    // Findings NEVER fail this job. Nonzero is reserved for machinery.
    () => process.exit(0),
    (e) => { console.error("FATAL (audit machinery):", e?.stack || e?.message || e); process.exit(3); },
  );
}
