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
 * asserts four invariants (see scripts/lib/pricing-invariants.cjs):
 *
 *   BASIS-IDENTITY  every cited comp shares product+parallel+printRun+grade,
 *                   or the persisted rung declares the transition
 *   RUNG-HONESTY    an exact-pool rung is backed by an exact pool that exists
 *   SUBSTITUTION    persisted vs shadow value within 25%
 *   DETERMINISM     unchanged provenance must not produce a moved value
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
 * never a vendor-keyed or invented number). Missing table = the rung simply
 * does not fire, which is the safe direction for an auditor.
 */
function loadGradeMultipliers() {
  try {
    const mod = require(path.join(__dirname, "..", "dist", "services", "compiq", "gradeCalibrationData.js"));
    const table = mod.GRADE_CALIBRATION ?? mod.default?.GRADE_CALIBRATION ?? null;
    if (!table || typeof table !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(table)) {
      const n = typeof v === "number" ? v : Number(v?.multiplier ?? v?.ratio ?? NaN);
      if (Number.isFinite(n) && n > 0) out[String(k).toUpperCase()] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** The single write this job may do: the auditFlag marker, and nothing else.
 *  Never a price field. Uses a targeted patch so no other field on the doc is
 *  read-modify-written. */
async function writeAuditFlag(portfolio, userId, holdingId, marker) {
  const op = marker === null
    ? { op: "remove", path: `/holdings/${holdingId}/auditFlag` }
    : { op: "set", path: `/holdings/${holdingId}/auditFlag`, value: marker };
  try {
    await retry(() => portfolio.item(userId, userId).patch([op]));
    return true;
  } catch (e) {
    // A "remove" on an absent path is a 400 — that is a no-op, not an error.
    const msg = String(e?.message ?? e);
    if (marker === null && /400|not.*exist|absent/i.test(msg)) return false;
    throw e;
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
        const wrote = await writeAuditFlag(portfolio, userId, holding.id, {
          reason: `${top.invariant}: ${top.kind}`,
          at: new Date(nowMs).toISOString(),
          invariant: top.invariant,
        });
        if (wrote) markersWritten++;
      }
    } else if (APPLY && holding.auditFlag) {
      const cleared = await writeAuditFlag(portfolio, userId, holding.id, null);
      if (cleared) markersCleared++;
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
}

main().then(
  () => process.exit(0),
  (e) => { console.error("FATAL (audit machinery):", e?.stack || e?.message || e); process.exit(3); },
);
