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

export interface ParsedListingIdentity {
  cardNumber: string | null;
  parallel: string;
  isAuto: boolean;
  printRun: number | null;
  /** CF-AUTO-STYLE (Drew, 2026-07-23, issue #712 option B).
   *  Autograph style — "on-card" (signed directly on the card surface,
   *  15-30% premium) or "sticker" (signed sticker applied to card).
   *  Null when the title doesn't hint at style OR the row isn't an auto.
   *  Downstream FMV path applies a multiplier when comparing on-card
   *  vs sticker sales — that math is a follow-up PR. */
  autoStyle: "on-card" | "sticker" | null;
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
const DEFAULT_CARD_NUMBER_RE =
  /#([A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4}|BCP-\d+|CPA-\w+|BSPA-\w+|BCPA-\w+|BDCA-\w+|BPA-\w+|BDA-\w+|BCRA-\w+|TCRA-\w+|CPALD|CPATWH|BDC-\d+|HL\d+|US\d+)\b/i;

// Note: `on card` alone does NOT imply auto — "On Card Display" and
// similar non-auto phrases exist. Explicit \bauto\b or "autograph" or
// "hard signed" are required. When "On Card Auto" appears, \bauto\b
// picks it up.
const AUTO_RE = /\bauto\b|autograph|hard[-\s]signed/i;
const AUTO_NEGATIVE_RE = /auto\s+relic|auto\s+patch/i;

/** Extract identity from a marketplace title.
 *
 *  When cardNumberRe is provided, only that pattern is tried (useful
 *  when the caller knows the target card and wants to reject rows for
 *  other cards from the same search response). */
export function parseListingIdentity(
  title: string,
  cardNumberRe?: RegExp,
): ParsedListingIdentity {
  const t = String(title ?? "");
  const isAuto = extractIsAuto(t);
  return {
    cardNumber: extractCardNumber(t, cardNumberRe),
    parallel: extractParallel(t),
    isAuto,
    printRun: extractPrintRun(t),
    autoStyle: isAuto ? extractAutoStyle(t) : null,
  };
}

function extractCardNumber(title: string, cardNumberRe?: RegExp): string | null {
  const re = cardNumberRe ?? DEFAULT_CARD_NUMBER_RE;
  const m = title.match(re);
  return m ? m[1].toUpperCase() : null;
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
function extractPrintRun(title: string): number | null {
  // First look for X/Y serial style — denominator is the print run
  const serial = title.match(/(?:^|[^0-9])(\d{1,2})\/(\d{1,3})(?:\D|$)/);
  if (serial) return Number(serial[2]);
  // Fall back to /N standalone
  const slash = title.match(/\/(\d{1,4})(?:\D|$)/);
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
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua)\s+grass/i);
  if (m) return capFirst(m[1]) + " Grass Refractor";
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
  if (/mojo\s+refractor/i.test(T)) return "Mojo Refractor";
  if (/lazer\s+refractor/i.test(T) || /\blaser\s+refractor/i.test(T)) return "Lazer Refractor";
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
  // Bare "Refractor" on auto = base refractor (silver)
  if (/\brefractor\b/i.test(T) && AUTO_RE.test(T) && !AUTO_NEGATIVE_RE.test(T)) return "Refractor";

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

  return "Base";
}

function capFirst(s: string): string {
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/** Infer setKey from a title. Best-effort — recognizes the common
 *  Bowman/Topps/Panini product lines. When nothing matches, returns
 *  a generic "Bowman" fallback (callers should override when they
 *  have more specific knowledge). */
export function inferSetKeyFromTitle(title: string): string {
  const t = String(title ?? "").toLowerCase();
  if (/sapphire/.test(t)) return "Bowman Chrome Sapphire";
  if (/topps\s+update/.test(t)) return "Topps Update";
  if (/topps\s+heritage/.test(t)) return "Topps Heritage";
  if (/topps\s+heavy\s+lumber|heavy\s+lumber/.test(t)) return "Topps Heavy Lumber";
  if (/topps\s+chrome/.test(t)) return "Topps Chrome";
  if (/bowman\s+draft\s+chrome/.test(t)) return "Bowman Draft Chrome";
  if (/bowman\s+draft/.test(t)) return "Bowman Draft";
  if (/bowman\s+chrome\s+prospects?/.test(t)) return "Bowman Chrome";
  if (/bowman\s+chrome/.test(t)) return "Bowman Chrome";
  if (/bowman\s+mega\s+box/.test(t)) return "Bowman Chrome Mega Box";
  if (/panini\s+prizm/.test(t)) return "Panini Prizm";
  if (/topps/.test(t)) return "Topps";
  return "Bowman";
}

/** Infer sport from a title. Falls back to a caller-supplied default. */
export function inferSportFromTitle(title: string, fallback = "baseball"): string {
  const t = String(title ?? "").toLowerCase();
  if (/football|nfl\b/.test(t)) return "football";
  if (/basketball|nba\b/.test(t)) return "basketball";
  if (/hockey|nhl\b/.test(t)) return "hockey";
  return fallback;
}
