/**
 * R71 (owner ruling, 2026-09-19), refining R70 (#2330).
 *
 * BLOCKING REVIEW FINDING (2026-09-19), fixed here: an earlier version of
 * `identityUnionGuard.ts` shipped a WIRED predicate
 * (`PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL`) that matched on the SHARED prefix
 * `"PARK. cardId vertical"` every sport-segment PARK entry opens with —
 * including the "BOTH sides carry a checklist-backed catalog row" class
 * (17,662 rows) and the title-veto classes (13,257 + 9,427 = 22,684 rows).
 * ~40,346 rows (46% of the tranche) would have been wrongly re-admitted. A
 * second, CORRECT fragment (`PARK_REASON_STRUCTURAL_CARVEOUT_SQL`) existed
 * but was never wired into any reader — dead code that made the bug harder
 * to see in review.
 *
 * This file now pins the SINGLE corrected predicate
 * (`PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL`, the only export — the dead
 * fragment is deleted) against every distinct evidence pattern found in a
 * full census of `backend/data/pool-relocations/2026-09-07-split-identity-
 * *.json` (52 files, 87,542 PARK entries):
 *
 *   count   pattern                                                admit?
 *   39,200  "...(cardId=no-catalog-row, hobbyiqCardId=no-catalog-    YES
 *           row)" -- literal neither-side-has-a-row parenthetical.
 *    7,996  "Destination <slug> has NO card_catalog row" -- the        YES
 *           Pokemon-phrasing variant of the SAME neither-backed class.
 *   17,662  "BOTH sides carry a checklist-backed catalog row"          NO
 *   13,257  "the title states the vertical ... but the only            NO
 *           checklist-backed side is ..."
 *    9,427  "...the checklist-backed side is the product ..." (one     NO
 *           side IS checklist-backed, title corroborates a different
 *           product or none)
 *   -------
 *   87,542  total
 *
 * Both TESTS in this file (the small in-process evaluator below, AND
 * `parkReasonCensusAgainstRealListFiles.test.ts`'s data-driven pin over the
 * actual JSON) must independently confirm 47,196 rows admit and 40,346 stay
 * excluded on the real corpus.
 */
import { describe, it, expect } from "vitest";
import { PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL } from "../src/services/compiq/identityUnionGuard.js";

/** A tiny in-process evaluator for the small SQL subset this fragment uses
 *  (STARTSWITH / CONTAINS / =, ANDed and ORed with one level of grouping),
 *  so the fragment can be exercised against fixture reasons without a real
 *  Cosmos engine. This is a MUTATION GUARD, not a SQL parser: it recognizes
 *  exactly the shapes `PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL` is built from,
 *  and throws on anything else so a future edit that adds an unrecognized
 *  clause shape fails the test loudly rather than silently mis-evaluating. */
export function evalReasonSql(sql: string, reason: string | undefined): boolean {
  const value = () => reason;

  function evalClause(clause: string): boolean {
    clause = clause.trim();
    if (clause.startsWith("(") && clause.endsWith(")")) {
      const inner = clause.slice(1, -1);
      if (topLevelHas(inner, " OR ")) return splitTopLevel(inner, " OR ").some((c) => evalClause(c));
      if (topLevelHas(inner, " AND ")) return splitTopLevel(inner, " AND ").every((c) => evalClause(c));
      return evalClause(inner);
    }
    if (clause.startsWith("NOT ")) return !evalClause(clause.slice(4));
    if (clause.startsWith("STARTSWITH(c.identityUnverifiedReason, '")) {
      const needle = clause.slice(clause.indexOf("'") + 1, clause.lastIndexOf("'"));
      return (value() ?? "").startsWith(needle);
    }
    if (clause.startsWith("CONTAINS(c.identityUnverifiedReason, '")) {
      const needle = clause.slice(clause.indexOf("'") + 1, clause.lastIndexOf("'"));
      return (value() ?? "").includes(needle);
    }
    if (clause === "c.identityUnverifiedReason = 'split-identity'") return value() === "split-identity";
    throw new Error(`evalReasonSql: unrecognized clause: ${clause}`);
  }

  function topLevelHas(s: string, sep: string): boolean {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      else if (depth === 0 && s.slice(i, i + sep.length) === sep) return true;
    }
    return false;
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

  return splitTopLevel(sql, " AND ").every((c) => evalClause(c));
}

const REASON = {
  neitherExplicit:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
    + "so RELOCATE would mint an identity from a sale. identityUnverified keeps the row out of EVERY pool "
    + "without asserting which card it belongs to.",
  neitherPokemon:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"pokemon\"; all other slug segments identical; "
    + "setKey \"pokemon-swsh\" is an unambiguous Pokemon TCG set. Destination "
    + "hiq:pokemon:2020:pokemon-swsh:swsh061:holo:no-auto has NO card_catalog row (read-only 2026-09-07), "
    + "so RELOCATE would mint an identity from a sale.",
  bothSidesBacked:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
    + "BOTH sides carry a checklist-backed catalog row (checklist-backed / checklist-backed), "
    + "so the catalog cannot say which card this sale is.",
  titleVertivalVeto:
    "PARK. cardId vertical \"non-sport\" vs hobbyiqCardId \"baseball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
    + "\"non-sport\" but the only checklist-backed side is \"baseball\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed). "
    + "identityUnverified keeps the row out of EVERY pool without asserting which card it belongs to.",
  oneSideBackedProductVeto:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"football\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title names the product "
    + "\"panini-optic\" but the checklist-backed side is the product \"bowman\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed). "
    + "identityUnverified keeps the row out of EVERY pool without asserting which card it belongs to.",
  duplicatePartitionCopy: "duplicate-partition-copy: PARK-NEITHER-QUALIFIES",
  malformedKeyEnum: "malformed-key",
  sportUnresolvedEnum: "sport-unresolved",
  insertNamedNoKeyEnum: "insert-named-no-key",
  twoInsertsNamedEnum: "two-inserts-named",
  insertNamedUnconfirmedEnum: "insert-named-unconfirmed",
  splitIdentityEnum: "split-identity",
} as const;

describe("PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL -- every census pattern class", () => {
  it("admits the two neither-backed shapes (the VW3 class)", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.neitherExplicit)).toBe(true);
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.neitherPokemon)).toBe(true);
  });

  it("admits the live write-guard's short-enum split-identity reason", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.splitIdentityEnum)).toBe(true);
  });

  it("REGRESSION GUARD: refuses BOTH-sides-backed, even though it shares the 'PARK. cardId vertical' prefix", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.bothSidesBacked)).toBe(false);
  });

  it("REGRESSION GUARD: refuses the explicit title-vertical veto", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.titleVertivalVeto)).toBe(false);
  });

  it("REGRESSION GUARD: refuses the one-side-backed title-product-veto residual phrasing", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.oneSideBackedProductVeto)).toBe(false);
  });

  it("refuses duplicate-partition-copy", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.duplicatePartitionCopy)).toBe(false);
  });

  it("refuses malformed-key / sport-unresolved / insert-named-* enum reasons", () => {
    for (const r of [
      REASON.malformedKeyEnum, REASON.sportUnresolvedEnum, REASON.insertNamedNoKeyEnum,
      REASON.twoInsertsNamedEnum, REASON.insertNamedUnconfirmedEnum,
    ]) {
      expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, r)).toBe(false);
    }
  });

  it("fails CLOSED on an absent or unrecognized reason", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, undefined)).toBe(false);
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, "some-future-reason-nobody-has-seen-yet")).toBe(false);
    // Even a "PARK. cardId vertical" opener with NEITHER of the two
    // recognized neither-backed markers must default to excluded -- the
    // predicate is an allow-list, not a deny-list.
    expect(evalReasonSql(
      PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL,
      "PARK. cardId vertical \"x\" vs hobbyiqCardId \"y\"; some entirely new phrasing nobody has written yet.",
    )).toBe(false);
  });
});
