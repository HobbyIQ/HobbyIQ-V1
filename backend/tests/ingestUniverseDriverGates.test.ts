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
const { gateStagedCsv, ladderIsAttested, splitCsv, isPersonName, LANE_ALIASES } = require_(script);

const HEADER = "category,cardNumber,parallel,isAuto,printRun,player";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uni-gate-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

let n = 0;
/**
 * Stage a CSV. `attested` writes the sidecar manifest every real converter
 * writes beside its file -- `parallelColumnAuthoritative: true`, the flag that
 * says "this parallel column is the checklist's own ladder". 101 of the 102
 * staged CSVs in this repo carry it (the one that does not is a single-rung
 * TCDB file), so ATTESTED is the ordinary case and a bare CSV is the unusual
 * one: a file nothing vouches for.
 */
function stage(lines: string[], attested = true): string {
  const p = path.join(tmp, `f${n++}.csv`);
  fs.writeFileSync(p, lines.join("\n") + "\n");
  if (attested) {
    fs.writeFileSync(p.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify({ sourceUrl: `https://example.invalid/${path.basename(p)}`, parallelColumnAuthoritative: true }));
  }
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

  /** The 11.49M-row exploded spine's signature at 60x6: every card paired with
   *  every rung, no card missing one. Size is NOT what makes it a cross-join. */
  function crossJoinCsv(): string[] {
    const rows = [HEADER];
    for (let i = 1; i <= 60; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    const rungs = ["Gold", "Silver", "Bronze", "Ruby", "Emerald", "Sapphire Finish"];
    for (let i = 1; i <= 60; i++) for (const g of rungs) rows.push(`base,${i},${g} Refractor,false,/99,Player ${i} Name`);
    return rows;
  }

  it("REFUSES cross-join arithmetic — rows ≈ cards × rungs in one category", () => {
    // Unattested: nothing vouches for this parallel column, so a perfectly
    // dense product is the graveyard shape and is refused ON ITS SHAPE ALONE.
    // #1694 bolted `rungCount > 60 && nums > 200` onto this rule to admit real
    // Panini ladders, which left the guard unpinned at exactly this size — 60x6
    // sailed straight through. The floor is provenance now, not magnitude.
    const r = gateStagedCsv(stage(crossJoinCsv(), false));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cartesian product, not a ladder/i);
  });

  it("REFUSES a SMALL dense cross-join — the guard is not gated on size", () => {
    // The mutation #1694 introduced, isolated: any rule still carrying
    // `rungCount > 60` or `nums > 200` passes this file, because it is 20x3.
    const rows = [HEADER];
    for (let i = 1; i <= 20; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    for (let i = 1; i <= 20; i++) for (const g of ["Gold", "Silver", "Bronze"]) {
      rows.push(`base,${i},${g} Refractor,false,/99,Player ${i} Name`);
    }
    const r = gateStagedCsv(stage(rows, false));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cartesian product, not a ladder/i);
  });

  it("ACCEPTS a checklist-backed FULL ladder — density is what a real ladder does", () => {
    // A 132-card set x Tiffany, and a wide multi-rung base ladder: both are
    // perfectly dense BY DEFINITION, because a complete ladder has no holes.
    // parallelColumnAuthoritative says the column was read off a published
    // checklist, and that — not size — is what separates these from the file
    // above. 342 of the 343 perfectly dense category groups among this repo's
    // 102 staged CSVs carry that flag.
    const tiffany = [HEADER];
    for (let i = 1; i <= 132; i++) tiffany.push(`base,${i},,false,,Player ${i} Name`);
    for (let i = 1; i <= 132; i++) tiffany.push(`base,${i},Tiffany,false,,Player ${i} Name`);
    expect(gateStagedCsv(stage(tiffany)).ok).toBe(true);

    // The shape #1694 was right to admit: 2012/13 Prizm's 300 cards x 4 rungs.
    const prizm = [HEADER];
    for (let i = 1; i <= 300; i++) prizm.push(`base,${i},,false,,Player ${i} Name`);
    for (let i = 1; i <= 300; i++) for (const g of ["Prizms", "Prizms Green", "Prizms Gold", "Prizms Blue"]) {
      prizm.push(`base,${i},${g},false,,Player ${i} Name`);
    }
    const r = gateStagedCsv(stage(prizm));
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("the SAME dense ladder flips on attestation alone", () => {
    // The rule's whole content, isolated: identical bytes, opposite verdicts,
    // decided only by whether a manifest vouches for the parallel column.
    const rows = crossJoinCsv();
    expect(gateStagedCsv(stage(rows, false)).ok).toBe(false);
    expect(gateStagedCsv(stage(rows, true)).ok).toBe(true);
  });

  it("attestation buys DENSITY, never unlimited width", () => {
    // An attested file is still bound by EXPLODED_PAR_MAX: the flag says the
    // column is a real ladder, not that any number of rungs is plausible.
    const rows = [HEADER];
    for (let i = 1; i <= 30; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    const shades = ["Gold", "Silver", "Bronze", "Ruby", "Emerald", "Onyx", "Ivory", "Cobalt", "Amber", "Jade"];
    const greek = ["Alpha","Beta","Gamma","Delta","Epsilon","Zeta","Eta","Theta","Iota","Kappa","Lambda","Mu","Nu","Xi","Omicron","Pi","Rho","Sigma","Tau","Upsilon"];
    for (let q = 0; q < 200; q++) rows.push(`base,1,${shades[q % 10]} ${greek[Math.floor(q / 10)]} Refractor,false,,Player 1 Name`);
    const r = gateStagedCsv(stage(rows, true));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/distinct parallels/i);
  });

  it("a handful of cards against a handful of rungs is noise, not a spine", () => {
    // 3 cards x 2 rungs is dense, but density over six rows means nothing —
    // the 11.49M-row signature needs enough cards to BE a signature. Pinned so
    // the floor cannot be quietly lowered into refusing tiny legitimate files.
    const rows = [HEADER];
    for (let i = 1; i <= 3; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    for (let i = 1; i <= 3; i++) for (const g of ["Gold", "Silver"]) {
      rows.push(`base,${i},${g} Refractor,false,,Player ${i} Name`);
    }
    expect(gateStagedCsv(stage(rows, false)).ok).toBe(true);
  });

  it("ladderIsAttested reads the sidecar and defaults to UNATTESTED", () => {
    // Pinned directly, because a helper stuck at `true` disables the whole
    // cross-join rule while every shape test still passes on the attested path.
    const withManifest = stage(cleanCsv(), true);
    const without = stage(cleanCsv(), false);
    expect(ladderIsAttested(withManifest)).toBe(true);
    expect(ladderIsAttested(without)).toBe(false);
    // A malformed sidecar is not an attestation, and must not throw.
    const bad = stage(cleanCsv(), false);
    fs.writeFileSync(bad.replace(/\.csv$/, ".manifest.json"), "{not json");
    expect(ladderIsAttested(bad)).toBe(false);
    // Present but not claiming the flag is also unattested.
    const noFlag = stage(cleanCsv(), false);
    fs.writeFileSync(noFlag.replace(/\.csv$/, ".manifest.json"), JSON.stringify({ sourceUrl: "x" }));
    expect(ladderIsAttested(noFlag)).toBe(false);
  });

  it("a RAGGED unattested ladder passes — only a gapless product is refused", () => {
    // The other side of the density test: real scraped ladders have holes
    // (short prints, rookie-only rungs), and holes are what say "not a
    // cross-join". Loosening the 0.995 density floor would refuse this file.
    const rows = [HEADER];
    for (let i = 1; i <= 60; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    const rungs = ["Gold", "Silver", "Bronze", "Ruby", "Emerald", "Sapphire Finish"];
    for (let i = 1; i <= 60; i++) {
      // Every third card is missing two of its six rungs — ~89% dense.
      for (const g of (i % 3 === 0 ? rungs.slice(0, 4) : rungs)) {
        rows.push(`base,${i},${g} Refractor,false,/99,Player ${i} Name`);
      }
    }
    const r = gateStagedCsv(stage(rows, false));
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("a single-rung set is dense by definition and never a cross-join", () => {
    // The one unattested dense group among this repo's staged CSVs is a
    // 50-card x 1-rung TCDB file. One rung carries no cross-join information.
    const rows = [HEADER];
    for (let i = 1; i <= 50; i++) rows.push(`base,${i},,false,,Player ${i} Name`);
    for (let i = 1; i <= 50; i++) rows.push(`base,${i},Refractor,false,,Player ${i} Name`);
    expect(gateStagedCsv(stage(rows, false)).ok).toBe(true);
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
