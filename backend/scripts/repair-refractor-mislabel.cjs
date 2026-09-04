#!/usr/bin/env node
/**
 * CF-REPAIR-THE-REFRACTOR-MISLABEL (Drew, 2026-08-25: "repair it").
 *
 * CF-CHROME-AUTO-DEFAULT-REFRACTOR (2026-07-31) is retracted. It claimed the
 * base tier of the chrome auto ladder IS Refractor, so any chrome auto title
 * with no colour rule matched was slugged ":refractor:" -- including titles
 * that said "Base" outright. Separately, the colour rules gated each colour on
 * its traditional print run, so "Purple /250" and "Aqua /125" lost the colour
 * and also landed on ":refractor:".
 *
 * Measured on 8,500 sampled rows carrying ':refractor:':
 *   21.8%  belong on :base:              a base auto sitting in a refractor pool
 *    3.0%  belong on :{colour}-refractor: the colour was dropped
 *   74.7%  are correct and are not touched
 *
 * THIS IS A CORRECTION, NOT A RECANONICALISATION. The only-improve rule
 * (never demote to a less specific slug) exists to stop a weaker parse
 * overwriting a stronger one. It must not apply here: refractor->base is not a
 * loss of specificity, it is the removal of an answer that was invented. The
 * title is the evidence and the title says base.
 *
 * THE DESTINATION MUST EXIST. A previous rematch computed destinations that
 * dropped the print run, so ':gold-refractor:auto' had no ':num-50' and the
 * row it pointed at did not exist -- the sales left one pool and arrived
 * nowhere. Every move here is checked against card_catalog first, and a move
 * whose destination is missing is REPORTED, not guessed at.
 *
 *   BACKFILL_APPLY  "true" to write; anything else reports only
 *   YEARS           comma list, or empty for every year present
 *   SLOT / SLOTS    partition the year list across parallel dispatches
 */
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(require("node:path").resolve(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { parseListingIdentity } = require(path.join(ROOT, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { unparsedVariantReason } = require(path.join(ROOT, "dist/services/catalog/attestationGuard.js"));

const APPLY = String(process.env.BACKFILL_APPLY || "") === "true";
const YEARS = String(process.env.YEARS || "").split(",").map(Number).filter(Boolean);
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
const SHARD_SCOPE = runnerShardScope({ label: "repair-refractor-mislabel" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

// "refractor" = only the plain-refractor segment (the original, narrow pass).
// "all"       = every slug whose parallel segment disagrees with its title.
const SCOPE = String(process.env.SCOPE || "refractor").toLowerCase();

const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The doubled-year producer is fixed (0000f60) but stored titles still carry
// it; strip so the parser sees what the seller actually wrote.
function dedupeYear(title, year) {
  const t = String(title ?? ""), y = String(year ?? "");
  return y && t.startsWith(y + " " + y + " ") ? t.slice(y.length + 1) : t;
}

/**
 * Rebuild a slug with a new parallel and print run, preserving everything else.
 * Layout: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N][:grade]
 * The print run travels WITH the parallel -- that is the bug that made the last
 * rematch point at rows which did not exist.
 */
function retarget(slug, parallelSlug, printRun) {
  const p = String(slug).split(":");
  if (p[0] !== "hiq" || p.length < 7) return null;
  const head = p.slice(0, 5);
  const auto = p[6];
  // Anything after the auto flag that is not a print run is carried through
  // untouched -- the grade suffix lives here and must survive.
  const tail = p.slice(7).filter((x) => !/^num-\d+$/.test(x));
  const run = Number(printRun) > 0 ? ["num-" + Number(printRun)] : [];
  return [...head, parallelSlug, auto, ...run, ...tail].join(":");
}

async function yearsPresent(sold) {
  if (YEARS.length) return YEARS;
  const rows = (await sold.items.query({
    query: "SELECT c.cardYear AS y, COUNT(1) AS n FROM c " +
           "WHERE IS_NUMBER(c.cardYear) AND IS_STRING(c.hobbyiqCardId) " +
           (SCOPE === "refractor" ? "AND CONTAINS(c.hobbyiqCardId, ':refractor:') " : "") +
           "GROUP BY c.cardYear",
  }).fetchAll()).resources;
  return rows.filter((r) => r.y >= 1990 && r.y <= 2030)
    .sort((a, b) => b.n - a.n).map((r) => r.y);
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

  const all = await yearsPresent(sold);
  const years = all.filter((_, i) => i % SLOTS === SLOT);
  console.log("years with ':refractor:' sales: " + all.length +
              "   this worker (slot " + SLOT + "/" + SLOTS + "): " + years.length);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const total = { seen: 0, correct: 0, toBase: 0, toColour: 0, other: 0, noDest: 0, held: 0, wrote: 0, failed: 0 };
  const destCache = new Map();

  // CF-THE-SCAN-CAN-BE-THROTTLED-TOO (2026-08-25). The first apply run lost 3
  // of 8 workers to "The request rate is too large" thrown from fetchNext --
  // not from a write. sold_comps is provisioned at 8,000 RU against
  // card_catalog's 400,000, so 8 workers reading it in parallel saturate the
  // container and the SDK's own retry budget (60 attempts / 300s) runs out.
  //
  // A throttled QUERY is the same claim as a throttled write: not now, ask
  // again. Letting it reach the top level kills the worker and abandons every
  // year it had not reached yet, which is how a partial run reports FATAL and
  // looks like a code fault rather than a capacity one.
  const queryWithRetry = async (spec, opts) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await sold.items.query(spec, opts).fetchNext();
      } catch (e) {
        const throttled = /request rate is too large|429/i.test(String(e?.message));
        if (!throttled || attempt >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  const destExists = async (slug) => {
    if (destCache.has(slug)) return destCache.get(slug);
    let ok = false;
    try { ok = !!(await cat.item(slug, slug).read()).resource; } catch { ok = false; }
    destCache.set(slug, ok);
    return ok;
  };

  for (const year of years) {
    let token, seen = 0, correct = 0, toBase = 0, toColour = 0, other = 0, noDest = 0, wrote = 0, failed = 0, held = 0;
    const heldWhy = new Map();
    const samples = [], missing = new Map();

    do {
      const page = await queryWithRetry(
        { query: "SELECT c.id, c.cardId, c.title, c.hobbyiqCardId, c.cardYear FROM c " +
                 "WHERE c.cardYear = @y AND IS_STRING(c.hobbyiqCardId) " +
                 (SCOPE === "refractor" ? "AND CONTAINS(c.hobbyiqCardId, ':refractor:')" : ""),
          parameters: [{ name: "@y", value: year }] },
        { maxItemCount: 400, continuationToken: token },
      );
      token = page.continuationToken;

      for (const r of page.resources) {
        seen++;
        const parts = String(r.hobbyiqCardId).split(":");
        const current = parts[5];
        // CF-GOLD-REFRACTOR-DOES-NOT-CONTAIN-COLON-REFRACTOR (Drew, 2026-08-25:
        // "i did the marconi and still shows bases").
        //
        // The first pass scanned CONTAINS(hobbyiqCardId, ':refractor:') and
        // only handled the segment that is EXACTLY "refractor". ':gold-
        // refractor:' does not contain ':refractor:', so every COLOUR pool went
        // unscanned -- and those are the pools that hurt most, because a base
        // auto sitting in Gold prices a /50 off $9 commons:
        //
        //   hiq:...:cpa-mg:gold-refractor:auto   51 sales, median $10.01
        //     "Marconi German 2026 Bowman #CPA-MG Chrome Auto Rookie 1st RC"
        //     "2026 Bowman Chrome Prospect Autographs Marconi German #CPA-MG"
        //   -- neither title says Gold. Both are base.
        //
        // SCOPE=all compares every slug's parallel segment against its own
        // title, which is what the fix always should have been. The narrow
        // scope stays available because it is far cheaper to re-run.
        if (SCOPE === "refractor" && current !== "refractor") { correct++; continue; }
        if (!current) { correct++; continue; }

        let parsed = {};
        try { parsed = parseListingIdentity(dedupeYear(r.title, r.cardYear)) || {}; } catch { correct++; continue; }
        const want = slugify(parsed.parallel || "base") || "base";
        if (want === current) { correct++; continue; }

        // A move is only as good as the parse behind it. The dry run found
        //   "#CPA-BA Brailyn Antunez 2026 Bowman ... Chrome PackFractor /89"
        // which the parser reads as Base -- moving it would have filed a real
        // /89 parallel into the base pool, trading one mislabel for another.
        // If the title names something the parse does not carry, leave the row
        // where it is: it is already wrong, and a second wrong move buries it.
        const holdReason = unparsedVariantReason({
          title: r.title, parsedParallel: parsed.parallel,
          parsedIsAuto: parsed.isAuto, parsedPrintRun: parsed.printRun,
        });
        if (holdReason) { held++; heldWhy.set(holdReason, (heldWhy.get(holdReason) || 0) + 1); continue; }

        const dest = retarget(r.hobbyiqCardId, want, parsed.printRun);
        if (!dest || dest === r.hobbyiqCardId) { correct++; continue; }

        if (!(await destExists(dest))) {
          noDest++;
          missing.set(dest, (missing.get(dest) || 0) + 1);
          continue;
        }

        if (want === "base") toBase++; else if (want.endsWith("refractor")) toColour++; else other++;
        if (samples.length < 4) samples.push({ t: r.title, from: r.hobbyiqCardId, to: dest });

        if (!APPLY) continue;
        try {
          const d = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
          if (!d) continue;
          d.hobbyiqCardId = dest;
          d.parallelRepairedBy = {
            by: "repair-refractor-mislabel",
            was: r.hobbyiqCardId,
            reason: "CF-CHROME-AUTO-DEFAULT-REFRACTOR retracted 2026-08-25",
            at: new Date().toISOString(),
          };
          await sold.item(r.id, r.cardId ?? r.id).replace(d);
          wrote++;
        } catch (e) {
          if (/request rate is too large|429/i.test(String(e?.message))) {
            // Same claim, same answer: wait and try this row once more before
            // charging it to failed.
            await new Promise((res) => setTimeout(res, 2000));
            try {
              const d2 = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
              if (d2) {
                d2.hobbyiqCardId = dest;
                d2.parallelRepairedBy = { by: "repair-refractor-mislabel", was: r.hobbyiqCardId,
                  reason: "CF-CHROME-AUTO-DEFAULT-REFRACTOR retracted 2026-08-25", at: new Date().toISOString() };
                await sold.item(r.id, r.cardId ?? r.id).replace(d2);
                wrote++;
                continue;
              }
            } catch { /* falls through to failed */ }
          }
          failed++;
        }
      }
    } while (token);

    total.seen += seen; total.correct += correct; total.toBase += toBase;
    total.toColour += toColour; total.other += other; total.noDest += noDest;
    total.wrote += wrote; total.failed += failed; total.held += held;

    console.log("  " + year + "  seen " + String(seen).padStart(7) +
                "  correct " + String(correct).padStart(7) +
                "  ->base " + String(toBase).padStart(6) +
                "  ->colour " + String(toColour).padStart(5) +
                "  held " + String(held).padStart(5) +
                "  noDest " + String(noDest).padStart(6) +
                "  wrote " + String(wrote).padStart(6));
    if (!APPLY) {
      for (const s of samples) {
        console.log("        " + String(s.t || "").slice(0, 86));
        console.log("           " + s.from + "\n        -> " + s.to);
      }
      // A destination that does not exist is a catalog gap, not a bad move.
      // Reported so the gap can be filled rather than silently skipped.
      for (const [d, n] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        console.log("        MISSING DEST x" + n + "  " + d);
      }
      if (held) console.log("        HELD " + [...heldWhy].map(([k, v]) => k + " " + v).join(", "));
    }
  }

  console.log("");
  console.log("TOTAL " + JSON.stringify(total));
  if (!APPLY) console.log("REPORT ONLY - nothing written.");

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. Three of this job's workers have already
  // died mid-scan on a 429 and abandoned every year they had not reached; that
  // failure at least exits 3. This covers the quieter one — finishing the scan
  // but not writing what the scan decided on.
  //
  // "Intended" is every row this run made a decision about: the moves it chose,
  // PLUS the ones it deliberately held (guard) or could not place (no
  // destination row). Declaring those keeps them out of the shortfall — they
  // are accounted for, not vanished — while still failing the run if a move it
  // committed to never reached the database.
  if (APPLY) {
    const moves = total.toBase + total.toColour + total.other;
    reportWrites({
      job: "repair-refractor-mislabel",
      intended: moves + total.held + total.noDest,
      written: total.wrote,
      skipped: total.held + total.noDest,
      failed: total.failed,
    });
  }
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
