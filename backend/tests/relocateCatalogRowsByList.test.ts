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

describe("the baseball list retires exactly the 60 preview rows", () => {
  const doc = readList(baseballList);

  it("names this lane and holds 60 entries, every one a retire", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(60);
    expect(doc.entries.every((e) => e.action === "retire")).toBe(true);
    expect(doc.entries.every((e) => e.to === undefined)).toBe(true);
  });

  it("every entry passes the lane's own validation", () => {
    for (const e of doc.entries) expect(L.classifyEntry(e).ok).toBe(true);
  });

  it("every id is in baseball/1997/bowmans-best, and none is a proper Bowman's Best row", () => {
    for (const e of doc.entries) {
      expect(e.id.startsWith("hiq:baseball:1997:bowmans-best:")).toBe(true);
    }
    // The measured split: 42 bare addresses, 18 carrying a :sub-preview segment.
    const sub = doc.entries.filter((e) => e.id.includes(":sub-preview:"));
    expect(sub).toHaveLength(18);
    expect(doc.entries.length - sub.length).toBe(42);
  });

  it("NOT the 232 legitimate rows — the separating field is the subset, never the source", () => {
    // Every entry's evidence names the Preview set. A row of the proper
    // checklist ("1997 Bowman\\s Best ... Baseball") must never appear.
    for (const e of doc.entries) {
      expect(String(e.evidence)).toMatch(/Bowmans Best Preview/i);
    }
    const properShaped = doc.entries.filter((e) => /Bowman\\s Best (Atomic )?Refractors/.test(String(e.evidence)));
    expect(properShaped).toHaveLength(0);
  });

  it("no duplicate ids", () => {
    expect(new Set(doc.entries.map((e) => e.id)).size).toBe(60);
  });

  it("records the ruling that it is report-only until the setKey is decided", () => {
    expect(JSON.stringify(doc.rulings)).toMatch(/bowmans-best-preview|pending|ruled key/i);
  });
});

describe("the basketball list retires 20 aliases and reslugs 40, in that order", () => {
  const doc = readList(basketballList);

  it("holds 60 entries: 20 retire, 40 reslug (the 20 base rows are omitted)", () => {
    expect(doc.entries).toHaveLength(60);
    const byAction: Record<string, number> = {};
    for (const e of doc.entries) byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    expect(byAction).toEqual({ retire: 20, reslug: 40 });
  });

  it("every entry passes the lane's own validation", () => {
    for (const e of doc.entries) expect(L.classifyEntry(e).ok).toBe(true);
  });

  it("ORDER IS LOAD-BEARING: every alias is retired BEFORE the row that reslugs onto it", () => {
    const order = doc.entries.map((e) => e.id);
    const ids = new Set(order);
    const contended = doc.entries.filter((e) => e.to && ids.has(e.to));
    // 20 Preview refractor rows land on the 20 vacated bare addresses.
    expect(contended).toHaveLength(20);
    for (const e of contended) {
      expect(order.indexOf(e.to as string)).toBeLessThan(order.indexOf(e.id));
    }
  });

  it("the 20 Atomic rows go to :atomic-refractor, never the plain rung", () => {
    const atomic = doc.entries.filter((e) => e.id.includes("sub-bowmans-best-preview-atomic"));
    expect(atomic).toHaveLength(20);
    for (const e of atomic) {
      expect(e.to).toMatch(/:bbp\d+:atomic-refractor:no-auto$/);
      expect(e.to).not.toMatch(/:refractor:no-auto$/);
    }
  });

  it("the 20 Preview refractor rows go to the bare :refractor address", () => {
    const plain = doc.entries.filter(
      (e) => e.action === "reslug" && !e.id.includes("preview-atomic"),
    );
    expect(plain).toHaveLength(20);
    for (const e of plain) expect(e.to).toMatch(/:bbp\d+:refractor:no-auto$/);
  });

  it("NO destination carries a sub- segment — the work-around is being removed, not moved", () => {
    for (const e of doc.entries) {
      if (e.to) expect(e.to).not.toContain(":sub-");
    }
  });

  it("THE EXPECTED END STATE: 60 rows, 3 per card, no sub- segment", () => {
    // 20 base (omitted, already correct) + 20 refractor + 20 atomic-refractor.
    const targets = doc.entries.filter((e) => e.to).map((e) => e.to as string);
    expect(new Set(targets).size).toBe(40);
    const cards = new Set(targets.map((t) => /:(bbp\d+):/.exec(t)?.[1]));
    expect(cards.size).toBe(20);
    // Each card gets exactly two reslugged rungs; its base row is left alone.
    expect(targets.length / cards.size).toBe(2);
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
    const tos = doc.entries.filter((e) => e.to).map((e) => e.to);
    expect(new Set(tos).size).toBe(tos.length);
  });

  it("SEQUENCING: the pool lane's list repoints onto addresses this list retires first", () => {
    // data/pool-relocations/2026-09-06-bbp-basketball-rung-repoint.json landed
    // on main the same day and repoints 30 sold_comps rows onto 12 targets in
    // this product. The two lists agree on the END STATE and disagree on the
    // ORDER: six of those targets are bare refractor addresses this list
    // retires before reslugging the Preview row onto them. Repointing sales
    // onto an address that is then deleted and recreated leaves them on a row
    // that existed under a different document, so the CATALOG list runs first.
    //
    // This pin exists so that a later edit to either list cannot quietly widen
    // the overlap without someone reading the ordering note.
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
    const retires = new Set(doc.entries.filter((e) => e.action === "retire").map((e) => e.id));
    const reslugTo = new Set(doc.entries.filter((e) => e.action === "reslug").map((e) => e.to));

    const retiredFirst = [...targets].filter((t) => retires.has(t));
    const landedOn = [...targets].filter((t) => reslugTo.has(t));

    // The measured overlap on 2026-09-06.
    expect(retiredFirst).toHaveLength(6);
    expect(landedOn).toHaveLength(8);
    // Every contended target ends up as a live address of this product, so the
    // end states genuinely agree — the only question is order.
    for (const t of retiredFirst) expect(reslugTo.has(t)).toBe(true);

    // And the list says so in its own rulings, for whoever runs it.
    expect(JSON.stringify(doc.rulings)).toMatch(/catalog list BEFORE pool list|SEQUENCING WITH THE POOL LANE/i);
  });
});
