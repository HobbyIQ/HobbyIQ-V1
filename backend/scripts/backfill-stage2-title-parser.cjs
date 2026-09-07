#!/usr/bin/env node
// CF-BACKFILL-STAGE2-TITLE-PARSER (Drew, 2026-08-01).
//
// Stage 2 of the three-stage pool-cleanup pipeline. Stage 1 rewrote
// ~177K rows using catalog+setName agreement; Stage 2 tackles the
// ~2M rows the catalog didn't cover, using the title text as the
// primary evidence source. Multi-witness safeguard: title-extracted
// fields (playerName, setSlug, cardNumber, year) must agree with the
// stored fields in at least 2 places before we rewrite.
//
// Only touches rows where the derived canonical slug differs from
// current. Skips rows lacking sufficient witnesses. Marker field
// __stage2TitleParsedAt for rollback traceability.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_MODE / BACKFILL_APPLY   dry (default) | apply / true|false
//   BACKFILL_CONCURRENCY       default 8

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. Stage 2 REWRITES sold_comps slugs --
// it moves a sale from one pool to another -- and declared no budget at all.
// Its own docblock puts the population at ~2M rows, which is far more than one
// 150-minute step holds, so before this it could only ever end by being KILLED
// at the ceiling: no marker, no reconcile, no finishLane line, and #1913's
// KILLED branch then withholding the re-dispatch with an unknown number of
// sales relocated and the rest at their old address.
//
// THE UNIT IS ONE PAGE of up to 500 sold_comps rows (maxItemCount: 500), and
// the page is the right unit rather than the row because the loop cannot stop
// inside one: the page is fetched whole, then drained through a CONCURRENCY-wide
// (default 8) window of whole-document upserts. 90 seconds comfortably exceeds
// that drain against a container that throttles, and it is checked BEFORE the
// page is fetched, so the page whose 500 upserts would overrun is never
// STARTED -- the loop-top defect #1799 named admits one whole extra page past
// expiry.
//
// THE PHASE ORDER MATTERS, AND THE SECOND PHASE IS GATED ON THE CLOCK.
// loadPlayerDict() walks the WHOLE card_catalog player column into memory
// before the pool scan begins. That is a pre-loop scope read, but an unbounded
// one, so entry to the pool walk is gated on not having already stopped --
// otherwise a stop in the dictionary load would be followed by a fresh
// full-pool scan started past expiry, which is #1947's "one more unit" defect
// at PHASE granularity.
//
// A PARTIAL DICTIONARY CANNOT PRODUCE A WRONG WRITE, which is why this lane may
// proceed on one where fix-catalog-parallel-as-player (this same change) must
// REFUSE. The dictionary is a LOOKUP, not a population whose shape decides the
// answer: a name it never reached simply fails to match, extractPlayerFromTitle
// returns nothing, the player witness does not fire, and the row falls BELOW
// the two-witness bar into `insufficientWitnesses` -- a SKIP. A short load
// therefore costs COVERAGE and never CORRECTNESS, and the relaunch picks those
// rows up on the next pass.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// --- Set → canonical slug (mirror of Stage 1) ---
function normalizeSetToCanonical(setText) {
  const s = String(setText || "").toLowerCase();
  if (!s) return null;
  if (/bowman chrome sapphire|bowman sapphire/.test(s)) return "bowman-chrome-sapphire";
  if (/topps chrome sapphire/.test(s)) return "topps-chrome-sapphire";
  if (/bowman chrome draft|bowman draft chrome/.test(s)) return "bowman-chrome";
  if (/bowman chrome/.test(s)) return "bowman-chrome";
  if (/chrome prospect/.test(s)) return "bowman-chrome";
  if (/bowman platinum/.test(s)) return "bowman-platinum";
  if (/bowman sterling/.test(s)) return "bowman-sterling";
  if (/bowman draft/.test(s)) return "bowman-draft";
  if (/bowman mega/.test(s)) return "bowman-mega";
  if (/bowman heritage/.test(s)) return "bowman-heritage";
  if (/bowman inception/.test(s)) return "bowman-inception";
  if (/bowman transcendent/.test(s)) return "bowman-transcendent";
  if (/\bbowman\b/.test(s)) return "bowman";
  if (/topps chrome platinum/.test(s)) return "topps-chrome-platinum";
  if (/topps chrome update|chrome update/.test(s)) return "topps-chrome";
  if (/topps chrome black/.test(s)) return "topps-chrome-black";
  if (/topps chrome/.test(s)) return "topps-chrome";
  if (/topps heritage/.test(s)) return "topps-heritage";
  if (/topps finest|^finest\b/.test(s) || /\btopps finest\b/.test(s)) return "topps-finest";
  if (/topps pristine/.test(s)) return "topps-pristine";
  if (/topps transcendent/.test(s)) return "topps-transcendent";
  if (/topps dynasty/.test(s)) return "topps-dynasty";
  if (/topps tribute/.test(s)) return "topps-tribute";
  if (/topps museum/.test(s)) return "topps-museum-collection";
  if (/topps stadium/.test(s)) return "topps-stadium-club";
  if (/topps allen|allen.*ginter/.test(s)) return "topps-allen-ginter";
  if (/topps gypsy/.test(s)) return "topps-gypsy-queen";
  if (/topps archives/.test(s)) return "topps-archives";
  if (/topps inception/.test(s)) return "topps-inception";
  if (/topps five star/.test(s)) return "topps-five-star";
  if (/topps definitive/.test(s)) return "topps-definitive";
  if (/topps big league/.test(s)) return "topps-big-league";
  if (/\btopps\b/.test(s)) return "topps";
  if (/donruss champions/.test(s)) return "donruss-champions";
  if (/panini prizm|^prizm/.test(s)) return "panini-prizm";
  if (/panini select/.test(s)) return "panini-select";
  if (/panini mosaic/.test(s)) return "panini-mosaic";
  if (/panini donruss optic|donruss optic|panini optic/.test(s)) return "panini-optic";
  if (/panini donruss|donruss/.test(s)) return "panini-donruss";
  if (/panini contenders/.test(s)) return "panini-contenders";
  if (/panini immaculate/.test(s)) return "panini-immaculate";
  if (/panini flawless/.test(s)) return "panini-flawless";
  if (/national treasures/.test(s)) return "panini-national-treasures";
  if (/panini absolute/.test(s)) return "panini-absolute";
  if (/panini chronicled|panini chronicles/.test(s)) return "panini-chronicles";
  if (/panini illusions/.test(s)) return "panini-illusions";
  if (/panini prestige/.test(s)) return "panini-prestige";
  if (/panini diamond kings/.test(s)) return "panini-diamond-kings";
  if (/panini phoenix/.test(s)) return "panini-phoenix";
  if (/panini/.test(s)) return "panini";
  if (/upper deck/.test(s)) return "upper-deck";
  if (/fleer/.test(s)) return "fleer";
  return null;
}

// --- Title extraction ---
function extractYearFromTitle(title) {
  const m = String(title || "").match(/\b(19|20)(\d{2})\b/);
  if (!m) return null;
  return Number(m[0]);
}

const CARD_NUMBER_RE = /#([A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4}|BCP-\d+|BDC-\d+|HL\d+|US\d+|\d{1,4})\b/i;
function extractCardNumberFromTitle(title) {
  const m = String(title || "").match(CARD_NUMBER_RE);
  return m ? m[1].toUpperCase() : null;
}

// CF-STAGE2-FAST-PLAYER-LOOKUP (Drew, 2026-08-01). Prior implementation
// ran one regex per player per row — 96K players × 3.4M rows = O(300B)
// operations, timed out after 150 min without progress. Fixed: build
// a Set of lowercased player names, then scan the title's word-window
// pairs (last-first or first-last order) and probe the set. O(rows ×
// title_words) — ~50M operations total, seconds not hours.
function extractPlayerFromTitle(title, playerSet) {
  if (!title) return null;
  const t = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const words = t.split(" ");
  // 2-word windows: "first last"
  for (let i = 0; i + 1 < words.length; i++) {
    const candidate = words[i] + " " + words[i + 1];
    if (playerSet.has(candidate)) return candidate;
  }
  // 3-word windows: "first middle last" (Bo Bichette Jr, etc.)
  for (let i = 0; i + 2 < words.length; i++) {
    const candidate = words[i] + " " + words[i + 1] + " " + words[i + 2];
    if (playerSet.has(candidate)) return candidate;
  }
  return null;
}

/** Set when the budget stopped the dictionary load, so the pool walk below can
 *  refuse to START rather than begin a full-pool scan past expiry. */
let dictLoadStoppedAtBudget = false;

async function loadPlayerDict(cc) {
  const iter = cc.items.query({ query: "SELECT c.player FROM c WHERE IS_DEFINED(c.player)" }, { maxItemCount: 5000 });
  const set = new Set();
  while (iter.hasMoreResults()) {
    // The load is a PRE-LOOP scope read, but an unbounded one: on a large
    // card_catalog it can outlive the whole budget on its own. Stopping it at
    // the clock is what lets the phase gate below make a decision instead of
    // discovering expiry only after a fresh full-pool scan has started.
    if (CLOCK.outOfClock()) { dictLoadStoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      const p = String(r.player || "").trim().toLowerCase();
      if (p && p.split(/\s+/).length >= 2 && p.length >= 5) set.add(p);
    }
  }
  return set;
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429 || /Too many requests|Request rate/i.test(String(e?.message || ""));
      if (!is429) throw e;
      const wait = baseMs * Math.pow(2, i) + Math.random() * 150;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cc = db.container("card_catalog");
  const sc = db.container("sold_comps");

  console.log(`[backfill-stage2-title-parser]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("Loading known player dictionary from card_catalog...");
  const playerDict = await loadPlayerDict(cc);
  console.log(`  known players: ${playerDict.size}`);
  if (dictLoadStoppedAtBudget) {
    console.log("  the dictionary load was CUT SHORT by the budget: it holds part of the"
      + " catalog's players, not all of them.");
  }

  // -- THE PHASE GATE ------------------------------------------------------
  //
  // #1947's backfill-canonicalize-chrome-slugs lesson, at phase granularity.
  // Entry to the pool walk is gated on not having already stopped: without
  // this, a budget expiry inside the dictionary load would be followed by a
  // FRESH FULL-POOL SCAN begun past expiry, which is the "one more unit" defect
  // where the unit is a whole container. Nothing has been written at this
  // point, so stopping here costs a cheap re-read on the relaunch and leaves no
  // half-done state.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the dictionary load consumed it; the sold_comps walk was NOT STARTED`);
    console.log("  nothing was written. The relaunch rebuilds the dictionary and continues from here.");
    return { client, budget: CLOCK };
  }

  console.log("\nScanning sold_comps...");
  // CF-STAGE2-SKIP-STAGE1 (Drew, 2026-08-01). Skip rows already handled
  // by Stage 1 catalog-driven fixer — those have __catalogCanonicalizedAt.
  const iter = sc.items.query({
    query: `SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')
              AND NOT IS_DEFINED(c.__catalogCanonicalizedAt)
              AND NOT IS_DEFINED(c.__stage2TitleParsedAt)`
  }, { maxItemCount: 500 });

  let examined = 0;
  let noTitle = 0, insufficientWitnesses = 0, sameSlug = 0;
  let rewritten = 0, errors = 0;
  const transitions = {};
  const inFlight = [];
  // `written` did not exist: only failures were counted, so a run reported
  // `rewritten: N` and said nothing at all about how many of those N landed.
  let written = 0;
  // Set when the budget stopped the page walk. There is NO honest `not reached`
  // count here: the loop DISCOVERS rows page by page, so a row never fetched was
  // never seen and is not part of `intended` (feedback: a slice is not a sibling
  // counter).
  let stoppedAtBudget = false;

  while (iter.hasMoreResults()) {
    // THE PRE-CHECK: above the unit's work, and BEFORE the page is fetched
    // rather than after its 500 upserts have been issued.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const slug = row.hobbyiqCardId;
      if (typeof slug !== "string" || !slug.startsWith("hiq:")) continue;
      const parts = slug.split(":");
      if (parts.length < 6) continue;

      const title = String(row.title || "");
      if (!title) { noTitle++; continue; }

      // Stored fields
      const storedName = String(row.playerName || "").trim();
      const storedCn = String(row.cardNumber || "").trim().toUpperCase();
      const storedYear = Number(row.cardYear || 0) || null;
      const storedSetCanon = normalizeSetToCanonical(row.setName);

      // Title-extracted fields
      const titleYear = extractYearFromTitle(title);
      const titleCn = extractCardNumberFromTitle(title);
      const titleSetCanon = normalizeSetToCanonical(title);
      const titleName = extractPlayerFromTitle(title, playerDict);

      // Count witnesses that AGREE between stored and title
      // (titleName is already lowercased by extractPlayerFromTitle)
      let witnesses = 0;
      if (storedName && titleName && storedName.toLowerCase() === titleName) witnesses++;
      if (storedCn && titleCn && storedCn === titleCn) witnesses++;
      if (storedYear && titleYear && storedYear === titleYear) witnesses++;
      if (storedSetCanon && titleSetCanon && storedSetCanon === titleSetCanon) witnesses++;

      // Need at least 2 agreeing witnesses to rewrite anything
      if (witnesses < 2) { insufficientWitnesses++; continue; }

      // Choose canonical set: title extraction wins (it's the primary
      // signal for Stage 2), but only when the title's set canonical
      // is confirmed by at least one other agreement.
      const canonicalSet = titleSetCanon || storedSetCanon;
      if (!canonicalSet) { insufficientWitnesses++; continue; }

      const currentSet = parts[3];
      if (currentSet === canonicalSet) { sameSlug++; continue; }

      // Extra safeguard: if the canonical set is a MAJOR product family
      // change (e.g. bowman→panini), require an even higher bar (3+ witnesses).
      const familyOf = (s) => (s || "").split("-")[0];
      const crossFamily = familyOf(currentSet) !== familyOf(canonicalSet);
      if (crossFamily && witnesses < 3) { insufficientWitnesses++; continue; }

      const tKey = `${currentSet}  →  ${canonicalSet}`;
      transitions[tKey] = (transitions[tKey] || 0) + 1;
      parts[3] = canonicalSet;
      const newSlug = parts.join(":");

      rewritten++;
      if (MODE === "apply") {
        row.hobbyiqCardId = newSlug;
        row.__stage2TitleParsedAt = new Date().toISOString();
        row.__stage2Witnesses = witnesses;
        inFlight.push(
          withRetry(() => sc.items.upsert(row))
            .then(() => { written++; })
            .catch(e => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) {
      console.log(`  examined=${examined}  rewritten=${rewritten}  insufficient=${insufficientWitnesses}  noTitle=${noTitle}`);
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  examined:         ${examined}`);
  console.log(`  no title:         ${noTitle}`);
  console.log(`  insufficient wit: ${insufficientWitnesses}`);
  console.log(`  same slug:        ${sameSlug}`);
  console.log(`  rewritten:        ${rewritten}`);
  console.log(`  errors:           ${errors}`);

  // RECONCILE OVER WHAT WAS SEEN. `rewritten` counts only rows this run actually
  // decided to move, so the identity holds whether the loop finished or the
  // budget stopped it -- a budget stop shrinks BOTH sides rather than opening a
  // gap that reads as loss.
  if (MODE === "apply") {
    console.log(`  reconciled: intended ${rewritten} = written ${written} + failed ${errors}`);
    if (written + errors !== rewritten) {
      console.error("  !! RECONCILE MISMATCH -- a planned rewrite was neither written nor failed");
      process.exitCode = 4;
    }
    reportWrites({
      job: "backfill-stage2-title-parser",
      intended: rewritten, written, skipped: 0, failed: errors,
    });
  }

  console.log(`\nTop 30 transitions:`);
  Object.entries(transitions).sort((a,b) => b[1] - a[1]).slice(0, 30).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `this sweep is UNFINISHED; the relaunch continues from here`);
    console.log("  the continuation is CHEAP over the finished part: a rewritten row carries"
      + " __stage2TitleParsedAt, and the scan query excludes it by name, so the next pass"
      + " never re-reads what this one wrote.");
  }

  return { client, budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
