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
//
// CF-HERITAGE-BARE-CARDNUMBER (Drew, 2026-07-29). Topps Heritage +
// vintage Topps use bare digit card numbers like #136, #500. The prior
// regex required 1-3 leading letters before digits, so #136 got no
// match and Heritage rows shipped with cardNumber=null. Now accepts
// 1-4 pure digits after '#' as a fallback alternative.
const DEFAULT_CARD_NUMBER_RE =
  /#([A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4}|BCP-\d+|CPA-\w+|BSPA-\w+|BCPA-\w+|BDCA-\w+|BPA-\w+|BDA-\w+|BCRA-\w+|TCRA-\w+|CPALD|CPATWH|BDC-\d+|HL\d+|US\d+|\d{1,4})\b/i;

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
  if (/topps\s+chrome/.test(t)) return "Topps Chrome";
  // CF-FLEER-STICKERS (Drew, 2026-07-29). 1986 Fleer Stickers (basketball)
  // is a distinct product from base 1986 Fleer — Michael Jordan #8 Sticker
  // rookie is separate from Fleer #57 Jordan base rookie. Recognize as
  // its own setKey. Must match BEFORE bare /topps/ / default Bowman
  // fallback. Applies to any year — Fleer produced sticker inserts across
  // multiple sports/years, all distinct products.
  if (/fleer\s+stickers?/i.test(t)) return "Fleer Stickers";
  if (/\bfleer\b/i.test(t)) return "Fleer";
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
  if (/bowman/.test(t) && /speckle|shimmer\s+refractor|\blava\s+refractor|wave\s+refractor|grass\s+refractor|x-?fractor|mojo\s+refractor|mega\s+refractor|prism\s+refractor|mini\s+diamond|\brefractor\b/i.test(t)) {
    return "Bowman Chrome";
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
  return "Bowman";
}

/** Infer sport from a title. Falls back to a caller-supplied default. */
export function inferSportFromTitle(title: string, fallback = "baseball"): string {
  const t = String(title ?? "").toLowerCase();
  if (/football|nfl\b/.test(t)) return "football";
  if (/basketball|nba\b/.test(t)) return "basketball";
  if (/hockey|nhl\b/.test(t)) return "hockey";
  // CF-BASKETBALL-BY-PRODUCT (Drew, 2026-07-29). Some famous basketball
  // products don't carry "basketball"/"nba" in the title but their
  // product line is basketball-exclusive:
  //   - 1986 Fleer Stickers (basketball only — that's the debut product)
  //   - Any Fleer Sticker across years is basketball-first
  // OBSERVED: "MICHAEL JORDAN 1986 FLEER STICKER #8 ROOKIE PSA MINT 9"
  // — no basketball keyword, defaulted to baseball. Fleer Sticker is
  // a strong basketball signal by product convention.
  if (/fleer\s+sticker/i.test(t)) return "basketball";

  // CF-TEAM-NAME-SPORT-HINTS (Drew, 2026-07-29). When the title carries
  // no explicit sport keyword, look for UNAMBIGUOUS team names as a
  // fallback signal. NFL/NBA/NHL each have some names that also exist
  // in another league (Panthers/Kings/Jets); those are excluded to
  // avoid false positives. OBSERVED: Justin Herbert 2020 Panini Prizm
  // / Mosaic rows landed at sport=baseball because the title says
  // neither "football" nor "NFL" — but "Chargers" / "Bolts" would
  // disambiguate.
  //
  // Order: check most-specific franchise names first.
  //
  // NFL — 32 teams (dropping ambiguous: Cardinals[MLB], Rangers[NHL],
  // Panthers[NHL], Jets[NHL], Giants[MLB]).
  if (/\b(chargers|bolts|cowboys|eagles|ravens|steelers|packers|bears|49ers|niners|rams|chiefs|bills|patriots|pats|broncos|raiders|vikings|lions|falcons|buccaneers|bucs|saints|seahawks|bengals|titans|colts|texans|jaguars|jags|dolphins|commanders|redskins)\b/i.test(t)) return "football";
  // NBA — 30 teams (dropping ambiguous: Kings[NHL], Jazz→OK, Suns→OK,
  // Hawks→OK, Nets→OK. Bruins→NHL, Hornets→OK).
  if (/\b(lakers|celtics|warriors|dubs|heat|knicks|nets|bucks|nuggets|suns|mavericks|mavs|rockets|spurs|pelicans|pels|grizzlies|timberwolves|wolves|thunder|okc|trail\s+blazers|blazers|clippers|jazz|hawks|hornets|magic|pistons|cavaliers|cavs|wizards|pacers|76ers|sixers|raptors)\b/i.test(t)) return "basketball";
  // NHL — 32 teams (dropping ambiguous: Kings[NBA], Jets[NFL],
  // Panthers[NFL], Rangers→MLB).
  if (/\b(bruins|islanders|isles|devils|flyers|penguins|pens|capitals|caps|blue\s+jackets|red\s+wings|blackhawks|hawks|wild|blues|predators|preds|stars|avalanche|avs|kraken|ducks|sharks|golden\s+knights|coyotes|canucks|flames|oilers|canadiens|habs|maple\s+leafs|leafs|senators|sens|sabres|hurricanes|canes|lightning|bolts)\b/i.test(t)) {
    // "Bolts" overlaps NFL Chargers ("Bolts") and NHL Lightning
    // ("Bolts"). If the football-team check above already fired, we
    // won't reach here. Skip Hawks (matched both NBA Atlanta and NHL
    // Chicago — but NHL bruins/leafs are unique enough).
    return "hockey";
  }

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
  const playerSport = inferSportFromPlayer(t);
  if (playerSport) return playerSport;

  return fallback;
}

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
