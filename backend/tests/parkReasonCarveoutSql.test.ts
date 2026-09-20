/**
 * R71 (owner ruling, 2026-09-19), refining R70 (#2330).
 *
 * Pins the two SQL fragments identityUnionGuard.ts exports for un-parking a
 * NARROW slice of the `identityUnverified` PARK class — see that file's own
 * header comment for the measured population this was checked against
 * (87,542 sport-segment PARK rows, the 2026-09-07 `relocate-pool-rows-by-list`
 * tranche; e.g. every Wembanyama `…:topps:vw3:…` sale).
 *
 * Both fragments must, on every mutation that removes a never-admit prefix,
 * fail to refuse the class that prefix names — that is what these tests
 * assert directly, rather than trusting the string is correct by inspection.
 */
import { describe, it, expect } from "vitest";
import {
  PARK_REASON_STRUCTURAL_CARVEOUT_SQL,
  PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL,
} from "../src/services/compiq/identityUnionGuard.js";

/** A tiny in-process evaluator for the small SQL subset these fragments use
 *  (STARTSWITH / CONTAINS / IS_DEFINED / =, ANDed and ORed), so the fragment
 *  can be exercised against fixture rows without a real Cosmos engine. This
 *  is a MUTATION GUARD, not a SQL parser: it recognizes exactly the shapes
 *  the two exports above are built from. */
function evalReasonSql(sql: string, reason: string | undefined): boolean {
  const row = { identityUnverifiedReason: reason };
  const isDefined = (field: string) => field in row && (row as Record<string, unknown>)[field] !== undefined;
  const get = () => row.identityUnverifiedReason;

  // Split top-level ANDs (this module never nests parens across an OR/AND
  // boundary in a way that would break a naive split, since it only ANDs a
  // parenthesized OR-group with a flat sequence of NOT STARTSWITH clauses).
  function evalClause(clause: string): boolean {
    clause = clause.trim();
    if (clause.startsWith("(") && clause.endsWith(")")) {
      // Could be an OR-group or just a parenthesized single clause.
      const inner = clause.slice(1, -1);
      if (inner.includes(" OR ") && !inner.includes(" AND ")) {
        return inner.split(" OR ").some((c) => evalClause(c));
      }
      return evalAnd(inner);
    }
    if (clause.startsWith("NOT STARTSWITH(c.identityUnverifiedReason, '") ) {
      const needle = clause.slice(clause.indexOf("'") + 1, clause.lastIndexOf("'"));
      return !(get() ?? "").startsWith(needle);
    }
    if (clause.startsWith("STARTSWITH(c.identityUnverifiedReason, '")) {
      const needle = clause.slice(clause.indexOf("'") + 1, clause.lastIndexOf("'"));
      return (get() ?? "").startsWith(needle);
    }
    if (clause.startsWith("NOT CONTAINS(c.identityUnverifiedReason, '")) {
      const needle = clause.slice(clause.indexOf("'") + 1, clause.lastIndexOf("'"));
      return !(get() ?? "").includes(needle);
    }
    if (clause.startsWith("CONTAINS(c.identityUnverifiedReason, '")) {
      const needle = clause.slice(clause.indexOf("'") + 1, clause.lastIndexOf("'"));
      return (get() ?? "").includes(needle);
    }
    if (clause === "IS_DEFINED(c.identityUnverifiedReason)") return isDefined("identityUnverifiedReason") && get() !== undefined;
    if (clause === "c.identityUnverifiedReason = 'split-identity'") return get() === "split-identity";
    throw new Error(`evalReasonSql: unrecognized clause: ${clause}`);
  }

  function splitTopLevel(s: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      else if (depth === 0 && s.slice(i, i + sep.length) === sep) {
        parts.push(s.slice(start, i));
        i += sep.length - 1;
        start = i + 1;
      }
    }
    parts.push(s.slice(start));
    return parts;
  }

  function evalAnd(s: string): boolean {
    return splitTopLevel(s, " AND ").every((c) => evalClause(c));
  }

  return evalAnd(sql);
}

describe("PARK_REASON_STRUCTURAL_CARVEOUT_SQL", () => {
  it("admits a reason that affirmatively names hobbyiqCardId as checklist-backed with no cardId backing and no title veto", () => {
    const reason =
      "PARK. cardId vertical \"non-sport\" vs hobbyiqCardId \"baseball\"; segments differing: sport. "
      + "NEITHER side carries a checklist-backed catalog row this sale agrees with: some other veto text "
      + "(cardId=no-catalog-row, hobbyiqCardId=checklist-backed). identityUnverified keeps the row out of EVERY pool.";
    expect(evalReasonSql(PARK_REASON_STRUCTURAL_CARVEOUT_SQL, reason)).toBe(true);
  });

  it("refuses when the title states the vertical (explicit veto) even with hobbyiqCardId backed", () => {
    const reason =
      "PARK. cardId vertical \"non-sport\" vs hobbyiqCardId \"baseball\"; segments differing: sport. "
      + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
      + "\"non-sport\" but the only checklist-backed side is \"baseball\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed).";
    expect(evalReasonSql(PARK_REASON_STRUCTURAL_CARVEOUT_SQL, reason)).toBe(false);
  });

  it("refuses when BOTH sides are checklist-backed", () => {
    const reason = "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
      + "BOTH sides carry a checklist-backed catalog row (checklist-backed / checklist-backed), so the catalog cannot say which card this sale is.";
    expect(evalReasonSql(PARK_REASON_STRUCTURAL_CARVEOUT_SQL, reason)).toBe(false);
  });

  it("refuses the VW3 neither-backed shape (no catalog row on either side)", () => {
    const reason = "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
      + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
      + "so RELOCATE would mint an identity from a sale.";
    expect(evalReasonSql(PARK_REASON_STRUCTURAL_CARVEOUT_SQL, reason)).toBe(false);
  });

  it("refuses duplicate-partition-copy even if it happened to mention hobbyiqCardId=checklist-backed", () => {
    const reason = "duplicate-partition-copy: hobbyiqCardId=checklist-backed but neither copy is coherent";
    expect(evalReasonSql(PARK_REASON_STRUCTURAL_CARVEOUT_SQL, reason)).toBe(false);
  });

  it("refuses malformed-key / insert-named-* / sport-unresolved outright", () => {
    for (const reason of ["malformed-key", "insert-named-no-key", "two-inserts-named", "insert-named-unconfirmed", "sport-unresolved"]) {
      expect(evalReasonSql(PARK_REASON_STRUCTURAL_CARVEOUT_SQL, reason)).toBe(false);
    }
  });

  it("refuses when identityUnverifiedReason is absent", () => {
    expect(evalReasonSql(PARK_REASON_STRUCTURAL_CARVEOUT_SQL, undefined)).toBe(false);
  });
});

describe("PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL (wholesale carve-out for hobbyiqCardId-only readers)", () => {
  it("admits the live write-guard's short-enum split-identity reason", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, "split-identity")).toBe(true);
  });

  it("admits the 2026-09-07 list lane's free-text VW3-shaped evidence sentence", () => {
    const reason = "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
      + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
      + "so RELOCATE would mint an identity from a sale. identityUnverified keeps the row out of EVERY pool "
      + "without asserting which card it belongs to.";
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, reason)).toBe(true);
  });

  it("still refuses duplicate-partition-copy", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, "duplicate-partition-copy: PARK-NEITHER-QUALIFIES")).toBe(false);
  });

  it("still refuses malformed-key / insert-named-* / sport-unresolved", () => {
    for (const reason of ["malformed-key", "insert-named-no-key", "two-inserts-named", "insert-named-unconfirmed", "sport-unresolved"]) {
      expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, reason)).toBe(false);
    }
  });

  it("refuses an unrecognized/absent reason (fail closed)", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, undefined)).toBe(false);
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, "some-unrelated-reason")).toBe(false);
  });
});
