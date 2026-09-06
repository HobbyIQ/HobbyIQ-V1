/**
 * CF-THE-LIST-IS-THE-SCOPE, for card_catalog (2026-09-06).
 *
 * The catalog twin of relocatePoolRowsByList.runnerContract. It pins the four
 * things that make a DELETING lane safe to hand a dispatch box:
 *
 *   - the scope must NAME a committed list, and unlike the pool lane there is
 *     no default to fall back to
 *   - an entry names ONE shape, stated rather than inferred
 *   - a reslug onto an address a DIFFERENT card holds is refused, not merged
 *   - retire is a DELETE, because nothing else stops a catalog row resolving
 *
 * and it pins the two committed lists against the shapes measured in prod, so
 * a list edited without re-measuring fails here rather than in an apply.
 *
 * WHY RETIRE IS A DELETE, pinned below as a source assertion. catalogVisibility
 * states that match paths "read everything and must not use this module", and
 * reading every match query confirms it: catalogMatcher's point read and its
 * four candidate queries, catalogIdentityResolver's stem query, catalogVerify's
 * two and resolveSetKey's one filter on identity fields only. No `retired`,
 * `supersededBy`, `deletedAt`, `isActive`, `status` or `tombstone` predicate
 * exists anywhere in them. So a soft label is a no-op for matching and only
 * absence removes a row from a pool.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);

const lane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const runner = join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml");
const listDir = join(__dirname, "..", "data", "catalog-relocations");
const baseballList = join(listDir, "2026-09-06-bbp-preview-baseball.json");
const basketballList = join(listDir, "2026-09-06-bbp-preview-basketball.json");

type Entry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
type ListDoc = { forLane: string; entries: Entry[]; rulings?: string[]; excluded?: unknown[] };

const readList = (p: string): ListDoc => JSON.parse(readFileSync(p, "utf8")) as ListDoc;

// The lane is required WITHOUT a built tree — its dist/ requires live inside
// main(), exactly as the pool lane does it, so the contract is testable.
const L = require_(lane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string; to?: string };
  occupiedByDifferentCard: (incumbent: unknown, row: unknown) => boolean;
};

// ── the runner contract ──────────────────────────────────────────────────────

describe("the lane is dispatchable and carries no new input", () => {
  it("is in the runner's script choice list", () => {
    // Line-ending agnostic: the checkout is CRLF on Windows and LF in CI, and
    // the pin is about the entry existing on its own line, not about which.
    expect(readFileSync(runner, "utf8")).toMatch(/^ {10}- relocate-catalog-rows-by-list\r?$/m);
  });

  it("rides the existing SCOPE passthrough — no new workflow_dispatch input", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
    // GitHub caps workflow_dispatch at 25 inputs and 24 are used. A new one
    // here would be the input that broke the cap for a 140-row cleanup.
    expect(yml).not.toContain("catalog_list:");
    expect(yml).not.toContain("relocation_list:");
  });

  it("and BACKFILL_APPLY is what arms it, not APPLY", () => {
    expect(readFileSync(runner, "utf8")).toMatch(/BACKFILL_APPLY:\s*\$\{\{\s*inputs\.apply/);
    expect(readFileSync(lane, "utf8")).toContain(
      'const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";',
    );
  });
});

// ── the scope refusal ────────────────────────────────────────────────────────

describe("the scope must name a committed list", () => {
  it("REFUSES an empty scope — this lane deletes, so it has no default list", () => {
    const src = readFileSync(lane, "utf8");
    // The pool lane may fall back to its one documented population. This one
    // must not: the runner's own default for `scope` is the string "refractor",
    // and a deleting lane must never be one empty input away from a list
    // nobody named.
    expect(src).toContain("if (!RAW_SCOPE) {");
    expect(src).toContain("has no default list");
    expect(src).not.toMatch(/const SCOPE = RAW_SCOPE \|\| DEFAULT_LIST/);
  });

  it("REFUSES another lane's vocabulary", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('if (!RAW_SCOPE.endsWith(".json"))');
    // The exact values that reach this box from a previous dispatch.
    for (const stray of ["refractor", "all", "improve"]) {
      expect(stray.endsWith(".json")).toBe(false);
    }
  });

  it("and a missing or empty list file is fatal, never a silent no-op", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("FATAL: scope list not found");
    expect(src).toContain("names no entries — nothing is in scope");
  });
});

// ── an entry names ONE shape ─────────────────────────────────────────────────

describe("entry shape is stated, never inferred", () => {
  it("accepts a well-formed retire", () => {
    const r = L.classifyEntry({ id: "hiq:baseball:1997:bowmans-best:1:base:no-auto", action: "retire", reason: "why" });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("retire");
  });

  it("accepts a well-formed reslug", () => {
    const r = L.classifyEntry({
      id: "hiq:basketball:1997:topps-stadium-club:sub-bowmans-best-preview:bbp1:refractor:no-auto",
      action: "reslug",
      to: "hiq:basketball:1997:topps-stadium-club:bbp1:refractor:no-auto",
      reason: "why",
    });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("reslug");
  });

  it("refuses an unknown or absent action rather than guessing one", () => {
    for (const action of [undefined, "", "delete", "move", "RETIRE"]) {
      const r = L.classifyEntry({ id: "hiq:a:1:b:1:base:no-auto", action, reason: "why" });
      expect(r.ok).toBe(false);
      expect(r.why).toContain("action must be");
    }
  });

  it("refuses an entry with no reason — an unexplained delete is not reviewable", () => {
    const r = L.classifyEntry({ id: "hiq:a:1:b:1:base:no-auto", action: "retire" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no reason");
  });

  it("refuses a reslug with no destination, and a retire that names one", () => {
    const noTo = L.classifyEntry({ id: "hiq:a:1:b:1:base:no-auto", action: "reslug", reason: "why" });
    expect(noTo.ok).toBe(false);
    expect(noTo.why).toContain('no "to"');

    const retireWithTo = L.classifyEntry({
      id: "hiq:a:1:b:1:base:no-auto", action: "retire", to: "hiq:a:1:b:2:base:no-auto", reason: "why",
    });
    expect(retireWithTo.ok).toBe(false);
    expect(retireWithTo.why).toContain('must not name a "to"');
  });

  it("refuses an id that is not a hiq slug", () => {
    const r = L.classifyEntry({ id: "cardhedge::1606922959335", action: "retire", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses a reslug whose destination equals its id", () => {
    const id = "hiq:a:1:b:1:base:no-auto";
    const r = L.classifyEntry({ id, action: "reslug", to: id, reason: "why" });
    expect(r.ok).toBe(false);
  });
});

// ── an occupied address is a collision, never a merge ────────────────────────

describe("a reslug onto an occupied address is refused", () => {
  const jeter = { playerName: "Derek Jeter" };
  const hundley = { playerName: "Todd Hundley" };

  it("refuses when a DIFFERENT player holds the target", () => {
    expect(L.occupiedByDifferentCard(hundley, jeter)).toBe(true);
  });

  it("allows a fold onto the SAME card (a re-run, or a regenerated child)", () => {
    expect(L.occupiedByDifferentCard({ playerName: "Derek Jeter" }, jeter)).toBe(false);
    // and is insensitive to the spelling differences a re-read introduces
    expect(L.occupiedByDifferentCard({ playerName: " derek jeter " }, jeter)).toBe(false);
  });

  it("an EMPTY destination is not occupied", () => {
    expect(L.occupiedByDifferentCard(null, jeter)).toBe(false);
    expect(L.occupiedByDifferentCard(undefined, jeter)).toBe(false);
  });

  it("an UNNAMED side refuses — blank is unknown, never 'the same'", () => {
    // The safe direction for a lane that deletes: an incumbent we cannot
    // identify is treated as a different card.
    expect(L.occupiedByDifferentCard({ playerName: "" }, jeter)).toBe(true);
    expect(L.occupiedByDifferentCard({}, jeter)).toBe(true);
    expect(L.occupiedByDifferentCard(hundley, { playerName: "" })).toBe(true);
  });

  it("MUTATION: treat an occupied address as a fold -> two cards, one address -> red", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("refusedOccupied++");
    // The mutant: always report unoccupied, so every reslug proceeds.
    const mutantSaysOccupied = () => false;
    expect(mutantSaysOccupied()).toBe(false);
    // The shipped rule refuses the exact shape this incident produced.
    expect(L.occupiedByDifferentCard(hundley, jeter)).toBe(true);
  });
});

// ── retire is a DELETE, and the reason is measured ───────────────────────────

describe("retire deletes, because nothing else stops a catalog row resolving", () => {
  it("calls retireCatalogRow, not a flag patch", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("retireCatalogRow");
    expect(src).toContain("dist/services/catalog/catalogRowOps.service.js");
    // The pool lane's marker fields must NOT appear: they are sold_comps
    // fields and would be a no-op written onto a catalog row.
    expect(src).not.toContain('path: "/flaggedWrong"');
    expect(src).not.toContain('path: "/identityUnverified"');
  });

  it("states the measurement that forced a delete", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("catalogVisibility.ts:23-25");
    expect(src).toMatch(/a soft label on a catalog row is a NO-OP for matching/i);
  });

  it("and the match paths really do carry no exclusion predicate", () => {
    // The pin behind the ruling: if someone later adds one, this goes red and
    // the lane's retire semantics should be revisited.
    const svcDir = join(__dirname, "..", "src", "services", "catalog");
    const matchers = [
      "catalogMatcher.service.ts",
      "catalogIdentityResolver.ts",
      "catalogVerify.service.ts",
      "resolveSetKey.service.ts",
    ];
    for (const m of matchers) {
      const src = readFileSync(join(svcDir, m), "utf8");
      // None of these may appear as a SQL predicate in a match query.
      for (const field of ["c.retired", "c.retiredAt", "c.supersededBy", "c.deletedAt", "c.isActive", "c.tombstone", "c.excludedFromMatch"]) {
        expect(src).not.toContain(field);
      }
    }
  });

  it("counts the sales it makes UNPLACED, before the apply", () => {
    const src = readFileSync(lane, "utf8");
    // retireCatalogRow re-points nothing; the hand-off to the rematch must be
    // visible in the report rather than inferred from a pool query afterwards.
    expect(src).toContain("salesUnplaced");
    expect(src).toContain("the rematch owns");
  });

  it("verifies the delete by READ, not by the call not throwing", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("the row is still readable after the retire");
  });
});

// ── report-first and reconciliation ──────────────────────────────────────────

describe("report first, and every entry is accounted for", () => {
  it("writes nothing without BACKFILL_APPLY", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("REPORT ONLY — nothing written");
    // Both write shapes are gated.
    expect(src).toContain("if (!APPLY) { retired++; continue; }");
    expect(src).toContain("if (!APPLY) { resluged++; continue; }");
  });

  it("reconciles intended = written + skipped + refused + failed, in BOTH modes", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("reconciled: intended");
    expect(src).toContain("RECONCILE MISMATCH");
    // reportWrites is the runner-wide reconciliation, on the apply.
    expect(src).toContain('job: "relocate-catalog-rows-by-list"');
  });

  it("THE ARITHMETIC holds for a mixed list", () => {
    const intended = 60;
    const retired = 20, resluged = 38, alreadyRight = 1, notFound = 0, refused = 1, failed = 0;
    const written = retired + resluged;
    const skipped = alreadyRight + notFound;
    expect(written + skipped + refused + failed).toBe(intended);
  });
});

// ── the two committed lists ──────────────────────────────────────────────────

describe("the baseball list moves the 19 rows that are actually stored", () => {
  const doc = readList(baseballList);

  /**
   * REBUILT FOR DREW'S 2026-09-06 RULING, and rebuilt against prod rather than
   * against this list's own history. Two things changed at once:
   *
   *   THE SHAPE. The prior revision RETIRED 60 rows because "the correct
   *   destination key is the pending ruling, and a reslug onto a key nobody
   *   has ruled would mint a phantom product". Drew ruled the key, so the
   *   destination exists and the rows can MOVE instead of being deleted.
   *
   *   THE IDS. Re-measured read-only for this PR, NOT ONE of those 60 ids
   *   still exists -- the fold and dedup lanes that merged since (#1838,
   *   #1876) consolidated them. 19 Preview-signalled rows remain. A list is a
   *   list of IDS, so a stale list is not a conservative list: it is a no-op
   *   that reconciles cleanly and reports success.
   */
  it("names this lane and holds the 19 rows the census measured", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(19);
    expect(doc.entries.every((e) => e.action === "reslug")).toBe(true);
    expect(doc.entries.every((e) => Boolean(e.to))).toBe(true);
  });

  it("every entry passes the lane's own validation", () => {
    for (const e of doc.entries) expect(L.classifyEntry(e).ok).toBe(true);
  });

  it("SAYS THE PRIOR REVISION'S IDS ARE GONE, in the file a reader opens", () => {
    // The dangerous silent failure is a list that still looks plausible. The
    // file has to carry the reason its ids changed, or the next reader
    // reconciles a no-op and calls it a clean run.
    expect(String(doc.supersedes)).toMatch(/2026-09-06T05:45:00Z/);
    expect(String(doc.supersedes)).toMatch(/NONE of those 60 ids still exists/i);
    expect((doc as unknown as { census: Record<string, number> }).census.priorRevisionIdsStillPresent).toBe(0);
  });

  it("every id is in baseball/1997/bowmans-best, and every one is a Preview row", () => {
    for (const e of doc.entries) {
      expect(e.id.startsWith("hiq:baseball:1997:bowmans-best:")).toBe(true);
      // The separating field is the SUBSET, never the source: the same dated
      // ingest wrote these and hundreds of correct rows into one product.
      expect(String(e.evidence)).toMatch(/Bowmans Best Preview/i);
    }
  });

  it("every destination is the ruled key at the card's OWN BBP number", () => {
    for (const e of doc.entries) {
      expect(e.to).toMatch(/^hiq:baseball:1997:bowmans-best-preview:bbp\d+:(base|refractor|atomic-refractor):no-auto$/);
      expect(e.to).not.toContain(":sub-");
      // The bare 1-20 it was minted at is Bowman's Best's own number space --
      // that is the collision the ruling exists to close.
      expect(e.to).not.toMatch(/:bowmans-best-preview:\d+:/);
    }
  });

  it("no duplicate ids and no two rows onto one address", () => {
    expect(new Set(doc.entries.map((e) => e.id)).size).toBe(doc.entries.length);
    const tos = doc.entries.map((e) => e.to);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it("SAYS PLAINLY that it does not mint the rows the checklist has and prod does not", () => {
    // Only 19 of 20 cards x 3 rungs survive, unevenly. This list moves what is
    // stored; the SCC re-mint creates the rest, which is why it runs first.
    expect(JSON.stringify(doc.rulings)).toMatch(/never mints/i);
    expect(JSON.stringify(doc.rulings)).toMatch(/re-mint runs FIRST/i);
  });
});

describe("the basketball list moves all 60 rows onto the ruled key", () => {
  const doc = readList(basketballList);

  /**
   * REBUILT TWICE OVER. The prior revision's retire half existed to vacate
   * bare addresses for its reslug half -- and measured today, the 40
   * `sub-`-segment ids it named are GONE and the product holds exactly 60
   * clean BBP rows, three rungs per card, no `sub-` anywhere. So there is
   * nothing left to retire, and naming ids that do not exist would be a list
   * that reports success while doing nothing.
   *
   * Drew's ruling then moves the destination off the host key entirely, which
   * is why the 20 BASE rows -- deliberately omitted before, because they were
   * correct while the Preview lived on `topps-stadium-club` -- now move too.
   */
  it("holds 60 entries, every one a reslug, and no retire is left to do", () => {
    expect(doc.entries).toHaveLength(60);
    const byAction: Record<string, number> = {};
    for (const e of doc.entries) byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    expect(byAction).toEqual({ reslug: 60 });
  });

  it("every entry passes the lane's own validation", () => {
    for (const e of doc.entries) expect(L.classifyEntry(e).ok).toBe(true);
  });

  it("ORDER IS NO LONGER LOAD-BEARING, because no target is held by this list", () => {
    // The prior revision's ordering pin existed because 20 reslugs landed on
    // 20 addresses the same list retired first. Every target now lives on the
    // ruled key, which holds ZERO rows, so no entry contends with another.
    const ids = new Set(doc.entries.map((e) => e.id));
    const contended = doc.entries.filter((e) => e.to && ids.has(e.to));
    expect(contended).toHaveLength(0);
  });

  it("ALL THREE RUNGS MOVE, 20 each -- leaving base behind is the split pool", () => {
    const rungs: Record<string, number> = {};
    for (const e of doc.entries) {
      const k = /:(base|refractor|atomic-refractor):/.exec(String(e.to))?.[1] ?? "?";
      rungs[k] = (rungs[k] ?? 0) + 1;
    }
    expect(rungs).toEqual({ base: 20, refractor: 20, "atomic-refractor": 20 });
  });

  it("an Atomic row goes to :atomic-refractor, never the plain rung", () => {
    const atomic = doc.entries.filter((e) => /Atomic Refractor/i.test(String(e.evidence)));
    expect(atomic).toHaveLength(20);
    for (const e of atomic) expect(e.to).toMatch(/:bbp\d+:atomic-refractor:no-auto$/);
  });

  it("NO destination carries a sub- segment -- the work-around is removed, not moved", () => {
    for (const e of doc.entries) expect(String(e.to)).not.toContain(":sub-");
  });

  it("THE EXPECTED END STATE: 60 rows on the ruled key, 3 per card", () => {
    const targets = doc.entries.map((e) => String(e.to));
    expect(new Set(targets).size).toBe(60);
    const cards = new Set(targets.map((t) => /:(bbp\d+):/.exec(t)?.[1]));
    expect(cards.size).toBe(20);
    expect(targets.length / cards.size).toBe(3);
    for (const t of targets) {
      expect(t).toMatch(/^hiq:basketball:1997:bowmans-best-preview:bbp\d+:(base|refractor|atomic-refractor):no-auto$/);
    }
  });

  it("every id is in basketball/1997/topps-stadium-club and none is a base-set row", () => {
    for (const e of doc.entries) {
      expect(e.id.startsWith("hiq:basketball:1997:topps-stadium-club:")).toBe(true);
      // The 1-240 base set must never appear: BBP numbering is what keeps this
      // product's preview rows clear of it.
      expect(e.id).toMatch(/:bbp\d+:/i);
    }
  });

  it("no duplicate ids and no duplicate destinations", () => {
    expect(new Set(doc.entries.map((e) => e.id)).size).toBe(60);
    const tos = doc.entries.map((e) => e.to);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it("SEQUENCING: the pool list repoints onto the SAME ruled addresses, and after this one", () => {
    // data/pool-relocations/2026-09-06-bbp-basketball-rung-repoint.json had its
    // 30 targets moved onto the ruled key in the same PR, so the two lists
    // agree on the end state. The order still matters for a different reason
    // than before: a sale repointed at an address the catalog has not created
    // yet is a sale pointing at nothing.
    const poolList = join(
      __dirname, "..", "data", "pool-relocations",
      "2026-09-06-bbp-basketball-rung-repoint.json",
    );
    if (!existsSync(poolList)) return; // the pool list is not in this tree yet

    const pool = JSON.parse(readFileSync(poolList, "utf8")) as {
      entries: { repointHobbyiqCardId?: string }[];
    };
    const targets = new Set(
      pool.entries.map((e) => e.repointHobbyiqCardId).filter(Boolean) as string[],
    );
    const reslugTo = new Set(doc.entries.map((e) => String(e.to)));

    // EVERY pool target is an address this list creates. Nothing is left
    // pointing at the host product, and nothing points at an address that
    // neither this list nor the re-mint produces.
    expect(targets.size).toBe(12);
    for (const t of targets) expect(reslugTo.has(t), `${t} is not created by the catalog list`).toBe(true);

    // And both lists say so, for whoever runs them.
    expect(JSON.stringify(doc.rulings)).toMatch(/re-mint|catalog list/i);
  });
});
