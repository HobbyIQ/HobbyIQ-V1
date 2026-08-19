#!/usr/bin/env node
/**
 * CF-CARDNUMBER-HYPHEN (Drew, 2026-08-19: "we need to fix it immediately i
 * think this is very wide spread in bowman").
 *
 * `BCP109` and `BCP-109` are the same card. They are also two different slugs,
 * so they are two pools that cannot see each other — 38,599 Bowman comps carry
 * an un-hyphenated number, and 9,096 of those have a hyphenated twin sitting in
 * the same year and set, splitting a live pool right now.
 *
 * WHY THIS IS NOT "ADD A HYPHEN EVERYWHERE".
 *
 * That was the obvious fix and it is wrong. Some prefixes are genuinely printed
 * WITHOUT a hyphen, and the checklist proves it:
 *
 *     BDPP   61,756 catalog rows, NEVER hyphenated
 *     BDP    48,799        "            "
 *     DP     13,785        "            "
 *
 * `bdpp19` and `bdpp12` sit near the top of the "un-hyphenated" list and are
 * CORRECT exactly as they are. Blanket hyphenation would have manufactured
 * 60,000+ rows of brand-new splits while claiming to repair splits.
 *
 * THE RULE, AND WHERE IT COMES FROM. Counting by SOURCE rather than by row
 * settles it — vendor rows carry both spellings, checklist rows do not:
 *
 *     prefix   checklist-backed        vendor-only
 *     BCP      hy=38,673  no=0         hy=217,275  no=41,638
 *     BP       hy=13,060  no=0         hy=143,272  no=41,961
 *     BDC      hy=21,522  no=0         hy=103,076  no= 1,339
 *     BDPP     hy=     0  no=0         hy=      0  no=61,756
 *
 * Every prefix with checklist backing is 100% hyphenated there. The
 * un-hyphenated spelling is purely a vendor artifact. So:
 *
 *   checklist has hyphenated AND no un-hyphenated  -> hyphen is canonical, fix
 *   checklist has un-hyphenated at all             -> ambiguous, leave alone
 *   no checklist rows for the prefix               -> unproven, leave alone
 *
 * A prefix is only ever repaired on positive checklist evidence. Silence is
 * not permission.
 *
 * SEGMENT 4 ONLY. The card number segment is rewritten and nothing else —
 * parallel, auto and serial are carried across untouched. A full re-derive
 * through the generator is only as good as the title text, and vendor titles
 * routinely omit a parallel the existing slug already captured correctly.
 *
 * REVERSIBLE via /hobbyiqCardIdBefore. hobbyiqCardId is not the partition key
 * (/cardId is), so this is a patch, never a delete-and-reinsert.
 *
 * FORWARD FIX STILL OWED. This repairs history. normalizeCardNumber() is
 * slugify() and preserves whatever spelling arrives, so new vendor ingests keep
 * writing `bcp109`. Without a matching parser change this script is swimming
 * upstream and will need re-running.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/repair-cardnumber-hyphen.cjs \
 *     [--apply] [--family=bowman] [--sport=baseball] [--pool=8] [--top=30]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const FAMILY = arg("family", "bowman");
const SPORT = arg("sport", "baseball");
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "30"));

/** Sources that transcribe a printed checklist. A vendor's own catalog is NOT
 *  evidence of how the card is printed — it is evidence of how the vendor types. */
const CHECKLIST_SOURCES = new Set([
  "beckett-checklist", "checklistcenter", "beckett-scraped",
  "beckett-scraped-2026-08-19", "cardboardconnection",
]);

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");

  console.log(`[repair-cardnumber-hyphen] mode=${APPLY ? "APPLY" : "DRY-RUN"} family=${FAMILY} sport=${SPORT}\n`);

  // ── 1. Ask the checklist which spelling each prefix uses ──────────────────
  const tally = new Map();   // prefix -> { ckHy, ckNo }
  {
    const iter = cat.items.query({
      query: `SELECT c.cardNumber, c.source FROM c
               WHERE IS_STRING(c.cardNumber) AND STARTSWITH(c.setKey, @f)`,
      parameters: [{ name: "@f", value: FAMILY }],
    }, { maxItemCount: 2000 });
    let n = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        if (!CHECKLIST_SOURCES.has(r.source)) continue;
        const s = String(r.cardNumber).trim();
        const hy = /^([A-Za-z]{1,5})-(\d+)$/.exec(s);
        const no = /^([A-Za-z]{2,5})(\d+)$/.exec(s);
        const pre = (hy ? hy[1] : no ? no[1] : null);
        if (!pre) continue;
        const k = pre.toUpperCase();
        if (!tally.has(k)) tally.set(k, { ckHy: 0, ckNo: 0 });
        if (hy) tally.get(k).ckHy++; else tally.get(k).ckNo++;
      }
      n += (resources || []).length;
      if (n % 250000 < 2000) process.stderr.write(`\r  catalog scanned=${n} prefixes=${tally.size}   `);
    }
    process.stderr.write("\n");
  }

  const canonical = new Set();     // prefixes where the hyphen is proven
  for (const [k, v] of tally) if (v.ckHy > 0 && v.ckNo === 0) canonical.add(k);
  console.log(`prefixes seen in checklist rows           : ${tally.size}`);
  console.log(`  hyphen PROVEN canonical (fixable)       : ${canonical.size}`);
  console.log(`  checklist itself split / un-hyphenated  : ${tally.size - canonical.size}  (left alone)\n`);
  if (!canonical.size) { console.log("no proven prefixes; nothing to do."); return 0; }

  // ── 2. Find comps whose number is un-hyphenated under a proven prefix ─────
  const work = [];
  const skippedUnproven = new Map();
  {
    const iter = sold.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.cardNumber FROM c
               WHERE STARTSWITH(c.hobbyiqCardId, @p) AND CONTAINS(c.hobbyiqCardId, @f)`,
      parameters: [{ name: "@p", value: `hiq:${SPORT}:` }, { name: "@f", value: `:${FAMILY}` }],
    }, { maxItemCount: 2000 });
    let n = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      for (const r of resources || []) {
        n++;
        const parts = String(r.hobbyiqCardId).split(":");
        if (parts.length < 7) continue;
        const m = /^([a-z]{2,5})(\d+)$/.exec(parts[4] ?? "");
        if (!m) continue;
        const pre = m[1].toUpperCase();
        if (!canonical.has(pre)) { skippedUnproven.set(pre, (skippedUnproven.get(pre) ?? 0) + 1); continue; }
        parts[4] = `${m[1]}-${m[2]}`;
        work.push({ r, next: parts.join(":"), cardNumber: `${pre}-${m[2]}` });
      }
      if (n % 250000 < 2000) process.stderr.write(`\r  comps scanned=${n} fixable=${work.length}   `);
    }
    process.stderr.write("\n");
  }

  const byPrefix = new Map();
  for (const w of work) {
    const p = w.cardNumber.split("-")[0];
    byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
  }
  console.log(`comps to re-number : ${work.length.toLocaleString()}\n`);
  console.log("by prefix:");
  for (const [k, n] of [...byPrefix].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`   ${String(n).padStart(7)}  ${k}`);
  }
  console.log("\nLEFT ALONE — no checklist proof the hyphen belongs:");
  for (const [k, n] of [...skippedUnproven].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(n).padStart(7)}  ${k}`);
  }
  console.log("\nexamples:");
  for (const w of work.slice(0, 8)) console.log(`   ${w.r.hobbyiqCardId}\n   -> ${w.next}`);

  // ── 3. Repair ────────────────────────────────────────────────────────────
  let done = 0, failed = 0, cursor = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < work.length) {
      const w = work[cursor++];
      if (!APPLY) { done++; continue; }
      try {
        await sold.item(w.r.id, w.r.cardId).patch([
          { op: "add", path: "/hobbyiqCardIdBefore", value: w.r.hobbyiqCardId },
          { op: "set", path: "/hobbyiqCardId", value: w.next },
          { op: "set", path: "/cardNumber", value: w.cardNumber },
        ]);
        done++;
        if (done % 2000 === 0) process.stderr.write(`\r  patched ${done}/${work.length}   `);
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${w.r.id}: ${String(e.message).slice(0, 80)}`);
      }
    }
  }));

  console.log(`\n${APPLY ? "repaired" : "would repair"}=${done} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
