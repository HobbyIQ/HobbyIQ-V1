/**
 * nameAgreement.ts -- MIRROR of `scripts/lib/name-agreement.cjs`, for
 * `arbitratePlayer`'s different-player conflict gate (catalogRowOps.service.ts)
 * ONLY.
 *
 * Restated here rather than imported for the reason `pokemonFinishFromTitle.ts`
 * and `playerSegmentIsAPerson` both record for their own mirrors: the canonical
 * copy is a `.cjs` under `scripts/`, and nothing in `src/` depends on
 * `scripts/`. `nameAgreementMirrorsScriptsLib.test.ts` asserts TABLE EQUALITY
 * against the `.cjs` in both directions (same vocabulary, same verdicts on the
 * same fixture pairs), so a rule changed in one copy and not the other is a red
 * test, not a silently diverged spelling.
 *
 * See `scripts/lib/name-agreement.cjs` for the full ruling and the diagnosis
 * (run 35638061024) this exists to close: 127 catalog different-player
 * refusals, all classified as name-SHAPE noise -- multi-player league-leader
 * cards read against a bare first name, a subset tag (RCup/FS/quoted insert
 * name) on one side only, or Jr./Sr. presence. This function narrows
 * `arbitratePlayer`'s conflict gate so those shapes are recognised as
 * AGREEMENT and fall through to the ordinary authority/vendorIds/sales/
 * confidence ladder, exactly like an RC-suffixed name already does via
 * `playerIdentityKey`'s cleanPlayerName pass. It answers a different question
 * than `playerIdentityKey` does, and is consulted separately -- see the header
 * comment at this function's call site in `arbitratePlayer`.
 */

/** Trailing subset/rookie markers seen in the diagnosed run, closed list. */
const TRAILING_SUBSET_MARKERS: readonly RegExp[] = [/\s+RCup$/i, /\s+FS$/i];

/** League-leader suffix: "LL AL HR", "LL NL ERA", etc. */
const LEAGUE_LEADER_SUFFIX = /\s+LL\s+(?:AL|NL)\s+(?:HR|RBI|ERA|W|AVG)$/i;

/** Quoted subset/insert names actually seen in the 127 refusals. A closed
 *  list -- a quoted phrase not on it is left alone. */
const QUOTED_SUBSET_NAMES: readonly string[] = [
  "Say Cheese!",
  "It Takes Two",
  "All Smiles",
  "Let's Dance!",
  "Bronx Bombers II",
  "Hoop Dreams",
  "Incoming!",
];

const QUOTED_SUBSET_RE = new RegExp(
  `\\s+[""](?:${QUOTED_SUBSET_NAMES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[""]$`,
);

/** Generational suffixes: presence on one side only is not a different
 *  person, but Jr. vs Sr. (or any two DIFFERENT tokens here) is a different,
 *  both-carded person -- Griffey, Ripken, Guerrero, Bonds, Fielder, Alomar,
 *  Tatis, Witt. Mirrors the suffix set `cleanPlayerName` strips. CAPTURING,
 *  unlike the other markers, so the token can be compared, not just dropped. */
const GENERATIONAL_SUFFIX = /,?\s+(Jr|Sr|II|III|IV|V)\.?$/i;

/** Pull the generational suffix token off the END of a name, once. */
function extractGenerationalSuffix(name: string): { base: string; suffix: string | null } {
  const s = String(name ?? "").trim();
  const m = s.match(GENERATIONAL_SUFFIX);
  if (!m) return { base: s, suffix: null };
  return { base: s.slice(0, m.index).trim(), suffix: m[1].toLowerCase() };
}

/** Both blank or exactly one present -> presence-vs-absence, compatible.
 *  Both present -> must be the SAME token (Jr. == Jr.); Jr. vs Sr. or
 *  II vs III is a real disagreement this rule alone refuses on. */
function suffixesCompatible(suffixA: string | null, suffixB: string | null): boolean {
  if (!suffixA || !suffixB) return true;
  return suffixA === suffixB;
}

function stripMarkers(name: string): string {
  let out = String(name ?? "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [QUOTED_SUBSET_RE, LEAGUE_LEADER_SUFFIX, ...TRAILING_SUBSET_MARKERS]) {
      if (re.test(out)) {
        out = out.replace(re, "").trim();
        changed = true;
      }
    }
  }
  return out;
}

function foldForCompare(name: string): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function firstListedName(name: string): string | null {
  const s = String(name ?? "");
  if (!s.includes(" / ")) return null;
  const first = s.split(" / ")[0];
  return first ? first.trim() : null;
}

/**
 * Do these two ALREADY-STORED playerName strings agree, for the purpose of
 * `arbitratePlayer`'s different-player conflict gate ONLY? See the header for
 * the four rules and their order. `true` narrows what counts as a conflict;
 * it never manufactures one.
 */
export function namesAgree(nameA: unknown, nameB: unknown): boolean {
  const a = String(nameA ?? "").trim();
  const b = String(nameB ?? "").trim();
  if (!a || !b) return false;

  const firstA = firstListedName(a);
  const firstB = firstListedName(b);
  let leftName = a;
  let rightName = b;
  if (firstA && !firstB) leftName = firstA;
  if (firstB && !firstA) rightName = firstB;

  // Rule (c) overrides everything else: a real suffix-vs-suffix disagreement
  // (Jr. vs Sr., II vs III) refuses the pair regardless of the base name.
  const { base: baseA, suffix: suffixA } = extractGenerationalSuffix(leftName);
  const { base: baseB, suffix: suffixB } = extractGenerationalSuffix(rightName);
  if (!suffixesCompatible(suffixA, suffixB)) return false;

  const strippedA = stripMarkers(baseA);
  const strippedB = stripMarkers(baseB);
  return foldForCompare(strippedA) === foldForCompare(strippedB);
}

// Exported only for the mirror-equality test's introspection; callers outside
// that test should use `namesAgree`.
export const __internal = {
  stripMarkers, foldForCompare, firstListedName, extractGenerationalSuffix, suffixesCompatible,
  TRAILING_SUBSET_MARKERS, LEAGUE_LEADER_SUFFIX, QUOTED_SUBSET_NAMES, GENERATIONAL_SUFFIX,
};
