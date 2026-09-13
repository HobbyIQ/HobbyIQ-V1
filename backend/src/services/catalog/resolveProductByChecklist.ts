/**
 * RULING R29 (Drew, 2026-09-13): "when ingesting, we need to make decisions
 * that correctly put it to the card set. I don't want to make a rule, but I
 * want this to be correct to match correctly."
 *
 * THE PRODUCT OF A SALE IS DECIDED BY THE CHECKLIST, NOT BY A BRAND REGEX.
 *
 * `inferSetKeyFromTitle` reads a title with ~40 brand rules and answers with a
 * product NAME. Those rules are a reading of the words; they are not a reading
 * of the hobby. When a title's product words are punctuated in a way no rule
 * anticipated, the bare family catch-all answers instead and the specialization
 * is swallowed by its flagship. Measured on the 2026-09-12 census samples
 * (15,016 parsed rows, 4,401 with a derivable identity), 678 rows -- 15.4% --
 * are exactly that shape: the row's STORED key is a longer specialization of
 * the key the parser derived.
 *
 *   "2025 Topps Allen & Ginter Baseball #234 Base"  -> topps    (want topps-allen-ginter)
 *   "2024 Bowman's Best Baseball #B24-GW Base"      -> bowman   (want bowmans-best)
 *   "2024 Panini Prizm WNBA Basketball #5 Base"     -> panini-prizm (want panini-prizm-wnba)
 *
 * A brand regex cannot tell which of those is right, because BOTH keys are real
 * products and both spellings appear in real titles. The CHECKLIST can, and it
 * answers unambiguously. Read read-only from card_catalog on 2026-09-13:
 *
 *   2024 bowmans-best #B24-GW  -> George Wolkow, catalog-explode-actuals
 *   2024 bowman       #B24-GW  -> playerName null, source bccp (a parallel stub)
 *   2025 topps-allen-ginter #234 -> Alec Bohm, checklistcenter-2026-08-30
 *   2025 topps        #234       -> playerName null, source bccp
 *
 * The specialization HOLDS THE CARD, named, from a transcribed checklist. The
 * flagship holds a row at the same address with no player on it. That is the
 * whole decision, and it is the same decision for every product pair in the
 * class -- which is why this is one resolver and not forty more regexes.
 *
 * -- WHY THIS SUBSUMES THE ALIAS TABLES RATHER THAN ADDING TO THEM -----------
 *
 * D31 registered `panini-optic` as a `names:` alias of `donruss-optic`. R29
 * says an alias must FALL OUT of the checklist rather than be maintained by
 * hand, and measured, it does:
 *
 *   2024 donruss-optic #201 -> Precious Achiuwa, checklistinsider-2026-08-27
 *                              (344,141 rows at the key)
 *   2024 panini-optic  #201 -> "Caleb Williams Rated", ingest-auto-seed
 *                              (10,200 rows, every one self-derived)
 *
 * `panini-optic` is not a product; it is a pool of our own mis-parses wearing
 * one. The resolver reaches `donruss-optic` because that is where the CARD is,
 * with no table consulted -- and it would keep reaching it if the table were
 * deleted tomorrow. The table is left in place (deleting it is a separate,
 * wider change: `normalizeSetKey` is on the hot path of every minted id and the
 * D31 entry also governs the SLUG seam) but it is no longer what decides.
 *
 * -- ROW EXISTENCE IS NOT EVIDENCE; A CHECKLIST-BACKED PLAYER IS -------------
 *
 * Both `topps` and `topps-allen-ginter` have a row at #234 -- so "does a row
 * exist" answers BOTH candidates and decides nothing. The predicate that
 * separates them is `catalogAuthorityOf(source) === "checklist"` AND a real
 * `playerName`, which is identityBacking's question asked of a candidate
 * product instead of a slug. `bccp` parallel stubs with a null player are
 * exactly the rows a naive existence check would be fooled by, and they are
 * the majority of what a flagship holds at a specialization's numbers.
 *
 * -- NO MATCH IS AN ANSWER, AND IT IS NOT A GUESS ----------------------------
 *
 * CF-ABSENT-BEATS-WRONG. When no candidate holds the card the resolver returns
 * `unknown` with the near-miss named -- "the NUMBER is there for a different
 * player" and "the PLAYER is there at a different number" are different work
 * items and the reason string says which. It never moves a sale to a card that
 * is not there, and it never invents a product. When no candidate has any
 * checklist at all the verdict is `no-checklist` and the candidate list is the
 * ACQUISITION QUEUE (annotate-checklist-backing's header makes the same point).
 *
 * -- THE LOOKUPS ARE BOUNDED, CACHED, AND NEVER A CROSS-PARTITION SCAN -------
 *
 * Every query is the indexed (year, setKey, cardNumber) shape the matcher
 * already uses, and answers are cached per (year, setKey, cardNumber) for the
 * life of a run -- a 1,000-row fixture asks a few hundred distinct questions,
 * not a thousand scans. card_catalog is at 100k RU for launch week and this
 * path must not be what spends it.
 */
import type { Container } from "@azure/cosmos";
import { catalogAuthorityOf } from "./catalogAuthority.service.js";
import {
  productEntry,
  productParentOf,
  productSetKeys,
  productAncestry,
  isProductSetKey,
} from "./productSetKeys.js";
import {
  applySiblingChecklistOverride,
  siblingSetKeysToAlsoCheck,
} from "../portfolioiq/hobbyIqCardId.service.js";

/** What the title says, normalized. Every field may be absent -- the resolver
 *  answers with what it is given and says so when that is not enough. */
export interface ProductEvidence {
  /** Slugified product text the title states, year and sport stripped. */
  readonly productText: string;
  readonly year: number | null;
  readonly cardNumber: string | null;
  readonly player: string | null;
  readonly sport?: string | null;
  /** The product the TITLE PARSER read, normalized. Supplied so the resolver
   *  can refuse to move a card UP its own family ladder -- see
   *  `wouldFoldUpToAnAncestor`. Optional: a caller with no parser answer
   *  simply gets no fold-up guard. */
  readonly parsedSetKey?: string | null;
}

export type ProductVerdict =
  /** Exactly one candidate's checklist holds this card. */
  | "resolved"
  /** Several hold it and the title's words broke the tie. */
  | "resolved-by-title"
  /** Candidates exist and have checklists, but none holds this card. */
  | "unknown"
  /** No candidate has a checklist at all -- the acquisition queue. */
  | "no-checklist"
  /** Not enough evidence to ask the question (no number, no year, no words). */
  | "insufficient-evidence";

export interface ProductResolution {
  readonly setKey: string | null;
  readonly verdict: ProductVerdict;
  /** Why, in a closed vocabulary a consumer can branch on. */
  readonly reason: string;
  /** Every product the title's words put in play, in the order tested. */
  readonly candidates: readonly string[];
  /** Candidates whose checklist holds this exact card. */
  readonly holders: readonly string[];
}

interface ChecklistHit {
  readonly setKey: string;
  readonly playerName: string | null;
  readonly source: string | null;
}

/** The one place a "does this product's checklist hold this card" answer is
 *  cached. Keyed by the full question so two different cards never share one. */
export type HolderCache = Map<string, ChecklistHit | null>;

export interface ResolveCtx {
  /** The card_catalog container, or null when the catalog is unreachable --
   *  in which case the resolver refuses rather than guessing. */
  readonly container: Container | null;
  /** Per-run cache. Callers processing a batch should pass ONE of these. */
  readonly cache?: HolderCache;
}

export function newResolveCache(): HolderCache {
  return new Map();
}

function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The products a title's words put in play.
 *
 * A candidate is any registered product whose key or registered `names:`
 * spelling appears in the title's product text as a contiguous run of
 * segments, PLUS -- for any candidate found -- its registered parent chain. The
 * parent is included because the title of a specialization always contains its
 * flagship's words ("Topps Allen Ginter" contains "topps"), so the flagship is
 * a genuine rival that the checklist must be allowed to rule out; excluding it
 * would make this resolver assume its own answer.
 *
 * Deliberately NOT a fuzzy match. A product whose words the title does not
 * state is not a candidate, because R29 is explicit that product words break
 * ties between products that both contain the card -- they never invent one.
 *
 * THE REGISTERED SIBLINGS ARE THE ONE EXCEPTION, and R29 names it: "the same
 * number can exist in two sibling products for different players... so
 * number+player+year must agree, never number alone". A title routinely names
 * the wrong half of a sibling pair -- measured live, "2026 Bowman #CPA-AC" is
 * a card the BOWMAN checklist does not list at all while bowman-chrome names
 * Argenis Cayama at it (8 checklistinsider rows). Without the sibling the
 * resolver refuses a card we plainly hold. This widens candidates ONLY along
 * the hand-verified pairs `siblingSetKeysToAlsoCheck` already governs -- the
 * same table, the same blast radius, never a blanket family search -- which is
 * the discipline resolveCardNumberByPlayer adopted for the same reason.
 */
export function candidateProducts(productText: string, year?: number | null): string[] {
  const text = String(productText ?? "").trim().toLowerCase();
  if (!text) return [];
  const segs = text.split("-").filter(Boolean);
  if (segs.length === 0) return [];
  // THE JOINING WORD IS NOT PART OF THE PRODUCT'S NAME, and dropping it is the
  // difference between finding a product and refusing it. Measured on the real
  // titles: "Topps Allen & Ginter" slugifies to `topps-allen-ginter` and
  // matches the registered key, while "Topps Allen and Ginter" -- the SAME
  // product, the spelling the brand rules actually parse correctly -- yields
  // `topps-allen-and-ginter`, which contains no run equal to the key. So the
  // ampersand form resolved and the written-out form did not, which is the
  // mechanism this ruling is about, inverted. Registry keys never carry `and`
  // (`topps-allen-ginter`, `stars-stripes`), so a second pass with the joining
  // words removed can only ever ADD the product the title plainly names.
  const segsNoJoiner = segs.filter((x) => x !== "and" && x !== "n");
  const segViews = segsNoJoiner.length === segs.length ? [segs] : [segs, segsNoJoiner];
  const found = new Set<string>();
  for (const key of productSetKeys()) {
    const entry = productEntry(key);
    if (!entry) continue;
    let hit = false;
    for (const name of [entry.setKey, ...(entry.names ?? [])]) {
      const needle = name.split("-");
      for (const view of segViews) if (containsRun(view, needle)) { hit = true; break; }
      if (hit) break;
    }
    if (hit) found.add(entry.setKey);
  }
  // Add each hit's parent chain: the flagship is a real rival, and the
  // checklist -- not this function -- is what rules it out.
  for (const k of [...found]) {
    let p = productParentOf(k);
    const guard = new Set<string>();
    while (p && !guard.has(p)) { guard.add(p); found.add(p); p = productParentOf(p); }
  }
  // The registered siblings for this year, for the reason in the header.
  const y = Number(year ?? 0);
  if (y) for (const k of [...found]) for (const s of siblingSetKeysToAlsoCheck(k, y)) found.add(s);
  // Longest (most specific) first, so a tie-break reads in the right order.
  return [...found].sort((a, b) => b.split("-").length - a.split("-").length || b.length - a.length);
}

/** Normalized comparison form for a player name: case, punctuation and
 *  suffix noise removed. Two spellings of one person must compare equal or
 *  the resolver refuses a card it actually holds. */
export function normalizePlayerForCompare(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Two player spellings name the same person when their surnames match and
 *  their first initials agree -- the checklist writes "Ronald Acuna Jr." where
 *  a title writes "Ronald Acuna", and refusing on that would reject a card the
 *  checklist plainly holds. Conservative: a single-token name never matches
 *  loosely, because a bare surname is exactly how two players collide. */
function playersAgree(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  if (ta.length < 2 || tb.length < 2) return false;
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  return lastA === lastB && ta[0][0] === tb[0][0];
}

/**
 * Does this product's checklist hold this card? Returns the hit, or null.
 *
 * CHECKLIST-BACKED AND NAMED. A row counts only when its source is the
 * `checklist` authority class and it carries a real playerName. Both halves are
 * load-bearing: the flagship holds `bccp` parallel stubs at a specialization's
 * card numbers with `playerName: null`, and a resolver that accepted those
 * would answer "topps" for every Allen & Ginter card in the pool -- the exact
 * defect it exists to fix.
 */
async function checklistHolds(
  container: Container,
  args: { year: number; setKey: string; cardNumber: string },
  cache: HolderCache,
): Promise<ChecklistHit | null> {
  const key = `${args.year}|${args.setKey}|${args.cardNumber.toUpperCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let hit: ChecklistHit | null = null;
  try {
    const { resources } = await container.items.query<{ playerName: string | null; source: string | null }>({
      query: `SELECT TOP 25 c.playerName, c.source FROM c
              WHERE c.year = @y AND c.setKey = @s AND c.cardNumber = @n`,
      parameters: [
        { name: "@y", value: args.year },
        { name: "@s", value: args.setKey },
        { name: "@n", value: args.cardNumber },
      ],
    }).fetchAll();
    for (const r of resources ?? []) {
      const named = String(r.playerName ?? "").trim();
      if (!named) continue;
      if (catalogAuthorityOf(r.source) !== "checklist") continue;
      hit = { setKey: args.setKey, playerName: named, source: r.source ?? null };
      break;
    }
  } catch {
    hit = null;
  }
  cache.set(key, hit);
  return hit;
}

/** Does any candidate hold a checklist for this year at all? Answers the
 *  difference between "we have the checklist and the card is not in it"
 *  (a real refusal) and "we have never acquired this product" (a work item). */
async function someCandidateHasAChecklist(
  container: Container,
  candidates: readonly string[],
  year: number,
  cache: HolderCache,
): Promise<boolean> {
  for (const setKey of candidates) {
    const key = `HASLIST|${year}|${setKey}`;
    const cached = cache.get(key);
    if (cached !== undefined) { if (cached) return true; continue; }
    let has: ChecklistHit | null = null;
    try {
      const { resources } = await container.items.query<{ source: string | null }>({
        query: `SELECT TOP 20 c.source FROM c WHERE c.year = @y AND c.setKey = @s`,
        parameters: [{ name: "@y", value: year }, { name: "@s", value: setKey }],
      }).fetchAll();
      for (const r of resources ?? []) {
        if (catalogAuthorityOf(r.source) === "checklist") {
          has = { setKey, playerName: null, source: r.source ?? null };
          break;
        }
      }
    } catch { has = null; }
    cache.set(key, has);
    if (has) return true;
  }
  return false;
}

/**
 * Decide the product for one card from the checklist.
 *
 * The decision, in R29's own order:
 *   exactly one candidate holds the card  -> that product
 *   several hold it                       -> the title's most specific stated
 *                                            product word decides; still tied
 *                                            -> unknown
 *   none holds it                         -> unknown, naming the near miss
 *   no candidate has any checklist        -> no-checklist + acquisition list
 */
export async function resolveProductByChecklist(
  evidence: ProductEvidence,
  ctx: ResolveCtx,
): Promise<ProductResolution> {
  const candidates = candidateProducts(evidence.productText, evidence.year);
  const year = Number(evidence.year ?? 0);
  const cardNumber = String(evidence.cardNumber ?? "").trim();

  if (candidates.length === 0) {
    return { setKey: null, verdict: "insufficient-evidence", reason: "no-product-words", candidates: [], holders: [] };
  }
  if (!year || !cardNumber) {
    return {
      setKey: null,
      verdict: "insufficient-evidence",
      reason: !year ? "no-year" : "no-card-number",
      candidates,
      holders: [],
    };
  }
  if (!ctx.container) {
    return { setKey: null, verdict: "insufficient-evidence", reason: "no-catalog", candidates, holders: [] };
  }

  const cache = ctx.cache ?? newResolveCache();
  const holders: string[] = [];
  const hits: ChecklistHit[] = [];
  for (const setKey of candidates) {
    const hit = await checklistHolds(ctx.container, { year, setKey, cardNumber }, cache);
    if (hit) { holders.push(setKey); hits.push(hit); }
  }

  // THE PLAYER IS PART OF THE QUESTION. #2064 measured 8 of 179 shared 2026
  // CPA- numbers naming DIFFERENT PEOPLE in Bowman and Bowman Chrome; a
  // resolver that matched on number alone would pool two players' sales. When
  // the title names a player, only the candidates whose checklist names the
  // SAME player hold the card.
  const wantPlayer = normalizePlayerForCompare(evidence.player);
  let kept = holders;
  let keptHits = hits;
  if (wantPlayer && hits.length > 0) {
    const agree = hits.filter((h) => playersAgree(normalizePlayerForCompare(h.playerName), wantPlayer));
    if (agree.length > 0) {
      keptHits = agree;
      kept = agree.map((h) => h.setKey);
    } else {
      // The number is there; the person is not. Never move to a card that
      // isn't there -- name the near miss and refuse.
      return {
        setKey: null,
        verdict: "unknown",
        reason: `number-present-different-player:${hits[0].setKey}:${hits[0].playerName ?? ""}`,
        candidates,
        holders,
      };
    }
  }

  if (kept.length === 1) {
    if (wouldFoldUpToAnAncestor(evidence.parsedSetKey, kept[0])) {
      return { setKey: null, verdict: "unknown", reason: `refused-fold-up:${kept[0]}`, candidates, holders: kept };
    }
    return {
      setKey: kept[0],
      verdict: "resolved",
      reason: `checklist:${keptHits[0]?.source ?? ""}`,
      candidates,
      holders: kept,
    };
  }
  if (kept.length > 1) {
    // THE #2064 OVERRIDE TABLE SURVIVES, AS A TIE-BREAKER, AND IT HAD TO --
    // MEASURED, NOT ASSUMED. The design allowed deleting it if the resolver
    // subsumed it. It does not, and the read that proves it is worth stating
    // because the opposite was the expectation going in:
    //
    //   2026 bowman        #CPA-MG -> Marconi German (checklistcenter, 8 rows)
    //   2026 bowman-chrome #CPA-MG -> Marconi German (checklist, 4 rows)
    //
    // The SAME PLAYER is listed at the same number under BOTH sibling keys, so
    // neither the checklist nor the player breaks the tie, and the title says
    // "Bowman Chrome" -- which would make title-specificity answer
    // `bowman-chrome`. Drew ruled the opposite (cpaMgBowmanChromeToBowman
    // Relocation.test.ts: CPA-MG is a 2026 BOWMAN card; the bowman-chrome rows
    // are phantom parallels being retired). The live catalog has not caught up
    // with the ruling, and a resolver that read only today's rows would quietly
    // reverse it.
    //
    // So the hand-verified table answers FIRST among tied holders. This is not
    // a rule competing with the checklist -- it is a RULING, and R29's "no
    // match -> unknown, never a guess" is about inventing products, not about
    // discarding a decision Drew already made on evidence we hold.
    //
    // ONLY WHEN THE TABLE ACTUALLY MOVED THE KEY. `applySiblingChecklistOverride`
    // returns its INPUT unchanged when no rule matches, so testing its output
    // alone makes every tie return whatever was fed in -- measured on the
    // fixture, that shipped "2025 Panini Donruss Optic #169" to `panini-donruss`
    // purely because it sorted first among three tied holders. The `!==` is what
    // keeps this a ruling and not an accidental default.
    const tieSeed = candidates.find((c) => kept.includes(c)) ?? kept[0];
    const overridden = applySiblingChecklistOverride(tieSeed, cardNumber, year);
    if (overridden !== tieSeed && kept.includes(overridden)) {
      return {
        setKey: overridden,
        verdict: "resolved-by-title",
        reason: "sibling-checklist-override",
        candidates,
        holders: kept,
      };
    }
    // Several products genuinely contain the card. R29: the title's most
    // specific stated product words break the tie. `candidates` is already
    // ordered most-specific-first and every entry is a product the title
    // STATES, so the first survivor is that answer -- "Chrome" present picks
    // bowman-chrome over bowman, "Sapphire" picks sapphire.
    const winner = candidates.find((c) => kept.includes(c)) ?? null;
    // A tie the words cannot break is a refusal, not a coin flip.
    const depth = (k: string) => k.split("-").length;
    const equallySpecific = winner ? kept.filter((k) => depth(k) === depth(winner)) : [];
    if (winner && equallySpecific.length === 1) {
      if (wouldFoldUpToAnAncestor(evidence.parsedSetKey, winner)) {
        return { setKey: null, verdict: "unknown", reason: `refused-fold-up:${winner}`, candidates, holders: kept };
      }
      return { setKey: winner, verdict: "resolved-by-title", reason: "title-most-specific", candidates, holders: kept };
    }
    return { setKey: null, verdict: "unknown", reason: `tie-unbroken:${kept.join(",")}`, candidates, holders: kept };
  }

  // Nothing holds the card. Did ANY candidate have a checklist at all?
  const anyChecklist = await someCandidateHasAChecklist(ctx.container, candidates, year, cache);
  if (!anyChecklist) {
    return { setKey: null, verdict: "no-checklist", reason: "acquisition-queue", candidates, holders: [] };
  }
  return { setKey: null, verdict: "unknown", reason: "card-not-in-any-candidate-checklist", candidates, holders: [] };
}

/**
 * THE FLAGSHIP-SWALLOW GUARD, POINTED BACK AT THIS RESOLVER.
 *
 * MEASURED REGRESSION, not a hypothetical. On the census CONFLICT sample this
 * resolver moved 10 rows `topps-triple-threads -> topps` and 5 rows
 * `topps-match-attax-uefa -> topps` -- committing, in its own answer, exactly
 * the defect it was written to fix.
 *
 * The mechanism is worth stating because it will recur. Candidate generation
 * offers a product only when the REGISTRY names it: `topps-triple-threads` is
 * not a registered key at all, and `topps-match-attax-uefa` is registered under
 * a spelling the title ("Topps Match Attax") does not contain. In both cases
 * the only candidate the title produced was the flagship `topps` -- whose
 * checklist, being enormous, holds a row at almost any number. The resolver
 * then "confirmed" a product the title never named.
 *
 * So a checklist hit may never fold a card UP its own family ladder. If the
 * parser read a specialization and the resolver's answer is that
 * specialization's ancestor, the honest verdict is `unknown`: we have not
 * disproved the parser, we have merely failed to offer its product as a
 * candidate, and CF-PRODUCT-FAMILY-COLLAPSE-IS-FORBIDDEN (Drew, 2026-09-03)
 * says the flagship must not answer for the specialization. The row keeps the
 * parser's key and becomes an ACQUISITION item -- which is the correct reading:
 * these products need registry entries and checklists, not a re-key.
 *
 * Note it compares ANCESTRY, not string prefixes: `bowman-chrome -> bowman` is
 * a genuine sibling correction the #2064 table makes on real evidence, and
 * `bowman` is not an ancestor of `bowman-chrome` in the registry (they are
 * siblings under their own entries), so that correction still lands.
 */
function wouldFoldUpToAnAncestor(
  parsedSetKey: string | null | undefined,
  decided: string,
): boolean {
  const parsed = String(parsedSetKey ?? "").trim().toLowerCase();
  if (!parsed || parsed === decided) return false;
  // The parser's key folding up to one of ITS OWN ancestors is the defect.
  if (productAncestry(parsed).slice(1).includes(decided)) return true;
  // A key the registry does not know cannot have its ancestry read, and the
  // measured cases (`topps-triple-threads`) are exactly that shape. Fall back
  // to the segment test, which is what "more specific" means for a slug.
  if (!isProductSetKey(parsed) && parsed.startsWith(`${decided}-`)) return true;
  return false;
}

/** True iff `key` names a registered product -- re-exported so callers need
 *  only this module to ask the resolver's questions. */
export function isRegisteredProduct(key: string | null | undefined): boolean {
  return isProductSetKey(key);
}

/**
 * THE ONE KEY CONVENTION BOTH PATHS USE.
 *
 * The TS service path calls `resolveProductByChecklist` inline; the .cjs
 * re-derivation path is synchronous and reads pre-resolved answers out of a
 * Map (see rematch-derive-identity.cjs). A map is only as good as both sides
 * agreeing on its key, and "both sides build the same string by hand" is how
 * two readings of one title start to disagree -- so the string is built HERE,
 * once, and each side imports it.
 */
export function productResolutionKey(
  year: number | null | undefined,
  setKey: string | null | undefined,
  cardNumber: string | null | undefined,
): string {
  return `${Number(year ?? 0)}|${String(setKey ?? "")}|${String(cardNumber ?? "").toUpperCase()}`;
}

/**
 * Resolve the products for a whole batch, returning the map the .cjs deriver
 * reads. Only entries the resolver actually DECIDED are present -- a miss is
 * an absent key, so the reader's `||` fallback leaves the parser's answer
 * standing (CF-ONLY-IMPROVE on the product axis).
 */
export async function resolveProductsForBatch(
  rows: ReadonlyArray<{ productText: string; year: number | null; cardNumber: string | null; player?: string | null; setKey: string }>,
  ctx: ResolveCtx,
): Promise<Map<string, string>> {
  const cache = ctx.cache ?? newResolveCache();
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = productResolutionKey(r.year, r.setKey, r.cardNumber);
    if (out.has(key)) continue;
    const res = await resolveProductByChecklist(
      {
        productText: r.productText,
        year: r.year,
        cardNumber: r.cardNumber,
        player: r.player ?? null,
        parsedSetKey: r.setKey,
      },
      { container: ctx.container, cache },
    );
    if (res.setKey && res.setKey !== r.setKey) out.set(key, res.setKey);
  }
  return out;
}
