#!/usr/bin/env node
/**
 * CF-DEDUPE-CATALOG-ROWS (Drew, 2026-08-20: "eric hartman shows the same card
 * twice ... lets fix it and dedupe and unify").
 *
 * Marks a single SURVIVOR among catalog rows that describe the same card, so
 * search stops showing it twice.
 *
 * WHY THE DUPLICATES EXIST. A catalog id is `cardhedge::<vendor-record-id>::
 * <hash>` — scoped to the VENDOR LISTING, not the card. Every listing mints
 * another row. Eric Hartman's 2026 bowman cpa-eha has 21 rows behind ONE slug;
 * they differ only in id, cardId, some metadata, and their images.
 *
 * RUNS AFTER unify-catalog-setkeys, NEVER BEFORE. Dedupe first and it picks a
 * survivor PER setKey — one kept on `bowman`, one on `bowman-chrome` —
 * cementing a split permanently while reporting a successful cleanup.
 *
 * MARKS, NEVER DELETES. A loser gets `supersededBy` pointing at the survivor.
 * Nothing is removed: deletion is irreversible, the catalog is the moat, and a
 * row that looks redundant today may be the only one carrying some field
 * tomorrow. Search and matching filter on `supersededBy`; the row stays.
 *
 * CONTENT IS PRESERVED, NOT DISCARDED. Those 21 rows carry SIX distinct
 * imageUrls. Picking a survivor with no image while five images sit on losers
 * would be a visible regression dressed as a cleanup, so the survivor inherits
 * an image if it lacks one, and every distinct image is recorded on it.
 *
 * SURVIVOR ORDER, most significant first:
 *   1. authority       checklist > vendor > derived > unknown
 *   2. has an image    a card page without one is worse than a duplicate
 *   3. completeness    printRun, parallel, verificationStatus
 *   4. freshness       most recently normalized, as a tie-break only
 *
 * Freshness is LAST on purpose. "Most recent wins" would let a vendor re-scrape
 * outrank a checklist, which is the mistake that put 51 card-number prefixes on
 * the wrong side of a repair earlier today.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/dedupe-catalog-rows.cjs \
 *     [--apply] [--family=bowman] [--years=2023-2026] [--pool=8] [--top=15]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { authorityRank, catalogAuthorityOf, isTranscriptionGrade } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const FAMILY = arg("family", "bowman");
const [Y0, Y1] = arg("years", "2023-2026").split("-").map(Number);
const POOL = Math.max(1, Number(arg("pool", "8")));
const TOP = Number(arg("top", "15"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}) ${Math.round(w / 1000)}s   `);
        await new Promise((r) => setTimeout(r, w));
        break;
      }
      token = page.continuationToken;
      progressed = true;
      for (const r of page.resources || []) { rows++; onRow(r); }
      legPages++;
      if (rows % 250000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      if (legPages >= REFRESH_PAGES) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

/**
 * Higher is a better survivor.
 *
 * TRANSCRIPTION GRADE RANKS ABOVE AN IMAGE, and that ordering is deliberate.
 * 11,123 clusters hold more than one CHECKLIST row — 3,495 a bccp-graded
 * re-scrape double-inserting, 7,628 genuinely different sites describing one
 * card (including baseballcardpedia + bccp, which are the same site under two
 * source names).
 *
 * Within those, `checklistcenter` is unanimous on hyphenation while `bccp`
 * disagrees with itself 18% of the time. If the sloppier row won merely because
 * it carried an image, and a later repair filtered on supersededBy, we would
 * have quietly degraded the evidence used for formatting questions. So precision
 * outranks decoration.
 *
 * supersededBy is a SEARCH/DISPLAY concept, not an evidence one — a superseded
 * row is still there and still readable. This ordering means that even if a
 * caller wrongly treats it as evidence, the survivor is the better witness.
 */
function score(r) {
  return [
    authorityRank(r.source),
    isTranscriptionGrade(r.source) ? 1 : 0,
    r.imageUrl ? 1 : 0,
    (r.printRun != null ? 1 : 0) + (r.parallel ? 1 : 0) + (r.verificationStatus === "verified" ? 1 : 0),
    Date.parse(r.normalizedAt || r.builtAt || 0) || 0,
  ];
}
function better(a, b) {
  const sa = score(a), sb = score(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i];
  return String(a.id) < String(b.id);   // stable, so a re-run picks the same row
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[dedupe-catalog-rows] mode=${APPLY ? "APPLY" : "DRY-RUN"} family=${FAMILY} years=${Y0}-${Y1}\n`);

  // Group by the row's OWN slug. Identity collapsing already happened in the
  // unify pass; this targets the narrower "same slug, many rows" case.
  const bySlug = new Map();
  let scanned = 0, skippedSuperseded = 0, skippedNoSlug = 0;
  await scanAll("card_catalog", {
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.source, c.imageUrl, c.printRun,
                   c.parallel, c.verificationStatus, c.normalizedAt, c.builtAt,
                   c.playerName, c.cardNumber, c.year, c.supersededBy
             FROM c WHERE STARTSWITH(c.setKey, @f) AND c.year >= @y0 AND c.year <= @y1
                      AND IS_DEFINED(c.hobbyiqCardId)`,
    parameters: [{ name: "@f", value: FAMILY }, { name: "@y0", value: Y0 }, { name: "@y1", value: Y1 }],
  }, (r) => {
    scanned++;
    if (r.supersededBy) { skippedSuperseded++; return; }   // idempotent re-runs

    // A ROW WITH NO SLUG IS NOT A DUPLICATE OF ANOTHER ROW WITH NO SLUG.
    //
    // `IS_DEFINED` passes a field that exists but is null, and String(null) is
    // "null" — so the first dry run produced a 43-row "cluster" keyed on the
    // literal string null. Those are 43 UNRELATED cards that merely share the
    // property of having no slug, and marking 42 of them superseded by a
    // stranger would have been the worst write attempted today: silent, plausible
    // and pointing at the wrong card.
    //
    // Rows with no slug are a separate defect (see the literal-"null"
    // cardNumber item in the backlog) and are skipped here.
    const slug = typeof r.hobbyiqCardId === "string" ? r.hobbyiqCardId.trim() : "";
    if (!slug || slug === "null" || slug === "undefined") { skippedNoSlug++; return; }

    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(r);
  }, "catalog");

  const clusters = [...bySlug.entries()].filter(([, v]) => v.length > 1);
  const losers = [];
  const survivorNeedsImage = [];
  const byAuthority = new Map();
  let imagesPreserved = 0;

  for (const [slug, rows] of clusters) {
    let winner = rows[0];
    for (const r of rows.slice(1)) if (better(r, winner)) winner = r;
    const images = [...new Set(rows.map((r) => r.imageUrl).filter(Boolean))];
    if (!winner.imageUrl && images.length) { survivorNeedsImage.push({ winner, image: images[0] }); imagesPreserved++; }
    for (const r of rows) {
      if (r.id === winner.id) continue;
      losers.push({ r, winnerId: winner.id, slug });
      const a = catalogAuthorityOf(r.source);
      byAuthority.set(a, (byAuthority.get(a) ?? 0) + 1);
    }
  }

  console.log(`catalog rows scanned      : ${scanned.toLocaleString()}`);
  console.log(`  already superseded      : ${skippedSuperseded.toLocaleString()}`);
  console.log(`  NO SLUG (never grouped) : ${skippedNoSlug.toLocaleString()}   <- unrelated cards, not duplicates`);
  console.log(`distinct slugs            : ${bySlug.size.toLocaleString()}`);
  console.log(`slugs with >1 row         : ${clusters.length.toLocaleString()}`);
  console.log(`rows to mark superseded   : ${losers.length.toLocaleString()}`);
  console.log(`survivors inheriting an image : ${imagesPreserved.toLocaleString()}   <- content that would otherwise vanish from view\n`);

  console.log("losers by authority (all are kept, just not shown):");
  for (const [a, n] of [...byAuthority].sort((x, y) => y[1] - x[1])) console.log(`   ${String(n).padStart(8)}  ${a}`);

  console.log("\nbiggest clusters:");
  for (const [slug, rows] of clusters.sort((a, b) => b[1].length - a[1].length).slice(0, TOP)) {
    const imgs = new Set(rows.map((r) => r.imageUrl).filter(Boolean)).size;
    console.log(`   x${String(rows.length).padStart(3)}  imgs=${imgs}  ${slug}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN. Nothing written, nothing deleted. Losers would receive");
    console.log("supersededBy; search and matching filter on it while the row remains.");
    return 0;
  }

  const cat = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");
  let done = 0, failed = 0, cursor = 0;

  // Survivors first: never hide a row before its image has been carried across.
  for (const { winner, image } of survivorNeedsImage) {
    try {
      await cat.item(winner.id, winner.cardId).patch([
        { op: "add", path: "/imageUrl", value: image },
        { op: "add", path: "/imageSource", value: "dedupe-survivor-inherit" },
      ]);
    } catch (e) { console.log(`   survivor image patch failed ${winner.id}: ${String(e.message).slice(0, 60)}`); }
  }
  console.log(`\nsurvivors given an inherited image: ${survivorNeedsImage.length}`);

  console.log(`marking ${losers.length.toLocaleString()} rows superseded...`);
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (cursor < losers.length) {
      const { r, winnerId } = losers[cursor++];
      try {
        await cat.item(r.id, r.cardId).patch([
          { op: "add", path: "/supersededBy", value: winnerId },
          { op: "add", path: "/supersededReason", value: "CF-DEDUPE-CATALOG-ROWS" },
        ]);
        done++;
        if (done % 2000 === 0) process.stderr.write(`\r  marked ${done}/${losers.length}   `);
      } catch (e) {
        failed++;
        if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 70)}`);
      }
    }
  }));
  console.log(`\nmarked=${done} failed=${failed}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
