#!/usr/bin/env node
// CF-TCG-SALES-OUT-OF-THE-BOWMAN-NAMESPACE (Drew, 2026-08-25).
//
// The repair half of CF-ONE-PIECE-IS-NOT-A-BOWMAN-CARD. That fix stopped TCA's
// mis-categorised `card_set` from being trusted on ingest; these are the rows
// already written under it:
//
//   hiq:anime-tcg:2025:bowman:eb02:base:no-auto
//     "2025 One Piece Night X Los Angeles Dodgers Monkey D Luffy #EB02-010"
//   hiq:anime-tcg:2002:bowman:301:base:no-auto
//     "NARUTO CCG 2002 Rare #301 SUPREME NINJUTSU ..."
//
// 2,433 One Piece and Naruto sales sitting in the single most valuable setKey
// namespace we have. The sport segment is already right -- only the set is
// wrong -- so the defect is exactly stateable: a row whose SPORT says this is
// not a sports card, filed under a setKey that names a real SPORTS product.
// That is the only thing this touches.
//
// SCOPE, MEASURED PROPERLY. 31,213 rows carry an anime-tcg slug in total and
// 17,180 are already `unknown`; only 2,433 are in `bowman`. An early SELECT TOP
// 400 with no ORDER BY returned nothing but bowman rows and made this look like
// a 30k-row problem. TOP without ORDER BY is not a sample.
//
// WHERE THEY GO. To whatever our own parser says, which for every one of these
// titles is "Unknown" -> `unknown`. That is deliberately unambitious. The
// titles do carry real set codes (OP07, EB02, OP09-107) and a franchise, and a
// setKey like `one-piece-op07` would be more useful -- but anime-tcg is a
// PARKED vertical pending the sport->vertical schema refactor, and minting
// vocabulary for a parked vertical is how a catalog acquires names nothing else
// agrees with. `unknown` is honest, reversible, and stops the poisoning today;
// the franchise extraction can happen when the vertical is unparked. The count
// of rows that COULD be resolved further is reported so that work is sized.
//
// SAFE BY CONSTRUCTION. sold_comps partitions on /cardId, and cardId here is
// the vendor id, not the slug -- so this rewrites hobbyiqCardId in place and no
// document ever changes partition. The original slug is preserved on the row.
//
// Env:
//   COSMOS_CONNECTION_STRING  required
//   APPLY=true                actually write (default dry-run)
//   SPORTS=anime-tcg,...      which non-sport categories to sweep
//   CONCURRENCY=16            parallel patches
//   LIMIT=0                   stop after N patches (0 = no limit)

const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { computeHobbyIqCardId, matchKnownProductLine } =
  require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { inferSetKeyFromTitle } =
  require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

// The runner sets BACKFILL_APPLY, not APPLY. Reading only APPLY would make
// this dry-run forever under the workflow while looking like it had run.
const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 16);
const LIMIT = Number(process.env.LIMIT || 0);
const SPORTS = String(process.env.SPORTS || "anime-tcg,pokemon,non-sport,tcg-other,motorsport,combat-sport")
  .split(",").map((s) => s.trim()).filter(Boolean);

// A franchise marker in the title means the row could be resolved to a real TCG
// set later. Counted only -- never written. See "WHERE THEY GO" above.
const FRANCHISE = /\b(one\s+piece|naruto|dragon\s*ball|digimon|weiss\s+schwarz|yu-?gi-?oh|magic\s+the\s+gathering|\bmtg\b|lorcana|pokemon)\b/i;

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sc = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("sold_comps");

  let scanned = 0, candidates = 0, patched = 0, failed = 0, unchanged = 0, resolvable = 0;
  const bySetKey = new Map();
  const samples = [];

  const inList = SPORTS.map((s) => `'${s.replace(/'/g, "")}'`).join(",");
  let token;
  do {
    const page = await sc.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.title, c.sport, c.cardYear, c.cardNumber,
                     c.parallel, c.isAuto, c.printRun, c.setName
              FROM c WHERE c.sport IN (${inList}) AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null`,
    }, { maxItemCount: 500, continuationToken: token }).fetchNext();
    token = page.continuationToken;

    const work = [];
    for (const r of page.resources) {
      scanned++;
      const parts = String(r.hobbyiqCardId).split(":");
      const setSeg = parts[3] ?? "";
      // THE defect: sport says not-a-sports-card, setKey names a sports product.
      // Anything else in this sport is left completely alone.
      if (!setSeg || matchKnownProductLine(setSeg) === null) continue;
      candidates++;
      bySetKey.set(setSeg, (bySetKey.get(setSeg) || 0) + 1);
      if (FRANCHISE.test(String(r.title ?? ""))) resolvable++;

      const newSetKey = inferSetKeyFromTitle(String(r.title ?? ""), r.cardNumber ?? null);
      const newSlug = computeHobbyIqCardId({
        sport: r.sport, year: r.cardYear, setKey: newSetKey,
        cardNumber: r.cardNumber, parallel: r.parallel ?? "",
        isAuto: r.isAuto === true, printRun: r.printRun ?? null,
      });
      // A slug that will not recompute cleanly, or that did not move out of the
      // sports namespace, is left alone rather than half-repaired.
      if (!newSlug || !newSlug.startsWith("hiq:")) { unchanged++; continue; }
      if (newSlug === r.hobbyiqCardId) { unchanged++; continue; }
      if (matchKnownProductLine(newSlug.split(":")[3] ?? "") !== null) { unchanged++; continue; }

      if (samples.length < 8) {
        samples.push(`${r.hobbyiqCardId}\n        -> ${newSlug}\n           ${String(r.title ?? "").slice(0, 88)}`);
      }
      work.push({ r, newSlug });
    }

    if (APPLY && work.length) {
      for (let i = 0; i < work.length; i += CONCURRENCY) {
        await Promise.all(work.slice(i, i + CONCURRENCY).map(async ({ r, newSlug }) => {
          try {
            // Patch, not replace: cardId is the partition key and must not move.
            await sc.item(r.id, r.cardId).patch([
              { op: "set", path: "/hobbyiqCardId", value: newSlug },
              { op: "set", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
              { op: "set", path: "/reslugedFrom", value: r.hobbyiqCardId },
              { op: "set", path: "/reslugedAt", value: new Date().toISOString() },
              { op: "set", path: "/reslugedReason", value: "CF-TCG-SALES-OUT-OF-THE-BOWMAN-NAMESPACE" },
            ]);
            patched++;
          } catch (e) {
            failed++;
            if (failed <= 5) console.error("  patch failed " + r.id + ": " + (e.message || e).slice(0, 90));
          }
        }));
        if (LIMIT && patched >= LIMIT) { token = undefined; break; }
      }
    }
    process.stderr.write(`\r  scanned ${scanned}  candidates ${candidates}  patched ${patched}   `);
  } while (token);
  process.stderr.write("\n");

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"}  sports=${SPORTS.join(",")}`);
  console.log(`  scanned            ${scanned.toLocaleString()}`);
  console.log(`  in a sports setKey ${candidates.toLocaleString()}   <- the defect`);
  console.log(`  would move         ${(candidates - unchanged).toLocaleString()}`);
  console.log(`  left alone         ${unchanged.toLocaleString()}   (slug would not improve)`);
  console.log(`  patched            ${patched.toLocaleString()}   failed ${failed}`);
  console.log(`\n  sports namespaces they are sitting in:`);
  for (const [k, n] of [...bySetKey].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`     ${String(n).padStart(7)}  ${k}`);
  }
  console.log(`\n  ${resolvable.toLocaleString()} of ${candidates.toLocaleString()} carry a franchise marker and could later`);
  console.log(`  resolve to a real TCG set instead of 'unknown' (parked vertical).`);
  if (samples.length) {
    console.log(`\n  sample moves:`);
    for (const s of samples) console.log("     " + s);
  }
  if (APPLY) {
    reportWrites({
      job: "reslug-tcg-out-of-sports-namespace",
      intended: candidates, written: patched, skipped: unchanged, failed,
    });
  }
})().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
