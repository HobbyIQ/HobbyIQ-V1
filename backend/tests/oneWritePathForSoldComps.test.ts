/**
 * CF-ONE-WRITE-PATH-FOR-SOLD-COMPS (2026-09-07, #1939 follow-up).
 *
 * THE DOCTRINE. `sold_comps` is ONE unified pool, and emission happens at the
 * call sites THROUGH `recordSoldComp` -- 46 of them. One write path, one guard
 * set, every write reconciles. That is the rule the repo already states.
 *
 * WHAT #1939 FOUND. The rule was true of the 46 callers and false of the
 * container. `backend/scripts/cardsight-bulk/phase-b-crawl-pricing.cjs` built
 * `sold_comps` documents by hand and upserted them STRAIGHT to the container,
 * so neither #1929's split-identity guard nor #1939's malformed-key guard --
 * both of which live inside `recordSoldComp` -- had ever seen a row it wrote.
 * The census behind this test found `persistVendorSalesToPool` doing the same
 * thing at ingest scale, and the sanctioned mover (`relocateSoldComp`, the one
 * way a row changes its key, used by 21 scripts) writing a NEW identity that
 * nothing had validated.
 *
 * The measured cost, from #1939: 8,102 rows wearing an `hiq:` prefix over a
 * key nothing can read back, 100% from the vendor-ingest source, and 337 of
 * them written AFTER #1929's guard shipped -- because the guard was in the
 * function those lanes do not call.
 *
 * -- THE SHAPE OF THE FIX, AND WHY IT IS NOT A SECOND GUARD -----------------
 *
 * `recordSoldComp` is a per-row TRANSACTION: a pre-ingest clean, a dedup
 * query, a cross-partition probe, a catalog seed. A bulk crawl cannot pay that
 * per sale, which is exactly why those lanes hand-rolled the write in the
 * first place. So the GUARD is separated from the TRANSACTION:
 *
 *     guardSoldCompDoc(doc)      the predicate -- pure, no I/O
 *     recordSoldComp(input)      the transaction, which CALLS that predicate
 *
 * One predicate, two entry points. `guardSoldCompDoc` is a thin doc-shaped
 * adapter over `decideSplitIdentity`, which already encodes BOTH guards
 * (malformed-key first, then split-identity); it adds no rule of its own, and
 * a rule added there and not in `decideSplitIdentity` is the reader/writer
 * drift that module's own header refuses.
 *
 * -- WHAT THIS TEST PINS ----------------------------------------------------
 *
 * A file that MINTS a sold_comps document (`items.upsert/create/bulk` on a
 * sold_comps handle) must reach a guard: `recordSoldComp`, `guardSoldCompDoc`,
 * or `relocateSoldComp` (which calls the guard itself). Anything else is on
 * the ALLOWLIST below, and the allowlist is exactly the two entry points.
 *
 * MUTATORS -- files that patch, replace or delete an ADDRESSED row -- are a
 * different population and are NOT policed here. A patch sets `flaggedWrong`
 * or backfills `hobbyiqCardId` on a row the guard already judged at ingest;
 * there are ~150 such repair lanes and requiring each to re-run an identity
 * guard would say nothing true. The line this test draws is the one the
 * defect is on: WHO MINTS A ROW.
 *
 * It is TEXT-LEVEL and it says so. It cannot know what a script does at
 * RUNTIME, only whether it hand-rolled the write instead of calling the shared
 * path -- which is where every one of these defects came from.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROOT, containerWriters, sourceMatches, stripComments, lines,
  type ContainerWriter,
} from "./_helpers/containerWriterCensus.js";

const CONTAINER = "sold_comps";
const DIRS = ["backend/src", "backend/scripts", "mcp-server", "compiq-functions"];

/** The transaction. It calls the predicate; it is not itself a bare exception. */
const STORE_HOME = "backend/src/services/portfolioiq/soldCompsStore.service.ts";
/** The predicate. Pure, no container handle of its own. */
const GUARD_HOME = "backend/src/services/portfolioiq/splitIdentityWriteGuard.ts";
/** The sanctioned mover: the one way a row changes its key. */
const MOVER_HOME = "backend/scripts/lib/relocate-sold-comp.cjs";

/**
 * THE ALLOWLIST. Exactly the shared entry points -- nothing else may mint.
 *
 *   the store           `recordSoldComp`, which owns the transaction AND
 *                       calls `guardSoldCompDoc` at its write door
 *   the guarded mover   `relocateSoldComp`, the one way a row changes its key
 *                       (21 scripts go through it); it runs the SAME predicate
 *                       on the NEW document before it writes, and REFUSES a
 *                       malformed destination outright
 *
 * A file is not added here. A file that needs to mint calls one of these.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([STORE_HOME, MOVER_HOME]);

/** Reaching the predicate: a call, or an import/require of the module owning it. */
const GUARD_CALL = /\b(?:recordSoldComp|guardSoldCompDoc|relocateSoldComp)\s*\(/;
const GUARD_IMPORT =
  /(?:from\s*|require\s*\(\s*)["'][^"']*(?:soldCompsStore\.service|splitIdentityWriteGuard|relocate-sold-comp)(?:\.js|\.cjs)?["']/;
/** A `require(path.join(backend, "dist/.../splitIdentityWriteGuard.js"))`, the .cjs form. */
const GUARD_REQUIRE_JOIN =
  /require\s*\((?:[^()]|\([^()]*\))*(?:splitIdentityWriteGuard|soldCompsStore\.service|relocate-sold-comp)(?:[^()]|\([^()]*\))*\)/;

const guarded = (rel: string) =>
  sourceMatches(rel, GUARD_CALL) || sourceMatches(rel, GUARD_IMPORT) || sourceMatches(rel, GUARD_REQUIRE_JOIN);

let cache: ContainerWriter[] | null = null;
const writers = (): ContainerWriter[] =>
  (cache ??= containerWriters({ containerName: CONTAINER, dirs: DIRS }));

/**
 * A row this file READ OUT OF THE POOL, changed, and wrote back.
 *
 * Mechanically that is `items.upsert`, so the census calls it a mint; the
 * doctrine calls it a patch, and the doctrine is right. `flagComp.routes` sets
 * `__userFlags`, `quarantineView` clears contamination markers,
 * `backfill-grade-from-title` fills a grade -- every one of them writes back a
 * document whose identity came from the pool, which means the guard already
 * judged that identity at ingest. Demanding a guard here would ask these lanes
 * to re-adjudicate an address they did not supply.
 *
 * THE TEST IS "WHERE DID THE DOCUMENT COME FROM", and it is asked of the
 * upserted expression rather than of the file:
 *
 *   `upsert(row)` / `upsert(doc)` / `upsert({ ...row, ... })`   a row read back
 *   `upsert({ id: ..., cardId: ..., ... })`                     a MINT
 *
 * An earlier version of this asked "does the file mention `cardId:` anywhere",
 * which a TypeScript interface (`cardId: string;`) answers yes to -- it called
 * both read-modify-write routes minters for their type declarations. The
 * question has to be about the WRITE.
 *
 * (Their real defect is a different one, and not this test's: a full-document
 * upsert clobbers any concurrent writer's other fields, where a `patch` would
 * not. That is worth fixing; it is not an identity guard's business.)
 */
/** `items.upsert(<expr>)` -- the first ~80 chars of what is being written. */
const UPSERTED = /\bitems\s*\.\s*(?:upsert|create)\s*\(\s*([\s\S]{0,80})/g;
/** A document literal that STATES an identity: `{ id: ..., cardId: ...`. */
const LITERAL_IDENTITY = /^\{[^}]*\b(?:id|cardId|hobbyiqCardId)\s*:/;
/** A spread or a bare name: `{ ...row`, `row`, `doc`, `next`, `merged`. */
const CARRIED_DOC = /^(?:\{\s*\.\.\.|[A-Za-z_$][\w$]*\s*[,)])/;

function readModifyWrite(rel: string): boolean {
  let src = "";
  try { src = stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch { return false; }
  // Nothing was read back -> nothing to modify -> every write states its own
  // identity, whatever it looks like.
  if (!/\.\s*read\s*\(\s*\)|items\s*\.\s*query\s*\(/.test(src)) return false;
  UPSERTED.lastIndex = 0;
  let m: RegExpExecArray | null;
  let sawCarried = false;
  while ((m = UPSERTED.exec(src))) {
    const arg = (m[1] ?? "").trim();
    if (LITERAL_IDENTITY.test(arg)) return false;  // one mint is enough
    if (CARRIED_DOC.test(arg)) sawCarried = true;
  }
  return sawCarried;
}

const minters = () => writers().filter((w) => w.mint);
const describeW = (w: ContainerWriter) =>
  `${w.rel}${w.fallback ? `  [loose match: ${w.fallback}]` : ""}`;

describe("one write path for sold_comps", () => {
  // The census reads every .ts/.cjs/.js/.mjs under four trees. Same cost note
  // as oneWayToBuildACatalogRow: the scan IS the test, so it gets the time.
  it("finds the minters, and says which it could only text-match", { timeout: 240_000 }, () => {
    const all = writers();
    expect(all.length).toBeGreaterThan(0);
    const loose = all.filter((w) => w.fallback).map(describeW);
    // eslint-disable-next-line no-console
    console.log(
      `sold_comps writers: ${all.length} (${minters().length} mint whole documents)` +
      (loose.length ? `\nmatched loosely -- no handle resolved, may be a false positive:${lines(loose)}` : ""),
    );
  });

  it("every sold_comps MINTER reaches a guard", { timeout: 240_000 }, () => {
    const rogue = minters()
      .filter((w) => !ALLOWLIST.has(w.rel) && !guarded(w.rel) && !readModifyWrite(w.rel))
      .map(describeW);
    expect(
      rogue,
      "these create or replace whole sold_comps documents without reaching recordSoldComp, " +
      "guardSoldCompDoc or relocateSoldComp. A row written this way is filed under an address " +
      "nothing checked -- the #1939 defect. Route it through the guard; do not add it here:" +
      lines(rogue),
    ).toEqual([]);
  });

  it("the allowlist is EXACTLY the shared entry points", () => {
    // A name may not accumulate here. If a third entry point is ever genuinely
    // needed it is a deliberate change to this assertion, argued in a PR --
    // not a line quietly appended to a set.
    expect([...ALLOWLIST].sort()).toEqual([STORE_HOME, MOVER_HOME].sort());
  });

  it("the allowlisted entries still exist and still write the pool", { timeout: 240_000 }, () => {
    // A stale allowlist silently re-permits the next regression: if an entry
    // stops writing, it must go, or it is covering nothing while looking like
    // protection.
    //
    // NEITHER entry resolves by container NAME, and that is a fact about each
    // of them rather than a gap. The store reaches its handle through
    // `containers.createIfNotExists({ id: containerId })`, where `containerId`
    // is `process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps"` bound a few
    // lines earlier; the mover is handed its `pool` by 21 different callers and
    // names no container at all. So the census cannot see them, and they are
    // checked HERE, on what actually makes them the write path: each one
    // upserts, and each one runs the shared predicate.
    const stale: string[] = [];
    for (const rel of ALLOWLIST) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) { stale.push(`${rel}  (file deleted)`); continue; }
      const src = fs.readFileSync(abs, "utf8");
      if (!/items\s*\.\s*upsert\s*\(/.test(src)) stale.push(`${rel}  (no longer upserts)`);
      if (!/guardSoldCompDoc/.test(src)) stale.push(`${rel}  (no longer runs the shared predicate)`);
    }
    expect(stale, `allowlisted but no longer a guarded write path -- remove:${lines(stale)}`).toEqual([]);
  });

  it("the two entry points share ONE predicate -- the store calls the guard", () => {
    // The whole design rests on this: if the store ever stops calling
    // guardSoldCompDoc it has grown a second copy of the rule, and the bulk
    // lanes drift away from the transaction lane exactly as #1939 describes.
    const store = fs.readFileSync(path.join(ROOT, STORE_HOME), "utf8");
    expect(
      /guardSoldCompDoc\s*\(/.test(store),
      "recordSoldComp must apply the SAME predicate the bulk entry points apply. " +
      "A guard inlined here instead is a second guard, and the two will drift.",
    ).toBe(true);
    // ...and the predicate must be the doc-shaped face of decideSplitIdentity,
    // never a rule of its own.
    const guard = fs.readFileSync(path.join(ROOT, GUARD_HOME), "utf8");
    expect(
      /export function guardSoldCompDoc[\s\S]*?decideSplitIdentity\s*\(/.test(guard),
      "guardSoldCompDoc must delegate to decideSplitIdentity -- it is an adapter, not a second rule set.",
    ).toBe(true);
  });

  it("the sanctioned mover validates the NEW identity, not just the ORDER", () => {
    // relocateSoldComp guarantees a sale is never lost between the upsert and
    // the delete. That is about ORDER. Being sanctioned to move a row is not
    // permission to move it to an address nobody can read back -- a `to` value
    // comes from a list file, and a mover that writes it unchecked mints
    // exactly the keys #1939 measured, with a verified read-back to prove it.
    const mover = fs.readFileSync(path.join(ROOT, MOVER_HOME), "utf8");
    expect(
      /guardSoldCompDoc/.test(mover),
      "relocateSoldComp must run the shared predicate on the document it keeps",
    ).toBe(true);
    expect(
      /malformed-key/.test(mover),
      "relocateSoldComp must REFUSE a malformed destination outright -- an unaddressable key has no pool to be parked out of",
    ).toBe(true);
  });
});
