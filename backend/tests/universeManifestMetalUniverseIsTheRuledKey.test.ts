import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

/**
 * CF-METAL-UNIVERSE-IS-THE-RULED-KEY (2026-09-13, package A acquisition).
 *
 * `backend/data/ingest-universe.json` carried eight sportscardchecklist entries
 * for 1997-98 Metal Universe Basketball under `setKey: "fleer-metal-universe"`,
 * because that is how the source's own slug spells the era's brand
 * (`1997-98-fleer-metal-universe-basketball-...`) and `setKeyFor()` derives the
 * key from the set NAME.
 *
 * The registered, ruled key is the bare one: `productSetKeys.ts` declares
 * `P("metal-universe")`, and the 2026-09-12 relocation
 * `data/catalog-relocations/2026-09-12-skybox-metal-universe-1997-self-derived-retire.json`
 * retires a self-derived `skybox-metal-universe` row precisely BECAUSE its
 * checklist-backed twin lives at `metal-universe`. `fleer-metal-universe` and
 * `skybox-metal-universe` are era-misnomer twins of that one product.
 *
 * WHY A FIXED-POINT CHECK IS NOT ENOUGH, and why this test exists instead.
 * All three spellings are normalizeSetKey fixed points:
 *
 *     metal-universe        -> metal-universe         (fixed)
 *     fleer-metal-universe  -> fleer-metal-universe   (fixed)
 *     skybox-metal-universe -> skybox-metal-universe  (fixed)
 *
 * so the usual "every emitted setKey is a fixed point" guard passes on all of
 * them and cannot see this. Worse, normalizeSetKey of the SET NAME
 * ("1997-98 Fleer Metal Universe Basketball") returns `fleer-metal-universe` --
 * the derivation reproduces the wrong key rather than correcting it. Canonical
 * here is a RULING, not a normalization, so it is pinned as one: the driver
 * would otherwise mint 1997-98 basketball rows at a third address the pool does
 * not use and split the product three ways.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, "..", "data", "ingest-universe.json");

type Entry = {
  id: string;
  lane: string;
  sport: string;
  year: number;
  setName: string;
  setKey?: string;
  derivedSetKey?: string;
};

const entries: Entry[] = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).entries;

describe("ingest-universe manifest: metal-universe is the ruled key", () => {
  it("has no sportscardchecklist entry left on the fleer-metal-universe twin", () => {
    const strays = entries.filter(
      (e) => e.lane === "sportscardchecklist" && e.setKey === "fleer-metal-universe",
    );
    expect(
      strays.map((e) => `${e.sport}/${e.year} ${e.setName}`),
      "fleer-metal-universe is an era-misnomer twin of the ruled key metal-universe",
    ).toEqual([]);
  });

  it("keys every 1997-98 Metal Universe basketball page to metal-universe", () => {
    const mu = entries.filter(
      (e) =>
        e.lane === "sportscardchecklist" &&
        e.sport === "basketball" &&
        Number(e.year) === 1997 &&
        /metal universe/i.test(e.setName),
    );
    // The base page plus its seven rung/insert pages.
    expect(mu.length).toBeGreaterThanOrEqual(8);
    for (const e of mu) expect(e.setKey, e.setName).toBe("metal-universe");
  });

  it("keeps the source's own spelling as derivedSetKey, so the rename stays auditable", () => {
    const base = entries.find((e) => e.id.includes("set-30163"));
    expect(base, "the 1997-98 Metal Universe basketball base page").toBeTruthy();
    expect(base!.setKey).toBe("metal-universe");
    expect(base!.derivedSetKey).toMatch(/fleer-metal-universe/);
  });

  it("pins that the ruled key is a fixed point AND that a fixed point is not the test", () => {
    expect(normalizeSetKey("metal-universe")).toBe("metal-universe");
    // The two twins are fixed points too -- which is exactly why a fixed-point
    // guard cannot catch this and this file asserts the ruling directly.
    expect(normalizeSetKey("fleer-metal-universe")).toBe("fleer-metal-universe");
    expect(normalizeSetKey("skybox-metal-universe")).toBe("skybox-metal-universe");
    // And the set NAME derives the WRONG key, so the derivation cannot self-correct.
    expect(normalizeSetKey("1997-98 Fleer Metal Universe Basketball", "basketball")).toBe(
      "fleer-metal-universe",
    );
  });
});
