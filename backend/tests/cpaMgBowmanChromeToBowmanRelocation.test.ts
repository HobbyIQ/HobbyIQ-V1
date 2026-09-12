/**
 * CF-IT-CAME-OUT-OF-BOWMAN, pool-side fold (2026-09-12).
 *
 * Two of Drew's holdings sit on a setKey with no checklist row while the
 * checklist row lives under a sibling key. This is CASE A: 2026 Chrome
 * Prospect Autograph #CPA-MG (Marconi German) is a 2026 BOWMAN card --
 * Beckett's 2026-bowman-full.csv lists "Chrome Prospect Autographs" (87 base
 * + 47 Gold Ink + 39 PackFractor cards) as a section of the 2026 Bowman
 * product itself, and 2026 Bowman Chrome's OWN Beckett checklist
 * (2026-bowman-chrome.csv, 1197 rows) carries zero CPA-MG rows. The
 * card_catalog fold for the exact holding's address
 * (hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50, movedFrom the
 * bowman-chrome address, movedAt 2026-09-05) already ran -- but the POOL rows
 * were never relocated, so every sale still sits at the old bowman-chrome
 * partition even where its own hobbyiqCardId already names the bowman row.
 *
 * These pins hold the LIST SHAPE and lean on the lane's own
 * `planRelocatedIdentity` (never a re-implementation), so a list this suite
 * accepts is a list the lane can read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

const FILE = "2026-09-12-cpa-mg-bowman-chrome-to-bowman.json";
const DIR = join(process.cwd(), "data", "pool-relocations");

type Entry = { id: string; fromCardId: string; toCardId: string; price?: number; evidence?: string };
type List = {
  forLane: string;
  reportOnlyUntil: string;
  finding: string;
  rulings: string[];
  census: Record<string, unknown>;
  excluded: Array<{ id: string; fromCardId: string; excludeReason: string }>;
  entries: Entry[];
};

const doc = JSON.parse(readFileSync(join(DIR, FILE), "utf8")) as List;

const { planRelocatedIdentity } = require_("../scripts/relocate-pool-rows-by-list.cjs") as {
  planRelocatedIdentity: (a: { storedHobbyiqCardId: string | null; from: string; to: string }) => {
    hobbyiqCardId: string;
    thirdSlug: string | null;
  };
};

describe("the file names the correct lane and stays report-only", () => {
  it("targets relocate-pool-rows-by-list", () => {
    expect(doc.forLane).toBe("relocate-pool-rows-by-list");
  });

  it("carries no apply authorization", () => {
    expect(doc.reportOnlyUntil).toMatch(/no apply is authorized/i);
  });

  it("states the CF-IT-CAME-OUT-OF-BOWMAN finding and the movedFrom/movedAt evidence", () => {
    expect(doc.finding).toMatch(/CF-IT-CAME-OUT-OF-BOWMAN/);
    expect(doc.finding).toMatch(/movedFrom/);
    expect(doc.finding).toMatch(/2026-09-05/);
  });

  it("names the deriver defect (bare bowman-chrome regex, no checklist-presence guard)", () => {
    expect(doc.finding).toMatch(/inferSetKeyFromTitle/);
    expect(doc.finding).toContain("bowman\\s+chrome");
  });
});

describe("every entry is a RELOCATE shape the lane accepts", () => {
  it("every entry has id, fromCardId, toCardId, and fromCardId !== toCardId", () => {
    for (const e of doc.entries) {
      expect(e.id, "missing id").toBeTruthy();
      expect(e.fromCardId, `${e.id}: missing fromCardId`).toBeTruthy();
      expect(e.toCardId, `${e.id}: missing toCardId`).toBeTruthy();
      expect(e.toCardId).not.toBe(e.fromCardId);
    }
  });

  it("every fromCardId sits under the bowman-chrome cpa-mg address (the wrong product)", () => {
    for (const e of doc.entries) {
      expect(e.fromCardId).toMatch(/^hiq:baseball:2026:bowman-chrome:cpa-mg:/);
    }
  });

  it("every toCardId sits under the bowman cpa-mg address (the checklist product)", () => {
    for (const e of doc.entries) {
      expect(e.toCardId).toMatch(/^hiq:baseball:2026:bowman:cpa-mg:/);
    }
  });

  it("addresses each (id, fromCardId) pair at most once", () => {
    const keys = doc.entries.map((e) => `${e.id}|${e.fromCardId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every entry an evidence line naming the title and the destination", () => {
    for (const e of doc.entries) {
      expect(String(e.evidence ?? "").length).toBeGreaterThan(20);
      expect(e.evidence).toContain(e.toCardId);
    }
  });
});

describe("planRelocatedIdentity (the lane's own function) lands every entry's identity at `to`", () => {
  it("hobbyiqCardId always becomes `to`, whatever the stored value was", () => {
    for (const e of doc.entries) {
      const r = planRelocatedIdentity({ storedHobbyiqCardId: e.toCardId, from: e.fromCardId, to: e.toCardId });
      expect(r.hobbyiqCardId).toBe(e.toCardId);
      expect(r.thirdSlug).toBeNull();
    }
  });

  it("a THIRD SLUG (stored hobbyiqCardId already something else) is still corrected to `to`, and reported", () => {
    // Simulates a row whose stored hobbyiqCardId is neither the old partition
    // nor the new one (a prior partial repoint, or a stale suggestion).
    const e = doc.entries.find((x) => x.id === "tca-ebay::377401957369")!;
    const weird = "hiq:baseball:2026:bowman-chrome:cpa-mg:speckle-refractor:auto"; // unnumbered stub
    const r = planRelocatedIdentity({ storedHobbyiqCardId: weird, from: e.fromCardId, to: e.toCardId });
    expect(r.hobbyiqCardId).toBe(e.toCardId);
    expect(r.thirdSlug).toBe(weird);
  });
});

describe("the print-run reconciliation: title states a number, destination is the numbered checklist row", () => {
  it("every Speckle Refractor sale (title states /299) targets the numbered address, not the unnumbered stub", () => {
    const speckleEntries = doc.entries.filter((e) => /speckle-refractor/.test(e.toCardId));
    expect(speckleEntries.length).toBeGreaterThan(0);
    for (const e of speckleEntries) {
      expect(e.toCardId).toBe("hiq:baseball:2026:bowman:cpa-mg:speckle-refractor:auto:num-299");
    }
  });

  it("the Gold Refractor sale (the holding's own card) targets the exact checklist row with its print run", () => {
    const goldEntries = doc.entries.filter((e) => e.toCardId.includes("gold-refractor"));
    expect(goldEntries.length).toBe(2);
    for (const e of goldEntries) {
      expect(e.toCardId).toBe("hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50");
    }
  });

  it("includes the holding's own purchased sale", () => {
    const own = doc.entries.find((e) => e.id === "ebay-user-purchase::holding::ca7a150b-f126-49e0-bd5b-f899ff964a1f");
    expect(own).toBeTruthy();
    expect(own!.toCardId).toBe("hiq:baseball:2026:bowman:cpa-mg:refractor:auto:num-499");
  });
});

describe("the Mini Diamond Refractor gap is excluded, never minted", () => {
  it("excludes tca-ebay::178410615046 with a no-checklist-row reason", () => {
    const ex = doc.excluded.find((e) => e.id === "tca-ebay::178410615046");
    expect(ex).toBeTruthy();
    expect(ex!.excludeReason).toMatch(/no .*checklist row exists/i);
    expect(ex!.excludeReason).toMatch(/absent beats wrong/i);
  });

  it("the excluded id never appears in entries", () => {
    expect(doc.entries.some((e) => e.id === "tca-ebay::178410615046")).toBe(false);
  });
});
