// ---------------------------------------------------------------------------
// slugFragmentation.ts
//
// CF-A-DISTINCT-CARD-IS-NOT-FRAGMENTATION (#1954, 2026-09-07).
//
// The cleanliness canary has one axis that has never measured what it names.
// It called a card "fragmented" when one `(cardYear, setName, cardNumber)`
// tuple carried more than one `hobbyiqCardId`, and it counted EVERY slug in
// that tuple as a defect. That tuple has no parallel segment, no auto flag and
// no print run -- so it groups together exactly the things the doctrine says
// are DIFFERENT CARDS:
//
//     hiq:pokemon:2023:151:151:master-ball:no-auto      Master Ball
//     hiq:pokemon:2023:151:151:poke-ball:no-auto        Poke Ball
//     hiq:pokemon:2023:151:151:base:no-auto             the ordinary card
//
// Three cards, three pools, three prices -- and the shipped axis reads them as
// one identity written three ways and fails the workflow. That is the reading
// that made the canary chronically red at "slug fragmentation 6.64%" while the
// DATA underneath it was right. "One card, one row, one pool" is a rule about
// one CARD; a named parallel is a distinct card (Drew), a finish is a distinct
// card line (#1935), and a print-run variant and an auto are distinct cards
// that the slug already spells out. None of them are fragmentation.
//
// ── WHAT FRAGMENTATION ACTUALLY IS ─────────────────────────────────────────
//
// Fragmentation is two slugs that the fold and re-key lanes WOULD MERGE: one
// card sitting at two addresses because two writers spelled one identity two
// ways. The test is not "do these slugs differ" but "do they still differ
// after every canonicalization this codebase already owns has run":
//
//   normalizeParallel        the ingest spelling rules (ray-wave/raywave,
//                            x-fractor/xfractor, mega->mojo, plural heads)
//   foldPokemonFinishToken   #1937's Pokemon finish fold, under the SAME
//                            sport gate the builder applies it under:
//                            `holo`/`foil`/`holofoil` are ONE token, and every
//                            `reverse-*` is `reverse-holofoil` and never folds
//                            onto the holo family
//   foldSpelling             D31's cross-source spelling fold
//                            (`refractors-refractor` == `refractor`)
//   playerIdentityKey        #1930's player fold, so "Miracle Sphere α" and
//                            "Miracle Sphere Alpha" are one key and NOT two
//
// Two slugs whose canonical keys AGREE are fragmentation and a lane can repair
// them. Two slugs whose canonical keys DIFFER are two cards, and the canary
// must say nothing about them at all.
//
// ── A GRADE TIER IS NOT A SECOND ADDRESS FOR ONE CARD ──────────────────────
//
// The first cut of this file stripped the grade tier through `cardIdentityKey`,
// on the reasoning that a PSA 10 and its raw parent are "one card at two
// grades". Run against 12h of live ingest that produced exactly one flagged
// group, and it was wrong:
//
//     hiq:baseball:2021:topps:11:base:no-auto:bgs-10
//     hiq:baseball:2021:topps:11:base:no-auto
//
// CF-CARD-IDENTITY-VS-GRADE is explicit that those are the SAME card in two
// PRICING dimensions, and that both rows are supposed to exist -- the grade
// explode (`grade-explode-2026-08-10`) mints one row per (card, grade) on
// purpose, so "all grades are available for people". A graded row beside its
// raw parent is that design working, not two writers spelling one identity two
// ways, and no fold lane would ever merge them. So the tier is KEPT in the key.
// Reporting it would have re-created the exact defect this file exists to fix,
// one dimension over.
//
// ── THE DIRECTION OF THE ERROR MATTERS ─────────────────────────────────────
//
// The old axis was not merely noisy, it was noisy in the direction that hides
// real defects. A canary pinned red by 6.64% of legitimate Pokemon parallels
// reports the same red when a genuine holo/holofoil split appears, so the
// signal the axis exists to carry cannot be seen. Narrowing the axis to the
// rows a lane would actually merge is what makes a red mean something again.
//
// ── WHY THE SLUG AND NOT THE ROW FIELDS ────────────────────────────────────
//
// The comparison reads the STORED SLUG, because the slug is the address the
// pool is keyed by and therefore the thing that can fragment. A row's own
// `parallel` text is the vendor's word and is deliberately preserved unchanged
// (that is what let the CF-BASE-IS-NOT-A-REFRACTOR sweep find its rows); it is
// not where two pools come from. `playerName` is read as well, because #1930's
// fold is a claim about the NAME and a slug carries no player.
//
// Pure: no I/O, no clock, no Cosmos.
// ---------------------------------------------------------------------------

import {
  normalizeParallel,
  foldPokemonFinishToken,
  parseHobbyIqCardId,
} from "./hobbyIqCardId.service";
import { GRADE_TIER_RE } from "./cardIdentityKey.service";
import { foldSpelling } from "../catalog/parallelSpellingFold";
import { playerIdentityKey } from "../catalog/playerIdentityKey";

/** One row as the axis needs to see it: an address, and the name on it. */
export interface FragmentationRow {
  hobbyiqCardId?: string | null;
  playerName?: string | null;
}

/**
 * Split a stored slug into its identity part and its grade tier, if it has one.
 *
 * `parseHobbyIqCardId` rejects a slug carrying a tier (it is one segment too
 * long), so the tier has to come off before the parse and go back into the key
 * afterwards -- the tier is kept, per the header, but it is not a segment the
 * parser knows about.
 *
 * The check is POSITIONAL, exactly as `cardIdentityKey` argues it must be: a
 * card number of `psa-th2` lives in segment 4, and a blind match on a slug
 * cannot tell segment 4 from the tail. Only the LAST segment is tested, and
 * only when removing it leaves a slug the parser accepts -- so a row whose
 * number merely looks like a grade is never mistaken for a graded child.
 */
function splitGradeTier(slug: string): { identity: string; tier: string } {
  const parts = slug.split(":");
  if (parts.length > 1 && GRADE_TIER_RE.test(parts[parts.length - 1])) {
    const identity = parts.slice(0, -1).join(":");
    // The PARSE is what confirms the tail was a tier. A slug that no longer
    // parses without its last segment never had one to remove, so it is left
    // whole and `parseHobbyIqCardId` gets the final say either way.
    if (parseHobbyIqCardId(identity)) {
      return { identity, tier: parts[parts.length - 1].toLowerCase() };
    }
  }
  return { identity: slug, tier: "" };
}

/** One group of slugs the axis judged to be a single card. */
export interface FragmentGroup {
  /** The canonical key every slug in this group reduces to. */
  canonicalKey: string;
  /** The distinct STORED slugs sharing it — always 2 or more. */
  slugs: string[];
  /** How many sampled rows sit on those slugs, in total. */
  rows: number;
}

export interface FragmentationResult {
  /** Rows that carried a usable slug and were therefore judged. */
  considered: number;
  /** Rows sitting on a slug that shares its canonical key with another slug. */
  fragmentedRows: number;
  /** The groups themselves, largest first. */
  groups: FragmentGroup[];
}

/**
 * The canonical PARALLEL token for a slug's parallel segment, under this
 * row's sport.
 *
 * Order is deliberate and each step is the function that already owns its
 * question. `normalizeParallel` first, because the fold tables are written
 * against normalized slugs (#1937 pins its table's keys as `normalizeParallel`
 * fixed points). The Pokemon fold second, and ONLY for Pokemon: "Foil" is a
 * real Skybox finish and "Holo" is Panini Optic's word, so folding them in a
 * sports set would merge two real pools -- the same gate the builder applies.
 * `foldSpelling` last, because it is the cross-source spelling question and is
 * sport-agnostic.
 */
export function canonicalParallelToken(parallelSlug: string, sport: string): string {
  const normalized = normalizeParallel(parallelSlug);
  const folded = String(sport ?? "").toLowerCase() === "pokemon"
    ? foldPokemonFinishToken(normalized)
    : normalized;
  return foldSpelling(folded) || folded;
}

/**
 * The key two rows must SHARE before they can be called one card written twice.
 *
 * Returns null when the slug is absent or does not parse: an unparseable slug
 * is not evidence of fragmentation, and guessing at its shape is how a
 * positional reader mistakes a `psa-th2` card number for a grade. Rows that
 * return null are excluded from the denominator too, so an ingest that starts
 * writing malformed slugs shows up on the missing-hobbyiqCardId axis (which
 * exists for exactly that) rather than silently inflating or deflating this one.
 *
 * The print run, the auto flag and the grade tier are all KEPT. The first two
 * are identity -- a /499 and a /50 are different cards, and so are an auto and
 * its base. The third is the pricing dimension the grade explode deliberately
 * gives its own row; see the header.
 */
export function fragmentationKey(row: FragmentationRow): string | null {
  const slug = String(row.hobbyiqCardId ?? "").trim();
  if (!slug) return null;
  const { identity, tier } = splitGradeTier(slug);
  const parsed = parseHobbyIqCardId(identity);
  if (!parsed) return null;

  const sport = String(parsed.sport ?? "").toLowerCase();
  const parallel = canonicalParallelToken(String(parsed.parallel ?? ""), sport);
  // The player key joins the address, so that #1930's fold is visible here:
  // two slugs that agree on every segment but sit under two spellings of one
  // name are one card, and two DIFFERENT players at one address are not one
  // card no matter how the segments read.
  const player = playerIdentityKey(row.playerName);

  return [
    sport,
    String(parsed.year ?? ""),
    String(parsed.setKey ?? ""),
    parsed.subsetName ? `sub-${parsed.subsetName}` : "",
    String(parsed.cardNumber ?? "").toLowerCase(),
    parallel,
    parsed.isAuto ? "auto" : "no-auto",
    parsed.printRun ? `num-${parsed.printRun}` : "",
    tier,
    `p-${player}`,
  ].join("|");
}

/**
 * Score a sample: which rows sit on a slug that a fold lane would merge into
 * another slug in the same sample.
 *
 * A group of ONE slug is not fragmentation however many rows it holds -- that
 * is simply a card with sales. Only a canonical key carrying two or more
 * DISTINCT stored slugs counts, and then every row on those slugs counts,
 * because every one of them is in a pool that should have been one pool.
 */
export function scoreFragmentation(rows: readonly FragmentationRow[]): FragmentationResult {
  const byKey = new Map<string, Map<string, number>>();
  let considered = 0;

  for (const r of rows ?? []) {
    const key = fragmentationKey(r);
    if (key === null) continue;
    // The STORED slug is what fragments, so the STORED slug is what is counted
    // distinct. The key is only ever the question "would a lane merge these?".
    const slug = String(r.hobbyiqCardId ?? "").trim();
    if (!slug) continue;
    considered++;
    const slugs = byKey.get(key) ?? new Map<string, number>();
    slugs.set(slug, (slugs.get(slug) ?? 0) + 1);
    byKey.set(key, slugs);
  }

  const groups: FragmentGroup[] = [];
  let fragmentedRows = 0;
  for (const [canonicalKey, slugs] of byKey) {
    if (slugs.size < 2) continue;
    let rowCount = 0;
    for (const n of slugs.values()) rowCount += n;
    fragmentedRows += rowCount;
    groups.push({ canonicalKey, slugs: [...slugs.keys()], rows: rowCount });
  }
  groups.sort((a, b) => b.rows - a.rows || a.canonicalKey.localeCompare(b.canonicalKey));

  return { considered, fragmentedRows, groups };
}
