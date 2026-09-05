#!/usr/bin/env node
/**
 * CF-WE-DONT-WANT-SELF-DERIVED-WE-WANT-IT-MATCHED-TO-CHECKLISTS
 * (Drew, 2026-09-04) — the READ-ONLY preview of the pricing gate.
 *
 * Answers, without writing anything and without repricing anything: under the
 * ruling, which holdings still show a number, which go dark, and which cards
 * need a checklist acquired.
 *
 * THIS SCRIPT NEVER WRITES. It has no APPLY mode by design — it is the thing
 * you run BEFORE deciding to turn the gate on, and a preview that could
 * mutate is not a preview. The gate itself lives in
 * holdingValuation.valueHoldingThroughOneEntry; this reproduces its decision
 * from the same predicate module so the two cannot disagree about a verdict
 * (it imports the compiled TS, it does not restate the rule).
 *
 * Measured on prod, 2026-09-04, all 12 portfolio docs / 131 holdings:
 *
 *     checklist-backed   58     prices normally
 *     self-derived-only  18     withheld — the identity was minted from a
 *                               user's own import or our own sales
 *     no-slug            49     withheld — no canonical identity at all
 *     no-catalog-row      6     withheld — slug names no catalog row
 *
 * Drew's 43: 31 priced, 12 withheld (7 self-derived-only, 3 no-slug,
 * 2 no-catalog-row).
 *
 *   USER=<userId>   one user (default: every portfolio doc)
 *   LIMIT=n         cap holdings examined
 */
"use strict";

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
// The gate's OWN predicate, compiled — not a restatement. A second copy of
// this rule is a second chance for the preview to lie about the gate.
const {
  identityBackingOf,
  mayPublishPrice,
} = require(path.join(backend, "dist/services/catalog/identityBacking.js"));

const USER = String(process.env.USER_ID || process.env.USER || "").trim();
const LIMIT = Number(process.env.LIMIT || 0);

const f = (n) => Number(n).toLocaleString("en-US");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const port = db.container("portfolio");

  const retry = async (fn, tries = 10) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e && e.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  console.log(`report-identity-backing-for-holdings  READ ONLY${USER ? `  user=${USER}` : "  ALL USERS"}\n`);

  const q = USER
    ? { query: "SELECT * FROM c WHERE c.userId=@u", parameters: [{ name: "@u", value: USER }] }
    : { query: "SELECT * FROM c", parameters: [] };
  const { resources: docs } = await retry(() => port.items.query(q, { maxItemCount: -1 }).fetchAll());

  // CF-HOLDINGS-IS-A-MAP: walk the map, print the count, refuse on zero.
  // A JOIN over it iterates nothing and reports a confident zero.
  const holdings = [];
  for (const d of docs) {
    const h = d.holdings || {};
    for (const k of Object.keys(h)) holdings.push({ user: d.userId, hid: h[k].id || k, ...h[k] });
  }
  console.log(`  ${f(docs.length)} portfolio docs, ${f(holdings.length)} holdings`);
  if (holdings.length === 0) { console.error("REFUSING: zero holdings walked — check the map traversal"); process.exit(1); }

  const take = LIMIT > 0 ? holdings.slice(0, LIMIT) : holdings;

  // Resolve every distinct slug ONCE. The catalog is asked in batches by id,
  // which is a point-lookup per row rather than a scan.
  const slugs = [...new Set(take.map((h) => h.hobbyiqCardId).filter(Boolean))];
  const rowsBySlug = new Map();
  for (let i = 0; i < slugs.length; i += 50) {
    const batch = slugs.slice(i, i + 50);
    const ps = batch.map((s, j) => ({ name: `@p${j}`, value: s }));
    const { resources } = await retry(() => cat.items.query({
      query: `SELECT c.id, c.source, c.retiredReason, c.identityUnverified FROM c
              WHERE c.id IN (${ps.map((p) => p.name).join(",")})`,
      parameters: ps,
    }, { maxItemCount: -1 }).fetchAll());
    for (const r of resources) {
      if (!rowsBySlug.has(r.id)) rowsBySlug.set(r.id, []);
      rowsBySlug.get(r.id).push(r);
    }
  }
  console.log(`  ${f(slugs.length)} distinct slugs, ${f(rowsBySlug.size)} found in the catalog\n`);

  const tally = {};
  const perUser = {};
  const acquisition = new Map();
  const rows = [];

  for (const h of take) {
    const slug = h.hobbyiqCardId || null;
    const catRows = slug ? (rowsBySlug.get(slug) || []) : [];
    const backing = identityBackingOf(slug, catRows);
    const verdict = mayPublishPrice(backing) ? "priced" : "withheld";
    tally[backing] = (tally[backing] || 0) + 1;
    (perUser[h.user] = perUser[h.user] || {})[verdict] = (perUser[h.user][verdict] || 0) + 1;

    if (verdict === "withheld") {
      // What needs acquiring, keyed the way a checklist is bought.
      const key = `${h.cardYear || h.year || "?"}|${h.setName || h.product || "?"}`;
      acquisition.set(key, (acquisition.get(key) || 0) + 1);
    }
    rows.push({
      user: h.user,
      id8: String(h.hid).slice(0, 8),
      card: [h.cardYear || h.year, h.setName || h.product, h.cardNumber, h.parallel, h.playerName]
        .filter(Boolean).join(" "),
      grade: [h.gradingCompany || h.gradeCompany, h.gradeValue].filter(Boolean).join(" "),
      fmv: h.fairMarketValue ?? null,
      rung: h.fmvRung || null,
      backing,
      verdict,
      reason: verdict === "withheld" ? "no-checklist-match" : null,
      sources: catRows.map((r) => r.source),
    });
  }

  console.log("  BACKING (all examined holdings):");
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(f(n)).padStart(6)}  ${k}`);
  }
  const priced = rows.filter((r) => r.verdict === "priced").length;
  console.log(`\n  ${f(priced)} priced / ${f(rows.length - priced)} withheld`);

  console.log("\n  PER USER:");
  for (const [u, v] of Object.entries(perUser).sort((a, b) => (b[1].priced || 0) + (b[1].withheld || 0) - (a[1].priced || 0) - (a[1].withheld || 0))) {
    console.log(`    ${u}  priced=${String(v.priced || 0).padStart(3)}  withheld=${String(v.withheld || 0).padStart(3)}`);
  }

  if (USER) {
    console.log(`\n  === ${USER} — every holding ===`);
    for (const r of rows.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.backing.localeCompare(b.backing))) {
      const money = r.fmv == null ? "-" : `$${r.fmv}`;
      console.log(`   ${r.id8}  ${r.verdict.padEnd(8)} ${r.backing.padEnd(18)} was=${money.padStart(10)}`
        + `  ${r.card}${r.grade ? ` [${r.grade}]` : ""}${r.sources.length ? `  src=${r.sources.join(",")}` : ""}`);
    }
  }

  console.log("\n  ACQUISITION QUEUE — the checklists these holdings need:");
  for (const [k, n] of [...acquisition.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }

  console.log("\n  (read-only: nothing was written and nothing was repriced)");
}

main().catch((e) => { console.error("FATAL", e && e.message); process.exit(1); });
