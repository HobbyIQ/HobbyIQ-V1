// rewrite-parallel-names.cjs -- 2026-09-28 baseball S-class alias batch
// (backend/data/parallel-name-rules/2026-09-28-baseball-s-class-aliases.json).
//
// Drew's "Fix all of baseball now" directive, S-class (spelling/rung) slice.
// Mirrors tests/rewriteParallelNames.test.ts's own loader/validator pins,
// scoped to this one rules file: does it load, is every rule registered
// against a real product in checklist-parallel-names.json, does every alias
// have from!=to, and does it avoid colliding with the already-shipped rules
// file or PR #2457's draft (same lane, disjoint scope: Panini + SuperFractor).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "rewrite-parallel-names.cjs");
const require_ = createRequire(import.meta.url);
const lib = require_(scriptPath) as {
  loadRules: (p: string, titles: string[]) => any[];
  applyRule: (rule: any, raw: string) => { name: string; strippedNote: string | null; empty?: boolean } | null;
};

const RULES_FILE = path.join(backend, "data", "parallel-name-rules", "2026-09-28-baseball-s-class-aliases.json");
const EXISTING_RULES_FILE = path.join(
  backend, "data", "parallel-name-rules", "2026-09-26-topps-bowman-2024-2026-leaked-notes-and-raywave.json",
);
const CHECKLIST_NAMES_FILE = path.join(backend, "data", "checklist-parallel-names.json");

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("baseball S-class aliases (2026-09-28) -- file exists and loads", () => {
  it("the rules file exists", () => {
    expect(fs.existsSync(RULES_FILE)).toBe(true);
  });

  it("loadRules accepts it without throwing, before any row is read", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("carries exactly the 4 shipped alias rules this batch confirmed (2 rungs x 2 source-glyph variants each, >=50 sales, checklist-backed target)", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    const ids = rules.map((r) => r.id).sort();
    expect(ids).toEqual([
      "alias-fathers-day-blue-ascii-topps-2023",
      "alias-fathers-day-blue-curly-source-to-ascii-topps-2023",
      "alias-mothers-day-pink-ascii-topps-2023",
      "alias-mothers-day-pink-curly-source-to-ascii-topps-2023",
    ]);
  });

  it("every rule is kind=alias, scoped to baseball/2023/topps", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    for (const r of rules) {
      expect(r.kind).toBe("alias");
      expect(r.sport).toBe("baseball");
      expect(r.years).toEqual([2023]);
      expect(r.setKey).toBe("topps");
    }
  });

  it("every rule carries a non-empty ruling, rulingDate and sources (refused otherwise, before any row read)", () => {
    const doc = readJson(RULES_FILE);
    for (const r of doc.rules) {
      expect(String(r.ruling ?? "").trim().length).toBeGreaterThan(0);
      expect(String(r.rulingDate ?? "").trim().length).toBeGreaterThan(0);
      expect(Array.isArray(r.sources)).toBe(true);
      expect(r.sources.length).toBeGreaterThan(0);
      for (const s of r.sources) expect(String(s ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});

describe("baseball S-class aliases -- from != to, and the alias actually changes the string", () => {
  it("every alias rule has from !== to", () => {
    const doc = readJson(RULES_FILE);
    for (const r of doc.rules) {
      expect(r.from).not.toBe(r.to);
    }
  });

  it("applyRule recovers the exact ASCII 'to' text for both the ASCII- and curly-apostrophe source spellings", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    const mothersDayAscii = rules.find((r) => r.id === "alias-mothers-day-pink-ascii-topps-2023")!;
    const mothersDayCurly = rules.find((r) => r.id === "alias-mothers-day-pink-curly-source-to-ascii-topps-2023")!;
    const fathersDayAscii = rules.find((r) => r.id === "alias-fathers-day-blue-ascii-topps-2023")!;
    const fathersDayCurly = rules.find((r) => r.id === "alias-fathers-day-blue-curly-source-to-ascii-topps-2023")!;

    // Both source-glyph variants fold to the SAME ASCII checklist name.
    expect(lib.applyRule(mothersDayAscii, "Mother's Day Pink")).toEqual({ name: "Mother's Day Hot Pink", strippedNote: null });
    expect(lib.applyRule(mothersDayCurly, "Mother’s Day Pink")).toEqual({ name: "Mother's Day Hot Pink", strippedNote: null });
    expect(lib.applyRule(fathersDayAscii, "Father's Day Blue")).toEqual({ name: "Father's Day Powder Blue", strippedNote: null });
    expect(lib.applyRule(fathersDayCurly, "Father’s Day Blue")).toEqual({ name: "Father's Day Powder Blue", strippedNote: null });

    // Each rule matches ONLY its own source glyph -- exact human-form string
    // per the alias contract, never a fuzzy/partial/glyph-insensitive match.
    // That is exactly why this rung needs two rules, not one.
    expect(lib.applyRule(mothersDayAscii, "Mother’s Day Pink")).toBeNull();
    expect(lib.applyRule(mothersDayCurly, "Mother's Day Pink")).toBeNull();
    expect(lib.applyRule(mothersDayAscii, "Mother's Day Hot Pink")).toBeNull();
    expect(lib.applyRule(mothersDayAscii, "mother's day pink")).toBeNull();
  });

  it("every rule's 'to' is the ASCII apostrophe form -- never the curly glyph", () => {
    const doc = readJson(RULES_FILE);
    for (const r of doc.rules) {
      expect(r.to).not.toContain("’");
    }
  });
});

describe("baseball S-class aliases -- registered against a real checklist product", () => {
  it("every rule's scope resolves to a product that actually exists in checklist-parallel-names.json, and the 'to' name is one of that product's stated parallel names", () => {
    const doc = readJson(RULES_FILE);
    const checklist = readJson(CHECKLIST_NAMES_FILE);
    for (const r of doc.rules) {
      const key = `${r.scope.sport}|${r.scope.year}|${r.scope.setKey}`;
      const product = checklist.products[key];
      expect(product, `product ${key} must be registered in checklist-parallel-names.json`).toBeDefined();
      const names: string[] = product.parallels.map((p: any) => p.name);
      expect(names, `"${r.to}" must be one of ${key}'s stated checklist parallel names`).toContain(r.to);
    }
  });
});

describe("baseball S-class aliases -- no overlap with the already-shipped rules file or PR #2457's draft", () => {
  it("no (scope, from, to) triple collides with the 2026-09-26 shipped rules file", () => {
    const newDoc = readJson(RULES_FILE);
    const existingDoc = readJson(EXISTING_RULES_FILE);
    const keyOf = (r: any) => JSON.stringify([r.scope, r.kind, r.from ?? r.pattern, r.to ?? null]);
    const existingKeys = new Set(existingDoc.rules.map(keyOf));
    for (const r of newDoc.rules) {
      expect(existingKeys.has(keyOf(r)), `rule ${r.id} duplicates an existing shipped rule`).toBe(false);
    }
  });

  it("no rule id collides with the 2026-09-26 shipped rules file", () => {
    const newDoc = readJson(RULES_FILE);
    const existingDoc = readJson(EXISTING_RULES_FILE);
    const existingIds = new Set(existingDoc.rules.map((r: any) => r.id));
    for (const r of newDoc.rules) {
      expect(existingIds.has(r.id), `rule id ${r.id} collides with the shipped rules file`).toBe(false);
    }
  });

  it("PR #2457's draft file (Panini + SuperFractor scope) shares no setKey with this batch's shipped rules", () => {
    // PR #2457 (census/panini-2023-2026-superfractor-20260927-0150) scopes to
    // panini-donruss/panini-prizm/panini-select and a topps-chrome-family
    // SuperFractor singular/plural fold (ruling: PENDING) -- disjoint from
    // this batch's baseball|2023|topps Mother's/Father's Day aliases by
    // construction (different setKey entirely). This test pins that the
    // shipped rules in THIS file never scope to a setKey PR #2457 also
    // covers, so a future rebase cannot silently introduce a collision.
    const newDoc = readJson(RULES_FILE);
    const pr2457SetKeys = new Set(["panini-donruss", "panini-prizm", "panini-select", "topps-chrome", "bowman-chrome", "bowman-chrome-mega-box", "bowman-chrome-nscc", "bowman-chrome-sapphire", "topps-allen-ginter-chrome", "topps-chrome-black", "topps-chrome-platinum-anniversary", "topps-stadium-club-chrome", "topps-chrome-platinum", "topps-cosmic-chrome", "topps-chrome-update"]);
    for (const r of newDoc.rules) {
      expect(pr2457SetKeys.has(r.scope.setKey)).toBe(false);
    }
  });
});

describe("baseball S-class aliases -- pending block is documentation-only, never fed to loadRules", () => {
  it("the pending block is not named 'rules' and is ignored by the loader", () => {
    const doc = readJson(RULES_FILE);
    expect(Array.isArray(doc.pending)).toBe(true);
    expect(doc.pending.length).toBeGreaterThan(0);
    // loadRules only ever reads doc.rules -- confirmed by the earlier "loads
    // without throwing" test already exercising the real loader against
    // this exact file, which contains the pending block alongside `rules`.
    const rules = lib.loadRules(RULES_FILE, []);
    const pendingIds = new Set(doc.pending.map((p: any) => p.id));
    for (const r of rules) {
      expect(pendingIds.has(r.id)).toBe(false);
    }
  });

  it("every pending entry documents its own evidence and status (never a silent placeholder)", () => {
    const doc = readJson(RULES_FILE);
    for (const p of doc.pending) {
      expect(String(p.status ?? "").trim().length).toBeGreaterThan(0);
      expect(String(p.evidence ?? "").trim().length).toBeGreaterThan(0);
      expect(typeof p.sampledSales).toBe("number");
      expect(p.sampledSales).toBeGreaterThan(0);
    }
  });
});

describe("baseball S-class aliases -- no control-byte corruption", () => {
  it("carries no 0x08/0x00 bytes in the rules file", () => {
    const buf = fs.readFileSync(RULES_FILE);
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });

  it("carries no 0x08/0x00 bytes in this test file itself", () => {
    const selfPath = path.join(backend, "tests", "rewriteParallelNames.baseballSClass.test.ts");
    const buf = fs.readFileSync(selfPath);
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });
});
