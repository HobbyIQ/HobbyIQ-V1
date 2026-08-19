// CF-PARSE-TITLE-IDENTITY (Drew, 2026-07-23, issue #722). Extract a
// (cardNumber, parallel, isAuto, printRun) tuple from a marketplace
// listing title. Foundational module for the persist-on-lookup
// pipeline — every vendor row we ingest goes through this parser
// so its identity ends up canonical + matchable to hobbyiqCardId.
//
// Extracted from the scratchpad ingest scripts (v3/v5/v7) that shipped
// Owen Carey Sapphire + Eric Hartman + Gage Wood on 2026-07-23.
//
// DESIGN
// - Pure function. No I/O.
// - Case-insensitive.
// - Whitelist over guess: parallel matches specific recognized patterns;
//   unrecognized text keeps parallel = "Base".
// - cardNumber extraction is regex-first; caller can pass a narrower
//   whitelist when the target card is known (e.g. "only accept CPA-EHA
//   for Eric Hartman queries") via the optional cardNumberRe.

// CF-SERIAL-IS-NOT-A-CARDNUMBER (Drew, 2026-08-14: "fix it").
//
// The TCG `POS/TOTAL` card-number rule below had no vertical guard, so it fired
// on SPORTS titles too, where `N/M` means something completely different:
//
//   "Macklin Celebrini OL 22/30"
//     cardNumber "22/30" -> slug ...:2230:...  + printRun 30
//
// 22/30 is a SERIAL. The real card number is "OL", sitting in the same title,
// discarded. One token consumed twice, and the resulting slug can never match —
// no checklist contains card #2230. Verified against raw titles: 206 of 208
// decided cases were this bug (99%), covering ~6,500 slugs and ~32,000 stuck
// sales, with ~5,600 phantom cards already in sold_comps.
//
// The Pokemon half is the mirror image. There, "40/147" really IS the card
// number (card 40 of a 147-card set) — but extractPrintRun ALSO read 147 as a
// print run, so the slug carried `:num-147` and matched nothing. A set size is
// not a print run.
//
// Both halves are the same root cause: the `N/M` token was interpreted without
// asking what it means in this vertical. So the vertical now decides. It is
// taken from the caller when known, and otherwise detected from the title by
// classifyTcg — the same pure classifier the ingest path already uses, so the
// two cannot disagree.
import { classifyTcg } from "./tcgVertical.service.js";

/** TCG `POS/TOTAL` card number, e.g. "008/132". Position CAN exceed the total
 *  (secret/hyper rares are numbered above set size), so only the <=400 bound
 *  is enforced, not num <= total.
 *
 *  The `#` in the leading class matters: sellers write BOTH "40/147" and
 *  "#044/193". Without it the generic #-prefix rule wins on the second form,
 *  returns "044", and silently drops the set half — which is a different card
 *  number and matches nothing. */
const TCG_NUMBER_RE = /(?:^|[\s#])(\d{1,3})\/(\d{1,3})(?:\s|$)/;
/** Global twin of the above, used to REMOVE the token before print-run
 *  extraction so a set size is never mistaken for a print run. */
const TCG_NUMBER_RE_G = /(?:^|[\s#])(\d{1,3})\/(\d{1,3})(?=\s|$)/g;

export interface ParseListingIdentityOptions {
  /** Vertical when the caller already knows it (vendor feed field, resolved
   *  slug, etc). Authoritative — checked before title detection. */
  vertical?: string | null;
  /** Canonical slug when available. Carries the setKey, which survives in
   *  cases where the title is too terse to classify. */
  hobbyiqCardId?: string | null;
}

export interface ParsedListingIdentity {
  cardNumber: string | null;
  parallel: string;
  isAuto: boolean;
  printRun: number | null;
  autoStyle: "on-card" | "sticker" | null;
  /** CF-GRADE-FROM-TITLE (Drew, 2026-08-01). "PSA 9", "BGS 9.5", "SGC 10",
   *  "PSA 10 GEM MINT" etc. — extracted from title. Null when raw. */
  gradeCompany: "PSA" | "BGS" | "SGC" | "CGC" | "HGA" | null;
  gradeValue: number | null;
}

// CF-GRADE-FROM-TITLE (Drew, 2026-08-01). Matches:
//   "PSA 9", "PSA 10", "PSA 10 GEM MINT", "PSA GEM MT 10",
//   "BGS 9.5", "BGS 10 PRISTINE", "SGC 10", "SGC 9.5",
//   "CGC 10", "CGC 9.5", "HGA 9"
// Value: 1-10, half-point steps for BGS/SGC/CGC.
const GRADE_RE = /\b(PSA|BGS|SGC|CGC|HGA)\s+(?:GEM\s+M(?:INT|T)\s+|PRISTINE\s+|MINT\s+)?(\d{1,2}(?:\.5)?)\b/i;

export function extractGradeFromTitle(title: string): { gradeCompany: "PSA" | "BGS" | "SGC" | "CGC" | "HGA" | null; gradeValue: number | null } {
  if (!title) return { gradeCompany: null, gradeValue: null };
  const m = String(title).match(GRADE_RE);
  if (!m) return { gradeCompany: null, gradeValue: null };
  const company = m[1].toUpperCase() as "PSA" | "BGS" | "SGC" | "CGC" | "HGA";
  const value = Number(m[2]);
  if (!Number.isFinite(value) || value < 1 || value > 10) return { gradeCompany: null, gradeValue: null };
  return { gradeCompany: company, gradeValue: value };
}

/** Default cardNumber regex — matches the common Bowman/Topps/Panini
 *  slab-printed formats. Caller-passed regexes take precedence when a
 *  specific target is known. */
// CF-PAPER-AUTO-CARDNUMBERS (Drew, 2026-07-29). Bowman flagship (paper)
// carries autograph subsets on paper stock — Bowman Prospect Autographs
// (BPA-XX), Bowman Draft Autographs (BDA-XX), Bowman Chrome Rookie Autos
// on paper (BCRA-XX overlaps chrome variant), Topps Chrome Rookie Autos
// paper (TCRA-XX). Card-number prefix is the disambiguating signal —
// CPA/BCPA/BCDA/BDPA on chrome stock, BPA/BDA on paper stock.
//
// CF-HERITAGE-BARE-CARDNUMBER (Drew, 2026-07-29). Topps Heritage +
// vintage Topps use bare digit card numbers like #136, #500. The prior
// regex required 1-3 leading letters before digits, so #136 got no
// match and Heritage rows shipped with cardNumber=null. Now accepts
// 1-4 pure digits after '#' as a fallback alternative.
// CF-CARDNUM-LOOSEN (Drew, 2026-08-02). Original regex required `#` with
// zero whitespace before the number. Real eBay titles from the TCA
// firehose showed 30% of skips are titles with `# NN` (space between)
// or `NN` standalone in a card-number-shaped position. Add `\s*` after
// the `#` and preserve the strict letter-prefix formats for high-signal
// SKUs like BCP-102 / CPA-EH / US175.
const DEFAULT_CARD_NUMBER_RE =
  /#\s*([A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4}|BCP-\d+|CPA-\w+|BSPA-\w+|BCPA-\w+|BDCA-\w+|BPA-\w+|BDA-\w+|BCRA-\w+|TCRA-\w+|CPALD|CPATWH|BDC-\d+|HL\d+|US\d+|\d{1,4})\b/i;

// CF-CARDNUM-STANDALONE (Drew, 2026-08-02). Second-chance regex for when
// the title has no `#` at all but a plausible card-number-shaped token
// appears after the year+set+player triple. Requires the token to be
// preceded by whitespace and followed by whitespace / EOL / PSA-style
// grader, and to NOT be a print run (no leading `/`).
// Example: "2023 PANINI SELECT GOLD GLITTER JALEN BRUNSON 194 PSA 10" → 194
const STANDALONE_CARD_NUMBER_RE =
  /(?:^|\s)(\d{1,4})(?=\s+(?:PSA|BGS|SGC|CGC|BVG|HGA|GEM|MINT|NM|RC|ROOKIE|GRADED|RAW|$))/i;

// Note: `on card` alone does NOT imply auto — "On Card Display" and
// similar non-auto phrases exist. Explicit \bauto\b or "autograph" or
// "hard signed" are required. When "On Card Auto" appears, \bauto\b
// picks it up.
const AUTO_RE = /\bauto\b|autograph|hard[-\s]signed/i;
/** Phrases that mean the card is NOT signed, despite containing "auto".
 *
 *  CF-NON-AUTO-IS-NOT-AUTO (2026-08-19). This only listed "auto relic" and
 *  "auto patch", so `\bauto\b` matched the "Auto" inside "Non Auto" and every
 *  one of these parsed as SIGNED:
 *
 *    "WALKER JENKINS RC REFRACTOR ... Non Auto Rookie Holo"        -> isAuto true
 *    "2026 Bowman Chrome /199 Fuchsia Konnor Griffin Non-Auto"     -> isAuto true
 *    "2019 Bowman Prospects Yordan Alvarez #BP-123 ... Non Auto"   -> isAuto true
 *
 *  A $22.49 unsigned base card then sits in a signed card's comp pool and drags
 *  its floor — found while auditing a user's Walker Jenkins /499 refractor auto,
 *  whose pool ran from $22.49 to $769.
 *
 *  Note this governs the TITLE TEXT only. The card number remains the boundary
 *  (isCardNumberAutoSubset is OR'd in separately), so a CPA- number still reads
 *  as an auto even if a seller typed something careless. */
const AUTO_NEGATIVE_RE =
  /auto\s+relic|auto\s+patch|\bnon[-\s]?auto|\bno\s+auto|\bnot\s+auto|\bunsigned\b|\bwithout\s+auto/i;

/** Extract identity from a marketplace title.
 *
 *  When cardNumberRe is provided, only that pattern is tried (useful
 *  when the caller knows the target card and wants to reject rows for
 *  other cards from the same search response). */
export function parseListingIdentity(
  title: string,
  cardNumberRe?: RegExp,
  opts?: ParseListingIdentityOptions,
): ParsedListingIdentity {
  const t = String(title ?? "");
  // CF-SERIAL-IS-NOT-A-CARDNUMBER. Decide the vertical ONCE, then let it govern
  // both readings of the `N/M` token. Callers that know the vertical should say
  // so — title detection is a fallback, and a Pokemon listing too terse to
  // classify will now yield cardNumber=null rather than a confidently wrong
  // number. Null is recoverable; a wrong identity silently files a real sale
  // against a card that does not exist.
  const isTcg = classifyTcg({
    sport: opts?.vertical ?? null,
    title: t,
    hobbyiqCardId: opts?.hobbyiqCardId ?? null,
  }).isTcg;
  const cardNumber = extractCardNumber(t, cardNumberRe, isTcg);
  // CF-CARDNUMBER-IMPLIES-AUTO (Drew, 2026-07-30). Auto-subset card
  // numbers carry a fixed prefix on ALL products — CPA-, BCPA-, BSPA-,
  // BDA-, BPA-, BCRA-, TCRA-, CA-, SPA-, CPALD-, etc. If the title
  // failed the AUTO_RE check but the card number is one of these,
  // trust the card number. This rescues terse marketplace titles that
  // omit "auto" but list a #CPA-XXX card number (very common when
  // sellers use CH's slab-derived title).
  const isAuto = extractIsAuto(t) || isCardNumberAutoSubset(cardNumber);
  const grade = extractGradeFromTitle(t);
  return {
    cardNumber,
    parallel: extractParallel(t),
    isAuto,
    printRun: extractPrintRun(t, isTcg),
    autoStyle: isAuto ? extractAutoStyle(t) : null,
    gradeCompany: grade.gradeCompany,
    gradeValue: grade.gradeValue,
  };
}

/** True when the cardNumber prefix belongs to a known BASEBALL autograph
 *  subset. Domain-curated list from Drew (2026-07-30) — where an
 *  empirically-low auto ratio contradicts the list, that's a signal
 *  that parser text-extraction is UNDER-tagging these products, which
 *  is exactly what this rule (+ backfill-isauto-from-cardnumber.cjs)
 *  is designed to fix.
 *
 *  BOWMAN FAMILY (all 100% auto by product definition):
 *    CPA   Chrome Prospect Autographs (Bowman/Bowman Chrome flagship 1st)
 *    CDA   Chrome Draft Pick Autographs (Bowman Draft)
 *    CRA   Chrome Rookie Autographs
 *    BPA   Bowman Prospect Autographs (paper, retail)
 *    PA    Paper Prospect Autographs / Bowman Inception Prospect Autos
 *    BSPA  Bowman Sterling Prospect Autographs (2016+)
 *    BGA   Bowman Glass Autographs (Draft insert)
 *    MRA   Mood Ring Autographs (Draft insert)
 *    DPPA  Draft Picks & Prospects Autographs
 *    54FAV Bowman '54 Flag Variation Autographs
 *    FFDA  Franchise Futures Dual Autographs
 *    APDCA Applied Pressure Autographs (Draft)
 *    UAC   Ultimate Autograph Book Card
 *    BA    Bowman's Best Autographs
 *    B96A  Bowman's Best "Best of '96" Autographs
 *    C##A  Class of [Year] Autographs (year-varying, C20A/C23A/etc)
 *
 *  TOPPS CHROME / CHROME-ADJACENT:
 *    RA    Topps Chrome Rookie Autographs (flagship auto)
 *    CUSA  Chrome Update Series Autographs
 *    CBA   Topps Chrome Black Autographs
 *    CCA   Cosmic Chrome Autographs
 *    FSA   Future Stars Autographs / Five Star Autographs (collision, both auto)
 *
 *  TOPPS HERITAGE:
 *    ROA   Real One Autographs
 *    RODA  Real One Dual Autographs
 *    ROTA  Real One Triple Autographs
 *    CCAR  Clubhouse Collection Autograph Relics
 *    FAR   Flashback Autograph Relics
 *
 *  OTHER TOPPS:
 *    GQA   Gypsy Queen Autographs
 *    FFA   Archives Fan Favorites Autographs
 *    AGA   Allen & Ginter Framed Autographs
 *    BSA   Baseball Stars Autographs (2021+)
 *    SCA   Stadium Club Autographs
 *    T1A   Tier One Autographs
 *    BOA   Tier One Break Out Autographs
 *    PPA   Tier One Prime Performers Autographs
 *    TA    Tribute Autographs
 *    AA    Museum Collection Archival Autographs
 *    DCA   Definitive Autograph Collection
 *    CAA   Clearly Authentic Autographs
 *    FA    Finest Autographs / Fire Autographs (collision, both auto)
 *    ODA   Opening Day Autographs
 *    TTAR  Triple Threads Autograph Relics
 *    UAR   Triple Threads Unity Autograph Relics
 *    IAP   Inception Autograph Patch
 *    AP    Dynasty Autograph Patches
 *
 *  PLUS earlier empirical additions:
 *    USA   Update Series Autographs — 100%, n=516
 *    SCCA  Sterling Chrome Certified — 93.3%, n=445
 *    DAS   Draft Autograph Series — 100%, n=254
 *    NTS   National Treasures Signatures — 100%, n=137
 *    SSM   Sterling Signature Materials — 100%, n=116
 *    CPALD, CPATWH  Chrome Prospect Auto special CH variants
 *    BCPA, BCRA, TCRA  Bowman Chrome Prospect/Rookie + Topps Chrome Rookie
 *                       (product convention, sub-100 sample)
 *
 *  Regex ordering: LONGEST alternatives first because JS regex
 *  alternation is left-to-right (not longest-match). "APDCA" MUST
 *  come before "AP" or every APDCA-XX would match as AP prefix.
 *
 *  Sport-awareness: currently BASEBALL-scoped implicitly (Drew's list).
 *  Football/basketball/hockey have their own auto-prefix vocab; this
 *  function may over-tag when applied cross-sport. Consider adding a
 *  sport param when we expand to other sports.
 *
 *  Silent-safe on null/empty. */
export function isCardNumberAutoSubset(cardNumber: string | null): boolean {
  if (!cardNumber) return false;
  const cn = String(cardNumber).toUpperCase().replace(/^#/, "");
  return /^(CPATWH|CPALD|APDCA|54FAV|FFDA|CUSA|SCCA|CCAR|RODA|ROTA|TTAR|DPPA|BSPA|BCPA|BCRA|TCRA|B96A|BGA|MRA|UAC|BSA|FSA|CPA|CDA|CRA|BPA|CBA|CCA|USA|DAS|NTS|SSM|DCA|CAA|GQA|AGA|ROA|FAR|FFA|BOA|T1A|SCA|PPA|ODA|IAP|UAR|C\d{2}A|BA|PA|RA|FA|TA|AA|AP)(-|$)/.test(cn);
}

// CF-INSERT-DETECTION (Drew, 2026-07-30). Inserts are separate card
// sets within a product — a "Bowman BTP-10 Scouts' Top 100 Refractor"
// is NOT the same card (or FMV pool) as a base Bowman #10 Refractor.
// Currently the parser conflates them: cardNumber "BTP-10" gets slugged
// as `hiq:baseball:2024:bowman:btp-10:refractor:no-auto` — same pool
// as any BTP-10 might land in, and separate from where OTHER insert
// numbers land.
//
// This function detects when a cardNumber prefix (or anniversary year
// stamp) indicates an insert set and returns the compound insert-name
// slug. Callers combine it with the base setKey to produce
// setKey = `${base}-${insertSlug}` (e.g. bowman-scouts-top-100).
//
// Curated from Drew's baseball insert vocabulary (2026-07-30):
//
//   BOWMAN inserts (2013+):
//     BTP  Scouts' Top 100
//     BSP  Bowman Spotlights
//     MR   Mood Ring        (also Draft variant)
//     DPP  Draft Picks & Prospects
//     TT   Transformative Talent
//     54F  Bowman '54       (design-throwback)
//   TOPPS FLAGSHIP inserts:
//     HRC  Home Run Challenge
//     SMLB Stars of MLB
//     CC   City Connect
//     GOAT Greatest of All Time  (varies by year, sometimes prefixed differently)
//     HA   Heavy Artillery
//   TOPPS CHROME inserts:
//     FS   Future Stars
//     USC  Ultraviolet (colored inserts, year-varying)
//   TOPPS HERITAGE inserts:
//     NF   New Age Performers (some years)
//     TAN  Then and Now
//     BF   Baseball Flashbacks
//     NAP  New Age Performers (canonical prefix)
//   ANNIVERSARY year-stamped: pattern ^\d{2}[A-Z]{1,4}-  (85TF, 87ASA,
//     88BF, 89BC, 87TB, etc.) — design-year prefix + insert-code suffix
//
// Returns null when the cardNumber doesn't match any known insert
// prefix — caller keeps the base setKey unchanged. */
export function detectInsertSet(cardNumber: string | null): string | null {
  if (!cardNumber) return null;
  const cn = String(cardNumber).toUpperCase().replace(/^#/, "");
  // Ordered longest-first for correct alternation matching.
  const map: Array<[RegExp, string]> = [
    // 4+ char prefixes
    [/^SMLB-/, "stars-of-mlb"],
    [/^GOAT-/, "greatest-of-all-time"],
    // 3-char
    [/^BTP-/, "scouts-top-100"],
    [/^BSP-/, "spotlights"],
    [/^DPP-/, "draft-picks-prospects"],
    [/^HRC-/, "home-run-challenge"],
    [/^USC-/, "ultraviolet"],
    [/^NAP-/, "new-age-performers"],
    [/^TAN-/, "then-and-now"],
    // 2-char
    [/^CC-/, "city-connect"],
    [/^HA-/, "heavy-artillery"],
    [/^FS-/, "future-stars"],
    [/^MR-/, "mood-ring"],
    [/^TT-/, "transformative-talent"],
    [/^NF-/, "new-age-performers"],
    [/^BF-/, "baseball-flashbacks"],
    [/^54F-/, "bowman-54"],
    // Anniversary year-stamped (85TF, 87ASA, 88BF, 89BC — 2-digit year
    // + 1-4 letters). The letter code is variable per year/product;
    // we route to a generic "anniversary" bucket keyed by the letters
    // for later disambiguation. Alt: return "anniversary-{letters}" so
    // 85TF and 89BC end up in the same "TF"/"BC" insert pool across
    // decades. That's the safer default.
  ];
  for (const [re, slug] of map) {
    if (re.test(cn)) return slug;
  }
  // Anniversary regex — extract the letter suffix as the insert code.
  const anniversary = cn.match(/^(\d{2})([A-Z]{1,4})-/);
  if (anniversary) return `anniversary-${anniversary[2].toLowerCase()}`;
  return null;
}

// CF-UNIFIED-AUTO-INFERENCE (Drew, 2026-07-30). Sport-aware auto
// detection that consolidates every signal:
//   - Title text ("auto" / "autograph" / "hard signed")
//   - Baseball cardNumber prefix (via isCardNumberAutoSubset)
//   - Football-specific cardNumber prefixes (WT for Winning Ticket +
//     baseball prefixes that also work in football: RA/BA/PA)
//   - Basketball + football setName keyword ("Signatures", "Autographs",
//     "Ink", "Penmanship", "Rookie Ticket", "Season Ticket", etc.)
//     — this is the PRIMARY rule for Panini basketball (2009-2024) and
//     Panini football (2016-2025) which don't use prefixes at all
//
// Traps (NOT handled by this function — need slab OCR):
//   - Contenders "Rookie Ticket" autos numbered within base set
//   - Nat'l Treasures / Immaculate / Flawless RPAs numbered within base
//   - Prizm veteran auto parallels sharing base card number
// For those, the caller (image-verify Tier-2a slab OCR) is authoritative.

/** Case-insensitive keyword regex covering auto-set NAMES across
 *  Panini + Topps NBA/NFL. Broad but conservative — must match a full
 *  word/phrase, not a substring inside another word. Includes both
 *  auto keywords and product families that ARE 100% auto (Ink,
 *  Penmanship, Rookie Ticket, Real One, etc.). */
const AUTO_SETNAME_RE = /\b(?:signatures?|autographs?|hard[-\s]signed|signature\s+(?:series|blend|style|class)|rookie\s+(?:signatures?|ticket|photo\s+shoot|premiere\s+materials)|season\s+ticket|playoff\s+ticket|championship\s+ticket|winning\s+ticket|clutch\s+gene|next\s+day\s+auto|penmanship|scripts?|signings?|significance|silhouettes?|ink\b|hot\s+signatures?|sensational\s+signatures?|great\s+significance|shadow\s+scripts?|manuscripts?|eternal\s+marks?|hoop\s+signs?|chromographs?|autograph\s+issue|real\s+one|sign\s+of\s+the\s+times|sott|volcanic\s+signatures?|aurora\s+ink|elusive\s+ink|cactus\s+ink|fresh\s+paint|heir\s+apparent|next\s+stop\s+signatures?|skywrite\s+signatures?|stratospheric\s+signatures?|1989\s+signatures?|hyper\s+signatures?|crystal\s+clear\s+autographs?|fast\s+break\s+autographs?|in\s+flight\s+signatures?|signature\s+series|rated\s+rookies?\s+signatures?|autograph\s+patch|dynasty\s+autograph|nfl\s+ink|breakout\s+autographs?|dual\s+autographs?|triple\s+autographs?|quad\s+autographs?|clearly\s+authentic|definitive\s+autographs?|flashback\s+autograph|framed\s+autographs?|prime\s+performers|tier\s+one\s+auto|clubhouse\s+collection\s+auto|inception\s+auto|hometown\s+heroes\s+auto|tribute\s+auto|museum\s+collection\s+auto|allen[-\s]?(?:and\s+)?ginter\s+auto|gypsy\s+queen\s+auto|opening\s+day\s+auto|five\s+star\s+auto|dynasty\s+patch\s+auto|1st\s+bowman(?:\s+chrome)?\s+auto)\b/i;

/** Football-specific cardNumber prefixes NOT in the baseball list.
 *  WT = Winning Ticket (Contenders). Baseball prefixes RA/BA/PA also
 *  work in football (draft/collegiate products), so
 *  isCardNumberAutoSubset already covers them. */
function isFootballCardNumberAutoSubset(cardNumber: string | null): boolean {
  if (!cardNumber) return false;
  const cn = String(cardNumber).toUpperCase().replace(/^#/, "");
  return /^(WT|SOT)(-|$)/.test(cn);
}

export interface InferIsAutoInput {
  sport?: string | null;               // "baseball" | "football" | "basketball" | "hockey" | null
  cardNumber?: string | null;
  setName?: string | null;             // full product/insert name if known
  titleHasAutoText?: boolean;          // pre-computed from extractIsAuto if available
}

/** Sport-aware isAuto inference — the ONE function callers should use
 *  when they have context beyond a raw title. Combines every signal
 *  and short-circuits on the first positive.
 *
 *  Returns true if ANY of:
 *    1. Title has explicit auto text (extractIsAuto)
 *    2. Baseball or football: cardNumber prefix on the curated list
 *    3. Football-only: Winning Ticket / SOT prefix
 *    4. Any sport: setName matches AUTO_SETNAME_RE
 *
 *  Never returns true just from being "possibly" an auto — bar is
 *  "one clear positive signal". Slab OCR is a separate authoritative
 *  path for numbered-within-base autos. */
export function inferIsAuto(input: InferIsAutoInput): boolean {
  if (input.titleHasAutoText === true) return true;

  const sport = (input.sport ?? "").toLowerCase();
  // Baseball + football + hockey (rare): prefix rule.
  // Basketball Panini era has NO prefix vocabulary — skip prefix rule
  // for basketball unless the sport hint is unset (safer default).
  if (sport !== "basketball") {
    if (isCardNumberAutoSubset(input.cardNumber ?? null)) return true;
  }
  if (sport === "football" && isFootballCardNumberAutoSubset(input.cardNumber ?? null)) return true;

  // Any sport: setName keyword.
  if (input.setName && AUTO_SETNAME_RE.test(input.setName)) return true;

  return false;
}

function extractCardNumber(title: string, cardNumberRe?: RegExp, isTcg = false): string | null {
  // CF-TCG-NUMBER-BEFORE-HASH (Drew, 2026-08-14). In TCG the POS/TOTAL rule
  // must run FIRST. Sellers write the number both ways — "40/147" and
  // "#044/193" — and on the second form the generic #-prefix rule below
  // matches "044" and returns early, dropping "/193". That is not a smaller
  // answer, it is a DIFFERENT card number, and it matches no catalog row.
  //
  // Caught only by running the verbatim listing title through the compiled
  // parser: the unit test had been written against the same title with the
  // "#" removed, so it passed while the real input failed.
  if (isTcg && !cardNumberRe) {
    const tcg = title.match(TCG_NUMBER_RE);
    if (tcg) {
      const num = Number(tcg[1]); const total = Number(tcg[2]);
      if (num > 0 && num <= 400 && total > 0 && total <= 400) {
        return `${tcg[1]}/${tcg[2]}`;
      }
    }
  }
  const re = cardNumberRe ?? DEFAULT_CARD_NUMBER_RE;
  const m = title.match(re);
  if (m) return m[1].toUpperCase();
  // CF-CARDNUM-STANDALONE fallback — only tried when the primary #-prefix
  // regex didn't fire. Won't match print runs (leading `/` blocked).
  if (!cardNumberRe) {
    const m2 = title.match(STANDALONE_CARD_NUMBER_RE);
    if (m2) return m2[1].toUpperCase();
  }
  // CF-TCG-CARDNUM (Drew, 2026-08-02). Pokemon/TCG card numbers use the
  // format `POS/TOTAL` (e.g. "008/132", "294/217"). Note the position
  // CAN exceed the total (secret/hyper rares are numbered above set
  // total). Constrain both to <=400 so we don't accidentally consume
  // sports print runs like /999 or /2011.
  //
  // CF-SERIAL-IS-NOT-A-CARDNUMBER (Drew, 2026-08-14). The <=400 bound was the
  // ONLY guard, and it does not separate the two meanings at all: a sports
  // serial like "22/30" or "49/75" sits comfortably inside it. So this rule
  // fired on sports titles and turned serials into card numbers — 99% wrong
  // where it fired, and it reached sold_comps as phantom cards.
  //
  // The bound was never the right discriminator, because `N/M` is not
  // ambiguous once you know the vertical: in TCG it is the card number, in
  // sports it is a serial. Gate on the vertical, not on the magnitude.
  //
  // The TCG branch itself now runs at the TOP of this function — see
  // CF-TCG-NUMBER-BEFORE-HASH — because it has to beat the #-prefix rule.
  return null;
}

function extractIsAuto(title: string): boolean {
  return AUTO_RE.test(title) && !AUTO_NEGATIVE_RE.test(title);
}

/** Extract auto style from title. Modern products drop hints like
 *  "On-Card Auto", "On Card Auto", or "OC Auto" (rare) for on-card
 *  signatures; "Sticker Auto" or plain "Sticker" for sticker autos.
 *  Returns null when neither hint is present — callers should treat
 *  as unknown, NOT infer a default. */
function extractAutoStyle(title: string): "on-card" | "sticker" | null {
  const T = title;
  // On-card indicators — check first since "On Card" is very common
  if (/\bon[-\s]card\b/i.test(T)) return "on-card";
  if (/\bhard[-\s]signed\b/i.test(T)) return "on-card";       // Topps' PR term for on-card
  // Sticker indicators
  if (/\bsticker\s+auto(graph)?\b/i.test(T)) return "sticker";
  if (/\bsticker\s+signed\b/i.test(T)) return "sticker";
  return null;
}

/** Extract the print run from a title. Handles serial patterns:
 *  - "3/5" (3-of-5 hand-numbered)
 *  - "77/199"
 *  - "/199" (unnumbered format when only the denominator appears)
 *  - "#/50 Braves" (numerator absent) */
function extractPrintRun(title: string, isTcg = false): number | null {
  let t = title;
  // CF-SERIAL-IS-NOT-A-CARDNUMBER (Drew, 2026-08-14). In TCG, "40/147" is
  // card-40-of-a-147-card-set. 147 is the SET SIZE, not a print run — Burning
  // Shadows was not a 147-copy print. Both branches below would have claimed
  // it (the serial branch reads the denominator; the standalone branch matches
  // the "/147" substring), so the token is removed rather than skipped. That
  // leaves a genuinely numbered TCG parallel — "... 40/147 ... /25" — still
  // able to report /25 correctly.
  if (isTcg) t = t.replace(TCG_NUMBER_RE_G, " ");
  // First look for X/Y serial style — denominator is the print run
  const serial = t.match(/(?:^|[^0-9])(\d{1,2})\/(\d{1,3})(?:\D|$)/);
  if (serial) return Number(serial[2]);
  // Fall back to /N standalone
  const slash = t.match(/\/(\d{1,4})(?:\D|$)/);
  if (slash) {
    const n = Number(slash[1]);
    // Guard against grabbing a random number (e.g. "/2024") — cap
    // reasonable print runs at 5000. Any /N > 5000 is likely a year
    // or unrelated numeric.
    if (n > 0 && n <= 5000) return n;
  }
  return null;
}

/** Extract a canonical parallel name from a title. Match precedence:
 *  SuperFractor > explicit adjacent color+variant > patterned refractors
 *  (Shimmer/Lava/Wave/RayWave/Grass/X-Fractor) > Sapphire variants when
 *  Sapphire is the product context + a color appears > color refractors
 *  > misc named parallels. Unrecognized → "Base". */
function extractParallel(title: string): string {
  const T = title;
  if (/superfractor|super\s+fractor/i.test(T)) return "SuperFractor";

  // ─── Paper-auto Border ladder (runs FIRST to win vs refractor rules) ─
  // CF-PAPER-AUTO-BORDERS (Drew, 2026-07-29). Bowman paper autos
  // (BPA-/BDA-/BCRA- prefixes; on flagship Bowman + Bowman Draft, on
  // paper stock, not chrome) use a "Color Border" parallel ladder
  // that's paper's equivalent of Chrome's Refractor color ladder.
  // Standard Bowman paper-auto Border ladder + print runs:
  //   Sky Blue Border /499     (COLLIDES with Sky Blue Refractor rule
  //                            below — Border MUST win, must run first)
  //   Neon Green Border /399
  //   Fuchsia Border /299
  //   Purple Border /250
  //   Blue Border /150         (COLLIDES with Blue Refractor /150)
  //   Yellow Border /75
  //   Gold Border /50          (COLLIDES with Gold Refractor /50)
  //   Orange Border /25        (COLLIDES with Orange Refractor /25)
  //   Red Border /5            (COLLIDES with Red Refractor /5)
  //   Platinum Border 1/1
  //
  // Match ordering: multi-word colors (sky blue, neon green) first so
  // "sky blue" doesn't fall to the single "blue" match.
  {
    if (/sky\s+blue\s+border/i.test(T)) return "Sky Blue Border";
    if (/neon\s+green\s+border/i.test(T)) return "Neon Green Border";
    if (/platinum\s+border/i.test(T)) return "Platinum Border";
    const bm = T.match(/(fuchsia|purple|blue|yellow|gold|orange|red|black|green)\s+border/i);
    if (bm) return capFirst(bm[1]) + " Border";
    if (/\bborder\b/i.test(T) && AUTO_RE.test(T)) return "Border";
  }

  // CF-TRUE-COLOR-PARALLEL (Drew, 2026-07-28). Market vernacular:
  // "True <Color>" means "<Color> Refractor" (the base colored
  // refractor variant). Real-world example: Eric Hartman's True Blue
  // #CPA-EHA sold at $905 tagged as parallel="Base" because the
  // parser missed the alias.
  //
  // eBay listings put "True" and the color in either order — "True
  // Blue Refractor" OR "Bowman Blue …True" (verified 2026-07-28 on
  // Hartman "2026 Bowman Blue Eric Hartman True #CPA-EHA"). We match
  // when both tokens are present ANYWHERE in the title, ordering
  // agnostic, but guarded to the canonical refractor colors so we
  // don't accidentally absorb "True Metal" / "True Silver" (real
  // Panini parallels distinct from Silver Refractor) or match on
  // stray marketing text.
  //
  // Runs BEFORE the plain color-refractor rules below so both
  // "True Blue Refractor" and "True Blue" land on "Blue Refractor".
  if (/\btrue\b/i.test(T)) {
    const c = T.match(/\b(blue|red|green|orange|yellow|purple|gold|aqua)\b/i);
    if (c) return capFirst(c[1]) + " Refractor";
  }
  // Explicit adjacent Sapphire variants (Color + Sapphire)
  if (/red\s+sapphire/i.test(T)) return "Red Sapphire";
  if (/orange\s+sapphire\s+refractor/i.test(T)) return "Orange Sapphire Refractor";
  if (/orange\s+sapphire/i.test(T)) return "Orange Sapphire";
  if (/yellow\s+sapphire/i.test(T)) return "Yellow Sapphire";
  if (/green\s+sapphire/i.test(T)) return "Green Sapphire";
  if (/blue\s+sapphire/i.test(T)) return "Blue Sapphire";
  // Patterned refractors (color + adjacent pattern word). Direct regex
  // literals — string-concatenated regexes were dropping the \s+ escape
  // when constructed via new RegExp().
  let m: RegExpMatchArray | null;
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua)\s+shimmer/i);
  if (m) return capFirst(m[1]) + " Shimmer Refractor";
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua)\s+lava/i);
  if (m) return capFirst(m[1]) + " Lava Refractor";
  // Ray Wave — check BEFORE plain Wave so "Ray Wave" doesn't get
  // swallowed by the wave-only pattern. Accepts three spellings:
  // "Ray Wave" (space), "Ray-Wave" (hyphen), "RayWave" (compound).
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua)\s+ray[\s-]?wave/i);
  if (m) return capFirst(m[1]) + " Ray Wave Refractor";
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua)\s+wave/i);
  if (m) return capFirst(m[1]) + " Wave Refractor";
  // CF-BARE-WAVE-REFRACTOR (Drew, 2026-07-29). Wave Refractor exists
  // as a bare (silver-based) parallel too — "2026 Bowman Eric Hartman
  // Wave Refractor /350 #BCP-102" landed at parallel="Refractor"
  // because the color-prefix rules above didn't match and the bare
  // Refractor fallback at the bottom did. Order: after color-prefixed
  // Wave rules so "Blue Wave" still returns "Blue Wave Refractor",
  // before the bare "Refractor" fallback so bare "Wave Refractor"
  // beats bare "Refractor". Same for Ray Wave.
  if (/ray[\s-]?wave\s+refractor/i.test(T)) return "Ray Wave Refractor";
  if (/wave\s+refractor/i.test(T)) return "Wave Refractor";
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua)\s+grass/i);
  if (m) return capFirst(m[1]) + " Grass Refractor";
  // CF-SPECKLE-REFRACTOR (Drew, 2026-07-29). Speckle is a Bowman Chrome
  // pattern refractor — small-dot foil overlay. Ships as bare Speckle
  // (silver-based) and as colored variants (Blue Speckle, Orange
  // Speckle, etc.). Same treatment shape as Shimmer/Lava/Wave/Grass.
  // OBSERVED: Bowman Chrome Speckle Refractor rows landed at
  // setKey=bowman parallel=Base because "Speckle" had no rule.
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua|pink|black|silver)\s+speckle/i);
  if (m) return capFirst(m[1]) + " Speckle Refractor";
  if (/speckle\s+refractor/i.test(T)) return "Speckle Refractor";
  if (/\bspeckle\b/i.test(T)) return "Speckle Refractor";
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua|black|silver)\s+x-?fractor/i);
  if (m) return capFirst(m[1]) + " X-Fractor";
  // Sapphire product context + standalone color → "Color Sapphire".
  // Real observed: "2026 Bowman Chrome Sapphire Owen Carey Green /99"
  // means Green Sapphire /99 (not Green Refractor /99).
  if (/sapphire/i.test(T)) {
    if (/\bred\b/i.test(T)) return "Red Sapphire";
    if (/\borange\b/i.test(T)) return "Orange Sapphire";
    if (/\byellow\b/i.test(T)) return "Yellow Sapphire";
    if (/\bgreen\b/i.test(T)) return "Green Sapphire";
    if (/\bblue\b/i.test(T)) return "Blue Sapphire";
    if (/\bgold\b/i.test(T)) return "Gold Refractor";       // Gold in Sapphire product = Gold Refractor still
  }
  // Named non-refractor parallels
  if (/mini\s+diamond\s+refractor/i.test(T)) return "Mini Diamond Refractor";
  if (/mini\s+diamond/i.test(T)) return "Mini Diamond";
  m = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua|black|pink)\s+geometric/i);
  if (m) return capFirst(m[1]) + " Geometric";
  if (/reptilian(\s+refractor)?/i.test(T)) return "Reptilian Refractor";
  if (/golden\s+mirror/i.test(T)) return "Golden Mirror";
  if (/heavy\s+lumber/i.test(T)) return "Heavy Lumber";
  if (/chrome-?image\s+variation/i.test(T)) return "Chrome-Image Variation";
  if (/image\s+variation/i.test(T)) return "Image Variation";
  if (/logo\s+pattern/i.test(T)) return "Bowman Logo Pattern";
  if (/gum\s+ball/i.test(T)) return "Gum Ball";
  // CF-EXTEND-BASEBALL-PARALLELS (Drew, 2026-07-28). Bowman Draft +
  // Bowman Chrome variants surfaced in the verify_queue that weren't
  // covered by the existing rules. Confirmed against real Cardsight
  // titles landing in pending-manual today.
  // CF-MEGA-MOJO-ALIAS (Drew, 2026-07-29). "Mega Refractor" and "Mojo
  // Refractor" are the SAME physical parallel — orange stock with a
  // pattern overlay — just named differently in the market vocabulary.
  // Distinct from plain Orange Refractor (which is solid orange). Both
  // titles collapse to "Mojo Refractor" here (the more common form) and
  // normalizeParallel in hobbyIqCardId.service.ts also collapses the
  // slug at the write layer so any vendor-supplied "Mega Refractor"
  // parallel string maps to the same canonical slug.
  if (/mojo\s+refractor/i.test(T) || /mega\s+refractor/i.test(T)) return "Mojo Refractor";
  if (/lazer\s+refractor/i.test(T) || /\blaser\s+refractor/i.test(T)) return "Lazer Refractor";

  // CF-STERLING-REFRACTOR (Drew, 2026-07-29). Bowman Sterling is an
  // insert set within Bowman flagship — identified by the BST-XX
  // cardNumber prefix. Its refractor parallel is called "Sterling
  // Refractor" in vendor titles. Kept as its own parallel so pricing
  // pools don't blend Sterling Refractor with Chrome Refractor (they
  // are visually and market-distinct products).
  //
  // OBSERVED 2026-07-29: "2026 Bowman JAC CAGLIANONE Bowman Sterling
  // Refractor Insert #BST-14 Royals RC" landed with parallel="Base".
  //
  // Also: bare "Sterling" appearing alongside a color modifier maps to
  // "<Color> Sterling Refractor" — mirrors the Sapphire treatment.
  {
    const sm = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua|pink|black)\s+sterling\s+refractor/i);
    if (sm) return capFirst(sm[1]) + " Sterling Refractor";
    if (/sterling\s+refractor/i.test(T)) return "Sterling Refractor";
  }

  // CF-COLOR-ROOKIE (Drew, 2026-07-29). "Red Rookie" is a parallel —
  // rookie-designated color-foiled variant seen in Topps flagship /
  // Panini Prizm / Bowman rookie subsets. Generalize to the color
  // ladder (Red/Blue/Green/Gold/etc). Matches "<Color> Rookie" phrase
  // ordering because that's how the market vocab labels these.
  {
    const rm = T.match(/(red|blue|green|orange|purple|gold|yellow|pink|black|silver)\s+rookie\b/i);
    if (rm) return capFirst(rm[1]) + " Rookie";
  }

  if (/sepia\s+refractor/i.test(T)) return "Sepia Refractor";
  if (/\bsepia\b/i.test(T) && /\brefractor\b/i.test(T)) return "Sepia Refractor";
  m = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua|pink|sky\s+blue)\s+foil/i);
  if (m) return capFirst(m[1].replace(/\s+/, " ")) + " Foil";
  if (/sky\s+blue/i.test(T)) return "Sky Blue Refractor";
  if (/aqua\s+lava/i.test(T)) return "Aqua Lava Refractor";
  if (/aqua\s+wave/i.test(T)) return "Aqua Wave Refractor";
  if (/aqua\s+shimmer/i.test(T)) return "Aqua Shimmer Refractor";
  m = T.match(/(rose\s+gold)\s+(refractor|x-?fractor|mini)/i);
  if (m) return "Rose Gold " + capFirst(m[2].replace(/-/, "-"));
  if (/black\s+shimmer\s+refractor/i.test(T)) return "Black Shimmer Refractor";
  if (/black.{0,3}white\s+shimmer/i.test(T)) return "Black & White Shimmer Refractor";
  m = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua)\s+prism/i);
  if (m) return capFirst(m[1]) + " Prism Refractor";
  if (/gold\s+ink/i.test(T)) return "Gold Ink";
  if (/prism\s+refractor/i.test(T)) return "Prism Refractor";

  // ─── Topps Heritage "Chrome" family parallels ─────────────────────
  // CF-HERITAGE-CHROME-PARALLELS (Drew, 2026-07-29). Topps Heritage
  // (a paper base product) ships chromium PARALLELS of the base card —
  // "Chrome" itself is the base chromium parallel, then Chrome Refractor,
  // Chrome Purple Refractor, Chrome Black Refractor, Chrome White, etc.
  // These are DISTINCT from the "Topps Chrome" set (which is its own
  // separate product). Detected via the "Chrome <modifier>" ordering
  // that Heritage uses (as opposed to "<color> Refractor" that Topps
  // Chrome uses).
  //
  // OBSERVED: "2026 Topps Heritage Jac Caglianone Chrome White RC #136"
  // — parser was returning "Base" because no rule caught "Chrome White".
  //
  // Ordered specific-first so "Chrome White Refractor" beats bare
  // "Chrome White".
  //
  // ALL Chrome-<modifier> rules here are GATED on /heritage/i so we
  // don't hijack Bowman Chrome / Topps Chrome titles where "Gold"
  // already means Gold Refractor. Without the gate, "Bowman Chrome
  // Gold /50" would wrongly return "Chrome Gold" instead of "Gold
  // Refractor". Heritage is the only context where "Chrome <Color>"
  // is a distinct parallel; elsewhere it's just the color refractor.
  if (/heritage/i.test(T)) {
    const cm = T.match(/chrome\s+(white|purple|black|blue|red|green|gold|orange|yellow)\s+refractor/i);
    if (cm) return "Chrome " + capFirst(cm[1]) + " Refractor";
    const cm2 = T.match(/chrome\s+(white|purple|black|blue|red|green|gold|orange|yellow)\b/i);
    if (cm2) return "Chrome " + capFirst(cm2[1]);
    if (/chrome\s+refractor/i.test(T)) return "Chrome Refractor";
    // Bare "Chrome" in a Heritage title = the base chromium parallel.
    if (/\bchrome\b/i.test(T)) return "Chrome";
  }

  // Base color refractors — accept "Color Refractor" OR "Color /N" where
  // N matches the traditional print run for that color.
  if (/gold\s+refractor/i.test(T) || /\bgold\b.*\/50\b/i.test(T)) return "Gold Refractor";
  if (/red\s+refractor/i.test(T) || /\bred\b.*\/5\b/i.test(T)) return "Red Refractor";
  if (/orange\s+refractor/i.test(T) || /\borange\b.*\/25\b/i.test(T)) return "Orange Refractor";
  if (/purple\s+refractor/i.test(T)) return "Purple Refractor";
  if (/green\s+refractor/i.test(T) || /\bgreen\b.*\/99\b/i.test(T)) return "Green Refractor";
  if (/yellow\s+refractor/i.test(T)) return "Yellow Refractor";
  if (/aqua\s+refractor/i.test(T)) return "Aqua Refractor";
  if (/blue\s+refractor/i.test(T) || /\bblue\b.*\/150\b/i.test(T) || /\bblue\b.*\/125\b/i.test(T)) return "Blue Refractor";
  // CF-PINK-REFRACTOR (Drew, 2026-07-29). Pink refractor is a Topps
  // Chrome parallel (Mother's Day pink, and other pink variants). Was
  // missing from the color ladder. OBSERVED: "Aaron Judge 2017 Topps
  // Chrome Catching PINK Refractor #169 RC PSA 10 GEM MT" landed as
  // parallel="Base" because no rule caught "Pink Refractor".
  if (/pink\s+refractor/i.test(T)) return "Pink Refractor";

  // CF-BARE-REFRACTOR (Drew, 2026-07-29). Bare "Refractor" (no color
  // modifier) is the base-silver refractor parallel of the base card —
  // real and priced distinct from Base. Prior rule required AUTO_RE to
  // be true, so non-auto refractors like "2017 Topps Chrome Aaron Judge
  // #169 Refractor RC PSA 10" collapsed to Base. Fixed by removing the
  // AUTO gate — all specific color/pattern refractor rules run BEFORE
  // this line, so "Blue Refractor" / "Gold Refractor" / "Mojo Refractor"
  // still return their specific values first. This is the fallback.
  if (/\brefractor\b/i.test(T) && !AUTO_NEGATIVE_RE.test(T)) return "Refractor";

  // ─── Basketball parallels (Prizm, Optic, Select, Contenders, Hoops) ───
  // CF-BASKETBALL-PARALLELS (Drew, 2026-07-28). Basketball card
  // conventions are distinct from baseball's Bowman Chrome vocabulary.
  // These rules run AFTER the baseball checks above so a hybrid title
  // like "Prizm Silver Refractor" still matches "Silver Refractor" first
  // when applicable (rare — most Prizm titles say "Silver Prizm").
  //
  // Verified against real Cardsight/CH titles landing in the verify_queue:
  //   "Panini Prizm Basketball Silver Prizm"
  //   "2024 Donruss Optic Blue Velocity"
  //   "Select Basketball Blue Zebra"
  //   "Contenders Cracked Ice"

  // Prizm — Panini Prizm/Prizm Draft/NBA Hoops Premium Stock uses the same
  // vocabulary. "Silver Prizm" is the base foil; every other color+Prizm
  // is a numbered parallel.
  if (/silver\s+prizm/i.test(T) || /prizm\s+silver/i.test(T)) return "Silver Prizm";
  m = T.match(/(blue|green|red|purple|gold|orange|pink|black)\s+ice\s+prizm/i);
  if (m) return capFirst(m[1]) + " Ice Prizm";
  m = T.match(/(blue|green|red|purple|gold|orange|pink|black)\s+pulsar/i);
  if (m) return capFirst(m[1]) + " Pulsar Prizm";
  m = T.match(/(red|blue|green|orange|purple|gold|pink)\s+wave\s+prizm/i);
  if (m) return capFirst(m[1]) + " Wave Prizm";
  m = T.match(/fast\s+break\s+(silver|blue|red|green|purple|gold|pink|orange|neon)/i);
  if (m) return "Fast Break " + capFirst(m[1]) + " Prizm";
  m = T.match(/hyper\s+(silver|blue|red|green|purple|gold)/i);
  if (m) return "Hyper " + capFirst(m[1]) + " Prizm";
  m = T.match(/mojo\s+prizm/i);
  if (m) return "Mojo Prizm";
  m = T.match(/(blue|red|green|purple|gold|pink|orange)\s+prizm/i);
  if (m) return capFirst(m[1]) + " Prizm";

  // Donruss Optic (basketball) — Holo/Silver base, then color velocities +
  // Pandora + Choice variants
  if (/\boptic\s+holo\b|\bholo\s+optic\b/i.test(T)) return "Holo Optic";
  m = T.match(/(blue|red|green|purple|orange|pink|gold)\s+velocity/i);
  if (m) return capFirst(m[1]) + " Velocity Optic";
  m = T.match(/choice\s+(blue|red|green|purple|orange|pink|gold)/i);
  if (m) return "Choice " + capFirst(m[1]) + " Optic";
  m = T.match(/(blue|red|green|purple|orange|pink|gold)\s+pandora/i);
  if (m) return capFirst(m[1]) + " Pandora Optic";
  m = T.match(/\b(silver|blue|red|green|purple|orange|pink|gold|holo)\s+optic\b/i);
  if (m) return capFirst(m[1]) + " Optic";

  // Panini Select — Concourse/Premier/Courtside tiers; Zebra is a pattern parallel
  if (/\bzebra\b/i.test(T)) return "Zebra Select";
  m = T.match(/(silver|blue|red|green|purple|gold|orange|pink)\s+select/i);
  if (m) return capFirst(m[1]) + " Select";

  // Contenders — Cracked Ice is the iconic parallel
  if (/cracked\s+ice/i.test(T)) return "Cracked Ice";

  // CF-CHROME-AUTO-DEFAULT-REFRACTOR (Drew, 2026-07-31). For Bowman
  // Chrome auto titles that reach this fallback with no color rule
  // matched, return "Refractor" not "Base". In Bowman Chrome
  // nomenclature the base tier of the auto ladder IS Refractor
  // (typically /499 print run); "Base" only makes sense for paper
  // (non-chrome) products.
  //
  // Live evidence 2026-07-31 on Josiah Hartshorn CPA-JHA:
  // 304 sold_comps rows landed at parallel="Base" because titles like
  //   "2025 Bowman Draft #CPA-JHA Josiah Hartshorn 1st Prospect Chrome Auto"
  // don't contain the word "refractor" — but they ARE /499 Chrome
  // Refractor autos by definition of the CPA-* subset. The Base
  // labels polluted the sibling pool, dragging Blue Refractor FMVs down.
  //
  // CF-CHROME-AUTO-REFRACTOR-DEFAULT (Drew, 2026-07-31, revised).
  // The base TIER of the chrome auto ladder IS "Refractor" (typically
  // /499 print run). When a title is a Chrome auto with no color rule
  // matched, return Refractor — NOT Base ("Base" is paper terminology).
  //
  // "Not all autos are refractors" (Drew, mid-turn): paper autos
  // (BPA-/BDA-/BSPA- prefixes on paper stock) have their own base
  // (paper Base) and their own color ladder ("Border" per CF-PAPER-
  // AUTO-BORDERS at line 401). Non-Chrome/non-Bowman autos (Panini,
  // Topps flagship non-Chrome, etc.) don't have Refractor at all.
  //
  // So this rule ONLY fires when:
  //   1. AUTO signal present (title text OR chrome-only prefix), AND
  //   2. Chrome PRODUCT signal present (bowman chrome / chrome
  //      prospects / chrome auto / topps chrome / bowman draft chrome).
  //
  // BPA/BDA/BSPA are excluded from the prefix list here on purpose
  // (they're paper). BCPA/BDPA/BCDA/BCRA/TCRA are chrome-only rookie/
  // prospect autograph prefixes. CPA is the flagship Chrome Prospect
  // Autograph prefix (baseball).
  // CF-NO-REFRACTOR-AUTO-RELEASED (Drew, 2026-08-15, on 2026 Bowman Eric
  // Hartman #CPA-EHA: "this is marked as a refractor but it is a base - eric
  // does not have a refractor auto" ... "eric hartman is the only one without
  // a refractor auto ... no card was released by topps. There was an issue
  // with his cards. It is an anomoly").
  //
  // The rule below is correct: the base tier of the chrome auto ladder IS
  // Refractor, for Bowman and Topps Chrome alike. Owen Carey's CPA-OC exists
  // in Base AND Refractor exactly as expected. This is not a product-wide
  // naming question and must not be "fixed" by narrowing the rule — doing so
  // would have moved 100,295 rows across bowman and bowman-chrome into a tier
  // they do not belong in.
  //
  // It is a PRODUCTION anomaly, at the level of one card. Topps never
  // released the Refractor auto for Eric Hartman, so 431 sold_comps rows were
  // filed under a parallel that does not physically exist — and several of
  // the titles say so outright ("True Base Auto", "Prospect Base AUTO").
  //
  // Keep this list tiny and keep every entry sourced. An entry is a claim
  // that a specific card was never printed in its ladder's base refractor
  // tier, which only the market can tell us. Do not add one by inference from
  // a thin checklist: our checklist coverage shows no Refractor tier for 151
  // of 190 2026 Bowman CPA-* cards, and that is a coverage gap, not 151
  // anomalies.
  // SCOPED BY YEAR, because card numbers are reused. CPA-EHA identifies Eric
  // Hartman in 2026 Bowman; nothing stops Topps issuing a CPA-EHA to someone
  // else in 2028, and an unscoped entry would silently inherit this anomaly
  // onto that card forever. A title with no year still matches — sellers
  // routinely omit it ("ERIC HARTMAN Bowman 1st Chrome Prospect Auto
  // #CPA-EHA") and today CPA-EHA means this card — but a title naming a
  // DIFFERENT year does not.
  const NO_REFRACTOR_AUTO_RELEASED: Array<{ number: RegExp; years: number[] }> = [
    // 2026 Bowman, Eric Hartman. Never released by Topps (Drew, 2026-08-15).
    { number: /#?\bCPA-EHA\b/i, years: [2026] },
  ];
  const titleYear = (() => {
    const m = T.match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : null;
  })();
  for (const entry of NO_REFRACTOR_AUTO_RELEASED) {
    if (!entry.number.test(T)) continue;
    if (titleYear !== null && !entry.years.includes(titleYear)) continue;
    return "Base";
  }

  const CHROME_AUTO_PREFIX_RE = /#?\b(CPA|BCPA|BDPA|BCDA|BCRA|TCRA|FCA|CU|CDA)-[A-Z0-9]+/i;
  const isChromeAutoTitle =
    (AUTO_RE.test(T) || CHROME_AUTO_PREFIX_RE.test(T))
    && (
      /bowman\s+chrome/i.test(T)
      || /chrome\s+prospect(s)?/i.test(T)
      || /chrome\s+auto/i.test(T)
      || /topps\s+chrome/i.test(T)
      || /bowman\s+draft.*chrome/i.test(T)
    );
  if (isChromeAutoTitle) {
    return "Refractor";
  }

  // CF-SCARCITY-IS-NOT-BASE (Drew, 2026-08-16, on "2018 Topps Ohtani Warm-Up
  // Shirt SSP": "are we handling SSP of players? ... we need to add these
  // things to the catalog and find others in the data like that").
  //
  // We were not. A super-short-print photo variation parsed to parallel="Base"
  // and therefore produced the SAME SLUG as the common base card:
  //
  //   "2018 Topps Shohei Ohtani Warm-Up Shirt SSP #150" -> Base, #150
  //   "2018 Topps Shohei Ohtani #150 Base"              -> Base, #150
  //
  // So an SSP trading at a large multiple averaged into the base pool,
  // inflating the base FMV and deflating its own at the same time. Counting
  // sold_comps titles filed as parallel="Base" on 2026-08-16:
  //
  //     SSP        48,034 of 75,822      SHORT PRINT  6,355 of  7,475
  //     CASE HIT   27,915 of 33,900      PHOTO VAR.     826 of  1,465
  //
  // (IMAGE VARIATION was already handled — 10 of 11,839.)
  //
  // THIS FIRES ONLY AT THE FALLBACK, never over a colour rule. Scarcity and
  // colour are different axes: a "Blue Refractor SSP" is still the Blue
  // Refractor, and every colour/pattern rule above has already returned. What
  // reaches here is a card with no parallel of its own — exactly the set that
  // was collapsing into Base.
  //
  // SP IS A BRAND AS OFTEN AS IT IS A SHORT PRINT. Discovery over 20,000
  // Base-filed titles returned "upper deck sp" as the single most common
  // descriptor preceding an SP marker (1,857), ahead of every genuine scarcity
  // term. "SP Authentic" (11,146 rows) and "Upper Deck SP" (10,808) are
  // PRODUCT LINES; a bare "SP" rule would have mislabelled ~22,000 sales into
  // a tier that does not exist. Only unambiguous forms are matched.
  const isSpBrand = /\b(?:sp\s+authentic|upper\s+deck\s+sp|sp\s+legendary|sp\s+game\s+used|sp\s+signature)\b/i.test(T);
  if (/\bssp\b/i.test(T) && !isSpBrand) return "SSP";
  if (/\bcase\s+hit\b/i.test(T)) return "Case Hit";
  if (/\bshort\s+print\b/i.test(T) && !isSpBrand) return "Short Print";
  if (/\bphoto\s+variation\b/i.test(T)) return "Photo Variation";

  return "Base";
}

function capFirst(s: string): string {
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/** Infer setKey from a title. Best-effort — recognizes the common
 *  Bowman/Topps/Panini product lines. When nothing matches, returns
 *  a generic "Bowman" fallback (callers should override when they
 *  have more specific knowledge).
 *
 *  CF-BOWMAN-PAPER-SETKEY (Drew, 2026-07-29). "bpa = bowman paper" —
 *  BPA-XX / BDA-XX cardNumbers indicate the paper-stock autograph
 *  subset of Bowman flagship / Bowman Draft, which is a DISTINCT
 *  product from the paper base cards and from Bowman Chrome autos.
 *  Historically these collapsed into the generic "Bowman" setKey,
 *  blending paper-auto FMV with paper-base FMV. Now derive
 *  "Bowman Paper" whenever the title carries explicit Paper Prospect
 *  Auto tokens. The card-number-driven form (BPA-XX with a bare
 *  "2026 Bowman" title that omits "Paper") is handled by the
 *  cardNumber-aware overload below. */
export function inferSetKeyFromTitle(title: string, cardNumber?: string | null): string {
  const t = String(title ?? "").toLowerCase();
  const cn = String(cardNumber ?? "").toUpperCase();

  // Bowman Paper detection — title-first, then cardNumber-prefix fallback.
  // Must run BEFORE the plain /bowman/ rules below so a "2026 Bowman
  // ... 1st Paper Prospect Auto" title doesn't collapse to plain "Bowman".
  const titleSaysPaper =
    /1st\s+paper|paper\s+prospect|paper\s+auto|paper\s+autograph/i.test(t);
  const cardNumSaysPaper = /^BPA-|^BDA-/i.test(cn);
  if (titleSaysPaper || cardNumSaysPaper) {
    if (/draft/i.test(t) || /^BDA-/i.test(cn)) return "Bowman Draft Paper";
    return "Bowman Paper";
  }

  if (/sapphire/.test(t)) return "Bowman Chrome Sapphire";
  if (/topps\s+update/.test(t)) return "Topps Update";
  if (/topps\s+heritage/.test(t)) return "Topps Heritage";
  if (/topps\s+heavy\s+lumber|heavy\s+lumber/.test(t)) return "Topps Heavy Lumber";
  // CF-TOPPS-PRODUCT-LINES (Drew, 2026-07-29). Complete Topps taxonomy so
  // rows for these distinct product lines stop collapsing to bare "topps"
  // (which pollutes pricing pools and misroutes the family ladder). All
  // must match BEFORE /topps\s+chrome/ where possible; Finest/Pristine/
  // Stadium Club/Allen-Ginter are their own products, not chrome variants.
  if (/topps\s+finest/i.test(t)) return "Topps Finest";
  if (/topps\s+pristine/i.test(t)) return "Topps Pristine";
  if (/topps\s+transcendent/i.test(t)) return "Topps Transcendent";
  if (/topps\s+dynasty/i.test(t)) return "Topps Dynasty";
  if (/topps\s+tribute/i.test(t)) return "Topps Tribute";
  if (/topps\s+inception/i.test(t)) return "Topps Inception";
  if (/topps\s+definitive/i.test(t)) return "Topps Definitive";
  if (/topps\s+five[-\s]?star|five[-\s]?star/i.test(t)) return "Topps Five Star";
  if (/topps\s+museum|museum\s+collection/i.test(t)) return "Topps Museum Collection";
  if (/topps\s+stadium\s+club|stadium\s+club/i.test(t)) return "Topps Stadium Club";
  if (/topps\s+allen[-\s]?(and\s+)?ginter|allen[-\s]?(and\s+)?ginter/i.test(t)) return "Topps Allen Ginter";
  if (/topps\s+gypsy\s+queen|gypsy\s+queen/i.test(t)) return "Topps Gypsy Queen";
  if (/topps\s+archives/i.test(t)) return "Topps Archives";
  if (/topps\s+big\s+league|big\s+league/i.test(t)) return "Topps Big League";
  if (/topps\s+bunt/i.test(t)) return "Topps Bunt";
  // CF-SUBPRODUCT-SETKEY (Drew, 2026-08-15). These product lines existed in
  // card_catalog but had no parser rule, so every sale of them collapsed to
  // the parent brand ("topps"/"bowman"/"fleer") and then failed to match a
  // catalog row that was sitting right there.
  //
  // Measured over 30,000 awaiting-catalog staging rows: 19,900 (66%)
  // inferred a GENERIC setKey. All 17 product lines below were confirmed
  // present in card_catalog FIRST — the point is to route to rows we
  // already hold, not to invent new ones:
  //
  //   leaf-metal 108,608 · topps-tier-one 92,677 · bowman-platinum 87,074
  //   topps-triple-threads 83,910 · topps-pro-debut 65,989
  //   topps-cosmic-chrome 34,144 · bowman-inception 18,029
  //   topps-now 14,221 · topps-shoebox-treasures 4,038 · fleer-update 2,504
  //   topps-signature-class 1,191 · fleer-ultra 598 · etopps 304
  //   panini-totally-certified 284 · topps-resurgence 86 · panini-noir 76
  //   fleer-metal 17
  //
  // Two were not merely generic but WRONG: "Panini Totally Certified" and
  // "Panini Noir" both returned "Bowman".
  //
  // ORDER MATTERS. Each must precede its parent brand's bare rule, and
  // eTopps must precede /topps/ since the brand name is a substring of it.
  if (/\betopps\b/i.test(t)) return "eTopps";
  if (/topps\s+pro\s+debut/i.test(t)) return "Topps Pro Debut";
  if (/topps\s+signature\s+class/i.test(t)) return "Topps Signature Class";
  if (/topps\s+cosmic\s+chrome|cosmic\s+chrome/i.test(t)) return "Topps Cosmic Chrome";
  if (/topps\s+triple\s+threads|triple\s+threads/i.test(t)) return "Topps Triple Threads";
  if (/topps\s+tier\s+one|tier\s+one/i.test(t)) return "Topps Tier One";
  if (/topps\s+shoebox\s+treasures|shoebox\s+treasures/i.test(t)) return "Topps Shoebox Treasures";
  if (/topps\s+resurgence/i.test(t)) return "Topps Resurgence";
  // "Topps Now" is a dated print-to-order line. Anchor on the brand so a
  // stray "now" elsewhere in a title cannot claim it.
  if (/topps\s+now\b/i.test(t)) return "Topps Now";
  // Panini sub-products — both of these previously returned "Bowman".
  if (/panini\s+totally\s+certified|totally\s+certified/i.test(t)) return "Panini Totally Certified";
  if (/panini\s+noir\b/i.test(t)) return "Panini Noir";
  if (/leaf\s+metal/i.test(t)) return "Leaf Metal";

  if (/topps\s+chrome/.test(t)) return "Topps Chrome";
  // CF-FLEER-STICKERS (Drew, 2026-07-29). 1986 Fleer Stickers (basketball)
  // is a distinct product from base 1986 Fleer — Michael Jordan #8 Sticker
  // rookie is separate from Fleer #57 Jordan base rookie. Recognize as
  // its own setKey. Must match BEFORE bare /topps/ / default Bowman
  // fallback. Applies to any year — Fleer produced sticker inserts across
  // multiple sports/years, all distinct products.
  if (/fleer\s+stickers?/i.test(t)) return "Fleer Stickers";
  if (/fleer\s+ultra|\bultra\s+fleer\b/i.test(t)) return "Fleer Ultra";
  if (/fleer\s+metal|metal\s+universe/i.test(t)) return "Fleer Metal";
  if (/fleer\s+update/i.test(t)) return "Fleer Update";
  if (/\bfleer\b/i.test(t)) return "Fleer";
  if (/bowman\s+platinum/i.test(t)) return "Bowman Platinum";
  if (/bowman\s+inception/i.test(t)) return "Bowman Inception";
  if (/bowman\s+draft\s+chrome/.test(t)) return "Bowman Draft Chrome";
  if (/bowman\s+draft/.test(t)) return "Bowman Draft";
  if (/bowman\s+chrome\s+prospects?/.test(t)) return "Bowman Chrome";
  if (/bowman\s+chrome/.test(t)) return "Bowman Chrome";
  if (/bowman\s+mega\s+box/.test(t)) return "Bowman Chrome Mega Box";
  // CF-CHROME-IMPLIED (Drew, 2026-07-29). Some parallels are Chrome-
  // exclusive (they don't exist on Bowman Paper): Speckle, Shimmer,
  // Lava, Wave, Ray Wave, Grass, X-Fractor, Mojo, Prism, Mini Diamond,
  // and any bare "Refractor". When a title says "Bowman" but omits
  // "Chrome" AND carries one of these chrome-only signals, upgrade to
  // Bowman Chrome. Ordered AFTER bowman-draft/chrome/sapphire so
  // explicit product-line phrases still win.
  //
  // OBSERVED: "2026 Bowman Speckle Refractor" (title omits "Chrome")
  // landed at setKey=bowman. Speckle is chrome-only; this is bowman-chrome.
  //
  // CF-CHROME-IMPLIED-EDITION-GUARD (Drew, 2026-07-30). Framework rule:
  // edition tokens (Sapphire, Mega Box, 1st Edition, Sonic, Cosmic,
  // Lite) reroute the whole comp pool. If the title carries an edition
  // token, DO NOT collapse to base "Bowman Chrome" — the edition-
  // specific handler (Sapphire → Bowman Chrome Sapphire; Mega Box →
  // Bowman Chrome Mega Box) should already have matched above, but if
  // it didn't, DEFER rather than pool with base. Also skip when the
  // cardNumber prefix implies a Sapphire subset (BSPA-XX).
  if (/bowman/.test(t) && /speckle|shimmer\s+refractor|\blava\s+refractor|wave\s+refractor|grass\s+refractor|x-?fractor|mojo\s+refractor|mega\s+refractor|prism\s+refractor|mini\s+diamond|\brefractor\b/i.test(t)) {
    // Edition guard: any explicit edition token → don't collapse to base
    if (/\b(sapphire|mega\s?box|1st\s+edition|first\s+edition|sonic|cosmic\s+chrome|\blite\b)/i.test(t)) {
      // Fall through — an edition-specific rule above should have
      // matched, or the caller will treat as base with an edition flag.
    } else if (/^BSPA-/i.test(cn)) {
      // cardNumber says this is Sapphire Prospect Autographs subset.
      return "Bowman Chrome Sapphire";
    } else {
      return "Bowman Chrome";
    }
  }
  // CF-PANINI-PRODUCT-LINES (Drew, 2026-07-29). Full Panini taxonomy so
  // rows for these distinct products stop collapsing to bare "panini".
  // Match on either "Panini <Product>" OR the bare product name when the
  // product IS uniquely Panini (Prizm, Optic, Select, etc. are all
  // Panini-exclusive brand names). Order most-specific first.
  if (/panini\s+national\s+treasures|national\s+treasures/i.test(t)) return "Panini National Treasures";
  if (/panini\s+immaculate|immaculate/i.test(t)) return "Panini Immaculate";
  if (/panini\s+flawless|\bflawless\b/i.test(t)) return "Panini Flawless";
  if (/panini\s+one[-\s]?one|\bone\s+one\b/i.test(t)) return "Panini One One";
  if (/panini\s+contenders|\bcontenders\b/i.test(t)) return "Panini Contenders";
  if (/panini\s+absolute|\babsolute\b/i.test(t)) return "Panini Absolute";
  if (/panini\s+chronicles|\bchronicles\b/i.test(t)) return "Panini Chronicles";
  if (/panini\s+phoenix|\bphoenix\b/i.test(t)) return "Panini Phoenix";
  if (/panini\s+illusions|\billusions\b/i.test(t)) return "Panini Illusions";
  if (/panini\s+obsidian|\bobsidian\b/i.test(t)) return "Panini Obsidian";
  if (/panini\s+spectra|\bspectra\b/i.test(t)) return "Panini Spectra";
  if (/panini\s+revolution|\brevolution\b/i.test(t)) return "Panini Revolution";
  if (/panini\s+crown\s+royale|crown\s+royale/i.test(t)) return "Panini Crown Royale";
  if (/panini\s+select|\bselect\b/i.test(t)) return "Panini Select";
  if (/panini\s+mosaic|\bmosaic\b/i.test(t)) return "Panini Mosaic";
  if (/panini\s+optic|donruss\s+optic|\boptic\b/i.test(t)) return "Panini Optic";
  if (/panini\s+donruss|\bdonruss\b/i.test(t)) return "Panini Donruss";
  if (/panini\s+prizm|\bprizm\b/i.test(t)) return "Panini Prizm";
  if (/topps/.test(t)) return "Topps";
  // CF-INFER-SET-POKEMON-GUARD (Drew, 2026-08-03). Bowman is the
  // baseball default for unmatched sports titles, but TCA firehose
  // pipes Pokemon/TCG in the same pool. Returning "Bowman" for
  // "Terrakion White Promo Japanese" mis-tags the row's setName.
  // For obviously non-sports contexts, return a truthful placeholder
  // so the LLM-provided setName wins downstream (persistVendorSalesToPool
  // uses `?? inferSetKeyFromTitle` for the fallback).
  if (/\b(pokemon|pok[eé]?mon|pok\s?mon|yugioh|yu-?gi-?oh|magic\s+the\s+gathering|\bmtg\b|dragon\s*ball|one\s+piece|weiss\s+schwarz|digimon|star\s+wars|halo|final\s+fantasy|ultraman|kaiju|godzilla|marvel|dc\s+comics|funko|topps\s+wacky|garbage\s+pail|hearthstone|lorcana|flesh\s+and\s+blood)\b/.test(t)) {
    return "Unknown";
  }
  // CF-BRANDS-BEFORE-THE-FALLBACK (Drew, 2026-08-16: "do it").
  //
  // These manufacturers had NO rule at all — "score", "skybox" and "o-pee-chee"
  // appeared zero times in this file — so their cards fell to the Bowman
  // default below, which fired on any title containing "baseball" or "rookie".
  // A 1994 Upper Deck baseball rookie therefore came back as Bowman.
  //
  // Measured across 9,765,902 comps by comparing each slug's product against
  // its own title:
  //
  //     147,700  upper-deck  parsed as "unknown"
  //      90,732  upper-deck  parsed as "bowman"
  //      34,428  o-pee-chee  parsed as "unknown"
  //      27,013  score       parsed as "bowman"
  //      26,441  skybox      parsed as "unknown"
  //      21,826  panini      parsed as "bowman"
  //      18,615  leaf        parsed as "bowman"
  //
  // ~432,000 comps where the SLUG was right and the PARSER was wrong. That
  // matters twice: it blocks the null-slug backfill, and it made the
  // title-vs-slug audit unusable — a fifth of the "disagreements" were this
  // fallback rather than real mis-slugging.
  //
  // Longest name first within a family, so "Upper Deck SP Authentic" is not
  // eaten by the bare "Upper Deck" rule.
  if (/\bo-?pee-?chee\b/.test(t)) return "O-Pee-Chee";
  if (/\bcollector'?s\s+choice\b/.test(t)) return "Collectors Choice";
  if (/\bsp\s+authentic\b/.test(t)) return "SP Authentic";
  if (/\bsp\s+game\s+used\b/.test(t)) return "SP Game Used";
  if (/\bspx\b/.test(t)) return "SPx";
  if (/\bupper\s+deck\b/.test(t)) return "Upper Deck";
  if (/\bskybox\b/.test(t)) return "Skybox";
  if (/\bpinnacle\b/.test(t)) return "Pinnacle";
  if (/\bstadium\s+club\b/.test(t)) return "Topps Stadium Club";
  if (/\bscore\b/.test(t)) return "Score";

  // Only default to Bowman when the title actually says something Bowman-ish.
  // It used to be enough to contain "baseball" or "rookie", which is how every
  // unrecognised brand became a Bowman card.
  if (/\b(1st\s+bowman|bowman)\b/.test(t)) {
    return "Bowman";
  }
  return "Unknown";
}

/** Infer sport from a title. Falls back to a caller-supplied default. */
/**
 * @deprecated Use `resolveVertical()` from resolveVertical.service.ts.
 *
 * CF-VERTICAL-NOT-SPORT (Drew, 2026-08-13: "so maybe calling it sport is
 * wrong?"). Two problems, both caused by the name:
 *
 *   1. It resolves a VERTICAL, not a sport. Pokemon, Yu-Gi-Oh and One Piece are
 *      not sports, and modelling them as one is why they had nowhere to go.
 *   2. `fallback = "baseball"` means an unidentifiable card silently BECOMES a
 *      baseball card, and the return type cannot express the difference between
 *      "this is baseball" and "I could not tell". That produced slugs like
 *      hiq:baseball:2003:ex-sandstorm:87100 which can never match anything, and
 *      left card_catalog 93.6% sport=baseball.
 *
 * Kept as-is because 800 references read this field; resolveVertical() wraps it
 * and reports confidence. Do not add new callers.
 */
export function inferSportFromTitle(title: string, fallback = "baseball"): string {
  const t = String(title ?? "").toLowerCase();
  // CF-SOCCER-NEVER-DETECTED (Drew, 2026-08-15). There was no soccer
  // branch at all, so every soccer card fell through to the `baseball`
  // fallback and landed in the pool that feeds baseball FMV and
  // calibration. Measured in sold_comps: 14,826 baseball-slugged rows
  // whose title says "WORLD CUP", 13,678 "FIFA", 8,293 "UEFA", 3,139
  // "PREMIER LEAGUE", 2,486 "UCC" — against only 7,034 rows correctly
  // tagged sport='soccer'. The mislabelled population is several times
  // the correctly-labelled one.
  //
  // Placed ABOVE the football check on purpose. Outside the US "football"
  // MEANS soccer, so "2024 Topps Merlin Football UEFA" would otherwise
  // match /football/ and return NFL. A named competition is a far
  // stronger signal than the bare word, so competitions win.
  //
  // Competition and league names only — no bare club names here. "Arsenal",
  // "City", "United", "Inter" and "Milan" are ordinary words or personal
  // names, and CF-SPORT-TEAM-OVERMATCH is the standing lesson about what
  // happens when an ordinary word is treated as a team.
  if (/\b(soccer|f[uú]tbol|fifa|uefa|champions\s+league|europa\s+league|premier\s+league|la\s+liga|serie\s+a|bundesliga|ligue\s+1|eredivisie|copa\s+(?:america|libertadores|del\s+rey)|world\s+cup|\bucl\b|\bucc\b|\bmls\b|euro\s+20\d\d|concacaf|conmebol)\b/.test(t)) {
    return "soccer";
  }
  // CF-WWE-UFC-NEVER-DETECTED (Drew, 2026-08-15: "This is marvel wwe cards").
  // Neither wrestling nor MMA had any detection, so both fell through to the
  // `baseball` fallback and polluted the pool that feeds baseball FMV and
  // calibration — the same failure soccer had.
  //
  // Measured in sold_comps: of 7,071 titles containing "WWE", 6,134 (87%)
  // were tagged baseball; of 5,573 containing "UFC", 4,715 (85%) were. The
  // backlog holds another 22,602 pending WWE rows.
  //
  // "wrestling" and "mma" are already in CANONICAL_SPORTS in slugGuard, and
  // ufc->mma is already an alias there, so nothing downstream needs teaching.
  //
  // NOTE the deliberate absence of "raw": it is the ungraded marker ending
  // thousands of titles in every sport ("... #CPA-BG - Raw"), and matching it
  // would drag the entire pool into wrestling. WWE's brand is "NXT"; "RAW" is
  // unusable as a signal here.
  if (/\b(wwe|wwf|aew|njpw|wrestlemania|smackdown|royal\s+rumble|nxt|wrestling)\b/.test(t)) {
    return "wrestling";
  }
  if (/\b(ufc|mma|bellator|octagon)\b/.test(t)) return "mma";
  if (/\bboxing\b/.test(t)) return "boxing";
  if (/football|nfl\b/.test(t)) return "football";
  if (/basketball|nba\b/.test(t)) return "basketball";
  if (/hockey|nhl\b/.test(t)) return "hockey";
  // CF-BASEBALL-KEYWORD-MISSING (Drew, 2026-08-14). There was no
  // baseball keyword check at all — baseball was reachable ONLY via the
  // `fallback` parameter. So a title that says "Baseball" in plain text
  // fell through every explicit check and landed on the team-name
  // heuristics below, where the NHL alternation contains "stars"
  // (Dallas Stars):
  //
  //   "1978 Kellogg's 3-D Super Stars Baseball #8"  -> "hockey"
  //   "2025 Topps Stars of MLB #SMLB10 Ohtani"      -> "hockey"
  //
  // "Stars" is everywhere in baseball product names (Super Stars, Stars
  // of MLB, All-Stars), so this quietly mis-sported a large slice of the
  // pool — sport='hockey' in sold_comps was dominated by baseball rows.
  // Placed AFTER the other three so an explicitly multi-sport title
  // keeps its existing precedence, and BEFORE the team-name fallbacks so
  // a stated sport always beats a guessed one. "basketball" does not
  // contain "baseball", so there is no overlap with the check above.
  if (/baseball|mlb\b/.test(t)) return "baseball";
  // CF-BASKETBALL-BY-PRODUCT (Drew, 2026-07-29). Some famous basketball
  // products don't carry "basketball"/"nba" in the title but their
  // product line is basketball-exclusive:
  //   - 1986 Fleer Stickers (basketball only — that's the debut product)
  //   - Any Fleer Sticker across years is basketball-first
  // OBSERVED: "MICHAEL JORDAN 1986 FLEER STICKER #8 ROOKIE PSA MINT 9"
  // — no basketball keyword, defaulted to baseball. Fleer Sticker is
  // a strong basketball signal by product convention.
  if (/fleer\s+sticker/i.test(t)) return "basketball";

  // CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). TCG/non-sport detection
  // used to sit BELOW the team-name heuristics. A title literally
  // reading "2025 Pokemon Mega Evolution Phantasmal Flames" therefore
  // reached the NHL alternation, matched "flames" (Calgary), and was
  // stamped sport=hockey — 3,436 Pokemon rows in a single month's slug
  // sweep. The check was never missing; it was merely unreachable.
  // A named product line is a STATED vertical, not a guessed one, so it
  // belongs with the other keyword checks above the team fallbacks.
  const nonSport = inferNonSportVertical(t);
  if (nonSport) return nonSport;

  // CF-PLAYER-SPORT-HINTS (Drew, 2026-07-29). Some Herbert / Mahomes /
  // Wembanyama-style titles carry ONLY the player name — no team, no
  // league, no product-line hint. Player→sport is the last-resort
  // disambiguator. Curated: unambiguous FULL-NAME matches only
  // (single-token last names like "Herbert" collide across sports;
  // "Justin Herbert" doesn't). Two-sport players (Bo Jackson, Deion
  // Sanders) are DELIBERATELY EXCLUDED — no correct default there.
  //
  // OBSERVED: Justin Herbert 2020 Panini Prizm / Mosaic rows landed at
  // sport=baseball because the title carries neither team nor "NFL";
  // full-name "Justin Herbert" is the only signal.
  //
  // CF-SPORT-TEAM-OVERMATCH moved this ABOVE the team checks. An
  // unambiguous full name is strictly more specific than a bare team
  // word, and the table already excludes two-sport players. "Shohei
  // Ohtani 2025 Bowman Chrome - HS4 Sho-Time Showcase Hobby Stars"
  // resolves on "shohei ohtani" instead of colliding with "Stars".
  const playerSport = inferSportFromPlayer(t);
  if (playerSport) return playerSport;

  // CF-TEAM-NAME-SPORT-HINTS (Drew, 2026-07-29). When the title carries
  // no explicit sport keyword, look for UNAMBIGUOUS team names as a
  // fallback signal. NFL/NBA/NHL each have some names that also exist
  // in another league (Panthers/Kings/Jets); those are excluded to
  // avoid false positives.
  //
  // CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). The single alternation
  // per league was too blunt: it mixed distinctive franchise nouns
  // ("Blackhawks", "Canadiens") with ordinary English words that are
  // ALSO team names ("Stars", "Flames", "Wild", "Blues", "Heat",
  // "Magic", "Bills"). Card titles are dense with product, insert and
  // parallel names, so the plain words collided constantly and a
  // GUESSED team outranked the product name sitting in the same title:
  //
  //   "...Sho-Time Showcase Hobby Stars #SLAD"     -> Dallas Stars
  //   "2025 Pokemon ... Phantasmal Flames #102"    -> Calgary Flames
  //   "...Scarlet & Violet Wild Force #53"         -> Minnesota Wild
  //   "2024-25 Hoops #1 Lillard Frequent Flyers"   -> Philadelphia Flyers
  //   "1940 Play Ball #22 Sammy West - Senators"   -> Ottawa Senators
  //                                                  (it's the MLB Senators)
  //   "1990 Pro Set #352 Bruce Matthews PB Oilers" -> Edmonton Oilers
  //                                                  (it's the NFL Oilers)
  //
  // So the tokens are split into two tiers. STRONG names are
  // distinctive enough to stand alone. WEAK names are ordinary words
  // and only count when the franchise's CITY sits next to them. That
  // discriminator was not invented — of the 4,589 damaged rows, every
  // genuinely-hockey one carried its city ("San Jose Sharks", "Anaheim
  // Ducks", "Carolina Hurricanes", "Boston Bruins", "Toronto Maple
  // Leafs") while none of the product-name collisions did.
  //
  // Team names are now a TRUE last resort: stated sport, named product
  // line and full player name all outrank them. Consistent with
  // slugGuard's doctrine that refusing beats defaulting, an unqualified
  // weak word yields NOTHING rather than a guess.
  if (NFL_TEAMS_STRONG.test(t) || NFL_TEAMS_CITY_QUALIFIED.test(t)) return "football";
  if (NBA_TEAMS_STRONG.test(t) || NBA_TEAMS_CITY_QUALIFIED.test(t)) return "basketball";
  // "Bolts" overlaps NFL Chargers and NHL Lightning. If the football
  // check above already fired, we won't reach here.
  if (NHL_TEAMS_STRONG.test(t) || NHL_TEAMS_CITY_QUALIFIED.test(t)) return "hockey";

  // CF-SOCCER-NEVER-DETECTED, last resort. Some soccer titles name only a
  // club or a player — "Julian Alvarez ... Atletico Madrid" carries no
  // competition word. Runs AFTER the US-league team checks so a shared
  // city never steals a card from them, and every entry is a full club
  // name or an unambiguous player. Bare "Arsenal", "City", "United",
  // "Inter" and "Milan" are deliberately absent: they are ordinary words
  // or personal names, which is exactly what made "Stars" and "Flames"
  // mis-sport 4,589 rows.
  if (SOCCER_CLUBS_AND_PLAYERS.test(t)) return "soccer";

  return fallback;
}

/** Full club names and unambiguous players — never bare one-word clubs. */
const SOCCER_CLUBS_AND_PLAYERS =
  /\b(real\s+madrid|barcelona|fc\s+barcelona|manchester\s+(?:united|city)|man\s+(?:utd|city)|liverpool\s+fc|chelsea\s+fc|arsenal\s+fc|tottenham|bayern\s+munich|borussia\s+dortmund|paris\s+saint-?germain|\bpsg\b|juventus|ac\s+milan|inter\s+milan|atl[eé]tico\s+madrid|napoli|ajax\s+amsterdam|benfica|boca\s+juniors|river\s+plate|flamengo|lionel\s+messi|cristiano\s+ronaldo|kylian\s+mbapp[eé]|erling\s+haaland|neymar|vin[ií]cius\s+j[uú]nior|jude\s+bellingham|lamine\s+yamal|mohamed\s+salah|kevin\s+de\s+bruyne|robert\s+lewandowski|luka\s+modri[cć]|antoine\s+griezmann|julian\s+[aá]lvarez)\b/i;

/**
 * CF-TCA-NON-SPORT-DETECT (Drew, 2026-08-02). TCA firehose pushes TCG +
 * non-sport (Pokemon, MTG, Star Wars, etc.) alongside sports. Rather
 * than default to "baseball" (which pollutes FMV/calibration pools),
 * tag these with their real category so downstream filters on sport IN
 * (baseball/basketball/football/hockey/soccer) exclude them naturally.
 * Rows stay queryable for later dedicated categorization.
 *
 * Extracted from inferSportFromTitle by CF-SPORT-TEAM-OVERMATCH so the
 * check can run above the team-name fallbacks. Returns null when the
 * title names no known non-sport product line.
 */
export function inferNonSportVertical(title: string): string | null {
  const t = String(title ?? "").toLowerCase();
  if (/\b(pokemon|pok[eé]?mon)\b/i.test(t)) return "pokemon";
  if (/\b(yugioh|yu-?gi-?oh)\b/i.test(t)) return "yugioh";
  if (/\b(magic\s+the\s+gathering|\bmtg\b|hearthstone|lorcana|flesh\s+and\s+blood)\b/i.test(t)) return "tcg-other";
  if (/\b(dragon\s*ball|one\s+piece|weiss\s+schwarz|digimon|hunter\s*x\s*hunter|jujutsu\s+kaisen|attack\s+on\s+titan|naruto|my\s+hero\s+academia|demon\s+slayer)\b/i.test(t)) return "anime-tcg";
  // CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). "halo" and "wow" were
  // dropped from this alternation. Both are ordinary card-title words,
  // not product signals, and promoting this check above the team
  // fallbacks would have made them fire far more often. Measured over
  // 2026-07: all 13 "halo" hits are foil/parallel treatments ("Halo
  // Foil", "Star Power Halo Photo", "Light Blue Halo /49") and all 61
  // "wow" hits are seller hype on real sports cards ("RARE ICONIC
  // PARALLEL WOW", "PSA 10 gem mint WOW !!"). Neither had a single
  // genuine Halo / World of Warcraft row. The spelled-out "world of
  // warcraft" still matches, which is what actually identifies those.
  // "marvel" is KEPT: its 948 hits are Donruss "Diamond Marvels", and
  // the trailing \b means the plural never matches.
  if (/\b(star\s+wars|final\s+fantasy|ultraman|kaiju|godzilla|marvel|dc\s+comics|funko|topps\s+wacky|garbage\s+pail|dungeons|d\s*&\s*d|d&d|world\s+of\s+warcraft)\b/i.test(t)) return "non-sport";
  return null;
}

/**
 * CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). Build a pattern that
 * matches a weak team word ONLY when its franchise city sits directly
 * in front of it — "calgary flames" counts, a bare "Flames" does not.
 */
function cityQualifiedTeams(pairs: Array<[city: string, team: string]>): RegExp {
  return new RegExp(
    pairs.map(([city, team]) => `\\b(?:${city})\\s+(?:${team})\\b`).join("|"),
    "i",
  );
}

// NFL — dropping names shared with another league: Cardinals[MLB],
// Rangers[NHL], Panthers[NHL], Jets[NHL], Giants[MLB].
const NFL_TEAMS_STRONG =
  /\b(chargers|bolts|steelers|packers|ravens|49ers|niners|seahawks|buccaneers|redskins|bengals|broncos)\b/i;
const NFL_TEAMS_CITY_QUALIFIED = cityQualifiedTeams([
  ["dallas", "cowboys"],
  ["philadelphia|philly", "eagles"],
  ["chicago", "bears"],
  ["detroit", "lions"],
  ["los\\s+angeles|la|st\\.?\\s+louis", "rams"],
  ["kansas\\s+city|kc", "chiefs"],
  ["buffalo", "bills"],
  ["new\\s+england", "patriots|pats"],
  ["las\\s+vegas|oakland|los\\s+angeles|la", "raiders"],
  ["minnesota", "vikings"],
  ["atlanta", "falcons"],
  ["tampa\\s+bay|tampa", "bucs"],
  ["new\\s+orleans|nola", "saints"],
  ["tennessee|houston", "titans"],
  ["indianapolis|indy|baltimore", "colts"],
  ["houston", "texans"],
  ["jacksonville", "jaguars|jags"],
  ["miami", "dolphins"],
  ["washington", "commanders"],
]);

// NBA — dropping Kings[NHL].
const NBA_TEAMS_STRONG =
  /\b(lakers|celtics|warriors|knicks|nuggets|mavericks|mavs|pelicans|pels|grizzlies|timberwolves|clippers|cavaliers|cavs|76ers|sixers|raptors|trail\s+blazers|okc)\b/i;
const NBA_TEAMS_CITY_QUALIFIED = cityQualifiedTeams([
  ["miami", "heat"],
  ["orlando", "magic"],
  ["oklahoma\\s+city|okc", "thunder"],
  ["washington", "wizards"],
  ["houston", "rockets"],
  ["brooklyn|new\\s+jersey", "nets"],
  ["milwaukee", "bucks"],
  ["phoenix", "suns"],
  ["utah", "jazz"],
  ["minnesota", "wolves"],
  ["san\\s+antonio", "spurs"],
  ["charlotte|new\\s+orleans", "hornets"],
  ["detroit", "pistons"],
  ["indiana", "pacers"],
  ["portland", "blazers"],
  ["atlanta", "hawks"],
  ["golden\\s+state", "dubs"],
]);

// NHL — dropping names shared with another league: Kings[NBA],
// Jets[NFL], Panthers[NFL], Rangers[MLB].
const NHL_TEAMS_STRONG =
  /\b(bruins|islanders|blackhawks|blue\s+jackets|red\s+wings|canadiens|habs|maple\s+leafs|canucks|kraken|golden\s+knights|coyotes|sabres|penguins|capitals)\b/i;
const NHL_TEAMS_CITY_QUALIFIED = cityQualifiedTeams([
  ["calgary", "flames"],
  ["dallas|minnesota\\s+north|north", "stars"],
  ["minnesota", "wild"],
  ["tampa\\s+bay|tampa", "lightning"],
  ["philadelphia|philly", "flyers"],
  ["ottawa", "senators|sens"],
  ["edmonton", "oilers"],
  ["san\\s+jose", "sharks"],
  ["anaheim|mighty", "ducks"],
  ["carolina", "hurricanes|canes"],
  ["st\\.?\\s+louis|saint\\s+louis", "blues"],
  ["colorado", "avalanche|avs"],
  ["nashville", "predators|preds"],
  ["new\\s+jersey|jersey", "devils"],
  ["washington", "caps"],
  ["toronto", "leafs"],
  ["pittsburgh", "pens"],
  ["new\\s+york|ny", "isles"],
  ["chicago", "hawks"],
]);

// CF-PLAYER-SPORT-HINTS (Drew, 2026-07-29). Full-name → sport table,
// grouped by sport for maintainability. Only include names that are
// UNAMBIGUOUS across sports at the full-name level. New additions
// should be sanity-checked against Wikipedia's disambiguation page.
const PLAYER_SPORT_HINTS: Array<{ sport: string; pattern: RegExp }> = [
  {
    sport: "football",
    // TWO-SPORT PLAYERS EXCLUDED (no correct default):
    //   deion sanders — NFL + MLB (Yankees/Braves/Reds/Giants)
    //   bo jackson    — NFL + MLB (Royals/White Sox/Angels)
    //   drew henson   — NFL + MLB (Yankees minor leagues)
    //   jim thorpe    — NFL + MLB (Braves/Reds)
    //   tom brady     — NFL + MLB draft (Expos '95); Bowman Draft has
    //                    Brady baseball cards in the Expos era. 4 rows
    //                    surfaced in dry-run 2.
    pattern: /\b(?:justin\s+herbert|patrick\s+mahomes|joe\s+burrow|josh\s+allen|lamar\s+jackson|jalen\s+hurts|dak\s+prescott|kyler\s+murray|trevor\s+lawrence|tua\s+tagovailoa|justin\s+fields|c\.?j\.?\s+stroud|caleb\s+williams|jayden\s+daniels|drake\s+maye|bo\s+nix|michael\s+penix|anthony\s+richardson|brock\s+purdy|jordan\s+love|aaron\s+rodgers|peyton\s+manning|eli\s+manning|drew\s+brees|ben\s+roethlisberger|philip\s+rivers|russell\s+wilson|joe\s+montana|dan\s+marino|brett\s+favre|john\s+elway|steve\s+young|troy\s+aikman|kurt\s+warner|ja[’']?marr\s+chase|justin\s+jefferson|ceedee\s+lamb|tyreek\s+hill|puka\s+nacua|rome\s+odunze|marvin\s+harrison(?:\s+jr)?|malik\s+nabers|xavier\s+worthy|garrett\s+wilson|chris\s+olave|drake\s+london|deebo\s+samuel|amon-?ra\s+st\.?\s+brown|devonta\s+smith|jaylen\s+waddle|davante\s+adams|stefon\s+diggs|cooper\s+kupp|deandre\s+hopkins|jerry\s+rice|randy\s+moss|calvin\s+johnson|travis\s+kelce|sam\s+laporta|george\s+kittle|brock\s+bowers|dallas\s+goedert|mark\s+andrews|t\.?j\.?\s+hockenson|christian\s+mccaffrey|saquon\s+barkley|bijan\s+robinson|jonathan\s+taylor|derrick\s+henry|nick\s+chubb|kenneth\s+walker|breece\s+hall|jahmyr\s+gibbs|de[’']?von\s+achane|jonathan\s+brooks|kaleb\s+johnson|omarion\s+hampton|ashton\s+jeanty|barry\s+sanders|walter\s+payton|emmitt\s+smith|jim\s+brown|adrian\s+peterson|ladainian\s+tomlinson|micah\s+parsons|nick\s+bosa|myles\s+garrett|t\.?j\.?\s+watt|aidan\s+hutchinson|maxx\s+crosby|khalil\s+mack|von\s+miller|lawrence\s+taylor|reggie\s+white|bruce\s+smith|sauce\s+gardner|patrick\s+surtain|jalen\s+ramsey|charles\s+woodson|ed\s+reed|troy\s+polamalu|ray\s+lewis|brian\s+urlacher|dick\s+butkus|derrick\s+brooks|ladd\s+mcconkey)\b/i,
  },
  {
    sport: "basketball",
    // TWO-SPORT / AMBIGUOUS EXCLUDED:
    //   bill russell   — NBA Celtics dominant, but MLB Bill Russell
    //                    (Dodgers 70s) exists; some era-baseball cards
    //                    would flip incorrectly.
    //   michael jordan — NBA dominant, but 1994-95 Upper Deck Minor
    //                    League Birmingham Barons cards exist; those
    //                    are actually baseball-category rows. Skip.
    pattern: /\b(?:lebron\s+james|steph(?:en)?\s+curry|kevin\s+durant|giannis\s+antetokounmpo|nikola\s+jokic|luka\s+doncic|jayson\s+tatum|jaylen\s+brown|devin\s+booker|anthony\s+edwards|ja\s+morant|trae\s+young|zion\s+williamson|victor\s+wembanyama|wemby|chet\s+holmgren|paolo\s+banchero|scoot\s+henderson|cade\s+cunningham|jalen\s+brunson|karl-?anthony\s+towns|shai\s+gilgeous-?alexander|de[’']?aaron\s+fox|alperen\s+sengun|bam\s+adebayo|domantas\s+sabonis|tyrese\s+haliburton|tyrese\s+maxey|anthony\s+davis|joel\s+embiid|jimmy\s+butler|kawhi\s+leonard|paul\s+george|damian\s+lillard|james\s+harden|russell\s+westbrook|chris\s+paul|dwyane\s+wade|klay\s+thompson|draymond\s+green|kyrie\s+irving|zach\s+lavine|donovan\s+mitchell|jamal\s+murray|michael\s+porter|amen\s+thompson|ausar\s+thompson|jabari\s+smith|jaden\s+ivey|dyson\s+daniels|bennedict\s+mathurin|jeremy\s+sochan|walker\s+kessler|jalen\s+williams|jalen\s+duren|franz\s+wagner|reed\s+sheppard|alex\s+sarr|zaccharie\s+risacher|donovan\s+clingan|matas\s+buzelis|stephon\s+castle|zach\s+edey|dalton\s+knecht|rob\s+dillingham|nikola\s+topic|ron\s+holland|cody\s+williams|isaiah\s+collier|carlton\s+carrington|jared\s+mccain|kobe\s+bryant|magic\s+johnson|larry\s+bird|kareem\s+abdul-?jabbar|wilt\s+chamberlain|shaquille\s+o[’']?neal|hakeem\s+olajuwon|tim\s+duncan|dirk\s+nowitzki|allen\s+iverson|charles\s+barkley|karl\s+malone|john\s+stockton|scottie\s+pippen|isiah\s+thomas|david\s+robinson|patrick\s+ewing|reggie\s+miller|julius\s+erving|oscar\s+robertson|elgin\s+baylor|jerry\s+west|rui\s+hachimura)\b/i,
  },
  {
    sport: "hockey",
    pattern: /\b(?:connor\s+mcdavid|auston\s+matthews|sidney\s+crosby|alex(?:ander)?\s+ovechkin|leon\s+draisaitl|nathan\s+mackinnon|cale\s+makar|jack\s+hughes|quinn\s+hughes|luke\s+hughes|connor\s+bedard|matvei\s+michkov|macklin\s+celebrini|kirill\s+kaprizov|igor\s+shesterkin|andrei\s+vasilevskiy|nikita\s+kucherov|artemi\s+panarin|david\s+pastrnak|mikko\s+rantanen|elias\s+pettersson|aleksander\s+barkov|sebastian\s+aho|mitch\s+marner|william\s+nylander|brady\s+tkachuk|matthew\s+tkachuk|trevor\s+zegras|juraj\s+slafkovsky|owen\s+power|adam\s+fantilli|jesper\s+bratt|wayne\s+gretzky|mario\s+lemieux|bobby\s+orr|gordie\s+howe|mark\s+messier|patrick\s+roy|steve\s+yzerman|jaromir\s+jagr|joe\s+sakic|nicklas\s+lidstrom|martin\s+brodeur|dominik\s+hasek|teemu\s+selanne|jarome\s+iginla|pavel\s+bure|brett\s+hull|paul\s+kariya)\b/i,
  },
  {
    sport: "baseball",
    pattern: /\b(?:aaron\s+judge|shohei\s+ohtani|mike\s+trout|bryce\s+harper|mookie\s+betts|freddie\s+freeman|ronald\s+acuna|juan\s+soto|fernando\s+tatis|julio\s+rodriguez|adley\s+rutschman|corbin\s+carroll|elly\s+de\s+la\s+cruz|jackson\s+chourio|wyatt\s+langford|jackson\s+merrill|jackson\s+holliday|paul\s+skenes|roman\s+anthony|ethan\s+salas|sebastian\s+walcott|kevin\s+mcgonigle|bryce\s+eldridge|josue\s+de\s+paula|konnor\s+griffin|termarr\s+johnson|druw\s+jones|jasson\s+dominguez|anthony\s+volpe|jose\s+altuve|clayton\s+kershaw|justin\s+verlander|max\s+scherzer|derek\s+jeter|albert\s+pujols|miguel\s+cabrera|ken\s+griffey|barry\s+bonds|hank\s+aaron|willie\s+mays|babe\s+ruth|mickey\s+mantle|ted\s+williams|jackie\s+robinson|nolan\s+ryan|cal\s+ripken|greg\s+maddux|randy\s+johnson|pedro\s+martinez|chipper\s+jones|frank\s+thomas|eric\s+hartman|ethan\s+conrad|owen\s+carey|gage\s+wood)\b/i,
  },
];

export function inferSportFromPlayer(title: string): string | null {
  const t = String(title ?? "").toLowerCase();
  for (const { sport, pattern } of PLAYER_SPORT_HINTS) {
    if (pattern.test(t)) return sport;
  }
  return null;
}
