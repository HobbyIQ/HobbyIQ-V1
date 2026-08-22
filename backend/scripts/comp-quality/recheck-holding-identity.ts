/**
 * Re-run the LIVE catalog matcher against holdings that currently have no
 * identity, and report what it would resolve them to.
 *
 * WHY THIS EXISTS. On 2026-08-22 eighteen sports holdings carried no cardId and
 * no hobbyiqCardId, $2,117.19 of cost basis between them, and every one of them
 * still rendered a confident price borrowed from a fallback pool. The obvious
 * diagnosis — "the catalog is missing these cards" — was wrong. The catalog
 * held 99 distinct parallels for 2026 RA-KG including the exact one needed, and
 * the matcher was FINDING the card and then rejecting its own match:
 *
 *   {"event":"catalog_match_parallel_invariant_violated",
 *    "matchedBy":"exact","confidence":0.98,
 *    "askedParallel":"Yellow",
 *    "returnedSlug":"hiq:baseball:2026:topps-chrome:ra-kg:yellow-refractor:auto"}
 *
 * This script is what made that visible, and it is the before/after harness for
 * any change to catalogMatcher. Run it, change the matcher, run it again, and
 * compare resolvesNow. Do not reason about the matcher without it.
 *
 * IT ALSO ANSWERS A QUESTION THAT KEEPS RECURRING: is a fix unrealized because
 * the CODE is wrong, or because the stored DATA was never re-derived? A matcher
 * fix that shows up here but not in Cosmos means the rows need re-matching, not
 * more code. That distinction bit five separate times on 2026-08-21/22.
 *
 * Read-only. Reports what canonicalize() WOULD return; writes nothing.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
 *     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *     npx tsx scripts/comp-quality/recheck-holding-identity.ts
 *
 *   MIN_COST=50   only holdings above this cost basis (default 0)
 *   INCLUDE_PARKED=true   include Pokemon etc (default: skipped, vertical is parked)
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const MIN_COST = Number(process.env.MIN_COST || 0);
const INCLUDE_PARKED = process.env.INCLUDE_PARKED === "true";

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }

  const { CosmosClient } = await import("@azure/cosmos");

  // Resolved from cwd, and PRINTED — the session cwd can silently revert to a
  // stale checkout, and importing the matcher from the wrong tree would make
  // every number here a lie.
  const matcherPath = path.resolve(process.cwd(), "src/services/catalog/catalogMatcher.service.ts");
  console.log(`[import] ${matcherPath}`);
  const { canonicalize } = await import(pathToFileURL(matcherPath).href);

  const c = new CosmosClient(conn).database("hobbyiq").container("portfolio");
  const { resources } = await c.items
    .query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();

  if (!resources.length) {
    console.error("FATAL: zero portfolio docs returned. The sweep proved nothing.");
    process.exit(2);
  }

  const targets: Array<{ userId: string; hid: string; h: any }> = [];
  let totalHoldings = 0;
  for (const doc of resources as any[]) {
    for (const [hid, h] of Object.entries<any>(doc.holdings || {})) {
      if (!h) continue;
      totalHoldings++;
      if (h.hobbyiqCardId ?? h.cardId ?? null) continue;
      const cost = Number(h.totalCostBasis ?? h.purchasePrice ?? 0) || 0;
      if (cost < MIN_COST) continue;
      if (!INCLUDE_PARKED) {
        const blob = JSON.stringify(h).toLowerCase();
        if (blob.includes("pokemon") || blob.includes("pokémon")) continue;
      }
      targets.push({ userId: doc.userId, hid, h });
    }
  }

  if (!totalHoldings) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The sweep proved nothing.");
    process.exit(2);
  }

  console.log(`holdings scanned: ${totalHoldings}   unidentified to re-match: ${targets.length}` +
    (MIN_COST ? `   (cost >= $${MIN_COST})` : "") + "\n");

  let resolves = 0, unresolved = 0, threw = 0;
  let costRecoverable = 0, costStranded = 0;
  const byMode = new Map<string, number>();

  for (const t of targets) {
    const h = t.h;
    const cost = Number(h.totalCostBasis ?? h.purchasePrice ?? 0) || 0;
    const label = `${String(h.playerName ?? "?").slice(0, 20).padEnd(20)} #${String(h.cardNumber ?? "?").padEnd(9)} $${cost.toFixed(2).padStart(8)}`;
    try {
      const r: any = await canonicalize({
        sport: String(h.sport ?? "Baseball").toLowerCase(),
        year: Number(h.cardYear) || 0,
        setName: String(h.product ?? h.setName ?? ""),
        cardNumber: String(h.cardNumber ?? ""),
        parallel: h.parallel ?? null,
        isAuto: h.isAuto === true,
        player: h.playerName ?? null,
        source: "portfolio",
      });
      byMode.set(r.matchedBy, (byMode.get(r.matchedBy) ?? 0) + 1);
      if (r.found) {
        resolves++; costRecoverable += cost;
        console.log(`  RESOLVES  ${label}  parallel=${JSON.stringify(h.parallel)}`);
        console.log(`            -> ${r.slug}   (${r.matchedBy}, conf ${r.confidence})`);
      } else {
        unresolved++; costStranded += cost;
        console.log(`  no match  ${label}  parallel=${JSON.stringify(h.parallel)}  (${r.matchedBy}, conf ${r.confidence})`);
      }
    } catch (e: any) {
      threw++;
      console.log(`  THREW     ${label}  ${e?.message}`);
    }
  }

  console.log(`\nSUMMARY  target=${targets.length}  resolvesNow=${resolves}  stillNotFound=${unresolved}  threw=${threw}`);
  console.log(`matchedBy: ${JSON.stringify(Object.fromEntries(byMode))}`);
  console.log(`cost basis recoverable by re-matching: $${costRecoverable.toFixed(2)}`);
  console.log(`cost basis still stranded:             $${costStranded.toFixed(2)}`);

  if (resolves > 0) {
    console.log(`\nNOTE: these resolve in the MATCHER. That is not the same as being fixed in`);
    console.log(`Cosmos — repriceOneHolding() prices an existing identity and never calls`);
    console.log(`canonicalize(), and rematchOne() queries CardHedge by title, not the catalog.`);
    console.log(`Realizing this needs an identity re-derivation pass over the stored rows.`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
