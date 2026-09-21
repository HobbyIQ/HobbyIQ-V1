import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * CF-DRAFT-SAPPHIRE-REKEY (2026-09-21). A PR ingested 1,410 checklist rows
 * hiq:baseball:2025:bowman-draft:<cardNumber>:<parallel>:<auto>[:num-N]
 * (source checklistinsider-2026-09-21, package backend/data/checklists/
 * scraped/acq-2026-09-21-checklistinsider-bowman-draft-sapphire-ladder-2025)
 * under the WRONG product key. 2025 Bowman Draft Sapphire is its own
 * registered product, bowman-draft-sapphire (productSetKeys.ts, parent
 * bowman-draft) -- confirmed both by computeHobbyIqCardId/inferSetKeyFromTitle
 * (built dist, 2026-09-21) and by card_catalog's own pre-existing 4,751-row
 * population at the bowman-draft-sapphire: id prefix for these 263
 * cardNumbers (vs 1,648 sapphire rows misfiled under bowman-draft:).
 *
 * The wrong-key package is removed (this PR) so it can never be re-ingested,
 * and this list retires the 1,410 bowman-draft: rows it minted. Every entry
 * was verified READ-ONLY, per id, before being listed: the bowman-draft: row
 * exists with source exactly "checklistinsider-2026-09-21" (all 1,410 of
 * 1,410 candidates passed; none excluded).
 *
 * sold_comps rows are resident at the retired addresses (sampled across all
 * four cardNumber-prefix buckets BDC-/CPA-/SSA-/SS-, all source=cardhedge).
 * They are reported, not moved, by this PR.
 */

const dataDir = path.join(process.cwd(), "data");
const list = JSON.parse(
  readFileSync(
    path.join(dataDir, "catalog-relocations", "2026-09-21-bowman-draft-sapphire-wrongkey-retire.json"),
    "utf8",
  ),
);

type CatEntry = { id: string; action: string; to?: string; reason?: string; evidence?: string };
const entries = list.entries as CatEntry[];

describe("2026-09-21 Bowman Draft Sapphire wrong-key (bowman-draft:) retire list", () => {
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

  it("has exactly 1,410 entries, all unique ids", () => {
    expect(entries).toHaveLength(1410);
    expect(new Set(entries.map((e) => e.id)).size).toBe(1410);
    expect(list.census.catalogRowsRetired).toBe(1410);
  });

  it("is a retire-only list — nothing is reslugged and nothing is minted", () => {
    for (const e of entries) {
      expect(e.action).toBe("retire");
      expect(e.to ?? "").toBe("");
    }
  });

  it("every id is under the wrong-key hiq:baseball:2025:bowman-draft: prefix, none under bowman-draft-sapphire:", () => {
    for (const e of entries) {
      expect(e.id.startsWith("hiq:baseball:2025:bowman-draft:"), e.id).toBe(true);
      expect(e.id.startsWith("hiq:baseball:2025:bowman-draft-sapphire:"), e.id).toBe(false);
    }
  });

  it("zero entries were excluded for a source mismatch or a missing row", () => {
    expect(list.census.sourceExcluded).toBe(0);
    expect(list.census.notFoundExcluded).toBe(0);
  });

  it("every entry's reason cites the wrong-key package and the correct product key", () => {
    for (const e of entries) {
      expect(e.reason ?? "", e.id).toMatch(/checklistinsider-2026-09-21/);
      expect(e.reason ?? "", e.id).toMatch(/bowman-draft-sapphire/);
    }
  });

  it("every entry's evidence cites a READ-ONLY point-read confirming source checklistinsider-2026-09-21", () => {
    for (const e of entries) {
      expect(e.evidence ?? "", e.id).toMatch(/checklistinsider-2026-09-21/);
    }
  });
});
