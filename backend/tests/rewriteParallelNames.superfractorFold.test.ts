// rewrite-parallel-names.cjs -- SuperFractor singular/plural fold
// (backend/data/parallel-name-rules/2026-09-27-panini-2023-2026-and-superfractor.DRAFT.json).
//
// PR #2457 "NEEDS RULING: rename rules -- Panini 2023-2026 + SuperFractor".
// Drew's 2026-09-28 11:55Z ruling: canonical rung name is the SINGULAR
// "SuperFractor" (cap S, cap F, ASCII); plural rows fold onto it. applyRule's
// alias dispatch is an exact-string match, so each distinct raw spelling
// ("SuperFractors" cap F, "Superfractors" low f) needs its own rule; and
// loadRules refuses a setKeyPrefix rule whose scope.setKeys entries do not
// all literally start with that prefix, so the family (which has no single
// shared string prefix -- bowman-chrome*, topps-allen-ginter-chrome,
// topps-stadium-club-chrome and topps-cosmic-chrome don't start with
// "topps-chrome") is split into one topps-chrome-prefixed group rule (for
// the 5 setKeys that DO share that prefix) plus one setKey-scoped rule per
// remaining literal setKey -- 8 scan groups x 2 spellings = 16 ruled rules.
// This test pins that split, confirms every rule loads and applies
// correctly, confirms the casing decision against variationVocabulary.ts's
// FINISH_SPELLING and the committed checklist corpus's majority spelling,
// and confirms every OTHER census finding is untouched in `pending`.
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

const RULES_FILE = path.join(
  backend, "data", "parallel-name-rules", "2026-09-27-panini-2023-2026-and-superfractor.DRAFT.json",
);
const SHIPPED_0926_FILE = path.join(
  backend, "data", "parallel-name-rules", "2026-09-26-topps-bowman-2024-2026-leaked-notes-and-raywave.json",
);
const SHIPPED_0928_SCLASS_FILE = path.join(
  backend, "data", "parallel-name-rules", "2026-09-28-baseball-s-class-aliases.json",
);
const CHECKLIST_NAMES_FILE = path.join(backend, "data", "checklist-parallel-names.json");
const VARIATION_VOCAB_FILE = path.join(backend, "src", "services", "catalog", "variationVocabulary.ts");

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const TOPPS_CHROME_PREFIXED_SETKEYS = [
  "topps-chrome", "topps-chrome-black", "topps-chrome-platinum-anniversary", "topps-chrome-platinum", "topps-chrome-update",
];
const INDIVIDUAL_SETKEYS = [
  "bowman-chrome", "bowman-chrome-mega-box", "bowman-chrome-nscc", "bowman-chrome-sapphire",
  "topps-allen-ginter-chrome", "topps-stadium-club-chrome", "topps-cosmic-chrome",
];
const SCAN_GROUP_SUFFIXES = ["topps-chrome-family", ...INDIVIDUAL_SETKEYS];
const SUPERFRACTOR_RULE_IDS = SCAN_GROUP_SUFFIXES.flatMap((suffix) => [
  `alias-superfractors-plural-capf-to-singular-${suffix}`,
  `alias-superfractors-plural-lowf-to-singular-${suffix}`,
]);

describe("SuperFractor fold (2026-09-28 ruling) -- file exists and loads", () => {
  it("the rules file exists and loads without throwing", () => {
    expect(fs.existsSync(RULES_FILE)).toBe(true);
    const rules = lib.loadRules(RULES_FILE, []);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("carries exactly 16 SuperFractor rules -- 8 scan groups x 2 raw plural spellings", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    expect(rules).toHaveLength(16);
    expect(rules.map((r: any) => r.id).sort()).toEqual([...SUPERFRACTOR_RULE_IDS].sort());
  });

  it("the topps-chrome-prefixed group rule scopes setKeyPrefix to exactly the 5 setKeys that share it", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    for (const suffix of ["capf", "lowf"]) {
      const r = rules.find((x: any) => x.id === `alias-superfractors-plural-${suffix}-to-singular-topps-chrome-family`);
      expect(r).toBeDefined();
      expect(r.setKeyPrefix).toBe("topps-chrome");
      expect([...r.setKeys].sort()).toEqual([...TOPPS_CHROME_PREFIXED_SETKEYS].sort());
      for (const sk of r.setKeys) expect(sk.startsWith("topps-chrome")).toBe(true);
    }
  });

  it("every individual-setKey rule scopes to exactly one literal setKey outside the topps-chrome prefix", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    for (const sk of INDIVIDUAL_SETKEYS) {
      for (const suffix of ["capf", "lowf"]) {
        const r = rules.find((x: any) => x.id === `alias-superfractors-plural-${suffix}-to-singular-${sk}`);
        expect(r, `rule for ${sk} (${suffix}) must be registered`).toBeDefined();
        expect(r.setKeyPrefix).toBe("");
        expect(r.setKey).toBe(sk);
        expect(sk.startsWith("topps-chrome")).toBe(false);
      }
    }
  });

  it("no ruling is PENDING or rulingDate null for any of the 16 SuperFractor rules", () => {
    const doc = readJson(RULES_FILE);
    for (const id of SUPERFRACTOR_RULE_IDS) {
      const r = doc.rules.find((x: any) => x.id === id);
      expect(r, `rule ${id} must exist in doc.rules`).toBeDefined();
      expect(String(r.ruling).trim()).not.toBe("PENDING");
      expect(String(r.ruling).trim().length).toBeGreaterThan(0);
      expect(r.rulingDate).toBe("2026-09-28");
      expect(Array.isArray(r.sources)).toBe(true);
      expect(r.sources.length).toBeGreaterThan(0);
    }
  });
});

describe("SuperFractor fold -- both plural raw spellings fold to the singular canonical, in every scan group", () => {
  it("every 'capf' rule folds 'SuperFractors' (cap F plural) to 'SuperFractor'", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    for (const suffix of SCAN_GROUP_SUFFIXES) {
      const r = rules.find((x: any) => x.id === `alias-superfractors-plural-capf-to-singular-${suffix}`)!;
      expect(lib.applyRule(r, "SuperFractors")).toEqual({ name: "SuperFractor", strippedNote: null });
      expect(r.from).toBe("SuperFractors");
      expect(r.to).toBe("SuperFractor");
    }
  });

  it("every 'lowf' rule folds 'Superfractors' (low f plural) to 'SuperFractor'", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    for (const suffix of SCAN_GROUP_SUFFIXES) {
      const r = rules.find((x: any) => x.id === `alias-superfractors-plural-lowf-to-singular-${suffix}`)!;
      expect(lib.applyRule(r, "Superfractors")).toEqual({ name: "SuperFractor", strippedNote: null });
      expect(r.from).toBe("Superfractors");
      expect(r.to).toBe("SuperFractor");
    }
  });

  it("no SuperFractor rule matches text that is already canonical, or an unrelated string", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    for (const id of SUPERFRACTOR_RULE_IDS) {
      const r = rules.find((x: any) => x.id === id)!;
      expect(lib.applyRule(r, "SuperFractor")).toBeNull();
      expect(lib.applyRule(r, "Gold SuperFractor")).toBeNull();
      expect(lib.applyRule(r, "Refractor")).toBeNull();
    }
  });

  it("every alias rule in this file has from !== to", () => {
    const doc = readJson(RULES_FILE);
    for (const r of doc.rules) {
      if (r.kind === "alias") expect(r.from).not.toBe(r.to);
    }
  });
});

describe("SuperFractor fold -- casing decided by majority, matches the rest of the codebase", () => {
  it("variationVocabulary.ts's FINISH_SPELLING already pins the same canonical casing", () => {
    const src = fs.readFileSync(VARIATION_VOCAB_FILE, "utf8");
    expect(src).toMatch(/superfractor:\s*"SuperFractor"/);
  });

  it("the committed checklist corpus canonicalizes to 'SuperFractor' for a clear majority of products", () => {
    const checklist = readJson(CHECKLIST_NAMES_FILE);
    const products = checklist.products;
    let capF = 0;
    let lowF = 0;
    for (const key of Object.keys(products)) {
      for (const par of products[key].parallels || []) {
        if (par.name === "SuperFractor") capF++;
        if (par.name === "Superfractor") lowF++;
      }
    }
    expect(capF).toBeGreaterThan(lowF);
    // Not a marginal call -- pin the actual majority so a future edit to the
    // corpus that erodes this margin is visible, not silently assumed.
    expect(capF).toBeGreaterThanOrEqual(50);
  });

  it("every rule's 'to' target is ASCII only (no smart quotes or other non-ASCII glyphs) and equals 'SuperFractor'", () => {
    const doc = readJson(RULES_FILE);
    for (const id of SUPERFRACTOR_RULE_IDS) {
      const r = doc.rules.find((x: any) => x.id === id);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(r.to)).toBe(true);
      expect(r.to).toBe("SuperFractor");
    }
  });

  it("at least one real checklist product (topps-chrome-platinum 2023) already carries both raw spellings, confirming this is a genuine catalog-wide fork the fold rules reach", () => {
    const checklist = readJson(CHECKLIST_NAMES_FILE);
    const product = checklist.products["baseball|2023|topps-chrome-platinum"];
    expect(product).toBeDefined();
    const names: string[] = product.parallels.map((p: any) => p.name);
    expect(names).toContain("SuperFractor");
    expect(names).toContain("Superfractors");
  });
});

describe("SuperFractor fold -- every other finding is untouched, in `pending`, never fed to loadRules", () => {
  it("`rules` contains only the 16 ruled SuperFractor aliases -- everything else moved to `pending`", () => {
    const doc = readJson(RULES_FILE);
    const ids = doc.rules.map((r: any) => r.id).sort();
    expect(ids).toEqual([...SUPERFRACTOR_RULE_IDS].sort());
  });

  it("loadRules only ever reads `rules` -- the pending block is invisible to it", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    expect(rules.map((r: any) => r.id).sort()).toEqual([...SUPERFRACTOR_RULE_IDS].sort());
  });

  it("every pending entry documents its own status, evidence and sampled-sales count (never a silent placeholder)", () => {
    const doc = readJson(RULES_FILE);
    expect(Array.isArray(doc.pending)).toBe(true);
    expect(doc.pending.length).toBeGreaterThan(0);
    for (const p of doc.pending) {
      expect(String(p.status ?? "").trim().length).toBeGreaterThan(0);
      expect(String(p.evidence ?? "").trim().length).toBeGreaterThan(0);
      expect(typeof p.sampledSales).toBe("number");
      expect(p.sampledSales).toBeGreaterThan(0);
    }
  });

  it("the documentation-only compound-rung exclusion finding is still present in pending and unresolved", () => {
    const doc = readJson(RULES_FILE);
    const flag = doc.pending.find((p: any) => p.id === "pending-flag-superfractor-compound-rung-family-not-a-fold-target");
    expect(flag).toBeDefined();
    expect(flag.status).toContain("DOCUMENTATION");
  });

  it("no pending id collides with a ruled rule id", () => {
    const doc = readJson(RULES_FILE);
    const ruledIds = new Set(doc.rules.map((r: any) => r.id));
    for (const p of doc.pending) {
      expect(ruledIds.has(p.id)).toBe(false);
    }
  });
});

describe("SuperFractor fold -- no overlap with already-shipped rules", () => {
  it("no rule id collides with the 2026-09-26 shipped rules file", () => {
    const newDoc = readJson(RULES_FILE);
    const existingDoc = readJson(SHIPPED_0926_FILE);
    const existingIds = new Set(existingDoc.rules.map((r: any) => r.id));
    for (const r of newDoc.rules) {
      expect(existingIds.has(r.id), `rule id ${r.id} collides with the 09-26 shipped rules file`).toBe(false);
    }
  });

  it("no (scope, kind, from, to) triple collides with the 2026-09-26 shipped rules file", () => {
    const newDoc = readJson(RULES_FILE);
    const existingDoc = readJson(SHIPPED_0926_FILE);
    const keyOf = (r: any) => JSON.stringify([r.scope, r.kind, r.from ?? r.pattern, r.to ?? null]);
    const existingKeys = new Set(existingDoc.rules.map(keyOf));
    for (const r of newDoc.rules) {
      expect(existingKeys.has(keyOf(r)), `rule ${r.id} duplicates a 09-26 shipped rule`).toBe(false);
    }
  });

  it("the 09-26 shipped file explicitly excludes SuperFractor (ruling was deliberately deferred to this PR)", () => {
    const raw = fs.readFileSync(SHIPPED_0926_FILE, "utf8");
    expect(raw).toContain("SuperFractor is DELIBERATELY");
  });

  it("no rule id collides with the 2026-09-28 baseball S-class aliases file (#2479, merged), and its scope stays disjoint", () => {
    const newDoc = readJson(RULES_FILE);
    const sClassDoc = readJson(SHIPPED_0928_SCLASS_FILE);
    const sClassIds = new Set(sClassDoc.rules.map((r: any) => r.id));
    for (const r of newDoc.rules) {
      expect(sClassIds.has(r.id), `rule id ${r.id} collides with the S-class aliases file`).toBe(false);
    }
    // #2479's S-class batch scoped only to baseball|2023|topps (Mother's/
    // Father's Day) -- disjoint by construction from this file's Panini +
    // topps-chrome-family scope, but pin it so a future rebase surfaces any
    // accidental widening immediately rather than silently colliding.
    for (const r of sClassDoc.rules) {
      expect(r.scope.setKey).toBe("topps");
    }
  });
});

describe("SuperFractor fold -- no control-byte corruption", () => {
  it("carries no 0x08/0x00 bytes in the rules file", () => {
    const buf = fs.readFileSync(RULES_FILE);
    let has08 = false;
    let has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });

  it("carries no 0x08/0x00 bytes in this test file itself", () => {
    const selfPath = path.join(backend, "tests", "rewriteParallelNames.superfractorFold.test.ts");
    const buf = fs.readFileSync(selfPath);
    let has08 = false;
    let has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });
});
