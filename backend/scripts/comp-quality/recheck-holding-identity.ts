/**
 * Re-run the LIVE catalog matcher against holdings that currently have no
 * identity: report what it resolves them to, and (with APPLY=true) write that
 * identity back onto the stored rows.
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
 * compare the pin count. Do not reason about the matcher without it.
 *
 * IT ALSO ANSWERS A QUESTION THAT KEEPS RECURRING: is a fix unrealized because
 * the CODE is wrong, or because the stored DATA was never re-derived? #1180
 * fixed the matcher and changed nothing a user could see, because NOTHING
 * re-derives identity on an existing holding — repriceOneHolding() prices an
 * identity it already has, and rematchOne() asks CardHedge by title. APPLY mode
 * is the missing re-derivation. That distinction bit five times on 08-21/22.
 *
 * ---------------------------------------------------------------------------
 * WHAT APPLY MODE WRITES, AND THE THREE RULES IT OBEYS
 *
 * 1. PIN ONLY AT >= 0.9 — the threshold ebayAutoHolding, ebayReviewQueue and
 *    resolveCert already use. Below it the slug is reported as a suggestion but
 *    nothing is pinned, because pinning "sends pricing to the wrong card while
 *    still showing a value, which reads as correct"
 *    (ebayAutoHolding.service.ts:192). Max Williams is the live example: asked
 *    "Gold", the matcher offers `...:gold:auto:num-50` at fuzzy-parallel/0.72.
 *    That slug asserts a /50 serial the holding never claimed, and a numbered
 *    parallel prices nothing like an unnumbered one. A holding with no price is
 *    already correct under #1179; replacing it with a confident wrong price is
 *    strictly worse than leaving it flagged.
 *
 *    NOTE this is deliberately STRICTER than portfolioStore's own add/update
 *    path, which adopts on `found` with no confidence gate at all
 *    (portfolioStore.service.ts:4869, :5057). Those run in front of a human who
 *    just typed the card and can see the result; a batch sweep has no witness.
 *
 * 2. NEVER SEED. canonicalize() creates a catalog row when the source is
 *    trusted, and "user-verified" — what add/update pass — is trusted. Running
 *    this sweep that way would mint 16 permanent catalog rows from the exact
 *    raw strings that need repairing first: "NONE", "[Base]", "Logofractor",
 *    "ChromeProspectAutographRefractor". Against a catalog already carrying
 *    3.1x duplication that is pure harm, so we pass an untrusted source AND set
 *    CATALOG_MATCH_ONLY_ENABLED. Match only, both belts.
 *
 * 3. CLEAR THE STALE FLAG. #1179 stamps needsReview + reviewReason when a
 *    holding has no identity, but its unidentifiedPatch is `{}` on the resolved
 *    branch — it can set the flag and never clears it. Pinning identity without
 *    clearing it leaves the card flagged for review forever. We clear it ONLY
 *    when reviewReason is #1179's own message; any other reason is somebody
 *    else's flag and is left alone.
 *
 * Writes use replace() with an ifMatch etag, so a concurrent portfolio write
 * makes this sweep fail loudly rather than silently clobbering it.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="$(az webapp config appsettings list \
 *     --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
 *     npx tsx scripts/comp-quality/recheck-holding-identity.ts
 *
 *   APPLY=true       write the resolved identity back (default: report only)
 *   MIN_CONFIDENCE   pin threshold (default 0.9 — matches production)
 *   MIN_COST=50      only holdings above this cost basis (default 0)
 *   INCLUDE_PARKED=true   include Pokemon etc (default: skipped, vertical is parked)
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const APPLY = process.env.APPLY === "true";
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.9);
const MIN_COST = Number(process.env.MIN_COST || 0);
const INCLUDE_PARKED = process.env.INCLUDE_PARKED === "true";

/** #1179's exact reviewReason. We clear only the flag this prefix identifies. */
const UNIDENTIFIED_REVIEW_PREFIX = "We could not identify this card";

interface Pin {
  hid: string;
  slug: string;
  matchedBy: string;
  confidence: number;
}

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }

  // Rule 2, belt. The matcher reads this at call time, so setting it here
  // disables seeding for every canonicalize() below, whatever the source says.
  process.env.CATALOG_MATCH_ONLY_ENABLED = "true";

  const { CosmosClient } = await import("@azure/cosmos");

  // Resolved from cwd, and PRINTED — the session cwd can silently revert to a
  // stale checkout, and importing the matcher from the wrong tree would make
  // every number here a lie.
  const matcherPath = path.resolve(process.cwd(), "src/services/catalog/catalogMatcher.service.ts");
  console.log(`[import] ${matcherPath}`);
  console.log(`[mode]   ${APPLY ? "APPLY — WILL WRITE" : "report only"}   pin threshold ${MIN_CONFIDENCE}\n`);
  const { canonicalize } = await import(pathToFileURL(matcherPath).href);

  const c = new CosmosClient(conn).database("hobbyiq").container("portfolio");
  const { resources } = await c.items
    .query({ query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();

  if (!resources.length) {
    console.error("FATAL: zero portfolio docs returned. The sweep proved nothing.");
    process.exit(2);
  }

  const targets: Array<{ docId: string; userId: string; hid: string; h: any }> = [];
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
      targets.push({ docId: doc.id, userId: doc.userId, hid, h });
    }
  }

  if (!totalHoldings) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The sweep proved nothing.");
    process.exit(2);
  }

  console.log(`holdings scanned: ${totalHoldings}   unidentified to re-match: ${targets.length}` +
    (MIN_COST ? `   (cost >= $${MIN_COST})` : "") + "\n");

  let pinnable = 0, unresolved = 0, threw = 0, belowThreshold = 0;
  let costRecoverable = 0, costStranded = 0;
  const byMode = new Map<string, number>();
  // Pins grouped by portfolio doc — one read-modify-write per user, not per card.
  const pinsByDoc = new Map<string, { userId: string; pins: Pin[] }>();

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
        // Rule 2, braces: "unknown" is documented NEVER-SEEDS in the source union.
        source: "unknown",
      });
      byMode.set(r.matchedBy, (byMode.get(r.matchedBy) ?? 0) + 1);

      if (r.found && r.slug && r.confidence >= MIN_CONFIDENCE) {
        pinnable++; costRecoverable += cost;
        console.log(`  PIN       ${label}  parallel=${JSON.stringify(h.parallel)}`);
        console.log(`            -> ${r.slug}   (${r.matchedBy}, conf ${r.confidence})`);
        const entry = pinsByDoc.get(t.docId) ?? { userId: t.userId, pins: [] };
        entry.pins.push({ hid: t.hid, slug: r.slug, matchedBy: r.matchedBy, confidence: r.confidence });
        pinsByDoc.set(t.docId, entry);
      } else if (r.found && r.slug) {
        belowThreshold++; costStranded += cost;
        console.log(`  suggest   ${label}  parallel=${JSON.stringify(h.parallel)}`);
        console.log(`            ?  ${r.slug}   (${r.matchedBy}, conf ${r.confidence}) — below ${MIN_CONFIDENCE}, NOT pinned`);
      } else {
        unresolved++; costStranded += cost;
        console.log(`  no match  ${label}  parallel=${JSON.stringify(h.parallel)}  (${r.matchedBy}, conf ${r.confidence})`);
      }
    } catch (e: any) {
      threw++;
      console.log(`  THREW     ${label}  ${e?.message}`);
    }
  }

  console.log(`\nSUMMARY  target=${targets.length}  pinnable=${pinnable}  belowThreshold=${belowThreshold}  stillNotFound=${unresolved}  threw=${threw}`);
  console.log(`matchedBy: ${JSON.stringify(Object.fromEntries(byMode))}`);
  console.log(`cost basis recoverable by pinning: $${costRecoverable.toFixed(2)}`);
  console.log(`cost basis still stranded:         $${costStranded.toFixed(2)}`);

  if (!APPLY) {
    if (pinnable > 0) {
      console.log(`\nReport only — nothing written. Re-run with APPLY=true to pin the ${pinnable} above.`);
    }
    return;
  }

  // ---- APPLY -------------------------------------------------------------
  console.log(`\n=== APPLY: ${pinnable} pin(s) across ${pinsByDoc.size} portfolio doc(s) ===`);
  let wrote = 0, conflicts = 0, failed = 0, skipped = 0;

  for (const [docId, entry] of pinsByDoc) {
    // Re-read for a current etag AND the full doc; the query projection above
    // is three fields, and replacing from it would delete everything else.
    let doc: any, etag: string | undefined;
    try {
      const read = await c.item(docId, entry.userId).read();
      doc = read.resource;
      etag = (read.resource as any)?._etag;
    } catch (e: any) {
      failed += entry.pins.length;
      console.log(`  READ FAIL  ${docId}  ${e?.message}`);
      continue;
    }
    if (!doc?.holdings) {
      failed += entry.pins.length;
      console.log(`  READ FAIL  ${docId}  doc has no holdings`);
      continue;
    }

    const now = new Date().toISOString();
    let mutated = 0;
    for (const pin of entry.pins) {
      const h = doc.holdings[pin.hid];
      if (!h) {
        skipped++;
        console.log(`  SKIP       ${pin.hid}  holding vanished between passes`);
        continue;
      }
      // Re-assert the precondition against the FRESH doc. If anything gave this
      // holding an identity since the scan, that write wins and we stand down.
      if (h.hobbyiqCardId ?? h.cardId ?? null) {
        skipped++;
        console.log(`  SKIP       ${pin.hid}  identity appeared since scan`);
        continue;
      }

      h.hobbyiqCardId = pin.slug;
      h.cardId = pin.slug;
      h.catalogMatchSlug = pin.slug;
      h.catalogMatchedBy = pin.matchedBy;
      h.catalogMatchConfidence = pin.confidence;
      h.lastUpdated = now;

      // Force a reprice on the next surface hit, exactly as applyRematchToHolding
      // does — the stored price was computed with no identity and is not ours.
      h.predictedPrice = null;
      h.predictedPriceUpdatedAt = null;
      h.fairMarketValue = null;

      // Rule 3 — clear #1179's flag, and only #1179's flag.
      if (h.needsReview === true && String(h.reviewReason ?? "").startsWith(UNIDENTIFIED_REVIEW_PREFIX)) {
        h.needsReview = false;
        h.reviewReason = null;
      }

      mutated++;
      console.log(JSON.stringify({
        event: "holding_identity_rederived",
        source: "recheck-holding-identity",
        userId: entry.userId,
        holdingId: pin.hid,
        slug: pin.slug,
        matchedBy: pin.matchedBy,
        confidence: pin.confidence,
      }));
    }

    if (!mutated) continue;

    try {
      await c.item(docId, entry.userId).replace(doc, { accessCondition: { type: "IfMatch", condition: etag! } });
      wrote += mutated;
      console.log(`  WROTE      ${docId}  ${mutated} holding(s)`);
    } catch (e: any) {
      if (e?.code === 412) {
        conflicts += mutated;
        console.log(`  CONFLICT   ${docId}  doc changed under us — nothing written, re-run the sweep`);
      } else {
        failed += mutated;
        console.log(`  WRITE FAIL ${docId}  ${e?.message}`);
      }
    }
  }

  console.log(`\nAPPLY DONE  written=${wrote}  skipped=${skipped}  conflicts=${conflicts}  failed=${failed}`);
  if (wrote > 0) {
    console.log(`Re-run WITHOUT APPLY to confirm the pinned rows no longer appear as targets.`);
  }
  if (conflicts || failed) process.exit(4);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
