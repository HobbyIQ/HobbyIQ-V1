/**
 * merge-census-backing.cjs — the 32-slot backing-count merge (2026-09-19
 * census batch, CF-CENSUS-BACKING-IS-CATALOG-ONLY).
 *
 * WHAT'S PINNED. Pure aggregation only: summing bucket counts across slot
 * artifacts, ranking the unbacked cells, and refusing cleanly on missing or
 * malformed input. No Cosmos, no APPLY, nothing live — the script's own
 * `classifyTopCells` Cosmos read is exercised separately (or not at all)
 * because it is explicitly best-effort and gated behind CATALOG_CHECK=true.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M = require_(path.join(backend, "scripts", "merge-census-backing.cjs"));

function bucket(overrides: Partial<Record<string, number>> = {}) {
  return { backedStrict: 0, rowExistsNonStrict: 0, noRow: 0, unparseable: 0, parked: 0, ...overrides };
}

function writeSlotArtifact(dir: string, slot: number, backing: any) {
  const file = path.join(dir, `census-slot-${slot}.json`);
  fs.writeFileSync(file, JSON.stringify({ slot, classified: 100, counts: {}, backing }));
  return file;
}

function tmpDir() {
  // CF-BUILDERS-USE-PER-CLONE-SCRATCH-PATHS: unique per test run, never a
  // shared /tmp name.
  return fs.mkdtempSync(path.join(os.tmpdir(), "census-backing-test-"));
}

describe("addInto / totalOf — the bucket arithmetic", () => {
  it("sums each of the five buckets independently", () => {
    const acc = M.emptyBuckets();
    M.addInto(acc, bucket({ backedStrict: 3, noRow: 1 }));
    M.addInto(acc, bucket({ backedStrict: 2, rowExistsNonStrict: 5 }));
    expect(acc).toEqual({ backedStrict: 5, rowExistsNonStrict: 5, noRow: 1, unparseable: 0, parked: 0 });
  });

  it("totalOf is the sum across all five buckets, including parked", () => {
    expect(M.totalOf(bucket({ backedStrict: 1, rowExistsNonStrict: 2, noRow: 3, unparseable: 4, parked: 5 }))).toBe(15);
  });
});

describe("readSlotArtifacts — discovery", () => {
  it("reads every .json file directly inside a directory", () => {
    const dir = tmpDir();
    writeSlotArtifact(dir, 0, { bySport: { baseball: bucket({ backedStrict: 1 }) }, byCell: {} });
    writeSlotArtifact(dir, 1, { bySport: { baseball: bucket({ noRow: 1 }) }, byCell: {} });
    const { slots, skipped } = M.readSlotArtifacts([dir]);
    expect(slots.map((s: any) => s.slot).sort()).toEqual([0, 1]);
    expect(skipped).toHaveLength(0);
  });

  it("skips a file with no `backing` key rather than throwing — a census run without SOURCES=backing writes one of these", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "census-slot-5.json"), JSON.stringify({ slot: 5, classified: 10, counts: {} }));
    const { slots, skipped } = M.readSlotArtifacts([dir]);
    expect(slots).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/not a backing-armed/);
  });

  it("skips unreadable JSON without throwing", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "census-slot-9.json"), "{not json");
    const { slots, skipped } = M.readSlotArtifacts([dir]);
    expect(slots).toHaveLength(0);
    expect(skipped[0].reason).toBe("unreadable");
  });

  it("accepts a single file path as well as a directory", () => {
    const dir = tmpDir();
    const file = writeSlotArtifact(dir, 3, { bySport: {}, byCell: {} });
    const { slots } = M.readSlotArtifacts([file]);
    expect(slots).toHaveLength(1);
    expect(slots[0].slot).toBe(3);
  });
});

describe("mergeSlots — the sum across slots", () => {
  it("sums bySport across every slot for the same sport key", () => {
    const dir = tmpDir();
    writeSlotArtifact(dir, 0, { bySport: { baseball: bucket({ backedStrict: 10, noRow: 5 }) }, byCell: {} });
    writeSlotArtifact(dir, 1, { bySport: { baseball: bucket({ backedStrict: 7, noRow: 3 }) }, byCell: {} });
    const { slots } = M.readSlotArtifacts([dir]);
    const { bySport } = M.mergeSlots(slots);
    expect(bySport.get("baseball")).toEqual(bucket({ backedStrict: 17, noRow: 8 }));
  });

  it("sums byCell across slots for the identical cell key", () => {
    const dir = tmpDir();
    const cell = "baseball|2018|topps-chrome";
    writeSlotArtifact(dir, 0, { bySport: {}, byCell: { [cell]: bucket({ noRow: 4 }) } });
    writeSlotArtifact(dir, 1, { bySport: {}, byCell: { [cell]: bucket({ noRow: 6 }) } });
    const { slots } = M.readSlotArtifacts([dir]);
    const { byCell } = M.mergeSlots(slots);
    expect(byCell.get(cell)).toEqual(bucket({ noRow: 10 }));
  });

  it("an 'other' overflow cell in one slot and not another still sums correctly, and anyOverflowed is sticky true", () => {
    const dir = tmpDir();
    writeSlotArtifact(dir, 0, { bySport: {}, byCell: { other: bucket({ noRow: 50 }) }, cellOverflowed: true });
    writeSlotArtifact(dir, 1, { bySport: {}, byCell: { other: bucket({ noRow: 25 }) }, cellOverflowed: false });
    const { slots } = M.readSlotArtifacts([dir]);
    const { byCell, anyOverflowed } = M.mergeSlots(slots);
    expect(byCell.get("other")).toEqual(bucket({ noRow: 75 }));
    expect(anyOverflowed).toBe(true);
  });
});

describe("topUnbackedCells — ranking, and the 'other' exclusion", () => {
  it("ranks by (noRow + rowExistsNonStrict), descending", () => {
    const byCell = new Map<string, any>([
      ["baseball|2018|topps", bucket({ noRow: 100 })],
      ["baseball|2019|topps-chrome", bucket({ rowExistsNonStrict: 500 })],
      ["baseball|2020|donruss", bucket({ noRow: 10, rowExistsNonStrict: 5 })],
    ]);
    const top = M.topUnbackedCells(byCell, 10);
    expect(top.map((r: any) => r.cell)).toEqual([
      "baseball|2019|topps-chrome",
      "baseball|2018|topps",
      "baseball|2020|donruss",
    ]);
  });

  it("excludes the 'other' overflow bucket from the ranked list entirely", () => {
    const byCell = new Map<string, any>([
      ["other", bucket({ noRow: 999999 })],
      ["baseball|2018|topps", bucket({ noRow: 5 })],
    ]);
    const top = M.topUnbackedCells(byCell, 10);
    expect(top).toHaveLength(1);
    expect(top[0].cell).toBe("baseball|2018|topps");
  });

  it("excludes a fully-backed cell (no unbacked volume) from the ranking", () => {
    const byCell = new Map<string, any>([
      ["baseball|2018|topps", bucket({ backedStrict: 500 })],
    ]);
    expect(M.topUnbackedCells(byCell, 10)).toHaveLength(0);
  });

  it("respects the topN cap", () => {
    const byCell = new Map<string, any>();
    for (let i = 0; i < 50; i++) byCell.set(`baseball|2018|set-${i}`, bucket({ noRow: i + 1 }));
    expect(M.topUnbackedCells(byCell, 5)).toHaveLength(5);
  });
});

describe("filesOf — the artifact-discovery shape rebaseline-i9-reference.cjs also uses", () => {
  it("returns [] for a path that does not exist, never throws", () => {
    expect(M.filesOf("/no/such/path/at/all.json")).toEqual([]);
  });

  it("returns [] for a non-.json single file", () => {
    const dir = tmpDir();
    const f = path.join(dir, "notes.txt");
    fs.writeFileSync(f, "hi");
    expect(M.filesOf(f)).toEqual([]);
  });
});
