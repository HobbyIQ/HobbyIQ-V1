#!/usr/bin/env node
/**
 * CF-THE-ID-IS-THE-TRUTH (Drew, 2026-08-28: "is the structure the best format
 * for Grade Grading company and card profile for search? we need to make it
 * clean and make it work").
 *
 * Re-derives every denormalized profile field FROM THE ROW'S OWN ID, so the
 * catalog presents one uniform card profile instead of whatever each of 30
 * sources happened to write.
 *
 * WHY THE ID IS THE MASTER. Measured tonight, the id is the only layer that
 * held up everywhere: 98.9% of rows sit at their own address, 100% of grade
 * rows end in their own tier and carry a parentSlug, and the id's parallel
 * segment disagrees with the parallelSlug FIELD on only 0.45% of rows -- while
 * the display fields disagree with EACH OTHER on 27%. Identity is consistent;
 * presentation is source-flavoured. So presentation is rebuilt from identity,
 * never the reverse: a row whose id is wrong is an identity problem owned by
 * the retire/annotate passes, and no field cosmetics here can fix or worsen it.
 *
 * WHAT IT DERIVES, per row, from `hiq:{sport}:{year}:{setKey}:{cardNumber}:
 * {parallelSlug}:{auto}[:num-N][:{gradeTier}]`:
 *
 *   parallelSlug   := the id's parallel segment (heals the 0.45% drift)
 *   parallel       := title-cased segment, ONLY when the current display
 *                     disagrees with the segment or is blank. A display that
 *                     already slugifies to the segment keeps its punctuation
 *                     ("1955 World Series" stays). Blank display with a minted
 *                     identity states the identity -- the blank-means-unknown
 *                     rule governs INGEST (do not mint from blank, #1324); a
 *                     row that exists is already minted, and hiding its
 *                     identity in a blank display helps nobody.
 *   searchTokens   := union of existing tokens with year, CARD NUMBER, player
 *                     parts, parallel parts, setKey parts, and grade tier.
 *                     cardNumber was in 0.1% of tokens -- half of Drew's own
 *                     identity standard was unsearchable.
 *   displayName    := "{year} {setName} {playerName} #{cardNumber} {Parallel}
 *                     [/N] [PSA 10]" -- one format, derived, everywhere.
 *
 * GRADE ROWS INCLUDED. The tier becomes part of the display name and tokens
 * ("psa" "10" searchable), company/value stay untouched -- they were 92%/92%
 * and correct (the gap IS the raw tier).
 *
 * RESUMABLE by profileVersion stamp; REDO=true re-runs everywhere. The stamp
 * doubles as the relaunch termination signal: a run that scans zero rows IS a
 * finished slot.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   REDO=true                 re-derive even already-stamped rows
 *   SLOT/SLOTS  CONCURRENCY=48  RUN_MINUTES=140  LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const REDO = String(process.env.REDO || "") === "true";
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
const SHARD_SCOPE = runnerShardScope({ label: "conform-card-profile" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();
const PROFILE_VERSION = 3;
const f = (n) => Number(n).toLocaleString();

const PENDING = REDO ? "" : ` AND (NOT IS_DEFINED(c.profileVersion) OR c.profileVersion < ${PROFILE_VERSION})`;

const slugify = (s) => String(s ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const titleCase = (seg) => String(seg ?? "").split("-").filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/** "psa-10" -> "PSA 10", "bgs-10-black" -> "BGS 10 Black", "raw" -> null (not shown). */
function tierLabel(tier) {
  if (!tier || tier === "raw") return null;
  const [co, ...rest] = String(tier).split("-");
  return [co.toUpperCase(), ...rest.map((r) => (/^\d/.test(r) ? r.replace(/-/g, ".") : titleCase(r)))].join(" ").replace(/(\d) (\d)/, "$1.$2");
}

/** Parse the fixed grammar. Segment 5 is ALWAYS the parallel; num-/tier follow. */
function parseId(id) {
  const p = String(id).split(":");
  if (p[0] !== "hiq" || p.length < 7) return null;
  let printRun = null, tier = null;
  for (const seg of p.slice(7)) {
    if (seg.startsWith("num-")) printRun = Number(seg.slice(4)) || null;
    else tier = seg;
  }
  return { sport: p[1], year: p[2], setKey: p[3], cardNumber: p[4], parallelSeg: p[5], auto: p[6] === "auto", printRun, tier };
}

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
        if (!/request rate is too large|429|ETIMEDOUT|ECONNRESET/i.test(String(e?.message)) || a >= tries) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  console.log(`slot ${SLOT}/${SLOTS}  profileVersion=${PROFILE_VERSION}${REDO ? " REDO" : ""}  ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  let scanned = 0, written = 0, unparsable = 0, alreadyClean = 0, failed = 0, notReached = 0;
  let otherSlot = 0; // siblings' rows: seen for shard stability, never this slot's work (CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER)
  let fixedSlug = 0, fixedDisplay = 0, fixedTokens = 0, fixedName = 0;
  let stopReason = null;
  let token;

  do {
    const page = await retry(() => cat.items.query({
      query: `SELECT c.id, c.cardId, c.year, c.setKey, c.setName, c.cardNumber, c.playerName, c.playerSlug,
                     c.parallel, c.parallelSlug, c.searchTokens, c.displayName, c.gradeTier, c.source
              FROM c WHERE STARTSWITH(c.id, 'hiq:')${PENDING}`,
    }, { maxItemCount: 500, continuationToken: token }).fetchNext());
    token = page.continuationToken;

    const mine = SLOTS > 1 ? page.resources.filter((_, i) => (i + scanned) % SLOTS === SLOT) : page.resources;
    otherSlot += page.resources.length - mine.length;
    scanned += page.resources.length - mine.length; // siblings' rows, counted as seen so sharding stays stable

    for (let i = 0; i < mine.length; i += CONCURRENCY) {
      await Promise.all(mine.slice(i, i + CONCURRENCY).map(async (d) => {
        scanned++;
        try {
          const p = parseId(d.id);
          if (!p) { unparsable++; return; }

          const ops = [];

          // 1. parallelSlug heals to the id segment
          if (d.parallelSlug !== p.parallelSeg) { ops.push({ op: "set", path: "/parallelSlug", value: p.parallelSeg }); fixedSlug++; }

          // 2. display parallel: keep punctuation when it already agrees;
          //    restate the identity when it is blank or disagrees
          const display = String(d.parallel ?? "").trim();
          let displayOut = display;
          // A checklist row's parallel is the checklist's own words --
          // restating it from the slug segment invents vocabulary the source
          // never printed. Only derived/vendor rows get their display derived.
          const isChecklistRow = catalogAuthorityOf(d.source) === "checklist";
          if (!isChecklistRow && (!display || slugify(display) !== p.parallelSeg)) {
            displayOut = titleCase(p.parallelSeg);
            ops.push({ op: "set", path: "/parallel", value: displayOut });
            fixedDisplay++;
          }

          // 3. tokens: identity-complete, union with what exists
          const tok = new Set((Array.isArray(d.searchTokens) ? d.searchTokens : []).map((x) => String(x).toLowerCase()).filter(Boolean));
          const before = tok.size;
          tok.add(String(p.year));
          tok.add(String(d.cardNumber ?? p.cardNumber).toLowerCase());
          for (const w of String(d.playerSlug ?? "").split("-")) if (w) tok.add(w);
          for (const w of p.parallelSeg.split("-")) if (w) tok.add(w);
          for (const w of p.setKey.split("-")) if (w) tok.add(w);
          if (p.tier) for (const w of p.tier.split("-")) if (w) tok.add(w);
          if (tok.size !== before || !Array.isArray(d.searchTokens)) { ops.push({ op: "set", path: "/searchTokens", value: [...tok] }); fixedTokens++; }

          // 4. one displayName format, derived
          const label = tierLabel(d.gradeTier ?? p.tier);
          const name = [
            p.year, d.setName || titleCase(p.setKey), d.playerName || null,
            `#${String(d.cardNumber ?? p.cardNumber).toUpperCase()}`,
            displayOut && displayOut !== "Base" ? displayOut : null,
            p.printRun ? `/${p.printRun}` : null,
            p.auto ? "Auto" : null, label,
          ].filter(Boolean).join(" ");
          if (d.displayName !== name) { ops.push({ op: "set", path: "/displayName", value: name }); fixedName++; }

          if (!ops.length) { alreadyClean++; }
          if (!APPLY) { written++; return; }
          ops.push({ op: "set", path: "/profileVersion", value: PROFILE_VERSION });
          await retry(() => cat.item(d.id, d.cardId ?? d.id).patch(ops.slice(0, 10)));
          written++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 60)}: ${String(e.message || e).slice(0, 60)}`);
        }
      }));
      const processed = Math.min(i + CONCURRENCY, mine.length);
      if (LIMIT && written >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; break; }
      if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; notReached += mine.length - processed; break; }
    }
    if (scanned % 20000 < 500) {
      const mins = Math.max(1 / 60, (Date.now() - STARTED) / 60000);
      process.stderr.write(`\r  scanned=${f(scanned)} written=${f(written)}  ${f(Math.round(written / mins))}/min   `);
    }
    if (stopReason) break;
  } while (token);
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  rows scanned             ${f(scanned)}`);
  console.log(`  rows conformed           ${f(written)}`);
  console.log(`    parallelSlug healed    ${f(fixedSlug)}`);
  console.log(`    display restated       ${f(fixedDisplay)}`);
  console.log(`    tokens completed       ${f(fixedTokens)}   <- cardNumber searchable at last`);
  console.log(`    displayName derived    ${f(fixedName)}`);
  console.log(`  already clean            ${f(alreadyClean)}`);
  console.log(`  other slots' rows        ${f(otherSlot)}   <- seen for shard stability, not this slot's work`);
  console.log(`  id not hiq grammar       ${f(unparsable)}   <- the canonicalize fleet owns these`);
  console.log(`  failed                   ${f(failed)}`);
  if (APPLY) {
    reportWrites({
      job: "conform-card-profile", intended: scanned, written,
      // disjoint: this slot's conformed rows + rows it deliberately left (clean, unparsable, not reached) + siblings' rows it only looked at
      skipped: alreadyClean + unparsable + notReached + otherSlot, failed,
    });
  }
}

module.exports = { parseId, tierLabel };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
