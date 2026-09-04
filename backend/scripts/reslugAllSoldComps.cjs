// CF-RESLUG-ALL-SOLD-COMPS (Drew, 2026-08-10). Bring every sold_comps
// row's hobbyiqCardId in line with the current slug generator.
//
// Motivation: the slug generator is the doctrine. Any row whose stored
// slug doesn't equal what computeHobbyIqCardId() would produce today is
// wrong by definition. Drew: "we need them to be correct and match" —
// this closes the loop for every historical row across every rule
// (chrome-prefix override, base-is-refractor, subset collapse,
// parallel canonicalization, etc.).
//
// Strategy:
//   - Walk every sold_comps row with the fields the generator needs
//   - Recompute canonical slug via the compiled dist generator
//   - PATCH hobbyiqCardId when it differs
//   - Skip rows where inputs are insufficient (missing sport/year/#/...)
//   - Log every distinct rewrite pattern for audit
//   - 429-safe with retry
//
// Env:
//   COSMOS_CONNECTION_STRING     required
//   APPLY=true                   write (default dry-run)
//   CONCURRENCY=16               parallel patches
//   MAX_ROWS                     cap for smoke tests
//   SHARD_HEX="0,1,2,3"          contentHash first-char shard filter
//                                (16 shards; run 4 workers with disjoint sets)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

// The runner sets BACKFILL_APPLY / RESLUG_APPLY, never APPLY. Reading only
// APPLY would make this dry-run forever under the workflow while looking
// like it had run -- the same trap reslug-tcg-out-of-sports-namespace hit.
const APPLY = String(process.env.BACKFILL_APPLY || process.env.RESLUG_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 16));
const MAX_ROWS = Number(process.env.MAX_ROWS || 0);
const SHARD_HEX = (process.env.SHARD_HEX || "").split(",").map(s => s.trim()).filter(Boolean);
// Ask the catalog when the prefix override disagrees with the row's own text.
// RESOLVE=false restores the pure-prefix behaviour for comparison.
const RESOLVE = String(process.env.RESOLVE ?? "true") !== "false";

// CF-RESLUG-EXITS-BEFORE-THE-CEILING (Drew, 2026-08-27: "and fix the workflow
// after"). The workflow kills the step at 150 minutes and this script had
// neither a budget nor a relaunch, so a shard that outran the ceiling was
// SIGKILLed with no summary and nothing re-dispatched it.
//
// It only became reachable once the catalog resolver was wired in: the same
// pass went from 40,000 rows in 21s to 40,000 in 260s, which turns 8 shards of
// ~2M rows into 3.6h apiece against a 2.5h ceiling. The dispatch that found
// this had to be split 16 ways by hand to stay under it -- exactly the sum
// nobody should have to do before pressing go.
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
// CF-SHARD-THE-REMATCH (2026-08-28): 15.9M sales on one worker is a day.
// Page-modulo split, same pattern as every other fleet.
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
const SHARD_SCOPE = runnerShardScope({ label: "reslugAllSoldComps" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

let _seen = 0;
const STARTED_AT = Date.now();

const distPath = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
if (!fs.existsSync(distPath)) { console.error(`missing dist at ${distPath} — run \`npx tsc\``); process.exit(2); }
const { computeHobbyIqCardId, normalizeSetKey } = require(distPath);
// CF-ASK-THE-CATALOG-NOT-A-PREFIX (Drew, 2026-08-27: "let's fix this
// immediately"). resolveSetKeyFromCatalog has existed, index-friendly and
// authority-aware, and nothing called it.
const { resolveSetKeyFromCatalog } = require(
  path.resolve(__dirname, "..", "dist", "services", "catalog", "resolveSetKey.service.js"));

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency=${CONCURRENCY}  cap=${MAX_ROWS || "∞"}  shards=${SHARD_HEX.join(",") || "all"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const where = ["IS_STRING(c.hobbyiqCardId)", "IS_DEFINED(c.cardYear)", "IS_DEFINED(c.cardNumber)", "IS_DEFINED(c.sport)"];
  const params = [];
  if (SHARD_HEX.length > 0) {
    const inList = SHARD_HEX.map((_, i) => `@s${i}`).join(",");
    where.push(`SUBSTRING(c.contentHash, 0, 1) IN (${inList})`);
    for (let i = 0; i < SHARD_HEX.length; i++) params.push({ name: `@s${i}`, value: SHARD_HEX[i] });
  }
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.sport, c.cardYear, c.setKey, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun
             FROM c WHERE ${where.join(" AND ")}`;
  const it = sold.items.query({ query: q, parameters: params }, { maxItemCount: 500 });

  async function fetchNextWithRetry(tries = 4) {
    for (let i = 0; i < tries; i++) {
      try { return await it.fetchNext(); }
      catch (err) {
        if (err && err.code === 429) {
          const wait = (err.retryAfterInMs || 1000 * (i + 1)) + 200;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    throw new Error("fetchNext retries exhausted");
  }

  async function patchWithRetry(r, newSlug, tries = 3) {
    // CF-RESLUG-ALSO-PARALLELSLUG (Drew, 2026-08-11). Extract the
    // parallel component from the new slug so downstream aggregators
    // (extract-cross-parallel-ratios, catalog matchers) that group by
    // parallelSlug see the canonical value. Slug layout:
    //   hiq:sport:year:setKey:cardNumber:parallelSlug:autoFlag[:printRunPart]
    //   0   1     2    3      4          5             6         7
    const parts = String(newSlug).split(":");
    const newParallelSlug = parts.length >= 6 ? parts[5] : null;

    for (let i = 0; i < tries; i++) {
      try {
        const ops = [
          { op: "set", path: "/hobbyiqCardId", value: newSlug },
          { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
          { op: "set", path: "/reslugedFrom", value: r.hobbyiqCardId },
          { op: "set", path: "/reslugedReason", value: "CF-RESLUG-ALL-SOLD-COMPS" },
        ];
        if (newParallelSlug) ops.push({ op: "set", path: "/parallelSlug", value: newParallelSlug });
        await sold.item(r.id, r.cardId).patch(ops);
        return true;
      } catch (err) {
        const code = err && err.code;
        if (code === 429) {
          const wait = (err.retryAfterInMs || 500 * (i + 1)) + 100;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  let scanned = 0, computed = 0, changed = 0, touched = 0, failed = 0, skipped = 0, demoted = 0;
  // How often the catalog overruled the prefix rule, and how often it declined.
  let resolverWins = 0, resolverSilent = 0, resolverFailed = 0;

  // A resolver call is a cross-partition catalog query, roughly a second.
  // Sales repeat the same card 6.5 times on average, so uncached the same
  // question gets asked over and over: 15,000 rows took 566s with the resolver
  // against 21s for 40,000 without it. Keyed on the IDENTITY being asked
  // about, not on the sale.
  const verdictCache = new Map();
  let resolverCached = 0;
  const startedAt = Date.now();
  const inflight = [];
  const rewriteCounts = new Map();
  const demoteCounts = new Map();

  let hitBudget = false;
  while (it.hasMoreResults()) {
    if (MAX_ROWS && scanned >= MAX_ROWS) break;
    if (Date.now() - STARTED_AT > RUN_MS) { hitBudget = true; break; }
    const { resources } = await fetchNextWithRetry();
    for (const r of resources) {
      if (SLOTS > 1 && (_seen++ % SLOTS) !== SLOT) continue;
      if (MAX_ROWS && scanned >= MAX_ROWS) break;
      scanned++;
      // Skip when we can't build inputs (setKey OR setName required)
      if (!r.setKey && !r.setName) { skipped++; continue; }

      // CF-RESLUG-PREFER-SPECIFIC-INPUT (Drew, 2026-08-12). Was
      // `r.setKey || r.setName` — the stored setKey always won. That
      // PERPETUATES a vaguer setKey when the vendor's setName carries the
      // real product, and it fragments a single card across pools:
      //
      //   setKey="bowman"        + P-21 -> bowman:p-21:lava-refractor
      //   setName="Bowman Draft Chrome" + P-21 -> bowman-chrome:p-21:green-refractor
      //
      // Same physical product, two FMV pools, purely because two vendors
      // populated different fields. Cleanliness canary 2026-08-12 measured
      // 8.68% slug fragmentation with cases exactly like this.
      //
      // Fix: compute BOTH candidates and keep the more SPECIFIC one — the
      // same only-improve principle as the demotion guard below, applied at
      // input selection instead of output. "More specific" means one setKey
      // is a strict descendant of the other (bowman-chrome starts with
      // "bowman-"), which is the only case where the ranking is unambiguous.
      // Unrelated setKeys (a genuine reclassification) keep the stored
      // setKey's answer — we do NOT let free-text setName override a
      // deliberate key with something merely different.
      //
      // Deliberately NOT solved with a cardNumber-prefix rule: the
      // 2026-07-31 blanket prefix override misclassified ~184 rows because
      // prefixes like CPA-/FCA-/TC- are shared across product families, and
      // was reverted. P- has the same shape. This uses only evidence already
      // on the row.
      const compute = (setKeyInput) => {
        try {
          return computeHobbyIqCardId({
            sport: r.sport,
            year: Number(r.cardYear),
            setKey: setKeyInput,
            cardNumber: String(r.cardNumber),
            parallel: r.parallel ?? "Base",
            isAuto: Boolean(r.isAuto),
            printRun: r.printRun ?? null,
          });
        } catch { return null; }
      };
      const setOf = (slug) => (String(slug || "").split(":")[3] || "");

      const fromKey = r.setKey ? compute(r.setKey) : null;
      const fromName = r.setName ? compute(r.setName) : null;

      let newSlug = fromKey || fromName;
      if (fromKey && fromName && fromKey !== fromName) {
        const a = setOf(fromKey), b = setOf(fromName);
        // Keep the strict descendant; otherwise stay with the stored setKey.
        if (b && a && b.startsWith(a + "-")) newSlug = fromName;
        else newSlug = fromKey;
      }
      if (!newSlug) { skipped++; continue; }

      // CF-ASK-THE-CATALOG-NOT-A-PREFIX. computeHobbyIqCardId applies
      // CHROME_PREFIX_OVERRIDES, which assumes "BCP- only ever = Bowman
      // Chrome". The checklists say otherwise -- BOTH products publish BCP-,
      // zero overlap, and the boundary MOVES between years (150 in 2021-23 and
      // 2026, 152 in 2024-25). So the rule rewrites 64,059 sales onto a product
      // they never came from; 30,016 of them say "2026 Bowman Baseball" in
      // their OWN setName, and 1,446 are basketball.
      //
      // Not fixed with another rule -- a boundary table was written and
      // discarded for being the same shape as the bug. The catalog knows,
      // because a checklist told it. Ask it, and only when there is a conflict
      // worth asking about: the override actually moved the setKey away from
      // what the row's own text says. That keeps this to the ~0.4% of rows in
      // dispute instead of a query per sale.
      const saidSet = String(r.setName || r.setKey || "");
      const overrodeTo = setOf(newSlug);
      // normalizeSetKey does NOT apply CHROME_PREFIX_OVERRIDES; compute() does.
      // Comparing compute() against itself can never differ, which is why this
      // fired zero times on the first attempt.
      const plainKey = normalizeSetKey(saidSet);
      // Narrow to the case that is actually in dispute: a chrome-family
      // cardNumber prefix on a row whose own text does NOT say chrome. Asking
      // on every disagreement cost 106s per 1,500 rows against 21s per 40,000
      // without -- unusable across 15.9M. This is the ~0.4% that the prefix
      // override actually rewrites.
      const chromePrefix = /^(bcp|cpa|bcpa|bdc|cda|bdcpa|tcpa|cra)(-|d)/i.test(String(r.cardNumber || ""));
      const textSaysChrome = /chrome/i.test(saidSet);
      if (RESOLVE && chromePrefix && !textSaysChrome && plainKey && overrodeTo && plainKey !== overrodeTo) {
        try {
          const ck = [r.sport, r.cardYear, String(r.cardNumber).toLowerCase(), saidSet.toLowerCase()].join("|");
          let verdict;
          if (verdictCache.has(ck)) {
            verdict = verdictCache.get(ck);
            resolverCached++;
          } else {
            verdict = await resolveSetKeyFromCatalog({
            sport: r.sport,
            year: Number(r.cardYear),
            cardNumber: String(r.cardNumber),
            playerName: r.playerName ?? null,
              sourceSetText: saidSet || null,
            });
            verdictCache.set(ck, verdict);
          }
          // Only a checklist-backed answer may overrule; the resolver already
          // drops rows that may not adjudicate, and returns null when it
          // cannot say. Null means keep whatever we had.
          if (verdict && verdict.setKey && verdict.setKey !== overrodeTo) {
            const resolved = computeHobbyIqCardId({
              sport: r.sport,
              year: Number(r.cardYear),
              setKey: verdict.setKey,
              cardNumber: String(r.cardNumber),
              parallel: r.parallel ?? "Base",
              isAuto: Boolean(r.isAuto),
              printRun: r.printRun ?? null,
              authoritativeSetKey: true,
            });
            if (resolved && resolved.startsWith("hiq:")) {
              newSlug = resolved;
              resolverWins++;
            }
          } else if (verdict && verdict.resolution) {
            resolverSilent++;
          }
        } catch { resolverFailed++; }
      }
      computed++;
      if (newSlug === r.hobbyiqCardId) { skipped++; continue; }

      // CF-RESLUG-NO-DEMOTE (Drew, 2026-08-12). Memory rule: re-canonicalize
      // only when the new slug is strictly MORE specific — never demote.
      // The 2026-08-12 dry-run surfaced rewrites like
      //   topps-chrome-sapphire -> topps
      // which throw away product specificity we already had. That happens
      // when the row's stored setKey is richer than what the generator can
      // recover from its setName input, so "recompute" would lose information.
      //
      // A demotion is when the stored setKey is a DESCENDANT of the new one
      // (stored starts with new + "-"): topps-chrome-sapphire vs topps,
      // bowman-chrome vs bowman. Lateral moves between different families
      // are left alone — those are real reclassifications, not information loss.
      const oldSet = String(r.hobbyiqCardId).split(":")[3] || "";
      const newSet = newSlug.split(":")[3] || "";
      if (oldSet && newSet && oldSet !== newSet && oldSet.startsWith(newSet + "-")) {
        demoted++;
        demoteCounts.set(`${oldSet}→${newSet}`, (demoteCounts.get(`${oldSet}→${newSet}`) || 0) + 1);
        skipped++;
        continue;
      }

      changed++;
      // Audit: bucket by (fromFamily, toFamily) style so we can see
      // what's actually shifting.
      const fromFam = (r.hobbyiqCardId.split(":")[3] || "?") + "→" + (newSlug.split(":")[3] || "?");
      rewriteCounts.set(fromFam, (rewriteCounts.get(fromFam)||0) + 1);

      if (!APPLY) { touched++; continue; }

      const p = patchWithRetry(r, newSlug)
        .then((ok) => { if (ok) touched++; else failed++; })
        .catch((err) => { console.warn(`fail ${r.id}: ${err.message||err}`); failed++; })
        .finally(() => {
          const idx = inflight.indexOf(p);
          if (idx >= 0) inflight.splice(idx, 1);
        });
      inflight.push(p);
      if (inflight.length >= CONCURRENCY) await Promise.race(inflight);

      if (changed % 1000 === 0) {
        const dur = ((Date.now() - startedAt)/1000).toFixed(0);
        console.log(`  scanned=${scanned} changed=${changed} touched=${touched} failed=${failed}  ${dur}s`);
      }
    }
  }
  await Promise.all(inflight);

  const dur = ((Date.now() - startedAt)/1000).toFixed(0);
  if (hitBudget) console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget with work left — the relaunch continues from here`);
  console.log(`\n[done ${dur}s] scanned=${scanned} computed=${computed} changed=${changed} touched=${touched} failed=${failed} skipped=${skipped} demoted-skipped=${demoted}`);
  console.log(`  catalog overruled the prefix rule: ${resolverWins}   declined: ${resolverSilent}   errored: ${resolverFailed}   cached: ${resolverCached}`);
  if (demoted) {
    console.log(`\n  SKIPPED as demotions (only-improve rule):`);
    for (const [k, n] of [...demoteCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${k}: ${n}`);
    }
  }
  console.log("\ntop rewrite patterns:");
  const top = [...rewriteCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 30);
  for (const [k, v] of top) console.log(`  ${k}: ${v}`);
}
main().catch(e => { console.error(e); process.exit(1); });
