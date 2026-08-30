/**
 * THE contentHash HAZARD -- a retracted rule still living in the dedup key.
 *
 * `computeContentHash` (portfolioiq/soldCompsStore.service.ts:566) and its
 * mirror in relocate-sold-comp.cjs:44 both strip a trailing " Refractor". The
 * comment says, in as many words, "Colour = Colour Refractor is one card".
 * D31 RETRACTED that rule on 2026-08-30.
 *
 * contentHash is scoped to cardId, so the collision only bites when a fold
 * lands a `Gold` sale and a `Gold Refractor` sale in the SAME partition at the
 * same price, date and grade -- which is precisely what MODE=colour creates.
 * A colliding hash lets the pool's dedup eat a REAL SALE.
 *
 * So the dry run COUNTS the would-be collisions and APPLY REFUSES while any are
 * outstanding. Reported before applied, per the D30 plan.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(backend, "scripts", "consolidate-catalog-duplicates.cjs"), "utf8");
const require_ = createRequire(import.meta.url);
const { contentHashOf } = require_(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs")) as {
  contentHashOf: (row: Record<string, unknown>) => string;
};

describe("the hazard is real, not hypothetical", () => {
  it("the retracted ' Refractor' strip STILL lives in the hash", () => {
    // If this ever fails, the hash was fixed and the guard below can be
    // reconsidered -- but never removed silently.
    const mirror = fs.readFileSync(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"), "utf8");
    expect(mirror).toMatch(/replace\(\/ refractors\?\$\/, ""\)/);
  });

  it("a Gold sale and a Gold Refractor sale COLLIDE once they share a partition", () => {
    const common = {
      cardId: "hiq:baseball:2025:topps-chrome:79:gold:no-auto",
      isAuto: false,
      gradeCompany: "PSA",
      gradeValue: 10,
      price: 123.45,
      soldAt: "2026-08-01T00:00:00.000Z",
    };
    const bare = contentHashOf({ ...common, parallel: "Gold" });
    const long = contentHashOf({ ...common, parallel: "Gold Refractor" });
    expect(bare).toBe(long); // the collision the fold would create
  });

  it("two genuinely different sales do NOT collide", () => {
    const common = {
      cardId: "hiq:baseball:2025:topps-chrome:79:gold:no-auto",
      isAuto: false,
      gradeCompany: "PSA",
      gradeValue: 10,
      soldAt: "2026-08-01T00:00:00.000Z",
    };
    expect(contentHashOf({ ...common, parallel: "Gold", price: 100 })).not.toBe(
      contentHashOf({ ...common, parallel: "Gold", price: 200 }),
    );
  });
});

describe("the fleet counts the risk and refuses to APPLY through it", () => {
  it("probes each sale's would-be hash in the WINNER's partition", () => {
    expect(source).toMatch(/const probe = contentHashOf\(\{ \.\.\.row, cardId: winnerId \}\)/);
    expect(source).toMatch(/if \(seenHash\.has\(probe\)\) stats\.hashCollisionRisk\+\+/);
  });

  it("reports the count in the dry run", () => {
    expect(source).toMatch(/contentHash COLLISION RISK/);
  });

  it("APPLY exits non-zero while any collision is outstanding", () => {
    const guard = source.slice(source.indexOf("if (APPLY && stats.hashCollisionRisk > 0)"));
    expect(guard.slice(0, 600)).toMatch(/process\.exit\(2\)/);
    expect(guard.slice(0, 600)).toMatch(/D31 retracted that rule/);
  });

  it("the refusal sits BEFORE the write reconciliation, so a blocked run never reports writes", () => {
    const guard = source.indexOf("if (APPLY && stats.hashCollisionRisk > 0)");
    const rw = source.indexOf("reportWrites({");
    expect(guard).toBeGreaterThan(-1);
    expect(rw).toBeGreaterThan(guard);
  });
});
