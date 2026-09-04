import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(backend, "scripts", "ingest-universe-driver.cjs");
const require_ = createRequire(import.meta.url);
const { gateStagedCsv, splitCsv, isPersonName, LANE_ALIASES } = require_(script);

const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-gate-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

let n = 0;
function stage(lines: string[]): string {
  const p = path.join(tmp, `f${n++}.csv`);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

/** A clean, ordinary checklist: base cards plus a small ladder with print runs. */
function cleanCsv(): string[] {
  const rows = [HEADER];
  for (let i = 1; i <= 50; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
  for (let i = 1; i <= 50; i++) {
    rows.push(`base,${i},Gold Refractor,false,/50,Player ${i} Name`);
    rows.push(`base,${i},Orange Refractor,false,/25,Player ${i} Name`);
  }
  return rows;
}

describe("ingest-universe-driver — the per-entry cleanliness gate", () => {
  it("passes a well-formed checklist and counts its ladder and print runs", () => {
    const r = gateStagedCsv(stage(cleanCsv()));
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.stats.base).toBe(50);
    expect(r.stats.ladder).toBe(100);
    expect(r.stats.withPrintRun).toBe(100);
  });

  it("REFUSES a file whose header is not the ONE canonical CSV", () => {
    // A different column order silently mis-columns every downstream read.
    const r = gateStagedCsv(stage(["cardNumber,player,parallel", "1,Some Player,Gold"]));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/canonical CSV header/i);
  });

  it("REFUSES zero base cards — a ladder with nothing to attach to", () => {
    const rows = [HEADER];
    for (let i = 1; i <= 40; i++) rows.push(`base,${i},Gold Refractor,false,/50,Player ${i} Name`);
    const r = gateStagedCsv(stage(rows));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/zero base cards/i);
  });

  it("REFUSES players-as-parallels leakage — a roster line read as a rung", () => {
    const rows = cleanCsv();
    // "Player 7 Name" is a player IN THIS FILE, so it can never be a rung.
    rows.push("base,900,Player 7 Name,false,,Player 900 Name");
    const r = gateStagedCsv(stage(rows));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parallel is a player name/i);
  });

  it("REFUSES a card line in the parallel column", () => {
    const rows = cleanCsv();
    rows.push("base,901,27 Mike Trout,false,,Somebody Else");
    const r = gateStagedCsv(stage(rows));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/card line/i);
  });

  it("REFUSES cross-join arithmetic — rows ≈ cards × rungs in one category", () => {
    // The 11.49M-row exploded spine's signature: every card paired with every rung.
    const rows = [HEADER];
    for (let i = 1; i <= 60; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    const rungs = ["Gold", "Silver", "Bronze", "Ruby", "Emerald", "Sapphire Finish"];
    for (let i = 1; i <= 60; i++) for (const g of rungs) rows.push(`base,${i},${g} Refractor,false,/99,Player ${i} Name`);
    const r = gateStagedCsv(stage(rows));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cross-join/i);
  });

  it("REFUSES a category carrying more rungs than any real checklist has", () => {
    const rows = [HEADER];
    for (let i = 1; i <= 30; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    // Rung names must not themselves look like a card line ("<number> <name>"),
    // or the card-line rule fires first and this asserts the wrong gate.
    const shades = ["Gold", "Silver", "Bronze", "Ruby", "Emerald", "Onyx", "Ivory", "Cobalt", "Amber", "Jade"];
    for (let p = 0; p < 200; p++) rows.push(`base,1,${shades[p % 10]} ${["Alpha","Beta","Gamma","Delta","Epsilon","Zeta","Eta","Theta","Iota","Kappa","Lambda","Mu","Nu","Xi","Omicron","Pi","Rho","Sigma","Tau","Upsilon"][Math.floor(p / 10)]} Refractor,false,,Player 1 Name`);
    const r = gateStagedCsv(stage(rows));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/distinct parallels|cross-join/i);
  });

  it("REFUSES an empty staged file rather than reporting a clean zero", () => {
    expect(gateStagedCsv(stage([HEADER])).ok).toBe(false);
    expect(gateStagedCsv(stage([HEADER])).reason).toMatch(/0 data rows/i);
  });

  it("REFUSES an unreadable path instead of throwing", () => {
    const r = gateStagedCsv(path.join(tmp, "does-not-exist.csv"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unreadable/i);
  });

  it("a blank parallel is UNKNOWN, never invented as 'Base'", () => {
    // The gate must not read a blank as a rung named Base, and must not refuse
    // the row for being blank -- blank means unknown.
    const r = gateStagedCsv(stage(cleanCsv()));
    expect(r.ok).toBe(true);
    expect(r.stats.base).toBe(50);
  });

  it("keeps a comma-bearing player name in one column", () => {
    // "Griffey Jr., Ken" must not shift the columns a gate reads.
    expect(splitCsv('base,1,"Griffey Jr., Ken",false,,Ken Griffey Jr')[2]).toBe("Griffey Jr., Ken");
  });

  it("does not mistake a rung for a person name", () => {
    expect(isPersonName("Mike Trout")).toBe(true);
    expect(isPersonName("Gold Refractor")).toBe(false);
    expect(isPersonName("Sapphire")).toBe(false);
  });
});

describe("ingest-universe-driver — scope refusals come before any require", () => {
  const runIt = (env: Record<string, string>) => {
    try {
      const out = execFileSync(process.execPath, [script], {
        cwd: backend,
        // The env is REPLACED, never spread: an ambient SOURCES from the shell
        // would hand the script the very scope this asserts it does not have.
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status as number, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  };

  it("REFUSES with no SOURCES — a lane is required and has no default", () => {
    const r = runIt({ COSMOS_CONNECTION_STRING: "dummy" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/SOURCES is required/i);
  });

  it("REFUSES more than one lane per dispatch", () => {
    const r = runIt({ COSMOS_CONNECTION_STRING: "dummy", SOURCES: "bcp,beckett" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/one lane per dispatch/i);
  });

  it("REFUSES tcdb by name, saying why rather than reading as a typo", () => {
    const r = runIt({ COSMOS_CONNECTION_STRING: "dummy", SOURCES: "tcdb" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/no enumerable universe/i);
  });

  it("REFUSES an unknown lane", () => {
    const r = runIt({ COSMOS_CONNECTION_STRING: "dummy", SOURCES: "nonsense" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unknown lane/i);
  });

  it("REFUSES a missing COSMOS_CONNECTION_STRING before touching the network", () => {
    const r = runIt({ SOURCES: "bcp" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/COSMOS_CONNECTION_STRING/i);
  });

  it("maps the operator's lane word onto the manifest's", () => {
    // The runner input has always said `insider`; the manifest says
    // `checklistinsider`. The alias is written down, not left to a dispatch.
    expect(LANE_ALIASES.insider).toBe("checklistinsider");
    expect(LANE_ALIASES.bcp).toBe("bcp");
  });
});

describe("ingest-universe-driver — the setKey the verify reads by", () => {
  // Each of these was a live defect the dry run caught: a wrong key counts 0
  // rows and records a CLEAN ingest as `failed`, which closes nothing and
  // reports a gap that is not there.
  const { setKeyFor } = require_(script);

  it("drops the sport suffix — the catalog keys 1952 Topps as `topps`", () => {
    // Measured: `topps-baseball` counted 0 against the 6,115 rows really there.
    expect(setKeyFor({ setName: "1952 Topps Baseball", year: 1952, lane: "hobbymonitor" })).toBe("topps");
  });

  it("drops the leading year, including a season span", () => {
    expect(setKeyFor({ setName: "2023-24 Upper Deck Hockey", year: 2024, lane: "clc" })).toBe("upper-deck");
  });

  it("drops a trailing 'card checklist' the CLC page titles carry", () => {
    expect(setKeyFor({ setName: "2018 Bowman Baseball Card Checklist", year: 2018, lane: "clc" })).toBe("bowman");
  });

  it("keeps sapphire and other channel-qualified names DISTINCT", () => {
    // A different product, not a shade of the flagship. Collapsing it would
    // merge two pools and price both wrong.
    expect(setKeyFor({ setName: "2026 Topps Chrome Sapphire Baseball", year: 2026, lane: "beckett" })).toBe("topps-chrome-sapphire");
    expect(setKeyFor({ setName: "2026 Topps Chrome Baseball", year: 2026, lane: "beckett" })).toBe("topps-chrome");
  });

  it("keys a Japanese pokemon set by its SET ID, not its unslugifiable name", () => {
    // "PMCG1 拡張パック" slugifies to nothing, so a name-derived key left every
    // tcgdexja entry unverifiable and would have failed a clean ingest.
    expect(setKeyFor({ setName: "PMCG1 拡張パック", sourceRef: "https://api.tcgdex.net/v2/ja/sets/PMCG1", lane: "tcgdexja" })).toBe("pmcg1");
  });

  it("returns null rather than guessing when nothing is derivable", () => {
    expect(setKeyFor({ setName: "", year: 2020, lane: "bcp" })).toBeNull();
  });
});

describe("ingest-universe-driver — the manifest is the durable universe", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(backend, "data", "ingest-universe.json"), "utf8"));

  it("carries every enumerated entry with a unique id and a resolvable sourceRef", () => {
    // D37 enumerated 7,755 across six lanes; the 2026-09-04 sitemap survey added
    // 5,850 sportscardchecklist entries for the seven vintage football/basketball/
    // hockey cells (plus the hockey/topps bonus cell). Both halves are pinned, so
    // a lane that silently loses its entries is still caught.
    const scc = manifest.entries.filter((e: any) => e.lane === "sportscardchecklist");
    expect(scc.length).toBe(5850);
    expect(manifest.entries.length - scc.length).toBe(7755);
    expect(manifest.entries.length).toBe(13605);
    const ids = new Set(manifest.entries.map((e: any) => e.id));
    expect(ids.size).toBe(manifest.entries.length);
    expect(manifest.entries.every((e: any) => typeof e.sourceRef === "string" && /^https?:\/\//.test(e.sourceRef))).toBe(true);
  });

  it("names only lanes the driver has machinery for", () => {
    const lanes = new Set(manifest.entries.map((e: any) => e.lane));
    for (const l of lanes) expect(Object.values(LANE_ALIASES)).toContain(l);
    // tcdb is refused by the driver, so it must not appear as an entry.
    expect(lanes.has("tcdb")).toBe(false);
  });

  it("keeps the enumeration's read as `seededStatus`, never as an authoritative `status`", () => {
    // The live verdict is the Cosmos control doc's. A field named `status` here
    // would read as authoritative and it is not.
    expect(manifest.entries.every((e: any) => e.status === undefined)).toBe(true);
    expect(manifest.entries.every((e: any) => typeof e.seededStatus === "string")).toBe(true);
  });
});
