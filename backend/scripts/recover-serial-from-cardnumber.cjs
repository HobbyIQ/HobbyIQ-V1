#!/usr/bin/env node
/**
 * CF-A-SERIAL-IS-NOT-A-CARD-NUMBER (Drew, 2026-08-27: "i think we do serial
 * for sports not pokemon").
 *
 * On a SPORTS card, "108/165" stamped on the front means copy 108 of 165 -- a
 * serial. It is not the card's number, and storing it in cardNumber makes the
 * slug unmatchable: every copy of the same card gets a different identity.
 *
 * On a POKEMON card, "87/90" IS the card number -- card 87 of a 90-card set.
 * 29,535 of the 51,123 slash-carrying sales are Pokemon, so a blanket pass
 * would move the majority's real card numbers into printRun and blank the
 * field that identifies them.
 *
 * WHAT THIS PASS DOES NOT TRUST, having been burned by each in turn today:
 *
 *   printRun === M is NOT evidence. It agrees 99.9% of the time because the
 *   same parser that read "87/90" wrote 90 into printRun. Testing a field
 *   against its own source cannot disagree.
 *
 *   sport is NOT sufficient. "2026 - N's Zoroark ex - Ascended Heroes -
 *   286/217" is tagged as a sport. Pokemon leaks into the sports buckets.
 *
 *   the SHAPE alone is NOT sufficient. Pokemon secret rares number ABOVE the
 *   set size (286/217), and sports serials never exceed their run.
 *
 * So three independent guards must all agree before a row is touched:
 *
 *   1. sport is a sport we recognise, and is not a TCG bucket
 *   2. the title carries no TCG marker (pokemon, tcg, holo, ex, psa-style)
 *   3. N <= M, because a serial cannot exceed its own print run
 *
 * WHAT IT WRITES. printRun = M when the row has none. It does NOT touch
 * cardNumber and does NOT re-slug: the card's real number was lost upstream
 * and this pass cannot invent it. Rows are FLAGGED (serialInCardNumber) so a
 * later pass that can recover the number -- from the title, or from the
 * checklist -- has a work list.
 *
 * NOT SAFE TO APPLY YET — the guards leak, measured 2026-08-27.
 *
 * Pokemon is mis-tagged as a sport in quantity, and when the title also lacks
 * an explicit TCG word all three guards pass:
 *
 *     "Team Rocket"        pokemon=393   baseball=175
 *     "Ascended Heroes"    pokemon=376   baseball=361
 *     "Reverse Holofoil"   pokemon=1858  baseball=229
 *
 * A dry run over 21,168 rows proposed 2,337 writes, and the first eight
 * sampled were ALL Pokemon: "Blitzle (40) - Black and White - Normal" carries
 * no TCG word at all, and holo does not match "Holofoil".
 *
 * The damage would be bounded -- printRun only, never cardNumber, never the
 * slug -- but it would still write a Pokemon SET SIZE into a print run.
 *
 * The right discriminator is a lookup, not a heuristic: does this setName
 * exist as a SPORTS product in the checklists? "Team Rocket" and "Ascended
 * Heroes" do not. Same shape as the BCP- fix, which stopped guessing from a
 * card-number prefix and asked the catalog instead.
 *
 * Env:
 *   COSMOS_CONNECTION_STRING  required
 *   APPLY / BACKFILL_APPLY    actually write (default: report only)
 *   SLOT / SLOTS  CONCURRENCY=48  RUN_MINUTES=140  LIMIT=0
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 48));
const LIMIT = Number(process.env.LIMIT || 0);
const SLOT = Number(process.env.SLOT ?? 0);
const SLOTS = Number(process.env.SLOTS ?? 1);
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const STARTED = Date.now();

const f = (n) => Number(n).toLocaleString();

/** Sports where a stamped N/M is a serial. Deliberately an ALLOW list. */
const SERIAL_SPORTS = new Set([
  "baseball", "basketball", "football", "hockey", "soccer", "golf", "racing",
  "auto racing", "boxing", "mma", "wrestling", "tennis", "softball", "bowling",
]);

/** A title that mentions any of these is not a sports serial, whatever the sport tag says. */
const TCG_MARKER = /\b(pok[eé]?mon|pokemon|tcg|yugioh|yu-gi-oh|magic the gathering|mtg|holo|reverse holo|secret rare|ultra rare|illustration rare|shatterfoil|energy|trainer)\b/i;

/**
 * A sanity bound on the denominator, NOT a discriminator.
 *
 * This started as an allow-list of "print runs the hobby uses" and it was
 * wrong twice over: it rejected 108/165 -- a real serial -- because 165 was
 * not on it, and it could never have done the job it claimed, because Pokemon
 * SET SIZES (90, 102, 165, 217) land on exactly the same numbers as print
 * runs. A denominator cannot tell the two apart.
 *
 * The sport allow-list and the TCG title marker do the discriminating. This
 * only rejects values too large to be either.
 */
const MAX_RUN = 5000;

/**
 * Decide whether this row's cardNumber is a sports serial. Returns the print
 * run to record, or null to leave the row completely alone.
 */
function serialRunFor(row) {
  const sport = String(row.sport ?? "").toLowerCase().trim();
  if (!SERIAL_SPORTS.has(sport)) return null;                 // guard 1
  if (TCG_MARKER.test(String(row.title ?? ""))) return null;  // guard 2

  const m = String(row.cardNumber ?? "").match(/^\s*(\d{1,5})\s*\/\s*(\d{1,5})\s*$/);
  if (!m) return null;
  const num = Number(m[1]), den = Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  if (num > den) return null;                                  // guard 3
  if (den > MAX_RUN) return null;
  return den;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sc = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database("hobbyiq").container("sold_comps");

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

  const sports = [...SERIAL_SPORTS];
  const mine = SLOTS > 1 ? sports.filter((_, i) => i % SLOTS === SLOT) : sports;
  if (!mine.length) { console.log(`slot ${SLOT}/${SLOTS} owns no sport — nothing to do`); return; }
  console.log(`slot ${SLOT}/${SLOTS}  sports: ${mine.join(", ")}\n`);

  let scanned = 0, eligible = 0, wrote = 0, alreadyHadRun = 0, rejected = 0, failed = 0;
  const rejectedBy = { sport: 0, tcgTitle: 0, shape: 0 };
  const sample = [];
  let stopReason = null;

  for (const sport of mine) {
    if (stopReason) break;
    let token;
    do {
      const page = await retry(() => sc.items.query(
        { query: `SELECT c.id, c.cardId, c.sport, c.title, c.cardNumber, c.printRun, c.setName, c.playerName
                  FROM c WHERE c.sport = @s AND CONTAINS(c.cardNumber, '/')`,
          parameters: [{ name: "@s", value: sport }] },
        { maxItemCount: 400, continuationToken: token }).fetchNext());
      token = page.continuationToken;

      for (let i = 0; i < page.resources.length; i += CONCURRENCY) {
        await Promise.all(page.resources.slice(i, i + CONCURRENCY).map(async (row) => {
          scanned++;
          const run = serialRunFor(row);
          if (run === null) {
            rejected++;
            if (TCG_MARKER.test(String(row.title ?? ""))) rejectedBy.tcgTitle++;
            else if (!SERIAL_SPORTS.has(String(row.sport ?? "").toLowerCase())) rejectedBy.sport++;
            else rejectedBy.shape++;
            return;
          }
          eligible++;
          if (row.printRun !== null && row.printRun !== undefined) { alreadyHadRun++; return; }
          if (sample.length < 8) sample.push(`${row.cardNumber} -> /${run}   ${String(row.title ?? "").slice(0, 58)}`);
          if (!APPLY) { wrote++; return; }
          try {
            await retry(() => sc.item(row.id, row.cardId).patch([
              { op: "set", path: "/printRun", value: run },
              // The card's real number was lost upstream; this pass cannot
              // invent it. Flagged so a later recovery has a work list.
              { op: "set", path: "/serialInCardNumber", value: true },
              { op: "set", path: "/serialRecoveredAt", value: new Date().toISOString() },
            ]));
            wrote++;
          } catch (e) {
            failed++;
            if (failed <= 5) console.error(`  failed ${String(row.id).slice(0, 60)}: ${String(e.message || e).slice(0, 60)}`);
          }
        }));
        if (LIMIT && wrote >= LIMIT) { stopReason = "limit"; break; }
        if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; break; }
      }
      if (stopReason) break;
    } while (token);
  }

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  scanned                      ${f(scanned)}`);
  console.log(`  eligible (all 3 guards pass) ${f(eligible)}`);
  console.log(`  print run recovered          ${f(wrote)}`);
  console.log(`  already had a print run      ${f(alreadyHadRun)}`);
  console.log(`  rejected                     ${f(rejected)}`);
  console.log(`     TCG marker in the title   ${f(rejectedBy.tcgTitle)}   <- pokemon leaking into a sport tag`);
  console.log(`     sport not a serial sport  ${f(rejectedBy.sport)}`);
  console.log(`     shape (N>M, not N/M)      ${f(rejectedBy.shape)}   <- includes pokemon secret rares`);
  console.log(`  failed                       ${f(failed)}`);
  if (sample.length) {
    console.log(`\n  sample of what would change:`);
    for (const s of sample) console.log(`    ${s}`);
  }
  if (APPLY) {
    reportWrites({ job: "recover-serial-from-cardnumber", intended: eligible, written: wrote, skipped: alreadyHadRun, failed });
  }
}

module.exports = { serialRunFor, SERIAL_SPORTS, TCG_MARKER };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
}
