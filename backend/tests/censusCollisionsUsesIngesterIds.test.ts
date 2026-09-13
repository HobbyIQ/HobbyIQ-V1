import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, afterAll } from "vitest";

/**
 * CF-ONE-DERIVATION-OR-TWO-CENSUSES (2026-09-13).
 *
 * THE DEFECT. census-catalog-id-collisions.cjs computed a row's address with
 * the bare product key for every row -- category, cell-wide insert-set
 * separation and colour-rung folding all discarded, the PRE-#2112 shape the
 * ingest no longer runs. Measured on the staged acq-2026-09-13-bcp
 * directory, cell (baseball, 2018, diamond-kings): the old derivation
 * reported 363 ids "contested inside the CSV" for a file
 * (2018-diamond-kings-baseball.csv) the ingest's OWN guard already refuses
 * today, for a different, real reason (`unregistered-set-keys` -- the
 * same-numbered DK Signatures / DK Rookie Signatures autograph sets ARE
 * correctly separated onto their own keys; those keys are simply not yet
 * registered normalizeSetKey fixed points). A census computing its own
 * approximation of the id cannot tell "the ingest silently clobbers this"
 * from "the ingest already correctly refuses this for an unrelated reason".
 *
 * THE FIX. The census no longer derives ids on its own. It calls
 * `ingest-checklist-csv-to-catalog.cjs`'s own `planStagedDirectory` -- the
 * read-only planning half of the write path's per-file loop, exported for
 * exactly this reuse -- and `insert-set-key.cjs`'s `finalIdFor`, the SAME
 * composition `planFile` measures collisions with and the write path stamps
 * from. This file pins that the census's per-row ids for a fixture equal the
 * ingester's own plan ids, using the REAL, committed modules -- never a copy
 * of them -- so a future edit to either cannot drift from the other without
 * failing here.
 */

const require_ = createRequire(import.meta.url);
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const ingestPath = path.join(scriptsDir, "ingest-checklist-csv-to-catalog.cjs");
const insertSetKeyPath = path.join(scriptsDir, "lib", "insert-set-key.cjs");
const backend = path.resolve(scriptsDir, "..");
const hobbyIqCardIdPath = path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");

const { planStagedDirectory } = require_(ingestPath) as {
  planStagedDirectory: (dir: string, files: string[]) => Map<string, { product: any; batch: any[]; plan: any }>;
};
const INSERT_SET = require_(insertSetKeyPath) as {
  finalIdFor: (ctx: { productSetKey: string; separate: Set<string>; foldRungs: unknown }, computeId: (r: any) => string) => (r: any) => string;
};
const { computeHobbyIqCardId } = require_(hobbyIqCardIdPath) as {
  computeHobbyIqCardId: (c: any) => string;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "census-ids-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function stage(name: string, csv: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmp, `${name}.csv`), csv);
  fs.writeFileSync(path.join(tmp, `${name}.manifest.json`), JSON.stringify(manifest));
}

/** The census's own claim-building loop, factored out so a fixture can drive
 *  it directly without a live Cosmos read -- the CSV-side half is exactly
 *  what census-catalog-id-collisions.cjs's main() runs after its query. */
function censusClaims(dir: string, sport: string, year: number, setKey: string) {
  const allFiles = fs.readdirSync(dir).filter((n) => n.endsWith(".csv")).sort();
  const plans = planStagedDirectory(dir, allFiles);
  const claims = new Map<string, any[]>();
  const refused: { name: string; reason: string }[] = [];
  for (const [name, entry] of plans) {
    const { product, batch, plan } = entry;
    if (!product) continue;
    if (product.sport !== sport || Number(product.year) !== year || product.setKey !== setKey) continue;
    if (!plan || plan.verdict === "refuse") {
      refused.push({ name, reason: plan ? plan.reason : "exploded-empty" });
      continue;
    }
    const finalId = INSERT_SET.finalIdFor(
      { productSetKey: product.setKey, separate: plan.separate, foldRungs: plan.foldRungs },
      (r: any) => computeHobbyIqCardId({
        sport: product.sport, year: product.year, setKey: r.setKey,
        cardNumber: String(r.cardNumber), parallel: r.parallel || "Base",
        isAuto: r.isAuto === "true", printRun: r.printRun ? Number(r.printRun) : null,
        authoritativeSetKey: true,
      }),
    );
    for (const r of batch) {
      let id: string | null = null;
      try { id = finalId(r); } catch { id = null; }
      if (!id) continue;
      if (!claims.has(id)) claims.set(id, []);
      claims.get(id)!.push(r);
    }
  }
  return { claims, refused };
}

describe("the census's per-row ids equal the ingester's plan ids", () => {
  const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";

  it("a same-numbered insert set that IS registered is 0 contested in the census, not 1", () => {
    // The World Cup shape in miniature, using a key #2106 already registered
    // as a normalizeSetKey fixed point on main: base #1 and the Rookie
    // Signatures insert's #1 clash on the product key, but the insert's
    // derived key resolves to itself (not a fold), so planFile SEPARATES
    // them and every row gets its own id -- the census must see PASS here,
    // not the "refuse" a not-yet-registered key would produce.
    const csv = [
      HEADER,
      "base,1,,false,,A Player",
      "auto-rookies-signatures,1,,false,,B Player",
    ].join("\n");
    stage("2020-panini-rookies-and-stars-baseball", csv, {
      sport: "baseball", year: 2020, setKey: "panini-rookies-and-stars", setName: "test",
    });

    const allFiles = fs.readdirSync(tmp).filter((n) => n.endsWith(".csv"));
    const plans = planStagedDirectory(tmp, allFiles);
    const entry = [...plans.values()].find((e) => e.product && e.product.setKey === "panini-rookies-and-stars");
    expect(entry).toBeTruthy();
    expect(entry!.plan.verdict).toBe("pass");
    expect(entry!.plan.ids).toBe(2);
    // Confirms this fixture actually exercises insert-set separation rather
    // than passing for an unrelated reason (e.g. isAuto alone distinguishing
    // the rows) -- the Rookie Signatures insert really did take its own key.
    expect(entry!.plan.keys.map((k: any) => k.setKey)).toEqual(["panini-rookies-and-stars-rookies-signatures"]);

    const { claims, refused } = censusClaims(tmp, "baseball", 2020, "panini-rookies-and-stars");
    // The point under test: the census's claim ids are the ingester's OWN
    // `finalIdFor` ids for this exact plan, not a flat product-key
    // approximation that would have collapsed both rows onto one id.
    expect(refused).toHaveLength(0);
    expect(claims.size).toBe(entry!.plan.ids);
    for (const group of claims.values()) expect(group).toHaveLength(1);
  });

  it("a file the ingest REFUSES contributes NO claims, and is named instead of miscounted", () => {
    // The real 1989 Pro Set shape: #47 printed twice with an identical blank
    // parallel is a genuine collision no set key can fix, so planFile
    // refuses with reason "id-collisions". The OLD census derivation would
    // have silently computed one id for both rows and called it "agrees" or
    // "contested" depending on which name landed on it; the fixed census
    // must instead report zero claims for this file and name the refusal.
    const csv = [
      HEADER,
      "base,46,,false,,Neal Anderson",
      "base,47,,false,,William Perry",
      "base,47,,false,,Ron Morris",
      "base,48,,false,,Brad Muster",
    ].join("\n");
    fs.mkdirSync(path.join(tmp, "proset"));
    fs.writeFileSync(path.join(tmp, "proset", "1989-pro-set-football.csv"), csv);
    fs.writeFileSync(path.join(tmp, "proset", "1989-pro-set-football.manifest.json"), JSON.stringify({
      sport: "football", year: 1989, setKey: "pro-set", setName: "1989 Pro Set Football",
    }));

    const { claims, refused } = censusClaims(path.join(tmp, "proset"), "football", 1989, "pro-set");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toEqual({ name: "1989-pro-set-football.csv", reason: "id-collisions" });
    // NOTHING from a refused file rides in claims -- there is no address to
    // report a row as agreeing OR contesting at.
    expect(claims.size).toBe(0);
  });

  it("a clean file with no clash reports every row's real id, matching planFile exactly", () => {
    const csv = [
      HEADER,
      "base,1,,false,,A Player",
      "base,2,,false,,B Player",
      "base,3,,false,,C Player",
    ].join("\n");
    fs.mkdirSync(path.join(tmp, "clean"));
    fs.writeFileSync(path.join(tmp, "clean", "2020-test-baseball.csv"), csv);
    fs.writeFileSync(path.join(tmp, "clean", "2020-test-baseball.manifest.json"), JSON.stringify({
      sport: "baseball", year: 2020, setKey: "topps", setName: "2020 Test",
    }));

    const { claims, refused } = censusClaims(path.join(tmp, "clean"), "baseball", 2020, "topps");
    expect(refused).toHaveLength(0);
    expect(claims.size).toBe(3);

    const allFiles = fs.readdirSync(path.join(tmp, "clean")).filter((n) => n.endsWith(".csv"));
    const plans = planStagedDirectory(path.join(tmp, "clean"), allFiles);
    const entry = [...plans.values()][0];
    expect(entry.plan.ids).toBe(3);
    expect([...claims.keys()].sort()).toEqual(
      entry.batch
        .map((r: any) => computeHobbyIqCardId({
          sport: "baseball", year: 2020, setKey: "topps",
          cardNumber: String(r.cardNumber), parallel: r.parallel || "Base",
          isAuto: r.isAuto === "true", printRun: r.printRun ? Number(r.printRun) : null,
          authoritativeSetKey: true,
        }))
        .sort(),
    );
  });
});

describe("the census script no longer derives ids on its own", () => {
  const src = fs.readFileSync(path.join(scriptsDir, "census-catalog-id-collisions.cjs"), "utf8");

  it("calls the ingester's planStagedDirectory, not its own flat product-key derivation", () => {
    expect(src).toMatch(/require\([^)]*"ingest-checklist-csv-to-catalog\.cjs"\)/);
    expect(src).toMatch(/planStagedDirectory\(/);
    // The old comment literally said "the product key for every row, category
    // discarded" -- pinned ABSENT, so a regression back to the flat
    // derivation cannot silently reappear under new wording.
    expect(src).not.toMatch(/category discarded/);
  });

  it("uses finalIdFor -- the exact composition planFile measures collisions with", () => {
    expect(src).toMatch(/INSERT_SET\.finalIdFor\(/);
  });

  it("names a refused file instead of folding its rows into claims", () => {
    expect(src).toMatch(/plan\.verdict === "refuse"/);
    expect(src).toMatch(/files the ingest REFUSES/);
  });
});

describe("the committed scripts are loadable", () => {
  it("node parses both", () => {
    const { execFileSync } = require_("node:child_process") as typeof import("node:child_process");
    expect(() => execFileSync(process.execPath, ["--check", ingestPath], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync(process.execPath, ["--check", path.join(scriptsDir, "census-catalog-id-collisions.cjs")], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync(process.execPath, ["--check", insertSetKeyPath], { stdio: "pipe" })).not.toThrow();
  });
});
