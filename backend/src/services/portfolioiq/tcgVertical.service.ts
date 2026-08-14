// CF-TCG-HOLDING-GROUP (Drew, 2026-08-13: "let's just tag them as TCG and into
// a holding group").
//
// Trading-card-game sales (Pokemon, One Piece, Yu-Gi-Oh, Magic, Lorcana) flow
// in from the same vendor feeds as sports cards, but there is no TCG catalog to
// match them against — the sport→vertical schema refactor is the parked
// blocker. So every TCG sale reaches recordSoldComp, fails the catalog match,
// and is skipped under CATALOG_MATCH_ONLY_ENABLED.
//
// Measured 2026-08-13 over 20,000 staging rows: 7.7% are TCG. They cannot be
// matched by any amount of checklist ingestion, yet they:
//
//   - sit permanently in the unmatched backlog, making coverage look worse
//     than it is (33% matched, and this is part of why)
//   - file checklist seeds for sets no sports checklist will ever cover, which
//     is why the seed queue GREW from 2,285 to 2,754 while we were draining it
//   - compute nonsense slugs — "hiq:baseball:2003:ex-sandstorm:87100" is a
//     Pokemon EX Sandstorm card wearing a baseball slug
//
// Routing them to their own holding status keeps the sales — they are real
// transactions and the vertical is coming — while taking them out of a pipeline
// that structurally cannot serve them. Nothing is deleted; when the TCG vertical
// lands, this population is exactly the seed corpus for it.

/** Vertical labels the pipeline already assigns to non-sport product. */
const TCG_VERTICALS: ReadonlySet<string> = new Set([
  "pokemon",
  "anime-tcg",
  "yugioh",
  "tcg-other",
  "mtg",
  "lorcana",
]);

/**
 * Titles that are unmistakably TCG even when the row was filed under a SPORT.
 *
 * This is the misclassified tail — measured at ~0.6% of staging rows, e.g. a
 * Charizard VSTAR carrying `sport=hockey`. Deliberately narrow: every term here
 * is a product line or a character that has no sports-card homonym, because a
 * false positive would pull a real sports sale out of the pool. "Prizm",
 * "Chrome" and colour words are absent for that reason.
 */
/**
 * Pokemon SET names, which are usually the only TCG signal present.
 *
 * CF-TCG-SET-NAMES (Drew, 2026-08-13). The brand-word patterns below miss most
 * real rows, because vendor titles are "<card> - <set> - <finish>":
 *
 *   "Mewtwo - Base Set 2 - Holofoil"        -> hiq:baseball:2000:base-set-2:…
 *   "Feraligatr (5) - Neo Genesis"          -> hiq:baseball:2000:neo-genesis:…
 *   "Gulpin (40) - Arceus - Normal"         -> hiq:baseball:2009:arceus:…
 *
 * Not one contains "Pokemon". Measured over 680 promotable slugs, rows like
 * these were landing in `genuinely-absent` (31.2%) and `setkey-drift` (17.8%)
 * and being read as a checklist gap, when they are a vertical gap — Pokemon
 * already matches (402,809 comps against 48,094 catalog rows).
 *
 * DELIBERATELY OMITTED, because they collide with sports products and a false
 * positive silently removes a real sale from pricing:
 *   "platinum"  — Bowman Platinum, Panini Platinum
 *   "base set"  — generic across every sport
 *   "dragon", "emerald", "crystal", "expedition", "legends"
 * Era prefixes (sv-, swsh, sm-, xy-, bw-) carry no such risk and do the heavy
 * lifting for modern sets.
 */
const POKEMON_SET_NAMES: readonly string[] = [
  // WotC era
  "neo genesis", "neo discovery", "neo revelation", "neo destiny",
  "gym heroes", "gym challenge", "team rocket", "jungle", "fossil",
  "wotc promo", "legendary collection",
  // "base set" alone collides with sports; the NUMERAL does not.
  "base set 2",
  // EX era
  "holon phantoms", "power keepers", "sandstorm", "unseen forces",
  "delta species", "legend maker", "crystal guardians", "dragon frontiers",
  "team magma", "hidden legends", "firered leafgreen", "ruby sapphire",
  // DP / Platinum / HGSS
  "mysterious treasures", "secret wonders", "great encounters",
  "legends awakened", "majestic dawn", "stormfront", "rising rivals",
  "supreme victors", "arceus", "heartgold soulsilver", "call of legends",
  "unleashed", "undaunted", "triumphant",
  // BW / XY
  "emerging powers", "noble victories", "next destinies", "dark explorers",
  "dragons exalted", "boundaries crossed", "plasma storm", "plasma freeze",
  "plasma blast", "legendary treasures", "flashfire", "furious fists",
  "phantom forces", "primal clash", "roaring skies", "ancient origins",
  "breakthrough", "breakpoint", "fates collide", "steam siege", "evolutions",
  "kalos starter set",
  // SM
  "guardians rising", "burning shadows", "crimson invasion", "ultra prism",
  "forbidden light", "celestial storm", "lost thunder", "team up",
  "unbroken bonds", "unified minds", "cosmic eclipse", "hidden fates",
  "dragon majesty",
  // SWSH
  "rebel clash", "darkness ablaze", "vivid voltage", "shining fates",
  "battle styles", "chilling reign", "evolving skies", "fusion strike",
  "brilliant stars", "astral radiance", "lost origin", "silver tempest",
  "celebrations",
  // SV
  "scarlet violet", "paldea evolved", "obsidian flames", "paradox rift",
  "temporal forces", "twilight masquerade", "shrouded fable",
  "stellar crown", "surging sparks", "prismatic evolutions",
  "phantasmal flames",
  // structural
  "pop series", "trainer gallery",
];

/**
 * Era prefixes that appear in slugs.
 *
 * CF-TCG-ERA-PREFIX-COLLISION (Drew, 2026-08-14). These were plain substrings
 * — "sv ", "sm ", "xy ", "bw " — and the haystack flattens hyphens to spaces,
 * so a SPORTS card number "SV-12" became "sv 12" and matched "sv ". Every
 * Topps Chrome Sapphire "SV-NN" card has therefore been classified as Pokemon.
 * The comment above claimed these "cannot collide with sports setKeys"; the
 * hyphen flattening, added later for slug matching, quietly made that false.
 *
 * Not a new bug, but #1035 raised its cost: an incorrect isTcg now also decides
 * how the N/M token is read, so a misfired prefix corrupts the card number too.
 *
 * The distinguishing rule is what FOLLOWS the prefix. Pokemon writes a set
 * ordinal glued on ("sv1", "sv8a") or a set name ("sv scarlet violet"). The
 * flattened sports form is always prefix-space-DIGITS ("sv 12"), so requiring
 * either a glued ordinal or a following letter separates them cleanly.
 */
const POKEMON_SET_PREFIXES: readonly string[] = ["swsh", "hgss"];
const POKEMON_ERA_PREFIX_RE = /\b(?:sv|sm|xy|bw)(?:\d{1,2}[a-z]?\b|\s+(?=[a-z]))/i;

/**
 * CF-TCG-DETECTION-WIDEN (Drew, 2026-08-14).
 *
 * #1035 made an undetected vertical COSTLY. Before it, a Pokemon title that no
 * pattern here recognised still got a card number out of the POS/TOTAL rule;
 * after it, that rule is gated on this classifier, so a miss yields
 * cardNumber=null. Measured on real blocked rows:
 *
 *   "CGC 10 Terapagos ex 136/187 SV8a Terastal Fest ex Holo Japanese 2024"
 *     before: cardNumber 136187 (right convention) + printRun 187 (wrong)
 *     after:  cardNumber null                                   <- regression
 *
 * So the classifier has to carry the weight the old fallback used to. The two
 * misses are Japanese-market product and the "<character> - <set> - <finish>"
 * title shape, where the set name is one of the ones deliberately omitted above
 * for colliding with sports ("crystal guardians", "base set").
 *
 * Character names close that gap without touching the collision list: a title
 * naming a Pokemon is Pokemon regardless of which set it came from. Every name
 * below is checked for a sports homonym — which is why "Ace", "Rocket", "Star",
 * "Champion" and "Shadow" are NOT here.
 */
const POKEMON_CHARACTERS: readonly string[] = [
  // Kanto starters + evolutions (dominant in vintage listings)
  "bulbasaur", "ivysaur", "venusaur", "charmander", "charmeleon",
  "squirtle", "wartortle", "blastoise",
  // Most-listed by sales volume
  "mewtwo", "eevee", "snorlax", "gengar", "gyarados", "dragonite",
  "umbreon", "espeon", "sylveon", "vaporeon", "jolteon", "flareon",
  "glaceon", "leafeon", "articuno", "zapdos", "moltres", "lugia",
  "ho-oh", "rayquaza", "groudon", "kyogre", "lucario", "greninja",
  "garchomp", "tyranitar", "machamp", "alakazam", "gardevoir",
  "metagross", "salamence", "arcanine", "ninetales", "lapras",
  // Modern chase
  "terapagos", "miraidon", "koraidon", "chien-pao", "iron valiant",
  "roaring moon", "flutter mane", "cinderace", "victini", "zacian",
  "zamazenta", "calyrex", "giratina", "palkia", "dialga", "darkrai",
  "arceus", "genesect", "volcarona", "mimikyu", "grimmsnarl",
];

/**
 * Japanese-market set codes ("SV8a", "S12a"). The trailing LETTER is what makes
 * these safe: sports card numbers use "SV-10" or "SV10" shapes, not "SV8a", so
 * requiring a letter suffix avoids the collision that a bare \bsv\d\b would
 * introduce. A false positive here would pull a real sports sale into the TCG
 * vertical, which is the exact harm this module exists to prevent.
 */
const JAPANESE_SET_CODE_RE = /\bs[vm]?\d{1,2}[a-z]\b/i;

const TCG_TITLE_PATTERNS: readonly RegExp[] = [
  /\bpokemon\b/i,
  /\bpikachu\b/i,
  /\bcharizard\b/i,
  /\bvstar\b|\bvmax\b/i,
  /\bswsh\b|\bsword\s*&?\s*shield\b/i,
  /\bscarlet\s*&?\s*violet\b/i,
  /\bcall of legends\b|\bmajestic dawn\b|\bstormfront\b|\bex sandstorm\b/i,
  /\bpop series\b/i,
  /\byu-?gi-?oh\b/i,
  /\bone piece\b/i,
  /\blorcana\b/i,
  /\bmagic:? the gathering\b/i,
  // CF-TCG-DETECTION-WIDEN (Drew, 2026-08-14). Modern/Japanese product that the
  // list above missed, taken from titles measured as still-unmatchable.
  /\bterastal\b/i,
  /\bshiny treasure\b|\bvstar universe\b|\bhigh class pack\b/i,
  /\bbattle academy\b|\bdeck exclusives\b|\btrainer kit\b/i,
  /\bjourney together\b|\bdestined rivals\b|\bblack bolt\b|\bwhite flare\b/i,
  /\bpaldean fates\b|\bcrown zenith\b|\bpokemon center\b/i,
  /\bex holo\b|\bhalf deck\b/i,
];

export interface TcgClassification {
  isTcg: boolean;
  /** Why it was classified — recorded on the row so the call is auditable. */
  reason?: "vertical-field" | "title-pattern" | "set-name" | "character-name" | "set-code";
  /** The vertical when known from the sport field. */
  vertical?: string;
}

/**
 * Decide whether a staged sale is TCG rather than a sports card.
 *
 * The `sport` field is trusted FIRST because the pipeline already resolves most
 * TCG product correctly (1,194 of 1,532 TCG rows in the sample carried
 * `pokemon`). The title patterns only catch the misfiled remainder.
 */
export function classifyTcg(input: {
  sport?: string | null;
  title?: string | null;
  hobbyiqCardId?: string | null;
}): TcgClassification {
  const sport = String(input.sport ?? "").trim().toLowerCase();
  if (sport && TCG_VERTICALS.has(sport)) {
    return { isTcg: true, reason: "vertical-field", vertical: sport };
  }

  // Check the title AND the slug: the slug carries the setKey, which is where
  // "ex-sandstorm" / "swsh-sword-shield-promo-cards" survive even when the
  // title is terse.
  //
  // Hyphens become spaces first — slugs are hyphenated ("call-of-legends") while
  // the patterns are written in prose form ("call of legends"), so without this
  // every slug-only detection silently missed.
  const hay = `${input.title ?? ""} ${input.hobbyiqCardId ?? ""}`.replace(/-/g, " ");
  if (TCG_TITLE_PATTERNS.some((re) => re.test(hay))) {
    return { isTcg: true, reason: "title-pattern" };
  }

  // Set-name match. Lowercased and hyphen-flattened above, so "Base Set 2" in a
  // title and "base-set-2" in a slug both normalise to the same haystack.
  const flat = hay.toLowerCase();
  if (POKEMON_SET_NAMES.some((s) => flat.includes(s))) {
    return { isTcg: true, reason: "set-name" };
  }
  if (POKEMON_SET_PREFIXES.some((p) => flat.includes(p)) || POKEMON_ERA_PREFIX_RE.test(flat)) {
    return { isTcg: true, reason: "set-name" };
  }

  // CF-TCG-DETECTION-WIDEN (Drew, 2026-08-14). Character name, checked LAST so
  // the cheaper and more specific signals win and keep their own `reason`.
  //
  // This is what rescues the "<character> - <set> - <finish>" title shape when
  // the set is one of the ones omitted from POKEMON_SET_NAMES for colliding
  // with sports — "Ivysaur - 035/100 - EX Crystal Guardians" is unambiguous
  // from the character alone, while "crystal guardians" on its own is not.
  //
  // Word-boundary matched: a substring test would fire "mew" inside "mewtwo"
  // harmlessly but also inside unrelated words.
  if (POKEMON_CHARACTERS.some((c) => new RegExp(`\\b${c}\\b`, "i").test(flat))) {
    return { isTcg: true, reason: "character-name" };
  }

  // Japanese-market set code ("SV8a"). Last because it is the loosest signal.
  if (JAPANESE_SET_CODE_RE.test(flat)) {
    return { isTcg: true, reason: "set-code" };
  }
  return { isTcg: false };
}
