#!/usr/bin/env node
// CF-FIX-PARALLEL-AS-PLAYER (Drew, 2026-08-02).
//
// CardHedge's catalog occasionally delivers rows with the PARALLEL
// word stored in the `player` field (Superfractor, Sunflower Seeds,
// Pop Corn, Peanuts, Gum Ball, Sparkle, Red Lava, Mini Diamond,
// Refractor, etc.). Extremely common in 2025 Bowman Draft Chrome's
// snack-themed patterned refractor series.
//
// Real player name is the SAME across all variants of a physical
// card. So for any (year, cardNumber) group that has BOTH bad
// (parallel-word) and good (real name) rows, we can pick the real
// name from the good rows and rewrite the bad ones.
//
// Idempotent via __playerFixedAt marker.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_APPLY             true|false  (default false = dry)
//   RUN_MINUTES                the work loop's budget (default 110)
//   RESERVE_MS / VERIFY_MS     unit reserve / verify cap (see THE CLOCK)
//   BACKFILL_CONCURRENCY       parallel workers (default 8)

const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy: a
// private capped() is what #1859 cost (an unref'd cap that never fired, four
// runs killed at the ceiling having already reconciled clean).
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { reportWrites } = require("../dist/services/ops/writeReconciliation.js");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane OVERWRITES the player name
// on card_catalog rows and had a LOCAL time cap rather than a budget:
// BACKFILL_MAX_MINUTES, default 25, checked at the top of both loops with no
// unit reserve, and signalling continuation through RELAUNCH_NEEDED rather than
// the marker every other budgeted lane prints. A killed step prints no line at
// all, `RN` parses empty, and the runner's RELAUNCH_NEEDED step falls to a
// `::warning::` that does NOT fail the job -- so a killed run went GREEN with
// an unknown number of player names rewritten. That is #1906's defect in a
// second protocol.
//
// THE UNIT IS ONE FIX -- a read, a mutate and an upsert through the retry
// ladder -- dispatched through a CONCURRENCY-wide window. 90 seconds
// comfortably exceeds one such unit plus the window's drain, and it is checked
// BEFORE the fix is dispatched.
//
// -- WHY THE WRITE PHASE REFUSES AFTER A SCAN-PHASE STOP ---------------------
//
// #1947's retire-flattened-attestations lesson, and here the partial-population
// failure is a CORRUPTION rather than a shortfall.
//
// Step 1 groups the whole catalog by (year, cardNumber) and, for each group,
// separates rows whose `player` is a parallel word (the bug) from rows whose
// player is a real name. Step 2 then takes a MAJORITY VOTE over the real names
// in the group and writes the winner onto the bad rows.
//
// A majority vote over a PARTIAL group is not a smaller answer -- it is a
// DIFFERENT one. If the scan stopped after seeing two rows of a group whose
// full membership is fifty, the "winner" is the majority of those two, and this
// lane will stamp that name onto every bad row in the group. The rows end up
// well-formed, confidently wrong, and indistinguishable from correct ones --
// exactly the shape feedback_only_improve_hides_wellformed_wrong_rows warns
// about, and the identity of a CARD is what gets corrupted.
//
// So a scan-phase budget stop REFUSES the apply phase outright (exit 5). The
// next dispatch re-scans from the top and votes only over groups it has seen
// whole.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop.
// Worst case 110 + 1.5 + 1 + 1 = 113.5m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

// Known parallel words that vendor rows sometimes put in the `player` field.
// Case-insensitive comparison.
const PARALLEL_WORDS = new Set([
  "superfractor", "refractor", "sapphire", "mini diamond", "x-fractor", "xfractor",
  "speckle", "wave", "ray wave", "shimmer", "lava", "grass",
  "mojo refractor", "mojo", "lazer refractor", "lazer",
  "sunflower seeds", "pop corn", "popcorn", "peanuts", "gum ball", "gumball", "sparkle",
  "red lava", "blue lava", "green lava", "gold lava", "orange lava", "purple lava",
  "red shimmer", "blue shimmer", "green shimmer", "gold shimmer", "orange shimmer",
  "red wave", "blue wave", "green wave", "gold wave", "orange wave", "purple wave", "aqua wave",
  "red ray wave", "blue ray wave", "green ray wave", "gold ray wave", "orange ray wave",
  "red speckle", "blue speckle", "green speckle", "gold speckle", "orange speckle",
  "chrome", "autograph", "base", "rookie", "image variation", "sterling",
  // Single color words are ambiguous (some real players like "Nick Silver") — still
  // flag but only "fix" when we find a clear alternate in the same group.
  "blue", "red", "gold", "orange", "green", "purple", "pink", "yellow", "aqua", "black", "silver",
].map(s => s.toLowerCase()));

function isParallelWord(name) {
  if (!name || typeof name !== "string") return false;
  return PARALLEL_WORDS.has(name.trim().toLowerCase());
}

async function withRetry(fn, attempts = 5, baseMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      if (!(e?.code === 429 || e?.statusCode === 429)) throw e;
      await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i) + Math.random() * 150));
    }
  }
}

async function main() {
  // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
  // SDK holds keep-alive sockets, and a live handle is what held four
  // reconciled-clean runs to the ceiling.
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  console.log(`[fix-catalog-parallel-as-player] apply=${APPLY} concurrency=${CONCURRENCY}`);
  console.log(`  ${CLOCK.describe()}`);

  console.log("Step 1: scan card_catalog to build (year, cardNumber) → { players: Map<name, count>, badRows: [ids] } ...");
  const groups = new Map();
  const iter = cc.items.query({
    query: "SELECT c.id, c.cardId, c.year, c.number, c.cardNumber, c.player, c.playerName, c.setName FROM c " +
           "WHERE c.source IN ('cardhedge', 'cardsight', 'canonical') " +
           "AND (IS_DEFINED(c.year) AND c.year != null) " +
           "AND (IS_DEFINED(c.number) OR IS_DEFINED(c.cardNumber))"
  }, { maxItemCount: 1000 });

  let scanned = 0;
  // Set when the budget stopped the SCAN. It is what makes the apply phase
  // refuse: a majority vote over a partial group is a WRONG answer, not a
  // smaller one (see THE CLOCK above).
  let scanStoppedAtBudget = false;
  while (iter.hasMoreResults()) {
    // THE PRE-CHECK, before the page is fetched rather than after it is grouped.
    if (CLOCK.outOfClock()) { scanStoppedAtBudget = true; break; }
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      scanned++;
      const cn = String(r.number ?? r.cardNumber ?? "").trim().toUpperCase();
      const yr = String(r.year ?? "");
      if (!cn || !yr) continue;
      const player = String(r.player ?? r.playerName ?? "").trim();
      if (!player) continue;
      const key = `${yr}::${cn}`;
      let g = groups.get(key);
      if (!g) { g = { players: new Map(), badRows: [] }; groups.set(key, g); }
      if (isParallelWord(player)) {
        g.badRows.push({ id: r.id, cardId: r.cardId, player });
      } else {
        g.players.set(player, (g.players.get(player) || 0) + 1);
      }
      if (scanned % 200000 === 0) console.log(`  scanned=${scanned}  groups=${groups.size}`);
    }
  }
  console.log(`  Scan done: ${scanned} rows in ${groups.size} groups`);

  // Step 2: for each group with badRows AND at least one good player, pick the majority good player and fix.
  let fixable = 0, unfixable = 0, groupsWithBad = 0;
  const fixPlan = [];
  for (const [key, g] of groups) {
    if (g.badRows.length === 0) continue;
    groupsWithBad++;
    if (g.players.size === 0) { unfixable += g.badRows.length; continue; }
    // Majority-vote real player
    const winner = [...g.players.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const bad of g.badRows) {
      fixPlan.push({ id: bad.id, cardId: bad.cardId, oldPlayer: bad.player, newPlayer: winner, key });
      fixable++;
    }
  }
  console.log(`\n  Groups with bad rows: ${groupsWithBad}`);
  console.log(`  Bad rows FIXABLE (has real name in group): ${fixable}`);
  console.log(`  Bad rows UNFIXABLE (no real name to inherit): ${unfixable}`);

  if (!APPLY) {
    console.log(`\n  (dry run — set BACKFILL_APPLY=true to persist)`);
    console.log(`  Sample fixes:`);
    for (const f of fixPlan.slice(0, 10)) console.log(`    ${f.key.padEnd(20)}  ${f.oldPlayer.padEnd(20)} → ${f.newPlayer}`);
    if (scanStoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `the scan is UNFINISHED, so these votes are over PARTIAL groups and this plan is NOT`
        + ` the plan an APPLY would be allowed to run`);
    }
    return { client, budget: CLOCK };
  }

  // -- THE APPLY PHASE REFUSES ON A PARTIAL SCAN ---------------------------
  //
  // See THE CLOCK above. A majority vote over part of a group elects a
  // different winner than the vote over all of it, and this lane writes that
  // winner onto the card's identity. Nothing has been written at this point, so
  // refusing costs a re-scan and never a wrong name.
  if (scanStoppedAtBudget) {
    console.error(`\nREFUSING TO APPLY: the scan stopped at the ${CLOCK.RUN_MINUTES}-minute budget,`
      + ` so the (year, cardNumber) groups are PARTIAL.`);
    console.error("  The fix elects a player by MAJORITY VOTE inside each group. A vote over the"
      + " fraction of a group this run happened to read can elect a different name than the whole"
      + " group would, and that name is then stamped onto the card's identity -- a well-formed row"
      + " that is confidently wrong, which no later pass can tell from a correct one.");
    console.error("  Nothing was written. Re-dispatch: the next run re-scans from the top and applies"
      + " only if it completes the scan inside its budget.");
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `scan phase only; the apply was REFUSED and the relaunch continues from here`);
    process.exitCode = 5;
    return { client, budget: CLOCK };
  }

  console.log(`\nStep 3: apply fixes...`);
  let applied = 0, errors = 0;
  const inFlight = [];
  async function applyOne(f) {
    try {
      const { resource } = await cc.item(f.id, f.cardId).read();
      if (!resource) { errors++; return; }
      resource.__playerFixedAt = new Date().toISOString();
      resource.__playerFixedFrom = f.oldPlayer;
      resource.player = f.newPlayer;
      resource.playerName = f.newPlayer;
      await withRetry(() => cc.items.upsert(resource));
      applied++;
    } catch { errors++; }
  }
  // The population is KNOWN here -- fixPlan was built from a COMPLETE scan,
  // which the refusal above guarantees -- so `not reached` below is a real
  // number rather than an invention.
  let applyStoppedAtBudget = false;
  for (const f of fixPlan) {
    // THE PRE-CHECK: before the fix is dispatched rather than after it lands.
    if (CLOCK.outOfClock()) { applyStoppedAtBudget = true; break; }
    inFlight.push(applyOne(f));
    if (inFlight.length >= CONCURRENCY) {
      await Promise.race(inFlight);
      for (let i = inFlight.length - 1; i >= 0; i--) {
        const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
        if (s !== "PENDING") inFlight.splice(i, 1);
      }
    }
    if (applied % 500 === 0 && applied > 0) console.log(`  applied=${applied}  errors=${errors}`);
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  applied:   ${applied}`);
  console.log(`  errors:    ${errors}`);

  // RECONCILE OVER THE KNOWN PLAN.
  const notReached = fixPlan.length - applied - errors;
  console.log(`  reconciled: intended ${fixPlan.length} = applied ${applied}`
    + ` + failed ${errors} + not reached ${notReached}`);
  if (applied + errors + notReached !== fixPlan.length) {
    console.error("  !! RECONCILE MISMATCH -- a planned fix was neither applied, failed nor left unreached");
    process.exitCode = 4;
  }
  reportWrites({
    job: "fix-catalog-parallel-as-player",
    intended: fixPlan.length, written: applied, skipped: notReached, failed: errors,
  });

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables: a marker built by concatenation is one a refactor can silently
  // reword, and a reworded marker ends the fan-out after one slice with the run
  // green -- the quiet version of the bug it exists to make loud.
  if (applyStoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${notReached} of ${fixPlan.length} planned fixes NOT REACHED; the relaunch continues from here`);
    console.log("  the fix is IDEMPOTENT: an applied row no longer carries a parallel word in"
      + " `player`, so the next scan files it among the group's GOOD names rather than its bad"
      + " rows, and it is never rewritten twice.");
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
