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

/**
 * Set names that ARE Pokemon sets but collide with sports products, so they
 * may only be read as Pokemon when something ELSE on the row already proves
 * the vertical.
 *
 * CF-TCG-SPORTS-COLLIDING-SETS-NEED-A-MARKER (#2006 follow-up, 2026-09-08).
 *
 * #2006 pointed the daily TCA feed at TCGplayer. Measured over the first
 * 12,000 live TCGplayer rows (2026-09-07 window): 8,102 resolved to pokemon
 * and 3,898 -- 32.5% -- resolved to NOTHING and were skipped as
 * `skippedSportUnresolved`, which under CF-NO-DEFAULT-SPORT means the sale
 * never entered a pool at all.
 *
 * Those 3,898 are not a detector failure in the usual sense. They are the
 * DELIBERATE omissions listed above -- "expedition", "base set", "platinum",
 * "dragon", the EX-era names -- which were rightly excluded because a bare
 * "Expedition" or "Platinum" in a SPORTS title must never be read as Pokemon.
 * The measured residual is dominated by two groups:
 *
 *   "Gastly - Expedition - Normal"           985+ rows across Expedition,
 *   "Furret - Aquapolis - Normal"            Aquapolis, Diamond and Pearl,
 *   "Floatzel - Diamond and Pearl - Normal"  Base Set, Platinum, EX Dragon...
 *
 *   "ME: Ascended Heroes" / "ME05: Pitch Black" / "ME01: Mega Evolution"
 *   -- 3,499 rows of the Mega Evolution era, which postdates every list here
 *   and which no amount of enumerating known set names could have caught.
 *
 * The fix is NOT to delete the collision guard -- that would put "Platinum"
 * back on a Bowman Platinum sale. It is to notice that the guard answers the
 * wrong question. "Is 'Expedition' a Pokemon word?" is genuinely ambiguous.
 * "Is 'Expedition' a Pokemon word ON A ROW WHOSE PLATFORM IS TCGPLAYER?" is
 * not ambiguous at all: TCGplayer sells no sports cards, so the collision it
 * guards against cannot occur on that row.
 *
 * So these names resolve to pokemon ONLY when a marker proves the vertical
 * independently, and stay unresolved otherwise. Blank still means unknown --
 * a marker is evidence, not a guess.
 */
const POKEMON_SPORTS_COLLIDING_SET_NAMES: readonly string[] = [
  // WotC / e-Card era
  "base set", "expedition", "aquapolis", "skyridge", "southern islands",
  "shadowless", "best of promos", "nintendo promos",
  // EX era (the "<character> - <set> - <finish>" title shape)
  "ex dragon", "ex deoxys", "ex emerald", "ex ruby and sapphire",
  "ex firered & leafgreen", "ex firered and leafgreen", "ex unseen forces",
  "ex team rocket returns", "ex hidden legends",
  // DP / Platinum / HGSS
  "diamond and pearl", "platinum", "rumble",
  // BW / XY
  "black and white", "dragon vault", "generations",
  // SM / SWSH
  "shining legends", "champion's path", "champions path",
  "blister exclusives", "prize pack series", "trading card game classic",
  // Mega Evolution era (2025-)
  "mega evolution", "ascended heroes", "pitch black", "chaos rising",
  "perfect order", "phantasmal flames",
  // structural / promo
  "miscellaneous cards & products", "mcdonald's", "mcdonalds",
];

/**
 * Set-code shape used by TCGplayer's Mega Evolution era: an "ME" ordinal
 * prefix ("ME01:", "ME05:", "MEE:"). Marker-gated like the names above --
 * "ME" is far too short to read as Pokemon on an unproven row.
 */
const POKEMON_ME_ERA_RE = /\bmee?\d{0,2}\s*:/i;

/**
 * Markers that prove a row is Pokemon INDEPENDENTLY of its set name.
 *
 * Each is vocabulary a sports-card listing does not carry. The platform check
 * is the strongest signal and is handled from the caller's `platform` /
 * `category` FIELDS rather than by a title regex, because a field the vendor
 * stamped is stronger evidence than a word someone typed into a title.
 */
const POKEMON_MARKER_PATTERNS: readonly RegExp[] = [
  /\bpok[eé]mon\b/i,
  // Rarity + card-type vocabulary that exists only in the TCG.
  /\bholo(?:foil)?\s+rare\b/i,
  /\breverse\s+holo(?:foil)?\b/i,
  /\b(?:secret|ultra|illustration|amazing|radiant|shiny)\s+rare\b/i,
  /\btrainer\s+(?:gallery|card|kit|deck)\b/i,
  // NOT an energy-type pattern. "<Type> Energy" reads as a Pokemon marker, but
  // it is the one marker a COLLIDING row can carry on its own: "Fighting
  // Energy - Expedition - Normal" would self-mark, unlocking "Expedition"
  // with no evidence from outside the title. That defeats the gate -- the
  // whole point is that a colliding name needs INDEPENDENT proof -- so the
  // energy phrasing is deliberately absent. Those rows resolve on their
  // platform (TCGplayer) instead, which is real evidence.
  /\b\d{1,3}\s*hp\b/i,
  /\b(?:vstar|vmax|v-union|tag team)\b/i,
];

const TCG_TITLE_PATTERNS: readonly RegExp[] = [
  /\bpokemon\b/i,
  /\bpikachu\b/i,
  /\bcharizard\b/i,
  /\bvstar\b|\bvmax\b/i,
  /\bswsh\b|\bsword\s*&?\s*shield\b/i,
  /\bscarlet\s*&?\s*violet\b/i,
  /\bcall of legends\b|\bmajestic dawn\b|\bstormfront\b|\bex sandstorm\b/i,
  /\bpop series\b/i,
  // Hyphen-flattening (above) turns "Yu-Gi-Oh" into "Yu Gi Oh", which
  // `\byu-?gi-?oh\b` cannot match — it allows an optional HYPHEN, not the
  // space the flattening produced. Harmless while an unmatched row merely
  // fell through to `isTcg:false`; NOT harmless once the platform fallback
  // below names a vertical, because the row would be labelled `pokemon`.
  /\byu[\s-]?gi[\s-]?oh\b/i,
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
  reason?: "vertical-field" | "title-pattern" | "set-name" | "character-name" | "set-code" | "tcg-platform" | "marked-set-name";
  /** The vertical when known from the sport field. */
  vertical?: string;
}

/**
 * Platforms that sell TCG product and no sports cards.
 *
 * CF-TCG-SPORTS-COLLIDING-SETS-NEED-A-MARKER (#2006 follow-up). TCGplayer is
 * a TCG marketplace -- a row sourced from it is never a sports card, so the
 * sports-collision guard has nothing to guard against there. This is a FIELD
 * the vendor stamped, not a word parsed out of a title, which is why it can
 * carry the weight of unlocking the colliding set names.
 */
const TCG_ONLY_PLATFORMS: ReadonlySet<string> = new Set(["tcgplayer"]);

/** Does anything on this row prove the TCG vertical on its own? */
function hasPokemonMarker(input: {
  platform?: string | null;
  category?: string | null;
  haystack: string;
}): boolean {
  const platform = String(input.platform ?? "").trim().toLowerCase();
  if (platform && TCG_ONLY_PLATFORMS.has(platform)) return true;
  // TCA stamps `category: "tcg"` on 100% of TCGplayer rows (measured
  // 2026-09-07, 4,000/4,000). A vendor category of "tcg" is a statement about
  // the PRODUCT, which is exactly what the cross-sport rule asks for.
  if (String(input.category ?? "").trim().toLowerCase() === "tcg") return true;
  return POKEMON_MARKER_PATTERNS.some((re) => re.test(input.haystack));
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
  /** Vendor marketplace the sale came from ("TCGplayer", "eBay", ...). */
  platform?: string | null;
  /** Vendor product category ("tcg", "sports", ...). */
  category?: string | null;
  /** Vendor set name, when the feed supplies one separately from the title. */
  setName?: string | null;
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
  const hay = `${input.title ?? ""} ${input.setName ?? ""} ${input.hobbyiqCardId ?? ""}`.replace(/-/g, " ");
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
  // CF-TCG-SPORTS-COLLIDING-SETS-NEED-A-MARKER (#2006 follow-up, 2026-09-08).
  //
  // LAST, and gated. Everything above resolves a row on its own evidence. This
  // branch handles the set names that are real Pokemon sets but collide with
  // sports products -- "Expedition", "Base Set", "Platinum", "Diamond and
  // Pearl", the EX-era names, the 2025 Mega Evolution era -- and it only fires
  // when a marker has ALREADY proved the vertical: a TCG-only platform, a
  // vendor category of "tcg", or TCG-only vocabulary in the text.
  //
  // Order matters for the same reason it does above: this is the weakest
  // signal, so every self-sufficient one keeps its own `reason` and wins.
  //
  // Removing the marker gate makes this branch read a bare "Platinum" or
  // "Base Set" in a SPORTS title as Pokemon, which is the exact harm the
  // omission list was written to prevent -- see the mutation test.
  if (POKEMON_SPORTS_COLLIDING_SET_NAMES.some((n) => flat.includes(n)) ||
      POKEMON_ME_ERA_RE.test(flat)) {
    if (hasPokemonMarker({ platform: input.platform, category: input.category, haystack: flat })) {
      return { isTcg: true, reason: "marked-set-name", vertical: "pokemon" };
    }
  }

  // A TCG-only platform proves the row is TCG even when nothing in the text
  // does: TCGplayer sells no sports cards, so a row sourced from it cannot be
  // one -- and 32.5% of the first live TCGplayer day reached here with no
  // other signal.
  //
  // WHICH TCG it is, though, is a separate claim. Every non-Pokemon game has
  // its own pattern above and keeps its own vertical, so anything reaching
  // here has already failed all of them. Pokemon is named because it is what
  // this feed overwhelmingly is (8,102 of the first 12,000 rows resolved to
  // pokemon on their own evidence, and the 3,898 residual was Pokemon sets to
  // the last row), and because leaving the vertical blank would park the sale
  // out of every pool -- the very outcome this change exists to end.
  if (hasPokemonMarker({ platform: input.platform, category: input.category, haystack: "" })) {
    return { isTcg: true, reason: "tcg-platform", vertical: "pokemon" };
  }

  return { isTcg: false };
}
