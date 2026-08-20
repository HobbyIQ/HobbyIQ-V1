#!/usr/bin/env node
/**
 * CF-NO-REFRACTOR-AUTO-RELEASED (Drew, 2026-08-15, on 2026 Bowman Eric
 * Hartman #CPA-EHA: "this is marked as a refractor but it is a base - eric
 * does not have a refractor auto" ... "eric hartman is the only one without a
 * refractor auto ... no card was released by topps. There was an issue with
 * his cards. It is an anomoly").
 *
 * The parser fix handles new ingests; this re-tags the rows already in the
 * pool.
 *
 * ONE CARD, NOT A PRODUCT RULE. The chrome-auto default is correct — the base
 * tier of that ladder really is Refractor, and Owen Carey's CPA-OC exists in
 * Base AND Refractor exactly as expected. Topps simply never released the
 * Refractor auto for Eric Hartman, so his sales were filed under a parallel
 * that does not physically exist. Several of the titles say so outright:
 *
 *     "2026 Bowman Chrome 1st - Eric Hartman - True Base Auto - CPA-EHA"
 *     "2026 1st Bowman Chrome Eric Hartman Prospect Base AUTO #CPA-EHA RC SP"
 *
 * A first pass at this treated it as a product-wide naming question and would
 * have moved 100,295 rows across bowman and bowman-chrome into a tier they do
 * belong in. That is why the query below is anchored on the card number.
 *
 * THE PARSER DECIDES, NOT THIS SCRIPT. Every candidate is re-parsed with the
 * shipped parseListingIdentity, the same code path new ingests use, so
 * remediated rows and future rows agree by construction. A row the parser
 * still calls Refractor is left exactly as it is — including Hartman's colour
 * autos (Blue /150, Gold /50 ...), which WERE printed and are not in scope.
 *
 * THE SLUG MOVES WITH THE FIELD. hobbyiqCardId encodes the parallel
 * (`hiq:baseball:2026:bowman:cpa-eha:refractor:auto`), and readCompsByCardId
 * matches canonical ids on `c.hobbyiqCardId` — so patching `parallel` alone
 * would fix the label while leaving the sale attached to the wrong card.
 * Segment 5 is rewritten refractor -> base, and ONLY when it is literally
 * "refractor"; a slug in any other shape is skipped rather than rebuilt from
 * guesses.
 *
 * hobbyiqCardId is NOT the partition key (that is /cardId, which here is
 * usually a backstop or vendor id), so this is a patch, never a delete and
 * reinsert.
 *
 * REVERSIBLE. The prior value is stamped to /parallelBefore on every patched
 * row, so the sweep can be undone from the data alone.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..."  *   node backend/scripts/repair-no-refractor-auto-released.cjs [--apply] [--concurrency=16]
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

/** Rewrite the parallel segment of a canonical slug. Returns null when the
 *  slug is not in the expected shape, or does not say "refractor" — in both
 *  cases the caller leaves the row alone. */
function slugToBase(slug) {
  if (typeof slug !== "string" || !slug.startsWith("hiq:")) return null;
  const parts = slug.split(":");
  if (parts.length < 7) return null;
  if (parts[5] !== "refractor") return null;
  parts[5] = "base";
  return parts.join(":");
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const APPLY = has("apply");
  const CONCURRENCY = Math.max(1, Number(arg("concurrency", "16")));
  console.log(`[no-refractor-auto] mode=${APPLY ? "APPLY" : "DRY-RUN"} concurrency=${CONCURRENCY}`);

  const iter = sold.items.query({
    // Anchored on the ONE anomalous card. Widening this query is how a
    // card-level production fact turns into a product-wide repricing.
    query: `SELECT c.id, c.cardId, c.title, c.parallel, c.hobbyiqCardId, c.setKey
            FROM c WHERE c.parallel = 'Refractor' AND c.isAuto = true
              AND CONTAINS(UPPER(c.cardNumber), 'CPA-EHA')`,
  }, { maxItemCount: 1000 });

  const tot = {
    scanned: 0, stillRefractor: 0, noTitle: 0, toBase: 0,
    slugUnchanged: 0, written: 0, failed: 0,
  };
  const bySet = {};
  const samples = [];
  const inflight = new Set();

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const row of resources || []) {
      tot.scanned++;
      const title = String(row.title ?? "").trim();
      if (!title) { tot.noTitle++; continue; }

      let parsed;
      try { parsed = parseListingIdentity(title); } catch { tot.noTitle++; continue; }
      if (parsed?.parallel !== "Base") { tot.stillRefractor++; continue; }

      tot.toBase++;
      const setKey = String(row.setKey || String(row.hobbyiqCardId || "").split(":")[3] || "?");
      bySet[setKey] = (bySet[setKey] || 0) + 1;

      const newSlug = slugToBase(row.hobbyiqCardId);
      if (!newSlug) tot.slugUnchanged++;

      if (samples.length < 8) {
        samples.push(`${String(row.hobbyiqCardId).slice(0, 56)}\n           -> ${String(newSlug ?? "(slug left as-is)").slice(0, 56)}\n           ${title.slice(0, 88)}`);
      }
      if (!APPLY) continue;

      const ops = [
        { op: "add", path: "/parallel", value: "Base" },
        { op: "add", path: "/parallelBefore", value: "Refractor" },
        { op: "add", path: "/parallelRepairedAt", value: new Date().toISOString() },
      ];
      // parallelSlug is only rewritten when it currently agrees with the old
      // value; anything else is another field's truth and not ours to touch.
      if (newSlug) ops.push({ op: "add", path: "/hobbyiqCardId", value: newSlug });

      while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
      // sold_comps is partitioned by /cardId, NOT by doc id.
      const p = sold.item(row.id, row.cardId).patch(ops)
        .then(() => { tot.written++; })
        .catch((e) => {
          tot.failed++;
          if (tot.failed <= 5) console.warn(`  patch failed id=${row.id} pk=${row.cardId}: ${e.code ?? e.message}`);
        })
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
    process.stderr.write(`\rscanned=${tot.scanned} toBase=${tot.toBase} written=${tot.written}`);
  }
  while (inflight.size) await Promise.race([...inflight]);
  process.stderr.write("\n");

  console.log(`\n  auto rows stored as parallel="Refractor"   ${tot.scanned}`);
  console.log(`    parser now says Base -> REPAIR           ${tot.toBase}`);
  console.log(`      of those, slug not in hiq:…:refractor: ${tot.slugUnchanged}  <- label fixed, slug left alone`);
  console.log(`    parser still says Refractor -> untouched ${tot.stillRefractor}`);
  console.log(`    no usable title -> untouched             ${tot.noTitle}`);
  console.log(`  written                                    ${APPLY ? `${tot.written} (failed ${tot.failed})` : "(dry-run)"}`);
  console.log("\n  repair count by setKey:");
  for (const [k, v] of Object.entries(bySet).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }
  console.log("\n  sample re-tags:");
  for (const s of samples) console.log(`    ${s}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
