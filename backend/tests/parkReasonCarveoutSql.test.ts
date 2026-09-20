/**
 * R71 (owner ruling, 2026-09-19), refining R70 (#2330).
 *
 * REVIEW ROUND 2 (OWNER RULING): a live production-shape check of round 1's
 * PR found two more incident pools (2023 Topps #472 and #271 basketball)
 * that did not recover, because their park reasons sit in the both-sides-
 * backed / title-veto classes round 1 excluded -- yet their titles plainly
 * say Wembanyama/Spurs and hobbyiqCardId (basketball) IS the right pricing
 * id. The owner's actual rule: keep a split-identity sale priced when
 * matched BY ITS PRICING ID; keep it out of the wrong-sport pool; keep
 * duplicate copies excluded. The ONE exception: exclude a title-veto row
 * only when the title's STATED VERTICAL is NOT hobbyiqCardId's own sport
 * (the title itself says the pricing id is wrong).
 *
 * This file pins the CORRECTED predicate against every distinct evidence
 * pattern found in the full census of `backend/data/pool-relocations/2026-
 * 09-07-split-identity-*.json` (52 files, 87,542 PARK entries; mutually
 * exclusive buckets):
 *
 *   count   pattern                                                admit?
 *   46,814  NEITHER side carries a checklist-backed catalog row      YES
 *    8,916  ONE side checklist-backed, title vetoes on PRODUCT        YES
 *           (not vertical)
 *   17,662  BOTH sides carry a checklist-backed catalog row          YES
 *    8,568  title states a vertical that EQUALS hobbyiqCardId's       YES
 *           own sport
 *    4,609  title states a vertical that equals cardId's sport        NO
 *           (the wrong side -- the owner's one exception)
 *       80  title states a vertical that equals NEITHER side          NO
 *      893  malformed / key-defect address                           NO
 *   -------
 *   87,542  total; 81,960 admit (94%), 5,582 exclude (6%)
 *
 * Both TESTS in this file (the small in-process evaluator below, AND
 * `parkReasonCensusAgainstRealListFiles.test.ts`'s data-driven pin over the
 * actual JSON) must independently confirm these seven counts on the real
 * corpus.
 */
import { describe, it, expect } from "vitest";
import { PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL } from "../src/services/compiq/identityUnionGuard.js";

/** A tiny in-process evaluator for the small SQL subset this fragment uses
 *  (STARTSWITH / CONTAINS / =, ANDed and ORed with grouping), so the
 *  fragment can be exercised against fixture reasons without a real Cosmos
 *  engine. This is a MUTATION GUARD, not a SQL parser: it recognizes
 *  exactly the shapes `PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL` is built from,
 *  and throws on anything else so a future edit that adds an unrecognized
 *  clause shape fails the test loudly rather than silently mis-evaluating.
 *
 *  `hobbyiqCardId` is threaded alongside `reason` because the corrected
 *  predicate's title-confirms-vertical branch reads `c.hobbyiqCardId`, not
 *  just `c.identityUnverifiedReason`. */
export function evalReasonSql(
  sql: string,
  reason: string | undefined,
  hobbyiqCardId?: string,
): boolean {
  const row = { identityUnverifiedReason: reason, hobbyiqCardId: hobbyiqCardId ?? null };

  function fieldOf(token: string): string | null {
    if (token === "c.identityUnverifiedReason") return row.identityUnverifiedReason ?? null;
    if (token === "c.hobbyiqCardId") return row.hobbyiqCardId;
    throw new Error(`evalReasonSql: unrecognized field: ${token}`);
  }

  function evalClause(clause: string): boolean {
    clause = clause.trim();
    if (clause.startsWith("(") && clause.endsWith(")")) {
      let depth = 0, wrapsAll = true;
      for (let i = 0; i < clause.length; i++) {
        if (clause[i] === "(") depth++;
        else if (clause[i] === ")") { depth--; if (depth === 0 && i !== clause.length - 1) { wrapsAll = false; break; } }
      }
      if (wrapsAll) return evalClause(clause.slice(1, -1));
    }
    if (topLevelHas(clause, " OR ")) return splitTopLevel(clause, " OR ").some((c) => evalClause(c));
    if (topLevelHas(clause, " AND ")) return splitTopLevel(clause, " AND ").every((c) => evalClause(c));
    if (clause.startsWith("NOT ")) return !evalClause(clause.slice(4));
    const starts = clause.match(/^STARTSWITH\((c\.\w+), '((?:[^'\\]|\\.)*)'\)$/);
    if (starts) return (fieldOf(starts[1]) ?? "").startsWith(starts[2]);
    const contains = clause.match(/^CONTAINS\((c\.\w+), '((?:[^'\\]|\\.)*)'\)$/);
    if (contains) return (fieldOf(contains[1]) ?? "").includes(contains[2]);
    const eq = clause.match(/^(c\.\w+) = '((?:[^'\\]|\\.)*)'$/);
    if (eq) return fieldOf(eq[1]) === eq[2];
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

const HIQ_BASKETBALL = "hiq:basketball:2023:topps:vw3:base:no-auto";
const HIQ_BASEBALL = "hiq:baseball:2023:topps:sho-5:base:no-auto";

const REASON = {
  neitherExplicit:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row), "
    + "so RELOCATE would mint an identity from a sale.",
  neitherPokemon:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"pokemon\"; setKey \"pokemon-swsh\" is an unambiguous "
    + "Pokemon TCG set. Destination hiq:pokemon:2020:pokemon-swsh:swsh061:holo:no-auto has NO card_catalog row "
    + "(read-only 2026-09-07), so RELOCATE would mint an identity from a sale.",
  bothSidesBacked:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
    + "BOTH sides carry a checklist-backed catalog row (checklist-backed / checklist-backed), "
    + "so the catalog cannot say which card this sale is.",
  productVetoResidual:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title names the product "
    + "\"panini-optic\" but the checklist-backed side is the product \"prizm\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed).",
  vertVetoStatedEqualsHiq:
    "PARK. cardId vertical \"baseball\" vs hobbyiqCardId \"basketball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
    + "\"basketball\" but the only checklist-backed side is \"baseball\" (cardId=checklist-backed, hobbyiqCardId=no-catalog-row).",
  vertVetoStatedEqualsCardId:
    "PARK. cardId vertical \"non-sport\" vs hobbyiqCardId \"baseball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
    + "\"non-sport\" but the only checklist-backed side is \"baseball\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed).",
  vertVetoStatedEqualsNeither:
    "PARK. cardId vertical \"hockey\" vs hobbyiqCardId \"baseball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the title states the vertical "
    + "\"soccer\" but the only checklist-backed side is \"baseball\" (cardId=no-catalog-row, hobbyiqCardId=checklist-backed).",
  malformedNonCanonicalVertical:
    "PARK. cardId vertical \"sight\" vs hobbyiqCardId \"baseball\"; segments differing: sport,cardYear,setKey,cardNumber,parallel,auto. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the cardId address names \"sight\", "
    + "which is not a canonical vertical (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row).",
  malformedEmptySegment:
    "PARK. cardId vertical \"hedge\" vs hobbyiqCardId \"baseball\"; segments differing: sport. "
    + "NEITHER side carries a checklist-backed catalog row this sale agrees with: the cardId address contains an "
    + "empty slug segment (a vendor key wearing an hiq: prefix) (cardId=no-catalog-row, hobbyiqCardId=no-catalog-row).",
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
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.neitherExplicit, HIQ_BASKETBALL)).toBe(true);
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.neitherPokemon, HIQ_BASKETBALL)).toBe(true);
  });

  it("admits the live write-guard's short-enum split-identity reason", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.splitIdentityEnum, HIQ_BASKETBALL)).toBe(true);
  });

  it("OWNER RULING: admits BOTH-sides-backed (the 2023 Topps #472/#271 incident shape)", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.bothSidesBacked, HIQ_BASKETBALL)).toBe(true);
  });

  it("OWNER RULING: admits the product-only veto residual (not a vertical contradiction)", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.productVetoResidual, HIQ_BASKETBALL)).toBe(true);
  });

  it("OWNER RULING: admits a title-vertical-veto row when the stated vertical EQUALS hobbyiqCardId's own sport", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.vertVetoStatedEqualsHiq, HIQ_BASKETBALL)).toBe(true);
  });

  it("THE ONE EXCEPTION: excludes a title-vertical-veto row when the stated vertical equals cardId's (wrong) sport", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.vertVetoStatedEqualsCardId, HIQ_BASEBALL)).toBe(false);
  });

  it("excludes a title-vertical-veto row when the stated vertical matches neither side", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.vertVetoStatedEqualsNeither, HIQ_BASEBALL)).toBe(false);
  });

  it("excludes malformed/key-defect addresses even when they carry a neither-backed marker", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.malformedNonCanonicalVertical, HIQ_BASEBALL)).toBe(false);
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.malformedEmptySegment, HIQ_BASEBALL)).toBe(false);
  });

  it("refuses duplicate-partition-copy", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, REASON.duplicatePartitionCopy, HIQ_BASKETBALL)).toBe(false);
  });

  it("refuses malformed-key / sport-unresolved / insert-named-* enum reasons", () => {
    for (const r of [
      REASON.malformedKeyEnum, REASON.sportUnresolvedEnum, REASON.insertNamedNoKeyEnum,
      REASON.twoInsertsNamedEnum, REASON.insertNamedUnconfirmedEnum,
    ]) {
      expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, r, HIQ_BASKETBALL)).toBe(false);
    }
  });

  it("fails CLOSED on an absent or unrecognized reason", () => {
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, undefined, HIQ_BASKETBALL)).toBe(false);
    expect(evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, "some-future-reason-nobody-has-seen-yet", HIQ_BASKETBALL)).toBe(false);
  });
});
