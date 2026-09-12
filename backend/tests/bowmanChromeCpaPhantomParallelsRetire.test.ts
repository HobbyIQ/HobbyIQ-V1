import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * 2026-09-12 widget ruling (Drew) -- THE BOWMAN-CHROME CPA PHANTOM PARALLELS.
 *
 * backend/data/checklists/hand-fetched/parallels-2026-bowman-chrome-baseball.json
 * (a generic colour-parallel ladder, source baseballcardpedia+observed-sold-comps)
 * was applied mechanically to every CPA-* card number under setKey bowman-chrome,
 * minting card_catalog rows (source "checklist") for numbers that are attested
 * ONLY in the 2026 BOWMAN (paper) product's own checklist
 * (backend/data/checklists/scraped/2026-bowman-full.csv) and never in 2026 Bowman
 * Chrome's own checklist (backend/data/checklists/scraped/2026-bowman-chrome.csv).
 * Bowman and Bowman Chrome are DIFFERENT cards (project_bowman_setkey_taxonomy);
 * a card number's presence in one product's checklist says nothing about the
 * other product.
 *
 * Census, read-only against prod card_catalog, 2026-09-12: 79 CPA-* numbers are
 * attested ONLY in the Bowman paper checklist. Excluding the 8 numbers legitimate
 * in BOTH products (different players) and CPA-MG (already handled by the
 * separate #2060 / 2026-09-12-cpa-mg-bowman-chrome-to-bowman.json lane), 27
 * bowman-chrome catalog rows exist on these phantom numbers; one (CPA-VF's
 * checklist-backed Black & White Red Ink row) is the 08-30 Red Ink ruling's own
 * scope and is excluded here too -- leaving the 26 retires this list pins.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "catalog-relocations", "2026-09-12-bowman-chrome-cpa-phantom-parallels-retire.json"),
    "utf8",
  ),
);

type CatEntry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
const entries = list.entries as CatEntry[];

// The 8 card numbers the ruling names as legitimate in BOTH 2026 Bowman and
// 2026 Bowman Chrome, for different people. Built independently of the list's
// own generation so a bug in the generator cannot also poison this check.
const BOTH_PRODUCTS_NUMBERS = ["cpa-ag", "cpa-bc", "cpa-df", "cpa-em", "cpa-hl", "cpa-js", "cpa-la", "cpa-wa"];

// CPA-VF's two Red Ink addresses. Owned by the 08-30 ruling's 2026-09-12
// twin-fold PR (data/pool-relocations/2026-09-12-figueroa-red-ink-twin-fold.json
// + data/catalog-relocations/2026-09-12-figueroa-red-ink-twin-retire.json).
const RED_INK_IDS = [
  "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink:auto",
  "hiq:baseball:2026:bowman-chrome:cpa-vf:black-white-red-ink-refractor:auto",
];

/** The setKey:cardNumber segment of a hiq slug, lowercased. */
function cardNumberOf(id: string): string {
  const parts = id.split(":");
  return (parts[4] ?? "").toLowerCase();
}

describe("2026-09-12 bowman-chrome CPA phantom parallels: the catalog retire list", () => {
  it("is addressed to the catalog lane and is report-only", () => {
    expect(list.forLane).toBe("relocate-catalog-rows-by-list");
    expect(String(list.reportOnlyUntil)).toMatch(/no apply is authorized/i);
  });

  it("every entry passes the LANE'S OWN classifier — not a second copy of it", () => {
    const lane = path.join(process.cwd(), "scripts", "relocate-catalog-rows-by-list.cjs");
    const L = require_(lane) as { classifyEntry: (e: unknown) => { ok: boolean; why?: string } };
    for (const e of entries) {
      const r = L.classifyEntry(e);
      expect(r.ok, `${e.id}: ${r.why ?? ""}`).toBe(true);
    }
  });

  it("is exactly 26 retires, in a stable sorted order", () => {
    expect(list.census.totalRetires).toBe(26);
    expect(entries).toHaveLength(26);
    expect(new Set(entries.map((e) => e.id)).size).toBe(26);
    const ids = entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("is a retire-only list — nothing is reslugged, nothing is parked here", () => {
    // The catalog lane has no "park" for a phantom row with no bowman equivalent
    // (a park stamp with no matcher predicate reading it would not stop this row
    // resolving); the ruling's disposition for those is a retire, and the
    // checklist-gap framing is carried in the reason text instead.
    for (const e of entries) {
      expect(e.action).toBe("retire");
      expect(e.to ?? "").toBe("");
      expect(e.reason, e.id).toBeTruthy();
      expect(e.evidence, e.id).toBeTruthy();
    }
  });

  it("every entry is setKey bowman-chrome, cardYear 2026", () => {
    for (const e of entries) {
      const parts = e.id.split(":");
      expect(parts[0], e.id).toBe("hiq");
      expect(parts[1], e.id).toBe("baseball");
      expect(parts[2], e.id).toBe("2026");
      expect(parts[3], e.id).toBe("bowman-chrome");
    }
  });

  it("touches NO number legitimate in both 2026 Bowman and Bowman Chrome", () => {
    for (const e of entries) {
      expect(BOTH_PRODUCTS_NUMBERS, e.id).not.toContain(cardNumberOf(e.id));
    }
  });

  it("touches NEITHER CPA-VF Red Ink row — that fold belongs to the 08-30 ruling", () => {
    const ids = new Set(entries.map((e) => e.id));
    for (const redInkId of RED_INK_IDS) {
      expect(ids.has(redInkId), redInkId).toBe(false);
    }
  });

  it("touches NO cpa-mg row — already handled by the separate #2060 lane", () => {
    for (const e of entries) {
      expect(cardNumberOf(e.id), e.id).not.toBe("cpa-mg");
    }
  });

  it("names 5 rows with a checklist-backed Bowman equivalent and 21 without", () => {
    expect(list.census.retiresWithBowmanEquivalent).toBe(5);
    expect(list.census.retiresNoBowmanEquivalentChecklistGap).toBe(21);
    expect(list.census.retiresWithBowmanEquivalent + list.census.retiresNoBowmanEquivalentChecklistGap).toBe(26);

    const withEquivalent = entries.filter((e) => /Bowman equivalent exists at/.test(e.reason ?? ""));
    const withoutEquivalent = entries.filter((e) => /No Bowman equivalent row exists/.test(e.reason ?? ""));
    expect(withEquivalent).toHaveLength(5);
    expect(withoutEquivalent).toHaveLength(21);
  });

  it("records the one entry that depends on the paired pool list applying first", () => {
    const dependent = entries.filter((e) => /this retire runs ONLY after that park has applied/.test(e.evidence ?? ""));
    expect(dependent).toHaveLength(1);
    expect(dependent[0].id).toBe("hiq:baseball:2026:bowman-chrome:cpa-eha:packfractor:auto:num-89");
    expect(String(list.applyOrder)).toMatch(/RUNS SECOND/);
    expect(String(list.applyOrder)).toMatch(/2026-09-12-bowman-chrome-cpa-phantom-parallels-park\.json/);
  });

  it("sales moved is zero — this list relocates nothing, only retires", () => {
    expect(list.census.salesMoved).toBe(0);
    expect(list.census.salesParked).toBe(1);
  });

  it("records the exclusion rulings by name, not just by absence", () => {
    const rulings = JSON.stringify(list.rulings);
    expect(rulings).toMatch(/CPA-AG, BC, DF, EM, HL, JS, LA, WA/);
    expect(rulings).toMatch(/CPA-MG is excluded/);
    expect(rulings).toMatch(/black-white-red-ink/);
    expect(rulings).toMatch(/CHECKLIST GAP/);
  });
});
