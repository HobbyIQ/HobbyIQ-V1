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

// BACKFILL_APPLY is what the runner exports; APPLY is what a hand run types.
// Reading BOTH is deliberate (feedback_runner_exports_backfill_apply): a
// dispatch that set `apply: true` and found this script reading only APPLY
// would report a dry run as if it had written.
const APPLY = process.env.APPLY === "true" || process.env.BACKFILL_APPLY === "true";
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.9);
const MIN_COST = Number(process.env.MIN_COST || 0);
const INCLUDE_PARKED = process.env.INCLUDE_PARKED === "true";

/**
 * MODE=rederive — THE HOLDING WHOSE IDENTITY IS PRESENT BUT WRONG
 * (Drew, 2026-09-04, ruling R2).
 *
 * The sweep above this line has one precondition it never states as a
 * limitation: `if (h.hobbyiqCardId ?? h.cardId) continue`. It re-derives only
 * holdings with NO identity, because an absent identity is self-evidently
 * safe to fill. That leaves the harder population untouched, and it is the
 * population that actually prices a user's card wrong:
 *
 *   277b05a3  "1997 Metal Universe Cal Ripken Jr. #8 PSA 8" priced from
 *             hiq:baseball:1997:metal-universe:8:base:no-auto — a pool whose
 *             7 rows are FOUR different cards (#1774). The slug is confident,
 *             well-formed, and names the wrong PRODUCT: the sale is a Magnetic
 *             Field insert, and base #8 and Magnetic Field #8 are BOTH Cal
 *             Ripken Jr., so nothing about the player or the number disagrees.
 *   c8949bb0  1987 Bellingham #15 stored at `:1987-bellingham-baseball:`, one
 *             of the three slugs the same 228-row pool is split across.
 *
 * A wrong identity is INVISIBLE to the unidentified sweep and invisible to
 * repriceOneHolding (which prices the identity it is given). Nothing in the
 * product re-derives it. This mode is that missing pass.
 *
 * IT IS STRICTLY NARROWER THAN THE SWEEP IT SITS BESIDE, ON PURPOSE:
 *
 *   SCOPED BY NAME. It refuses to run corpus-wide. Either HOLDING_IDS names
 *     the holdings (the runner's `titles` input carries them — a comma list of
 *     ids or id prefixes) or USER_ID names one user. Both empty is a refusal,
 *     not a whole-portfolio sweep (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME).
 *   CHECKLIST-MATCHED ONLY, NEVER MINT. Same two belts as the sweep —
 *     CATALOG_MATCH_ONLY_ENABLED plus an untrusted `source` — and then a THIRD
 *     that the sweep does not need: the resolved slug must be backed by a real
 *     catalog row, read back by id. A slug the matcher composes but no
 *     checklist lists is reported and never written. Replacing one confident
 *     wrong identity with another is the failure this mode could uniquely
 *     cause, so it is the failure it guards hardest against.
 *   NO SILENT COLLAPSE. If the holding claims an axis the destination does not
 *     carry — a print run, a serial, a parallel — the write is refused and the
 *     holding is left `identityUnverified` with the reason, rather than
 *     dropped onto a less specific row. Drew's ca7a150b is exactly this: a
 *     Gold Refractor /50 with no ladder source, which stays unverified rather
 *     than collapsing onto the base auto.
 *
 * Reports old -> new with the checklist row that backs the new one. APPLY only
 * via BACKFILL_APPLY (or APPLY), and every write is verified by reading the
 * document back.
 */
const MODE = String(process.env.MODE ?? "").trim().toLowerCase();
const REDERIVE = MODE === "rederive";
/** The runner's `titles` input, reused as the holding-id list (workflow_dispatch
 *  is at its input cap; see the backfill-runner comment for this script). */
const HOLDING_IDS = String(process.env.HOLDING_IDS ?? process.env.BCP_TITLES ?? process.env.TITLES ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const USER_ID = String(process.env.USER_ID ?? "").trim();

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

  const db = new CosmosClient(conn).database("hobbyiq");
  const c = db.container("portfolio");
  const { resources } = await c.items
    .query({ query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();

  // MODE=rederive is a DIFFERENT PASS over the same documents, not a variant
  // of the sweep below: its precondition is the opposite one (identity
  // PRESENT, not absent), so it branches here rather than threading a flag
  // through a loop whose every guard would need inverting.
  if (REDERIVE) {
    // Bound to a name, and READ-ONLY. This script never writes card_catalog —
    // it queries it to prove a destination slug exists (see GATE 1 in
    // `rederive`) and mints nothing, which is the whole point of the
    // never-seed rule above. The binding is what lets
    // oneWayToBuildACatalogRow.test.ts resolve the handle and see that: passed
    // inline as an argument it resolves to nothing, and the file's OTHER
    // `.item().replace()` — the PORTFOLIO write — is then loose-matched as if
    // it were a catalog mutation.
    const catalogReadOnly = db.container("card_catalog");
    await rederive({ docs: resources as any[], container: c, catalog: catalogReadOnly, canonicalize });
    return;
  }

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
        setName: String(h.setName ?? h.product ?? ""),
        cardNumber: String(h.cardNumber ?? ""),
        parallel: h.parallel ?? null,
        isAuto: h.isAuto === true,
        // CF-REDERIVE-MUST-STATE-THE-PRINT-RUN (2026-09-05). Omitted here, the
        // matcher could not reach a :num-N ladder row and GATE 2 then refused
        // the move as a dropped-specificity claim. Production has always passed
        // it (ebayReviewQueue.service.ts:766); this pass had not.
        printRun: typeof h.printRun === "number" ? h.printRun : null,
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

// ── MODE=rederive ───────────────────────────────────────────────────────────

/** The axes a holding can CLAIM that a destination row must not silently drop.
 *  Each is a thing the user (or the eBay listing) asserted about the physical
 *  card; a destination that does not carry it is a DIFFERENT card, not a
 *  less-specific description of the same one. */
const SPECIFICITY_AXES = ["printRun", "serialNumber", "parallel"] as const;

/**
 * GATE 2 — WHICH AXES WOULD THIS MOVE SILENTLY DROP?
 *
 * Returns the axes the HOLDING claims that the DESTINATION slug does not
 * state. Non-empty means refuse: a card serial-numbered /50 is not the same
 * card as the unnumbered one, and a Gold Refractor is not the base auto.
 * Moving one onto the other fuses two pools and prices both wrong, which is
 * the same defect the aliases in this PR exist to undo, committed deliberately.
 *
 * Exported so a pin can drive it alone and a mutation check can revert it
 * alone — a guard nothing can call alone is a guard nothing can prove.
 *
 * `parallel: "Base"` is NOT a claim: it is the absence of one, and the slug
 * grammar spells it `:base:` on the destination anyway. Everything else is
 * compared against the destination slug's own text, because the slug is the
 * identity — if the axis is not IN the slug, the destination does not carry it.
 */
export function droppedSpecificityAxes(
  holding: Record<string, unknown>,
  to: string,
): string[] {
  return SPECIFICITY_AXES.filter((axis) => {
    const v = holding[axis];
    if (v === null || v === undefined || v === "") return false;
    if (axis === "parallel" && /^base$/i.test(String(v))) return false;
    // The destination carries the axis when its own slug states it.
    if (axis === "printRun") return !new RegExp(`:num-${Number(v)}(?::|$)`).test(to);
    if (axis === "serialNumber") return !/:num-\d+(?::|$)/.test(to);
    return !to.toLowerCase().includes(String(v).toLowerCase().replace(/\s+/g, "-"));
  });
}

interface RederiveVerdict {
  hid: string;
  userId: string;
  docId: string;
  from: string | null;
  to: string | null;
  backedBy: string | null;
  verdict: "REDERIVE" | "AGREE" | "UNVERIFIED" | "NO-MATCH";
  reason: string;
  matchedBy?: string;
  confidence?: number;
}

async function rederive(
  { docs, container, catalog, canonicalize }:
  { docs: any[]; container: any; catalog: any; canonicalize: (i: any) => Promise<any> },
): Promise<void> {
  // SCOPE OR REFUSE. A re-derivation that can rewrite a CORRECT identity must
  // be asked for by name; "every holding" is not a name.
  if (!HOLDING_IDS.length && !USER_ID) {
    console.error(
      "FATAL: MODE=rederive needs a scope. Pass HOLDING_IDS (comma-separated holding ids or id\n"
      + "prefixes — the runner's `titles` input) or USER_ID. Refusing to re-derive every holding in\n"
      + "the database: this mode can overwrite an identity that is already right.");
    process.exit(2);
  }
  if (!docs.length) {
    console.error("FATAL: zero portfolio docs returned. The pass proved nothing.");
    process.exit(2);
  }

  console.log(`[scope]  ${HOLDING_IDS.length ? `holdings: ${HOLDING_IDS.join(", ")}` : `user: ${USER_ID}`}`);
  console.log(`[mode]   rederive — ${APPLY ? "APPLY, WILL WRITE" : "report only"}\n`);

  const targets: Array<{ docId: string; userId: string; hid: string; h: any }> = [];
  let scanned = 0;
  for (const doc of docs) {
    if (USER_ID && doc.userId !== USER_ID && doc.id !== USER_ID) continue;
    for (const [hid, h] of Object.entries<any>(doc.holdings || {})) {
      if (!h) continue;
      scanned++;
      if (HOLDING_IDS.length && !HOLDING_IDS.some((w) => hid === w || hid.startsWith(w))) continue;
      targets.push({ docId: doc.id, userId: doc.userId, hid, h });
    }
  }

  if (!scanned) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The pass proved nothing.");
    process.exit(2);
  }
  if (!targets.length) {
    console.error(`FATAL: the scope matched NO holding out of ${scanned} scanned. A scope that names nothing is a\n`
      + "typo, not an empty result — refusing to report a clean zero.");
    process.exit(2);
  }
  console.log(`holdings scanned: ${scanned}   in scope: ${targets.length}\n`);

  /** Is this slug a real catalog row, and what source backs it? `null` when
   *  absent — and absent is a REFUSAL, never a shrug. Read by id, which is how
   *  the catalog is keyed, so this cannot match a near neighbour. */
  const backingOf = async (slug: string): Promise<{ id: string; source: string; setName: string | null } | null> => {
    const { resources } = await catalog.items
      .query({
        query: "SELECT c.id, c.source, c.setName FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: slug }],
      })
      .fetchAll();
    const r = resources?.[0];
    return r ? { id: r.id, source: String(r.source ?? "unknown"), setName: r.setName ?? null } : null;
  };

  const verdicts: RederiveVerdict[] = [];

  for (const t of targets) {
    const h = t.h;
    const from = h.hobbyiqCardId ?? h.cardId ?? null;
    const label = `${String(h.playerName ?? "?").slice(0, 22).padEnd(22)} ${String(h.cardYear ?? "?")} #${String(h.cardNumber ?? "?").padEnd(8)}`;
    const push = (v: Omit<RederiveVerdict, "hid" | "userId" | "docId" | "from">) =>
      verdicts.push({ hid: t.hid, userId: t.userId, docId: t.docId, from, ...v });

    let r: any;
    try {
      r = await canonicalize({
        sport: String(h.sport ?? "Baseball").toLowerCase(),
        year: Number(h.cardYear) || 0,
        setName: String(h.setName ?? h.product ?? ""),
        cardNumber: String(h.cardNumber ?? ""),
        parallel: h.parallel ?? null,
        isAuto: h.isAuto === true,
        // CF-REDERIVE-MUST-STATE-THE-PRINT-RUN (2026-09-05). Omitted here, the
        // matcher could not reach a :num-N ladder row and GATE 2 then refused
        // the move as a dropped-specificity claim. Production has always passed
        // it (ebayReviewQueue.service.ts:766); this pass had not.
        printRun: typeof h.printRun === "number" ? h.printRun : null,
        player: h.playerName ?? null,
        // NEVER SEED, braces. Same untrusted source the sweep uses.
        source: "unknown",
      });
    } catch (e: any) {
      push({ to: null, backedBy: null, verdict: "NO-MATCH", reason: `matcher threw: ${e?.message}` });
      console.log(`  THREW      ${label}  ${e?.message}`);
      continue;
    }

    const to: string | null = r?.found && r?.slug ? r.slug : null;
    if (!to) {
      push({ to: null, backedBy: null, verdict: "NO-MATCH",
        reason: `matcher found nothing (${r?.matchedBy}, conf ${r?.confidence})`,
        matchedBy: r?.matchedBy, confidence: r?.confidence });
      console.log(`  NO MATCH   ${label}  from=${from}  (${r?.matchedBy}, conf ${r?.confidence})`);
      continue;
    }

    if (to === from) {
      push({ to, backedBy: null, verdict: "AGREE", reason: "re-derivation agrees with the stored identity",
        matchedBy: r.matchedBy, confidence: r.confidence });
      console.log(`  AGREE      ${label}  ${from}`);
      continue;
    }

    // GATE 1 — the destination must be a REAL CHECKLIST ROW. This is the gate
    // the plain sweep does not have, and the reason this mode may touch a
    // holding that already has an identity at all.
    const backing = await backingOf(to);
    if (!backing) {
      push({ to, backedBy: null, verdict: "UNVERIFIED",
        reason: "no catalog row backs the derived slug — never mint",
        matchedBy: r.matchedBy, confidence: r.confidence });
      console.log(`  UNVERIFIED ${label}\n             ${from}\n          -> ${to}   NOT WRITTEN: no catalog row backs it (${r.matchedBy}, conf ${r.confidence})`);
      continue;
    }

    // GATE 2 — NO SILENT COLLAPSE. A holding that claims a print run, a serial
    // or a parallel the destination does not carry is a DIFFERENT card from
    // the destination, and moving it there would fuse two pools.
    //
    // ca7a150b IS STILL THE CANARY, but it proves the OPPOSITE of what the
    // first cut of this comment claimed (Drew, 2026-09-05). It is a standard
    // Gold Refractor Autograph /50 and its ladder is fully published: the row
    // `hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50`
    // exists, source `checklist`, printRun 50. It was never a PackFractor and
    // was never unpriceable. Two things hid that, and BOTH lived in this
    // script rather than in the catalog:
    //
    //   1. this pass sent `product` ("Bowman") as the set name where every
    //      production caller sends `setName` ("Bowman Chrome"), so the setKey
    //      invariant saw asked=bowman vs returned=bowman-chrome and rejected
    //      its own correct 0.98 exact match; and
    //   2. it never passed printRun, so the matcher could not reach the
    //      :num-50 rung and GATE 2 then read the holding's own /50 as a
    //      dropped claim.
    //
    // The gate itself is right and is left exactly as it was.
    const claimed = droppedSpecificityAxes(h, to);
    if (claimed.length) {
      push({ to, backedBy: backing.source, verdict: "UNVERIFIED",
        reason: `no ladder source — the holding claims ${claimed.map((a) => `${a}=${h[a]}`).join(", ")} and the destination does not carry it`,
        matchedBy: r.matchedBy, confidence: r.confidence });
      console.log(`  UNVERIFIED ${label}\n             ${from}\n          -> ${to}   NOT WRITTEN: holding claims ${claimed.map((a) => `${a}=${h[a]}`).join(", ")}, destination does not carry it`);
      continue;
    }

    // GATE 3 — the same confidence floor the sweep pins at, for the same
    // reason: below it a slug is a suggestion, and a confident wrong price
    // reads as correct.
    if (Number(r.confidence) < MIN_CONFIDENCE) {
      push({ to, backedBy: backing.source, verdict: "UNVERIFIED",
        reason: `confidence ${r.confidence} below ${MIN_CONFIDENCE}`,
        matchedBy: r.matchedBy, confidence: r.confidence });
      console.log(`  UNVERIFIED ${label}\n             ${from}\n          -> ${to}   NOT WRITTEN: conf ${r.confidence} < ${MIN_CONFIDENCE}`);
      continue;
    }

    push({ to, backedBy: backing.source, verdict: "REDERIVE",
      reason: `checklist-backed by ${backing.source}`, matchedBy: r.matchedBy, confidence: r.confidence });
    console.log(`  REDERIVE   ${label}\n             ${from}\n          -> ${to}   (${r.matchedBy}, conf ${r.confidence})  backed by ${backing.source}${backing.setName ? ` — "${backing.setName}"` : ""}`);
  }

  const counts = verdicts.reduce<Record<string, number>>((a, v) => { a[v.verdict] = (a[v.verdict] ?? 0) + 1; return a; }, {});
  console.log(`\nSUMMARY  ${JSON.stringify(counts)}`);
  console.log(JSON.stringify({ event: "holding_rederive_report", mode: "rederive", apply: APPLY, verdicts }, null, 1));

  const writable = verdicts.filter((v) => v.verdict === "REDERIVE");
  if (!APPLY) {
    console.log(`\nReport only — nothing written.${writable.length ? ` Re-run with BACKFILL_APPLY=true to move the ${writable.length} above.` : ""}`);
    return;
  }
  if (!writable.length) {
    console.log("\nAPPLY requested, but nothing qualified. Nothing written.");
    return;
  }

  // ---- APPLY ---------------------------------------------------------------
  console.log(`\n=== APPLY: ${writable.length} re-derivation(s) ===`);
  let wrote = 0, skipped = 0, conflicts = 0, failed = 0;
  const byDoc = new Map<string, RederiveVerdict[]>();
  for (const v of writable) byDoc.set(v.docId, [...(byDoc.get(v.docId) ?? []), v]);

  for (const [docId, list] of byDoc) {
    const userId = list[0].userId;
    let doc: any, etag: string | undefined;
    try {
      const read = await container.item(docId, userId).read();
      doc = read.resource; etag = (read.resource as any)?._etag;
    } catch (e: any) {
      failed += list.length; console.log(`  READ FAIL  ${docId}  ${e?.message}`); continue;
    }
    if (!doc?.holdings) { failed += list.length; console.log(`  READ FAIL  ${docId}  doc has no holdings`); continue; }

    const now = new Date().toISOString();
    let mutated = 0;
    for (const v of list) {
      const h = doc.holdings[v.hid];
      if (!h) { skipped++; console.log(`  SKIP       ${v.hid}  holding vanished between passes`); continue; }
      // Re-assert the precondition against the FRESH doc: the identity we are
      // replacing must still be the one we read.
      const cur = h.hobbyiqCardId ?? h.cardId ?? null;
      if (cur !== v.from) { skipped++; console.log(`  SKIP       ${v.hid}  identity changed under us (${cur})`); continue; }

      h.hobbyiqCardId = v.to;
      h.cardId = v.to;
      h.catalogMatchSlug = v.to;
      h.catalogMatchedBy = v.matchedBy ?? "rederive";
      h.catalogMatchConfidence = v.confidence ?? null;
      h.lastUpdated = now;
      // THE AUDIT TRAIL. A re-derived identity says where it came from and what
      // backed the move, in its own document — a later pass must be able to
      // tell this from an identity the user typed.
      h.identityRederivedFrom = v.from;
      h.identityRederivedAt = now;
      h.identityRederivedBy = "recheck-holding-identity MODE=rederive";
      h.identityRederivedBackedBy = v.backedBy;
      // The stored price was computed for the OLD identity and is not ours.
      h.predictedPrice = null;
      h.predictedPriceUpdatedAt = null;
      h.fairMarketValue = null;
      if (h.needsReview === true && String(h.reviewReason ?? "").startsWith(UNIDENTIFIED_REVIEW_PREFIX)) {
        h.needsReview = false; h.reviewReason = null;
      }
      mutated++;
      console.log(JSON.stringify({
        event: "holding_identity_rederived", source: "recheck-holding-identity/rederive",
        userId, holdingId: v.hid, from: v.from, to: v.to, backedBy: v.backedBy,
        matchedBy: v.matchedBy, confidence: v.confidence,
      }));
    }
    if (!mutated) continue;

    try {
      await container.item(docId, userId).replace(doc, { accessCondition: { type: "IfMatch", condition: etag! } });
      wrote += mutated;
      console.log(`  WROTE      ${docId}  ${mutated} holding(s)`);
    } catch (e: any) {
      if (e?.code === 412) { conflicts += mutated; console.log(`  CONFLICT   ${docId}  doc changed under us — nothing written, re-run`); }
      else { failed += mutated; console.log(`  WRITE FAIL ${docId}  ${e?.message}`); }
    }
  }

  console.log(`\nAPPLY DONE  written=${wrote}  skipped=${skipped}  conflicts=${conflicts}  failed=${failed}`);

  // VERIFY BY READ. A green run is not a written row
  // (feedback_green_workflow_is_not_data_flow): re-read every document we
  // claimed to write and assert the stored identity is the one we intended.
  if (wrote > 0) {
    console.log(`\n=== RECONCILIATION: re-reading ${byDoc.size} document(s) ===`);
    let confirmed = 0, wrong = 0;
    for (const [docId, list] of byDoc) {
      const read = await container.item(docId, list[0].userId).read();
      for (const v of list) {
        const h = (read.resource as any)?.holdings?.[v.hid];
        const got = h?.hobbyiqCardId ?? h?.cardId ?? null;
        if (got === v.to) { confirmed++; console.log(`  OK         ${v.hid}  ${got}`); }
        else { wrong++; console.log(`  MISMATCH   ${v.hid}  expected ${v.to}, stored ${got}`); }
      }
    }
    console.log(`\nVERIFIED   confirmed=${confirmed}  mismatched=${wrong}`);
    if (wrong) process.exit(5);
  }
  if (conflicts || failed) process.exit(4);
}

// Run only when EXECUTED, never when imported. `droppedSpecificityAxes` above
// is pinned by a unit test, and an unconditional main() would have that test
// open a Cosmos connection (and exit the process) on import.
const INVOKED_DIRECTLY = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
})();

if (INVOKED_DIRECTLY) {
  main().catch((e) => {
    console.error("FATAL:", e?.stack || e?.message || String(e));
    process.exit(3);
  });
}
