/**
 * PR #2495 review fix (2026-09-28): Series 2's already-ingested card_catalog
 * rows for the 2023 Topps Golden Mirror Image Variation SSP (cardNumbers
 * 331-660) live under the OLD, raw-scraped slug
 * `golden-mirror-variation-checklist`. The corrected checklist package this
 * PR also carries (acq-2026-09-28-cbc-beckett-topps-golden-mirror-image-
 * variation-2023) spells the parallel "Golden Mirror Variation" -- the
 * codebase's own canonical slug (variationVocabulary.ts). Re-ingesting the
 * corrected CSV without first reslugging the live rows would MINT 330 new
 * catalog rows at the canonical address and ORPHAN the 330 already standing
 * at the old one.
 *
 * Verified read-only against prod card_catalog and sold_comps on 2026-09-28
 * (point reads, id used as both item id and partition key per
 * cardCatalog.service.ts's cardId === id === slug): all 330 old-slug rows
 * exist live, all 330 new-slug destinations are vacant, and 0 sold_comps
 * rows exist at either slug for cardNumbers 331..660.
 *
 * `backend/data/catalog-relocations/2026-09-28-topps-2023-series2-golden-
 * mirror-reslug.json` is the relocate list this test pins: 330 `reslug`
 * entries, each carrying an explicit entry-level `parallel: "Golden Mirror
 * Variation"` human-form text per CF-A-RESLUG-THAT-CHANGES-THE-RUNG-CARRIES-
 * THE-RUNG'S-TEXT (#2431) -- relocate-catalog-rows-by-list.cjs's
 * rungChangeFields requires this whenever the destination's parallel segment
 * differs from the source's, and re-verifies computeHobbyIqCardId(row with
 * that text) === the entry's own "to" before trusting it.
 *
 * ORDER OF OPERATIONS (stated in the PR body, pinned by this test's own
 * assertions on the list's `rulings`): this list's APPLY must run BEFORE the
 * corrected checklist package is ever ingested. After APPLY, ingesting
 * 2023-topps-series2-baseball.csv is expected to report all 330 Golden
 * Mirror rows as already present (checklist-authority match on the
 * canonical id), never as 330 new writes.
 *
 * Modelled on relocateCatalogRowsByListRungText.test.ts's own "run the real
 * lane functions against the real entry shape" pattern -- this file is the
 * list-content pin; that file already pins rungChangeFields's general
 * behaviour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);

const LIST_PATH = join(
  __dirname,
  "..",
  "data",
  "catalog-relocations",
  "2026-09-28-topps-2023-series2-golden-mirror-reslug.json",
);

const { parseHobbyIqCardId, computeHobbyIqCardId } = require_(
  join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
) as {
  parseHobbyIqCardId: (id: string) => Record<string, unknown> | null;
  computeHobbyIqCardId: (c: Record<string, unknown>) => string;
};

const gradedIdLib = require_(join(__dirname, "..", "scripts", "lib", "graded-id.cjs")) as {
  parseSlugWithGrade: (
    slug: string,
    parseId: (id: string) => Record<string, unknown> | null,
  ) => { parsed: Record<string, unknown>; parentSlug: string; gradeTier: string | null } | null;
};
const parseSlugWithGrade = (slug: string) => gradedIdLib.parseSlugWithGrade(slug, parseHobbyIqCardId);

const LANE = require_(join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs")) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string };
  rungChangeFields: (
    id: string,
    to: string,
    entry: unknown,
    oldRow: unknown,
    parseId: typeof parseHobbyIqCardId,
    computeId: typeof computeHobbyIqCardId,
    parseGrade: typeof parseSlugWithGrade,
  ) => { ok: true; changedFields: Record<string, unknown> } | { ok: false; why: string };
};

type Entry = { id: string; action: string; to: string; parallel: string; reason: string };
type ListDoc = {
  forLane: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  census: { entries: number; oldSlugFoundLive: number; newSlugAlreadyOccupied: number; soldCompsAtOldSlug: number; soldCompsAtNewSlug: number };
  entries: Entry[];
};

const doc: ListDoc = JSON.parse(readFileSync(LIST_PATH, "utf8"));

describe("2026-09-28-topps-2023-series2-golden-mirror-reslug.json — shape and census", () => {
  it("is a lane-scope object (never a bare array), addressed to relocate-catalog-rows-by-list, not yet authorized to APPLY", () => {
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.reportOnlyUntil).toMatch(/review pending|no apply is authorized/i);
  });

  it("carries exactly 330 entries, matching the census and the live-verified population", () => {
    expect(doc.entries.length).toBe(330);
    expect(doc.census.entries).toBe(330);
    expect(doc.census.oldSlugFoundLive).toBe(330);
    expect(doc.census.newSlugAlreadyOccupied).toBe(0);
    expect(doc.census.soldCompsAtOldSlug).toBe(0);
    expect(doc.census.soldCompsAtNewSlug).toBe(0);
  });

  it("states the APPLY-before-ingest ordering explicitly in its rulings", () => {
    const rulings = doc.rulings.join(" ");
    expect(rulings).toMatch(/BEFORE the corrected checklist package/);
    expect(rulings).toMatch(/already present/);
  });

  it("every entry is action=reslug, carries the canonical parallel text, and moves cardNumbers 331..660 exactly once each", () => {
    const numbers = new Set<number>();
    for (const e of doc.entries) {
      expect(e.action).toBe("reslug");
      expect(e.parallel).toBe("Golden Mirror Variation");
      expect(e.id).toMatch(/^hiq:baseball:2023:topps:\d+:golden-mirror-variation-checklist:no-auto$/);
      expect(e.to).toMatch(/^hiq:baseball:2023:topps:\d+:golden-mirror-variation:no-auto$/);
      const idNum = Number(e.id.split(":")[4]);
      const toNum = Number(e.to.split(":")[4]);
      expect(toNum).toBe(idNum); // only the rung moves, never the card number
      numbers.add(idNum);
    }
    expect(numbers.size).toBe(330);
    expect(Math.min(...numbers)).toBe(331);
    expect(Math.max(...numbers)).toBe(660);
  });

  it("every entry passes the real lane's classifyEntry (well-formed hiq ids, reason present, to != id)", () => {
    for (const e of doc.entries) {
      const r = LANE.classifyEntry(e);
      expect(r.ok, `entry ${e.id}: ${r.why}`).toBe(true);
    }
  });

  it("every entry passes the real lane's rungChangeFields — the stated parallel text reproduces `to` exactly via computeHobbyIqCardId", () => {
    let checked = 0;
    for (const e of doc.entries) {
      const r = LANE.rungChangeFields(
        e.id,
        e.to,
        e,
        { sport: "baseball" },
        parseHobbyIqCardId,
        computeHobbyIqCardId,
        parseSlugWithGrade,
      );
      expect(r.ok, `entry ${e.id}: ${!r.ok ? r.why : ""}`).toBe(true);
      if (r.ok) {
        expect(r.changedFields.parallel).toBe("Golden Mirror Variation");
      }
      checked++;
    }
    expect(checked).toBe(330);
  });

  it("spot-checks the first and last card numbers against the checklist's own player mapping", () => {
    const first = doc.entries.find((e) => e.id.includes(":331:"));
    const last = doc.entries.find((e) => e.id.includes(":660:"));
    expect(first?.reason).toMatch(/Charlie Morton/);
    expect(last?.reason).toMatch(/Austin Riley/);
  });
});
