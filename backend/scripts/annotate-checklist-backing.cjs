#!/usr/bin/env node
/**
 * CF-THE-CHECKLIST-IS-THE-SPINE (Drew, 2026-08-27: "I want checklist to be
 * driven then sales match to it. not sales derived").
 *
 * Stamps every sales-derived catalog row with WHAT A CHECKLIST SAYS ABOUT IT,
 * so a later matcher can prefer confirmed identities instead of treating a row
 * the sales minted as equal evidence to a printed checklist.
 *
 * THIS ANNOTATES. IT DELETES NOTHING AND RE-SLUGS NOTHING.
 *
 * That restraint is the point. `unconfirmed` does NOT mean the card is fake --
 * it overwhelmingly means we have not acquired that product's checklist yet.
 * 2019 Bowman Paper is a real product whether or not we hold its checklist, and
 * a pass that deleted or unmatched those rows would destroy real cards and
 * strand their sales. So the output is a LABEL and, equally, an acquisition
 * work list.
 *
 * FOUR STATES, and the boundaries between them are the whole design:
 *
 *   checklist-confirmed  a checklist lists this card AND this parallel
 *   card-confirmed       a checklist lists this card; the PARALLEL is not on it
 *   family-match         not in THIS setKey, but listed under a related one
 *   unconfirmed          no checklist in the family lists this card at all
 *
 * `family-match` exists because the first cut of this pass called 2024 Topps
 * 86.8% unconfirmed, which was false: those cards' checklists sit under
 * `topps-series-1` and `topps-series-2`, and a lookup scoped to `topps` cannot
 * see them. The family is gathered with STARTSWITH(setKey, 'topps-'), which is
 * index-friendly, and the matched setKeys are RECORDED rather than adopted.
 *
 * Recorded, not adopted, because the same shape has already been a trap once
 * today. Sampling pairs where a derived setKey had no checklist row, the
 * checklist was unanimous for `bowman-chrome -> bowman` and
 * `bowman-chrome-sapphire -> bowman` -- unanimous only because we are MISSING
 * the Chrome and Sapphire checklists, so the sole row carrying that number is
 * the paper one. Adopting it merges different cards irreversibly. So this pass
 * labels the disagreement and leaves the ruling to a human.
 *
 * Card-level confirmation is keyed on year + setKey + cardNumber + player,
 * which is Drew's stated standard. Player is load-bearing rather than
 * decorative: CPA-AN is BOTH Angel Nunez and Alejandro Nunez, so a card number
 * alone is not an identity.
 *
 * WHY PARALLEL DISAGREEMENT DOES NOT DEMOTE THE CARD. Measured on baseball,
 * 86.6% of derived parallels are absent from the checklist for their card --
 * but reading the comparisons, a large share is OUR checklist being thin, not
 * the sale being wrong:
 *
 *     "Refractor"      not in [base cards, base]
 *     "Base"           not in [orange, green pattern, sky blue, yellow]
 *     "Purple Pattern" not in ["", neon green, fuchsia, orange]
 *
 * The second lists no Base at all; the third carries an EMPTY STRING as a
 * parallel name. Demoting on that evidence would demote nearly everything on
 * the strength of our own gaps. So parallel disagreement is RECORDED as
 * card-confirmed and never collapsed into unconfirmed.
 *
 * ONE PRODUCT AT A TIME, which is what makes it affordable. A product's whole
 * checklist fits in memory, so its derived rows cost two queries rather than
 * one query per row -- the same trap that held the checklist ingest to 216
 * rows/min.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SPORT=baseball
 *   SLOT / SLOTS  CONCURRENCY=48  RUN_MINUTES=140  LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// The workflow passes the existing `sports` input as SPORTS; accept both so
// non-baseball dispatches need no new plumbing.
const SPORT = process.env.SPORT || process.env.SPORTS || "baseball";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
const LIMIT = Number(process.env.LIMIT || 0);
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "annotate-checklist-backing" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "-");

/** Finds sale-minted rows cheaply. catalogAuthorityOf remains the arbiter. */
const DERIVED = "(c.source='ingest-auto-seed' OR STARTSWITH(c.source,'catalog-explode') " +
  "OR STARTSWITH(c.source,'sold-comps-stub') OR STARTSWITH(c.source,'sales-derived') " +
  "OR STARTSWITH(c.source,'tree-builder'))";

/**
 * Resume, and the relaunch's termination condition in one predicate.
 *
 * Without it a budget stop sends the next run back to the first product and the
 * fleet re-annotates the same head forever while every run stays green. With
 * it, each run takes only what is still unannotated, and a run that scans zero
 * rows IS the signal that the slot is finished.
 */
// REANNOTATE arrives as its own env or through the runner's mode input,
// the same plumbing the map redo uses.
const REANNOTATE = String(process.env.REANNOTATE || "") === "true" || String(process.env.MODE || "").toLowerCase() === "reannotate";
const PENDING = REANNOTATE ? "" : " AND NOT IS_DEFINED(c.checklistBacking)";

const norm = (s) => String(s ?? "").toLowerCase().trim();
const cardKey = (n, p) => `${norm(n)}|${norm(p)}`;

/**
 * CF-PLAYER-CONTAINMENT (Drew, 2026-08-28: "how can we get a better baseball
 * match"). 65% of sampled unconfirmed rows were player-KEY-only misses:
 * derived slugs carry variation glue ("joey-votto-bat-knob", "adrian-
 * beltre-hl") that exact equality can never meet. Containment with a length
 * guard (>= 5 chars, so "jr" never bridges two people) matches the holdings
 * resolver's standard. CPA-AN stays two people: "angel-nunez" is not
 * contained in "alejandro-nunez".
 */
const playerAgrees = (a, b) => {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  // CF-TWO-TOKENS-TO-BRIDGE (2026-08-28, scorecard v2 spot-check). The
  // 5-char guard let "limited-to-999-copies-exclusive-to-packs-sold-at-
  // walmart" get card-confirmed off a short slug found inside garbage. A
  // bridge now needs a first AND last name: the contained slug must carry at
  // least two tokens. "payton-tolle" bridges; "walmart" and "rose" never do.
  const tokens = shorter.split("-").filter(Boolean);
  if (tokens.length < 2 || shorter.length < 7) return false;
  // and it must match on token boundaries, not mid-word
  return (`-${longer}-`).includes(`-${shorter}-`);
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("card_catalog");

  const retry = async (fn, tries = 12) => {
    let wait = 1000;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        if (!/request rate is too large|429/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  // Products, and their true sizes, BEFORE splitting the work. A shard axis
  // that is not measured is how 89% of a retire once landed on one worker.
  const { resources: prods } = await retry(() => cat.items.query({
    query: `SELECT c.year, c.setKey, COUNT(1) AS n FROM c
            WHERE c.sport=@s AND ${DERIVED}${PENDING} GROUP BY c.year, c.setKey`,
    parameters: [{ name: "@s", value: SPORT }],
  }).fetchAll());

  const all = prods.filter((p) => p.setKey && p.year)
    .sort((a, b) => b.n - a.n || `${a.year}${a.setKey}`.localeCompare(`${b.year}${b.setKey}`));
  // Greedy longest-first onto the least-loaded slot: deterministic, so every
  // worker computes the same assignment and takes only its own.
  const load = new Array(Math.max(1, SLOTS)).fill(0);
  const owner = new Map();
  for (const p of all) {
    const i = load.indexOf(Math.min(...load));
    owner.set(`${p.year}|${p.setKey}`, i);
    load[i] += p.n;
  }
  const mine = all.filter((p) => owner.get(`${p.year}|${p.setKey}`) === SLOT);
  const mineRows = mine.reduce((s, p) => s + p.n, 0);
  console.log(`slot ${SLOT}/${SLOTS}  sport=${SPORT}  ${APPLY ? "APPLY" : "REPORT ONLY"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${f(all.length)} products, ${f(all.reduce((s, p) => s + p.n, 0))} derived rows total`);
  console.log(`  this slot owns ${f(mine.length)} products, ${f(mineRows)} rows\n`);

  let scanned = 0, written = 0, failed = 0, notReached = 0, noChecklistProduct = 0;
  const state = { "checklist-confirmed": 0, "card-confirmed": 0, "family-match": 0, unconfirmed: 0 };
  const gaps = new Map();
  const familyPairs = new Map();
  let stopReason = null;

  for (const p of mine) {
    if (stopReason) break;

    // The product's checklist AND its set family, once. STARTSWITH uses the
    // range index; a function-wrapped or field-to-field predicate here would
    // full-scan 31.2M documents per product.
    const cards = new Set(), pars = new Map(), family = new Map(), byNumber = new Map();
    let cToken;
    do {
      const page = await retry(() => cat.items.query({
        query: `SELECT c.cardNumber, c.playerSlug, c.parallel, c.setKey, c.source FROM c
                WHERE c.sport=@s AND c.year=@y AND (c.setKey=@k OR STARTSWITH(c.setKey, @kp))`,
        parameters: [{ name: "@s", value: SPORT }, { name: "@y", value: p.year },
          { name: "@k", value: p.setKey }, { name: "@kp", value: `${p.setKey}-` }],
      }, { maxItemCount: 2000, continuationToken: cToken }).fetchNext());
      cToken = page.continuationToken;
      for (const r of page.resources) {
        if (catalogAuthorityOf(r.source) !== "checklist") continue;
        const k = cardKey(r.cardNumber, r.playerSlug);
        const numKey = norm(r.cardNumber);
        if (!byNumber.has(numKey)) byNumber.set(numKey, new Set());
        byNumber.get(numKey).add(norm(r.playerSlug));
        if (r.setKey === p.setKey) {
          cards.add(k);
          if (!pars.has(k)) pars.set(k, new Set());
          pars.get(k).add(norm(r.parallel));
        } else {
          if (!family.has(k)) family.set(k, new Set());
          family.get(k).add(r.setKey);
        }
      }
    } while (cToken);
    if (!cards.size && !family.size) {
      noChecklistProduct++;
      gaps.set(`${p.year} ${p.setKey}`, p.n);
    }

    let dToken;
    do {
      const page = await retry(() => cat.items.query({
        query: `SELECT c.id, c.cardNumber, c.playerSlug, c.parallel FROM c
                WHERE c.sport=@s AND c.year=@y AND c.setKey=@k AND ${DERIVED}${PENDING}`,
        parameters: [{ name: "@s", value: SPORT }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey }],
      }, { maxItemCount: 500, continuationToken: dToken }).fetchNext());
      dToken = page.continuationToken;

      for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
        await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (d) => {
          scanned++;
          const k = cardKey(d.cardNumber, d.playerSlug);
          let backing, familyIn = null;
          const numK = norm(d.cardNumber);
          const exactHit = cards.has(k);
          const containHit = !exactHit && byNumber.has(numK) && [...byNumber.get(numK)].some((cp) => playerAgrees(cp, d.playerSlug));
          if (exactHit || containHit) {
            backing = pars.get(k)?.has(norm(d.parallel)) ? "checklist-confirmed" : "card-confirmed";
          } else if (family.has(k)) {
            backing = "family-match";
            familyIn = [...family.get(k)].sort();
            const pair = `${p.setKey}  ->  ${familyIn.join(" | ")}`;
            familyPairs.set(pair, (familyPairs.get(pair) ?? 0) + 1);
          } else {
            backing = "unconfirmed";
          }
          state[backing]++;
          if (!APPLY) return;
          try {
            const ops = [
              { op: "set", path: "/checklistBacking", value: backing },
              { op: "set", path: "/checklistBackingAt", value: new Date().toISOString() },
            ];
            // The candidate sets, for the ruling. Never applied here.
            if (familyIn) ops.push({ op: "set", path: "/checklistFamilySetKeys", value: familyIn });
            // CF-PATCH-BY-PARTITION (2026-08-29). 3,391 baseball rows have cardId !== id;
            // patching with id as the key 404'd silently, they stayed unstamped, and the
            // relaunch re-judged the same rows every 5 minutes.
            await retry(() => cat.item(d.id, d.cardId ?? d.id).patch(ops));
            written++;
          } catch (e) {
            if (e.code === 404) return;   // moved by a concurrent pass; not a failure
            failed++;
            if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 62)}: ${String(e.message || e).slice(0, 60)}`);
          }
        }));
        const processed = Math.min(i + CONCURRENCY, page.resources.length);
        if (LIMIT && scanned >= LIMIT) { stopReason = "limit"; notReached += page.resources.length - processed; break; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += page.resources.length - processed; break; }
      }
      if (stopReason) break;
    } while (dToken);

    process.stderr.write(`\r  ${p.year} ${p.setKey}   scanned=${f(scanned)}   `);
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  derived rows scanned         ${f(scanned)}`);
  for (const [k, v] of Object.entries(state)) {
    console.log(`  ${k.padEnd(28)} ${String(f(v)).padStart(9)}   ${pct(v, scanned)}`);
  }
  console.log(`  annotated                    ${f(written)}`);
  console.log(`  failed                       ${f(failed)}`);
  console.log(`\n  products with NO checklist in the family: ${f(noChecklistProduct)}`);
  console.log(`  These are an ACQUISITION list, not fake cards:`);
  for (const [k, n] of [...gaps].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(f(n)).padStart(8)} rows   ${k}`);
  }
  if (familyPairs.size) {
    console.log(`\n  family matches — the card is on a checklist under a RELATED set.`);
    console.log(`  Recorded for a ruling, never adopted: adopting the analogous`);
    console.log(`  bowman-chrome -> bowman would merge two different cards.`);
    for (const [k, n] of [...familyPairs].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${String(f(n)).padStart(8)} rows   ${k.slice(0, 92)}`);
    }
  }
  if (APPLY) {
    reportWrites({
      job: "annotate-checklist-backing", intended: scanned,
      written, skipped: notReached, failed,
    });
  }
}

module.exports = { cardKey };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
