// CF-HOLDING-ALIGN (Drew, 2026-08-10). Re-align every portfolio holding's
// hobbyiqCardId to what the current slug generator produces.
//
// Motivation: source fixes deployed today (chrome-prefix override, no-dash
// regex, base=refractor for chrome autos) mean existing holdings
// created before those fixes have stale slugs. Holdings pointing at a
// stale slug won't find their catalog row or comps pool → panel shows
// empty pricing. This mirrors the sold_comps mass reslug at the
// portfolio layer.
//
// Uses the existing deriveHoldingSlug service (same rules as ingest)
// with per-holding safeguards:
//   - Only rewrite when new slug is NON-EMPTY-sport
//   - Only rewrite when new slug is different from current
//   - Never demote (only-improve rule from feedback memory)
//   - Log every rewrite pattern for audit
//
// Env: APPLY=true; default dry-run.

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";
const MAX_DOCS = Number(process.env.MAX_DOCS || 0);

const distPath = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "holdingSlug.service.js");
if (!fs.existsSync(distPath)) { console.error(`missing dist — run \`npx tsc\``); process.exit(2); }
const { deriveHoldingSlug } = require(distPath);

// Empty-sport guard
function hasValidSport(slug) {
  if (!slug || typeof slug !== "string") return false;
  const m = /^hiq:([^:]+):/.exec(slug);
  return !!(m && m[1] && m[1].length > 0);
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const portfolio = new CosmosClient(conn).database("hobbyiq").container("portfolio");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  maxDocs=${MAX_DOCS || "∞"}`);

  const q = `SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)`;
  const it = portfolio.items.query({ query: q }, { maxItemCount: 100 });

  let docsScanned = 0, docsChanged = 0, docsWritten = 0, docsFailed = 0;
  let holdingsScanned = 0, holdingsChanged = 0, holdingsSkipped = 0;
  const rewriteCounts = new Map();
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    if (MAX_DOCS && docsScanned >= MAX_DOCS) break;
    const { resources } = await it.fetchNext();
    for (const doc of resources) {
      if (MAX_DOCS && docsScanned >= MAX_DOCS) break;
      docsScanned++;
      const holdings = doc.holdings || {};
      if (!holdings || typeof holdings !== "object") continue;

      // Read the full doc so we can safely replace it (query returns
      // subset; replace needs the full doc + _etag).
      const { resource: full } = await portfolio.item(doc.id, doc.userId).read();
      if (!full || !full.holdings) continue;

      let mutated = false;
      for (const [holdingId, h] of Object.entries(full.holdings)) {
        if (!h || typeof h !== "object") continue;
        holdingsScanned++;

        const oldSlug = h.hobbyiqCardId ?? null;
        // CF-A-MINTED-SLUG-NEVER-REPLACES-A-PIN (D12a, 2026-08-29). The
        // generator re-derives from free text; a slug the catalog wrote or
        // the import/picker pinned is a stronger identity than that and is
        // never overwritten by this pass. Only generator-derived (or
        // pre-CF unlabelled, non-pinned) slugs are re-aligned.
        const isPin = typeof oldSlug === "string" && oldSlug.startsWith("hiq:") && (
          h.hobbyiqCardIdSource === "catalog"
          || h.hobbyiqCardIdSource === "catalog-seeded"
          || h.hobbyiqCardIdSource === "pinned"
          || h.catalogVerifiedSlug === oldSlug
          || h.cardId === oldSlug
        );
        if (isPin) { holdingsSkipped++; continue; }
        const newSlug = deriveHoldingSlug(h);
        if (!newSlug) { holdingsSkipped++; continue; }
        if (oldSlug === newSlug) { holdingsSkipped++; continue; }

        // Safeguards
        if (!hasValidSport(newSlug)) { holdingsSkipped++; continue; }
        // If old slug had a family, don't demote to a shorter family
        // (only-improve rule from feedback_slug_recompute_only_improve).
        if (oldSlug && typeof oldSlug === "string") {
          const oldFam = oldSlug.split(":")[3] || "";
          const newFam = newSlug.split(":")[3] || "";
          // Allow strict improvements only: same family OR new family is
          // MORE specific (longer, or contains old family as prefix like
          // bowman → bowman-chrome). Never allow shortening the family.
          const oldIsPrefixOfNew = oldFam && newFam.startsWith(oldFam);
          const newIsPrefixOfOld = newFam && oldFam.startsWith(newFam);
          if (newIsPrefixOfOld && !oldIsPrefixOfNew && oldFam !== newFam) {
            holdingsSkipped++;
            continue;
          }
        }

        holdingsChanged++;
        const oldFam = oldSlug ? (oldSlug.split(":")[3] || "?") : "(null)";
        const newFam = newSlug.split(":")[3] || "?";
        const bucket = `${oldFam}→${newFam}`;
        rewriteCounts.set(bucket, (rewriteCounts.get(bucket)||0)+1);

        if (APPLY) {
          full.holdings[holdingId].hobbyiqCardId = newSlug;
          full.holdings[holdingId].hobbyiqCardIdSource = "align-generator-2026-08-10";
          full.holdings[holdingId].hobbyiqCardIdReslugedFrom = oldSlug;
          mutated = true;
        }
      }

      if (mutated && APPLY) {
        try {
          full.lastUpdated = new Date().toISOString();
          await portfolio.item(doc.id, doc.userId).replace(full);
          docsWritten++;
        } catch (err) {
          console.warn(`fail write doc=${doc.id}: ${err.message||err}`);
          docsFailed++;
        }
      }
      if (mutated) docsChanged++;

      if (docsScanned % 100 === 0) {
        const dur = ((Date.now() - startedAt)/1000).toFixed(0);
        console.log(`  docs=${docsScanned} changed=${docsChanged} written=${docsWritten} holdingsScanned=${holdingsScanned} holdingsChanged=${holdingsChanged}  ${dur}s`);
      }
    }
  }

  const dur = ((Date.now() - startedAt)/1000).toFixed(0);
  console.log(`\n[done ${dur}s]`);
  console.log(`  docs: scanned=${docsScanned} changed=${docsChanged} written=${docsWritten} failed=${docsFailed}`);
  console.log(`  holdings: scanned=${holdingsScanned} changed=${holdingsChanged} skipped=${holdingsSkipped}`);
  console.log("\ntop rewrite patterns:");
  const top = [...rewriteCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 30);
  for (const [k, v] of top) console.log(`  ${v.toString().padStart(4)}  ${k}`);
}
main().catch(e => { console.error(e); process.exit(1); });
