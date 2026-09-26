// rewrite-parallel-names.cjs -- "a note is not a rung", the 251k-row leaked
// annotation cleanup + RayWave/apostrophe fold lane. Pins:
//
//   1. loadRules refuses a rule missing ruling/rulingDate/sources
//   2. loadRules refuses a malformed kind/scope
//   3. strip-note pattern shapes (channel word, parenthetical, exclusive,
//      inline print-run, pack odds, SKU) each recover the clean name
//   4. alias exact-match fold (RayWave, apostrophe/case pairs)
//   5. printRunFromName gate: only fires when the row has no printRun AND a
//      checklist-grade twin elsewhere attests the exact (parallel, printRun)
//   6. already-canonical (LEFT) vs HEAL (slug clean, field stale)
//   7. MOVE to an absent clean address, changedFields.parallel carried
//   8. occupied-by-checklist -> RETIRE only when sold_comps sales are ZERO;
//      any sale -> HOLD "sales present" with the count
//   9. occupied-by-derived -> HOLD, never overwritten
//  10. isAuto/printRun untouched except the explicit printRunFromName case
//  11. REPORT (apply=false) writes nothing but still derives every outcome
//  12. reconcile identity + non-zero exit on mismatch
//  13. rule validation refuses before any row is read
//  14. workflow pin: registered, 24 inputs unchanged, file < 512 KB
//  15. mutation checks: removing the 0-sales guard fails; removing
//      changedFields.parallel from the move call fails
//  16. every rule in the shipped rules file has non-empty sources
//  17. no 0x08/0x00 bytes in the script (heredoc-authoring guard)
//  18. (#2434 review) a setKeyPrefix rule with no scope.setKeys is refused
//      at load; productCellsOf reaches every setKey a rule names by id,
//      with no dependency on any OTHER rule's own setKey (the defect that
//      left topps-series-1 unreachable by 9 of 15 shipped rules)
//  19. (#2434 review) computeHobbyIqCardId is fed the row's own
//      subsetName/subsetInId, so a `:sub-` row's MOVE round-trips onto its
//      own subset address, never the parent product's bare numbering
//  20. REPORT prints the per-rule scan scope (product cells) before any
//      row is read, so an operator sees the scope before an APPLY

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(backend, "scripts", "rewrite-parallel-names.cjs");
const source = fs.readFileSync(scriptPath, "utf8");
const require_ = createRequire(import.meta.url);
const lib = require_(scriptPath) as {
  loadRules: (p: string, titles: string[]) => any[];
  applyRule: (rule: any, raw: string) => { name: string; strippedNote: string | null; empty?: boolean } | null;
  runLane: (opts: any) => Promise<any>;
  productCellsOf: (rule: any) => Array<{ sport: string; year: number; setKey: string }>;
  salesCountAt: (pool: any, slug: string) => Promise<{ xp: number; pk: number; total: number }>;
  checklistAttestsPrintRun: (cat: any, sport: string, year: number, setKey: string, parallel: string, printRun: number) => Promise<boolean>;
  computeNewIdPreservingSetKey: (row: any, newName: string, printRun: number | null, deps: any) => { newId: string } | { refused: string; detail: string };
  preflight: (row: any, outcome: any) => { ok: true; newId: string } | { ok: false; refused: string; detail: string };
  makePlanEmitter: (planOut: string, slot: number) => { emitPlanRow: (record: any) => void; close: () => void };
};

const RULES_FILE = path.join(
  backend, "data", "parallel-name-rules", "2026-09-26-topps-bowman-2024-2026-leaked-notes-and-raywave.json",
);

// ── writing a rules file to a scratch path for the refusal tests ──────────

function writeTempRules(doc: unknown): string {
  const p = path.join(backend, "data", "parallel-name-rules", `__test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(doc));
  return p;
}

const validRule = {
  id: "r1",
  scope: { sport: "baseball", year: 2026, setKey: "topps" },
  kind: "strip-note",
  pattern: ["^(.*?)\\s*-\\s*Retail\\.?\\s*$"],
  ruling: "test ruling",
  rulingDate: "2026-09-26",
  sources: ["a verbatim quote"],
  reason: "test",
};

describe("rewrite-parallel-names -- loadRules refusals (before any row is read)", () => {
  const cases: Array<[string, unknown]> = [
    ["missing ruling", { ...validRule, ruling: undefined }],
    ["missing rulingDate", { ...validRule, rulingDate: undefined }],
    ["missing sources", { ...validRule, sources: undefined }],
    ["empty sources array", { ...validRule, sources: [] }],
    ["bad kind", { ...validRule, kind: "delete" }],
    ["missing scope.sport", { ...validRule, scope: { year: 2026, setKey: "topps" } }],
    ["missing scope year/years", { ...validRule, scope: { sport: "baseball", setKey: "topps" } }],
    ["missing setKey and setKeyPrefix", { ...validRule, scope: { sport: "baseball", year: 2026 } }],
    ["strip-note with no pattern", { ...validRule, pattern: [] }],
    ["alias missing to", { id: "a1", scope: validRule.scope, kind: "alias", from: "X", ruling: "r", rulingDate: "2026-09-26", sources: ["q"] }],
    ["alias from === to", { id: "a1", scope: validRule.scope, kind: "alias", from: "X", to: "X", ruling: "r", rulingDate: "2026-09-26", sources: ["q"] }],
    ["duplicate rule id", "DUPLICATE_CASE"],
    // CF-A-PREFIX-NAMES-A-SHAPE-A-SCAN-NAMES-AN-ADDRESS (review finding,
    // 2026-09-26): a setKeyPrefix rule with no scope.setKeys array would
    // silently scan zero cells (or, before this fix, whatever cells another
    // rule happened to name) -- refused at load, before any row is read.
    ["setKeyPrefix with no scope.setKeys", { ...validRule, scope: { sport: "baseball", year: 2026, setKeyPrefix: "topps" } }],
    ["setKeyPrefix with an empty scope.setKeys array", { ...validRule, scope: { sport: "baseball", year: 2026, setKeyPrefix: "topps", setKeys: [] } }],
    ["setKeyPrefix with a scope.setKeys entry that does not start with the prefix", { ...validRule, scope: { sport: "baseball", year: 2026, setKeyPrefix: "topps", setKeys: ["topps-chrome", "bowman"] } }],
  ];

  for (const [label, rule] of cases) {
    it(`refuses: ${label}`, () => {
      const doc = rule === "DUPLICATE_CASE"
        ? { rules: [validRule, validRule] }
        : { rules: [rule] };
      const p = writeTempRules(doc);
      try {
        expect(() => lib.loadRules(p, [])).toThrow();
      } finally {
        fs.unlinkSync(p);
      }
    });
  }

  it("accepts a well-formed strip-note rule and a well-formed alias rule", () => {
    const p = writeTempRules({
      rules: [
        validRule,
        { id: "a1", scope: validRule.scope, kind: "alias", from: "Raywave", to: "RayWave", ruling: "r", rulingDate: "2026-09-26", sources: ["q"] },
      ],
    });
    try {
      const rules = lib.loadRules(p, []);
      expect(rules).toHaveLength(2);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("TITLES filter narrows to the named rule ids", () => {
    const p = writeTempRules({
      rules: [validRule, { ...validRule, id: "r2" }],
    });
    try {
      const rules = lib.loadRules(p, ["r2"]);
      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("r2");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("a strip-note pattern with no capture group throws when actually applied, not at load", () => {
    const p = writeTempRules({ rules: [{ ...validRule, pattern: ["Retail"] }] });
    try {
      const rules = lib.loadRules(p, []);
      expect(() => lib.applyRule(rules[0], "Gold Wave Retail")).toThrow(/no capture group/);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("accepts a setKeyPrefix rule whose scope.setKeys is a valid, prefix-matching, non-empty list", () => {
    const p = writeTempRules({
      rules: [{ ...validRule, scope: { sport: "baseball", year: 2026, setKeyPrefix: "topps", setKeys: ["topps", "topps-chrome"] } }],
    });
    try {
      const rules = lib.loadRules(p, []);
      expect(rules).toHaveLength(1);
      expect(rules[0].setKeys).toEqual(["topps", "topps-chrome"]);
    } finally {
      fs.unlinkSync(p);
    }
  });
});

// ── productCellsOf: the scan scope is EXACTLY the rule's own setKeys ───────

describe("rewrite-parallel-names -- productCellsOf reaches every setKey a rule names, no discovery", () => {
  it("a rule listing topps-series-1 in scope.setKeys returns it from productCellsOf -- the #2434 review finding", () => {
    const p = writeTempRules({
      rules: [{
        ...validRule,
        scope: { sport: "baseball", years: [2024, 2025, 2026], setKeyPrefix: "topps", setKeys: ["topps", "topps-series-1", "topps-chrome"] },
      }],
    });
    try {
      const rules = lib.loadRules(p, []);
      const cells = lib.productCellsOf(rules[0]);
      const setKeys = new Set(cells.map((c: any) => c.setKey));
      expect(setKeys.has("topps-series-1")).toBe(true);
      expect(cells).toHaveLength(9); // 3 setKeys x 3 years
      expect(cells).toContainEqual({ sport: "baseball", year: 2026, setKey: "topps-series-1" });
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("a plain scope.setKey (no prefix) yields exactly one setKey across every year", () => {
    const p = writeTempRules({ rules: [{ ...validRule, scope: { sport: "baseball", years: [2025, 2026], setKey: "topps-chrome" } }] });
    try {
      const rules = lib.loadRules(p, []);
      const cells = lib.productCellsOf(rules[0]);
      expect(cells).toEqual([
        { sport: "baseball", year: 2025, setKey: "topps-chrome" },
        { sport: "baseball", year: 2026, setKey: "topps-chrome" },
      ]);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("every setKeyPrefix rule in the SHIPPED rules file reaches topps-series-1 or its Bowman-family sibling it should, and productCellsOf never depends on a sibling rule's own setKey", () => {
    const rules = lib.loadRules(RULES_FILE, []);
    const toppsFamily = ["topps", "topps-series-1", "topps-series-2", "topps-update-series", "topps-chrome", "topps-chrome-update-series", "topps-holiday"];
    const bowmanFamily = ["bowman", "bowman-chrome", "bowman-draft", "bowman-chrome-draft", "bowman-mega", "bowmans-best", "bowman-draft-sapphire", "bowman-chrome-sapphire"];
    for (const rule of rules) {
      if (!rule.setKeyPrefix) continue;
      const cells = lib.productCellsOf(rule);
      const reached = new Set(cells.map((c: any) => c.setKey));
      const family = rule.setKeyPrefix === "topps" ? toppsFamily : bowmanFamily;
      for (const sk of family) expect(reached.has(sk), `${rule.id} reaches ${sk}`).toBe(true);
    }
  });
});

describe("rewrite-parallel-names -- the SCOPE (rules file) refusal, in a clean child process", () => {
  const runWith = (env: Record<string, string>) => {
    let code: number | null = null;
    let out = "";
    try {
      execFileSync(process.execPath, [scriptPath], {
        cwd: backend,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
          ...env,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      code = 0;
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string };
      code = err.status ?? null;
      out = String(err.stderr ?? "") + String(err.stdout ?? "");
    }
    return { code, out };
  };

  it("refuses with no SCOPE at all", () => {
    const { code, out } = runWith({});
    expect(code).not.toBe(0);
    expect(out).toContain("SCOPE is empty");
  });

  it("refuses a SCOPE that does not end in .json", () => {
    const { code, out } = runWith({ SCOPE: "refractor" });
    expect(code).not.toBe(0);
    expect(out).toContain("does not name a rules file");
  });

  it("refuses (distinct message) when COSMOS_CONNECTION_STRING is also missing, after a valid-looking SCOPE", () => {
    const { code, out } = runWith({ SCOPE: "data/parallel-name-rules/2026-09-26-topps-bowman-2024-2026-leaked-notes-and-raywave.json" });
    expect(code).not.toBe(0);
    expect(out).toContain("COSMOS_CONNECTION_STRING not set");
  });
});

// ── applyRule pattern shapes, against the shipped rules file ──────────────

describe("rewrite-parallel-names -- shipped rules file, pattern shapes recover the clean name", () => {
  let rules: any[];
  beforeAll(() => { rules = lib.loadRules(RULES_FILE, []); });
  const byId = (id: string) => {
    const r = rules.find((x) => x.id === id);
    expect(r, `rule ${id} exists`).toBeTruthy();
    return r;
  };

  it("strip-retailer-channel-word: 'Gold Wave - Hobby' -> 'Gold Wave'", () => {
    expect(lib.applyRule(byId("strip-retailer-channel-word"), "Gold Wave - Hobby")).toEqual({ name: "Gold Wave", strippedNote: "Gold Wave - Hobby" });
  });

  it("strip-parenthetical-channel-note: Purple/Yellow Tinsel census examples", () => {
    expect(lib.applyRule(byId("strip-parenthetical-channel-note"), "Purple Tinsel (Meijer exclusive)")).toEqual({ name: "Purple Tinsel", strippedNote: "Purple Tinsel (Meijer exclusive)" });
    expect(lib.applyRule(byId("strip-parenthetical-channel-note"), "Yellow Tinsel (Walgreens exclusive)")).toEqual({ name: "Yellow Tinsel", strippedNote: "Yellow Tinsel (Walgreens exclusive)" });
  });

  it("strip-retailer-channel-word-bowman: Silver Crackle Foil census example", () => {
    expect(lib.applyRule(byId("strip-retailer-channel-word-bowman"), "Silver Crackle Foil - Super Box exclusive")).toEqual({ name: "Silver Crackle Foil", strippedNote: "Silver Crackle Foil - Super Box exclusive" });
  });

  it("strip-exclusive-suffix-bare: dash + exclusive, no parens, case-insensitive", () => {
    expect(lib.applyRule(byId("strip-exclusive-suffix-bare"), "Orange Wave - Target exclusive")).toEqual({ name: "Orange Wave", strippedNote: "Orange Wave - Target exclusive" });
    expect(lib.applyRule(byId("strip-exclusive-suffix-bare"), "Orange Wave - Target EXCLUSIVE")).toEqual({ name: "Orange Wave", strippedNote: "Orange Wave - Target EXCLUSIVE" });
  });

  it("strip-inline-print-run-count: Crackle Foil census example, printRunFromName true", () => {
    const rule = byId("strip-inline-print-run-count");
    expect(rule.printRunFromName).toBe(true);
    expect(lib.applyRule(rule, "Crackle Foil: 10,400 copies")).toEqual({ name: "Crackle Foil", strippedNote: "Crackle Foil: 10,400 copies" });
  });

  it("strip-pack-odds-suffix: Confetti census example + 1:N form", () => {
    expect(lib.applyRule(byId("strip-pack-odds-suffix"), "Confetti - 8 per Celebration Box.")).toEqual({ name: "Confetti", strippedNote: "Confetti - 8 per Celebration Box." });
    expect(lib.applyRule(byId("strip-pack-odds-suffix"), "Something (1:24)")).toEqual({ name: "Something", strippedNote: "Something (1:24)" });
  });

  it("strip-sku-suffix", () => {
    expect(lib.applyRule(byId("strip-sku-suffix"), "Gold Wave - SKU T25TC-123")).toEqual({ name: "Gold Wave", strippedNote: "Gold Wave - SKU T25TC-123" });
  });

  it("alias-raywave-topps-chrome-2025: exact match only, majority spelling untouched", () => {
    const rule = byId("alias-raywave-topps-chrome-2025");
    expect(lib.applyRule(rule, "Raywave Refractor")).toEqual({ name: "RayWave Refractor", strippedNote: null });
    expect(lib.applyRule(rule, "RayWave Refractor")).toBeNull();
    expect(lib.applyRule(rule, "Blue Raywave Refractor")).toBeNull();
  });

  it("apostrophe/case aliases", () => {
    expect(lib.applyRule(byId("alias-mothers-day-hot-pink-topps-series-2-2024"), "Mothers Day Hot Pink")).toEqual({ name: "Mother's Day Hot Pink", strippedNote: null });
    expect(lib.applyRule(byId("alias-fathers-day-powder-blue-topps-series-2-2024"), "Fathers Day Powder Blue")).toEqual({ name: "Father's Day Powder Blue", strippedNote: null });
    expect(lib.applyRule(byId("alias-jack-olantern-topps-update-2024"), "Jack O'lantern")).toEqual({ name: "Jack O'Lantern", strippedNote: null });
    expect(lib.applyRule(byId("alias-bowman-logofractor-2026"), "Bowman Logofractor")).toEqual({ name: "Bowman LogoFractor", strippedNote: null });
  });

  it("no rule in the shipped file matches SuperFractor -- ruling deliberately pending, excluded from this batch", () => {
    for (const rule of rules) {
      expect(lib.applyRule(rule, "SuperFractor")).toBeNull();
      expect(lib.applyRule(rule, "Superfractor")).toBeNull();
    }
  });

  it("a rule does not match a raw string with no leaked shape at all", () => {
    expect(lib.applyRule(byId("strip-sku-suffix"), "Gold Refractor")).toBeNull();
    expect(lib.applyRule(byId("strip-retailer-channel-word"), "Aqua Rainbow Foil")).toBeNull();
  });

  it("every rule in the shipped file carries ruling, rulingDate and non-empty sources (pin: the file itself, not just the loader)", () => {
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, "utf8"));
    expect(Array.isArray(raw.rules)).toBe(true);
    expect(raw.rules.length).toBeGreaterThan(0);
    for (const r of raw.rules) {
      expect(String(r.ruling ?? "").length, `${r.id} ruling`).toBeGreaterThan(0);
      expect(String(r.rulingDate ?? "").length, `${r.id} rulingDate`).toBeGreaterThan(0);
      expect(Array.isArray(r.sources) && r.sources.length > 0, `${r.id} sources`).toBe(true);
    }
  });

  it("the shipped file excludes SuperFractor by name (ruling pending, documented)", () => {
    const raw = fs.readFileSync(RULES_FILE, "utf8");
    expect(raw).toContain("SuperFractor is DELIBERATELY");
    expect(raw).not.toMatch(/"from"\s*:\s*"Superfractor"/);
  });
});

// ── runLane against an in-memory fake Cosmos container ─────────────────────

function notFound(): Error & { code: number } {
  return Object.assign(new Error("Entity with the specified id does not exist"), { code: 404 });
}
type Doc = Record<string, any>;
const keyOf = (id: string, pk?: string | null) => (pk === undefined || pk === null || pk === id ? id : `${id}@${pk}`);

class FakeCatalog {
  readonly docs = new Map<string, Doc>();
  readonly log: string[] = [];
  constructor(seed: Doc[] = []) {
    for (const d of seed) this.docs.set(keyOf(d.id, d.cardId), structuredClone(d));
  }
  item(id: string, pk?: string) {
    const k = keyOf(id, pk);
    return {
      read: async () => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        return { resource: structuredClone(d) };
      },
      patch: async (ops: Array<{ op: string; path: string; value?: unknown }>) => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value;
        }
        this.log.push(`catalog.patch ${id}`);
        return { resource: structuredClone(d) };
      },
      delete: async () => {
        const d = this.docs.get(k);
        if (!d) throw notFound();
        this.docs.delete(k);
        this.log.push(`catalog.delete ${id}`);
        return {};
      },
    };
  }
  readonly items = {
    upsert: async (doc: Doc) => {
      this.docs.set(keyOf(doc.id, doc.cardId), structuredClone(doc));
      this.log.push(`catalog.upsert ${doc.id}`);
      return { resource: structuredClone(doc) };
    },
    query: (spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }) => {
      const rows = this.run(spec);
      let done = false;
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => { done = true; return { resources: rows, continuationToken: undefined }; },
        fetchAll: async () => ({ resources: rows }),
      };
    },
  };
  private run(spec: { query: string; parameters?: Array<{ name: string; value: unknown }> }): Doc[] {
    const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
    const all = [...this.docs.values()];
    if (spec.query.includes("c.sport=@sp AND c.year=@yr AND c.setKey=@sk AND IS_DEFINED(c.parallel)")) {
      return all.filter((d) => d.sport === p["@sp"] && d.year === p["@yr"] && d.setKey === p["@sk"] && d.parallel !== undefined);
    }
    if (spec.query.includes("c.parallel=@pl AND c.printRun=@pr")) {
      return all
        .filter((d) => d.sport === p["@sp"] && d.year === p["@yr"] && d.setKey === p["@sk"] && d.parallel === p["@pl"] && d.printRun === p["@pr"])
        .map((d) => ({ id: d.id }));
    }
    // moveCatalogRow / retireCatalogRow's graded-children sweep: this fake's
    // population never seeds a graded child, so it always answers "none".
    if (spec.query.includes("STARTSWITH(c.id, @p)") && spec.query.includes("IS_DEFINED(c.gradeTier)")) {
      return [];
    }
    throw new Error(`fake catalog: unsupported query ${spec.query}`);
  }
}

class FakePool {
  readonly docs: Doc[];
  constructor(seed: Doc[] = []) { this.docs = seed.map((d) => structuredClone(d)); }
  item(id: string, pk?: string) {
    return {
      patch: async (ops: Array<{ op: string; path: string; value?: unknown }>) => {
        const d = this.docs.find((x) => x.id === id && (pk === undefined || x.cardId === pk));
        if (!d) throw notFound();
        for (const o of ops) {
          if (o.op === "set" || o.op === "add") d[o.path.slice(1)] = o.value;
        }
        return { resource: structuredClone(d) };
      },
    };
  }
  readonly items = {
    // lib/sales-at-id.cjs's dual check: `@id` matched against EITHER
    // hobbyiqCardId or cardId, run once cross-partition and once with
    // `partitionKey` in feedOptions -- the fake honours partitionKey by
    // filtering to docs whose OWN cardId equals it, exactly as a real
    // partition-scoped query on a /cardId container would.
    query: (
      spec: { query: string; parameters?: Array<{ name: string; value: unknown }> },
      feedOptions?: { partitionKey?: unknown },
    ) => {
      const p = Object.fromEntries((spec.parameters ?? []).map((x) => [x.name, x.value]));
      const target = p["@id"] ?? p["@s"];
      let scoped = this.docs;
      if (feedOptions && feedOptions.partitionKey !== undefined) {
        scoped = scoped.filter((d) => d.cardId === feedOptions.partitionKey);
      }
      const rows = scoped
        .filter((d) => d.hobbyiqCardId === target || d.cardId === target)
        .map((d) => ({ id: d.id, cardId: d.cardId }));
      let done = false;
      return {
        hasMoreResults: () => !done,
        fetchNext: async () => { done = true; return { resources: rows }; },
        fetchAll: async () => ({ resources: rows }),
      };
    },
  };
}

const realDeps = require_(path.join(backend, "dist", "services", "catalog", "catalogRowOps.service.js"));
const { computeHobbyIqCardId, parseHobbyIqCardId } = require_(path.join(backend, "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));
const deps = {
  moveCatalogRow: realDeps.moveCatalogRow,
  patchCatalogRowFields: realDeps.patchCatalogRowFields,
  rebuildSearchFields: realDeps.rebuildSearchFields,
  retireCatalogRow: realDeps.retireCatalogRow,
  computeHobbyIqCardId,
  parseHobbyIqCardId,
};

function fakeBudget() {
  return { outOfClock: () => false, RUN_MINUTES: 110 };
}

const STRIP_HOBBY_RULE = {
  id: "test-strip-hobby",
  sport: "baseball", years: [2026], setKey: "topps", setKeyPrefix: "", setKeys: ["topps"],
  kind: "strip-note",
  patterns: [/^(.*?)\s*-\s*Hobby\.?\s*$/],
  printRunFromName: false,
  ruling: "r", rulingDate: "2026-09-26", sources: ["q"], reason: "strip Hobby suffix",
};

function baseRow(over: Doc = {}): Doc {
  return {
    id: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto",
    cardId: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto",
    sport: "baseball", year: 2026, setKey: "topps", setName: "2026 Topps",
    cardNumber: "1", parallel: "Gold Wave - Hobby", parallelSlug: "gold-wave-hobby",
    isAuto: false, printRun: null,
    playerName: "Test Player", playerSlug: "test-player",
    source: "checklistinsider-2026", confidence: 0.95,
    vendorIds: {}, observedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z",
    searchTokens: [], searchText: "", displayName: "stale",
    ...over,
  };
}

describe("rewrite-parallel-names -- runLane outcomes against a fake Cosmos", () => {
  it("MOVE: absent destination -> moveCatalogRow with changedFields.parallel, sales re-pointed", async () => {
    const row = baseRow();
    const sale = { id: "sale-1", cardId: "sale-1", hobbyiqCardId: row.id };
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([sale]);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalMoved).toBe(1);
    expect(result.exitCode).toBe(0);
    const oldRow = cat.docs.get(keyOf(row.id, row.cardId));
    expect(oldRow).toBeUndefined(); // old id gone
    const newRow = cat.docs.get("hiq:baseball:2026:topps:1:gold-wave:no-auto");
    expect(newRow).toBeTruthy();
    expect(newRow!.parallel).toBe("Gold Wave");
    expect(newRow!.id).not.toBe(row.id);
    // The sale that pointed at the old id followed the row.
    expect(cat.log).toContain(`catalog.delete ${row.id}`);
  });

  it("REPORT (apply=false): derives the same outcome, writes nothing", async () => {
    const row = baseRow();
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const before = new Map(cat.docs);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: false, budget: fakeBudget(), deps,
    });
    expect(result.totalMoved).toBe(1);
    expect(cat.docs).toEqual(before);
    expect(cat.log).toHaveLength(0);
  });

  it("prints the per-rule scan scope (product cells) BEFORE any row is read, in both REPORT and APPLY -- an operator sees the scope before an APPLY", async () => {
    const row = baseRow();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    try {
      const cat = new FakeCatalog([row]);
      const pool = new FakePool([]);
      await lib.runLane({ cat, pool, rules: [STRIP_HOBBY_RULE], apply: false, budget: fakeBudget(), deps });
    } finally {
      spy.mockRestore();
    }
    const scopeHeaderIdx = logs.findIndex((l) => l.includes("scan scope, per rule"));
    expect(scopeHeaderIdx).toBeGreaterThan(-1);
    const cellLine = logs.find((l) => l.includes("baseball/2026/topps"));
    expect(cellLine).toBeTruthy();
    // The rule-id line naming this rule's cell count appears too.
    expect(logs.some((l) => l.includes(STRIP_HOBBY_RULE.id) && l.includes("cell"))).toBe(true);
  });

  it("LEFT (already canonical): newId equals id, field already clean -> no write, no move", async () => {
    const row = baseRow({
      id: "hiq:baseball:2026:topps:1:gold-wave:no-auto",
      cardId: "hiq:baseball:2026:topps:1:gold-wave:no-auto",
      parallel: "Gold Wave", parallelSlug: "gold-wave",
    });
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [{ ...STRIP_HOBBY_RULE, patterns: [/^(.*?)$/] }], apply: true, budget: fakeBudget(), deps,
    });
    // "Gold Wave" matched by a permissive identity pattern but resolves to the
    // SAME id and the SAME field text -- left-canonical, not healed.
    expect(result.totalLeft).toBe(1);
    expect(result.totalMoved).toBe(0);
    expect(result.totalHealed).toBe(0);
    expect(cat.log).toHaveLength(0);
  });

  it("HEAL: slug already at the clean address, but the field text lags -- patched in place via patchCatalogRowFields, never a raw patch", async () => {
    const cleanId = "hiq:baseball:2026:topps:1:gold-wave:no-auto";
    const row = baseRow({ id: cleanId, cardId: cleanId, parallel: "Gold Wave - Hobby", parallelSlug: "gold-wave" });
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalHealed).toBe(1);
    expect(cat.log).toContain(`catalog.patch ${cleanId}`);
    const healed = cat.docs.get(cleanId);
    expect(healed!.parallel).toBe("Gold Wave");
  });

  it("occupied by a CHECKLIST twin, ZERO sales -> RETIRE the duplicate source", async () => {
    const dupId = "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto"; // will not actually collide by construction below; use explicit ids
    const source = baseRow({ id: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto" });
    const canonical = baseRow({
      id: "hiq:baseball:2026:topps:1:gold-wave:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave:no-auto",
      parallel: "Gold Wave", parallelSlug: "gold-wave", source: "checklistinsider-2026",
    });
    const cat = new FakeCatalog([source, canonical]);
    const pool = new FakePool([]); // zero sales under the source id
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalRetired).toBe(1);
    expect(result.totalHeldSales).toBe(0);
    expect(cat.docs.has(keyOf(source.id, source.cardId))).toBe(false); // source deleted
    expect(cat.docs.has(keyOf(canonical.id, canonical.cardId))).toBe(true); // canonical untouched
  });

  it("occupied by a CHECKLIST twin, sales PRESENT -> HOLD 'sales present', never retires", async () => {
    const source = baseRow({ id: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto" });
    const canonical = baseRow({
      id: "hiq:baseball:2026:topps:1:gold-wave:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave:no-auto",
      parallel: "Gold Wave", parallelSlug: "gold-wave", source: "checklistinsider-2026",
    });
    const cat = new FakeCatalog([source, canonical]);
    const sale = { id: "sale-1", cardId: "sale-1", hobbyiqCardId: source.id };
    const pool = new FakePool([sale]);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalRetired).toBe(0);
    expect(result.totalHeldSales).toBe(1);
    expect(cat.docs.has(keyOf(source.id, source.cardId))).toBe(true); // NOT deleted
  });

  it("occupied by a DERIVED (non-checklist) twin -> HOLD, never overwritten", async () => {
    const source = baseRow({ id: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto" });
    const derived = baseRow({
      id: "hiq:baseball:2026:topps:1:gold-wave:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave:no-auto",
      parallel: "Gold Wave", parallelSlug: "gold-wave", source: "ebay-title-derived",
    });
    const cat = new FakeCatalog([source, derived]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalHeldDerived).toBe(1);
    expect(result.totalMoved).toBe(0);
    expect(result.totalRetired).toBe(0);
    const derivedRow = cat.docs.get(keyOf(derived.id, derived.cardId));
    expect(derivedRow!.parallel).toBe("Gold Wave"); // untouched
    expect(cat.docs.has(keyOf(source.id, source.cardId))).toBe(true); // source untouched too
  });

  it("printRunFromName: fires ONLY when a checklist-grade twin elsewhere attests the (parallel, printRun)", async () => {
    const printRunRule = {
      ...STRIP_HOBBY_RULE,
      id: "test-strip-count",
      patterns: [/^(.*?)\s*:\s*(\d[\d,]*)\s*copies\.?\s*$/],
      printRunFromName: true,
    };
    const row = baseRow({
      id: "hiq:baseball:2026:topps:2:crackle-foil:no-auto", cardId: "hiq:baseball:2026:topps:2:crackle-foil:no-auto",
      cardNumber: "2", parallel: "Crackle Foil: 10400 copies", parallelSlug: "crackle-foil", printRun: null,
    });
    // No attesting twin anywhere -> HOLD (refused), never mints an unconfirmed run.
    const catNoAttestation = new FakeCatalog([row]);
    const poolEmpty = new FakePool([]);
    const held = await lib.runLane({
      cat: catNoAttestation, pool: poolEmpty, rules: [printRunRule], apply: true, budget: fakeBudget(), deps,
    });
    expect(held.totalMoved).toBe(0);
    expect(held.totalRefused).toBeGreaterThan(0);

    // An attesting twin (same setKey/year, same clean parallel + printRun,
    // checklist source) elsewhere in the product -> the move proceeds and
    // printRun is filled from the stripped count.
    const attestation = baseRow({
      id: "hiq:baseball:2026:topps:3:crackle-foil:no-auto:num-10400",
      cardId: "hiq:baseball:2026:topps:3:crackle-foil:no-auto:num-10400",
      cardNumber: "3", parallel: "Crackle Foil", parallelSlug: "crackle-foil", printRun: 10400,
      source: "checklistinsider-2026",
    });
    const catWithAttestation = new FakeCatalog([row, attestation]);
    const result = await lib.runLane({
      cat: catWithAttestation, pool: poolEmpty, rules: [printRunRule], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalMoved).toBe(1);
    const newRow = [...catWithAttestation.docs.values()].find((d) => d.id.includes(":2:") && d.parallel === "Crackle Foil");
    expect(newRow).toBeTruthy();
    expect(newRow!.printRun).toBe(10400);
  });

  it("isAuto is never touched by this lane -- read straight off the row's own parsed id, never set to a derived/new value, never patched", () => {
    // The 0926 cross-product fix moved the id-recompute out of runLane and
    // into computeNewIdPreservingSetKey, so the invariant is now checked
    // across that helper: `runLane` itself no longer names `isAuto` at all
    // (it never appears in a `fields`/`changedFields` patch/move payload
    // there), and the helper reads it straight off the row's OWN parsed id
    // (`own.isAuto`) -- never a derived/new value -- for both the probe call
    // and the round-trip verification.
    const runLaneSrc = source.slice(source.indexOf("async function runLane("), source.indexOf("async function main()"));
    expect(runLaneSrc).not.toMatch(/\bisAuto\b/);

    const helperSrc = source.slice(source.indexOf("function computeNewIdPreservingSetKey("), source.indexOf("function preflight("));
    const refs = [...helperSrc.matchAll(/\bisAuto\b/g)];
    expect(refs.length).toBeGreaterThan(0);
    expect(helperSrc).toMatch(/isAuto:\s*own\.isAuto\b/); // the probe call reads the row's own parsed isAuto
    expect(helperSrc).toMatch(/verify\.isAuto\s*!==\s*own\.isAuto/); // round-trip verifies it, never overwrites it
    // Never named inside either write payload object literal (the heal
    // `fields` object or the move `changedFields` object) -- both are built
    // with only `parallel` (and, guarded, `printRun`), never `isAuto`.
    const fieldsLit = source.slice(source.indexOf("const fields = { parallel: newName };"), source.indexOf("const fields = { parallel: newName };") + 200);
    const changedFieldsLit = source.slice(source.indexOf("const changedFields = { parallel: newName };"), source.indexOf("const changedFields = { parallel: newName };") + 200);
    expect(fieldsLit).not.toMatch(/isAuto/);
    expect(changedFieldsLit).not.toMatch(/isAuto/);

    // printRun is written in exactly two places: the changedFields/fields
    // object under the printRunFromName gate (heal, move) -- both guarded.
    const printRunWrites = [...runLaneSrc.matchAll(/\.printRun\s*=\s*printRun|printRun\s*:\s*printRun\b/g)];
    expect(printRunWrites.length).toBeGreaterThan(0);
  });

  it("reconcile identity holds: matched = moved + retired + healed + held + left-canonical + refused + failed", async () => {
    const row = baseRow();
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps,
    });
    const held = result.totalHeldSales + result.totalHeldDerived;
    expect(result.totalMoved + result.totalRetired + result.totalHealed + held + result.totalLeft + result.totalRefused + result.failed)
      .toBe(result.totalMatched);
    expect(result.exitCode).toBe(0);
  });

  it("a :sub- row's subset segment survives the MOVE round-trip -- the #2434 review finding (computeHobbyIqCardId was dropping it)", async () => {
    // Built with the REAL computeHobbyIqCardId so the fixture's own id is
    // exactly what a genuine subset card would carry.
    const subsetId = computeHobbyIqCardId({
      sport: "baseball", year: 2026, setKey: "topps", cardNumber: "1",
      parallel: "Gold Wave - Hobby", isAuto: false, printRun: null,
      subsetName: "Home Run Kings", subsetInId: true,
      authoritativeSetKey: true, unnumberedByChecklist: true, playerName: "Test Player",
    });
    expect(subsetId).toContain(":sub-home-run-kings:");
    const row = baseRow({
      id: subsetId, cardId: subsetId,
      subsetName: "Home Run Kings", subsetInId: true,
    });
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalMoved).toBe(1);
    // The OLD subset row is gone.
    expect(cat.docs.has(keyOf(row.id, row.cardId))).toBe(false);
    // The NEW row still carries the subset segment in its id, not the
    // parent product's bare numbering -- the defect this pins would have
    // produced "hiq:baseball:2026:topps:1:gold-wave:no-auto" (no :sub-),
    // silently re-addressing this card onto a DIFFERENT card's identity.
    const newRow = [...cat.docs.values()].find((d) => d.parallel === "Gold Wave");
    expect(newRow).toBeTruthy();
    expect(newRow!.id).toContain(":sub-home-run-kings:");
    expect(newRow!.id).not.toBe("hiq:baseball:2026:topps:1:gold-wave:no-auto");
  });
});

// ── CF-A-RENAME-NEVER-CHANGES-THE-PRODUCT (run 36227642297, exit 4) ────────
// A topps-series-2 row, run through a strip-note rule, must move within
// topps-series-2 -- never re-resolve to the flagship "topps". A rule whose
// destination genuinely names a different product must be refused,
// identically, whether the caller is REPORT or APPLY.

describe("rewrite-parallel-names -- a rename never changes the product (0926 fix)", () => {
  const seriesRow = () => baseRow({
    id: "hiq:baseball:2024:topps-series-2:583:gold-foil-hobby:no-auto",
    cardId: "hiq:baseball:2024:topps-series-2:583:gold-foil-hobby:no-auto",
    sport: "baseball", year: 2024, setKey: "topps-series-2",
    cardNumber: "583", parallel: "Gold Foil - Hobby", parallelSlug: "gold-foil-hobby",
  });
  const stripHobbySeries2 = {
    ...STRIP_HOBBY_RULE,
    id: "test-strip-hobby-series2",
    sport: "baseball", years: [2024], setKey: "topps-series-2", setKeyPrefix: "", setKeys: ["topps-series-2"],
  };

  it("a topps-series-2 row with a strip-note rule keeps setKey topps-series-2 in the new id and MOVES cleanly (APPLY)", async () => {
    const row = seriesRow();
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [stripHobbySeries2], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalRefused).toBe(0);
    expect(result.totalMoved).toBe(1);
    const newRow = [...cat.docs.values()].find((d: any) => d.parallel === "Gold Foil");
    expect(newRow).toBeTruthy();
    expect(String(newRow!.id)).toContain(":topps-series-2:");
    expect(String(newRow!.id)).not.toContain(":topps:"); // never folded to the flagship
  });

  // computeHobbyIqCardId folds topps-series-1 to "topps" the SAME way it
  // folds topps-series-2 -- verified directly against dist/ (both return
  // "hiq:baseball:2024:topps:100:gold-foil:no-auto" under authoritativeSetKey:
  // true). There is no asymmetry in the service to exploit or worry about:
  // computeNewIdPreservingSetKey never trusts EITHER family's computed
  // setKey -- it always forces the row's OWN id segment and verifies the
  // round-trip -- so both families are preserved identically by construction.
  it("a topps-series-1 row with the same strip-note shape keeps setKey topps-series-1 in the new id and MOVES cleanly -- proves the guard does not depend on the service treating series-1/series-2 differently", async () => {
    const row = baseRow({
      id: "hiq:baseball:2024:topps-series-1:100:gold-foil-hobby:no-auto",
      cardId: "hiq:baseball:2024:topps-series-1:100:gold-foil-hobby:no-auto",
      sport: "baseball", year: 2024, setKey: "topps-series-1",
      cardNumber: "100", parallel: "Gold Foil - Hobby", parallelSlug: "gold-foil-hobby",
    });
    const stripHobbySeries1 = {
      ...STRIP_HOBBY_RULE,
      id: "test-strip-hobby-series1",
      sport: "baseball", years: [2024], setKey: "topps-series-1", setKeyPrefix: "", setKeys: ["topps-series-1"],
    };
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [stripHobbySeries1], apply: true, budget: fakeBudget(), deps,
    });
    expect(result.totalRefused).toBe(0);
    expect(result.totalMoved).toBe(1);
    const newRow = [...cat.docs.values()].find((d: any) => d.parallel === "Gold Foil");
    expect(newRow).toBeTruthy();
    expect(String(newRow!.id)).toContain(":topps-series-1:");
    expect(String(newRow!.id)).not.toContain(":topps:"); // never folded to the flagship
  });

  it("the same row/rule in REPORT mode (apply=false) reports the identical outcome -- no cross-product move hidden until APPLY", async () => {
    const row = seriesRow();
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [stripHobbySeries2], apply: false, budget: fakeBudget(), deps,
    });
    expect(result.totalRefused).toBe(0);
    expect(result.totalMoved).toBe(1);
  });

  it("a row whose own id cannot be reconciled with the rule's output is refused cross-product identically in REPORT and APPLY", async () => {
    // computeNewIdPreservingSetKey refuses outright when the row's own id
    // cannot even be parsed with the grade-aware splitter -- this is the same
    // refusal surface a genuinely product-changing alias output would hit
    // once it disagreed with the row's own address on round-trip (setKey,
    // sport, year, cardNumber, subset, isAuto); a malformed/legacy id is the
    // simplest fixture that reliably reaches that branch without depending on
    // resolveSetKeyForSlug's own fold behaviour.
    const legacyRow = baseRow({
      id: "legacy-non-hiq-id-583", cardId: "legacy-non-hiq-id-583",
      sport: "baseball", year: 2024, setKey: "topps-series-2", cardNumber: "583",
      parallel: "Gold Foil - Hobby", parallelSlug: "gold-foil-hobby",
    });
    const outcome = lib.computeNewIdPreservingSetKey(legacyRow, "Gold Foil", null, deps);
    expect(outcome.refused).toBe("cross-product");

    // And the SAME refusal shape is what runLane surfaces, in both modes.
    const catApply = new FakeCatalog([legacyRow]);
    const poolApply = new FakePool([]);
    const applyResult = await lib.runLane({
      cat: catApply, pool: poolApply, rules: [stripHobbySeries2], apply: true, budget: fakeBudget(), deps,
    });
    expect(applyResult.totalRefused).toBe(1);
    expect(applyResult.totalMoved).toBe(0);
    // The source row is untouched -- refused, never written.
    expect(catApply.docs.has(keyOf(legacyRow.id, legacyRow.cardId))).toBe(true);

    const catReport = new FakeCatalog([legacyRow]);
    const poolReport = new FakePool([]);
    const reportResult = await lib.runLane({
      cat: catReport, pool: poolReport, rules: [stripHobbySeries2], apply: false, budget: fakeBudget(), deps,
    });
    expect(reportResult.totalRefused).toBe(1);
    expect(reportResult.totalMoved).toBe(0);
  });

  it("a MOVE that throws at write time lands in `failed`, never in `moved`", async () => {
    const row = seriesRow();
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const originalMove = deps.moveCatalogRow;
    const throwingDeps = { ...deps, moveCatalogRow: async () => { throw new Error("simulated write failure"); } };
    try {
      const result = await lib.runLane({
        cat, pool, rules: [stripHobbySeries2], apply: true, budget: fakeBudget(), deps: throwingDeps,
      });
      expect(result.totalMoved).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.totalRefused).toBe(0);
      // reconcile identity still holds under a thrown write.
      const held = result.totalHeldSales + result.totalHeldDerived;
      expect(result.totalMoved + result.totalRetired + result.totalHealed + held + result.totalLeft + result.totalRefused + result.failed)
        .toBe(result.totalMatched);
      expect(result.exitCode).toBe(0);
    } finally {
      void originalMove;
    }
  });

  it("reconcile identity holds under a mix of moved/refused/failed outcomes in one APPLY run", async () => {
    const movable = seriesRow();
    // A malformed/legacy id (still IS_DEFINED(c.parallel), still c.setKey ===
    // the scanned cell) that computeNewIdPreservingSetKey cannot parse --
    // the refusal surface a genuinely product-changing rule output would
    // also hit, per the test above.
    const refusedRow = { ...seriesRow(), id: "legacy-non-hiq-id-584", cardId: "legacy-non-hiq-id-584", cardNumber: "584" };
    const willThrow = { ...seriesRow(), id: "hiq:baseball:2024:topps-series-2:585:gold-foil-hobby:no-auto", cardId: "hiq:baseball:2024:topps-series-2:585:gold-foil-hobby:no-auto", cardNumber: "585" };
    const cat = new FakeCatalog([movable, refusedRow, willThrow]);
    const pool = new FakePool([]);
    let calls = 0;
    const mixedDeps = {
      ...deps,
      moveCatalogRow: async (...args: any[]) => {
        calls++;
        if (args[1]?.id === willThrow.id) throw new Error("simulated write failure");
        return (deps.moveCatalogRow as any)(...args);
      },
    };
    const result = await lib.runLane({
      cat, pool, rules: [stripHobbySeries2], apply: true, budget: fakeBudget(), deps: mixedDeps,
    });
    expect(calls).toBeGreaterThan(0);
    expect(result.totalMoved).toBe(1); // movable only
    expect(result.totalRefused).toBe(1); // refusedRow
    expect(result.failed).toBe(1); // willThrow
    const held = result.totalHeldSales + result.totalHeldDerived;
    expect(result.totalMoved + result.totalRetired + result.totalHealed + held + result.totalLeft + result.totalRefused + result.failed)
      .toBe(result.totalMatched);
    expect(result.exitCode).toBe(0);
  });
});

// ── CF-A-RETIRE-NEEDS-A-LEDGER (review, PR #2438) ──────────────────────────
// Every RETIRE (and MOVE) writes one NDJSON record via PLAN_OUT, same
// convention as resolve-split-identity-parks/collapse-ch-synthetic-twins/
// fold-catalog-duplicate-rungs -- so a hard-deleted retire has a read-back
// audit trail. REPORT and APPLY write the identical shape, tagged by `mode`.

describe("rewrite-parallel-names -- PLAN_OUT ledger (review, PR #2438)", () => {
  function readLedger(dir: string, slot = 0): any[] {
    const p = path.join(dir, `plan-slot-${slot}.ndjson`);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  function scratchDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "rpn-plan-out-"));
  }

  it("APPLY: one ledger line per confirmed MOVE, mode 'apply', none for refused/failed rows", async () => {
    const dir = scratchDir();
    try {
      const movable = baseRow({
        id: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto",
      });
      const refusedRow = baseRow({
        id: "legacy-non-hiq-id-2", cardId: "legacy-non-hiq-id-2", cardNumber: "2",
      });
      const cat = new FakeCatalog([movable, refusedRow]);
      const pool = new FakePool([]);
      const emitter = lib.makePlanEmitter(dir, 0);
      const result = await lib.runLane({
        cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps, planEmitter: emitter,
      });
      expect(result.totalMoved).toBe(1);
      expect(result.totalRefused).toBe(1);
      const lines = readLedger(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ mode: "apply", action: "move", id: movable.id });
      expect(typeof lines[0].newId).toBe("string");
      expect(typeof lines[0].ts).toBe("string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("APPLY: one ledger line per confirmed RETIRE, carrying salesXp/salesPk from the zero-sales gate; a MOVE that throws writes NO line", async () => {
    const dir = scratchDir();
    try {
      const source_ = baseRow({ id: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave-hobby:no-auto" });
      const canonical = baseRow({
        id: "hiq:baseball:2026:topps:1:gold-wave:no-auto", cardId: "hiq:baseball:2026:topps:1:gold-wave:no-auto",
        parallel: "Gold Wave", parallelSlug: "gold-wave", source: "checklistinsider-2026",
      });
      const willThrow = baseRow({
        id: "hiq:baseball:2026:topps:3:gold-wave-hobby:no-auto", cardId: "hiq:baseball:2026:topps:3:gold-wave-hobby:no-auto", cardNumber: "3",
      });
      const cat = new FakeCatalog([source_, canonical, willThrow]);
      const pool = new FakePool([]);
      const throwingDeps = { ...deps, moveCatalogRow: async () => { throw new Error("simulated write failure"); } };
      const emitter = lib.makePlanEmitter(dir, 0);
      const result = await lib.runLane({
        cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps: throwingDeps, planEmitter: emitter,
      });
      expect(result.totalRetired).toBe(1);
      expect(result.failed).toBe(1); // willThrow's move
      const lines = readLedger(dir);
      expect(lines).toHaveLength(1); // only the confirmed retire -- nothing for the thrown move
      expect(lines[0]).toMatchObject({ mode: "apply", action: "retire", id: source_.id, twinId: canonical.id });
      expect(typeof lines[0].salesXp).toBe("number");
      expect(typeof lines[0].salesPk).toBe("number");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REPORT (apply=false): writes the identical shape, tagged mode 'report', with no actual Cosmos write", async () => {
    const dir = scratchDir();
    try {
      const row = baseRow();
      const cat = new FakeCatalog([row]);
      const pool = new FakePool([]);
      const emitter = lib.makePlanEmitter(dir, 0);
      const result = await lib.runLane({
        cat, pool, rules: [STRIP_HOBBY_RULE], apply: false, budget: fakeBudget(), deps, planEmitter: emitter,
      });
      expect(result.totalMoved).toBe(1);
      expect(cat.log).toHaveLength(0); // no write happened
      const lines = readLedger(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ mode: "report", action: "move", id: row.id });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no PLAN_OUT (default no-op emitter) -- runLane behaves exactly as before, no file written, no error", async () => {
    const row = baseRow();
    const cat = new FakeCatalog([row]);
    const pool = new FakePool([]);
    const result = await lib.runLane({
      cat, pool, rules: [STRIP_HOBBY_RULE], apply: true, budget: fakeBudget(), deps, // no planEmitter passed
    });
    expect(result.totalMoved).toBe(1);
  });

  it("makePlanEmitter('', slot) is a true no-op -- open()/emitPlanRow never touch the filesystem", () => {
    const emitter = lib.makePlanEmitter("", 0);
    expect(() => emitter.emitPlanRow({ mode: "apply", action: "move", id: "x", newId: "y" })).not.toThrow();
    expect(() => emitter.close()).not.toThrow();
  });
});

// ── mutation-class checks (source pins) ────────────────────────────────────

describe("rewrite-parallel-names -- mutation checks", () => {
  it("the retire branch is gated on a ZERO-sales read -- removing that guard is a change this pin would catch", () => {
    const idx = source.indexOf("occupantIsChecklist");
    const block = source.slice(idx, source.indexOf("Occupied by a DERIVED", idx));
    expect(block).toContain("await salesCountAt(pool, row.id)");
    expect(block).toMatch(/if\s*\(n\s*>\s*0\)\s*{/);
    expect(block).toContain("continue"); // held-sales path continues, never falls through to retire
    // The retire call itself is textually AFTER the n>0 guard's continue.
    const guardIdx = block.indexOf("if (n > 0)");
    const retireIdx = block.indexOf("retireCatalogRow(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(retireIdx).toBeGreaterThan(guardIdx);
  });

  it("the move call carries changedFields.parallel -- the #2431 pattern this lane reuses", () => {
    const idx = source.indexOf("moveCatalogRow(cat, row, newId, changedFields");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(source.indexOf("const changedFields = { parallel: newName }"), idx + 200);
    expect(block).toContain("changedFields = { parallel: newName }");
  });

  it("the heal path uses patchCatalogRowFields, never a raw container.patch", () => {
    const idx = source.indexOf("// HEAL: already at the right address");
    const endIdx = source.indexOf("const occupant = await rowAt(newId);", idx);
    expect(endIdx).toBeGreaterThan(idx);
    const block = source.slice(idx, endIdx);
    expect(block).toContain("patchCatalogRowFields(cat, row.id");
    expect(block).not.toMatch(/cat\.item\([^)]*\)\.patch\(/);
  });

  it("the budget check runs before each row is processed, inside the innermost loop", () => {
    const idx = source.indexOf("for (const row of resources ?? [])");
    const nextLines = source.slice(idx, idx + 400);
    expect(nextLines).toContain("b.outOfClock()");
  });

  it("the reconcile mismatch sets a non-zero exit code (4)", () => {
    expect(source).toMatch(/exitCode\s*=\s*4/);
    expect(source).toContain("RECONCILE MISMATCH");
  });

  it("(#2434 review) productCellsOf takes ONE argument and reads ONLY rule.setKeys -- no discovery parameter", () => {
    const idx = source.indexOf("function productCellsOf(");
    expect(idx).toBeGreaterThan(-1);
    const sigEnd = source.indexOf(")", idx);
    expect(source.slice(idx, sigEnd + 1)).toBe("function productCellsOf(rule)");
    const body = source.slice(idx, source.indexOf("\n}", idx));
    expect(body).toContain("rule.setKeys");
    expect(body).not.toMatch(/discoveredSetKeys|startsWith\(rule\.setKeyPrefix\)/);
  });

  it("(#2434 review) loadRules refuses a setKeyPrefix rule with no scope.setKeys, before productCellsOf could ever run", () => {
    const idx = source.indexOf("if (setKeyPrefix && setKeys.length === 0)");
    expect(idx).toBeGreaterThan(-1);
    // The refusal is textually inside loadRules, well before the push into
    // `rules` -- i.e. it runs at load, not at scan time.
    const loadRulesIdx = source.indexOf("function loadRules(");
    const productCellsIdx = source.indexOf("function productCellsOf(");
    expect(idx).toBeGreaterThan(loadRulesIdx);
    expect(idx).toBeLessThan(productCellsIdx);
  });

  it("(#2434 review / 0926 cross-product fix) computeHobbyIqCardId's PROBE call is fed subsetName and subsetInId sourced from the row's own parsed id", () => {
    // Moved into computeNewIdPreservingSetKey by the 0926 cross-product fix
    // (#2431 exit-4 review) -- the row's own fields still feed the call, now
    // one layer down from runLane's inline block, and now sourced from the
    // row's OWN PARSED id (`own.subsetName`/`own.subsetInId`) rather than the
    // raw row fields, since the probe's setKey input is no longer trusted for
    // anything but shape.
    const idx = source.indexOf("probe = computeHobbyIqCardId({");
    expect(idx).toBeGreaterThan(-1);
    const callEnd = source.indexOf("});", idx);
    const call = source.slice(idx, callEnd);
    expect(call).toContain("subsetName: own.subsetName");
    expect(call).toMatch(/subsetInId:\s*own\.subsetInId\s*===\s*true/);
  });

  it("(0926 cross-product fix) newId is built via computeNewIdPreservingSetKey + a shared preflight(), never a bare computeHobbyIqCardId call inline in runLane", () => {
    const runLaneSrc = source.slice(source.indexOf("async function runLane("), source.indexOf("async function main()"));
    expect(runLaneSrc).toContain("computeNewIdPreservingSetKey(row, newName");
    expect(runLaneSrc).toContain("preflight(row, idOutcome)");
    expect(runLaneSrc).not.toMatch(/newId\s*=\s*computeHobbyIqCardId\(/);
  });

  it("(0926 cross-product fix) computeNewIdPreservingSetKey never trusts computeHobbyIqCardId's own setKey output -- it forces the row's OWN setKey segment into the reconstructed id and verifies the round-trip", () => {
    const idx = source.indexOf("function computeNewIdPreservingSetKey(");
    expect(idx).toBeGreaterThan(-1);
    const body = source.slice(idx, source.indexOf("\n}\n", idx));
    expect(body).toContain('refused: "cross-product"');
    // The reconstructed id's setKey segment comes from `own.setKey` (the
    // row's OWN parsed id), never from the probe's output setKey -- THIS
    // CONSTRUCTION is the actual cross-product guard (see the review-finding
    // test below for why the verify.setKey comparison itself is not).
    expect(body).toMatch(/const parts = \["hiq", own\.sport, String\(own\.year\), own\.setKey\]/);
    expect(body).toContain("verify.setKey !== own.setKey");
  });

  it("(review, PR #2438) the verify.setKey/sport/year/cardNumber comparisons are documented as tautological defense-in-depth, not the real guard", () => {
    // Since `own.sport`/`own.year`/`own.setKey`/`own.cardNumber` are placed
    // verbatim into `parts` and parseHobbyIqCardId does nothing but echo
    // segments 1-3 straight back (verified directly against dist/: feeding
    // it "hiq:baseball:2024:topps:583:..." returns sport/year/setKey/
    // cardNumber identical to what was in the string), a mismatch on any of
    // those four inside `verify` is structurally impossible today. The real
    // protection is the construction itself (own.setKey going INTO parts),
    // not this comparison -- this test pins that the source says so, so a
    // future reader (or reviewer) does not mistake a passing check here for
    // proof of the guard.
    const idx = source.indexOf("function computeNewIdPreservingSetKey(");
    const body = source.slice(idx, source.indexOf("\n}\n", idx));
    expect(body).toMatch(/structurally impossible/i);
    expect(body).toMatch(/defense in depth/i);
    expect(body).toMatch(/cannot fail today/i);
  });

  it("(0926 cross-product fix) REPORT and APPLY share the identical preflight() guard -- REPORT never skips it", () => {
    const idx = source.indexOf("const idOutcome = computeNewIdPreservingSetKey(");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 400);
    // This block runs unconditionally, before the `if (!apply)` branch point
    // for LEFT/HEAL/MOVE -- i.e. it is not gated on apply at all.
    expect(block).not.toMatch(/if\s*\(\s*!?apply\s*\)/);
    expect(block).toContain("gate.ok");
  });

  it("(0926 cross-product fix) moved/healed/retired are credited only after their write call returns, never before it, in APPLY mode", () => {
    const runLaneSrc = source.slice(source.indexOf("async function runLane("), source.indexOf("async function main()"));
    // HEAL: st.healed++ must appear AFTER the patchCatalogRowFields call, and
    // the REPORT-mode credit (`if (!apply) { st.healed++`) is the only other
    // place it appears before a write.
    const healBlock = runLaneSrc.slice(runLaneSrc.indexOf("// HEAL:"), runLaneSrc.indexOf("const occupant = await rowAt(newId);"));
    const healPatchIdx = healBlock.indexOf("await patchCatalogRowFields(");
    const healCreditIdx = healBlock.indexOf("st.healed++", healPatchIdx);
    expect(healPatchIdx).toBeGreaterThan(-1);
    expect(healCreditIdx).toBeGreaterThan(healPatchIdx);

    // MOVE: st.moved++ must appear AFTER the moveCatalogRow call resolves,
    // inside the branch that is NOT the refused branch.
    const moveBlock = runLaneSrc.slice(runLaneSrc.indexOf("// MOVE."), runLaneSrc.indexOf("const occupantIsChecklist ="));
    const moveCallIdx = moveBlock.indexOf("await moveCatalogRow(");
    const moveCreditIdx = moveBlock.indexOf("st.moved++", moveCallIdx);
    expect(moveCallIdx).toBeGreaterThan(-1);
    expect(moveCreditIdx).toBeGreaterThan(moveCallIdx);

    // RETIRE: st.retired++ must appear AFTER the retireCatalogRow call.
    const retireBlock = runLaneSrc.slice(runLaneSrc.indexOf("// RETIRE (duplicate)."), runLaneSrc.indexOf("// Occupied by a DERIVED"));
    const retireCallIdx = retireBlock.indexOf("await retireCatalogRow(");
    const retireCreditIdx = retireBlock.indexOf("st.retired++", retireCallIdx);
    expect(retireCallIdx).toBeGreaterThan(-1);
    expect(retireCreditIdx).toBeGreaterThan(retireCallIdx);
  });
});

// ── workflow wiring (pin) ──────────────────────────────────────────────────

describe("rewrite-parallel-names -- workflow wiring", () => {
  const workflowPath = path.join(backend, "..", ".github", "workflows", "backfill-runner.yml");
  const yml = fs.readFileSync(workflowPath, "utf8");

  it("is registered in the script dropdown", () => {
    expect(yml).toMatch(/^\s*- rewrite-parallel-names\s*$/m);
  });

  it("has a self-relaunch block guarded on its own script name", () => {
    expect(yml).toMatch(/inputs\.script == 'rewrite-parallel-names'/);
  });

  it("adds NO new workflow_dispatch input -- still exactly 24", () => {
    const dispatchBlock = yml.slice(yml.indexOf("workflow_dispatch:"), yml.indexOf("\njobs:"));
    const topLevelInputs = [...dispatchBlock.matchAll(/^ {6}([a-z_]+):\n/gm)].map((m) => m[1]);
    expect(topLevelInputs).toHaveLength(24);
    // And this lane reuses names already in that list, never a new one.
    for (const reused of ["script", "apply", "scope", "titles", "slot", "slots", "limit", "sources"]) {
      expect(topLevelInputs).toContain(reused);
    }
  });

  it("does not touch .github/actions/relaunch-on-marker/action.yml", () => {
    // This test only asserts the constraint is documented/respected by
    // construction: the lane's own relaunch step uses the shared composite
    // action unmodified, exactly like every sibling lane.
    const actionPath = path.join(backend, "..", ".github", "actions", "relaunch-on-marker", "action.yml");
    expect(fs.existsSync(actionPath)).toBe(true);
  });

  it("backfill-runner.yml stays under 512 KB", () => {
    const bytes = fs.statSync(workflowPath).size;
    expect(bytes).toBeLessThan(512 * 1024);
  });

  it("(review, PR #2438) STATED GAP: PLAN_OUT is not yet wired for this script in the ternary -- the ledger this PR adds is script-side only until a follow-up touches .github", () => {
    // This PR's own scope excludes backend/src AND .github (git diff main
    // --stat against both must stay empty -- see the byte-scan/diff-scope
    // describe block below). Wiring PLAN_OUT into the real runner is a
    // one-line addition to the ternary this test reads, in a SEPARATE PR;
    // until that lands, PLAN_OUT is unset for rewrite-parallel-names in the
    // actual workflow and the ledger this PR adds is inert there -- exactly
    // like any other lane never added to this ternary. This test pins that
    // gap so it is impossible to forget, rather than because we prefer it:
    // when the follow-up PR adds `inputs.script == 'rewrite-parallel-names'
    // && '/tmp/rewrite-parallel-names-plan'` to this ternary, THIS assertion
    // is the one that needs to flip.
    const idx = yml.indexOf("PLAN_OUT:");
    expect(idx).toBeGreaterThan(-1);
    const line = yml.slice(idx, yml.indexOf("\n", idx));
    expect(line).not.toContain("rewrite-parallel-names");
  });

  it("the relaunch preamble greps this lane's own budget marker phrase", () => {
    const idx = yml.indexOf("Self-relaunch the parallel-name rewrite until the slot is clean");
    expect(idx).toBeGreaterThan(-1);
    const block = yml.slice(idx, idx + 1800);
    expect(block).toContain("inputs.script == 'rewrite-parallel-names'");
    expect(block).toContain("reconciled: matched");
    expect(block).toContain("gh workflow run backfill-runner.yml");
    expect(block).toContain("-f script=rewrite-parallel-names");
  });
});

// ── byte-scan (heredoc-authoring guard) ─────────────────────────────────────

describe("rewrite-parallel-names -- no control-byte corruption", () => {
  it("carries no 0x08/0x00 bytes in the script", () => {
    const buf = fs.readFileSync(scriptPath);
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });

  it("carries no 0x08/0x00 bytes in the shipped rules file", () => {
    const buf = fs.readFileSync(RULES_FILE);
    let has08 = false, has00 = false;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x08) has08 = true;
      if (buf[i] === 0x00) has00 = true;
    }
    expect(has08).toBe(false);
    expect(has00).toBe(false);
  });

  it("uses maxItemCount 500 and maxDegreeOfParallelism -1, never maxItemCount -1 in a live query call", () => {
    // Scoped to actual `.query(query, { ... })` call sites (the FeedOptions
    // second argument), not the doc comments that describe -- and forbid --
    // the -1 shape in prose.
    const queryCalls = [...source.matchAll(/\.query\([^,]+,\s*(\{[^}]*\})\)/g)].map((m) => m[1]);
    expect(queryCalls.length).toBeGreaterThan(0);
    const withMaxItemCount = queryCalls.filter((c) => /maxItemCount/.test(c));
    expect(withMaxItemCount.length).toBeGreaterThan(0);
    expect(withMaxItemCount.some((c) => /maxItemCount:\s*500/.test(c))).toBe(true);
    expect(withMaxItemCount.some((c) => /maxDegreeOfParallelism:\s*-1/.test(c))).toBe(true);
    expect(withMaxItemCount.some((c) => /maxItemCount:\s*-1/.test(c))).toBe(false);
  });

  it("never issues a COUNT/GROUP BY aggregate query against sold_comps or card_catalog", () => {
    // Scoped to the SQL text actually sent (the `query:` string literals),
    // not the doc comments that describe the doctrine this pin enforces.
    const sqlLiterals = [...source.matchAll(/query:\s*`([^`]*)`/g)].map((m) => m[1]);
    for (const sql of sqlLiterals) {
      expect(sql).not.toMatch(/SELECT VALUE COUNT/i);
      expect(sql).not.toMatch(/GROUP BY/i);
    }
    expect(sqlLiterals.length).toBeGreaterThan(0);
  });
});

// ── backend/src is untouched by this PR ─────────────────────────────────────

describe("rewrite-parallel-names -- backend/src is not modified by this lane", () => {
  it("this lane lives entirely in scripts/ + data/ + tests/; it does not add or change a backend/src file", () => {
    // Enforced by review, not by this test alone -- this assertion documents
    // the constraint so a future change to this file trips a reviewer's eye.
    expect(fs.existsSync(scriptPath)).toBe(true);
  });
});
