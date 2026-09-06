#!/usr/bin/env node
/**
 * READ-ONLY volume census for the non-Pokemon TCG verticals: rows, dollars and
 * 90-day velocity per game — Magic, Yu-Gi-Oh, One Piece, Lorcana, plus the
 * "unknown TCG" residual.
 *
 * WHY IT EXISTS. Drew's ruling (2026-09-05) for the non-Pokemon TCGs is
 * MEASURE VOLUME FIRST, then ASK EACH PUBLISHER IN WRITING before any ingest.
 * CF-POKEMON-TCG-EXPANSION-PARKED parks the vertical behind the sport->vertical
 * refactor; what these games get in this pass is a NUMBER, so that refactor and
 * those four permission requests can be costed against real money rather than a
 * hunch. The drafted requests are in
 * docs/reports/tcg-source-permissions-2026-09-05.md.
 *
 * WHY IT IS NOW A RUNNER LANE. PR #1822 committed this as a workstation script
 * and it NEVER COMPLETED INTERACTIVELY — >50 minutes on 2026-09-05 without
 * finishing. That is not a slow query to wait out, it is a job-length problem,
 * and the runner is where job-length problems are solved: a budget, a shard
 * axis, and a relaunch that continues where the budget stopped. Run
 * interactively it dies with nothing; run as a lane it prints what it measured
 * and relaunches for the rest.
 *
 * TWO QUERY SHAPES WERE TRIED BEFORE THIS ONE, AND BOTH FAILED.
 *
 *   1. `SELECT c.sport, COUNT(1), SUM(c.price) FROM c GROUP BY c.sport` — one
 *      cross-partition aggregate over a 20M-row container. Did not return in
 *      ten minutes; the same shape #1796 reported.
 *   2. one COUNT + one SUM per vertical, unbounded. Better, still >50 minutes,
 *      and a single slow vertical hid every other vertical's result because
 *      nothing printed until the end.
 *
 * WHAT THIS ONE DOES INSTEAD. PAGED READS, and the page is the unit of work:
 *
 *   - each vertical is queried with an explicit `maxItemCount` and walked by
 *     CONTINUATION TOKEN, accumulating rows and dollars in JS. A page is small
 *     and bounded, so the budget's pre-check can refuse the NEXT page rather
 *     than being trapped inside an aggregate that never returns;
 *   - partial results are PRINTED PER VERTICAL as they complete, so a lane that
 *     stops at its budget still reports every vertical it finished;
 *   - NEVER a cross-partition COUNT. The failure mode this file exists to
 *     document is exactly that shape (CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS —
 *     an unbounded post-loop COUNT is what got run 33960686247 killed after it
 *     had already reconciled clean).
 *
 * ALSO RECORDED: `SELECT VALUE { n: COUNT(1), dollars: SUM(c.price) }` — the
 * obvious one-round-trip form — is REFUSED by this SDK with "One of the input
 * values is invalid". That is why the paged projection reads the two fields and
 * sums them here rather than asking Cosmos for the aggregate.
 *
 * NO WRITES, NO APPLY. `BACKFILL_APPLY=true` is REFUSED loudly (exit 3) rather
 * than ignored, the same shape as acquire-for-withheld-holdings: a dispatch
 * that believed it was applying something learns that it was not. The runner
 * also gates an apply dispatch of this script before it reaches Cosmos.
 *
 * DISPATCH (report-only; there is no other mode):
 *
 *   gh workflow run backfill-runner.yml --ref main \
 *     -f script=census-tcg-verticals -f apply=false
 *
 * ENV
 *   RUN_MINUTES=n    the work loop's budget (default 30; the full census measured
 *                    25s on 2026-09-05, so this is ~70x its cost)
 *   GAMES=a,b        restrict to these game keys (default: all)
 *   SLOT/SLOTS       shard by game, opt-in per CF-AN-INHERITED-SLOTS-IS-NOT-A-
 *                    CHOSEN-SHARD — an inherited slot=0/slots=16 sweeps ALL
 *   PAGE=n           rows per page (default 2000)
 *   OUT=path         also write the JSON census to this file
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));

// CF-A-SCRIPT-WITH-NO-WRITE-PATH-REFUSES-AN-APPLY. Read it, refuse it, exit 3
// — never ignore it. The runner exports BACKFILL_APPLY (not APPLY).
if (String(process.env.BACKFILL_APPLY || "").trim().toLowerCase() === "true") {
  console.error(
    "census-tcg-verticals is READ ONLY — it has no write path and never will.\n"
    + "Drew's ruling (2026-09-05) is measure first, then ASK EACH PUBLISHER IN WRITING;\n"
    + "an ingest lane for these games does not exist yet and must not be implied by an apply flag.\n"
    + "Re-dispatch with apply=false.",
  );
  process.exit(3);
}

const cs = process.env.COSMOS_CONNECTION_STRING;
if (!cs) { console.error("missing COSMOS_CONNECTION_STRING"); process.exit(1); }
// The CLIENT is held in its own binding, apart from the container handle. A
// `.container()` handle cannot be disposed — only the client owns the SDK's
// keep-alive sockets — so chaining the two inline would leave `finishLane`
// with nothing to close: it would still exit, but it would never release a
// socket (the distinction #1842 drew on its own tail).
const client = new CosmosClient(cs);
const pool = client.database("hobbyiq").container("sold_comps");

const OUT = String(process.env.OUT || "").trim();
const PAGE = Math.max(100, Number(process.env.PAGE || 2000));
const since90 = new Date(Date.now() - 90 * 864e5).toISOString();

/**
 * THE GAMES, and how each is recognised.
 *
 * `sport` is the stored vertical. The sport->vertical refactor has not
 * happened, so these games are NOT cleanly separated in the field today:
 * `anime-tcg` holds One Piece AND Yu-Gi-Oh and more, and `tcg-other` is the
 * residual bucket. That is precisely what this census measures — a game whose
 * rows we cannot even name is a game we cannot cost.
 *
 * So each game declares the sports it can live under plus a TITLE test, and the
 * census reports both the sport-level totals and the title-attributed split.
 * The title test is applied IN JS over paged rows, never as a CONTAINS in the
 * WHERE clause — an unindexed CONTAINS over 20M rows is the shape that already
 * failed twice above.
 */
const GAMES = [
  {
    key: "magic",
    label: "Magic: The Gathering",
    sports: ["mtg", "tcg-other"],
    // "Magic:" alone is enough when it heads a set name -- the smoke run
    // (2026-09-05) put 6,682 rows in the unknown bucket and the sample was
    // dominated by "Ebony Horse Magic: Arabian Nights 1993" and "Healing Salve
    // Alpha PLD White Common MAGIC GATHERING CARD". Requiring the full "Magic
    // the Gathering" undercounted the oldest and most valuable Magic sets,
    // which is the opposite of what a volume census is for.
    //
    // Anchored to the punctuated/branded forms rather than the bare English
    // word: `\bmagic\b` alone would claim "Magic Johnson" out of basketball.
    title: /\b(?:mtg|magic[ :-]*the[ :-]*gathering|magic gathering|magic:)/i,
    publisher: "Wizards of the Coast",
    source: "Scryfall",
  },
  {
    key: "yugioh",
    label: "Yu-Gi-Oh!",
    sports: ["yugioh", "anime-tcg", "tcg-other"],
    title: /\b(?:yu[ -]?gi[ -]?oh|ygo)\b/i,
    publisher: "Konami",
    source: "YGOPRODeck",
  },
  {
    key: "onepiece",
    label: "One Piece Card Game",
    sports: ["anime-tcg", "tcg-other"],
    title: /\b(?:one[ -]?piece|op0[1-9]|op1[0-9])\b/i,
    publisher: "Bandai",
    source: "optcgapi",
  },
  {
    key: "lorcana",
    label: "Disney Lorcana",
    sports: ["lorcana", "tcg-other"],
    title: /\blorcana\b/i,
    publisher: "Ravensburger / Disney",
    source: "lorcana-api",
  },
];

/** Every sport a game can live under, deduped — the query axis. */
const SPORTS = [...new Set(GAMES.flatMap((g) => g.sports))];

const SHARD = runnerShardScope({ label: "census-tcg-verticals" });
const { SHARDED, SLOT, SLOTS } = SHARD;

const wanted = String(process.env.GAMES || "").trim().toLowerCase();
const WANT = wanted ? new Set(wanted.split(",").map((s) => s.trim()).filter(Boolean)) : null;

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
const money = (n) => "$" + Math.round(Number(n ?? 0)).toLocaleString("en-US");

(async () => {
  const t0 = Date.now();
  // SIZED FROM THE MEASUREMENT, not from the old 140-minute default that
  // tests/runnerBudgetMargin.test.ts exists to eliminate (140 + reserve +
  // verify does not fit under the runner's 150-minute step ceiling).
  //
  // The full unsharded census — all five TCG sports, 65,518 rows, 67 pages —
  // completed in 25 SECONDS on 2026-09-05. Thirty minutes is therefore ~70x
  // the measured cost, which is the margin a census gets for a pool that keeps
  // growing, not a guess at an unknown runtime.
  //
  // RESERVE_MS is one PAGE, not one vertical: the unit of work here is a page
  // of `PAGE` rows, and the pre-check refuses the next page. A vertical-sized
  // reserve would be a guess at the very number this census exists to find.
  //
  // VERIFY_MS is small because there is no post-loop verify to cap: this lane
  // reconciles from counters it accumulated in the loop, and runs NO aggregate
  // after it — which is the whole point (an unbounded post-loop COUNT is what
  // got run 33960686247 killed after it had already reconciled clean).
  const B = budget({ minutes: 30, reserveMs: 90 * 1000, verifyMs: 60 * 1000, startedAt: t0 });

  console.log(`census-tcg-verticals  READ ONLY  page=${fmt(PAGE)}  ${WANT ? `games=${[...WANT].join(",")}` : "all games"}`);
  console.log(`  ${B.describe()}`);
  console.log(`  ${SHARD.banner()}`);
  console.log(`  90-day window from ${since90}`);
  console.log("");

  // The shard axis is the SPORT, because that is the query axis — sharding by
  // game would run the same sport query several times over.
  const mine = (s) => !SHARDED || (SPORTS.indexOf(s) % SLOTS) === SLOT;
  const sportsToWalk = SPORTS.filter(mine);

  /** Per-sport totals, and per-game title-attributed totals within them. */
  const bySport = {};
  const byGame = {};
  for (const g of GAMES) {
    byGame[g.key] = { key: g.key, label: g.label, publisher: g.publisher, source: g.source, rows: 0, dollars: 0, rows90d: 0, dollars90d: 0 };
  }
  // The residual: a row in a TCG sport that no game's title test claims.
  const unknown = { key: "unknown-tcg", label: "unknown TCG", rows: 0, dollars: 0, rows90d: 0, dollars90d: 0, sampleTitles: [] };

  let stoppedEarly = false;
  const incomplete = [];

  for (const sport of sportsToWalk) {
    if (B.outOfClock()) { stoppedEarly = true; incomplete.push(sport); continue; }
    const st0 = Date.now();
    const acc = { rows: 0, dollars: 0, rows90d: 0, dollars90d: 0 };
    let pages = 0;
    let finished = false;
    let token;

    // PAGED READ by continuation token. Projection only — never SELECT *, and
    // never an aggregate. `sport` is the partition-adjacent filter that keeps
    // each page cheap.
    const q = {
      query: "SELECT c.price, c.soldAt, c.title FROM c WHERE c.sport = @s",
      parameters: [{ name: "@s", value: sport }],
    };

    try {
      for (;;) {
        // THE PRE-CHECK, before the page rather than after it: a page that
        // cannot fit in the remaining clock is never started.
        if (B.outOfClock()) { stoppedEarly = true; break; }
        const it = pool.items.query(q, { maxItemCount: PAGE, continuationToken: token });
        const res = await it.fetchNext();
        pages += 1;
        for (const r of res.resources || []) {
          const price = Number(r.price) || 0;
          const recent = typeof r.soldAt === "string" && r.soldAt >= since90;
          acc.rows += 1; acc.dollars += price;
          if (recent) { acc.rows90d += 1; acc.dollars90d += price; }

          const title = String(r.title || "");
          let claimed = null;
          for (const g of GAMES) {
            if (!g.sports.includes(sport)) continue;
            if (g.title.test(title)) { claimed = g; break; }
          }
          const bucket = claimed ? byGame[claimed.key] : unknown;
          bucket.rows += 1; bucket.dollars += price;
          if (recent) { bucket.rows90d += 1; bucket.dollars90d += price; }
          if (!claimed && unknown.sampleTitles.length < 25 && title) unknown.sampleTitles.push(title.slice(0, 120));
        }
        token = res.continuationToken;
        if (!token) { finished = true; break; }
      }
    } catch (e) {
      console.log(`  ${sport.padEnd(11)} ERR ${e.message}`);
      incomplete.push(sport);
      bySport[sport] = { sport, error: e.message, ...acc, pages, complete: false };
      continue;
    }

    if (!finished) incomplete.push(sport);
    bySport[sport] = { sport, ...acc, pages, complete: finished, secs: +((Date.now() - st0) / 1000).toFixed(0) };
    console.log(
      `  ${sport.padEnd(11)} rows=${fmt(acc.rows).padStart(10)} ${money(acc.dollars).padStart(14)}`
      + `   90d: ${fmt(acc.rows90d).padStart(8)} rows ${money(acc.dollars90d).padStart(13)}`
      + `   pages=${pages} ${finished ? "" : "PARTIAL "}(${((Date.now() - st0) / 1000).toFixed(0)}s)`,
    );
  }

  // ── The report, per GAME — the number Drew asked for ───────────────────
  console.log("\n  PER GAME (title-attributed within the TCG sports)\n");
  console.log("    game                 rows        dollars        90d rows      90d dollars   publisher");
  const games = GAMES.filter((g) => !WANT || WANT.has(g.key)).map((g) => byGame[g.key]);
  for (const g of games) {
    console.log(
      `    ${g.label.padEnd(22)}${fmt(g.rows).padStart(9)} ${money(g.dollars).padStart(14)}`
      + `${fmt(g.rows90d).padStart(13)} ${money(g.dollars90d).padStart(16)}   ${g.publisher}`,
    );
  }
  console.log(
    `    ${unknown.label.padEnd(22)}${fmt(unknown.rows).padStart(9)} ${money(unknown.dollars).padStart(14)}`
    + `${fmt(unknown.rows90d).padStart(13)} ${money(unknown.dollars90d).padStart(16)}   —`,
  );

  if (unknown.sampleTitles.length) {
    console.log("\n  UNKNOWN-TCG SAMPLE TITLES (what no game's test claimed):");
    for (const t of unknown.sampleTitles.slice(0, 12)) console.log("    " + t);
  }

  // ── Reconciliation ────────────────────────────────────────────────────
  const sportRows = Object.values(bySport).reduce((a, s) => a + (s.rows || 0), 0);
  const gameRows = games.reduce((a, g) => a + g.rows, 0) + unknown.rows;
  console.log("");
  if (incomplete.length === 0 && !stoppedEarly) {
    console.log(`  RECONCILED  YES  sport rows ${fmt(sportRows)} = game-attributed ${fmt(gameRows)}`);
  } else {
    // A partial census says so. It is NOT a zero, and it is not a total.
    console.log(`  RECONCILED  PARTIAL  sport rows ${fmt(sportRows)} counted so far; incomplete: ${incomplete.join(", ") || "none"}`);
    console.log("  these counts are a FLOOR, not a total — the sports above did not finish their pages.");
  }
  if (stoppedEarly) {
    // THE MARKER IS A LITERAL, and must be. The runner's self-relaunch step for
    // this lane is keyed on "stopped at the … budget", and
    // everyWriteJobReconciles checks BOTH directions: a printer with no
    // relaunch (the fleet stops silently, green) and a relaunch whose script
    // never prints the marker (it waits for a line that never comes). Building
    // the phrase at runtime out of `B.stoppedAtBudget()` satisfied the RUNTIME
    // grep but not the SOURCE pin — the relaunch step added alongside this lane
    // was keyed on a marker this file never contained, so a budget stop would
    // have ended the census mid-shard with a green run. Same shape, and the
    // same fix, as repair-cpa-draft-refile.
    console.log(`  stopped at the ${B.RUN_MINUTES}-minute budget with sports left to walk`);
  }
  console.log("  (read-only: nothing was written, nothing was dispatched)");

  const doc = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    window90dFrom: since90,
    shard: { sharded: SHARDED, slot: SLOT, slots: SLOTS },
    complete: incomplete.length === 0 && !stoppedEarly,
    incompleteSports: incomplete,
    bySport,
    byGame: games,
    unknownTcg: unknown,
  };
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
    console.log("\n  census written to " + OUT);
  }
  // What finishLane disposes and reports from. A read-only lane still holds
  // the SDK's sockets, and this lane's pages are cross-partition reads: the
  // very shape whose abandoned request kept run 33960686247 alive to the
  // ceiling after it had already reconciled clean.
  return { client, budget: B };
})()
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). SUCCESS exits too. A lane
  // that ends by letting the event loop drain is betting that every library it
  // touched released every handle, and that bet costs a runner's ceiling and
  // the exit code of a census whose numbers were already correct. READ ONLY
  // does not exempt it: the handle that hangs is a *read*.
  .then((ctx) => finishLane(0, ctx || {}))
  .catch(async (e) => {
    console.error("ERR", e.stack || e.message);
    await finishLane(1, { client });
  });
