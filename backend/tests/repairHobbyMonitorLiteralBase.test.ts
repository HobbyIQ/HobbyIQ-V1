/**
 * CF-BLANK-MEANS-UNKNOWN-NEVER-BASE, on the rows already stored.
 *
 * #1634 fixed the emitter. This pins the repair that fixes what the emitter
 * already wrote — and, more importantly, pins what it must REFUSE to touch.
 *
 * The write itself is safe by construction (blanking a field whose value is
 * already slug-equivalent to blank), so the whole risk of this script is in
 * its SCOPE. Every test below is about the scope holding: three axes, all
 * required, each one mutation-checked so a guard that stopped guarding fails
 * here rather than in the catalog.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "repair-hobbymonitor-literal-base.cjs");
const RUNNER = path.join(HERE, "..", "..", ".github", "workflows", "backfill-runner.yml");

const mod = require_(SCRIPT);
const { isLiteralBase, inScope, GROUPS, TOTAL_EXPECT, isHobbyMonitorScope } = mod;

/** A row as the query returns it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "x",
  cardId: "x",
  setKey: "panini-prizm",
  cardYear: 2026,
  parallel: "Base",
  source: "hobbymonitor-2026-09-01",
  ...over,
});

describe("the audited scope is the scope", () => {
  it("names exactly the six audited groups, totalling 1,075 rows", () => {
    expect(GROUPS).toEqual([
      { setKey: "panini-prizm", cardYear: 2026, expect: 579 },
      { setKey: "topps-cosmic-chrome", cardYear: 2025, expect: 204 },
      { setKey: "topps-resurgence", cardYear: 2025, expect: 106 },
      { setKey: "panini-turn-four", cardYear: 2026, expect: 100 },
      { setKey: "panini-obsidian", cardYear: 2025, expect: 44 },
      { setKey: "panini-immaculate", cardYear: 2026, expect: 42 },
    ]);
    expect(TOTAL_EXPECT).toBe(1075);
  });

  it("a SEVENTH group refuses, even when everything else about the row fits", () => {
    // The audit is what makes the write safe. A group nobody audited has no
    // such evidence behind it, so it is not this script's to repair.
    expect(inScope(row({ setKey: "topps-chrome", cardYear: 2026 }))).toBe(false);
    expect(inScope(row({ setKey: "panini-mosaic", cardYear: 2025 }))).toBe(false);
  });

  it("the right setKey in the WRONG year refuses", () => {
    // panini-prizm is audited for 2026 only; its 2025 rows were never counted.
    expect(inScope(row({ setKey: "panini-prizm", cardYear: 2026 }))).toBe(true);
    expect(inScope(row({ setKey: "panini-prizm", cardYear: 2025 }))).toBe(false);
    expect(inScope(row({ setKey: "panini-obsidian", cardYear: 2025 }))).toBe(true);
    expect(inScope(row({ setKey: "panini-obsidian", cardYear: 2026 }))).toBe(false);
  });

  it("accepts a string cardYear, because the column is dual-written", () => {
    expect(inScope(row({ cardYear: "2026" }))).toBe(true);
  });
});

describe("only the word we invented is removed", () => {
  it("matches the literal word in any casing or padding", () => {
    for (const v of ["Base", "base", "BASE", " Base ", "\tbase\n"]) {
      expect(isLiteralBase(v), `${JSON.stringify(v)} is the literal word`).toBe(true);
    }
  });

  it("a REAL parallel name refuses — this is the pin that protects the ladder", () => {
    // These are finishes hobbymonitor genuinely stated, on the ladder. Blanking
    // one would destroy a real rung and collapse it onto the base pool.
    for (const v of [
      "Silver Prizm", "Orange Refractor", "SuperFractor", "Base Prizm",
      "Red Ink", "Gold", "Base Refractor", "1st Base", "Basement",
    ]) {
      expect(isLiteralBase(v), `${JSON.stringify(v)} is a real parallel, not our word`).toBe(false);
      expect(inScope(row({ parallel: v }))).toBe(false);
    }
  });

  it("an already-blank row is not in scope — there is nothing to correct", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(isLiteralBase(v)).toBe(false);
      expect(inScope(row({ parallel: v }))).toBe(false);
    }
  });
});

describe("only hobbymonitor rows", () => {
  it("accepts the bare stamp and every dated run of it", () => {
    for (const s of ["hobbymonitor", "hobbymonitor-2026-09-01", "hobbymonitor-scraped-2026-08-18", "HobbyMonitor-2026-09-01"]) {
      expect(inScope(row({ source: s })), `${s} is a hobbymonitor row`).toBe(true);
    }
  });

  it("another publisher's identical-looking row refuses", () => {
    // Every other source mints a base card blank already. A beckett row whose
    // parallel says "Base" is a different defect with different evidence.
    for (const s of ["beckett-scraped-2026-08-26", "tcdb-2026-09-01", "baseballcardpedia", "checklistinsider", ""]) {
      expect(inScope(row({ source: s })), `${s} is not hobbymonitor`).toBe(false);
    }
  });

  it("the source scope flag accepts hobbymonitor and nothing wider", () => {
    expect(isHobbyMonitorScope("hobbymonitor")).toBe(true);
    expect(isHobbyMonitorScope(" HobbyMonitor ")).toBe(true);
    for (const s of ["", "all", "*", "beckett", "hobbymonitor-2026-09-01"]) {
      expect(isHobbyMonitorScope(s), `${JSON.stringify(s)} must not pass as the scope`).toBe(false);
    }
  });
});

// ── mutation checks ─────────────────────────────────────────────────────
//
// A guard nobody can break is a guard nobody has tested. Each mutation below
// removes exactly one axis from the source, re-evaluates the file as its own
// module, and asserts the assertions above would then FAIL — proving they pin
// the guard rather than merely agreeing with it.
function evaluate(src: string) {
  const Module = require_("node:module");
  const m = new Module.Module(`${SCRIPT}.mutant`, undefined);
  m.filename = `${SCRIPT}.mutant`;
  m.paths = (Module.Module as any)._nodeModulePaths(path.dirname(SCRIPT));
  m._compile(src, `${SCRIPT}.mutant`);
  return m.exports as any;
}

describe("the guards are load-bearing, not decorative", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");

  it("dropping the SOURCE axis lets another publisher's rows in", () => {
    const LINE = `  if (!String(row.source ?? "").toLowerCase().startsWith(SOURCE_ROOT)) return false;`;
    expect(SRC).toContain(LINE);
    const mutant = evaluate(SRC.replace(LINE, "  // source guard removed"));
    expect(mutant.inScope(row({ source: "beckett-scraped-2026-08-26" })))
      .toBe(true); // THE DEFECT, reproduced: beckett rows would be blanked.
    // And the real guard rejects exactly that row.
    expect(inScope(row({ source: "beckett-scraped-2026-08-26" }))).toBe(false);
  });

  it("dropping the GROUP axis lets a seventh group in", () => {
    const LINE = "  return GROUPS.some((g) => g.setKey === row.setKey && g.cardYear === Number(row.cardYear));";
    expect(SRC).toContain(LINE);
    const mutant = evaluate(SRC.replace(LINE, "  return true;"));
    expect(mutant.inScope(row({ setKey: "topps-chrome", cardYear: 2026 }))).toBe(true);
    expect(inScope(row({ setKey: "topps-chrome", cardYear: 2026 }))).toBe(false);
  });

  it("loosening the literal-Base test swallows a real parallel", () => {
    const LINE = `  return /^\\s*base\\s*$/i.test(String(parallel ?? ""));`;
    expect(SRC).toContain(LINE);
    // The classic mistake: a substring test instead of an anchored one.
    const mutant = evaluate(SRC.replace(LINE, `  return /base/i.test(String(parallel ?? ""));`));
    expect(mutant.isLiteralBase("Base Refractor")).toBe(true); // a real rung, destroyed
    expect(isLiteralBase("Base Refractor")).toBe(false);
  });
});

describe("the write contract", () => {
  const SRC = fs.readFileSync(SCRIPT, "utf8");

  // Comments are prose, and prose naming a forbidden verb is not a call to it.
  // These assertions are about CODE, so the comments come out first.
  const CODE = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("writes through patchCatalogRowFields, never a raw patch or a move", () => {
    // CF-GUARD-THE-CATALOG-WRITE-CONTRACT. A field repair is a patch through
    // the row-op; a re-key would be moveCatalogRow, and this is not one.
    expect(CODE).toContain("patchCatalogRowFields(cat, r.id, r.cardId, { parallel: \"\" })");
    expect(CODE).not.toMatch(/\.item\([^)]*\)\.patch\(/);
    expect(CODE).not.toMatch(/\bmoveCatalogRow\(/);
    expect(CODE).not.toMatch(/\brelocateSoldComp\(/);
    expect(CODE).not.toMatch(/\.(upsert|create|delete)\(/);
  });

  it("never writes a field that would re-key the row", () => {
    // The whole safety argument is that identity does not move. `parallel` is
    // the only field ever handed to the helper — and the helper itself refuses
    // id / cardId / hobbyiqCardId, so a re-key cannot be spelled here at all.
    const patched = [...CODE.matchAll(/patchCatalogRowFields\([^,]+,[^,]+,[^,]+,\s*\{([^}]*)\}/g)]
      .map((m) => m[1].trim());
    expect(patched).toEqual(['parallel: ""']);
    for (const f of ["hobbyiqCardId", "cardId", "setKey", "cardYear", "id"]) {
      expect(patched.some((p) => new RegExp(`\\b${f}\\s*:`).test(p)), `${f} must never be patched`).toBe(false);
    }
  });

  it("reconciles intended = written + skipped + failed", () => {
    expect(SRC).toMatch(/reportWrites\(\{/);
    for (const k of ["intended: c.intended", "written: c.written", "skipped: c.skipped", "failed: c.failed"]) {
      expect(SRC).toContain(k);
    }
    // A "noop" is a declared outcome, not a silent write.
    expect(SRC).toContain("else c.skipped++;");
  });

  it("is report-first and reads the switch the runner exports", () => {
    expect(SRC).toContain('const APPLY = flag("apply") || env("BACKFILL_APPLY") === "true";');
    // Dry-run returns before the write loop.
    expect(SRC.indexOf("if (!APPLY)")).toBeLessThan(SRC.indexOf("patchCatalogRowFields(cat"));
  });

  it("refuses before it requires, so a missing dist cannot look like a refusal", () => {
    expect(SRC.indexOf("process.exit(2)")).toBeLessThan(SRC.indexOf("require(path.join(backend"));
  });

  it("prints no budget marker, because it has no relaunch step", () => {
    // A marker with nothing keyed on it is a fleet that stops silently, green.
    // 1,075 rows finish inside one step, so there is no clock at all.
    expect(SRC).not.toMatch(/stopped at the .*budget/);
  });
});

describe("the runner can actually dispatch it", () => {
  const YML = fs.readFileSync(RUNNER, "utf8");

  it("is whitelisted in the script dropdown", () => {
    expect(YML).toContain("- repair-hobbymonitor-literal-base");
  });

  it("the generic run step carries the SOURCE the script requires", () => {
    // The exec gate is generic — one `Run backfill` step for every script —
    // so registration is the choice option plus the env plumbing. `sources`
    // already maps to SOURCE/SOURCES; no new dispatch input is claimed
    // (GitHub caps workflow_dispatch at 25 and 24 are used).
    expect(YML).toMatch(/^\s+SOURCE: \$\{\{ inputs\.sources \}\}/m);
    expect(YML).toMatch(/^\s+SOURCES: \$\{\{ inputs\.sources \}\}/m);
    expect(YML).toMatch(/^\s+BACKFILL_APPLY: /m);
  });

  it("claims no new workflow_dispatch input", () => {
    const block = YML.slice(YML.indexOf("workflow_dispatch:"), YML.indexOf("jobs:"));
    const inputs = [...block.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputs.length, "dispatch inputs are frozen at 24 of GitHub's 25").toBeLessThanOrEqual(24);
  });
});
