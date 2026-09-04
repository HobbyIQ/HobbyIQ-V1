// CF-CARD-CATALOG (Drew, 2026-07-28).
//
// The authoritative identity source. Every real card in existence
// gets ONE canonical entry in `card_catalog` keyed by the hobbyiqCardId
// slug. Comps reference a catalog entry; comps that don't get flagged
// as "catalog-missing" so the pool can never fork on unknown identities.
//
// Why:
//   - Slug fragmentation ("True Blue" vs "Blue Refractor" vs "Blue")
//     goes away when the catalog is the source of truth — every ingest
//     resolves to the same catalog entry regardless of title spelling.
//   - Vendor cross-reference (CH cardId ⇄ CS UUID ⇄ eBay item ID) lives
//     on the catalog entry, not scattered across comp rows.
//   - Reference image + phash lives here for the image-verify step.
//   - "99.9% catalog-matched" is a metric Drew can call out — it's the
//     substrate for the whole trust story.
//
// Container: `card_catalog`, partition **/cardId**.
//
// CORRECTION (2026-08-12): this comment previously said "partition /sport
// (small cardinality)". It is not. Verified against the live container:
// partitionKey.paths = ["/cardId"]. The wrong value was trusted and copied
// into other services, where it justified treating catalog reads as cheap
// single-partition lookups — they are cross-partition fan-outs unless the
// query pins cardId. Check the container, not this file, before relying on it.
//
// Doc id = hobbyiqCardId slug. Same slug is same catalog entry —
// upserts are deterministic + no dup risk.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeHobbyIqCardId, parseHobbyIqCardId } from "./hobbyIqCardId.service.js";
import { authorityRank, catalogAuthorityOf } from "../catalog/catalogAuthority.service.js";
import { buildSearchText, buildSearchTokens } from "./searchIndexing.service.js";
import { canonicalCardName } from "../catalog/canonicalCardName.js";

export interface CardCatalogEntry {
  id: string;                        // hobbyiqCardId slug (also the doc id)
  // PARTITION KEY. card_catalog partitions on /cardId — the comment here used
  // to say `sport`, and rows written without cardId went to the undefined
  // partition where point reads cannot reach them. Always equals `id` for
  // canonical rows. See CF-CATALOG-CARDID-PARTITION-KEY below.
  cardId: string;
  hobbyiqCardId: string;             // same slug; what downstream readers expect
  sport: string;
  year: number;
  setKey: string;                    // normalized set slug
  cardNumber: string;
  parallel: string;                  // canonical human form ("Blue Refractor")
  parallelSlug: string;              // slug form ("blue-refractor")
  isAuto: boolean;
  // SERIAL-ONLY TRUTH: a number stamped on the card. Null whenever the source
  // did not state one for THIS card. Never filled from a set-production figure
  // -- see `rarity`. CF-A-PRINT-RUN-IS-A-FUNCTION-OF-(RANGE, PARALLEL).
  printRun: number | null;
  /**
   * CF-RARITY-IS-NOT-A-PRINT-RUN (Drew ruling, 2026-08-30).
   *
   * A set-level production or scarcity statement in the SOURCE'S OWN WORDS --
   * "approximately 30,000 sets produced" (1987 Topps Tiffany), "1:12/packs"
   * (1997 Finest), "inserted 1:24 packs" (1996 Metal Universe). #1571 §5 ruled
   * these must map to a rarity field and never be coerced into printRun; until
   * this field existed they were dropped on the floor.
   *
   * DESCRIPTIVE ONLY. No valuation path reads it. It is not a multiplier, not a
   * synthetic print run, and not a scarcity score -- a production figure counts
   * factory sets while a serial counts copies of one card, and conflating them
   * writes a confidently-wrong row that no later sweep can see.
   *
   * Absent when the source stated nothing. Blank is unknown.
   */
  rarity?: string | null;
  // 2,645,310 rows (8.4%) carry no player: unnamed checklist slots, team and
  // logo cards, and parallel rows seeded before a name was known. The type
  // said `string` and the data disagreed, which is a second reason writers
  // built their own doc rather than satisfy this one.
  playerName: string | null;
  playerSlug: string | null;         // for player search
  // Vendor cross-reference. Keys are source names; values are the
  // vendor's opaque card id for this catalog entry. Populate as we
  // encounter each vendor.
  vendorIds: Record<string, string>;
  // Reference image — populated once Slice 4 (image verify) lands.
  referenceImage?: {
    url: string;
    phash?: string;
    verifiedAt: string;
  };
  // Provenance.
  //
  // CF-THE-TYPE-MUST-BE-ABLE-TO-EXPRESS-THE-ROWS (Drew, 2026-08-26). This was
  // a five-value union: "seed" | "ch-catalog" | "cs-catalog" | "user-verified"
  // | "auto-inferred". Measured against production it admitted 45 rows out of
  // 31,444,200 -- 100.0% of the catalog carried a source this type could not
  // express, across 99 distinct values (baseballcardpedia 13.9M, bccp 1.6M,
  // checklistcenter 1.5M, ingest-auto-seed 933k, cardsight 720k, ...).
  //
  // That is why 59 of 61 writers bypass upsertCatalogEntry: routing through it
  // meant lying about where the row came from, so everyone wrote their own doc
  // instead -- and every one of those hand-rolled shapes is what the repair
  // sweeps have been chasing. A type nobody can satisfy does not enforce a
  // contract, it just moves the writes somewhere unguarded.
  //
  // Left open deliberately rather than enumerated: sources are minted by
  // scrapers and dated batches ("beckett-scraped-2026-08-26"), and a closed
  // union would need editing for each one -- which is the exact friction that
  // produced the bypassing in the first place. Convention is
  // `<origin>` for identities and `<origin>-graded` for their grade rows.
  source: string;
  confidence: number;                // 0-1
  observedAt: string;
  lastSeenAt: string;
  // Live counter for how many sold_comps rows point at this entry
  compCount?: number;

  // CF-THE-TYPE-MUST-BE-ABLE-TO-EXPRESS-THE-ROWS (Drew, 2026-08-26).
  //
  // Everything below is present on real rows and was absent from this type,
  // measured over 31,449,325 production rows:
  //
  //   searchTokens        99.0%        subsetName      49.8%
  //   setName             98.9%        gradeTier       28.0%
  //   searchText          89.9%        parentSlug      28.0%
  //   displayName         89.6%        gradeCompany    25.6%
  //   verificationStatus  87.1%        team             6.1%
  //   catalogVersion      85.8%        imageUrl         3.0%
  //
  // This is the rest of the answer to why 59 of 61 writers hand-roll their
  // own doc. A writer that routed through this type would have DROPPED
  // searchTokens and setName -- the fields catalog search and the matcher
  // discriminate on -- so going around it was self-preservation, not
  // laziness. A canonical path that silently loses 99%-present fields does
  // not get adopted, and cannot be enforced.
  //
  // All optional, so this widening cannot break an existing constructor.
  setName?: string;
  displayName?: string;
  searchTokens?: string[];
  searchText?: string;
  subsetName?: string | null;
  /** CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew, 2026-09-04).
   *  True on the rows whose cardNumber is shared by more than one subset of
   *  this product at this rung -- those, and only those, carry a `:sub-`
   *  segment in their id. PERSISTED so the decision is the catalog's: a later
   *  reader reaches the same slug without re-deriving the clash, and no path
   *  ever infers one from a sale title. */
  subsetInId?: boolean;
  team?: string | null;
  imageUrl?: string | null;
  brand?: string;
  // Null for a flagship that has no parent — deriveParentSetKey returns null
  // there, and a `string`-only field would force every caller to lie or cast.
  parentSetKey?: string | null;
  verificationStatus?: string;
  catalogVersion?: number;
  firstSeenAt?: string;
  observedCompCount?: number;

  // Grade rows: a graded card is its parent card plus a grade. parentSlug
  // points at the identity this one grades. See materialize-graded-identities.
  parentSlug?: string;
  gradeTier?: string;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  gradeQualifier?: string | null;
}

let _cached: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog");
    return _cached;
  } catch {
    return null;
  }
}

/**
 * Look up a catalog entry by slug. Null when the entry genuinely does not
 * exist, or Cosmos is unavailable.
 *
 * CF-GETCATALOGENTRY-WAS-A-NULL-GENERATOR (Drew, 2026-08-26). This read
 * partitioned on SPORT, parsed out of the slug. card_catalog has not
 * partitioned on /sport since CF-CATALOG-CARDID-PARTITION-KEY — it partitions
 * on /cardId, which the comment 130 lines below this one already said. So every
 * call raised a partition-key mismatch, the bare `catch` swallowed it, and the
 * function returned null for EVERY row in the container.
 *
 * It is called by persistVendorSalesToPool — the live sales firehose. That path
 * has been asking "does the catalog have this card?", being told no about
 * everything, and proceeding as though nothing exists. A lookup that always
 * fails is worse than one that throws, because nothing downstream can tell the
 * difference between "no such card" and "I did not really look".
 *
 * Two reads, deliberately in this order:
 *   1. point read on (slug, slug) — ~1 RU, and correct for every row written
 *      through deriveCatalogEntry, which sets cardId = id.
 *   2. on a miss, ONE query by id. 16.4M rows still sit under a foreign
 *      partition key (a vendor id inherited from the grade explode) and cannot
 *      be point-read at all until the re-home reaches them. Without this
 *      fallback the fix would only work for rows that were never broken.
 *
 * The fallback is the expensive half and it disappears on its own: as rows are
 * re-homed, step 1 starts hitting and step 2 stops running.
 */
export async function getCatalogEntry(slug: string): Promise<CardCatalogEntry | null> {
  if (!slug || !slug.startsWith("hiq:")) return null;
  const c = await getContainer();
  if (!c) return null;

  try {
    const { resource } = await c.item(slug, slug).read<CardCatalogEntry>();
    if (resource) return resource;
  } catch (err) {
    // 404 is "not at its own address", which is a real possibility here and
    // means fall through. Anything else is a fault worth surfacing rather than
    // silently reporting the card as missing.
    const code = (err as { code?: number })?.code;
    if (code !== undefined && code !== 404) {
      console.warn(JSON.stringify({
        event: "catalog.point_read_failed", source: "cardCatalog.service", slug, code,
      }));
      return null;
    }
  }

  try {
    const { resources } = await c.items.query<CardCatalogEntry>({
      query: "SELECT TOP 1 * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: slug }],
    }).fetchAll();
    return resources[0] ?? null;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "catalog.fallback_query_failed", source: "cardCatalog.service", slug,
      message: (err as Error)?.message,
    }));
    return null;
  }
}

/**
 * Fields an incoming winner carries over from the row it replaces. They are
 * enrichment written by OTHER jobs about the same card -- an image the 32M
 * backfill found, the sale counts, the re-home / move history -- and none of
 * them is a claim about the card's identity, which is exactly what the winner
 * is replacing. Everything derived from the row's own name (displayName,
 * searchText, profileVersion, checklistBacking ...) is NOT carried: it
 * described the old row, and the normalisers recompute it for the new one.
 */
const PRESERVED_ON_REPLACE = [
  "imageUrl", "imageSource", "imageBackfilledAt",
  "recentSaleCount", "observedCompCount", "firstSeenAt", "team",
  "rehomedFrom", "rehomedAt", "movedFrom", "movedReason", "movedAt",
  "setKeyBefore", "canonicalizedFrom", "unfoldedFrom",
  // A set-level production/odds statement is a fact about the PRODUCT, not a
  // claim about this row's identity, so a higher-authority source that simply
  // does not publish one must not erase it. CF-RARITY-IS-NOT-A-PRINT-RUN.
  "rarity",
] as const;

/** A confidence the row never declared is no confidence, not a high one. */
const confidenceOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The literal word "Base" — the finish no checklist states (#1634). Matches
 *  the predicate repair-hobbymonitor-literal-base.cjs applies to stored rows. */
export const isLiteralBaseParallel = (v: unknown): boolean => /^\s*base\s*$/i.test(String(v ?? ""));

/** The checklist said nothing in the parallel column. Blank, never "Base". */
export const isBlankParallel = (v: unknown): boolean => String(v ?? "").trim() === "";

/**
 * The merge rule behind upsertCatalogEntry, on its own so it can be tested
 * without a container -- the test that pinned "the cleanest one wins" carried
 * a COPY of the rule, and the copy could not fail when the rule did.
 *
 * CF-NO-CONFIDENCE-IS-NOT-HIGH-CONFIDENCE (2026-08-29, D3b). Rank by authority
 * first, and within a class by confidence. The class tie-break compared
 * `entry.confidence > existing.confidence`, and the 1.2M old checklistcenter
 * rows, the 13M baseballcardpedia rows and the beckett-checklist rows carry NO
 * confidence field at all -- so `0.95 > undefined` was false and the row with
 * no confidence beat the 0.95 checklist row every time. The D3 re-ingest
 * "wrote" 2,869,277 rows and left most of them under the OLD label: 2025
 * Bowman Draft CPA-MWI's Refractor /499, Purple Refractor /250, Gold Refractor
 * /50 ... all upserted as no-ops onto beckett / bcp / old-checklistcenter rows
 * with the same id, and the new source showed only the 13 rungs nobody else
 * had. A source retire keyed on that label would have deleted the ladder the
 * re-ingest had just re-attested. Missing confidence is 0; an exact tie still
 * keeps the existing row (idempotent re-runs stay no-ops).
 */
export function mergeCatalogEntries(
  entry: Omit<CardCatalogEntry, "observedAt" | "lastSeenAt">,
  existing: CardCatalogEntry | null,
  now: string,
): { merged: CardCatalogEntry; winnerIsIncoming: boolean } {
  const incomingRank = authorityRank(entry.source);
  const existingRank = existing ? authorityRank(existing.source) : -1;
  const winnerIsIncoming = !existing
    || incomingRank > existingRank
    || (incomingRank === existingRank && confidenceOf(entry.confidence) > confidenceOf(existing.confidence));
  if (!winnerIsIncoming) {
    // CF-A-DERIVED-INDEX-IS-NOT-AN-AUTHORITY-CLAIM (Drew, 2026-09-01).
    //
    // The losing branch keeps the existing row wholesale, which is right for
    // every field that ASSERTS something — player, parallel, printRun, source.
    // searchText / searchTokens / displayName assert nothing: they are a pure
    // function of the row, and a row that lacks them is not "winning", it is
    // unfindable (catalogSearch discriminates on ARRAY_CONTAINS(searchTokens)).
    //
    // Without this, re-ingesting a checklist over rows that already existed
    // left 153 of 646 variation rows with no tokens — the incoming row did not
    // outrank them, so the fields it had just computed were discarded. Fill
    // them in only where the existing row HAS none; never overwrite, so a
    // better row's index is left alone and the merge stays idempotent.
    const ex = existing!;
    const backfill: Record<string, unknown> = {};
    for (const f of ["searchText", "searchTokens", "displayName", "setName"] as const) {
      const has = (ex as unknown as Record<string, unknown>)[f];
      const incoming = (entry as unknown as Record<string, unknown>)[f];
      if ((has === undefined || has === null || has === "") && incoming !== undefined) {
        backfill[f] = incoming;
      }
    }
    // CF-BLANK-MEANS-UNKNOWN-NEVER-BASE, on the losing branch (2026-09-04).
    //
    // The literal word "Base" in a stored `parallel` is the one identity field
    // a losing checklist row may still correct, and it is not an exception to
    // the rule above so much as the rule applied honestly: "Base" asserts a
    // finish that no checklist ever states (#1634), and the incoming row is a
    // CHECKLIST saying the field is blank. Blanking it cannot move the row --
    // "", "Base", null and " Base " all normalise to the same `:base:` slug
    // segment, verified in repair-hobbymonitor-literal-base.cjs -- so no pool
    // splits and no FMV moves. It removes a word we invented.
    //
    // Deliberately narrow, on all three axes at once, exactly as the repair
    // script is: only when the INCOMING row is checklist authority, only when
    // the incoming parallel is genuinely blank, and only when the stored value
    // is the literal word. A real parallel name is never touched, and a
    // checklist that names a rung is not "blank" and so cannot erase one.
    if (
      catalogAuthorityOf(entry.source) === "checklist"
      && isBlankParallel(entry.parallel)
      && isLiteralBaseParallel(ex.parallel)
    ) {
      backfill.parallel = null;
      backfill.parallelBefore = ex.parallel;
    }
    return {
      winnerIsIncoming,
      merged: {
        ...ex,
        ...backfill,
        vendorIds: { ...ex.vendorIds, ...entry.vendorIds },
        lastSeenAt: now,
      },
    };
  }
  const merged: CardCatalogEntry = {
    ...entry,
    vendorIds: { ...(existing?.vendorIds ?? {}), ...entry.vendorIds },
    observedAt: existing?.observedAt ?? now,
    lastSeenAt: now,
  };
  if (existing) {
    const from = existing as unknown as Record<string, unknown>;
    const onto = merged as unknown as Record<string, unknown>;
    for (const k of PRESERVED_ON_REPLACE) if (from[k] !== undefined && onto[k] === undefined) onto[k] = from[k];
  }
  return { winnerIsIncoming, merged };
}

/**
 * Upsert a catalog entry. Idempotent: same slug → same doc id, so
 * repeated calls with identical facts are no-ops. When the incoming
 * entry has higher confidence than the existing, the higher wins.
 * Returns the resulting entry (either the incoming or the pre-existing).
 */
export async function upsertCatalogEntry(
  entry: Omit<CardCatalogEntry, "observedAt" | "lastSeenAt">,
  opts?: { known?: CardCatalogEntry | null },
): Promise<CardCatalogEntry | null> {
  const c = await getContainer();
  if (!c) return null;
  const now = new Date().toISOString();
  // CF-DO-NOT-LOOK-TWICE (Drew, 2026-08-26). getCatalogEntry point-reads and,
  // on a miss, falls back to a CROSS-PARTITION "SELECT TOP 1 * WHERE c.id".
  // That fallback exists for rows still sitting under a foreign partition key,
  // and it fires on every miss -- so a caller writing a NEW slug pays a
  // cross-partition scan for a row it already knows is absent.
  //
  // canonicalize-vendor-shaped-rows does exactly that 2.7M times: it point-
  // reads the target slug to check for a twin, then calls this, which looks
  // again and then scans. Re-homing ran at 1,700 rows/min against a scan that
  // sustains 22,000. `known` lets a caller pass the lookup it already did --
  // including `null` for "I checked, it is not there".
  const existing = opts && "known" in opts ? opts.known ?? null : await getCatalogEntry(entry.id);
  // Merge vendor IDs so we never lose a cross-reference. Keep the
  // higher-confidence source's canonical parallel + printRun.
  // CF-THE-CLEANEST-ONE-WINS (Drew, 2026-08-26).
  //
  // This compared CONFIDENCE alone, which lets the wrong row win exactly where
  // it matters most. `ingest-auto-seed` writes at 0.85 and is DERIVED — built
  // from the sales themselves — so a mis-slugged comp seeds a row and that row
  // then confirms the comp. An incoming CHECKLIST row transcribed from the
  // manufacturer's own list would lose to it on any confidence below 0.85.
  //
  // catalogAuthority already declares the ordering and says plainly that
  // derived rows "must never outvote a checklist"; it simply was not enforced
  // on the write path. Rank by authority first — checklist 3, vendor 2,
  // derived 1, unknown 0 — and only break ties within a class on confidence.
  //
  // This is the whole point of ingesting checklists: a checklist is the only
  // artifact that can CONTRADICT a sale. If it cannot win, ingesting it just
  // adds rows that agree with whatever was already there.
  const { merged } = mergeCatalogEntries(entry, existing, now);
  try {
    await c.items.upsert(merged as unknown as Record<string, unknown>);
    return merged;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "card_catalog_upsert_failed",
      source: "cardCatalog.service",
      slug: entry.id,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

/**
 * Derive a canonical catalog entry from raw fields. Used by the seed
 * script + the persist-time hook. Returns null when identity is
 * insufficient (missing year / setKey / cardNumber / playerName).
 */
export function deriveCatalogEntry(input: {
  sport: string;
  year: number | null | undefined;
  setKey: string | null | undefined;
  cardNumber: string | null | undefined;
  parallel: string | null | undefined;
  isAuto: boolean;
  printRun: number | null | undefined;
  /** Set-level production / odds statement, verbatim. Descriptive only;
   *  never a substitute for printRun. CF-RARITY-IS-NOT-A-PRINT-RUN. */
  rarity?: string | null | undefined;
  playerName: string;
  source: CardCatalogEntry["source"];
  confidence: number;
  vendorIds?: Record<string, string>;
  /** The publisher's own name for the product ("2018 Bowman Chrome"). Leads
   *  the search text and the display name. Optional: when absent, both are
   *  still built, from the setKey — a row with no setName is still findable,
   *  which is the whole point of CF-DERIVE-BUILDS-ITS-OWN-SEARCH-FIELDS. */
  setName?: string | null;
  /** Named subset, when the source states one. Display on most rows; part of
   *  the IDENTITY on the ones `subsetInId` flags. */
  subsetName?: string | null;
  /** CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE. Set by the caller
   *  that can SEE the clash -- the checklist ingest, comparing this rung
   *  against what the catalog already holds. Never derived here and never read
   *  off a title: one row cannot see a clash, and a seller's words are not the
   *  checklist. Left unset, the slug keeps the shape it has always had. */
  subsetInId?: boolean;
  /** Set when the caller knows the product for certain — a published
   *  checklist. Suppresses the cardNumber-prefix repair meant for untrusted
   *  vendor text, which would otherwise collapse 2026 Bowman CPA-AG
   *  (Adrian Gil) onto 2026 Bowman Chrome CPA-AG (Angeibel Gomez).
   *  See CF-AUTHORITATIVE-SETKEY. */
  authoritativeSetKey?: boolean;
}): Omit<CardCatalogEntry, "observedAt" | "lastSeenAt"> | null {
  const year = typeof input.year === "number" && Number.isFinite(input.year) ? input.year : null;
  const setKey = String(input.setKey ?? "").trim();
  const cardNumber = String(input.cardNumber ?? "").trim();
  const playerName = cleanPlayerName(input.playerName);
  if (!year || !setKey || !cardNumber || !playerName) return null;

  const slug = computeHobbyIqCardId({
    sport: input.sport,
    year,
    setKey,
    cardNumber,
    parallel: input.parallel ?? "Base",
    isAuto: input.isAuto,
    printRun: input.printRun ?? null,
    authoritativeSetKey: input.authoritativeSetKey === true,
    // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE: a no-op unless
    // the caller states the clash, which only the checklist ingest can see.
    subsetName: input.subsetName ?? null,
    subsetInId: input.subsetInId === true,
  });
  if (!slug || !slug.startsWith("hiq:")) return null;

  // READ THE SLUG STRUCTURALLY, NOT BY POSITION. This used to index
  // `slug.split(":")` at 3 and 5 for setKey and parallelSlug. Both indices are
  // wrong the moment a slug carries an OPTIONAL segment before them, and
  // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE introduces exactly
  // that: `hiq:basketball:2000:topps-chrome:sub-johnson-reprints:mj1:...`
  // would have read its setKey correctly and its PARALLEL as `mj1`, writing a
  // parallelSlug that names a card number. parseHobbyIqCardId knows where the
  // optional segments are; positional indexing cannot.
  const parsedIdentity = parseHobbyIqCardId(slug);
  const slugSetKey = parsedIdentity?.setKey ?? setKey;
  const parallelSlug = parsedIdentity?.parallel ?? "base";

  // CF-YEAR-CARDYEAR-DUAL-WRITE (Drew, 2026-08-11). Schema drift: some
  // legacy code paths wrote catalog rows with field name `cardYear`
  // (6.4M rows), others with `year` (9.26M rows). Explode + other
  // scripts filtering on `c.cardYear` skipped the `year`-only rows —
  // e.g., 2023 Topps Chrome Titans CT-10 Adley Rutschman never got its
  // refractor rainbow, so a user pick of Green Refractor /99 returned
  // no comps. Write BOTH going forward so every downstream filter
  // works regardless of which name it checks.
  // CF-CATALOG-CARDID-PARTITION-KEY (Drew, 2026-08-12). card_catalog
  // partitions on /cardId — NOT /sport, whatever the interface comment used to
  // claim. Entries built here carried no cardId at all, so every row this path
  // wrote landed in the UNDEFINED partition. Cosmos allows the same `id` in a
  // different partition, so a checklist ingest silently created a SECOND doc
  // beside the canonical one instead of updating it:
  //
  //   id=hiq:baseball:2026:bowman-chrome:1:base:no-auto cardId=undefined Konnor Griffin
  //   id=hiq:baseball:2026:bowman-chrome:1:base:no-auto cardId=<set>     Aaron Judge
  //
  // Both "wrote" successfully. Neither point read could see the new one, and
  // catalogVerify — which reads by partition — never found it. Setting cardId
  // puts canonical rows back in their own single-document partition, which is
  // what makes the ~1 RU point read work.
  // CF-DERIVE-BUILDS-ITS-OWN-SEARCH-FIELDS (Drew, 2026-09-01: "Fix the root
  // cause — deriveCatalogEntry should build its own search fields").
  //
  // catalogSearch discriminates with ARRAY_CONTAINS(c.searchTokens, @t), so a
  // row without them EXISTS and can never be returned by any query. This
  // constructor did not write them, which is why every checklist ingested
  // through ingest-scraped-checklist landed search-invisible and needed
  // repair-missing-search-fields run behind it:
  //
  //     2026 bowman-chrome checklist rows   2179 / 2179 had searchTokens
  //     the 78 rows ingested by #1612          0 /   78
  //
  // It is also the second half of the answer this file already gives for why
  // 59 of 61 catalog writers hand-roll their own doc — a canonical path that
  // silently drops 99%-present fields does not get adopted. Now it doesn't.
  //
  // The SAME derivation catalogRowOps.rebuildSearchFields uses, field for
  // field, so a row minted here and a row healed there are byte-identical and
  // neither reads as stale to the coverage canary. buildSearchText /
  // buildSearchTokens are the single source of truth (CF-SEARCH-INDEXING);
  // this is a caller of them, never a third copy.
  const setName = typeof input.setName === "string" && input.setName.trim()
    ? input.setName.trim()
    : null;
  const searchText = buildSearchText({
    player: playerName,
    setName,
    set: setKey ? setKey.replace(/-/g, " ") : null,
    number: cardNumber,
    year,
    variant: input.parallel && String(input.parallel).toLowerCase() !== "base" ? String(input.parallel) : null,
    attributes: parallelSlug && parallelSlug !== input.parallel ? [parallelSlug.replace(/-/g, " ")] : null,
  });
  const searchFields = {
    searchText,
    searchTokens: buildSearchTokens(searchText),
    displayName: canonicalCardName({
      year,
      setName,
      setKey: slugSetKey,
      sport: input.sport,
      cardNumber,
      playerName,
      parallel: input.parallel ? String(input.parallel) : null,
      printRun: typeof input.printRun === "number" ? input.printRun : null,
      subsetName: input.subsetName ?? null,
    }),
  };

  return {
    id: slug,
    cardId: slug,
    hobbyiqCardId: slug,
    sport: input.sport,
    year,
    cardYear: year,
    // CF-THE-ID-CARRIES-THE-PRODUCT (D23). A key needs both halves AT MINT:
    // the field is the id's own setKey segment, never the caller's spelling
    // of it. "leaf-metal-baseball" (a filename), "Topps Update" (one
    // source's name) and "bowman" + BCP- (the vendor repair) all used to
    // leave a field that disagreed with the id, and every mover then refused
    // the row. setName keeps the source's own words.
    setKey: slugSetKey,
    cardNumber: cardNumber.toUpperCase(),
    parallel: String(input.parallel ?? "Base"),
    parallelSlug,
    isAuto: input.isAuto,
    printRun: input.printRun ?? null,
    // Omitted entirely when unknown, so an existing row's rarity is not
    // overwritten with null by a source that simply does not publish one.
    ...(typeof input.rarity === "string" && input.rarity.trim()
      ? { rarity: input.rarity.trim() }
      : {}),
    playerName,
    playerSlug: playerSlugify(playerName),
    vendorIds: input.vendorIds ?? {},
    source: input.source,
    confidence: input.confidence,
    ...(setName ? { setName } : {}),
    // Omitted when unknown, for the same reason rarity is: blank is unknown,
    // and writing null would erase a subset another source did state.
    ...(input.subsetName ? { subsetName: input.subsetName } : {}),
    // The flag rides WITH the slug it produced -- a row whose id carries a
    // :sub- segment and whose field does not would be a row nothing could
    // re-derive.
    ...(input.subsetInId === true ? { subsetInId: true } : {}),
    ...searchFields,
  } as Omit<CardCatalogEntry, "observedAt" | "lastSeenAt"> & { cardYear: number };
}

/**
 * CF-A-NAME-DOES-NOT-END-IN-A-COMMA (D15, 2026-08-29). Beckett's workbook
 * writes the player cell as "Max Williams," and the one checklist CSV carried
 * it through to 9,199 catalog rows -- Drew saw it in the 2025 Bowman Draft
 * CPA-MWI picker. A trailing run of commas / semicolons / whitespace is not
 * part of any name. A trailing "." IS ("Jr." -- 656,452 rows). Applied here by
 * deriveCatalogEntry and by the CSV ingest's row parse;
 * scripts/repair-trailing-comma-player-names.cjs heals the rows that were
 * already written.
 *
 * CF-ONE-PLAYER-IS-NOT-TWO-PLAYERS (D33, Drew 2026-08-30, "still a mess" on
 * 2020 Bowman Draft BD-152). D15 scoped EMBEDDED commas out because no
 * "Last, First" row was found -- true, and this is not that shape. baseball-
 * cardpedia writes the GENERATIONAL SUFFIX with a comma before it ("Bobby
 * Witt, Jr."), which the end-anchored trim cannot see: the trailing character
 * is the ".". So both spellings persist and the picker renders one player as
 * two -- measured 2026-08-30, 158,567 catalog rows, and the clean spelling
 * already coexists for every one of the top names (Bobby Witt Jr. 33,367;
 * Ken Griffey Jr. 24,441). The comma before Jr./Sr./II/III/IV/V is
 * punctuation, not a name boundary, so it is dropped and the suffix kept.
 *
 * WHAT THIS STILL REFUSES TO DO. Only a comma followed by a known
 * generational suffix is touched. A "Last, First" row -- if one ever appears
 * -- is left exactly as it is, because reordering a name invents an identity;
 * and a multi-player name keeps every player ("Eddie Murray / Cal Ripken,
 * Jr." -> "Eddie Murray / Cal Ripken Jr.", never split on the comma). The
 * D15 pin "O'Neil, Tyler" stays untouched for the same reason.
 */
const GENERATIONAL_SUFFIX_COMMA = /,\s*(Jr|Sr|III|IV|II|V)\.?(?![A-Za-z])/gi;

export function cleanPlayerName(raw: string | null | undefined): string {
  // CF-A-COMMA-BEFORE-JR-IS-NOT-A-TEAM (D33, Drew 2026-08-30). The picker
  // listed "Bobby Witt, Jr." and "Bobby Witt Jr." as two different players for
  // one card: baseballcardpedia writes the comma, every other source does not.
  // A comma before an honorific SUFFIX is punctuation inside one name, so it
  // is removed and the suffix kept. The match is GLOBAL, not end-anchored, so
  // the suffix is also healed mid-string -- "Ronald Acuna, Jr., Braves" and
  // "Eddie Murray / Cal Ripken, Jr." both carry it away from the end -- and
  // the (?![A-Za-z]) lookahead is what keeps "Smith, Ivan" / "Brown, Sroka"
  // (a real name that merely STARTS like a suffix) untouched.
  return String(raw ?? "")
    .trim()
    .replace(GENERATIONAL_SUFFIX_COMMA, (_m, suffix: string) => ` ${suffix}${_m.trimEnd().endsWith(".") ? "." : ""}`)
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[\s,;]+$/, "");
}

function playerSlugify(name: string): string {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Cheap count for the data-quality report. Cross-partition — the
 * result includes every catalog entry across every sport. Cached at
 * the caller.
 */
export async function countCatalogEntries(): Promise<number> {
  const c = await getContainer();
  if (!c) return 0;
  try {
    const { resources } = await c.items.query<number>("SELECT VALUE COUNT(1) FROM c").fetchAll();
    return resources[0] ?? 0;
  } catch {
    return 0;
  }
}
