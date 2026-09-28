// CF-T206-NAME-TO-POSITION (Drew directive "fix all of baseball now",
// 2026-09-28). Companion to CF-T206-BACK-BRAND-IS-NOT-THE-PLAYER (#2409).
//
// THE GAP. `unnumberedCardSegment` mints `player-<slug>` for every
// unnumbered card, unconditionally -- including t206. But the t206 catalog
// (550 checklist-grade rows, source sportscardchecklist-2026-09-05) is keyed
// by the checklist's own numeric position (`hiq:baseball:1909:t206:<1-550>
// :base:no-auto`), never by `player-<slug>`. The two families are CLOSED and
// DISJOINT -- no rekey, rematch or back-brand cleanup can ever land a
// `player-<slug>` sale on a numeric-position catalog row, because nothing
// mints a `player-<slug>` CATALOG row for the sale to fold onto. Measured on
// a 200-row probe (C:/tmp/t206probe_1430/REPORT.md, 2026-09-27): 0/200
// resolve today, for exactly this reason.
//
// THE FIX. Build a name(+pose)-to-position lookup FROM the same 550-row
// checklist the catalog itself is keyed from (the sportscardchecklist
// excerpt at backend/data/checklists/t206/1909-11-t206-baseball.positions
// .json, derived from backend/tests/fixtures/sportscardchecklist/1909-11
// -t206-baseball.trimmed.html -- 524 of 550 positions; the missing 26 are a
// gap in the fixture excerpt available to this repo, not a defect in this
// resolver, and any sale for one of them correctly falls through to the
// existing player-<slug> behavior). Consult it AFTER the existing back-brand
// strip and BEFORE the player-<slug> fallback.
//
// DISAMBIGUATION RULE (owner-scoped, "absent beats wrong"):
//   - exactly ONE checklist row shares this player's (first, last) name
//     pair  -> resolve to its numeric position, unconditionally.
//   - MORE THAN ONE checklist row shares the name pair (multi-pose players
//     -- Cobb, Mathewson, Seymour, ...) -> only resolve when the sale
//     title's own residue states a pose word that uniquely identifies ONE
//     of the candidate rows' own pose-word tail. Any other outcome (no pose
//     stated, pose stated but still multiple/zero matches) is UNRESOLVED --
//     never a guess.
//   - Rows with an NNO/no-player residue never reach this resolver (the
//     caller already refuses those before this file is consulted).
//
// This module is read-only and has no side effects: it parses a bundled
// JSON checklist snapshot once (lazily, memoized) and answers a pure
// function. It touches nothing about how the checklist itself is stored in
// Cosmos -- the catalog's own 550 rows are untouched by this PR.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "./hobbyIqCardId.service.js";

// backend/src/services/portfolioiq -> backend/data/checklists/t206/...
// Several sibling files in this directory (bareColourAliasFromChecklist.ts,
// checklistSpellingAdoption.ts, parallelVocabulary.service.ts, ...) resolve
// their own bundled data file the same way: __dirname sits at
// dist/services/portfolioiq at runtime, and the exact number of ".." hops
// back to the repo's data/ directory has drifted across build layouts
// before, so a short list of candidate paths is tried in order rather than
// hardcoding one.
const CHECKLIST_CANDIDATE_PATHS = [
  join(__dirname, "..", "..", "..", "data", "checklists", "t206", "1909-11-t206-baseball.positions.json"),
  join(__dirname, "..", "..", "data", "checklists", "t206", "1909-11-t206-baseball.positions.json"),
  join(process.cwd(), "backend", "data", "checklists", "t206", "1909-11-t206-baseball.positions.json"),
  join(process.cwd(), "data", "checklists", "t206", "1909-11-t206-baseball.positions.json"),
];

interface ChecklistRow {
  position: number;
  title: string; // "Al Mattern Portrait" -- "FirstName LastName [PoseWords...]"
}

interface ChecklistFile {
  source: string;
  rows: ChecklistRow[];
}

interface IndexedRow {
  position: number;
  /** slugify(firstName-lastName), e.g. "al-mattern" */
  nameKey: string;
  /** slugified pose words after the name, e.g. "portrait" / "hands-above-head" */
  poseKey: string;
  title: string;
}

let cachedIndex: Map<string, IndexedRow[]> | null = null;

/** Split a checklist title into its (first, last) name prefix and pose
 *  suffix. The checklist has no annotated boundary between them, but every
 *  row is written "FirstName LastName [pose words...]" -- the first two
 *  whitespace-delimited tokens are the name pair on every row this resolver
 *  can use (a handful of back-of-card-variant titles like "Harry Davis H.
 *  Davis" don't fit this shape and simply produce a nameKey that will never
 *  collide with a real sale residue -- inert, not wrong). */
function splitNameAndPose(title: string): { nameKey: string; poseKey: string } {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const namePart = words.slice(0, 2).join(" ");
  const posePart = words.slice(2).join(" ");
  return { nameKey: slugify(namePart), poseKey: slugify(posePart) };
}

function readChecklistFile(): ChecklistFile {
  for (const candidate of CHECKLIST_CANDIDATE_PATHS) {
    try {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, "utf-8")) as ChecklistFile;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "t206ChecklistPositionResolver: could not find 1909-11-t206-baseball.positions.json " +
    `under any of: ${CHECKLIST_CANDIDATE_PATHS.join(", ")}`,
  );
}

function buildIndex(): Map<string, IndexedRow[]> {
  const parsed = readChecklistFile();
  const byName = new Map<string, IndexedRow[]>();
  for (const row of parsed.rows) {
    const { nameKey, poseKey } = splitNameAndPose(row.title);
    if (!nameKey) continue;
    const entry: IndexedRow = { position: row.position, nameKey, poseKey, title: row.title };
    const bucket = byName.get(nameKey);
    if (bucket) bucket.push(entry);
    else byName.set(nameKey, [entry]);
  }
  return byName;
}

function getIndex(): Map<string, IndexedRow[]> {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

/** Test-only: forces the next call to re-read the checklist file from disk.
 *  Production code never calls this -- the index is immutable for the life
 *  of the process, same as every other lazily-memoized lookup in this repo. */
export function _resetT206ChecklistIndexForTests(): void {
  cachedIndex = null;
}

/**
 * Resolve a T206 sale residue (the player-name segment AFTER the existing
 * back-brand strip has already run) to the checklist's own numeric
 * position, or null when it cannot be resolved without guessing.
 *
 * `residue` is the full free-text subject as it survives stripT206BackBrand
 * -- name plus any pose words the title stated ("Cy Seymour Batting",
 * "Al Mattern", "Tris Speaker"). This function does its own name/pose split
 * on it using the SAME first-two-tokens rule the checklist rows use, so a
 * residue that is just a name ("Al Mattern") and a residue that also states
 * a pose ("Cy Seymour Batting") both work without the caller having to
 * separate them first.
 */
export function resolveT206ChecklistPosition(residue: string): number | null {
  const raw = String(residue ?? "").trim();
  if (!raw) return null;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null; // no last name at all -- can't key on a surname

  const nameKey = slugify(words.slice(0, 2).join(" "));
  if (!nameKey) return null;

  let index: Map<string, IndexedRow[]>;
  try {
    index = getIndex();
  } catch {
    // The checklist snapshot could not be found/parsed. Never let a data
    // file outage throw out of the identity deriver -- keep today's
    // player-<slug> behavior exactly as if this resolver did not exist,
    // same contract as playerSegmentIsAPerson's own corpus-outage handling
    // a few lines up in unnumberedCardSegment.
    return null;
  }

  const candidates = index.get(nameKey);
  if (!candidates || candidates.length === 0) return null;

  if (candidates.length === 1) return candidates[0].position;

  // Multi-pose player. Only resolve if the residue states pose words that
  // match EXACTLY ONE candidate's own pose tail. slugify both sides so
  // "Batting" / "batting" / "BATTING" all compare equal.
  const statedPose = slugify(words.slice(2).join(" "));
  if (!statedPose) return null; // no pose stated -- ambiguous, refuse

  const matches = candidates.filter((c) => c.poseKey && c.poseKey === statedPose);
  if (matches.length === 1) return matches[0].position;

  // A looser containment match (either side is a substring of the other,
  // word-for-word) catches minor phrasing drift ("Bat on Shoulder" vs "Bat
  // on Shoulder ") without ever picking between two genuinely different
  // poses -- still refuses on 0 or >1 matches.
  const loose = candidates.filter((c) => {
    if (!c.poseKey) return false;
    return c.poseKey.includes(statedPose) || statedPose.includes(c.poseKey);
  });
  if (loose.length === 1) return loose[0].position;

  return null;
}
