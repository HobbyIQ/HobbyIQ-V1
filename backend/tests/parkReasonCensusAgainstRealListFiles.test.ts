/**
 * R71 (owner ruling, 2026-09-19), refining R70 (#2330).
 *
 * DATA-DRIVEN PIN over the ACTUAL shipped list files, not a hand-written
 * fixture -- so a future edit to `PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL` (or
 * a future addition to the corpus) is checked against the real evidence
 * strings, not a sample of them. Uses relative paths only (this file lives
 * in `backend/tests/`, the corpus in `backend/data/pool-relocations/`).
 *
 * Loads every `backend/data/pool-relocations/2026-09-07-split-identity-
 * *.json` file (52 files at the time this was written), feeds each PARK
 * entry's `evidence` string through the wired predicate via the SAME
 * evaluator `parkReasonCarveoutSql.test.ts` uses, and asserts:
 *
 *   1. the admitted count equals the measured NEITHER-side-backed count
 *      (39,200 explicit + 7,996 Pokemon-phrasing = 47,196), and
 *   2. ZERO admitted rows carry "BOTH sides carry" or "the title states the
 *      vertical" evidence text.
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
  toCardId?: string;
  repointHobbyiqCardId?: string;
}
interface ListFile {
  entries?: ListEntry[];
}

function loadSportSegmentParkEvidence(): string[] {
  const files = fs.readdirSync(RELOCATIONS_DIR).filter((f) => /^2026-09-07-split-identity-.*\.json$/.test(f));
  const evidence: string[] = [];
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(RELOCATIONS_DIR, f), "utf8")) as ListFile;
    for (const e of doc.entries ?? []) {
      if (e.parkIdentityUnverified === true && typeof e.evidence === "string") evidence.push(e.evidence);
    }
  }
  return evidence;
}

describe("R71 census pin: PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL against the real 2026-09-07 split-identity lists", () => {
  it("finds the expected corpus size (52 files, 87,542 PARK entries) -- a missing/added file changes this number, which is the point", () => {
    const evidence = loadSportSegmentParkEvidence();
    const files = fs.readdirSync(RELOCATIONS_DIR).filter((f) => /^2026-09-07-split-identity-.*\.json$/.test(f));
    expect(files.length).toBe(52);
    expect(evidence.length).toBe(87542);
  });

  it("admits exactly the measured neither-backed count (39,200 + 7,996 = 47,196)", () => {
    const evidence = loadSportSegmentParkEvidence();
    const admitted = evidence.filter((ev) => evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, ev));
    expect(admitted.length).toBe(47196);
  });

  it("zero admitted rows carry BOTH-sides-backed or title-vertical-veto evidence text", () => {
    const evidence = loadSportSegmentParkEvidence();
    const admitted = evidence.filter((ev) => evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, ev));
    const wronglyAdmitted = admitted.filter(
      (ev) => ev.includes("BOTH sides carry") || ev.includes("the title states the vertical"),
    );
    expect(wronglyAdmitted).toEqual([]);
  });

  it("every admitted row's evidence carries a neither-backed marker (positive control, not just absence of the negative ones)", () => {
    const evidence = loadSportSegmentParkEvidence();
    const admitted = evidence.filter((ev) => evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, ev));
    for (const ev of admitted) {
      const hasNeitherMarker =
        ev.includes("(cardId=no-catalog-row, hobbyiqCardId=no-catalog-row)") || ev.includes(" has NO card_catalog row");
      expect(hasNeitherMarker).toBe(true);
    }
  });

  it("the excluded remainder (40,346) is exactly the both-backed + title-veto + product-veto-residual classes", () => {
    const evidence = loadSportSegmentParkEvidence();
    const excluded = evidence.filter((ev) => !evalReasonSql(PARK_REASON_ADMITS_HOBBYIQ_MATCH_SQL, ev));
    expect(excluded.length).toBe(40346);
    const bothSides = excluded.filter((ev) => ev.includes("BOTH sides carry")).length;
    const titleVeto = excluded.filter((ev) => ev.includes("the title states the vertical")).length;
    expect(bothSides).toBe(17662);
    expect(titleVeto).toBe(13257);
    // The residual class (9,427): one side IS checklist-backed (or
    // self-derived-only), the title corroborates a different product or
    // none, and it does not use the "states the vertical" phrasing.
    expect(excluded.length - bothSides - titleVeto).toBe(9427);
  });
});
