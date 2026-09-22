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
 *  person. Mirrors the suffix set `cleanPlayerName` strips. */
const GENERATIONAL_SUFFIX = /,?\s+(?:Jr|Sr|II|III|IV|V)\.?$/i;

function stripMarkers(name: string): string {
  let out = String(name ?? "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [QUOTED_SUBSET_RE, LEAGUE_LEADER_SUFFIX, ...TRAILING_SUBSET_MARKERS, GENERATIONAL_SUFFIX]) {
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

  const strippedA = stripMarkers(leftName);
  const strippedB = stripMarkers(rightName);
  return foldForCompare(strippedA) === foldForCompare(strippedB);
}

// Exported only for the mirror-equality test's introspection; callers outside
// that test should use `namesAgree`.
export const __internal = {
  stripMarkers, foldForCompare, firstListedName,
  TRAILING_SUBSET_MARKERS, LEAGUE_LEADER_SUFFIX, QUOTED_SUBSET_NAMES, GENERATIONAL_SUFFIX,
};
