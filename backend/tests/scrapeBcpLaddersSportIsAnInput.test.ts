/**
 * CF-THE-SPORT-IS-AN-INPUT-NOT-A-CONSTANT (2026-08-31).
 *
 * scrape-bcp-ladders wrote the literal "baseball" into the two places the
 * sport actually reaches disk:
 *
 *   const productKey = (sk) => `${year}-${sk}-baseball`;   // the FILE identity
 *   { year, sport: "baseball", setKey: sc.setKey, ... }    // the manifest
 *
 * The site is baseballcardpedia, so that held as long as every page fetched
 * was a baseball page. But `--titles` (and the runner's BCP_TITLES) takes
 * ARBITRARY page titles, and the wiki carries football and basketball sets.
 * A run dispatched at one of those minted football cards under a baseball
 * product key, with a manifest that asserted baseball. The sport was not
 * wrong in some advisory field -- it was wrong in the IDENTITY, which is the
 * one thing no downstream consumer can second-guess.
 *
 * These tests drive the COMMITTED emission path -- the exported `main`, with
 * fetch stubbed and a real fixture -- rather than re-implementing it, so what
 * is pinned is what a dispatch actually writes. A football title must carry
 * sport=football all the way to the CSV filename and the manifest, and the
 * baseball default must be unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const L = require("../scripts/scrape-bcp-ladders.cjs");

const FIXTURE = fs.readFileSync(
  path.resolve(__dirname, "fixtures/bcp/2020-bowman.trimmed.html"),
  "utf8",
);

let outDir: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcp-sport-"));
  // Every page request answers with the same real fixture: this test is about
  // the sport that travels with the run, not about the parse.
  globalThis.fetch = (async () =>
    new Response(FIXTURE, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(outDir, { recursive: true, force: true });
});

/** The staged artefacts of one run, by kind. */
function staged(dir: string) {
  const files = fs.readdirSync(dir);
  return {
    csv: files.filter((f) => f.endsWith(".csv")),
    manifests: files
      .filter((f) => f.endsWith(".manifest.json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))),
  };
}

describe("the sport is threaded from the run inputs to every emission site", () => {
  it("a football title carries sport=football into BOTH the file identity and the manifest", async () => {
    await L.main({
      outDir,
      titles: "2020_Panini_Prizm_Football",
      titlesOnly: "1",
      sport: "football",
      years: "2020-2020",
      delayMs: 0,
    });

    const { csv, manifests } = staged(outDir);
    expect(csv.length).toBeGreaterThan(0);
    expect(manifests.length).toBeGreaterThan(0);

    // The file identity -- `${year}-${setKey}-${sport}`.
    for (const name of csv) {
      expect(name).toMatch(/-football[.-]/);
      expect(name).not.toMatch(/-baseball[.-]/);
    }
    // The manifest's own assertion about what these rows are.
    for (const m of manifests) {
      expect(m.sport).toBe("football");
    }
  });

  it("the default is still baseball, stated rather than assumed", async () => {
    await L.main({
      outDir,
      titles: "2020_Bowman",
      titlesOnly: "1",
      years: "2020-2020",
      delayMs: 0,
    });

    const { csv, manifests } = staged(outDir);
    expect(csv.length).toBeGreaterThan(0);
    for (const m of manifests) expect(m.sport).toBe("baseball");
    for (const name of csv) expect(name).toMatch(/-baseball[.-]/);
  });

  it("MUTATION CHECK: a hardcoded sport would fail the football case", async () => {
    // If either emission site went back to the literal "baseball", the run
    // above would stage baseball-keyed files. Prove the assertion above is
    // load-bearing by checking the two spellings cannot both be satisfied:
    // one run, one sport, and it is the one that was passed in.
    await L.main({
      outDir,
      titles: "2020_Panini_Prizm_Football",
      titlesOnly: "1",
      sport: "basketball",
      years: "2020-2020",
      delayMs: 0,
    });
    const { csv, manifests } = staged(outDir);
    expect(manifests.every((m: { sport: string }) => m.sport === "basketball")).toBe(true);
    expect(csv.every((n: string) => n.includes("-basketball"))).toBe(true);
    expect(csv.some((n: string) => n.includes("-baseball"))).toBe(false);
  });
});

describe("normalizeSport", () => {
  it("folds spelling without inventing a sport", () => {
    expect(L.normalizeSport("Football")).toBe("football");
    expect(L.normalizeSport("  BASKETBALL  ")).toBe("basketball");
    expect(L.normalizeSport("non-sport")).toBe("non-sport");
  });

  it("an absent sport is not silently some other sport", () => {
    // Blank means unknown, and the caller's default (baseball, the site's own
    // sport) applies -- but normalizeSport itself never guesses.
    expect(L.normalizeSport("")).toBe("");
    expect(L.normalizeSport(null)).toBe("");
  });
});
