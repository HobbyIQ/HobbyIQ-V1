import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * 2026-09-25 -- 2025 Bowman's Best B25- rows folded off setKey=bowman.
 *
 * Measured read-only 2026-09-25: 297 card_catalog rows carry sport=baseball,
 * year=2025, setKey=bowman, and a B25--prefixed cardNumber (case-insensitive).
 * All 297 come from catalog-explode-actuals-2026-08-12 (sales-exploded, never
 * checklist), not from any baseballcardpedia-ladders source. B25- is the
 * cardNumber prefix of 2025 Bowman's Best's "Best of 2025 Autographs" insert --
 * never the Quad Autographs insert and never plain 2025 Bowman -- and the SAME
 * 131 distinct B25- cardNumbers already live checklist-grade under
 * setKey=bowmans-best (521 of those rows are "Printing Plates" parallels,
 * sourced checklistcenter-2026-08-29 / baseballcardpedia-ladders-2026-08-29),
 * so this list folds the sales-exploded rows onto the product that already has
 * a checklist there.
 *
 * All 297 destinations point-read ABSENT -- including a handful of
 * :psa-N graded-child destinations, whose grade suffix is carried through
 * verbatim by segment-replacing setKey alone (never re-derived through
 * computeHobbyIqCardId, which does not model a grade segment) -- so this
 * list excludes nothing.
 *
 * These pins run the lane's OWN validator (classifyEntry), so a list this
 * suite accepts is a list the lane can read.
 */

const DIR = path.join(process.cwd(), "data", "catalog-relocations");
const FILE = "2026-09-25-b25-bowman-to-bowmans-best.json";

type Entry = {
  id: string;
  action: string;
  to?: string;
  reason?: string;
  evidence?: string;
  fromCardId?: string;
  toCardId?: string;
  fromSetKey?: string;
  toSetKey?: string;
  cardNumber?: string;
  parallel?: string;
  source?: string;
};
type List = {
  generatedAt: string;
  forLane: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  census: Record<string, unknown>;
  excluded: Array<{ id: string; excludeReason: string }>;
  entries: Entry[];
};

const doc = JSON.parse(readFileSync(path.join(DIR, FILE), "utf8")) as List;

// The lane's own validator, so these pins cannot drift from what the lane runs.
const { classifyEntry } = require_("../scripts/relocate-catalog-rows-by-list.cjs");

describe("the file targets the catalog lane and stays report-only", () => {
  it("names relocate-catalog-rows-by-list", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
  });

  it("carries no apply authorization", () => {
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("states the finding, the B25- prefix ruling, and the measured counts", () => {
    expect(doc.finding).toMatch(/297/);
    expect(doc.finding).toMatch(/catalog-explode-actuals-2026-08-12/);
    expect(doc.finding).toMatch(/Best of 2025 Autographs/);
    expect(doc.finding).toMatch(/bowmans-best/);
  });
});

describe("count: exactly the measured population", () => {
  it("has 297 entries", () => {
    expect(doc.entries.length).toBe(297);
  });

  it("excludes nothing -- every destination point-read absent", () => {
    expect(doc.excluded.length).toBe(0);
  });

  it("includes the :psa-N graded destinations with their grade suffix intact", () => {
    const gradedEntry = doc.entries.find(
      (e) => e.id === "hiq:baseball:2025:bowman:b25-cme:green-refractor:auto:num-99:psa-9",
    );
    expect(gradedEntry).toBeTruthy();
    expect(gradedEntry!.to).toBe(
      "hiq:baseball:2025:bowmans-best:b25-cme:green-refractor:auto:num-99:psa-9",
    );
  });

  it("no entry id repeats", () => {
    const ids = doc.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every entry is a reslug the lane accepts, on the ruled axis only", () => {
  it("classifyEntry accepts all 296 entries as reslugs", () => {
    for (const e of doc.entries) {
      const v = classifyEntry(e);
      expect(v.ok, `${e.id}: ${v.why}`).toBeTruthy();
      expect(v.action).toBe("reslug");
      expect(v.to).toBe(e.to);
    }
  });

  it("every id's setKey segment (index 3) is bowman", () => {
    for (const e of doc.entries) {
      const seg = e.id.split(":");
      expect(seg[0]).toBe("hiq");
      expect(seg[3]).toBe("bowman");
    }
  });

  it("every to's setKey segment (index 3) is bowmans-best", () => {
    for (const e of doc.entries) {
      const seg = String(e.to).split(":");
      expect(seg[0]).toBe("hiq");
      expect(seg[3]).toBe("bowmans-best");
    }
  });

  it("every cardNumber segment (index 4) starts with b25- (lowercase, as the slug spells it)", () => {
    for (const e of doc.entries) {
      const fromSeg = e.id.split(":");
      const toSeg = String(e.to).split(":");
      expect(fromSeg[4].startsWith("b25-"), e.id).toBe(true);
      expect(toSeg[4].startsWith("b25-"), String(e.to)).toBe(true);
    }
  });

  it("setKey is the ONLY segment that differs between id and to -- every other segment is byte-identical", () => {
    for (const e of doc.entries) {
      const fromSeg = e.id.split(":");
      const toSeg = String(e.to).split(":");
      expect(toSeg.length).toBe(fromSeg.length);
      for (let i = 0; i < fromSeg.length; i++) {
        if (i === 3) {
          expect(fromSeg[i]).toBe("bowman");
          expect(toSeg[i]).toBe("bowmans-best");
        } else {
          expect(toSeg[i], `segment ${i} differs on ${e.id}`).toBe(fromSeg[i]);
        }
      }
    }
  });

  it("fromSetKey/toSetKey mirror the axis and the id/to segments exactly", () => {
    for (const e of doc.entries) {
      expect(e.fromSetKey).toBe("bowman");
      expect(e.toSetKey).toBe("bowmans-best");
      expect(e.fromCardId).toBe(e.id);
      expect(e.toCardId).toBe(e.to);
    }
  });

  it("every entry carries a reason naming the fold and evidence naming the row", () => {
    for (const e of doc.entries) {
      expect(String(e.reason ?? "").length).toBeGreaterThan(20);
      expect(e.reason).toMatch(/bowman/);
      expect(e.reason).toMatch(/bowmans-best/);
      expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
      expect(e.evidence).toMatch(new RegExp(String(e.cardNumber ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }
  });
});

describe("no other field differs -- cardNumber and parallel on the entry match both slugs", () => {
  it("entry.cardNumber appears (case-insensitively) in both id and to", () => {
    for (const e of doc.entries) {
      const num = String(e.cardNumber ?? "").toLowerCase();
      expect(num.length).toBeGreaterThan(0);
      expect(e.id.toLowerCase()).toContain(num);
      expect(String(e.to).toLowerCase()).toContain(num);
    }
  });
});

describe("the census matches what the file actually contains", () => {
  it("census.entries equals doc.entries.length", () => {
    expect(doc.census.entries).toBe(doc.entries.length);
  });

  it("census.excluded equals doc.excluded.length", () => {
    expect(doc.census.excluded).toBe(doc.excluded.length);
  });

  it("census.candidatesMeasured equals entries + excluded", () => {
    expect(doc.census.candidatesMeasured).toBe(doc.entries.length + doc.excluded.length);
  });
});
