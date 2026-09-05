#!/usr/bin/env node
/**
 * CF-IF-KNOWN-WE-SHOULD-BE-ABLE-TO-FIGURE-IT-OUT (Drew, 2026-09-05).
 *
 *   "if known, we should be able to figure it out"
 *
 * A holding withheld for `no-checklist-match` whose card IS identifiable must
 * resolve without a human. Three pieces already existed and nothing joined
 * them:
 *
 *   #1784  marks self-derived identities identityUnverified and PRINTS an
 *          acquisition queue per (sport, year, setKey) -- a list nobody reads.
 *   D38    `ingest-universe-driver` ingests a product when handed exact
 *          manifest setNames in `titles`.
 *   R2     `rederive-holding-identity` (MODE=rederive, ids in `titles`)
 *          re-points a holding onto the row an ingest just landed.
 *          `reprice-user-holdings` then republishes the number.
 *
 * THIS SCRIPT IS THE JOIN, and it is the READ + MATCH + PLAN half of it. It
 * walks every user's holdings, keeps the ones the pricing gate withheld on
 * IDENTITY grounds, groups them into acquisition CELLS, ranks them, matches
 * each cell to a manifest entry that can serve it, and emits a PLAN.
 *
 * IT DISPATCHES NOTHING AND WRITES NOTHING. That is the design, not a missing
 * feature. The dispatch chain (driver report -> gate -> driver apply -> rederive
 * report -> gate -> rederive apply -> reprice) lives in
 * `.github/workflows/acquire-for-withheld-holdings.yml`, because only the
 * workflow holds the runner's GH token and only `gh run watch` can gate one
 * dispatch on the banner of the last. A script that shells out to `gh` from a
 * workstation would be a write path from a laptop, which
 * feedback_never_run_write_paths_locally_against_prod forbids.
 *
 * So this file has NO APPLY MODE AT ALL -- the same shape as its ancestor
 * `report-identity-backing-for-holdings.cjs`. `BACKFILL_APPLY=true` is read and
 * REFUSED loudly (exit 3) rather than ignored, so a dispatch that believed it
 * was applying something learns that it was not.
 *
 *   MODE=plan     (default) the ranked cells + their matched source, as text
 *   MODE=json     the same plan as one JSON document on stdout, for the
 *                 workflow to slice with jq. Nothing else goes to stdout in
 *                 this mode.
 *   TOP=n         the nightly cap -- how many cells the plan proposes (10)
 *   USER_ID=...   one user (default: every portfolio doc)
 *   OUT=path      also write the JSON plan to this file (the workflow's
 *                 artifact + ledger input)
 *
 * MEASURING SALES VOLUME. The rank's tie-break is the cell's sales volume, and
 * it is read per-cell with a bounded query under the verify cap, only for the
 * cells that survive grouping -- never as a corpus-wide aggregate.
 * CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS: an unbounded post-loop COUNT over
 * sold_comps is the exact shape that got run 33960686247 killed after it had
 * already reconciled clean.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { budget } = require(path.join(__dirname, "lib/runner-budget.cjs"));
const {
  ACTIONABLE_REASONS,
  groupIntoCells,
  rankCells,
  matchCellToManifest,
} = require(path.join(__dirname, "lib/withheld-acquisition-cells.cjs"));

const MODE = String(process.env.MODE || "plan").trim().toLowerCase();
const TOP = Math.max(1, Number(process.env.TOP || 10));
const USER = String(process.env.USER_ID || "").trim();
const OUT = String(process.env.OUT || "").trim();
const JSON_MODE = MODE === "json";

// THE REFUSAL. This lane is read-only by construction; a dispatch that asked
// for an apply is a misunderstanding worth failing on rather than absorbing.
if (/^(1|true|yes)$/i.test(String(process.env.BACKFILL_APPLY || ""))) {
  console.error(
    "REFUSING: acquire-for-withheld-holdings has no apply mode. It plans; the workflow "
    + "dispatches. Nothing here writes to Cosmos.",
  );
  process.exit(3);
}

// ── THE THREE CONSTANTS (CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS) ──────────
//
// The loop unit here is ONE CELL's sales count -- a single partitioned
// aggregate over one (sport, year, setKey) -- so this lane's sizing sits at the
// small end of the whitelist: it reads a few hundred documents, it does not
// sweep a corpus. The reserve is one minute (a page-sized unit reserves seconds
// to minutes, not the tens of minutes a whole-product lane needs) and the
// verify cap is five.
//
// They are declared as NAMED CONSTANTS rather than passed inline because
// tests/runnerBudgetMargin.test.ts enumerates the runner's whitelist and keeps
// only lanes whose source names `RUN_MINUTES`. A lane that calls `budget()`
// with literals is SKIPPED by that census -- it passes vacuously, and its
// worst case against the 150-minute step ceiling is never computed. Naming them
// is what puts this lane under the pin.
//
//   worst case = 45 + 1 + 5 + 1 startup = 52 minutes, 98 under the ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 45);
const RESERVE_MS = Number(process.env.RESERVE_MS || 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 5 * 60 * 1000);
const B = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const say = (...a) => { if (!JSON_MODE) console.log(...a); };

/** stderr in JSON mode so stdout stays a single parseable document. */
const note = (...a) => { if (JSON_MODE) console.error(...a); else console.log(...a); };

/** The driver's own key normalizer, when dist/ is built. Absent dist degrades
 *  to raw-key matching rather than crashing a nightly run -- the same fallback
 *  ingest-universe-driver.cjs takes. */
function loadCanonicalSetKey() {
  try {
    const { normalizeSetKey } = require(
      path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"),
    );
    return typeof normalizeSetKey === "function" ? normalizeSetKey : null;
  } catch {
    return null;
  }
}

/**
 * Read the identity fields off a holding, preferring the CLEANED ones.
 * feedback_use_normalized_fields_for_ref_lookups: the reference lookup uses
 * cleanFields, never the raw import text.
 */
function identityOf(h) {
  const clean = h.cleanFields || {};
  const meta = h.pricingSourceMeta || {};
  const withheld = meta.withheld || {};
  return {
    hid: h.id || h.hid || null,
    user: h.user || null,
    withheldReason: String(withheld.reason || ""),
    blockingId: withheld.blockingId || null,
    hobbyiqCardId: h.hobbyiqCardId || withheld.blockingId || null,
    sport: clean.sport || h.sport || null,
    cardYear: clean.cardYear ?? h.cardYear ?? clean.year ?? h.year ?? null,
    setKey: clean.setKey || h.setKey || null,
    subset: clean.subset || h.subset || null,
    setName: clean.setName || h.setName || h.product || null,
    playerName: clean.playerName || h.playerName || null,
    cardNumber: clean.cardNumber || h.cardNumber || null,
  };
}

/**
 * The identity a slug states, when the holding's own fields do not.
 *
 * A hiq slug IS the identity: `hiq:baseball:2026:bowman-chrome:cpa-vf:...`. A
 * holding withheld for `no-checklist-match` always has one (the gate read it to
 * refuse), so a cell is derivable even from a row whose import fields were
 * blank -- which is the difference between "needs a source" and "unaddressable".
 */
function identityFromSlug(slug) {
  const m = /^hiq:([a-z0-9-]+):(\d{4}):([a-z0-9-]+):/i.exec(String(slug || ""));
  if (!m) return null;
  return { sport: m[1].toLowerCase(), cardYear: Number(m[2]), setKey: m[3].toLowerCase() };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: {
      retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 },
    },
  }).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const port = db.container("portfolio");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

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

  note(`acquire-for-withheld-holdings  READ ONLY  MODE=${MODE}  TOP=${TOP}`
    + `${USER ? `  user=${USER}` : "  ALL USERS"}`);
  note(`  ${B.describe()}`);

  // ── (1) READ ────────────────────────────────────────────────────────────
  const q = USER
    ? { query: "SELECT * FROM c WHERE c.userId=@u", parameters: [{ name: "@u", value: USER }] }
    : { query: "SELECT * FROM c", parameters: [] };
  const { resources: docs } = await retry(
    () => port.items.query(q, { maxItemCount: -1 }).fetchAll(),
  );

  // CF-HOLDINGS-IS-A-MAP: walk the map, print the count, refuse on zero. A
  // JOIN over it iterates nothing and reports a confident zero.
  const holdings = [];
  for (const d of docs) {
    const h = d.holdings || {};
    for (const k of Object.keys(h)) holdings.push({ user: d.userId, ...h[k], id: h[k].id || k });
  }
  note(`  ${f(docs.length)} portfolio docs, ${f(holdings.length)} holdings walked`);
  if (holdings.length === 0) {
    console.error("REFUSING: zero holdings walked — check the map traversal");
    process.exit(1);
  }

  const withheld = holdings.map(identityOf).filter((h) => ACTIONABLE_REASONS.has(h.withheldReason));
  note(`  ${f(withheld.length)} withheld on identity grounds `
    + `(${[...ACTIONABLE_REASONS].join(" / ")})`);

  // The slug is the fallback identity: a holding the gate refused always has
  // one, so a blank import field is not an unaddressable card.
  for (const h of withheld) {
    if (h.sport && h.cardYear && h.setKey) continue;
    const fromSlug = identityFromSlug(h.hobbyiqCardId);
    if (!fromSlug) continue;
    h.sport = h.sport || fromSlug.sport;
    h.cardYear = h.cardYear || fromSlug.cardYear;
    h.setKey = h.setKey || fromSlug.setKey;
    h.identityFrom = "slug";
  }

  // ── identityUnverified catalog rows these holdings reference ────────────
  // #1784's label is the OTHER half of the population: a holding can price
  // today off a row lane (b) has just marked unverified, and that row is an
  // acquisition item before the gate ever darkens the holding. Read by id --
  // a point lookup per row, never a scan.
  const slugs = [...new Set(holdings.map((h) => h.hobbyiqCardId).filter(Boolean))];
  const unverifiedSlugs = new Set();
  for (let i = 0; i < slugs.length; i += 50) {
    const batch = slugs.slice(i, i + 50);
    const ps = batch.map((s, j) => ({ name: `@p${j}`, value: s }));
    const { resources } = await retry(() => cat.items.query({
      query: `SELECT c.id, c.identityUnverified, c.sport, c.cardYear, c.setKey FROM c
              WHERE c.id IN (${ps.map((p) => p.name).join(",")})`,
      parameters: ps,
    }, { maxItemCount: -1 }).fetchAll());
    for (const r of resources) if (r.identityUnverified) unverifiedSlugs.add(r.id);
  }
  note(`  ${f(unverifiedSlugs.size)} identityUnverified catalog rows referenced by holdings`);

  // A holding pointing at an identityUnverified row is queued even when the
  // gate has not (yet) withheld it -- the acquisition is the same work.
  for (const h of holdings) {
    if (!h.hobbyiqCardId || !unverifiedSlugs.has(h.hobbyiqCardId)) continue;
    if (withheld.some((w) => w.hid === h.id)) continue;
    const idn = identityOf(h);
    const fromSlug = identityFromSlug(h.hobbyiqCardId);
    idn.withheldReason = "identity-not-in-catalog";
    idn.identityFrom = "identityUnverified";
    idn.sport = idn.sport || fromSlug?.sport || null;
    idn.cardYear = idn.cardYear || fromSlug?.cardYear || null;
    idn.setKey = idn.setKey || fromSlug?.setKey || null;
    withheld.push(idn);
  }

  const { cells, unaddressable } = groupIntoCells(
    withheld.map((h) => ({ ...h, year: h.cardYear })),
  );
  note(`  ${f(cells.length)} acquisition cells, ${f(unaddressable.length)} unaddressable holdings`);

  // ── sales volume per cell, BOUNDED, under the verify cap ────────────────
  //
  // THE TIE-BREAK IS NOT WORTH A STALL. Measured on prod 2026-09-05: the READ
  // above resolves in seconds (12 docs, 131 holdings, 16 cells), and then each
  // per-cell `COUNT(1)` over sold_comps is a cross-partition aggregate on a
  // 16.3M-row container. Sixteen of them do not finish inside a sensible
  // window, and this number is ONLY the second sort key -- the ranking is
  // decided by holdings count, which is already in hand.
  //
  // So the counts are OPTIONAL and OFF by default. `SALES_VOLUME=1` asks for
  // them, the shared verify cap still bounds the whole phase, and an unread
  // count is recorded as UNREAD rather than as a zero
  // (feedback_never_dismiss_small_numbers_as_noise: a missing number is not a
  // small one). A cell whose volume is unread simply falls back to the cell-name
  // tie-break, which keeps the ordering total either way.
  const WANT_SALES = /^(1|true|yes)$/i.test(String(process.env.SALES_VOLUME || ""));
  if (!WANT_SALES) {
    note("  sales volume: NOT MEASURED (SALES_VOLUME=1 to measure) — "
      + "the ranking is by holdings count, which does not need it");
    for (const c of cells) c.salesVolumeRead = false;
  }
  const vt0 = Date.now();
  for (const c of WANT_SALES ? cells : []) {
    if (B.outOfClock()) {
      note(`  ${B.stoppedAtBudget()} — sales volume unread for the remaining cells`);
      break;
    }
    const n = await B.capped(vt0, `sales ${c.cell}`, () => retry(async () => {
      const { resources } = await pool.items.query({
        query: `SELECT VALUE COUNT(1) FROM c
                WHERE c.sport=@sp AND c.cardYear=@y AND c.setKey=@k`,
        parameters: [
          { name: "@sp", value: c.sport },
          { name: "@y", value: c.year },
          { name: "@k", value: c.setKey },
        ],
      }, { maxItemCount: -1 }).fetchAll();
      return Number(resources[0] || 0);
    }));
    // null is UNCONFIRMED, never zero -- it must not silently demote a cell in
    // the ranking, so it is recorded as such and sorts as 0 only for ordering.
    c.salesVolume = n === null ? 0 : n;
    c.salesVolumeRead = n !== null;
  }

  // ── (2) MATCH ───────────────────────────────────────────────────────────
  const manifestPath = path.join(backend, "data/ingest-universe.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`FATAL: ${manifestPath} is missing — there is no manifest to match against`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (entries.length === 0) {
    console.error("FATAL: the manifest holds no entries — refusing to report every cell as sourceless");
    process.exit(1);
  }
  const canonicalSetKey = loadCanonicalSetKey();
  note(`  manifest: ${f(entries.length)} entries`
    + `${canonicalSetKey ? "" : "  (dist/ absent — raw-key matching only)"}`);

  const ranked = rankCells(cells);
  const planned = [];
  for (const c of ranked) {
    const { matches, corroborated } = matchCellToManifest(c, entries, { canonicalSetKey });
    planned.push({
      cell: c.cell,
      sport: c.sport,
      year: c.year,
      setKey: c.setKey,
      subsets: c.subsets,
      holdings: c.holdings,
      holdingIds: c.holdingIds,
      users: c.users,
      slugs: c.slugs,
      reasons: c.reasons,
      salesVolume: c.salesVolume,
      salesVolumeRead: c.salesVolumeRead !== false,
      // A cell with no manifest entry is REPORTED, never guessed. This list is
      // the input to Drew's discovery program -- the sets we own cards in and
      // have no way to acquire.
      needsSource: matches.length === 0,
      source: matches.length ? matches[0] : null,
      alternates: matches.slice(1, 4),
      corroborated,
    });
  }

  const actionable = planned.filter((p) => !p.needsSource).slice(0, TOP);
  const needsSource = planned.filter((p) => p.needsSource);

  const plan = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    scope: { user: USER || null, top: TOP },
    counts: {
      portfolioDocs: docs.length,
      holdings: holdings.length,
      withheld: withheld.length,
      cells: cells.length,
      matched: planned.length - needsSource.length,
      needsSource: needsSource.length,
      unaddressable: unaddressable.length,
    },
    // THE NIGHTLY CAP, applied here rather than in the workflow: the plan is
    // what the workflow executes, so the cap is auditable in the artifact.
    tonight: actionable,
    needsSourceCells: needsSource.slice(0, 50),
    unaddressable: unaddressable.slice(0, 50),
  };

  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    say("\n  RANKED CELLS — holdings first, sales volume second:");
    say(`    ${"holdings".padStart(8)} ${"sales".padStart(9)}  cell`);
    for (const p of planned.slice(0, Math.max(TOP, 20))) {
      const src = p.needsSource
        ? "NEEDS A SOURCE"
        : `${p.source.lane}: ${p.source.setName}${p.corroborated ? "  (corroborated)" : ""}`;
      say(`    ${String(f(p.holdings)).padStart(8)} ${String(f(p.salesVolume)).padStart(9)}  `
        + `${p.cell.padEnd(46)}  ${src}`);
    }
    say(`\n  TONIGHT (cap ${TOP}): ${actionable.length} cells`);
    for (const p of actionable) {
      say(`    ${p.cell}  -> ${p.source.lane}  titles="${p.source.setName}"`
        + `  holdings=${p.holdings}  users=${p.users.length}`);
    }
    if (needsSource.length) {
      say(`\n  NEEDS A SOURCE (${f(needsSource.length)}) — no manifest entry serves these:`);
      for (const p of needsSource.slice(0, 20)) {
        say(`    ${String(f(p.holdings)).padStart(6)}  ${p.cell}`);
      }
    }
    if (unaddressable.length) {
      say(`\n  UNADDRESSABLE (${f(unaddressable.length)}) — no (sport, year, setKey) could be read:`);
      for (const u of unaddressable.slice(0, 10)) {
        say(`    ${String(u.holdingId).slice(0, 8)}  ${JSON.stringify(u.have)}`);
      }
    }
  }

  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), `${JSON.stringify(plan, null, 2)}\n`);
    note(`\n  plan written to ${OUT}`);
  }

  // The banner. It is REPORT-ONLY and says so in the words the workflow greps.
  note(`\n  RECONCILED  YES  cells=${f(cells.length)} matched=${f(plan.counts.matched)} `
    + `needs-source=${f(plan.counts.needsSource)} tonight=${f(actionable.length)}`);
  note("  (read-only: nothing was written, nothing was dispatched, nothing was repriced)");
}

main().catch((e) => { console.error("FATAL", e && e.message); process.exit(1); });
