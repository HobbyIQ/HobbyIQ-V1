/**
 * codeCollisions.ts -- the registered table of (sport, year, setKey, code)
 * triples where the SAME printed card code names TWO DIFFERENT PLAYERS in
 * the SAME product.
 *
 * CF-A-CODE-TWO-PLAYERS-SHARE-GETS-A-PLAYER-SEGMENT (Drew, 2026-09-28 14:35Z).
 *
 * THE SHAPE. This is a Topps printing defect, not a transcription or ingest
 * error: the SAME checklist prints the SAME card code (`CPA-PS`, `CPA-ET`,
 * ...) against two different rookies in one release. Confirmed against 2024
 * Bowman Chrome Prospect Autographs by the checklist-verified audit at
 * C:/tmp/cpaaudit2_134838/REPORT.md (2026-09-28, WebSearch-corroborated by at
 * least 3 independent secondary sources per code, reprinting the SAME
 * product's SAME printed code): CPA-PS is Paul Skenes AND Paulino Santana;
 * checklistinsider's own 2024 Bowman Chrome checklist page independently
 * documents CPA-PS as a duplicate, alongside CPA-GD and CPA-JF.
 *
 * THIS IS DIFFERENT FROM initialsCollisionPark.ts. That table is for a
 * number that collides ACROSS TWO PRODUCTS (2026 Bowman CPA-AG is a
 * different card from 2026 Bowman CHROME CPA-AG) -- the product word
 * itself disambiguates once it is read, and a sale naming neither player is
 * parked with NO id at all. This table is for a code that collides WITHIN
 * ONE product/checklist -- there is no product word to fall back on, because
 * both cards are the same product. The only way to tell them apart is the
 * player, and once the player is known (from the catalog row, or resolved
 * from the sale's own title) BOTH cards get a real, priceable id -- they are
 * not parked, because refusing to price a Paul Skenes rookie auto because
 * Topps printed the same code twice would be a worse outcome than a one-word
 * disambiguating segment.
 *
 * THE FIX. `computeHobbyIqCardId` mints `<code>-<surname-slug>` for the
 * cardNumber segment ONLY for a registered (sport, year, setKey, code) --
 * chosen by the row's playerName (catalog) or the sale's title-resolved
 * player (sales, via `resolveCodeCollisionPlayer` below). Every other code,
 * including every OTHER Bowman/Bowman Chrome CPA code not in this table,
 * stays byte-identical to today -- absence from this table is not a defect,
 * it means the checklist printed that code once.
 *
 * ADDING A ROW IS A RULING, not a guess: an entry must be backed by the
 * checklist-verified audit's per-code table (class (i), "true Topps
 * collision"), never a matcher's suspicion. CPA-ES is now CONFIRMED for both
 * claimants (SportsCardInvestor + eBay, Orange Lava Refractor /25, Red Wave
 * Refractor /5, audit 2026-09-28) and is wired into the active table below.
 * CPA-GD and CPA-JF are named by
 * checklistinsider as duplicates of the same class, but no source read by
 * this audit carries the two players' names for either code, so they are
 * ALSO excluded pending that lookup. Minting a surname slug from a guessed
 * name would be worse than leaving the code unregistered: an unregistered
 * code still refuses cleanly (CF-ABSENT-BEATS-WRONG) rather than mint an
 * address for a player who was never confirmed on the card.
 *
 * Pure: no I/O, no Cosmos, no clock.
 */

export interface CodeCollisionClaimant {
  /** The full printed/checklist player name, e.g. "Paul Skenes". */
  readonly playerName: string;
  /** The slug appended to the cardNumber segment: `cpa-ps-skenes`. Must be
   *  distinct from every other claimant's slug for this code (enforced by
   *  the validity test) -- a code whose two players share a surname needs a
   *  design decision from Drew, not a silent collision here. */
  readonly surnameSlug: string;
}

export interface CodeCollisionEntry {
  readonly sport: string;
  readonly year: number;
  readonly setKey: string;
  readonly code: string;
  readonly claimants: readonly [CodeCollisionClaimant, CodeCollisionClaimant, ...CodeCollisionClaimant[]];
  /** The audit / source citation for the reviewer. Documentation only --
   *  nothing here is read at runtime. */
  readonly source: string;
}

/**
 * CPA- codes are letters-then-hyphen-then-initials; the surname slug is
 * derived from the LAST WORD of the printed name (drops suffixes like "Jr."
 * by taking the final alphabetic token, which for every confirmed entry
 * below IS the surname -- checked by the validity test, not assumed).
 */
function surnameSlugOf(fullName: string): string {
  const tokens = String(fullName)
    .trim()
    .split(/\s+/)
    .filter((t) => /[a-zA-Z]/.test(t));
  const last = tokens[tokens.length - 1] ?? "";
  return last
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w-]/g, "")
    .replace(/_/g, "-");
}

function claimant(playerName: string): CodeCollisionClaimant {
  return { playerName, surnameSlug: surnameSlugOf(playerName) };
}

/**
 * THE 14 CONFIRMED CODES (2026-09-28 checklist-verified audit, class (i)).
 * Every entry: 2024 Bowman Chrome, setKey `bowman-chrome`, sport baseball.
 */
export const CODE_COLLISIONS: readonly CodeCollisionEntry[] = [
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-PS",
    claimants: [claimant("Paul Skenes"), claimant("Paulino Santana")],
    source: "checklistinsider 2024 Bowman Chrome checklist documents CPA-PS as a printed duplicate; corroborated by GameStop/Goldin/Fanatics/SportsCardInvestor/sportscardspro (Skenes) and eBay/SportsCardInvestor (Santana)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-ET",
    claimants: [claimant("Erick Torres"), claimant("Eduardo Tait")],
    source: "eBay/COMC/sportscardspro (Torres) and eBay/COMC/VCP/sportscardspro incl. CSPA-ET Sapphire variant (Tait)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-EB",
    claimants: [claimant("Eduardo Beltre"), claimant("Erick Bautista")],
    source: "eBay/SportsCardInvestor, 51 tracked variations (Beltre) and eBay/PSA auction prices/sportscardspro (Bautista)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-ETE",
    claimants: [claimant("Emiliano Teodo"), claimant("Enmanuel Tejeda")],
    source: "eBay/sportscardspro incl. CSPA-ETE Sapphire variant (Teodo) and eBay/PSA auction prices/COMC (Tejeda)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-AS",
    claimants: [claimant("Anthony Scull"), claimant("Adolfo Sanchez")],
    source: "eBay/SportsCardInvestor, 24 tracked variations (Scull) and eBay listings under CPA-AS, raw-10 auto (Sanchez)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-YM",
    claimants: [claimant("Yohandy Morales"), claimant("Yordanny Monegro")],
    source: "eBay/COMC BCP-52 base (Morales) and eBay/sportscardspro (Monegro)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-EV",
    claimants: [claimant("Esmerlyn Valdez"), claimant("Echedry Vargas")],
    source: "eBay/PSA/sportscardspro (Valdez) and eBay/COMC/sportscardspro incl. CSPA-EV Sapphire variant (Vargas)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-DB",
    claimants: [claimant("Diego Benitez"), claimant("Derek Bernard")],
    source: "eBay/SportsCardInvestor/sportscardspro (Benitez) and eBay/Sportscard Superstore (Bernard)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-AR",
    claimants: [claimant("Agustin Ramirez"), claimant("Adriel Radney")],
    source: "eBay/Veriswap/Goldin/COMC/sportscardspro (Ramirez) and MLBShop listing CPAAR Adriel Radney (Radney)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-JR",
    claimants: [claimant("Jensy Rivas"), claimant("Jesus Rodriguez")],
    source: "eBay, 6+ parallels, MLBShop CPAJR (Rivas) and eBay listing naming Jesus Rodriguez under CPA-JR (Rodriguez)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-JA",
    claimants: [claimant("Jadher Areinamo"), claimant("Jalvin Arias")],
    source: "eBay/PSA auction prices/COMC, 3 parallels/sportscardspro (Areinamo) and eBay listing naming Jalvin Arias under CPA-JA (Arias)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-BM",
    claimants: [claimant("Brice Matthews"), claimant("Braylin Morel")],
    source: "eBay/SportsCardInvestor/GameStop (Matthews) and Fanatics Collect, CPA-BM Braylin Morel RC Auto (Morel). One stray Braden Montgomery row is unexplained and needs a separate targeted check -- not folded into either claimant." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-JB",
    claimants: [claimant("Jacob Burke"), claimant("Jake Bloss")],
    source: "eBay, CPA-JB WHITE SOX (Burke) and eBay/COMC/Beckett live product-checklist subpage for HTA Choice Refractors/SportsCardDatabase (Bloss)." },
  { sport: "baseball", year: 2024, setKey: "bowman-chrome", code: "CPA-ES",
    claimants: [claimant("Estuar Suero"), claimant("Emilio Sanchez")],
    source: "SportsCardInvestor + eBay (Orange Lava Refractor /25, Red Wave Refractor /5), audit 2026-09-28." },

  // -- PROVISIONAL / EXCLUDED. Documented for the follow-up audit, NOT wired
  // into COLLISION_INDEX below. Do not use these until a ruling confirms
  // them and moves them into CODE_COLLISIONS proper.
  //
  // CPA-GD, CPA-JF: named by checklistinsider as duplicates of the same
  // class as CPA-PS, but no source read by the audit carries either code's
  // two player names. Excluded until that lookup is done -- see the header.
] satisfies readonly CodeCollisionEntry[];

/**
 * PLACEHOLDER -- Prizm SS-XX (basketball/football initials-numbered inserts)
 * is the SAME CLASS as the CPA collisions above (memory: "Initials-numbered
 * inserts collide in the id" -- #2091, 09-27: "Prizm SS-XX: 18/100 numbers
 * hold two players; id has no player axis; ruling needed"), and the caller
 * needs the shape proven for a non-baseball, non-CPA code too. No real pair
 * has been recorded in memory or found in this repo's docs/tests as of this
 * ruling -- the 18 real (sport, year, setKey, code) triples still need the
 * same checklist-verified audit CPA got before they can be registered here.
 *
 * This entry is FICTIONAL and must never be treated as a real ruling: it
 * exists only so the id-minting SHAPE (a non-CPA prefix, a different sport)
 * is exercised by a test before the real Prizm data lands. Do not ship a
 * catalog write or a repoint list against `ss-99`; it names no real card.
 */
export const PRIZM_SS_XX_PLACEHOLDER: CodeCollisionEntry = {
  sport: "basketball",
  year: 2024,
  setKey: "panini-prizm",
  code: "SS-99",
  claimants: [claimant("Placeholder Player One"), claimant("Placeholder Player Two")],
  source: "PLACEHOLDER -- no real Prizm SS-XX pair recorded yet (see memory "
    + "\"Initials-numbered inserts collide in the id\", #2091 09-27). Not a "
    + "ruling; not registered in CODE_COLLISIONS; exists only to prove the "
    + "id shape works outside baseball/CPA before real data lands.",
};

/** Hyphen- and case-insensitive, matching foldCardNumber's comparison. */
function foldCode(code: string | null | undefined): string {
  return String(code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COLLISION_INDEX: ReadonlyMap<string, CodeCollisionEntry> = new Map(
  CODE_COLLISIONS.map((c) => [
    `${c.sport.toLowerCase()}|${c.year}|${c.setKey.toLowerCase()}|${foldCode(c.code)}`,
    c,
  ]),
);

/** Is this (sport, year, setKey, code) a REGISTERED same-product collision? */
export function findCodeCollision(input: {
  sport?: string | null;
  year?: number | string | null;
  setKey?: string | null;
  code?: string | null;
}): CodeCollisionEntry | null {
  const sport = String(input?.sport ?? "").toLowerCase().trim();
  const setKey = String(input?.setKey ?? "").toLowerCase().trim();
  const year = Number(input?.year);
  const code = foldCode(input?.code);
  if (!sport || !setKey || !Number.isFinite(year) || !code) return null;
  return COLLISION_INDEX.get(`${sport}|${year}|${setKey}|${code}`) ?? null;
}

/**
 * Resolve WHICH claimant a playerName names, for a registered collision.
 * Matches on `playerIdentityKey`-equivalent folding (letters+digits only,
 * lowercase) so punctuation/case differences never cause a false UNDERIVABLE.
 * Returns null when the name matches none of the claimants -- never a guess.
 */
export function resolveCodeCollisionClaimant(
  entry: CodeCollisionEntry,
  playerName: string | null | undefined,
): CodeCollisionClaimant | null {
  const key = String(playerName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  for (const c of entry.claimants) {
    const ck = c.playerName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ck === key) return c;
  }
  return null;
}

/**
 * CF-TITLE-NAMES-EXACTLY-ONE-OR-UNDERIVABLE (the R34-style resolution). A
 * sale has no `playerName` field the way a catalog row does -- only a title
 * string. This resolves a registered collision from a title by requiring
 * the title to name EXACTLY ONE of the entry's claimants (by surname, case-
 * insensitive, word-boundary matched so "Bloss" does not also match inside
 * a longer token). Naming NONE or naming BOTH is UNDERIVABLE -- never a
 * guess, same doctrine as resolveT206ChecklistPosition's disambiguation.
 */
export function resolveCodeCollisionFromTitle(
  entry: CodeCollisionEntry,
  title: string | null | undefined,
): CodeCollisionClaimant | null {
  const t = String(title ?? "").toLowerCase();
  if (!t) return null;
  const hits: CodeCollisionClaimant[] = [];
  for (const c of entry.claimants) {
    const surname = c.surnameSlug.replace(/-/g, "[\\s-]*");
    const re = new RegExp(`\\b${surname}\\b`, "i");
    if (re.test(t)) hits.push(c);
  }
  return hits.length === 1 ? hits[0] : null;
}
