#!/usr/bin/env node
/**
 * CF-DRAFT-IS-ITS-OWN-PRODUCT (Drew, 2026-08-16: "we match the PRODUCT from
 * bowman in the checklist!!" / "do it, lets clean it ALL up").
 *
 * Re-slugs sold_comps rows whose TITLE says Bowman Draft but whose slug says
 * bowman-chrome.
 *
 * WHY IT MATTERS. Bowman Draft and Bowman Chrome are different products with
 * different checklists, different players and different prices. Measured
 * 2026-08-16:
 *
 *     comps whose title says BOWMAN DRAFT      204,284
 *       slugged to bowman-chrome  (wrong)      123,256   <- 60%
 *       slugged to bowman-draft   (right)       78,663
 *
 * So 60% of Bowman Draft sales were pooling into the standalone Bowman Chrome
 * product. That corrupts BOTH pools at once — Draft cards priced off Chrome
 * comps and vice versa — and it is why the 2025 Bowman Draft catalog looked
 * empty from a card's point of view despite holding 93,183 rows across 837
 * card numbers. The checklist was there; the sales never arrived at it.
 *
 * normalizeSetKey now resolves every Bowman Draft card to bowman-draft (the
 * product the checklist names, 277,616 checklist-backed rows against
 * bowman-draft-chrome's ZERO). This brings the already-written rows in line.
 *
 * THE SLUG GENERATOR DECIDES, NOT THIS SCRIPT. Each row is re-derived through
 * the shipped parseListingIdentity + computeHobbyIqCardId — the same path new
 * ingests use — so remediated and future rows agree by construction. No string
 * surgery on the old slug.
 *
 * ONLY-IMPROVE. A row is written only when the re-derived slug actually moves
 * the set segment from bowman-chrome to bowman-draft. Anything else is left
 * exactly as it is, including rows the generator cannot confidently re-derive.
 *
 * REVERSIBLE. The prior slug is stamped to /hobbyiqCardIdBefore. hobbyiqCardId
 * is NOT the partition key (/cardId is), so this is a patch, never a delete
 * and reinsert.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/reslug-bowman-draft-comps.cjs [--apply] [--concurrency=24]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

const yearOf = (t) => {
  const m = String(t).match(/\b(19[3-9]\d|20[0-4]\d)\b/);
  return m ? Number(m[1]) : null;
};

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const M = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const APPLY = has("apply");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "24")));
  console.log(`[reslug-bowman-draft] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}`);

  const iter = sold.items.query({
    query: `SELECT c.id, c.cardId, c.title, c.hobbyiqCardId, c.sport, c.year,
                   c.cardNumber, c.parallel, c.isAuto, c.printRun
            FROM c
            WHERE CONTAINS(UPPER(c.title), 'BOWMAN DRAFT')
              AND CONTAINS(c.hobbyiqCardId, ':bowman-chrome:')`,
  }, { maxItemCount: 1000 });

  const tot = { scanned: 0, moved: 0, unchanged: 0, noDerive: 0, written: 0, failed: 0 };
  const samples = [];
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      tot.scanned++;
      const title = String(row.title ?? "").trim();
      if (!title) { tot.noDerive++; continue; }

      let p;
      try { p = M.parseListingIdentity(title); } catch { tot.noDerive++; continue; }

      const year = row.year ?? yearOf(title);
      const setKey = M.inferSetKeyFromTitle(title);
      const cardNumber = p?.cardNumber ?? row.cardNumber ?? null;
      const sport = row.sport || M.inferSportFromTitle(title) || null;
      if (!year || !setKey || !cardNumber || !sport) { tot.noDerive++; continue; }

      let next;
      try {
        next = computeHobbyIqCardId({
          sport, year: Number(year), setKey, cardNumber,
          parallel: p?.parallel ?? row.parallel ?? "Base",
          isAuto: p?.isAuto ?? row.isAuto === true,
          printRun: p?.printRun ?? row.printRun ?? null,
        });
      } catch { tot.noDerive++; continue; }

      // ONLY THE PRODUCT MOVES. A full re-derive rewrites every segment, and
      // the dry run showed that degrading real parallels:
      //
      //   2020:bowman-chrome:cda-ss:gold-refractor:auto
      //     -> 2020:bowman-draft:cda-ss:refractor:auto     ("gold" lost)
      //
      // The parallel already on the row came from its own ingest, which had
      // the untruncated title and vendor fields this script does not. Moving
      // a Draft card to the Draft product must not cost it its colour, so the
      // re-derive is used ONLY to confirm the product, and the write is a
      // targeted swap of the set segment. Everything else is left alone.
      if (!next || !next.startsWith("hiq:") || !next.includes(":bowman-draft:")) {
        tot.unchanged++; continue;
      }
      const parts = String(row.hobbyiqCardId).split(":");
      if (parts.length < 7 || parts[3] !== "bowman-chrome") { tot.unchanged++; continue; }
      parts[3] = "bowman-draft";
      next = parts.join(":");
      if (next === row.hobbyiqCardId) { tot.unchanged++; continue; }

      tot.moved++;
      if (samples.length < 8) {
        samples.push(`${String(row.hobbyiqCardId).slice(0, 58)}\n           -> ${next.slice(0, 58)}\n           ${title.slice(0, 84)}`);
      }
      if (!APPLY) continue;

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // sold_comps is partitioned by /cardId, NOT by doc id.
      const q = sold.item(row.id, row.cardId).patch([
        { op: "add", path: "/hobbyiqCardId", value: next },
        { op: "add", path: "/hobbyiqCardIdBefore", value: row.hobbyiqCardId },
        { op: "add", path: "/reslugDraftAt", value: new Date().toISOString() },
      ])
        .then(() => { tot.written++; })
        .catch((e) => {
          tot.failed++;
          if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
        })
        .finally(() => inflight.delete(q));
      inflight.add(q);
    }
    process.stderr.write(`\rscanned=${tot.scanned} moved=${tot.moved} written=${tot.written}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  console.log(`\n  title says Bowman Draft, slug says bowman-chrome  ${tot.scanned}`);
  console.log(`    re-derives to bowman-draft -> MOVE              ${tot.moved}`);
  console.log(`    re-derives elsewhere / already right            ${tot.unchanged}`);
  console.log(`    could not re-derive, left alone                 ${tot.noDerive}`);
  console.log(`  written                                          ${APPLY ? `${tot.written} (failed ${tot.failed})` : "(dry-run)"}`);
  console.log("\n  sample moves:");
  for (const s of samples) console.log(`    ${s}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
