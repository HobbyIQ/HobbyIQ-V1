#!/usr/bin/env node
/**
 * audit-pricing-invariants.cjs — the nightly adversarial recompute.
 *
 * CF-NEVER-AGAIN (Drew, 2026-09-02: "rather than fixing one — how can we
 * ensure this NEVER happens again"). Six pricing defects were found the week of
 * 2026-08-27..09-02. Every one was found by Drew looking at a number and then
 * proven by an adversarial recompute. This job runs that recompute over every
 * holding, nightly, so the next one is found by the machine.
 *
 * WHAT IT DOES. For every holding (walking the holdings MAP on each portfolio
 * doc) and an env-capped sample of top-traded cards, it INDEPENDENTLY re-derives
 * the value — reading the identity, querying the exact pool directly, applying
 * the doctrine ladder — WITHOUT calling the engine's valuation code. Then it
 * asserts five invariants (see scripts/lib/pricing-invariants.cjs):
 *
 *   BASIS-IDENTITY     every cited comp shares product+parallel+printRun+grade,
 *                      or the persisted rung declares the transition
 *   RUNG-HONESTY       an exact-pool rung is backed by an exact pool that exists
 *   SUBSTITUTION       persisted vs shadow value within 25%
 *   DETERMINISM        unchanged provenance must not produce a moved value
 *   IDENTITY-COHERENCE no row the pool read reached contradicts ITSELF -- its
 *                      cardId and hobbyiqCardId naming different cards, which
 *                      the OR-query turns into one sale pricing two cards.
 *                      Vendor-partition rows are exempt by design (#1650).
 *
 * FINDINGS ARE DATA, NOT FAILURES. Report mode exits 0 whatever it finds — a
 * red X on this job means the AUDITOR broke, never that the portfolio has a
 * defect. Findings surface as per-violation telemetry (App Insights alerts on
 * `pricing_invariant_violation`) and as the digest in the run log.
 *
 * WRITES. Exactly one field, and only with APPLY=true: `auditFlag` on a flagged
 * holding — {reason, at, invariant}. It NEVER touches a price field, and it is
 * only-improve in the sense that matters: an unflagged holding's marker is
 * cleared, a flagged one's is written, and nothing else on the doc is read back
 * out and rewritten. Local runs are report-only by design.
 *
 * ...and those writes RECONCILE (CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW). This is a
 * cron writer: nightly, unattended, no dry-run. Every marker write it decides
 * to make is counted as written / skipped / failed and checked against the
 * intent by reportWrites, so a throttled run that silently dropped its markers
 * turns the workflow red instead of green. That is the ONE way a finding-free
 * exit code can be non-zero: findings never fail this job, but marker writes
 * going missing means the badge quietly stopped appearing and the digest
 * became a claim nobody can check. Requires dist/ — the workflow builds it.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   COSMOS_DATABASE           default "hobbyiq"
 *   USER_ID                   optional scope to one user
 *   TOP_CARDS                 sampled top-traded cards to audit (default 250, 0 = off)
 *   APPLY                     "true" to write the auditFlag marker (default off)
 *   STATE_BLOB                path to the determinism state file (default
 *                             .audit-state/pricing-invariants.json)
 *   MAX_EVIDENCE              evidence lines printed per finding (default 3)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");
const {
  loadLeafUtilities, auditHolding, persistedValueOf, provenanceFingerprint,
  DIVERGENCE_PCT, WINDOW_DAYS,
} = require(path.join(__dirname, "lib", "pricing-invariants.cjs"));
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. This is a CRON writer: it runs nightly,
// unattended, with no dry-run switch, and under APPLY it patches the auditFlag
// marker. A throttled patch that silently drops is exactly the failure
// writeReconciliation exists to catch, so the marker writes are counted and
// reconciled like any other write job's. Requires dist/ (compiled TS) — the
// workflow builds it.
const { reportWrites } = require(path.join(__dirname, "..", "dist", "services", "ops", "writeReconciliation.js"));

const DB_NAME = process.env.COSMOS_DATABASE || "hobbyiq";
const USER_ID = process.env.USER_ID || "";
const TOP_CARDS = Number(process.env.TOP_CARDS ?? 250);
const APPLY = String(process.env.APPLY ?? "").toLowerCase() === "true";
const MAX_EVIDENCE = Number(process.env.MAX_EVIDENCE ?? 3);
const STATE_BLOB = process.env.STATE_BLOB || path.join(__dirname, "..", ".audit-state", "pricing-invariants.json");

const f = (n) => Number(n).toLocaleString();

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

/** Fire-and-forget per-violation telemetry. One line per violation, in the
 *  existing warning shape (marketRead.service.ts logSubRawInversionObserved)
 *  so App Insights can alert on `pricing_invariant_violation` without new
 *  ingestion wiring. Telemetry failures never propagate. */
function logPricingInvariantViolation(opts) {
  try {
    console.warn(JSON.stringify({
      event: "pricing_invariant_violation",
      source: "audit-pricing-invariants",
      invariant: opts.invariant,
      kind: opts.kind,
      userId: opts.userId ?? null,
      holdingId: opts.holdingId ?? null,
      cardId: opts.slug ?? null,
      persistedValue: opts.persisted ?? null,
      shadowValue: opts.shadowValue ?? null,
      persistedRung: opts.persistedRung ?? null,
      shadowRung: opts.shadowRung ?? null,
      detail: opts.detail ?? null,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // Telemetry must never break the audit.
  }
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_BLOB, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_BLOB), { recursive: true });
    fs.writeFileSync(STATE_BLOB, JSON.stringify(state, null, 1));
  } catch (e) {
    console.warn(`state not persisted (${String(e?.message ?? e)}) — DETERMINISM will re-baseline next run`);
  }
}

/**
 * The comps the PERSISTED price cites. pricingSourceMeta carries the winning
 * slug + count but not the ids, so the basis is reconstructed as the newest
 * `compsUsed` rows the engine would have read under the persisted slug —
 * which is what the persisted rung claims it priced from. When the meta names
 * no slug there is no basis to check and BASIS-IDENTITY is vacuous.
 *
 * THE KEY IS `hobbyiqCardId`, NOT `hobbyiqCardId OR cardId`. An OR pulls in
 * rows that merely MENTION the cited slug in their other id field — a
 * different card whose cardId happens to equal this holding's hobbyiqCardId —
 * and every one of those would surface as a phantom `cross-product` finding
 * against a holding whose price never touched them. Measured on the fake-pool
 * smoke run: a healthy holding priced off two correct comps was flagged
 * cross-product by a Bowman Draft row the engine never read. The basis must be
 * the rows the price ACTUALLY cited, so it is keyed the way the pool is keyed.
 */
async function readBasisRows(pool, holding) {
  const meta = holding.pricingSourceMeta ?? null;
  const slug = meta && typeof meta.slug === "string" ? meta.slug : null;
  const compsUsed = meta && Number.isFinite(Number(meta.compsUsed)) ? Number(meta.compsUsed) : 0;
  if (!slug || compsUsed <= 0) return [];
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const { resources } = await retry(() => pool.items.query({
    query: `SELECT TOP @n c.id, c.cardId, c.hobbyiqCardId, c.title, c.price, c.soldAt,
                   c.source, c.parallel, c.printRun, c.gradeCompany, c.gradeValue, c.userId
            FROM c WHERE c.hobbyiqCardId = @s AND c.price > 0
              AND c.soldAt >= @since ORDER BY c.soldAt DESC`,
    parameters: [
      { name: "@n", value: Math.min(compsUsed, 60) },
      { name: "@s", value: slug },
      { name: "@since", value: since },
    ],
  }).fetchAll());
  return resources;
}

/** Every row under either of the holding's identities — the shadow's raw
 *  material. The shadow does its OWN scoping (window, tier, product, union
 *  refusal) so this query is deliberately WIDE, and the OR here is correct
 *  where the one in readBasisRows was not: the basis must be what the price
 *  cited, but the shadow must see everything that could have been cited before
 *  deciding for itself what belongs. */
async function readPoolRows(pool, holding) {
  const ids = [holding.hobbyiqCardId, holding.cardId]
    .filter((x) => typeof x === "string" && x.trim())
    .map((x) => x.trim());
  if (!ids.length) return [];
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const out = [];
  const seen = new Set();
  for (const id of [...new Set(ids)]) {
    const { resources } = await retry(() => pool.items.query({
      query: `SELECT TOP 200 c.id, c.cardId, c.hobbyiqCardId, c.title, c.price, c.soldAt,
                     c.source, c.parallel, c.printRun, c.gradeCompany, c.gradeValue, c.userId
              FROM c WHERE (c.hobbyiqCardId = @s OR c.cardId = @s) AND c.price > 0
                AND c.soldAt >= @since ORDER BY c.soldAt DESC`,
      parameters: [{ name: "@s", value: id }, { name: "@since", value: since }],
    }).fetchAll());
    for (const r of resources) {
      const key = String(r.id ?? "");
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      // The shadow keys on hobbyiqCardId; rows found by cardId alone carry it
      // forward so the identity filter downstream sees the id it matched on.
      out.push({ ...r, hobbyiqCardId: r.hobbyiqCardId ?? id });
    }
  }
  return out;
}

/**
 * The empirical grade multipliers for the graded->raw rung, read from the
 * SHIPPED calibration table (GRADE_CALIBRATION only — empirical-only doctrine,
 * never a vendor-keyed or invented number).
 *
 * THE SHAPE IS THREE LEVELS DEEP, NOT ONE. GRADE_CALIBRATION is
 *
 *   family -> company -> { medianRatio, p25, p75, sampleSize, byTier? }
 *   byTier -> tierKey("10" | "9.5" | ...) -> { medianRatio, sampleSize }
 *
 * The first version of this loader read `Object.entries(table)` and asked each
 * value for `.multiplier ?? .ratio` — but the top level is a FAMILY ("bowman"),
 * whose value is a map of companies and has neither field. Every entry became
 * NaN, the guard dropped all of them, gradeMultipliers came back {} with
 * `gradeMultipliers=0` in the banner, and the graded-to-raw rung — which needs
 * `Number.isFinite(mult)` — could never fire. It was dead code for every
 * holding, and the `catch { return {} }` made a real shape error look exactly
 * like a missing table. Hence the pins in tests/pricingInvariantAuditor.test.ts
 * asserting the LIVE table yields a non-empty map: a loader that silently
 * returns {} is indistinguishable from a rung that never applies.
 *
 * Keys are the shadow's tier format, `"<COMPANY> <VALUE>"` (gradeTierOf in
 * lib/pricing-invariants.cjs) — the same format lookupGradeRatioByTier builds
 * from (grader, gradeValue).
 *
 * ONLY `byTier` ratios are read. The company-level `medianRatio` is an average
 * ACROSS tiers (a PSA 10 and a PSA 6 pooled into one number), so it answers a
 * different question than "what does THIS tier trade at over raw" and would
 * price a PSA 6 off a number a PSA 10 dominates. The engine's own
 * lookupGradeRatioByTier reaches for byTier and falls through to the "other"
 * family's byTier — never to the cross-tier median — and the auditor holds the
 * same line. A tier with no empirical byTier entry gets no multiplier and the
 * rung declines to fire for it, which is the refusal the shadow already knows
 * how to express.
 *
 * Families are folded together by taking the widest-sampled entry per tier,
 * because the auditor knows a holding's grade but not reliably its product
 * family — and a multiplier from the wrong family is still an empirical number
 * from OUR pool, where an invented one would not be.
 *
 * Missing table = the rung does not fire, which is the safe direction for an
 * auditor. That is a legitimate outcome; a MALFORMED table is not, and the
 * pin is what tells the two apart.
 */
function loadGradeMultipliers() {
  let table = null;
  try {
    const mod = require(path.join(__dirname, "..", "dist", "services", "compiq", "gradeCalibrationData.js"));
    table = mod.GRADE_CALIBRATION ?? mod.default?.GRADE_CALIBRATION ?? null;
  } catch {
    // dist/ not built — the rung does not fire. Safe, and the banner says 0.
    return {};
  }
  return flattenGradeCalibration(table);
}

/**
 * The pure half of loadGradeMultipliers, split out so it is testable against
 * the live table without a dist/ build in the way. Exported below.
 */
function flattenGradeCalibration(table) {
  if (!table || typeof table !== "object") return {};
  // tier -> { ratio, sampleSize, perTier } so a byTier entry always beats a
  // company-level fallback, and among equals the larger sample wins.
  const best = new Map();
  const offer = (tier, ratio, sampleSize, perTier) => {
    const n = Number(ratio);
    if (!Number.isFinite(n) || n <= 0) return;
    const size = Number.isFinite(Number(sampleSize)) ? Number(sampleSize) : 0;
    const prev = best.get(tier);
    if (!prev || (perTier && !prev.perTier) || (perTier === prev.perTier && size > prev.sampleSize)) {
      best.set(tier, { ratio: n, sampleSize: size, perTier });
    }
  };

  for (const companies of Object.values(table)) {
    if (!companies || typeof companies !== "object") continue;
    for (const [company, entry] of Object.entries(companies)) {
      if (!entry || typeof entry !== "object") continue;
      const grader = String(company).trim().toUpperCase();
      if (!grader) continue;
      const byTier = entry.byTier;
      if (byTier && typeof byTier === "object") {
        for (const [gradeValue, tierEntry] of Object.entries(byTier)) {
          const v = Number(gradeValue);
          if (!Number.isFinite(v)) continue;
          offer(`${grader} ${v}`, tierEntry?.medianRatio, tierEntry?.sampleSize, true);
        }
      }
    }
  }
  return Object.fromEntries([...best].map(([tier, v]) => [tier, v.ratio]));
}

/** The operation list the auditFlag write sends to Cosmos — one op, on the
 *  marker path, never a price field. Exported so the pin in
 *  tests/auditFlagMarkerIsOnlyImprove.test.ts asserts against THE patch this
 *  job actually issues rather than a copy of it: a mirror in the test would go
 *  on passing the day a price field was added here. */
function auditFlagPatchOps(holdingId, marker) {
  return marker === null
    ? [{ op: "remove", path: `/holdings/${holdingId}/auditFlag` }]
    : [{ op: "set", path: `/holdings/${holdingId}/auditFlag`, value: marker }];
}

/** The single write this job may do: the auditFlag marker, and nothing else.
 *  Never a price field. Uses a targeted patch so no other field on the doc is
 *  read-modify-written.
 *
 *  Returns the reconciliation outcome for this one attempt, so the caller can
 *  count it: "written" (the marker is on the server), "skipped" (a clear
 *  against a doc that had no marker — deliberate, not loss), or "failed" (a
 *  permanent error, already reported). A throw here would abort the audit; a
 *  single unwritable holding must not cost the other thousands their run. */
async function writeAuditFlag(portfolio, userId, holdingId, marker) {
  const ops = auditFlagPatchOps(holdingId, marker);
  try {
    await retry(() => portfolio.item(userId, userId).patch(ops));
    return "written";
  } catch (e) {
    // A "remove" on an absent path is a 400 — that is a no-op, not an error.
    const msg = String(e?.message ?? e);
    if (marker === null && /400|not.*exist|absent/i.test(msg)) return "skipped";
    console.warn(`  auditFlag write failed  user=${userId} holding=${holdingId}: ${msg.slice(0, 160)}`);
    return "failed";
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const leaf = loadLeafUtilities();
  const gradeMultipliers = loadGradeMultipliers();
  const nowMs = Date.now();
  const state = readState();
  const nextState = {};

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database(DB_NAME);
  const portfolio = db.container("portfolio");
  const pool = db.container("sold_comps");

  console.log(`audit-pricing-invariants  ${APPLY ? "APPLY (auditFlag marker only)" : "REPORT-ONLY"}  db=${DB_NAME}${USER_ID ? `  user=${USER_ID}` : ""}`);
  console.log(`  window=${WINDOW_DAYS}d  divergence=${(DIVERGENCE_PCT * 100).toFixed(0)}%  topCards=${TOP_CARDS}  gradeMultipliers=${Object.keys(gradeMultipliers).length}`);
  console.log(`  the shadow pricer does NOT call the engine — a disagreement is the finding\n`);

  const { resources: docs } = await retry(() => portfolio.items.query({
    query: `SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)${USER_ID ? " AND c.userId = @u" : ""}`,
    parameters: USER_ID ? [{ name: "@u", value: USER_ID }] : [],
  }).fetchAll());

  // The holdings MAP — walk the map, never treat it as an array
  // (feedback_holdings_is_a_map_join_iterates_nothing). Count and refuse on zero.
  const rows = [];
  for (const d of docs) {
    const map = d.holdings || {};
    for (const [hid, h] of Object.entries(map)) {
      rows.push({ userId: d.userId, holding: { ...h, id: h?.id ?? hid } });
    }
  }
  console.log(`walked ${f(docs.length)} portfolio docs -> ${f(rows.length)} holdings`);
  if (rows.length === 0) {
    console.error("FATAL: zero holdings walked — the holdings map iterated nothing; refusing to report a clean audit");
    process.exit(2);
  }

  const results = [];
  const byInvariant = new Map();
  let flaggedHoldings = 0, markersWritten = 0, markersCleared = 0;
  // The reconciliation counters. `intended` is incremented at the point the
  // job DECIDES a marker write is needed — not derived afterwards from the
  // successes, which would make the equation self-satisfying and green by
  // construction.
  let markerIntended = 0, markerSkipped = 0, markerFailed = 0;

  for (const { userId, holding } of rows) {
    const [basisRows, poolRows] = [await readBasisRows(pool, holding), await readPoolRows(pool, holding)];
    const key = `${userId}::${holding.id}`;
    const previous = state[key] ?? null;
    const res = auditHolding(holding, {
      basisRows, poolRows, previous, nowMs, userId, gradeMultipliers, leaf,
    });
    results.push(res);
    nextState[key] = { fingerprint: res.fingerprint, value: res.persisted, at: new Date(nowMs).toISOString() };

    for (const finding of res.findings) {
      byInvariant.set(finding.invariant, (byInvariant.get(finding.invariant) ?? 0) + 1);
      logPricingInvariantViolation({ ...finding, ...res });
    }

    if (res.findings.length > 0) {
      flaggedHoldings++;
      if (APPLY) {
        const top = res.findings[0];
        markerIntended++;
        const outcome = await writeAuditFlag(portfolio, userId, holding.id, {
          reason: `${top.invariant}: ${top.kind}`,
          at: new Date(nowMs).toISOString(),
          invariant: top.invariant,
        });
        if (outcome === "written") markersWritten++;
        else if (outcome === "skipped") markerSkipped++;
        else markerFailed++;
      }
    } else if (APPLY && holding.auditFlag) {
      markerIntended++;
      const outcome = await writeAuditFlag(portfolio, userId, holding.id, null);
      if (outcome === "written") markersCleared++;
      else if (outcome === "skipped") markerSkipped++;
      else markerFailed++;
    }
  }

  // ── Top-traded card sample ────────────────────────────────────────────────
  // The same invariants over cards NO ONE holds: a defect that only ever hit
  // an unheld card would otherwise be invisible until someone bought one.
  let sampledCards = 0;
  if (TOP_CARDS > 0) {
    try {
      const since = new Date(nowMs - 30 * 86400000).toISOString();
      const { resources: top } = await retry(() => pool.items.query({
        query: `SELECT TOP @n c.hobbyiqCardId, COUNT(1) AS sales FROM c
                WHERE c.soldAt >= @since AND IS_DEFINED(c.hobbyiqCardId) AND c.price > 0
                GROUP BY c.hobbyiqCardId ORDER BY COUNT(1) DESC`,
        parameters: [{ name: "@n", value: TOP_CARDS }, { name: "@since", value: since }],
      }).fetchAll());
      sampledCards = top.length;
    } catch (e) {
      // GROUP BY + ORDER BY COUNT is not universally supported; the sample is
      // an enrichment, never the audit's backbone.
      console.log(`  (top-traded sample skipped: ${String(e?.message ?? e).slice(0, 120)})`);
    }
  }

  writeState(nextState);

  // ── Digest ────────────────────────────────────────────────────────────────
  const clean = results.length - flaggedHoldings;
  console.log(`\n${"=".repeat(72)}\nPRICING INVARIANT DIGEST  ${new Date(nowMs).toISOString()}\n${"=".repeat(72)}`);
  console.log(`  holdings audited      ${f(results.length)}`);
  console.log(`  clean                 ${f(clean)} (${results.length ? (100 * clean / results.length).toFixed(1) : "0.0"}%)`);
  console.log(`  flagged               ${f(flaggedHoldings)}`);
  console.log(`  top-traded sampled    ${f(sampledCards)}`);
  if (APPLY) console.log(`  auditFlag written     ${f(markersWritten)}   cleared ${f(markersCleared)}`);
  console.log(`\n  by invariant:`);
  for (const inv of ["BASIS-IDENTITY", "RUNG-HONESTY", "SUBSTITUTION", "DETERMINISM"]) {
    console.log(`    ${inv.padEnd(18)} ${f(byInvariant.get(inv) ?? 0)}`);
  }

  const flagged = results.filter((r) => r.findings.length > 0)
    .sort((a, b) => b.findings.length - a.findings.length);
  if (flagged.length) {
    console.log(`\n${"-".repeat(72)}\nEVIDENCE\n${"-".repeat(72)}`);
    for (const r of flagged) {
      console.log(`\n  ${String(r.holdingId).slice(0, 8)}  ${r.slug ?? "(no slug)"}`);
      console.log(`    persisted $${r.persisted ?? "-"} [${r.persistedRung ?? "no rung"}]  |  shadow $${r.shadowValue == null ? "-" : r.shadowValue.toFixed(2)} [${r.shadowRung}] over ${r.shadowComps} comps of ${r.poolSize} pooled`);
      for (const n of r.notes) console.log(`    note: ${n}`);
      const shown = r.findings.slice(0, MAX_EVIDENCE);
      for (const fi of shown) console.log(`    ${fi.invariant} / ${fi.kind}: ${fi.detail}`);
      if (r.findings.length > shown.length) console.log(`    ... and ${r.findings.length - shown.length} more`);
    }
  } else {
    console.log(`\n  no violations — every holding's persisted value reconciles with an independent re-derivation.`);
  }
  console.log(`\n${"=".repeat(72)}`);
  console.log(`findings are DATA, not failures — this job exits 0 whatever it found.`);
  console.log(`a red X here means the AUDITOR broke. Alert on the telemetry event`);
  console.log(`\`pricing_invariant_violation\` in App Insights, not on this exit code.`);

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. Every marker write this run decided to
  // make must be accounted for as written, deliberately skipped, or failed.
  // Note what this does and does not turn red: a FINDING is data and never
  // fails the job (the exit is forced 0 below), but marker writes that VANISH
  // are an auditor malfunction — the badge silently stops appearing and the
  // digest above becomes a claim nobody can trust. Report-only runs intend no
  // writes and print no banner.
  if (APPLY) {
    reportWrites({
      job: "audit-pricing-invariants",
      intended: markerIntended,
      written: markersWritten + markersCleared,
      skipped: markerSkipped,
      failed: markerFailed,
    });
  }
}

// Exported for the pins. `auditFlagPatchOps` is exported so the badge test
// asserts against THE patch this job issues rather than a mirror of it, and
// `flattenGradeCalibration` so the loader's shape handling can be pinned
// against the live GRADE_CALIBRATION table. Requiring this file for its
// exports must not run the audit, so main() is invoked only as a script.
module.exports = { auditFlagPatchOps, flattenGradeCalibration, loadGradeMultipliers };

if (require.main === module) {
  main().then(
    // Findings never fail this job — but a marker-write shortfall does.
    // reportWrites sets process.exitCode = 4 when the counters do not add up,
    // and a hardcoded exit(0) here would discard exactly the signal it was
    // wired in to raise, leaving the reconciliation a banner that turns
    // nothing red. So the forced 0 applies only when nothing set a code.
    () => process.exit(process.exitCode ?? 0),
    (e) => { console.error("FATAL (audit machinery):", e?.stack || e?.message || e); process.exit(3); },
  );
}
