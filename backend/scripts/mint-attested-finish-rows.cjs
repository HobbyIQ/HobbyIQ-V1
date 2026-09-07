#!/usr/bin/env node
/**
 * CF-A-FINISH-IS-A-CARD-LINE (Drew, 2026-09-07).
 *
 * THE RULING. A Pokemon FINISH -- Holofoil / Reverse Holofoil / Normal, and the
 * era equivalents ("Cosmos Holo", "Cracked Ice") -- IS A DISTINCT CARD LINE. It
 * gets its own catalog row and its own pool, exactly as a refractor rung does
 * on the sports side. `1st Edition` is a SEPARATE AXIS and is NOT a finish;
 * it is not minted here.
 *
 * THE PROBLEM THE RULING CREATES. tcgdex checklists carry NO finish. They list
 * a set code, a card number and a name -- and that is the whole checklist. So
 * the finish rows the ruling requires cannot come from the checklist, and the
 * only place the finish is ever WRITTEN DOWN is the market itself:
 *
 *   "Eevee V - SWSH: Crown Zenith - Holofoil"          TCGplayer, via tca-ebay
 *   "Charizard ex - SV: Obsidian Flames - Holofoil"    same shape
 *   CardHedge product labels state it too
 *
 * THAT IS AN ATTESTATION, NOT AN IDENTITY. Standing doctrine
 * (feedback_no_synthetic_parallels_only_actuals, and the "self derived" ruling
 * of 2026-09-04) forbids minting an identity FROM SALES. This lane does not.
 * What it mints is a CHECKLIST-BACKED IDENTITY PLUS AN ATTESTED ATTRIBUTE:
 *
 *   the checklist card       (set code, number, name)  <- tcgdex, already ours
 *   + the finish             stated by a source        <- the attestation
 *   = the finish row
 *
 * so the row is only ever as real as the checklist row it hangs under, and the
 * finish is only ever as real as the source that said it out loud. NEITHER HALF
 * IS GUESSED. The attestation is RECORDED on the row -- `source`,
 * `attestationCount`, `attestedBy`, `attestationExamples` -- so a reader can
 * always see which sales bought this row its existence, and a later ruling can
 * retire it by that name.
 *
 * WHAT IT REFUSES TO MINT, counted and never written:
 *   noChecklistCard  the checklist card (same set code, number, `:base:` rung)
 *                    is NOT in card_catalog. THE PARENT MUST EXIST. Minting
 *                    here would create an UNBACKED IDENTITY -- a card line
 *                    hanging on nothing, which is the exact failure the
 *                    "self derived" ruling names. Reported as an ACQUISITION
 *                    LIST (go get the checklist), never guessed at.
 *   marketMismatch   the sale's slug carries a JAPANESE set code while the
 *                    attesting title states an ENGLISH market (or the reverse).
 *                    EN `sv10-5b` and JA `sv11b` are DIFFERENT PRODUCTS that
 *                    share a name; a finish row minted across that line fuses
 *                    two markets into one pool.
 *   notAFinish       the parallel segment names something that is not a print
 *                    finish -- `1st-edition` (a separate axis), `full-art` (a
 *                    card TYPE), `master-ball` (a stamp). Only FINISH_TOKENS
 *                    below is admitted, and it is a CLOSED vocabulary.
 *   belowFloor       fewer than MIN_ATTESTATIONS sales state this finish for
 *                    this card. One mislabelled vendor row is not a card line
 *                    (project_ch_product_label_becomes_sale_parallel: a CH
 *                    product label became a sale parallel and minted a rung
 *                    that did not exist).
 *   exists           the finish row is already there. Idempotent: a re-run
 *                    REFRESHES the attestation count on a row this lane owns
 *                    and otherwise leaves it alone -- it never overwrites a
 *                    checklist-sourced or user-ruled row.
 *
 * SCOPE IS AN INPUT, AND A WHOLE-SCOPE WRITE REFUSES WITHOUT ONE.
 * (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME.) Report-only runs wide freely --
 * that is how the census gets measured -- but APPLY with YEARS and SETKEYS both
 * empty is refused: minting catalog rows corpus-wide needs its name said out
 * loud.
 *
 * MEASURED BEFORE IT WAS WRITTEN (read-only census, 2026-09-06, the whole
 * Pokemon pool -- 3,262,614 sold_comps rows against 244,178 catalog rows):
 *
 *   310,814  sales whose slug STATES a finish
 *   190,676    already backed by an exact catalog row
 *   120,138    UNBACKED -- no catalog row at that exact slug
 *      86,531    checklist card present  -> MINTABLE by this lane
 *      33,607    checklist card absent   -> acquisition list, refused
 *
 *   unbacked by finish   89,747 reverse-holo   17,313 reverse-foil
 *                         4,888 reverse         3,874 holofoil
 *                         2,442 reverse-holofoil  839 cracked-ice ...
 *   unbacked by band    103,526 2023-2026   9,511 2015-2022
 *                         6,918 2000-2014     183 pre-2000
 *   unbacked by source  113,420 cardhedge   6,718 tca-ebay
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      BACKFILL_APPLY=true to write   (the runner exports BACKFILL_APPLY, not
 *                                      APPLY; APPLY=true also accepted)
 *      YEARS      comma list, e.g. 2023            (empty = every year)
 *      SETKEYS    comma list, e.g. sv03,me04       (empty = every set code)
 *      MIN_ATTESTATIONS=2   sales that must state the finish before it is a line
 *      SLOT/SLOTS shard the work across parallel dispatches
 *      RUN_MINUTES=140  budget marker; prints RELAUNCH_NEEDED= for the runner
 *      LIMIT=0    bounded dry run (a LIMIT stop is NOT a budget stop)
 */
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const { CosmosClient } = require("@azure/cosmos");
const ROOT = path.resolve(__dirname, "..");
const { deriveCatalogEntry } = require(path.join(ROOT, "dist/services/portfolioiq/cardCatalog.service.js"));
const { POKEMON_EN_SET_CODES, POKEMON_JA_SET_CODES } = require(path.join(ROOT, "dist/services/catalog/pokemonSetCodes.js"));
const { reportWrites } = require(path.join(ROOT, "dist/services/ops/writeReconciliation.js"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = list(process.env.YEARS).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SETKEYS = list(process.env.SETKEYS);
const MIN_ATTESTATIONS = Math.max(1, Number(process.env.MIN_ATTESTATIONS || 2));

// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756). The runner exports
// `slots` for EVERY script with a workflow-wide default of "16", so sharding is
// OPT-IN via the shared helper: an inherited slot=0/slots=16 sweeps EVERY row.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "mint-attested-finish-rows" });
const { SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top -- a check that runs after
 *  the unit admits one more unit of unbounded size past expiry, and the
 *  150-minute action ceiling then KILLS the step mid-write.
 *
 *  Sized to this lane's LARGEST unit. That is a pass-3 mint: two cached point
 *  reads already paid for in pass 2, one `deriveCatalogEntry`, and one upsert
 *  with a 429 retry that sleeps 2s and tries again. 90s covers that with room
 *  for a throttled account, and matches the reserve the sibling repair lanes
 *  (repair-base-to-title-finish, repair-refractor-mislabel) settled on for the
 *  same single-row-write shape. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);

const f = (n) => Number(n).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;

// THE VOCABULARY IS THE RULING, so it lives in one file and is pinned by test
// there rather than re-typed here. See lib/pokemon-finish-vocab.cjs for what
// counts as a finish and, just as load-bearing, what deliberately does not.
const { FINISH_TOKENS, FINISH_DISPLAY, finishOf, titleMarket } =
  require(path.join(__dirname, "lib", "pokemon-finish-vocab.cjs"));

/**
 * THE MARKET A SET CODE BELONGS TO. EN `sv10-5b` and JA `sv11b` are different
 * products that share a name, so a finish row minted across the line fuses two
 * markets into one pool. A code in NEITHER table is `null` -- unknown, and
 * unknown is not a mismatch (the guard refuses only a POSITIVE disagreement).
 */
function marketOf(setCode) {
  const k = String(setCode ?? "").toLowerCase();
  if (POKEMON_EN_SET_CODES[k]) return "en";
  if (POKEMON_JA_SET_CODES[k]) return "ja";
  return null;
}

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE. Refused before the
// connection string is even read, so a mis-dispatched apply dies on its own
// arguments and never touches the account.
if (APPLY && !YEARS.length && !SETKEYS.length) {
  console.error("REFUSED: BACKFILL_APPLY=true with YEARS and SETKEYS both empty mints catalog rows corpus-wide.");
  console.error("         Name at least one axis (e.g. YEARS=2023, or SETKEYS=sv03,me04), or drop APPLY to report.");
  process.exit(2);
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`mint-attested-finish-rows  ${APPLY ? "APPLY" : "REPORT ONLY"}` +
              `  years=${YEARS.join(",") || "ALL"}  setKeys=${SETKEYS.join(",") || "ALL"}` +
              `  minAttestations=${MIN_ATTESTATIONS}  slot ${SLOT}/${SLOTS}` +
              `  budget ${RUN_MINUTES}m${LIMIT ? `  limit ${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  // CF-THE-SCAN-CAN-BE-THROTTLED-TOO. A throttled QUERY is the same claim as a
  // throttled write: not now, ask again. Letting it reach the top level kills
  // the worker and abandons everything it had not reached.
  const queryWithRetry = async (container, spec, opts) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await container.items.query(spec, opts).fetchNext(); }
      catch (e) {
        const throttled = /request rate is too large|429|ETIMEDOUT|ECONNRESET|503/i.test(String(e?.message));
        if (!throttled || attempt >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  const stats = {
    seen: 0, mine: 0, notAFinish: 0, marketMismatch: 0,
    candidates: 0, belowFloor: 0, noChecklistCard: 0, exists: 0,
    mints: 0, wrote: 0, refreshed: 0, failed: 0,
  };
  // "<destSlug>" -> { parent, finish, setCode, year, count, sources:Map, titles:[] }
  const wanted = new Map();
  const acquisition = new Map();   // "<setCode>|<finish>" -> count, the refusal list
  const byPair = new Map();        // "<setCode>|<finish>" -> would-mint row count
  const mismatchExamples = [];
  let stopReason = "";

  // ---------------------------------------------------------------------
  // PASS 1 -- what the SALES attest. Page the hobbyiqCardId prefix; never a
  // cross-partition COUNT over 3.2M rows.
  // ---------------------------------------------------------------------
  const where = ["STARTSWITH(c.hobbyiqCardId, @p)"];
  const params = [{ name: "@p", value: "hiq:pokemon:" }];
  if (YEARS.length) {
    where.push(`c.cardYear IN (${YEARS.map((_, i) => `@y${i}`).join(",")})`);
    YEARS.forEach((y, i) => params.push({ name: `@y${i}`, value: y }));
  }
  if (SETKEYS.length) {
    where.push(`(${SETKEYS.map((_, i) => `CONTAINS(c.hobbyiqCardId, @sk${i})`).join(" OR ")})`);
    SETKEYS.forEach((k, i) => params.push({ name: `@sk${i}`, value: `:${k}:` }));
  }

  let token;
  outer:
  do {
    if (budgetLeft() < RESERVE_MS) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
    const page = await queryWithRetry(sold,
      { query: `SELECT c.hobbyiqCardId, c.title, c.playerName, c.cardYear, c.source FROM c WHERE ${where.join(" AND ")}`,
        parameters: params },
      { maxItemCount: 1000, continuationToken: token });
    token = page.continuationToken;

    for (const r of page.resources) {
      stats.seen++;
      const slug = String(r.hobbyiqCardId ?? "");
      const parts = slug.split(":");
      if (parts.length < 7) continue;
      if (SLOTS > 1 && shardOf(slug) !== SLOT) continue;
      stats.mine++;
      if (LIMIT && stats.mine >= LIMIT) { stopReason = `stopped at LIMIT=${f(LIMIT)} (a dry-run bound, not a budget stop)`; break outer; }

      const finish = finishOf(parts[5]);
      // Not a finish at all -- `1st-edition`, `full-art`, `master-ball`. Real
      // card lines, simply not this ruling's business.
      if (!finish) { stats.notAFinish++; continue; }

      const setCode = parts[3];
      // JA <-> EN: a POSITIVE disagreement between the slug's set code and the
      // title's stated market. Unknown on either side is not a mismatch.
      const slugMarket = marketOf(setCode);
      const stated = titleMarket(r.title);
      if (slugMarket && stated && slugMarket !== stated) {
        stats.marketMismatch++;
        if (mismatchExamples.length < 6) {
          mismatchExamples.push(`  ${setCode} is ${slugMarket.toUpperCase()}, title says ${stated.toUpperCase()}: "${String(r.title).slice(0, 62)}"`);
        }
        continue;
      }

      stats.candidates++;
      // The destination is the slug with the finish CANONICALIZED -- so the
      // three spellings of one reverse finish reach ONE row.
      const dest = [...parts.slice(0, 5), finish, ...parts.slice(6)].join(":");
      // The checklist card: the same address at the `:base:` rung.
      const parent = [...parts.slice(0, 5), "base", ...parts.slice(6)].join(":");

      let w = wanted.get(dest);
      if (!w) {
        w = { parent, finish, setCode, year: r.cardYear ?? null, count: 0,
              sources: new Map(), titles: [], player: null };
        wanted.set(dest, w);
      }
      w.count++;
      w.sources.set(r.source || "?", (w.sources.get(r.source || "?") || 0) + 1);
      if (w.titles.length < 3 && r.title) w.titles.push(String(r.title).slice(0, 120));
      if (!w.player && r.playerName) w.player = r.playerName;
    }
  } while (token);

  console.log(`\n  pass 1 -- sales scanned ${f(stats.seen)}  this shard ${f(stats.mine)}  ` +
              `finish-stating ${f(stats.candidates)}  distinct destinations ${f(wanted.size)}`);

  // ---------------------------------------------------------------------
  // PASS 2 -- does the CHECKLIST CARD exist, and does the finish row already?
  // Point reads, cached, and only for the destinations pass 1 actually found.
  // ---------------------------------------------------------------------
  const rowCache = new Map();
  const readRow = async (slug) => {
    if (rowCache.has(slug)) return rowCache.get(slug);
    let row = null;
    try { row = (await cat.item(slug, slug).read()).resource ?? null; } catch { row = null; }
    rowCache.set(slug, row);
    return row;
  };

  const toMint = [];
  for (const [dest, w] of wanted) {
    // BEFORE the unit, not after it: this unit issues point reads and may
    // issue a replace, and a check at the loop top would admit one past expiry.
    if (budgetLeft() < RESERVE_MS) { stopReason = stopReason || `stopped at the ${RUN_MINUTES}-minute budget`; break; }

    // ONE mislabelled vendor row is not a card line.
    if (w.count < MIN_ATTESTATIONS) { stats.belowFloor++; continue; }

    // THE PARENT MUST EXIST. Never mint an unbacked identity.
    const parentRow = await readRow(w.parent);
    if (!parentRow) {
      stats.noChecklistCard++;
      const k = `${w.setCode}|${w.finish}`;
      acquisition.set(k, (acquisition.get(k) || 0) + 1);
      continue;
    }

    const existing = await readRow(dest);
    if (existing) {
      stats.exists++;
      // Idempotent, and it only ever touches a row THIS LANE MINTED. A
      // checklist-sourced or user-ruled row at this address is left alone --
      // refreshing a count onto it would restate someone else's provenance.
      if (APPLY && String(existing.source ?? "").startsWith("finish-attested:")
          && Number(existing.attestationCount ?? 0) !== w.count) {
        try {
          existing.attestationCount = w.count;
          existing.attestedBy = [...w.sources.keys()].sort();
          existing.lastSeenAt = new Date().toISOString();
          await cat.item(dest, dest).replace(existing);
          stats.refreshed++;
        } catch { stats.failed++; }
      }
      continue;
    }

    stats.mints++;
    byPair.set(`${w.setCode}|${w.finish}`, (byPair.get(`${w.setCode}|${w.finish}`) || 0) + 1);
    toMint.push({ dest, w, parentRow });
  }

  // ---------------------------------------------------------------------
  // PASS 3 -- mint. The identity comes from the PARENT (the checklist card);
  // only the finish comes from the sales.
  // ---------------------------------------------------------------------
  if (APPLY) {
    for (const { dest, w, parentRow } of toMint) {
      // BEFORE the mint. A mint is this lane's largest unit (derive + upsert +
      // a 429 retry that sleeps 2s), so the reserve is checked here rather than
      // at the loop top, where it would admit one more past expiry.
      if (budgetLeft() < RESERVE_MS) { stopReason = stopReason || `stopped at the ${RUN_MINUTES}-minute budget`; break; }
      const parts = dest.split(":");
      const printRun = parts[7] && parts[7].startsWith("num-") ? Number(parts[7].slice(4)) : null;
      // The dominant attesting source names the provenance.
      const topSource = [...w.sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      const entry = deriveCatalogEntry({
        sport: "pokemon",
        year: parentRow.year ?? parentRow.cardYear ?? w.year,
        setKey: parts[3],
        cardNumber: parts[4],
        // The DISPLAY name, so the row reads as the card line it is and
        // normalizeParallel slugs it straight back to this address.
        parallel: FINISH_DISPLAY[w.finish] ?? w.finish,
        isAuto: parts[6] === "auto",
        printRun,
        // THE IDENTITY IS THE PARENT'S. Never a seller's word for the player.
        playerName: parentRow.playerName ?? w.player ?? "",
        setName: parentRow.setName ?? null,
        source: `finish-attested:${topSource}`,
        confidence: parentRow.confidence ?? 0.9,
        vendorIds: {},
        // The checklist decided this product's key; do not re-derive it.
        authoritativeSetKey: true,
      });
      if (!entry || entry.id !== dest) {
        // deriveCatalogEntry is the canonical constructor. If it does not agree
        // this row lives at `dest`, the disagreement is the answer -- a mint at
        // an address the deriver would not build is exactly the multi-home
        // defect CF-ONE-CARD-ONE-ROW-ONE-POOL forbids.
        stats.failed++;
        continue;
      }
      try {
        const now = new Date().toISOString();
        await cat.items.upsert({
          ...entry,
          observedAt: now,
          lastSeenAt: now,
          // THE ATTESTATION, ON THE ROW. Which sales bought this row its
          // existence, so a later ruling can retire it by name.
          attestationCount: w.count,
          attestedBy: [...w.sources.keys()].sort(),
          attestationExamples: w.titles,
          parentSlug: w.parent,
          mintedBy: {
            by: "mint-attested-finish-rows",
            reason: "CF-A-FINISH-IS-A-CARD-LINE (Drew, 2026-09-07)",
            at: now,
          },
        });
        stats.wrote++;
      } catch (e) {
        if (/request rate is too large|429/i.test(String(e?.message))) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const now = new Date().toISOString();
            await cat.items.upsert({
              ...entry, observedAt: now, lastSeenAt: now,
              attestationCount: w.count, attestedBy: [...w.sources.keys()].sort(),
              attestationExamples: w.titles, parentSlug: w.parent,
              mintedBy: { by: "mint-attested-finish-rows",
                reason: "CF-A-FINISH-IS-A-CARD-LINE (Drew, 2026-09-07)", at: now },
            });
            stats.wrote++;
            continue;
          } catch { /* falls through to failed */ }
        }
        stats.failed++;
      }
    }
  }

  // ---------------------------------------------------------------------
  // THE BANNER.
  // ---------------------------------------------------------------------
  console.log("");
  console.log(`  sales scanned (scope)     ${f(stats.seen)}`);
  console.log(`  this shard                ${f(stats.mine)}`);
  console.log(`  not a finish              ${f(stats.notAFinish)}   <- 1st-edition / full-art / a stamp; real lines, not finishes`);
  console.log(`  REFUSED market mismatch   ${f(stats.marketMismatch)}   <- slug's set code and title's market disagree (EN vs JA)`);
  console.log(`  finish-stating sales      ${f(stats.candidates)}`);
  console.log(`  distinct destinations     ${f(wanted.size)}`);
  console.log(`  REFUSED below floor       ${f(stats.belowFloor)}   <- fewer than ${MIN_ATTESTATIONS} attesting sales; one vendor label is not a card line`);
  console.log(`  REFUSED no checklist card ${f(stats.noChecklistCard)}   <- parent absent from card_catalog; an acquisition list, never an unbacked mint`);
  console.log(`  already present           ${f(stats.exists)}   (refreshed ${f(stats.refreshed)})`);
  console.log(`  WOULD MINT                ${f(stats.mints)}`);
  console.log(`  wrote                     ${f(stats.wrote)}`);
  console.log(`  failed                    ${f(stats.failed)}`);

  if (byPair.size) {
    console.log(`\n  would-mint by (set code, finish):`);
    for (const [k, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      const [sc, fin] = k.split("|");
      console.log(`    ${String(n).padStart(7)}  ${sc.padEnd(28)} ${fin}`);
    }
  }
  if (acquisition.size) {
    console.log(`\n  ACQUISITION LIST -- checklist card missing, by (set code, finish):`);
    for (const [k, n] of [...acquisition.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      const [sc, fin] = k.split("|");
      console.log(`    ${String(n).padStart(7)}  ${sc.padEnd(28)} ${fin}`);
    }
  }
  if (mismatchExamples.length) {
    console.log(`\n  market-mismatch examples:`);
    for (const e of mismatchExamples) console.log(e);
  }
  if (stopReason) console.log(`\n${stopReason}`);
  if (!APPLY) console.log("\nREPORT ONLY - nothing written.");

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. What this run decided, against what it
  // wrote. Every refusal is DECLARED as skipped -- accounted for, not vanished
  // -- so it stays out of the shortfall, while a committed mint that never
  // reached the database still fails the run.
  const intended = stats.mints + stats.belowFloor + stats.noChecklistCard + stats.marketMismatch;
  const skipped = stats.belowFloor + stats.noChecklistCard + stats.marketMismatch
    + (APPLY ? 0 : stats.mints);
  reportWrites({
    job: "mint-attested-finish-rows",
    intended,
    written: APPLY ? stats.wrote : 0,
    skipped,
    failed: stats.failed,
  });

  // The budget marker the runner relaunches on, verbatim. A LIMIT stop is a
  // dry-run bound and does NOT ask for a relaunch.
  const budgetStopped = budgetLeft() < RESERVE_MS;
  console.log(`RELAUNCH_NEEDED=${budgetStopped ? "true" : "false"}`);
})()
  // CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
  // that lets the loop drain is betting every library released every handle.
  .then(() => finishLane(process.exitCode || 0))
  .catch(async (e) => {
    console.error("FATAL:", e?.stack || e?.message || String(e));
    console.log("RELAUNCH_NEEDED=true");
    await finishLane(3);
  });
