import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * EVERY POOL-RELOCATION LIST IS AN OBJECT, NEVER A BARE ARRAY.
 *
 * `relocate-pool-rows-by-list.cjs` reads its scope as
 * `Array.isArray(doc.entries) ? doc.entries : []` and then refuses:
 *
 *     FATAL: <scope> names no entries — nothing is in scope.
 *
 * A list committed as a bare `[...]` therefore has NO `.entries` property, so
 * the lane reads zero entries and exits 1. That is exactly what happened to
 * 2026-09-07-i5-one-sale-one-address.json and 2026-09-07-staging-twins.json
 * (both from #1956): runs died at entry 0 with a list that was, on its face,
 * full. The failure is silent in review — the file looks complete, and only a
 * dispatch reveals that the lane cannot see any of it.
 *
 * This is a DIRECTORY SWEEP, not a per-list content pin (auditI3I5I6Lists.test.ts
 * pins the contents of three particular lists). It asserts only the one shape
 * the lane depends on, so any future list dropped into this directory is
 * checked the moment it lands rather than at dispatch time.
 *
 * MANIFESTS ARE EXEMPTED BY THEIR KEYS, NEVER BY THEIR FILE NAME. This
 * directory also holds census/canary/observation documents that are not
 * addressed to a relocate lane and legitimately carry no `entries`. A
 * name-based allowlist would rot the moment one is renamed, and worse, would
 * let a genuinely broken list hide behind a matching name. So the exemption is
 * read off the document itself.
 */

const dir = path.join(process.cwd(), "data", "pool-relocations");

/** Keys that mark a document as a manifest/census rather than a lane scope. */
const MANIFEST_KEYS = ["listPaths", "observations", "canaries"] as const;

type PoolEntry = { id?: unknown; fromCardId?: unknown; action?: unknown };

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const load = (f: string): unknown => JSON.parse(readFileSync(path.join(dir, f), "utf8"));

describe("backend/data/pool-relocations: every lane scope is an object with entries", () => {
  it("the directory is non-empty — a passing sweep over nothing proves nothing", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s is not a bare array", (f) => {
    const doc = load(f);
    // The whole defect, named with the file that carries it. A bare array has
    // no `.entries`, so the lane sees an empty scope and refuses.
    expect(
      Array.isArray(doc),
      `${f} is a BARE JSON ARRAY. relocate-pool-rows-by-list.cjs reads doc.entries, ` +
        `so this list is invisible to the lane and every run FATALs with ` +
        `"names no entries". Wrap it as { generatedAt, forLane, finding, rulings, entries: [...] }.`,
    ).toBe(false);
    expect(typeof doc, `${f} must be a JSON object`).toBe("object");
    expect(doc, `${f} must not be null`).not.toBeNull();
  });

  it.each(files)("%s: if it is a lane scope, its entries are usable", (f) => {
    const doc = load(f) as Record<string, unknown>;

    // Exempt by KEY, not by name: a manifest/census names no lane scope.
    const isManifest = MANIFEST_KEYS.some((k) => k in doc);
    // A lane scope declares itself either by addressing a lane or by carrying
    // an entry-like array. Both are read off the document.
    const hasEntryArray = Array.isArray(doc.entries);
    const isLaneScope = !isManifest && ("forLane" in doc || hasEntryArray);
    if (!isLaneScope) return;

    expect(
      hasEntryArray,
      `${f} addresses a lane (forLane=${JSON.stringify(doc.forLane)}) but has no entries[] array`,
    ).toBe(true);

    const entries = doc.entries as PoolEntry[];
    expect(entries.length, `${f} has an EMPTY entries[] — the lane refuses an empty scope`)
      .toBeGreaterThan(0);

    entries.forEach((e, i) => {
      expect(e, `${f} entry ${i} is not an object`).toBeTypeOf("object");
      const entry = e as PoolEntry;
      const id = String(entry.id ?? "");
      expect(id, `${f} entry ${i} has no id`).not.toBe("");

      // This directory also holds one CATALOG-lane list (entries carry
      // `action`/`to` and address rows by slug, so `fromCardId` is not their
      // field). Demanding a pool field of a catalog entry would be a wrong
      // guard, so the required field is read off the entry's OWN shape --
      // again by key, never by file name.
      const isCatalogEntry = typeof entry.action === "string" && entry.action !== "";
      if (isCatalogEntry) return;
      expect(
        String(entry.fromCardId ?? ""),
        `${f} entry ${i} (id=${id}) has no fromCardId — a pool entry must name ` +
          `the partition it is addressed to`,
      ).not.toBe("");
    });
  });
});

describe("the two #1956 lists the lane could not read", () => {
  // Runs 34169072301 and siblings died here. These pins prove the lane now
  // sees the scope it was always meant to see.
  it("i5-one-sale-one-address names its 7 entries to the pool lane", () => {
    const doc = load("2026-09-07-i5-one-sale-one-address.json") as Record<string, unknown>;
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.forLane).toBe("relocate-pool-rows-by-list");
    // The lane's own read, reproduced exactly.
    const entries = Array.isArray(doc.entries) ? (doc.entries as PoolEntry[]) : [];
    expect(entries).toHaveLength(7);
    expect(String(doc.finding)).toMatch(/I5/);
    expect((doc.rulings as string[]).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(doc.rulings)).toMatch(/#1956/);
    // Every entry is a PARK: no copy is promoted on no evidence.
    for (const e of entries as Array<PoolEntry & { parkIdentityUnverified?: boolean }>) {
      expect(e.parkIdentityUnverified).toBe(true);
    }
  });

  it("staging-twins names its 71 entries to the pool lane", () => {
    const doc = load("2026-09-07-staging-twins.json") as Record<string, unknown>;
    expect(Array.isArray(doc)).toBe(false);
    expect(doc.forLane).toBe("relocate-pool-rows-by-list");
    const entries = Array.isArray(doc.entries) ? (doc.entries as PoolEntry[]) : [];
    expect(entries).toHaveLength(71);
  });

  it("the evidence strings are clean UTF-8, not mojibake", () => {
    // The em dash must be U+2014 itself, never the Â/â double-encoding that a
    // latin-1 round trip leaves behind.
    for (const f of ["2026-09-07-i5-one-sale-one-address.json", "2026-09-07-staging-twins.json"]) {
      const raw = readFileSync(path.join(dir, f), "utf8");
      expect(raw, `${f} carries double-encoded UTF-8`).not.toMatch(/â€|Ã¢/);
      expect(raw).toContain("—");
    }
  });
});
