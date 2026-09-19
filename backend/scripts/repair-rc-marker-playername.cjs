#!/usr/bin/env node
/**
 * repair-rc-marker-playername.cjs -- a rookie marker inside the player cell
 * is not the name.
 *
 * CF-A-ROOKIE-MARKER-IS-NOT-PART-OF-THE-NAME (2026-09-19). Checklist sources
 * (baseballcardpedia, cardboardconnection, checklistinsider, tcdb,
 * drew-rulings CSVs) write the rookie fact INSIDE the player cell -- "Jonah
 * Tong RC" -- so playerSlugify minted `jonah-tong-rc`. The SIBLING row of the
 * SAME card number that omits the marker carries the clean slug: one card
 * split across two player identities. A prior census measured >=33,000
 * card_catalog rows across ~40 product-years with a playerSlug ending `-rc`
 * (2026 topps 10,821; 2026 topps-chrome 2,885; 2022 bowman 1,826; 2024 bowman
 * 1,910; 2019 topps-update 1,734; 2015-2017 topps ~4,000; hockey
 * upper-deck-series-1/2 2019-2024 ~5,800; ...).
 *
 * A SEPARATE, EARLIER commit (#2292, 2026-09-19) fixed convertBeckettChecklistXlsx.cjs
 * at the SOURCE so it never again stamps " RC" into a CSV `player` cell; this
 * script is the OTHER HALF, for rows already stored -- from Beckett CSVs
 * ingested before that fix landed, and from the other sources above, which
 * write the marker directly into their own scraped text and are unaffected
 * by a Beckett-only converter change.
 *
 * THE ID DOES NOT CHANGE. The slug carries no player segment
 * (CF-THE-ID-CARRIES-THE-PRODUCT), so this is a FIELD PATCH through
 * patchCatalogRowFields, never moveCatalogRow -- a raw container.patch() is
 * not allowed here (CF-GUARD-THE-CATALOG-WRITE-CONTRACT). playerName is
 * recomputed with the fixed cleanPlayerName, playerSlug with playerSlugify's
 * canonical equivalent (hobbyIqCardId.slugify -- the same function the
 * matcher keys the sale side with), and searchText/displayName/searchTokens
 * are rebuilt through catalogRowOps.rebuildSearchFields (never a raw patch --
 * CF-DERIVED-FIELDS-ARE-NEVER-HAND-ROLLED). id/cardId/hobbyiqCardId are
 * UNPATCHABLE by the helper itself and are never in the patch set. The old
 * value survives on `playerNameBefore` (patchCatalogRowFields's own shadow).
 *
 * ONLY THE RC FAMILY (" RC", " RC*", " (RC)") IS TOUCHED, mirroring
 * cleanPlayerName's own scope. TC/UER/SP/SSP/RR/DP/tier-letter rows are left
 * exactly as they are -- this script calls the same cleanPlayerName the fix
 * PR shipped, so its scope is inherited, never re-declared here.
 *
 * SCOPE: required sport + years (comma-separated `sport:year` cells, matching
 * the runner's SCOPE convention used by repair-clc-signature-unsigned),
 * optional setKey filter (comma-separated, via the runner's `titles` input --
 * workflow_dispatch is at its input cap; see backfill-runner.yml). The
 * runner's inherited defaults ('', 'refractor', 'all') are REFUSED, never
 * treated as "every cell" -- a whole-source write needs its own name
 * (feedback_a_whole_source_retire_needs_its_name). Each cell is queried with
 * equality filters on sport/year (+ optional setKey) AND
 * `ENDSWITH(c.playerSlug, '-rc')` -- never a cross-partition COUNT/GROUP BY.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write
 *      (report only by default); SCOPE REQUIRED, comma-separated `sport:year`
 *      cells; SET_KEYS optional comma-separated setKey filter; CONCURRENCY;
 *      LIMIT; SLOT/SLOTS (sha1(id) shards, opt-in via SHARD=true for slot 0);
 *      RUN_MINUTES=110.
 */
"use strict";

const path = require("path");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 12));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repair-rc-marker-playername" });
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// THE SCOPE. `sport:year`, and the runner's inherited default is REFUSED --
// a whole-source write refuses without its name.
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z]+:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// Optional setKey narrowing, riding the runner's `titles` input (workflow
// caps at 25 inputs and 24 are already used -- see BCP_TITLES in
// backfill-runner.yml for the same convention on rekey-product-setkey).
const SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function forEachPage(container, spec, onPage, pageSize = 500) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** The candidate predicate for one cell, shared by the scan and the
 *  verify-by-read so the two cannot drift. Equality on sport/year (+ optional
 *  setKey), ENDSWITH on playerSlug -- never a cross-partition COUNT/GROUP BY. */
function candidateSpec(sport, year, setKeys) {
  const parameters = [
    { name: "@sport", value: sport },
    { name: "@year", value: year },
  ];
  let setKeyClause = "";
  if (setKeys.length) {
    setKeyClause = ` AND (${setKeys.map((_, i) => `c.setKey = @sk${i}`).join(" OR ")})`;
    setKeys.forEach((sk, i) => parameters.push({ name: `@sk${i}`, value: sk }));
  }
  return {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c.sport, c.year, c.cardYear,
                   c.setKey, c.setName, c.cardNumber, c.playerName, c.playerSlug,
                   c.parallel, c.parallelSlug, c.printRun, c.subsetName, c.gradeTier, c.searchTokens
            FROM c
            WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND IS_STRING(c.playerSlug) AND ENDSWITH(c.playerSlug, '-rc')${setKeyClause}`,
    parameters,
  };
}

/**
 * Pure: the patch a row needs, or null when it is out of scope for a repair
 * (no name, or the cleaned name does not change anything -- the `-rc` slug
 * was stale, or was never really from the RC marker in the first place).
 * `deps` are the canonical helpers (dist at runtime, src in the test) so
 * this file never re-spells cleanPlayerName / slugify / rebuildSearchFields
 * (CF-DERIVED-FIELDS-ARE-NEVER-HAND-ROLLED).
 */
function planRepair(row, deps) {
  const before = typeof row.playerName === "string" ? row.playerName : null;
  if (before === null || !before.trim()) return { action: "skip", reason: "empty playerName" };
  const after = deps.cleanPlayerName(before);
  if (!after) return { action: "skip", reason: "cleaned name is empty" };
  if (after === before) return { action: "skip", reason: "cleanPlayerName made no change (stale -rc slug, or not the RC-marker shape)" };
  const playerSlug = deps.slugify(after);
  if (playerSlug === String(row.playerSlug ?? "")) return { action: "skip", reason: "playerSlug unchanged after clean" };
  const year = typeof row.year === "number" ? row.year : (typeof row.cardYear === "number" ? row.cardYear : null);
  const fields = deps.rebuildSearchFields({ ...row, year, playerName: after });
  const existingTokens = Array.isArray(row.searchTokens) ? row.searchTokens.map((t) => String(t).toLowerCase()).filter(Boolean) : [];
  const searchTokens = [...new Set([...existingTokens, ...fields.searchTokens])];
  return {
    action: "repair",
    before,
    after,
    playerSlug,
    graded: row.gradeTier !== undefined && row.gradeTier !== null,
    patch: {
      playerName: after,
      playerSlug,
      searchText: fields.searchText,
      displayName: fields.displayName,
      searchTokens,
    },
  };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPAIR: a rookie marker inside the player cell is not the name (RC family)");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like baseball:2026 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to repair, as sport:year.");
    console.error("       There is no 'all' for this lane -- a report over an unnamed scope is");
    console.error("       how an apply over an unnamed scope gets authorised, and this defect");
    console.error("       spans ~40 product-years across multiple sports.");
    console.error("       Dispatch with -f scope=baseball:2026 (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { rebuildSearchFields, patchCatalogRowFields } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
  const { cleanPlayerName } = require(path.join(backend, "dist/services/portfolioiq/cardCatalog.service.js"));
  const { slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const deps = { rebuildSearchFields, cleanPlayerName, slugify };

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  if (SET_KEYS.length) console.log(`  setKey filter    ${SET_KEYS.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");
  console.log("  only the RC family (\" RC\", \" RC*\", \" (RC)\") is touched -- TC/UER/SP/SSP/RR/DP/tier-letter");
  console.log("  rows are left exactly as they are, because cleanPlayerName itself leaves them alone.");
  console.log("  id/cardId/hobbyiqCardId never change -- this is a field patch, never a move.");
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, repaired: 0, graded: 0, skipped: 0, failed: 0, notReached: 0,
  };
  const skipReasons = new Map();
  const bySource = new Map();
  const byCell = new Map();
  const examples = [];
  const failures = [];
  let stoppedAtBudget = false;

  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);
    const spec = candidateSpec(sport, year, SET_KEYS);

    const rows = [];
    await forEachPage(cat, spec, async (page) => {
      for (const r of page) {
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; return false; }
        s.scanned++;
        if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
        rows.push(r);
      }
      return true;
    });

    if (!byCell.has(cell)) byCell.set(cell, { repaired: 0, skipped: 0 });
    const cellStats = byCell.get(cell);

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached += rows.length - i; break; }
      if (LIMIT && s.repaired >= LIMIT) { s.notReached += rows.length - i; break; }
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (row) => {
        const plan = planRepair(row, deps);
        if (plan.action === "skip") {
          s.skipped++;
          cellStats.skipped++;
          bump(skipReasons, plan.reason);
          return;
        }
        if (examples.length < 20) {
          examples.push(`  ${JSON.stringify(plan.before)} -> ${JSON.stringify(plan.after)}  slug=${plan.playerSlug}  [${row.source}]  ${row.id}`);
        }
        try {
          const res = await retry(() => patchCatalogRowFields(cat, String(row.id), row.cardId ?? row.id, plan.patch, {
            retry,
            dryRun: !APPLY,
          }));
          if (res.action === "patch") {
            s.repaired++;
            cellStats.repaired++;
            if (plan.graded) s.graded++;
            bump(bySource, row.source ?? "?");
          } else {
            // noop: patchCatalogRowFields's own idempotency check found nothing
            // to change (a concurrent heal, or the row 404'd). Declared as
            // skipped, never as a silent success.
            s.skipped++;
            cellStats.skipped++;
            bump(skipReasons, "patchCatalogRowFields returned noop");
          }
        } catch (e) {
          s.failed++;
          if (failures.length < 50) failures.push({ id: row.id, error: String(e?.message ?? e).slice(0, 200) });
          if (s.failed <= 5) console.error(`  FAILED ${row.id}: ${String(e?.message ?? e).slice(0, 100)}`);
        }
      }));
    }
  }

  console.log("");
  console.log(`scanned ${f(s.scanned)} candidate rows (playerSlug ENDSWITH '-rc')${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  ${APPLY ? "REPAIRED" : "would repair"}  ${f(s.repaired)}   <- ${f(s.graded)} of them graded children (tokens kept, name/slug/text healed)`);
  console.log(`  skipped          ${f(s.skipped)}`);
  console.log(`  failed           ${f(s.failed)}`);
  if (s.notReached) console.log(`  not reached      ${f(s.notReached)}`);

  const actionable = [...byCell.entries()].filter(([, v]) => v.repaired > 0).sort((a, b) => b[1].repaired - a[1].repaired);
  if (actionable.length) {
    console.log(`\n  by cell:`);
    for (const [k, v] of actionable) console.log(`    ${String(v.repaired).padStart(7)}  ${k}${v.skipped ? `   (${v.skipped} skipped)` : ""}`);
  }
  if (bySource.size) {
    console.log(`\n  by source:`);
    for (const [k, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(7)}  ${k}`);
  }
  if (skipReasons.size) {
    console.log(`\n  skip reasons:`);
    for (const [k, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(7)}  ${k}`);
  }
  if (examples.length) { console.log(`\n  examples:`); for (const e of examples) console.log(e); }
  if (failures.length) {
    console.log(`\n  FAILURES (${failures.length}):`);
    for (const fl of failures.slice(0, 20)) console.log(`    ${fl.id}: ${fl.error}`);
  }

  // -- THE RECONCILIATION -----------------------------------------------------
  // intended = written + skipped + failed. Every refusal (skip reason) is
  // named above so a wrong skip is visible, not absorbed into a blind total.
  const written = s.repaired;
  const skipped = s.skipped + s.otherShard + s.notReached;
  const intended = s.scanned;
  console.log("");
  console.log(`  reconciled: intended ${f(intended)} = written ${f(written)} + skipped ${f(skipped)} + failed ${f(s.failed)}`
    + `   [residual ${f(intended - written - skipped - s.failed)}]`);
  if (APPLY) {
    reportWrites({
      job: "repair-rc-marker-playername",
      intended, written, skipped,
      failed: Math.max(s.failed, intended - written - skipped - s.failed),
    });
  }

  // -- VERIFY BY READ, under the cap -------------------------------------------
  if (APPLY) {
    const vt0 = Date.now();
    let anyUnread = false;
    for (const cell of SCOPE_CELLS) {
      const [sport, yearStr] = cell.split(":");
      const spec = candidateSpec(sport, Number(yearStr), SET_KEYS);
      const left = await CLOCK.capped(vt0, `verify ${cell}`, (signal) => cat.items.query(
        { query: `SELECT VALUE COUNT(1) FROM (${spec.query})`, parameters: spec.parameters },
        { maxItemCount: 1, abortSignal: signal },
      ).fetchAll().then((r) => r.resources[0]));
      if (left === null) anyUnread = true;
      console.log(`  VERIFY BY READ ${cell}: candidates still matching '-rc': ${left === null ? "UNCONFIRMED (verify cap)" : f(left)}  (skipped rows stay, by design)`);
    }
    if (anyUnread) console.log(CLOCK.unreadNote ? CLOCK.unreadNote() : "  (verify cap reached on at least one cell -- treat as UNREAD, not zero)");
  }

  console.log("");
  // The runner's relaunch action greps `^  REPAIRED +[0-9,]+` (the SAME shape
  // repair-trailing-comma-player-names and repair-isauto-from-cardnumber-
  // catalog print) -- CF-RELAUNCH-ONLY-ON-BUDGET (#1361). The words after the
  // number are free; the count must come first.
  console.log(`  REPAIRED ${f(written)}   <- clean playerName/playerSlug (RC-family marker stripped)`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.failed) {
    console.error(`::error::${f(s.failed)} row(s) failed patchCatalogRowFields -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = { planRepair, candidateSpec, INHERITED_SCOPES, CELL_RE };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
