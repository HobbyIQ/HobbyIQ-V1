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
import { recoverHoldingFields, titleStatedProduct } from "../../src/services/portfolioiq/holdingFieldRecovery.service.js";
// GATE R2's authority test — the SAME one the catalog uses to decide which row
// may adjudicate a card. A ruling is not licence to pin a user's holding to a
// row we derived from our own sales.
import { canAdjudicate, catalogAuthorityOf } from "../../src/services/catalog/catalogAuthority.service.js";
// CF-AGREE-IS-A-VERDICT-ABOUT-A-ROW (Drew, 2026-09-05). The SAME predicate the
// pricing gate asks — imported, never restated, for the reason
// sourceCorroboration's header gives at length: four spellings of "is this row
// checklist-backed" is how the rematch comes to write rows the gate refuses.
import { identityBackingOf, isSelfDerivedIdentity } from "../../src/services/catalog/identityBacking.js";

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
/**
 * MODE=rule — THE HUMAN SAYS WHICH CARD IT IS (Drew, 2026-09-05).
 *
 * MODE=rederive DERIVES an identity and, since #1811, refuses to write one a
 * human already ruled on. That is the right default and it leaves a gap with
 * no exit: when the derivation is RIGHT and the standing ruling is stale,
 * nothing in the product can say so. Both of #1811's canaries are exactly
 * that shape —
 *
 *   6f4f079b  Drew ruled it `...:d24:base:no-auto` on 2026-08-30, before
 *             #1787 ingested the row that made the real answer reachable.
 *             Field recovery then proved the destination at exact/0.98 and
 *             correctly declined to overwrite him.
 *   277b05a3  stores no cardNumber at all, so no derivation can reach its
 *             row: `inferSetKeyFromTitle` reads its description as "Fleer
 *             Metal", and the only witness naming `metal-universe` is the
 *             vendor suggestion that mispriced it. A machine cannot get here.
 *             A person who owns the card can.
 *
 * SO THIS MODE IS NOT A BETTER DERIVATION — IT IS A DIFFERENT KIND OF CLAIM.
 * The slug is not computed, it is DICTATED, one holding at a time, by name:
 *
 *     MODE=rule titles=6f4f079b=hiq:baseball:1999:...:num-1500,277b05a3=hiq:...
 *
 * WHAT IT STILL REFUSES, because a ruling is not a licence to invent a card:
 *
 *   THE ROW MUST EXIST. Read back by id, exactly as GATE 1 does. A ruling
 *     onto a slug no catalog row carries is refused BY NAME — it would mint
 *     an identity from a typo and price a real card off an empty pool.
 *   THE ROW MUST BE CHECKLIST-BACKED. `canAdjudicate` — the same authority
 *     test the catalog uses to decide which row may adjudicate a card. A
 *     ruling onto a `holding-seeded-*`, `sales-attested` or vendor row would
 *     pin a user's card to a row derived from our own sales, which is the
 *     self-comp loop the pricing doctrine exists to break.
 *   IT NEVER TOUCHES A FIELD THE USER SET. Blank fields are filled FROM the
 *     ruled row (that is the ruling's whole content); a field the holding
 *     already states is left alone and reported, because the ruling names the
 *     CARD and the user's own typing is still the better witness for the rest.
 *
 * AND THE ASYMMETRY THAT MAKES IT SAFE: a ruling may override a PRIOR RULING,
 * and only here. MODE=rederive stays report-only on ruled rows forever. A
 * human overriding a human is a decision; a script overriding a human is the
 * failure #1811 built the gate against, and that gate is untouched.
 */
const MODE = String(process.env.MODE ?? "").trim().toLowerCase();
const REDERIVE = MODE === "rederive";
const RULE = MODE === "rule";

/** The ruling this mode stamps. Dated, because a ruling is an event: the
 *  2026-08-30 ruling on 6f4f079b was correct for the catalog that existed
 *  then, and is superseded rather than erased. */
const RULING_ID = String(process.env.RULING_ID ?? "ruling:Drew:2026-09-05").trim();

/** The runner's `titles` input, reused as the holding-id list (workflow_dispatch
 *  is at its input cap; see the backfill-runner comment for this script).
 *  In MODE=rule each entry is `id8=slug` instead of a bare id. */
const HOLDING_IDS = String(process.env.HOLDING_IDS ?? process.env.BCP_TITLES ?? process.env.TITLES ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const USER_ID = String(process.env.USER_ID ?? "").trim();

/** #1179's exact reviewReason. We clear only the flag this prefix identifies. */
const UNIDENTIFIED_REVIEW_PREFIX = "We could not identify this card";

/** One `id8=slug` pair from the `titles` input. */
export interface RulingPair { hid: string; slug: string; }

/**
 * Parse MODE=rule's `titles` input: `id8=slug` pairs, comma-separated.
 *
 * EVERY MALFORMED ENTRY IS A REFUSAL, NOT A SKIP. A ruling list is typed by
 * hand into a dispatch box, and the failure that matters is the one that looks
 * like it worked: an entry that silently drops leaves the operator believing a
 * card was ruled when it was not, and the card keeps its wrong price.
 * `feedback_scope_formats_are_per_script` is this exact shape — `years=2018-2019`
 * became ALL in a comma-list script. So this throws on the first bad entry and
 * names it.
 *
 * A bare id with no `=` is rejected too: in MODE=rederive that spelling means
 * "derive this holding", and accepting it here would read a rederive scope as
 * a ruling with an empty destination.
 *
 * Exported so a pin can drive it alone.
 */
export function parseRulingPairs(entries: string[]): RulingPair[] {
  const out: RulingPair[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) {
      throw new Error(
        `MODE=rule needs \`id8=slug\` pairs; got a bare id ${JSON.stringify(entry)}. `
        + "A bare id is MODE=rederive's spelling — refusing rather than ruling a holding onto nothing.");
    }
    const hid = entry.slice(0, eq).trim();
    const slug = entry.slice(eq + 1).trim();
    if (!hid) throw new Error(`MODE=rule entry ${JSON.stringify(entry)} has no holding id before the '='.`);
    if (!slug) throw new Error(`MODE=rule entry ${JSON.stringify(entry)} names no destination slug after the '='.`);
    // The slug must LOOK like one of ours. A ruling is a write, and a
    // destination that is not a hiq: id cannot be a catalog row by id.
    if (!slug.startsWith("hiq:")) {
      throw new Error(
        `MODE=rule destination ${JSON.stringify(slug)} for ${hid} is not a hiq: slug. `
        + "Rulings name a canonical catalog id, never a vendor id or a title.");
    }
    if (seen.has(hid)) {
      throw new Error(`MODE=rule names holding ${hid} twice. One card, one ruling — refusing an ambiguous list.`);
    }
    seen.add(hid);
    out.push({ hid, slug });
  }
  if (!out.length) {
    throw new Error("MODE=rule was given no rulings. Pass `titles=id8=slug,...` — an empty ruling list is a typo, not a no-op.");
  }
  return out;
}

/**
 * Which identity fields does a ruled catalog row dictate?
 *
 * IN MODE=rule, ALL OF THEM (Drew, 2026-09-05): "the ruling IS the user's
 * word." The set, the number, the parallel and the print run all follow from
 * WHICH CARD IT IS, so the ruled row's values win over whatever the holding
 * stores — including a value a prior ruling set, and including one typed by
 * hand earlier.
 *
 * THIS IS THE OPPOSITE OF MODE=rederive'S RULE, AND THE ASYMMETRY IS THE
 * WHOLE DESIGN. Automatic recovery may only fill blanks, because it is a
 * machine guessing next to a human's typing (holdingFieldRecovery.service.ts).
 * A ruling is the human, stating the card explicitly, by name, one at a time.
 * "Never overwrite a user-set field" protects the user from the machine; it
 * would be nonsense to apply it against the user themself.
 *
 * 6f4f079b IS THE CASE THAT FORCED THE DECISION. It stores `parallel: "Base"`
 * — a real stated value, set before #1787 ingested the row that proves the
 * card is a Diamond Dominance insert. Under a blank-only rule the identity
 * would move to `...:diamond-dominance:no-auto:num-1500` while the visible
 * field still read "Base": a card whose own record contradicts its identity.
 * The ruling settles that, so the ruling's spelling wins.
 *
 * NOTHING IS LOST. Every overwrite carries `previous`, and the apply writes
 * them into `identityRuling.previousFields`, so the displaced values are
 * recoverable from the document itself and the overwrite is reversible.
 *
 * TWO THINGS THE ROW STILL NEVER DICTATES:
 *   A field the ROW does not state. A null printRun on a checklist row means
 *     unknown, and unknown never overwrites a value.
 *   `playerName` and every grade field. Drew's ruling says so explicitly, and
 *     the reason outlives the instruction: the row's player is a
 *     transcription and the holding's is what the owner calls their own card,
 *     and the grade belongs to the slab in hand, not to the checklist.
 *
 * Exported so a pin can drive it alone.
 */
export function fieldsFromRuledRow(
  holding: Record<string, unknown>,
  row: { setName?: string | null; cardNumber?: string | null; parallel?: string | null; printRun?: number | string | null },
): Array<{ field: string; value: string | number; from: "ruled-row"; previous: unknown }> {
  const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
  const fills: Array<{ field: string; value: string | number; from: "ruled-row"; previous: unknown }> = [];

  /** Take the row's value whenever the row states one, and record what it
   *  displaced. `previous` is the audit trail: nothing is lost, so the
   *  overwrite is reversible from the document itself. A field the row does
   *  NOT state is still never touched — a null in the checklist is unknown,
   *  and unknown never overwrites a value. */
  const take = (field: string, rowValue: string | number | null | undefined) => {
    if (rowValue === null || rowValue === undefined || String(rowValue).trim() === "") return;
    const value = typeof rowValue === "number" ? rowValue : String(rowValue).trim();
    const previous = holding[field] ?? null;
    // Nothing to record and nothing to change when they already agree.
    if (!blank(previous) && String(previous) === String(value)) return;
    if (blank(previous) && (value === "" as unknown)) return;
    fills.push({ field, value, from: "ruled-row", previous });
  };

  take("setName", row.setName);
  take("cardNumber", row.cardNumber);
  take("parallel", row.parallel);
  const pr = Number(row.printRun);
  if (Number.isFinite(pr) && pr > 0) take("printRun", pr);

  return fills;
}

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
  // MODE=rule is a THIRD pass, and the only one that does not ask the matcher
  // a question at all: the slug is dictated, so there is nothing to derive.
  // It shares the catalog read-back and the etag-guarded verified write with
  // `rederive` and nothing else.
  if (RULE) {
    const catalogReadOnly = db.container("card_catalog");
    await rule({ docs: resources as any[], container: c, catalog: catalogReadOnly });
    return;
  }

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

/**
 * ROOKIE / TEAM / PRODUCT DECORATION ON A PLAYER NAME. Not another player —
 * the SAME name with a hobby token stapled on, by a checklist transcriber or
 * by the seller who typed the holding.
 *
 * MEASURED, not guessed (read-only sweep of all 130 holdings, 2026-09-06).
 * Widening GATE 1b to stored set names raised 13 contradictions, and FIVE of
 * them were this, on holdings that are already RIGHT:
 *
 *   "Mike Trout"             vs catalog "Mike Trout RC"      (3 holdings)
 *   "Aaron Judge"            vs catalog "Aaron Judge RC"
 *   "Bobby Witt Jr. Royals"  vs catalog "Bobby Witt Jr."
 *   "Draft Devin Taylor"     vs its own row's "Devin Taylor"
 *
 * Parking those is not caution, it is damage: the widening would withhold five
 * correctly-identified cards on the strength of the letters "RC".
 *
 * A CLOSED LIST, AND IT STAYS CLOSED. Every token here is a hobby word or an
 * MLB club name that cannot be a surname on its own — never a fuzzy score, and
 * never a rule that could eat a real name. `Gonzalez` vs `Gonzales` stays a
 * REFUSAL (it is on no list here and one letter is not a decoration), and so
 * does every case project_beckett_initials_card_numbers_collide is about:
 * Devin Taylor and Diego Tornes share their initials and nothing this strips.
 *
 * THE CLUB NAMES ARE ONLY THE ONES THE MEASURED POPULATION CARRIES, and each
 * is a plural or a common noun no MLB player is surnamed. A club whose name
 * doubles as a surname (Boston's "Sox" is safe; a hypothetical "Marlin" is
 * not) does NOT go on this list. Add a token only with a measured case in
 * front of you — an unmeasured addition here silently fuses two players.
 */
const PLAYER_NAME_DECORATIONS = new RegExp(
  "\\b(?:"
  + "rc|rookie|"                       // rookie-card markers
  + "draft|prospect|prospects|auto|autograph|"   // product words
  + "royals|athletics|yankees|angels?"           // club names seen in the data
  + ")\\b",
  "g",
);

/**
 * Fold a player name to the form GATE 1b compares on: lowercase, no
 * punctuation, no generational suffix, no hobby decoration. "Cal Ripken, Jr."
 * and "Cal Ripken Jr" are one player, and so are "Mike Trout" and "Mike Trout
 * RC"; "Cal Ripken" and "Billy Ripken" are not, and neither are "Justin
 * Gonzalez" and "Justin Gonzales".
 *
 * Deliberately NOT a fuzzy score. This gate exists to catch a destination that
 * is a DIFFERENT CARD, and a similarity threshold is exactly how two brothers
 * or two players sharing an initials card number get fused
 * (project_beckett_initials_card_numbers_collide). Equal after folding, or
 * refuse. The decoration list above is a CLOSED VOCABULARY for exactly that
 * reason: it removes tokens that are never a name, rather than tolerating a
 * difference between two names.
 *
 * Exported so a mutation check can revert it alone.
 */
export function normalizePlayerForCompare(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(?:jr|sr|ii|iii|iv)\b\.?/g, " ")
    .replace(PLAYER_NAME_DECORATIONS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * GATE 1b's decision, alone.
 *
 * Returns true when the destination row CORROBORATES a recovered set name —
 * i.e. both sides name a player and they are the same person. Everything else
 * is a refusal, including a destination with no player name at all: 16,831
 * bccp rows carry `playerName: null`, and a null is not agreement (memory:
 * "count by source, not row count").
 *
 * Exported so a mutation check can revert the DECISION rather than only its
 * helper — a gate whose refusal nothing can call alone is a gate nothing can
 * prove.
 */
export function recoveredSetNameIsCorroborated(
  holdingPlayer: unknown,
  catalogRowPlayer: unknown,
): boolean {
  const a = normalizePlayerForCompare(holdingPlayer);
  const b = normalizePlayerForCompare(catalogRowPlayer);
  if (!a || !b) return false;
  return a === b;
}

/** A graded child's tail: `…:psa-10`, `…:bgs-9-5`, `…:bgs-10-black`, `…:sgc-10`,
 *  `…:cgc-9-5`. Matched on the LAST segment so a parallel that merely contains
 *  a grader's letters cannot be mistaken for a grade. */
export const GRADED_SUFFIX = /:(psa|bgs|sgc|cgc)-[0-9]+(-[0-9]+)?(-black)?$/i;

interface RederiveVerdict {
  hid: string;
  userId: string;
  docId: string;
  from: string | null;
  to: string | null;
  backedBy: string | null;
  verdict: "REDERIVE" | "AGREE" | "AGREE-UNBACKED" | "UNVERIFIED" | "NO-MATCH";
  reason: string;
  matchedBy?: string;
  confidence?: number;
  /** FIELD RECOVERY: which blank axes were filled from the holding's own
   *  evidence, and out of which property. Empty when the holding was already
   *  complete. Written into `identityRederivedBy` evidence on apply. */
  recoveredFields?: Array<{ field: string; value: string | number; source: string; via: string }>;
  /** True when a human ruled on this identity — REPORT ONLY, never written. */
  userAuthored?: boolean;
  /** GATE A: how the STORED identity stands under the pricing gate's own
   *  predicate. Present on every verdict this pass reached through the
   *  `to === from` branch, so a reader can tell an AGREE that prices from one
   *  that does not without re-reading the catalog. */
  storedBacking?: string;
  /** The `source` of the stored identity's catalog row; null when it has none. */
  storedSource?: string | null;
  /** CF-AGREE-IS-A-VERDICT-ABOUT-A-ROW: the PLAYER NAMED BY THE ROW this
   *  verdict is about — which is not the holding's player whenever a card
   *  number collides. The console label prints the HOLDING's player, and for
   *  4a82faed / 25bc5079 that is exactly how `AGREE Devin Taylor` came to be
   *  printed beside Diego Tornes' row. Every verdict this pass reaches through
   *  a real catalog row carries both names now, in the JSON and on the line. */
  rowPlayer?: string | null;
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
  const backingOf = async (slug: string): Promise<{ id: string; source: string; setName: string | null; playerName: string | null } | null> => {
    const { resources } = await catalog.items
      .query({
        query: "SELECT c.id, c.source, c.setName, c.playerName FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: slug }],
      })
      .fetchAll();
    const r = resources?.[0];
    return r ? { id: r.id, source: String(r.source ?? "unknown"), setName: r.setName ?? null, playerName: r.playerName ?? null } : null;
  };

  /**
   * The CHECKLIST-BACKED rows for the same card as `slug`, at any parallel.
   *
   * CF-AGREE-IS-A-VERDICT-ABOUT-A-ROW (Drew, 2026-09-05). Read at CARD level —
   * `hiq:<sport>:<year>:<setKey>:<cardNumber>:` — because that is the scope in
   * which "is there a real transcription of this card" can be answered at all,
   * and it is the same scope `retire-self-derived-identities` already uses to
   * decide whether a self-derived row has a twin. Asking only at the exact
   * slug would answer a question we already know the answer to: the exact slug
   * IS the self-derived row.
   *
   * GRADED CHILDREN ARE EXCLUDED. They are minted from their parents by
   * materialize-graded-identities and carry the parent's provenance, so a
   * self-derived row's own `:psa-7` child would otherwise read as a second
   * opinion on itself — the same self-confirmation `sourceCorroboration`
   * excludes graded twins from the rival set for.
   *
   * The rows come back with their fields because the CALLER must decide
   * whether any of them is THIS card (GATE A2 below); this function only
   * narrows the catalog to the candidates.
   */
  const checklistTwinsOfCard = async (slug: string): Promise<Array<{ id: string; source: string; parallel: string | null; printRun: number | null; isAuto: boolean | null; playerName: string | null }>> => {
    const seg = String(slug ?? "").split(":");
    // hiq : sport : year : setKey : cardNumber : parallel : auto [ : num-N ][ : grade ]
    if (seg.length < 6 || seg[0] !== "hiq") return [];
    const cardPrefix = `${seg.slice(0, 5).join(":")}:`;
    const { resources } = await catalog.items
      .query({
        query: "SELECT c.id, c.source, c.parallel, c.printRun, c.isAuto, c.playerName FROM c WHERE STARTSWITH(c.id, @p)",
        parameters: [{ name: "@p", value: cardPrefix }],
      })
      .fetchAll();
    return (resources ?? [])
      .filter((r: any) => r?.id && r.id !== slug)
      // A graded child confirms nothing its parent does not already say.
      .filter((r: any) => !GRADED_SUFFIX.test(String(r.id)))
      .filter((r: any) => identityBackingOf(String(r.id), [{ source: r.source ?? null, id: r.id, playerName: r.playerName ?? null }]) === "checklist-backed")
      .map((r: any) => ({
        id: String(r.id),
        source: String(r.source ?? "unknown"),
        parallel: r.parallel ?? null,
        printRun: typeof r.printRun === "number" ? r.printRun : null,
        isAuto: typeof r.isAuto === "boolean" ? r.isAuto : null,
        playerName: r.playerName ?? null,
      }));
  };

  /**
   * GATE 1b, AS A FUNCTION BOTH PATHS CALL — THE DESTINATION MUST NAME THIS
   * HOLDING'S PLAYER.
   *
   * CF-AGREE-IS-A-VERDICT-ABOUT-A-ROW (Drew, 2026-09-06). #1849 widened this
   * gate from recovered set names to ALL set names, and it was still reachable
   * only on the `to !== from` path. GATE A returns AGREE for any holding whose
   * re-derived slug EQUALS its stored one and whose row is checklist-backed —
   * every branch inside it ends in `continue` — so a holding already sitting on
   * the wrong player's row never reached the player check at all. The gate that
   * exists to catch a colliding card number was unreachable for exactly the
   * population that had already been written onto the collision.
   *
   * 4a82faed / 25bc5079 are the measured case, and they are the SAME two
   * holdings #1849 fixed on the other path. Both store
   * `setName: "Bowman Chrome"` and both were ALREADY PINNED to
   *
   *     hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499
   *
   * so the re-derivation lands back on the stored slug, `to === from` is true,
   * the row IS checklist-backed (checklistcenter-2026-08-29) — and GATE A said
   * AGREE. The row names DIEGO TORNES. Run 34051875762 printed
   * `AGREE Devin Taylor …` beside it, because the label prints the HOLDING's
   * player and nothing ever printed the ROW's.
   *
   * An AGREE must be a verdict about a row that names the holding's player.
   * So the check runs on BOTH paths, from one implementation — restating it
   * would be the "four spellings of one predicate" this file's own header
   * warns about — and it keeps #1849's two steps exactly:
   *
   *   1. RE-ASK WITH THE TITLE'S PRODUCT. A contradiction is a question before
   *      it is a refusal. `titleStatedProduct` reads the holding's free text
   *      through the ONE vocabulary and returns a product only when it differs
   *      from the stored one; the matcher is re-asked with that set name and
   *      EVERY OTHER AXIS PINNED, and the candidate must clear GATE 1 (a real
   *      row) and this gate again (a player who corroborates).
   *   2. OTHERWISE PARK, naming BOTH players.
   *
   * GATE 2 is asked by the CALLER on whatever destination comes back, because
   * a substitution moves the holding to a different row and gating the
   * abandoned one would let a dropped axis through on the written one.
   *
   * Returns "ok" when the destination already names this player (the common
   * case, and no re-ask is made), "resolved" with the substituted row, or
   * "park" with the contradiction spelled out for the caller's verdict.
   */
  type PlayerCheck =
    | { kind: "ok" }
    | { kind: "resolved"; slug: string; backing: NonNullable<Awaited<ReturnType<typeof backingOf>>>; titleSetName: string; matchedBy: string; confidence: number }
    | { kind: "park"; reason: string; titleProduct: string | null };

  const corroboratePlayer = async (
    h: any,
    recovery: any,
    dest: { slug: string; backing: NonNullable<Awaited<ReturnType<typeof backingOf>>> },
  ): Promise<PlayerCheck> => {
    if (recoveredSetNameIsCorroborated(h.playerName, dest.backing.playerName)) return { kind: "ok" };

    const setNameWasRecovered = (recovery?.recovered ?? []).some((f: any) => f.field === "setName");

    // STEP 1 — does the holding's OWN TITLE name a different product?
    // Only tried when both sides actually name a player: a null on either
    // side is an absence, not a contradiction the title can resolve.
    const bothNamePlayers = !!normalizePlayerForCompare(h.playerName)
      && !!normalizePlayerForCompare(dest.backing.playerName);
    const titleProduct = bothNamePlayers ? titleStatedProduct(h) : null;

    if (titleProduct) {
      console.log(`  title says "${titleProduct.setName}" (${titleProduct.source}), stored says ${JSON.stringify(h.setName ?? h.product ?? null)} — re-asking`);
      let alt: any = null;
      try {
        alt = await canonicalize({
          sport: String(h.sport ?? "Baseball").toLowerCase(),
          year: Number(h.cardYear) || 0,
          setName: titleProduct.setName,
          // EVERY OTHER AXIS UNCHANGED. The contradiction is about the
          // product; substituting more than that would be a different card.
          cardNumber: recovery ? recovery.fields.cardNumber : String(h.cardNumber ?? ""),
          parallel: recovery ? recovery.fields.parallel : (h.parallel ?? null),
          isAuto: h.isAuto === true,
          printRun: recovery
            ? (typeof recovery.fields.printRun === "number" ? recovery.fields.printRun : null)
            : (typeof h.printRun === "number" ? h.printRun : null),
          player: h.playerName ?? null,
          source: "unknown",
        });
      } catch (e: any) {
        console.log(`  title-product re-ask threw: ${e?.message}`);
      }
      const altSlug: string | null = alt?.found && alt?.slug ? alt.slug : null;
      if (altSlug) {
        const altBacking = await backingOf(altSlug);
        if (!altBacking) {
          console.log(`  title-product candidate ${altSlug} has no catalog row — discarded`);
        } else if (!recoveredSetNameIsCorroborated(h.playerName, altBacking.playerName)) {
          console.log(`  title-product candidate ${altSlug} names ${JSON.stringify(altBacking.playerName ?? null)} — still not this player, discarded`);
        } else {
          return { kind: "resolved", slug: altSlug, backing: altBacking, titleSetName: titleProduct.setName,
            matchedBy: `${alt.matchedBy}+title-product`, confidence: alt.confidence };
        }
      } else {
        console.log(`  title-product re-ask found nothing (${alt?.matchedBy}, conf ${alt?.confidence})`);
      }
    }

    // STEP 2 — PARK, with the contradiction named on BOTH sides.
    return {
      kind: "park",
      titleProduct: titleProduct?.setName ?? null,
      reason: `${setNameWasRecovered ? "set name was recovered from listing text and the" : "the"} destination names a different player: holding ${JSON.stringify(h.playerName ?? null)} vs catalog row ${JSON.stringify(dest.backing.playerName ?? null)}`
        + (titleProduct
          ? ` — the title says "${titleProduct.setName}" and no checklist row for that product names this player either`
          : " — the title names no other product to try"),
    };
  };

  const verdicts: RederiveVerdict[] = [];

  for (const t of targets) {
    const h = t.h;
    const from = h.hobbyiqCardId ?? h.cardId ?? null;
    const label = `${String(h.playerName ?? "?").slice(0, 22).padEnd(22)} ${String(h.cardYear ?? "?")} #${String(h.cardNumber ?? "?").padEnd(8)}`;
    const push = (v: Omit<RederiveVerdict, "hid" | "userId" | "docId" | "from">) =>
      verdicts.push({ hid: t.hid, userId: t.userId, docId: t.docId, from, ...v });

    let r: any;
    let recovery: any = null;
    try {
      // CF-A-HOLDING-CARRIES-ITS-OWN-EVIDENCE (Drew, 2026-09-05) — FIELD
      // RECOVERY. The question below is built from five stored fields, and a
      // blank one makes it unanswerable about a card whose checklist row
      // exists. recoverHoldingFields fills ONLY blanks, from this holding's
      // own aspects and listing text, through the one normalizer and the one
      // title parser. See holdingFieldRecovery.service.ts for what it refuses.
      const rec = recoverHoldingFields({ holding: h });
      recovery = rec;
      if (rec.recovered.length) {
        console.log(`  recovered  ${label}  ${rec.recovered.map((f) => `${f.field}=${JSON.stringify(f.value)} <- ${f.source}`).join("; ")}`);
      }
      // ASK BOTH WAYS. The recovered question is asked first; if it does not
      // land on a real row the ORIGINAL question stands, so a recovery can
      // only ever add a match, never take one away (absent beats wrong).
      r = await canonicalize({
        sport: String(h.sport ?? "Baseball").toLowerCase(),
        year: Number(h.cardYear) || 0,
        setName: rec.fields.setName,
        cardNumber: rec.fields.cardNumber,
        parallel: rec.fields.parallel,
        isAuto: h.isAuto === true,
        // CF-REDERIVE-MUST-STATE-THE-PRINT-RUN (2026-09-05). Omitted here, the
        // matcher could not reach a :num-N ladder row and GATE 2 then refused
        // the move as a dropped-specificity claim. Production has always passed
        // it (ebayReviewQueue.service.ts:766); this pass had not.
        printRun: typeof rec.fields.printRun === "number" ? rec.fields.printRun : null,
        player: h.playerName ?? null,
        // NEVER SEED, braces. Same untrusted source the sweep uses.
        source: "unknown",
      });
      if (rec.recovered.length && !r?.found) {
        // The recovery did not reach a catalog row. Fall back to the question
        // this pass asked before recovery existed, so the report is never
        // WORSE than it was — and say so, because a discarded recovery is a
        // fact about the evidence worth reading.
        console.log(`  recovery discarded — no catalog row; re-asking as stored`);
        recovery = { ...rec, recovered: [], discarded: rec.recovered } as any;
        r = await canonicalize({
          sport: String(h.sport ?? "Baseball").toLowerCase(),
          year: Number(h.cardYear) || 0,
          setName: String(h.setName ?? h.product ?? ""),
          cardNumber: String(h.cardNumber ?? ""),
          parallel: h.parallel ?? null,
          isAuto: h.isAuto === true,
          printRun: typeof h.printRun === "number" ? h.printRun : null,
          player: h.playerName ?? null,
          source: "unknown",
        });
      }
    } catch (e: any) {
      // A holding too blank to build an identity from names the field it is
      // missing, rather than reporting an opaque throw.
      const missing = recovery?.stillMissing?.length
        ? ` — missing ${recovery.stillMissing.join(", ")} and no evidence on the holding names ${recovery.stillMissing.length > 1 ? "them" : "it"}`
        : "";
      push({ to: null, backedBy: null, verdict: "NO-MATCH", reason: `matcher threw: ${e?.message}${missing}` });
      console.log(`  THREW      ${label}  ${e?.message}${missing}`);
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
      // GATE A — AGREE IS A VERDICT ABOUT A ROW, NOT ABOUT TWO STRINGS.
      //
      // CF-AGREE-IS-A-VERDICT-ABOUT-A-ROW (Drew, 2026-09-05). This branch used
      // to `continue` on `to === from` alone, which asks only whether the
      // matcher re-derived the same SLUG — never whether anything real stands
      // behind it. Every other destination in this pass goes through GATE 1
      // ("the destination must be a REAL CHECKLIST ROW"); the stored one, the
      // single destination this pass can leave in place, was the one that
      // never did.
      //
      // What that hid, measured on prod 2026-09-05 (run 33998562094, PR
      // #1842): nine of ten withheld-holding cells reported AGREE, and SEVEN
      // of those holdings sit on a row the pricing gate refuses. Drew's two
      // 1997 Bowman's Best BBP4 Jeter Atomic Refractors (437f010d, 5979f485)
      // agree on `hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto`
      // — whose ONLY catalog row is `ebay-user-purchase`, minted from Drew's
      // own eBay import. The rederive said "already right", the gate said
      // `no-checklist-match`, and both were reading the same row. AGREE meant
      // "agrees with itself".
      //
      // So the stored identity is asked the SAME question, through the SAME
      // predicate the gate uses (identityBackingOf), and the answer splits
      // three ways rather than being assumed.
      const own = await backingOf(from as string);
      const ownBacking = identityBackingOf(
        from,
        own ? [{ source: own.source, id: own.id, playerName: own.playerName }] : [],
      );
      if (ownBacking === "checklist-backed") {
        // AND THE ROW MUST NAME THIS HOLDING'S PLAYER (Drew, 2026-09-06).
        // Checklist-backed answers "may a price rest on this row"; it does not
        // answer "is this row THIS CARD". A colliding card number makes those
        // two different questions: the checklist is RIGHT about Diego Tornes'
        // cpa-dt, and this holding is still Devin Taylor's. Without this call
        // `to === from` short-circuits GATE 1b entirely, and 4a82faed /
        // 25bc5079 printed `AGREE Devin Taylor` against Tornes' row.
        const storedCheck = await corroboratePlayer(h, recovery, { slug: from as string, backing: own! });

        if (storedCheck.kind === "resolved") {
          // The title's product named a real checklist row for THIS player.
          // It is a re-point like any other, so it is reported as REDERIVE and
          // rides this pass's existing apply path — but it must clear the gates
          // below it first, which is why the remaining ladder is asked here
          // rather than assumed: GATE 2 (no dropped axis), GATE 3 (confidence),
          // GATE 4 (a human's ruling outranks it).
          const claimForGate2 = recovery ? { ...h, ...recovery.fields } : h;
          const droppedOnResolved = droppedSpecificityAxes(claimForGate2, storedCheck.slug);
          if (droppedOnResolved.length) {
            push({ to: storedCheck.slug, backedBy: storedCheck.backing.source, verdict: "UNVERIFIED",
              reason: `the stored row names ${JSON.stringify(own?.playerName ?? null)} and the title's product reaches ${storedCheck.slug}, but the holding claims ${droppedOnResolved.map((a) => `${a}=${h[a]}`).join(", ")} and it does not carry it`,
              matchedBy: storedCheck.matchedBy, confidence: storedCheck.confidence,
              storedBacking: ownBacking, storedSource: own?.source ?? null,
              rowPlayer: own?.playerName ?? null });
            console.log(`  UNVERIFIED ${label}\n             ${from}   (row names ${JSON.stringify(own?.playerName ?? null)})\n          -> ${storedCheck.slug}   NOT WRITTEN: holding claims ${droppedOnResolved.map((a) => `${a}=${h[a]}`).join(", ")}`);
            continue;
          }
          if (Number(storedCheck.confidence) < MIN_CONFIDENCE) {
            push({ to: storedCheck.slug, backedBy: storedCheck.backing.source, verdict: "UNVERIFIED",
              reason: `the stored row names ${JSON.stringify(own?.playerName ?? null)} and the title's product reaches ${storedCheck.slug}, but confidence ${storedCheck.confidence} is below ${MIN_CONFIDENCE}`,
              matchedBy: storedCheck.matchedBy, confidence: storedCheck.confidence,
              storedBacking: ownBacking, storedSource: own?.source ?? null,
              rowPlayer: own?.playerName ?? null });
            console.log(`  UNVERIFIED ${label}\n             ${from}   (row names ${JSON.stringify(own?.playerName ?? null)})\n          -> ${storedCheck.slug}   NOT WRITTEN: conf ${storedCheck.confidence} < ${MIN_CONFIDENCE}`);
            continue;
          }
          if (recovery?.userAuthored) {
            // GATE 4 — a human's ruling is report-only forever, and a player
            // contradiction is exactly the new evidence that would justify
            // revisiting it. Reported in full; the decision stays with them.
            push({ to: storedCheck.slug, backedBy: storedCheck.backing.source, verdict: "UNVERIFIED",
              reason: `a human ruled this identity (${recovery.userAuthoredBy}) — report only; the stored row names ${JSON.stringify(own?.playerName ?? null)} and the title's product reaches ${storedCheck.slug} (${JSON.stringify(storedCheck.backing.playerName ?? null)})`,
              matchedBy: storedCheck.matchedBy, confidence: storedCheck.confidence, userAuthored: true,
              storedBacking: ownBacking, storedSource: own?.source ?? null,
              rowPlayer: own?.playerName ?? null });
            console.log(`  UNVERIFIED ${label}\n             ${from}   (row names ${JSON.stringify(own?.playerName ?? null)})\n          -> ${storedCheck.slug}   NOT WRITTEN: ruled by ${recovery.userAuthoredBy}`);
            continue;
          }
          push({ to: storedCheck.slug, backedBy: storedCheck.backing.source, verdict: "REDERIVE",
            reason: `the stored identity is checklist-backed by ${own?.source ?? "unknown"} but names ${JSON.stringify(own?.playerName ?? null)}, not this holding's player — the title's product "${storedCheck.titleSetName}" reaches ${storedCheck.slug}, checklist-backed by ${storedCheck.backing.source} and naming ${JSON.stringify(storedCheck.backing.playerName ?? null)}`,
            matchedBy: storedCheck.matchedBy, confidence: storedCheck.confidence,
            recoveredFields: (recovery?.recovered ?? []).map((f: any) => ({ field: f.field, value: f.value, source: f.source, via: f.via })),
            userAuthored: false,
            storedBacking: ownBacking, storedSource: own?.source ?? null,
            rowPlayer: storedCheck.backing.playerName ?? null });
          console.log(`  RESOLVED   ${label}\n             ${from}   (${JSON.stringify(own?.playerName ?? null)} — not this player)\n          -> ${storedCheck.slug}   ${JSON.stringify(storedCheck.backing.playerName ?? null)} via the title's product "${storedCheck.titleSetName}"`);
          continue;
        }

        if (storedCheck.kind === "park") {
          push({ to: from, backedBy: own?.source ?? null, verdict: "UNVERIFIED",
            reason: storedCheck.reason,
            matchedBy: r.matchedBy, confidence: r.confidence,
            recoveredFields: (recovery?.recovered ?? []).map((f: any) => ({ field: f.field, value: f.value, source: f.source, via: f.via })),
            userAuthored: !!recovery?.userAuthored,
            storedBacking: ownBacking, storedSource: own?.source ?? null,
            rowPlayer: own?.playerName ?? null });
          console.log(`  UNVERIFIED ${label}\n             ${from}   NOT AN AGREE: the row names ${JSON.stringify(own?.playerName ?? null)}, the holding says ${JSON.stringify(h.playerName ?? null)}`);
          continue;
        }

        push({ to, backedBy: own?.source ?? null, verdict: "AGREE",
          reason: `re-derivation agrees with the stored identity, and it is checklist-backed by ${own?.source ?? "unknown"}`,
          matchedBy: r.matchedBy, confidence: r.confidence,
          storedBacking: ownBacking, storedSource: own?.source ?? null,
          rowPlayer: own?.playerName ?? null });
        console.log(`  AGREE      ${label}  ${from}   backed by ${own?.source ?? "unknown"}   row names ${JSON.stringify(own?.playerName ?? null)}`);
        continue;
      }

      // The stored row is NOT something a price may rest on. Is there a real
      // transcription of this same card the holding should point at instead?
      //
      // GATE A2 — A TWIN OF THE CARD IS NOT AUTOMATICALLY THIS CARD.
      // `droppedSpecificityAxes` is the gate the REDERIVE path already uses to
      // refuse a move that would fuse two pools, and a re-point out of a
      // self-derived row is a move like any other — it is asked here for the
      // same reason and with the same claim (recovered fields included).
      // CF-A-ROW-THAT-EXISTS-IS-NOT-THE-RIGHT-ROW.
      const claim = recovery ? { ...h, ...recovery.fields } : h;
      const twins = (await checklistTwinsOfCard(from as string))
        .filter((t) => droppedSpecificityAxes(claim, t.id).length === 0)
        // A twin naming a DIFFERENT player is a different card, whatever else
        // matches. Compared only when both sides carry a name — a null is not
        // a witness (the same rule GATE 1b states).
        .filter((t) => !(normalizePlayerForCompare(h.playerName) && normalizePlayerForCompare(t.playerName))
          || recoveredSetNameIsCorroborated(h.playerName, t.playerName));

      // GATE A4 — A HUMAN'S RULING OUTRANKS THIS INFERENCE TOO. Asked BEFORE
      // the re-point rather than after, because a ruled holding must reach the
      // report unchanged whether or not a twin exists: the standing GREAT
      // REMATCH rule is that ruled rows are report-only FOREVER, and a new
      // gate that could move one would be this pass acquiring, by accident,
      // the one power #1811 built a gate to deny it.
      if (recovery?.userAuthored) {
        push({ to, backedBy: own?.source ?? null, verdict: "AGREE-UNBACKED",
          reason: `stored identity is ${ownBacking} (${own?.source ?? "no catalog row"}) and a human ruled it (${recovery.userAuthoredBy}) — report only`,
          matchedBy: r.matchedBy, confidence: r.confidence, userAuthored: true,
          storedBacking: ownBacking, storedSource: own?.source ?? null,
          rowPlayer: own?.playerName ?? null });
        console.log(`  AGREE-UNBACKED ${label}  ${from}   ${ownBacking} — ruled by ${recovery.userAuthoredBy}, never overwritten by this pass`);
        continue;
      }

      if (twins.length === 1) {
        // EXACTLY ONE surviving twin is a re-point, and it is reported as
        // REDERIVE so it rides this pass's existing apply path, its etag
        // write and its read-back reconciliation rather than a parallel one.
        //
        // AMBIGUITY IS A REFUSAL. Several surviving twins means the catalog
        // holds more than one real transcription this holding could be, and
        // picking one by sort order is how a confident wrong price is made
        // (the `ambiguous` refusal in catalogIdentityResolver exists for the
        // identical reason). It falls through to AGREE-UNBACKED below.
        //
        // GATE 3 (the confidence floor) IS DELIBERATELY NOT ASKED HERE, and
        // that is not an omission. `r.confidence` scores the MATCHER's guess
        // at a slug from free text; this destination was not guessed. It is
        // the one row in the catalog that (i) transcribes this exact card from
        // a checklist, (ii) survives GATE 2 against the holding's own claim,
        // and (iii) is unique in doing so. Reusing a text-match score to gate
        // a structural fact would refuse the correct destination whenever the
        // holding's PROSE is messy — which is precisely the population this
        // whole pass exists for.
        const twin = twins[0];
        push({ to: twin.id, backedBy: twin.source, verdict: "REDERIVE",
          reason: `stored identity is ${ownBacking} (${own?.source ?? "no catalog row"}) and a checklist twin of the same card exists — checklist-backed by ${twin.source}`,
          matchedBy: r.matchedBy, confidence: r.confidence,
          recoveredFields: (recovery?.recovered ?? []).map((f: any) => ({ field: f.field, value: f.value, source: f.source, via: f.via })),
          userAuthored: !!recovery?.userAuthored,
          storedBacking: ownBacking, storedSource: own?.source ?? null,
          rowPlayer: twin.playerName ?? null });
        console.log(`  REDERIVE   ${label}\n             ${from}   (${ownBacking}: ${own?.source ?? "no catalog row"})\n          -> ${twin.id}   checklist twin, backed by ${twin.source}, names ${JSON.stringify(twin.playerName ?? null)}`);
        continue;
      }

      // No usable twin. The holding's identity is as good as this pass can
      // make it and STILL unpriceable — which is an ACQUISITION ITEM, not
      // progress. It is named rather than folded into AGREE precisely because
      // the gate at run 33998562094 counted nine of these as "done".
      push({ to, backedBy: own?.source ?? null, verdict: "AGREE-UNBACKED",
        reason: twins.length > 1
          ? `stored identity is ${ownBacking} (${own?.source ?? "no catalog row"}) and ${twins.length} checklist twins of this card survive the gates — ambiguous, refusing to pick one`
          : `stored identity is ${ownBacking} (${own?.source ?? "no catalog row"}); no checklist row transcribes this card — acquire the checklist`,
        matchedBy: r.matchedBy, confidence: r.confidence,
        storedBacking: ownBacking, storedSource: own?.source ?? null,
        rowPlayer: own?.playerName ?? null });
      console.log(`  AGREE-UNBACKED ${label}  ${from}   ${ownBacking} (${own?.source ?? "no catalog row"}, names ${JSON.stringify(own?.playerName ?? null)})${twins.length > 1 ? ` — ${twins.length} ambiguous twins` : " — no checklist twin: ACQUIRE"}`);
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

    // GATE 1b — THE DESTINATION MUST NAME THIS HOLDING'S PLAYER.
    //
    // WIDENED FROM RECOVERED SET NAMES TO ALL SET NAMES (Drew, 2026-09-06,
    // #1849). The gate was scoped to RECOVERED set names on the stated ground
    // that "a STORED set name is the holding's own claim about its product,
    // and this pass has never been in the business of second-guessing it".
    // CF-A-STORED-SET-NAME-CAN-BE-WRONG-TOO retires that scope: the user's
    // stated set name does not outrank the checklist's player.
    //
    // 277b05a3 is why the gate exists at all — a RECOVERED set name, read by
    // inferSetKeyFromTitle as "Fleer Metal" (setKey `fleer`), landing on
    // `hiq:baseball:1997:fleer:8:base:no-auto`, a real baseballcardpedia row
    // at exact/0.98 that is TONY GWYNN's card and not Cal Ripken's. Every
    // other gate passed.
    //
    // 4a82faed / 25bc5079 are why it widens. Both STORE
    // `setName: "Bowman Chrome"`, so `recoveredFields` is empty and the gate
    // was skipped; both resolve at exact/0.98 onto
    //
    //     hiq:baseball:2025:bowman-chrome:cpa-dt:refractor:auto:num-499
    //
    // whose playerName is DIEGO TORNES, while the holdings say DEVIN TAYLOR.
    // CPA-DT is a colliding card number across three products and three
    // players (project_beckett_initials_card_numbers_collide) —
    //
    //     2025 Bowman Chrome          cpa-dt -> Diego Tornes
    //     2025 Bowman Draft           cpa-dt -> Devin Taylor
    //     2025 Topps Chrome Platinum  cpa-dt -> Drew Thorpe
    //
    // — and the checklist is right about all three. What is wrong is the
    // stored set name: the seller's eBay `Set` aspect dropped the word DRAFT
    // that the holdings' OWN TITLE carries ("2025 Bowman Chrome DRAFT 1st
    // Refractor Auto /499 Oakland Athletics"). A fold never changes the player
    // (#1838), and neither does a re-derivation.
    //
    // TWO STEPS, IN THIS ORDER (Drew: "if known, we should be able to figure
    // it out"). A contradiction is not automatically a dead end — when the
    // title's own product word plus the title's player name a real checklist
    // row, that row is the answer and parking would throw it away:
    //
    //   1. RE-ASK WITH THE TITLE'S PRODUCT. `titleStatedProduct` reads the
    //      holding's free text through the ONE vocabulary
    //      (inferSetKeyFromTitle) and returns a product only when it differs
    //      from the stored one. The matcher is re-asked with that set name and
    //      every other axis of the claim UNCHANGED — same cardNumber, same
    //      parallel, same printRun, same isAuto — because the disagreement is
    //      about the PRODUCT and nothing else. The result must then clear the
    //      whole ladder again: a real catalog row (GATE 1), a player who
    //      CORROBORATES the holding's (this gate, again — a second wrong row
    //      is not better than the first), and no dropped specificity axis
    //      (GATE 2, re-asked below on the substituted destination).
    //
    //   2. OTHERWISE PARK. No title product, no row for it, or a row that
    //      contradicts the player too: the holding is left identityUnverified
    //      with the contradiction named, and prices nothing. Absent beats
    //      wrong — the same rule the recovery fallback obeys.
    //
    // A destination with NO player name is not agreement either (memory:
    // "count by source, not row count" — a null is not a witness), and it is
    // not a contradiction that step 1 can repair: nothing was contradicted, so
    // there is nothing for the title's product to correct. It parks.
    // GATE 1b is asked HERE by calling the shared corroboration above — the
    // same call GATE A now makes. Both paths, one implementation.
    let destination = to;
    let destinationBacking = backing;
    const check = await corroboratePlayer(h, recovery, { slug: to, backing });
    if (check.kind === "park") {
      push({ to, backedBy: backing.source, verdict: "UNVERIFIED",
        reason: check.reason,
        matchedBy: r.matchedBy, confidence: r.confidence,
        recoveredFields: (recovery?.recovered ?? []).map((f: any) =>
          ({ field: f.field, value: f.value, source: f.source, via: f.via })),
        userAuthored: !!recovery?.userAuthored,
        rowPlayer: backing.playerName ?? null });
      console.log(`  UNVERIFIED ${label}\n             ${from}\n          -> ${to}   NOT WRITTEN: player mismatch (holding ${JSON.stringify(h.playerName ?? null)} vs row ${JSON.stringify(backing.playerName ?? null)})`);
      continue;
    }
    if (check.kind === "resolved") {
      destination = check.slug;
      destinationBacking = check.backing;
      // The matcher's own confidence for the destination we will actually
      // write is the one the report must carry.
      r = { ...r, matchedBy: check.matchedBy, confidence: check.confidence };
      console.log(`  RESOLVED   ${label}\n             ${to}   (${JSON.stringify(backing.playerName ?? null)} — not this player)\n          -> ${destination}   ${JSON.stringify(destinationBacking.playerName ?? null)} via the title's product "${check.titleSetName}"`);
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
    // The gate is asked about the RECOVERED claim, because that is the claim
    // the match was made on. Asked about the stored fields it would read a
    // recovered "Diamond Dominance" as a dropped axis on a destination that
    // spells it — refusing the very move recovery exists to enable. The gate
    // itself is unchanged; only the claim it is handed is now complete.
    //
    // AND IT IS ASKED ABOUT THE DESTINATION THIS PASS WILL ACTUALLY WRITE.
    // GATE 1b may have substituted the title's product for a stored set name
    // that contradicted the checklist's player, in which case `to` is the row
    // this holding is moving AWAY from. Gating the abandoned slug would let a
    // dropped axis through on the one being written.
    const claimed = droppedSpecificityAxes(
      recovery ? { ...h, ...recovery.fields } : h, destination);
    if (claimed.length) {
      push({ to: destination, backedBy: destinationBacking.source, verdict: "UNVERIFIED",
        reason: `no ladder source — the holding claims ${claimed.map((a) => `${a}=${h[a]}`).join(", ")} and the destination does not carry it`,
        matchedBy: r.matchedBy, confidence: r.confidence,
        rowPlayer: destinationBacking.playerName ?? null });
      console.log(`  UNVERIFIED ${label}\n             ${from}\n          -> ${destination}   NOT WRITTEN: holding claims ${claimed.map((a) => `${a}=${h[a]}`).join(", ")}, destination does not carry it`);
      continue;
    }

    // GATE 3 — the same confidence floor the sweep pins at, for the same
    // reason: below it a slug is a suggestion, and a confident wrong price
    // reads as correct.
    if (Number(r.confidence) < MIN_CONFIDENCE) {
      push({ to: destination, backedBy: destinationBacking.source, verdict: "UNVERIFIED",
        reason: `confidence ${r.confidence} below ${MIN_CONFIDENCE}`,
        matchedBy: r.matchedBy, confidence: r.confidence,
        rowPlayer: destinationBacking.playerName ?? null });
      console.log(`  UNVERIFIED ${label}\n             ${from}\n          -> ${destination}   NOT WRITTEN: conf ${r.confidence} < ${MIN_CONFIDENCE}`);
      continue;
    }

    // GATE 4 — A HUMAN'S RULING OUTRANKS EVERY INFERENCE IN THIS PASS.
    // Ruled and user-edited rows are report-only forever (the GREAT REMATCH
    // program's standing rule). Field recovery makes this gate matter more,
    // not less: recovery is exactly the kind of new evidence that would
    // justify revisiting a ruling, so the finding is REPORTED in full — with
    // its provenance — and the decision is left to the person who made it.
    const recoveredFields = (recovery?.recovered ?? []).map((f: any) =>
      ({ field: f.field, value: f.value, source: f.source, via: f.via }));
    if (recovery?.userAuthored) {
      push({ to: destination, backedBy: destinationBacking.source, verdict: "UNVERIFIED",
        reason: `a human ruled this identity (${recovery.userAuthoredBy}) — report only; field recovery proposes ${destination}`,
        matchedBy: r.matchedBy, confidence: r.confidence, recoveredFields, userAuthored: true,
        rowPlayer: destinationBacking.playerName ?? null });
      console.log(`  UNVERIFIED ${label}\n             ${from}\n          -> ${destination}   NOT WRITTEN: ruled by ${recovery.userAuthoredBy} — a human's identity is never overwritten by this pass`);
      continue;
    }

    push({ to: destination, backedBy: destinationBacking.source, verdict: "REDERIVE",
      reason: `checklist-backed by ${destinationBacking.source}`, matchedBy: r.matchedBy, confidence: r.confidence,
      recoveredFields, userAuthored: false,
      rowPlayer: destinationBacking.playerName ?? null });
    console.log(`  REDERIVE   ${label}\n             ${from}\n          -> ${destination}   (${r.matchedBy}, conf ${r.confidence})  backed by ${destinationBacking.source}, names ${JSON.stringify(destinationBacking.playerName ?? null)}${destinationBacking.setName ? ` — "${destinationBacking.setName}"` : ""}`);
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
      // FIELD RECOVERY provenance. A later pass must be able to tell an
      // identity derived from the holding's own listing evidence from one
      // derived off its stored fields, and see WHICH fact came from WHERE.
      // Absent when nothing was recovered — the field says something happened.
      if (v.recoveredFields?.length) {
        h.identityRecoveredFields = v.recoveredFields;
      }
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

// ── MODE=rule ───────────────────────────────────────────────────────────────

interface RuleVerdict {
  hid: string;
  userId: string;
  docId: string;
  from: string | null;
  to: string;
  verdict: "RULE" | "AGREE" | "REFUSED";
  reason: string;
  backedBy?: string | null;
  /** Identity fields the ruled row dictates, each carrying the value it
   *  displaces. In MODE=rule the row WINS, so this includes overwrites. */
  fills?: Array<{ field: string; value: string | number; from: string; previous?: unknown }>;
  /** Fields the holding states that the ROW does not, so they stand. A null
   *  on a checklist row means unknown, and unknown never overwrites. */
  rowSilentOn?: Array<{ field: string; value: unknown }>;
  /** The ruling this supersedes, when there was one. */
  supersedes?: string | null;
}

/**
 * Apply named rulings. The slug comes from the operator, not the matcher; the
 * catalog is consulted only to prove the destination is real and adjudicable.
 */
async function rule(
  { docs, container, catalog }: { docs: any[]; container: any; catalog: any },
): Promise<void> {
  let pairs: RulingPair[];
  try {
    pairs = parseRulingPairs(HOLDING_IDS);
  } catch (e: any) {
    console.error(`FATAL: ${e?.message}`);
    process.exit(2);
  }

  console.log(`[scope]  ${pairs.length} ruling(s): ${pairs.map((p) => `${p.hid} -> ${p.slug}`).join("; ")}`);
  console.log(`[ruling] ${RULING_ID}`);
  console.log(`[mode]   rule — ${APPLY ? "APPLY, WILL WRITE" : "report only"}\n`);

  if (!docs.length) {
    console.error("FATAL: zero portfolio docs returned. The pass proved nothing.");
    process.exit(2);
  }

  // Locate every ruled holding FIRST, and refuse the whole run if one is
  // missing. A ruling list is a set of decisions about specific cards; running
  // three of four silently would leave the operator believing all four moved.
  const located = new Map<string, { docId: string; userId: string; hid: string; h: any; slug: string }>();
  let scanned = 0;
  for (const doc of docs) {
    for (const [hid, h] of Object.entries<any>(doc.holdings || {})) {
      if (!h) continue;
      scanned++;
      for (const p of pairs) {
        if (hid !== p.hid && !hid.startsWith(p.hid)) continue;
        if (located.has(p.hid)) {
          console.error(`FATAL: ruling id ${p.hid} matches more than one holding (${located.get(p.hid)!.hid}, ${hid}).\n`
            + "An id prefix that names two cards cannot rule either — pass the full holding id.");
          process.exit(2);
        }
        located.set(p.hid, { docId: doc.id, userId: doc.userId, hid, h, slug: p.slug });
      }
    }
  }
  if (!scanned) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The pass proved nothing.");
    process.exit(2);
  }
  const missing = pairs.filter((p) => !located.has(p.hid));
  if (missing.length) {
    console.error(`FATAL: ${missing.length} ruled holding(s) matched NOTHING out of ${scanned} scanned: `
      + `${missing.map((m) => m.hid).join(", ")}.\n`
      + "A ruling that names no card is a typo, not an empty result — refusing the whole list so a\n"
      + "partial run cannot read as a complete one.");
    process.exit(2);
  }
  console.log(`holdings scanned: ${scanned}   ruled: ${located.size}\n`);

  const verdicts: RuleVerdict[] = [];

  for (const p of pairs) {
    const t = located.get(p.hid)!;
    const h = t.h;
    const from = h.hobbyiqCardId ?? h.cardId ?? null;
    const label = `${String(h.playerName ?? "?").slice(0, 22).padEnd(22)} ${String(h.cardYear ?? "?")} #${String(h.cardNumber ?? "?").padEnd(8)}`;
    const push = (v: Omit<RuleVerdict, "hid" | "userId" | "docId" | "from" | "to">) =>
      verdicts.push({ hid: t.hid, userId: t.userId, docId: t.docId, from, to: t.slug, ...v });

    // GATE R1 — THE ROW MUST EXIST. Read by id, the way the catalog is keyed,
    // so a near neighbour cannot satisfy it. A ruling onto a slug no row
    // carries would mint an identity from a typo.
    const { resources: rows } = await catalog.items
      .query({
        query: "SELECT c.id, c.source, c.setName, c.cardNumber, c.parallel, c.printRun, c.playerName FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: t.slug }],
      })
      .fetchAll();
    const row = rows?.[0];
    if (!row) {
      push({ verdict: "REFUSED", backedBy: null,
        reason: `no catalog row carries ${t.slug} — a ruling never mints a card` });
      console.log(`  REFUSED    ${label}  -> ${t.slug}\n             no catalog row carries that id`);
      continue;
    }

    // GATE R2 — THE ROW MUST BE CHECKLIST-BACKED. The same authority test the
    // catalog uses to decide which row may adjudicate a card. Ruling onto a
    // self-seeded or sales-derived row would pin a user's card to a row built
    // from our own sales — the self-comp loop the pricing doctrine breaks.
    const source = String(row.source ?? "unknown");
    if (!canAdjudicate(source)) {
      push({ verdict: "REFUSED", backedBy: source,
        reason: `${t.slug} is backed by \`${source}\` (${catalogAuthorityOf(source)}), not a checklist — a ruling may only name a checklist-backed card` });
      console.log(`  REFUSED    ${label}  -> ${t.slug}\n             backed by \`${source}\` (${catalogAuthorityOf(source)}), not a checklist`);
      continue;
    }

    const priorRuling = String(h.identityResolvedBy ?? "").trim() || null;
    const fills = fieldsFromRuledRow(h, row);
    const rowSilentOn = (["setName", "cardNumber", "parallel", "printRun"] as const)
      .filter((f) => !fills.some((x) => x.field === f))
      .filter((f) => h[f] !== null && h[f] !== undefined && String(h[f]).trim() !== "")
      .map((f) => ({ field: f, value: h[f] }));

    if (from === t.slug) {
      push({ verdict: "AGREE", backedBy: source, fills, rowSilentOn,
        supersedes: priorRuling,
        reason: "the holding already carries the ruled identity" });
      console.log(`  AGREE      ${label}  ${t.slug}`);
      continue;
    }

    push({ verdict: "RULE", backedBy: source, fills, rowSilentOn,
      supersedes: priorRuling && priorRuling !== RULING_ID ? priorRuling : null,
      reason: `ruled onto a ${source} row` });
    console.log(`  RULE       ${label}\n             ${from}\n          -> ${t.slug}   backed by ${source}${row.setName ? ` — "${row.setName}"` : ""}`);
    if (priorRuling && priorRuling !== RULING_ID) {
      console.log(`             supersedes ${priorRuling}`);
    }
    // Print SETS and OVERWRITES apart. An overwrite is the line an operator
    // must actually read before approving an apply — it is the one that
    // discards something — so it never hides inside a list of fills.
    const sets = fills.filter((f) => f.previous === null || f.previous === undefined || String(f.previous).trim() === "");
    const overwrites = fills.filter((f) => !sets.includes(f));
    if (sets.length) {
      console.log(`             sets blank: ${sets.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(", ")}`);
    }
    for (const f of overwrites) {
      console.log(`             OVERWRITES ${f.field}: ${JSON.stringify(f.previous)} -> ${JSON.stringify(f.value)}   (previous kept in identityRuling.previousFields)`);
    }
    if (rowSilentOn.length) {
      console.log(`             row silent on, holding stands: ${rowSilentOn.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(", ")}`);
    }
  }

  const counts = verdicts.reduce<Record<string, number>>((a, v) => { a[v.verdict] = (a[v.verdict] ?? 0) + 1; return a; }, {});
  console.log(`\nSUMMARY  ${JSON.stringify(counts)}`);
  console.log(JSON.stringify({ event: "holding_ruling_report", mode: "rule", ruling: RULING_ID, apply: APPLY, verdicts }, null, 1));

  const writable = verdicts.filter((v) => v.verdict === "RULE");
  if (!APPLY) {
    console.log(`\nReport only — nothing written.${writable.length ? ` Re-run with BACKFILL_APPLY=true to apply the ${writable.length} above.` : ""}`);
    // A REFUSED ruling is an operator error, and a report that ends 0 would
    // let a dispatch of four rulings where one was a typo read as success.
    if (verdicts.some((v) => v.verdict === "REFUSED")) process.exit(6);
    return;
  }
  if (!writable.length) {
    console.log("\nAPPLY requested, but nothing qualified. Nothing written.");
    if (verdicts.some((v) => v.verdict === "REFUSED")) process.exit(6);
    return;
  }

  // ---- APPLY ---------------------------------------------------------------
  console.log(`\n=== APPLY: ${writable.length} ruling(s) ===`);
  let wrote = 0, skipped = 0, conflicts = 0, failed = 0;
  const byDoc = new Map<string, RuleVerdict[]>();
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
      // Re-assert against the FRESH doc: the identity we are replacing must
      // still be the one the report described. A ruling is a decision about a
      // specific state, and if something moved the card in between, the person
      // should see the new state before ruling on it.
      const cur = h.hobbyiqCardId ?? h.cardId ?? null;
      if (cur !== v.from) { skipped++; console.log(`  SKIP       ${v.hid}  identity changed under us (${cur})`); continue; }

      h.hobbyiqCardId = v.to;
      h.cardId = v.to;
      h.catalogMatchSlug = v.to;
      h.catalogMatchedBy = "ruling";
      h.catalogMatchConfidence = 1;
      h.lastUpdated = now;

      // Fill ONLY the blanks the ruled row dictates. A field the user stated
      // is left exactly as it is — the ruling names the card, not the typing.
      // CAPTURE BEFORE WRITING. `previousFields` is what makes an overwrite
      // acceptable at all: the ruling wins, and every value it displaced is
      // recorded on the document, so nothing the user typed is destroyed and
      // the overwrite is reversible from the holding itself.
      const previousFields: Record<string, unknown> = {};
      for (const f of v.fills ?? []) previousFields[f.field] = (h as any)[f.field] ?? null;
      for (const f of v.fills ?? []) (h as any)[f.field] = f.value;

      // THE AUDIT TRAIL. A ruled identity says it was ruled, by whom, what it
      // superseded, and WHAT IT DISPLACED — a later pass must be able to tell
      // this from a derived identity, and MODE=rederive's GATE 4 reads exactly
      // this field to know it must stand down.
      h.identityResolvedBy = RULING_ID;
      h.identityResolvedAt = now;
      h.identityVerified = true;
      h.identityVerifiedAt = now;
      h.identityVerifiedBy = { source: "checklist-backed-identity", candidateId: v.to, via: RULING_ID, verifiedAt: now };
      h.identityRederivedFrom = v.from;
      h.identityRederivedAt = now;
      h.identityRederivedBy = `recheck-holding-identity MODE=rule ${RULING_ID}`;
      h.identityRederivedBackedBy = v.backedBy ?? null;
      h.identityRuling = {
        ruling: RULING_ID,
        at: now,
        from: v.from,
        to: v.to,
        backedBy: v.backedBy ?? null,
        supersedes: v.supersedes ?? null,
        fields: (v.fills ?? []).map((f) => ({ field: f.field, value: f.value })),
        // Drew, 2026-09-05: "with the previous values recorded in the ruling
        // stamp so nothing is lost".
        previousFields,
      };
      if (v.fills?.length) h.identityRuledFields = v.fills;
      if (v.supersedes) h.identityRulingSupersedes = v.supersedes;

      // The stored price was computed for the OLD identity and is not ours.
      h.predictedPrice = null;
      h.predictedPriceUpdatedAt = null;
      h.fairMarketValue = null;
      if (h.needsReview === true && String(h.reviewReason ?? "").startsWith(UNIDENTIFIED_REVIEW_PREFIX)) {
        h.needsReview = false; h.reviewReason = null;
      }

      mutated++;
      console.log(JSON.stringify({
        event: "holding_identity_ruled", source: "recheck-holding-identity/rule",
        ruling: RULING_ID, userId, holdingId: v.hid, from: v.from, to: v.to,
        backedBy: v.backedBy, fills: v.fills ?? [], supersedes: v.supersedes ?? null,
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

  // VERIFY BY READ. feedback_green_workflow_is_not_data_flow — a green run is
  // not a written row. Re-read every document and assert both the identity AND
  // the filled fields landed.
  if (wrote > 0) {
    console.log(`\n=== RECONCILIATION: re-reading ${byDoc.size} document(s) ===`);
    let confirmed = 0, wrong = 0;
    for (const [docId, list] of byDoc) {
      const read = await container.item(docId, list[0].userId).read();
      for (const v of list) {
        const h = (read.resource as any)?.holdings?.[v.hid];
        const got = h?.hobbyiqCardId ?? h?.cardId ?? null;
        const badFill = (v.fills ?? []).find((f) => String(h?.[f.field] ?? "") !== String(f.value));
        if (got === v.to && h?.identityResolvedBy === RULING_ID && !badFill) {
          confirmed++; console.log(`  OK         ${v.hid}  ${got}  (${RULING_ID})`);
        } else {
          wrong++;
          console.log(`  MISMATCH   ${v.hid}  expected ${v.to} ruled ${RULING_ID}`
            + `, stored ${got} ruled ${h?.identityResolvedBy ?? null}`
            + (badFill ? `, field ${badFill.field} expected ${JSON.stringify(badFill.value)} stored ${JSON.stringify(h?.[badFill.field] ?? null)}` : ""));
        }
      }
    }
    console.log(`\nVERIFIED   confirmed=${confirmed}  mismatched=${wrong}`);
    if (wrong) process.exit(5);
  }
  if (conflicts || failed) process.exit(4);
  if (verdicts.some((v) => v.verdict === "REFUSED")) process.exit(6);
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
