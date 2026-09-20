/**
 * R71 (owner ruling, 2026-09-19), refining R70 (#2330), OWNER RULING round 2.
 *
 * DATA-DRIVEN PIN over the ACTUAL shipped list files, not a hand-written
 * fixture -- so a future edit to `PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL` (or
 * a future addition to the corpus) is checked against the real evidence
 * strings, not a sample of them. Uses relative paths only (this file lives
 * in `backend/tests/`, the corpus in `backend/data/pool-relocations/`).
 *
 * Loads every `backend/data/pool-relocations/2026-09-07-split-identity-
 * *.json` file (52 files, 87,542 PARK entries at the time this was
 * written), classifies each PARK entry's `evidence` string into one of
 * SEVEN mutually-exclusive buckets, and asserts:
 *
 *   1. bucket sizes match the measured census exactly (54,671 / 1,059 /
 *      17,662 / 8,568 / 4,609 / 80 / 893 = 87,542, zero unrecognized), and
 *   2. running the REAL predicate (via the shared evaluator, threading each
 *      row's actual hobbyiqCardId derived from its `wouldBeCardId`) admits
 *      exactly 81,960 and excludes exactly 5,582, matching the bucket math
 *      (54,671+1,059+17,662+8,568 admit; 4,609+80+893 exclude).
 *
 * NOTE ON THE FIRST DRAFT OF THIS TEST: an earlier bucket table
 * under-counted "neither-backed" (used ONLY the literal
 * "(cardId=no-catalog-row, hobbyiqCardId=no-catalog-row)" parenthetical,
 * missing the `self-derived-only` / `unbacked` backing-state spellings the
 * classifier also emits) and missed the "the title names no product, so
 * nothing corroborates..." phrasing of the product-veto-residual class
 * entirely -- both found by this test itself failing "unrecognized = 0"
 * against the real corpus, which is exactly why that assertion exists.
 *
 * A RELOCATE/REPOINT entry (no `parkIdentityUnverified`) is skipped -- those
 * never carry `identityUnverified` in the first place, so a reader never
 * sees their evidence text under this field.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL } from "../src/services/compiq/identityUnionGuard.js";
import { evalReasonSql } from "./parkReasonCarveoutSql.test.js";

const RELOCATIONS_DIR = path.join(__dirname, "..", "data", "pool-relocations");

interface ListEntry {
  evidence?: string;
  parkIdentityUnverified?: boolean;
  fromCardId?: string;
  wouldBeCardId?: string;
}
interface ListFile {
  entries?: ListEntry[];
}

function loadSportSegmentParkEntries(): ListEntry[] {
  const files = fs.readdirSync(RELOCATIONS_DIR).filter((f) => /^2026-09-07-split-identity-.*\.json$/.test(f));
  const entries: ListEntry[] = [];
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(RELOCATIONS_DIR, f), "utf8")) as ListFile;
    for (const e of doc.entries ?? []) {
      if (e.parkIdentityUnverified === true && typeof e.evidence === "string") entries.push(e);
    }
  }
  return entries;
}

/** Mutually-exclusive classification, checked in this PRIORITY ORDER
 *  (malformed first -- a malformed-address row can also carry the
 *  neither-backed marker text, and malformed must win the classification;
 *  vert-veto next, since a vertical-veto row also carries a `(cardId=...,
 *  hobbyiqCardId=...)` parenthetical that would otherwise fall into
 *  neither-backed/product-veto). */
type Bucket =
  | "malformed"
  | "vert-veto-equals-neither"
  | "vert-veto-equals-cardid"
  | "vert-veto-equals-hiq"
  | "both-sides"
  | "product-veto-residual"
  | "neither-backed"
  | "UNRECOGNIZED";

function classify(e: ListEntry): Bucket {
  const ev = e.evidence ?? "";
  const sportOf = (s: string | undefined) => (s ?? "").split(":")[1] ?? "";
  if (!/^PARK\. /.test(ev)) return "UNRECOGNIZED";
  if (ev.includes("which is not a canonical vertical") || ev.includes("contains an empty slug segment") || ev.includes("has only"))
    return "malformed";
  const vertVeto = ev.match(/the title states the vertical "([^"]+)"/);
  if (vertVeto) {
    const stated = vertVeto[1];
    const hiqSport = sportOf(e.wouldBeCardId);
    const cardIdSport = sportOf(e.fromCardId);
    if (stated === hiqSport) return "vert-veto-equals-hiq";
    if (stated === cardIdSport) return "vert-veto-equals-cardid";
    return "vert-veto-equals-neither";
  }
  if (ev.includes("BOTH sides carry a checklist-backed catalog row")) return "both-sides";
  // "one side IS checklist-backed, but the title doesn't corroborate the
  // product it names (or names no product at all)" -- a PRODUCT-level
  // veto, never a vertical one, so the owner's rule admits it.
  if (ev.includes("checklist-backed side is the product") || ev.includes("the title names no product"))
    return "product-veto-residual";
  // Genuinely neither side checklist-backed. The closing parenthetical
  // spells "not checklist-backed" three ways (no-catalog-row /
  // self-derived-only / unbacked) -- tested structurally (neither captured
  // value equals the literal string "checklist-backed") rather than by
  // enumerating every combination, so a future fourth spelling is still
  // caught correctly.
  const neitherParen = ev.match(/\(cardId=([\w-]+), hobbyiqCardId=([\w-]+)\)/);
  if (neitherParen && neitherParen[1] !== "checklist-backed" && neitherParen[2] !== "checklist-backed") return "neither-backed";
  if (/Destination .* has NO card_catalog row/.test(ev)) return "neither-backed";
  return "UNRECOGNIZED";
}

describe("R71 census pin: PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL against the real 2026-09-07 split-identity lists", () => {
  it("finds the expected corpus size (52 files, 87,542 PARK entries) -- a missing/added file changes this number, which is the point", () => {
    const entries = loadSportSegmentParkEntries();
    const files = fs.readdirSync(RELOCATIONS_DIR).filter((f) => /^2026-09-07-split-identity-.*\.json$/.test(f));
    expect(files.length).toBe(52);
    expect(entries.length).toBe(87542);
  });

  it("every one of the 87,542 real evidence strings is RECOGNIZED (unrecognized = 0)", () => {
    const entries = loadSportSegmentParkEntries();
    const buckets = new Map<Bucket, number>();
    for (const e of entries) {
      const b = classify(e);
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    expect(buckets.get("UNRECOGNIZED") ?? 0).toBe(0);
    // The full bucket table, asserted exactly.
    expect(buckets.get("neither-backed")).toBe(54671);
    expect(buckets.get("product-veto-residual")).toBe(1059);
    expect(buckets.get("both-sides")).toBe(17662);
    expect(buckets.get("vert-veto-equals-hiq")).toBe(8568);
    expect(buckets.get("vert-veto-equals-cardid")).toBe(4609);
    expect(buckets.get("vert-veto-equals-neither")).toBe(80);
    expect(buckets.get("malformed")).toBe(893);
    const sum = [...buckets.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(87542);
  });

  it("the REAL predicate admits exactly 81,960 and excludes exactly 5,582, run against every row's actual hobbyiqCardId", () => {
    const entries = loadSportSegmentParkEntries();
    let admitted = 0, excluded = 0;
    for (const e of entries) {
      const ok = evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, e.evidence, e.wouldBeCardId);
      if (ok) admitted++; else excluded++;
    }
    expect(admitted).toBe(81960);
    expect(excluded).toBe(5582);
    expect(admitted + excluded).toBe(87542);
  });

  it("zero admitted rows are malformed or a cardId/neither-side vertical veto (the never-admit remainder)", () => {
    const entries = loadSportSegmentParkEntries();
    const wronglyAdmitted = entries.filter((e) => {
      const ok = evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, e.evidence, e.wouldBeCardId);
      if (!ok) return false;
      const b = classify(e);
      return b === "malformed" || b === "vert-veto-equals-cardid" || b === "vert-veto-equals-neither";
    });
    expect(wronglyAdmitted).toEqual([]);
  });

  it("every admitted vert-veto row's stated vertical genuinely equals hobbyiqCardId's own sport (positive control)", () => {
    const entries = loadSportSegmentParkEntries();
    const vertVetoAdmitted = entries.filter((e) => {
      const ok = evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, e.evidence, e.wouldBeCardId);
      return ok && classify(e) === "vert-veto-equals-hiq";
    });
    expect(vertVetoAdmitted.length).toBe(8568);
    for (const e of vertVetoAdmitted) {
      const m = (e.evidence ?? "").match(/the title states the vertical "([^"]+)"/);
      expect(m).not.toBeNull();
      const hiqSport = (e.wouldBeCardId ?? "").split(":")[1];
      expect(m?.[1]).toBe(hiqSport);
    }
  });
});
