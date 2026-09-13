// CF-SIBLING-CHECKLIST-DECIDES-THE-PRODUCT (#2064, generalized after #2069
// found the same defect on CPA-VF the same night the class was declared open,
// not one holding).
//
// SIBLING_CHECKLIST_OVERRIDES in hobbyIqCardId.service.ts is HARDCODED, not
// read from the CSVs at runtime — that module has zero filesystem I/O today
// and sits on the hot path of every minted id, and a CSV read + parse there
// would be a heavier, riskier change than the two-list generalization itself
// (see CF-RECONCILIATION-DEFENSIVE-LOAD in setKeyReconciliation.ts for the
// exact shape of risk a throw-at-import in a transitively-imported module
// creates). So the safety net is here instead: this suite re-reads BOTH real
// 2026 checklist CSVs on every run and asserts the exported lists are an
// EXACT match — same members, same set membership, same exclusions. A future
// checklist re-scrape that adds, removes, or renumbers a CPA- card fails this
// test rather than silently drifting the deriver out of sync with the data
// it is supposed to be reading.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CPA_2026_BOWMAN_ONLY,
  CPA_2026_BOWMAN_CHROME_ONLY,
  applySiblingChecklistOverride,
} from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const DATA_DIR = path.resolve(__dirname, "../data/checklists/scraped");

/** Every CPA- card number a checklist CSV's `cardNumber` column lists,
 *  upper-cased, de-duplicated. Mirrors how the deriver reads a card number:
 *  case-insensitive, and a number repeated across parallel rows (base/gold-
 *  ink/packfractor) counts once. */
function cpaNumbersIn(csvPath: string): Set<string> {
  const text = readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).slice(1); // drop header
  const out = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const cardNumber = line.split(",")[1]?.trim().toUpperCase() ?? "";
    if (/^CPA-/.test(cardNumber)) out.add(cardNumber);
  }
  return out;
}

const bowmanFull = cpaNumbersIn(path.join(DATA_DIR, "2026-bowman-full.csv"));
const bowmanChrome = cpaNumbersIn(path.join(DATA_DIR, "2026-bowman-chrome.csv"));

const liveBowmanOnly = [...bowmanFull].filter((n) => !bowmanChrome.has(n)).sort();
const liveChromeOnly = [...bowmanChrome].filter((n) => !bowmanFull.has(n)).sort();
const liveBoth = [...bowmanFull].filter((n) => bowmanChrome.has(n)).sort();

describe("the checklist CSVs are readable and non-trivial (a sanity floor under the whole suite)", () => {
  it("both files parse to a real number of CPA- rows", () => {
    expect(bowmanFull.size).toBeGreaterThan(50);
    expect(bowmanChrome.size).toBeGreaterThan(50);
  });
});

describe("CPA_2026_BOWMAN_ONLY matches a live re-read of the two CSVs exactly", () => {
  it("same length", () => {
    expect(CPA_2026_BOWMAN_ONLY.length).toBe(liveBowmanOnly.length);
  });

  it("same members, no extras and nothing missing", () => {
    const exported = [...CPA_2026_BOWMAN_ONLY].sort();
    expect(exported).toEqual(liveBowmanOnly);
  });

  it("every member really is CPA-only-in-full: present in bowman-full, absent from bowman-chrome", () => {
    for (const n of CPA_2026_BOWMAN_ONLY) {
      expect(bowmanFull.has(n), `${n} should be in 2026-bowman-full.csv`).toBe(true);
      expect(bowmanChrome.has(n), `${n} should NOT be in 2026-bowman-chrome.csv`).toBe(false);
    }
  });
});

describe("CPA_2026_BOWMAN_CHROME_ONLY matches a live re-read of the two CSVs exactly", () => {
  it("same length", () => {
    expect(CPA_2026_BOWMAN_CHROME_ONLY.length).toBe(liveChromeOnly.length);
  });

  it("same members, no extras and nothing missing", () => {
    const exported = [...CPA_2026_BOWMAN_CHROME_ONLY].sort();
    expect(exported).toEqual(liveChromeOnly);
  });

  it("every member really is CPA-only-in-chrome: present in bowman-chrome, absent from bowman-full", () => {
    for (const n of CPA_2026_BOWMAN_CHROME_ONLY) {
      expect(bowmanChrome.has(n), `${n} should be in 2026-bowman-chrome.csv`).toBe(true);
      expect(bowmanFull.has(n), `${n} should NOT be in 2026-bowman-full.csv`).toBe(false);
    }
  });
});

describe("the two lists are disjoint from each other and from the excluded 'both' set", () => {
  it("no number appears in both lists", () => {
    const chromeSet = new Set(CPA_2026_BOWMAN_CHROME_ONLY);
    for (const n of CPA_2026_BOWMAN_ONLY) expect(chromeSet.has(n), n).toBe(false);
  });

  it("the excluded (present-in-both) count and members match the doc comment: 8 numbers, AG/BC/DF/EM/HL/JS/LA/WA", () => {
    expect(liveBoth.length).toBe(8);
    expect(liveBoth).toEqual([
      "CPA-AG", "CPA-BC", "CPA-DF", "CPA-EM", "CPA-HL", "CPA-JS", "CPA-LA", "CPA-WA",
    ]);
  });

  it("neither exported list contains an excluded (both-checklist) number", () => {
    const both = new Set(liveBoth);
    for (const n of CPA_2026_BOWMAN_ONLY) expect(both.has(n), `${n} is a collision number and must be excluded`).toBe(false);
    for (const n of CPA_2026_BOWMAN_CHROME_ONLY) expect(both.has(n), `${n} is a collision number and must be excluded`).toBe(false);
  });

  it("CPA-AG (Adrian Gil / Angeibel Gomez) is untouched in both directions -- the canary for the whole class", () => {
    expect(applySiblingChecklistOverride("bowman-chrome", "CPA-AG", 2026)).toBe("bowman-chrome");
    expect(applySiblingChecklistOverride("bowman", "CPA-AG", 2026)).toBe("bowman");
  });
});

describe("Figueroa CPA-VF (#2069) is covered by the generalized table", () => {
  it("CPA-VF is in the Bowman-only list", () => {
    expect(CPA_2026_BOWMAN_ONLY).toContain("CPA-VF");
  });

  it("applySiblingChecklistOverride moves a 2026 bowman-chrome CPA-VF row to bowman", () => {
    expect(applySiblingChecklistOverride("bowman-chrome", "CPA-VF", 2026)).toBe("bowman");
    expect(applySiblingChecklistOverride("bowman-chrome", "cpa-vf", 2026)).toBe("bowman");
  });
});

describe("Deward Tovar's 2026 CPA-DT (chrome-only) does not collide with the unrelated 2025 CPA-DT ruling", () => {
  // #1860/#1912's CPA-DT is Diego Tornes (bowman-chrome) vs Devin Taylor
  // (bowman-draft) in 2025 -- a different YEAR and a different sibling pair
  // entirely. This table is year-scoped to 2026, so it must never answer for
  // 2025's CPA-DT.
  it("2026 CPA-DT is chrome-only and maps bowman -> bowman-chrome", () => {
    expect(CPA_2026_BOWMAN_CHROME_ONLY).toContain("CPA-DT");
    expect(applySiblingChecklistOverride("bowman", "CPA-DT", 2026)).toBe("bowman-chrome");
  });

  it("2025 CPA-DT is untouched by this table (wrong year)", () => {
    expect(applySiblingChecklistOverride("bowman", "CPA-DT", 2025)).toBe("bowman");
    expect(applySiblingChecklistOverride("bowman-chrome", "CPA-DT", 2025)).toBe("bowman-chrome");
  });
});
