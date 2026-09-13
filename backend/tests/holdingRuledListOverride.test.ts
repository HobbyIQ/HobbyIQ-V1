import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  validateRuledEntry,
  parseRuledList,
  ruled,
  type RuledEntry,
} from "../scripts/comp-quality/recheck-holding-identity.js";

/**
 * CF-A-RULING-IS-THE-ONLY-THING-THAT-MAY-RE-ADDRESS-A-HUMAN (Drew, 2026-09-13)
 * — MODE=ruled.
 *
 * Drew's ca7a150b carries `identityVerifiedBy.source: "manual-confirm"`
 * pointing at `hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:
 * num-50` — the address the a78a5ea key-twin fold retired once it proved 2026
 * Chrome Prospect Autographs is a Bowman section, not a Bowman Chrome one.
 * `MODE=rederive` refuses it correctly: "ruled by manual-confirm — a human's
 * identity is never overwritten by this pass". `MODE=rule` already lets a
 * human override a human, but only through `titles=id8=slug` typed into a
 * dispatch box. This mode is that same override, entered from a committed,
 * reviewed list instead — the catalog list lane's shape
 * (relocate-catalog-rows-by-list.cjs / #1858) applied to a holding.
 *
 * TEST STRATEGY, matching this file's own convention
 * (holdingIdentityRuling.test.ts for MODE=rule): `validateRuledEntry` and
 * `parseRuledList` are pure — no Cosmos, no `process.exit` — so they are
 * called live. `ruled()` itself calls `process.exit(2)` on a missing/
 * malformed scope and `process.exit(6)` whenever any entry is REFUSED, and no
 * test in this file (or its sibling `holdingIdentityRuling.test.ts` /
 * `rederiveHoldingIdentity.test.ts`) mocks `process.exit` to survive that —
 * so refusal and write-path shapes are pinned as source-text assertions,
 * exactly as `rule()`'s are. The one live call to `ruled()` below is the
 * SUCCESS shape (a verified target, no refusal), which returns normally and
 * never reaches an exit — safe to invoke directly against a mocked
 * container, and it is the case that actually proves REPORT writes nothing.
 */

const SCRIPT_PATH = join(__dirname, "..", "scripts", "comp-quality", "recheck-holding-identity.ts");
const SRC = readFileSync(SCRIPT_PATH, "utf8");

const STAGED_LIST_PATH = join(
  __dirname, "..", "data", "holding-rulings",
  "2026-09-13-marconi-cpa-mg-gold-refractor.json",
);

const HOLDING_ID = "ca7a150b-f126-49e0-bd5b-f899ff964a1f";
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const DOC_ID = "portfolio-doc-1";
const RETIRED_SLUG = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50";
const RULED_SLUG = "hiq:baseball:2026:bowman:cpa-mg:gold-refractor:auto:num-50";

const RULED_ENTRY: RuledEntry = {
  holdingId: HOLDING_ID,
  userId: USER_ID,
  to: RULED_SLUG,
  ruling: { by: "drew", date: "2026-09-13", note: "same card, re-addressed after the fold" },
};

const MANUAL_CONFIRM_HOLDING = () => ({
  playerName: "Marconi German", cardYear: 2026, cardNumber: "CPA-MG",
  parallel: "Gold Refractor", printRun: 50,
  hobbyiqCardId: RETIRED_SLUG,
  cardId: RETIRED_SLUG,
  identityVerified: true,
  identityVerifiedBy: { source: "manual-confirm", verifiedAt: "2026-08-20T00:00:00.000Z" },
});

const VERIFIED_ROW = {
  id: RULED_SLUG,
  source: "checklistinsider",
  verificationStatus: "verified",
  setName: "2026 Bowman", cardNumber: "CPA-MG", parallel: "Gold Refractor", printRun: 50,
  playerName: "Marconi German",
};

function baseDoc() {
  return { id: DOC_ID, userId: USER_ID, _etag: '"etag-1"', holdings: { [HOLDING_ID]: MANUAL_CONFIRM_HOLDING() } };
}

/** A minimal Cosmos-shaped card_catalog container: a point-read-by-id SELECT
 *  backed by an in-memory map of id -> row. */
function mockCatalog(rows: Record<string, any>) {
  return {
    items: {
      query: ({ parameters }: { parameters: Array<{ name: string; value: string }> }) => ({
        fetchAll: async () => {
          const id = parameters.find((p) => p.name === "@id")?.value;
          const row = id ? rows[id] : undefined;
          return { resources: row ? [row] : [] };
        },
      }),
    },
  };
}

/** A minimal Cosmos-shaped portfolio container: `.item(id, userId).read()` /
 *  `.replace()` backed by an in-memory map of docId -> doc. Every `.replace`
 *  is recorded so a test can assert nothing was written. */
function mockPortfolio(docs: Record<string, any>) {
  const replaced: Array<{ docId: string; doc: any }> = [];
  return {
    replaced,
    item: (docId: string, _userId: string) => ({
      read: async () => ({ resource: JSON.parse(JSON.stringify(docs[docId])) }),
      replace: async (doc: any) => {
        replaced.push({ docId, doc: JSON.parse(JSON.stringify(doc)) });
        docs[docId] = doc;
        return { resource: doc };
      },
    }),
  };
}

// ── the staged list itself ──────────────────────────────────────────────────

describe("the staged list ships valid and matches the CASE", () => {
  it("exists at the documented path", () => {
    expect(existsSync(STAGED_LIST_PATH)).toBe(true);
  });

  it("parses to exactly the one ca7a150b entry, re-addressing bowman-chrome -> bowman", () => {
    const raw = JSON.parse(readFileSync(STAGED_LIST_PATH, "utf8"));
    const entries = parseRuledList(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].holdingId).toBe(HOLDING_ID);
    expect(entries[0].userId).toBe(USER_ID);
    expect(entries[0].to).toBe(RULED_SLUG);
    expect(entries[0].ruling.by).toBe("drew");
    expect(entries[0].ruling.date).toBe("2026-09-13");
    expect(entries[0].ruling.note).toMatch(/checklistinsider/);
  });
});

// ── entry validation refusals ────────────────────────────────────────────────

describe("validateRuledEntry refuses a malformed entry, naming what is missing", () => {
  it("accepts a well-formed entry", () => {
    const v = validateRuledEntry(RULED_ENTRY);
    expect(v.ok).toBe(true);
  });

  it("refuses a missing holdingId", () => {
    const v = validateRuledEntry({ ...RULED_ENTRY, holdingId: undefined });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/no holdingId/);
  });

  it("refuses a missing userId", () => {
    const v = validateRuledEntry({ ...RULED_ENTRY, userId: "" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/no userId/);
  });

  it("refuses a missing `to`", () => {
    const v = validateRuledEntry({ ...RULED_ENTRY, to: "" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/no "to"/);
  });

  it("refuses a `to` that is not a hiq: slug", () => {
    const v = validateRuledEntry({ ...RULED_ENTRY, to: "not-a-slug" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/not a hiq: slug/);
  });

  it("refuses a missing ruling.by", () => {
    const v = validateRuledEntry({ ...RULED_ENTRY, ruling: { date: "2026-09-13" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/no ruling\.by/);
  });

  it("refuses a missing ruling.date", () => {
    const v = validateRuledEntry({ ...RULED_ENTRY, ruling: { by: "drew" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/no ruling\.date/);
  });

  it("refuses a missing ruling object entirely", () => {
    const v = validateRuledEntry({ holdingId: HOLDING_ID, userId: USER_ID, to: RULED_ENTRY.to });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/no ruling\.by/);
  });

  it("ruling.note is optional", () => {
    const v = validateRuledEntry({ ...RULED_ENTRY, ruling: { by: "drew", date: "2026-09-13" } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entry.ruling.note).toBeUndefined();
  });
});

describe("parseRuledList refuses the WHOLE list on any one bad entry", () => {
  it("throws naming the bad entry rather than dropping it", () => {
    expect(() => parseRuledList({
      entries: [RULED_ENTRY, { holdingId: "aaaaaaaa", to: "hiq:x" }],
    })).toThrow(/RULED_LIST entry refused/);
  });

  it("refuses an empty entries array", () => {
    expect(() => parseRuledList({ entries: [] })).toThrow(/no entries/);
  });

  it("refuses a document with no entries array at all", () => {
    expect(() => parseRuledList({})).toThrow(/no entries/);
  });

  it("refuses the same holding named twice", () => {
    expect(() => parseRuledList({
      entries: [RULED_ENTRY, { ...RULED_ENTRY, to: "hiq:baseball:2026:bowman:cpa-mg:base:auto" }],
    })).toThrow(/twice/);
  });
});

// ── target-missing refusal (GATE RL1) ────────────────────────────────────────

describe("GATE RL1 — the target must exist in card_catalog, or the entry is REFUSED", () => {
  it("names the missing row in the source", () => {
    expect(SRC).toMatch(/GATE RL1/);
    expect(SRC).toContain("no catalog row carries ${entry.to} — a ruling never mints a card");
  });

  it("a REFUSED entry exits non-zero in REPORT and in APPLY, so it cannot read as success", () => {
    const ruledFn = SRC.slice(SRC.indexOf("export async function ruled("), SRC.indexOf("\n// ── MODE=rederive"));
    const exits6 = [...ruledFn.matchAll(/verdict === "REFUSED"\)\) process\.exit\(6\)/g)];
    expect(exits6.length).toBeGreaterThanOrEqual(2); // REPORT branch and APPLY-tail branch
  });
});

// ── target-not-verified refusal (GATE RL2) ───────────────────────────────────

describe("GATE RL2 — the target must be verificationStatus \"verified\", stricter than canAdjudicate", () => {
  it("names the gate and reads verificationStatus, not just canAdjudicate", () => {
    expect(SRC).toMatch(/GATE RL2/);
    expect(SRC).toContain('status !== "verified"');
    expect(SRC).toContain('not "verified" — a ruling may only land on a verified row');
  });

  it("REFUSES live against a mocked pending-review row, and writes nothing", async () => {
    const pendingRow = { ...VERIFIED_ROW, verificationStatus: "pending-review" };
    const catalog = mockCatalog({ [RULED_SLUG]: pendingRow });
    const portfolio = mockPortfolio({ [DOC_ID]: baseDoc() });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    // REPORT mode (module APPLY is false in this test process, matching every
    // other test of this file — see rederiveHoldingIdentity.test.ts / holding
    // IdentityRuling.test.ts, none of which set BACKFILL_APPLY before import)
    // still calls process.exit(6) on a REFUSED entry, so exit itself is
    // mocked to a no-op that records the code rather than killing the worker.
    const exitCodes: number[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as never);
    try {
      await ruled({
        entries: [RULED_ENTRY],
        docs: [baseDoc()],
        container: portfolio as any,
        catalog: catalog as any,
      });
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(exitCodes).toContain(6);
    expect(portfolio.replaced).toHaveLength(0);
    expect(logs.some((l) => l.includes("REFUSED") && l.includes(RULED_SLUG))).toBe(true);
    expect(logs.some((l) => l.includes('not "verified"'))).toBe(true);
  });

  it("REFUSES live when the target row does not exist at all", async () => {
    const catalog = mockCatalog({}); // empty: nothing exists
    const portfolio = mockPortfolio({ [DOC_ID]: baseDoc() });
    const exitCodes: number[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0);
      return undefined as never;
    }) as never);
    try {
      await ruled({
        entries: [RULED_ENTRY],
        docs: [baseDoc()],
        container: portfolio as any,
        catalog: catalog as any,
      });
    } finally {
      logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore();
    }
    expect(exitCodes).toContain(6);
    expect(portfolio.replaced).toHaveLength(0);
  });
});

// ── the manual-confirm holding is re-addressed, provenance kept ─────────────

describe("a manual-confirm holding named in the list IS re-addressed, with provenance kept", () => {
  it("REPORT computes a RULED verdict that bypasses manual-confirm and writes nothing", async () => {
    const catalog = mockCatalog({ [RULED_SLUG]: VERIFIED_ROW });
    const portfolio = mockPortfolio({ [DOC_ID]: baseDoc() });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    try {
      // No REFUSED verdict this time (the target is verified), so `ruled()`
      // returns normally without ever calling process.exit — safe to call
      // live with no mock, and this run is what actually proves REPORT
      // writes nothing.
      await ruled({
        entries: [RULED_ENTRY],
        docs: [baseDoc()],
        container: portfolio as any,
        catalog: catalog as any,
      });
    } finally {
      logSpy.mockRestore();
    }
    // REPORT: nothing written.
    expect(portfolio.replaced).toHaveLength(0);
    // The banner shows the bypass explicitly, naming the old ruling source.
    const joined = logs.join("\n");
    expect(joined).toContain("RULED");
    expect(joined).toContain(RETIRED_SLUG);
    expect(joined).toContain(RULED_SLUG);
    expect(joined).toMatch(/BYPASSES manual-confirm \(manual-confirm\)/);
    expect(joined).toContain("drew 2026-09-13");
  });

  it("a holding in the list that is NOT manual-confirm is still ruled, banner says so", async () => {
    const unruledDoc = {
      id: DOC_ID, userId: USER_ID, _etag: '"etag-1"',
      holdings: {
        [HOLDING_ID]: {
          playerName: "Marconi German", cardYear: 2026, cardNumber: "CPA-MG",
          parallel: "Gold Refractor", printRun: 50,
          hobbyiqCardId: RETIRED_SLUG, cardId: RETIRED_SLUG,
          // No identityVerifiedBy / identityResolvedBy / userEditedFields at
          // all — userAuthoredIdentity reads this as NOT human-ruled.
        },
      },
    };
    const catalog = mockCatalog({ [RULED_SLUG]: VERIFIED_ROW });
    const portfolio = mockPortfolio({ [DOC_ID]: unruledDoc });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    try {
      await ruled({
        entries: [RULED_ENTRY],
        docs: [unruledDoc],
        container: portfolio as any,
        catalog: catalog as any,
      });
    } finally {
      logSpy.mockRestore();
    }
    const joined = logs.join("\n");
    expect(joined).toContain("RULED");
    expect(joined).toMatch(/no manual-confirm guard on this holding/);
    expect(joined).not.toMatch(/BYPASSES manual-confirm/);
  });

  it("APPLY keeps identityVerifiedBy and appends identityReconfirmedBy + identityRederivedBy in source", () => {
    const applyBlock = SRC.slice(SRC.indexOf("// ---- APPLY -------------------------------------------------------------\n  console.log(`\\n=== APPLY: ${writable.length} ruled re-address"));
    expect(applyBlock).not.toMatch(/delete\s+h\.identityVerifiedBy/);
    expect(applyBlock).not.toMatch(/h\.identityVerifiedBy\s*=\s*(null|undefined)/);
    expect(applyBlock).toContain("h.identityReconfirmedBy = {");
    expect(applyBlock).toContain('source: "drew-ruling"');
    expect(applyBlock).toContain("date: v.ruling.date");
    expect(applyBlock).toContain("note: v.ruling.note ?? null");
    expect(applyBlock).toContain("from: v.from");
    expect(applyBlock).toContain('h.identityRederivedBy = "recheck-holding-identity MODE=ruled"');
  });

  it("APPLY sets both cardId and hobbyiqCardId to the ruled target", () => {
    const applyBlock = SRC.slice(SRC.indexOf("h.hobbyiqCardId = v.to;", SRC.indexOf("export async function ruled(")));
    expect(applyBlock.slice(0, 200)).toContain("h.hobbyiqCardId = v.to;");
    expect(applyBlock.slice(0, 200)).toContain("h.cardId = v.to;");
  });

  it("writes are etag-guarded and reconciliation verifies BOTH cardId and hobbyiqCardId", () => {
    const ruledFn = SRC.slice(SRC.indexOf("export async function ruled("), SRC.indexOf("\n// ── MODE=rederive"));
    expect(ruledFn).toMatch(/accessCondition: \{ type: "IfMatch", condition: etag! \}/);
    expect(ruledFn).toContain("RECONCILIATION: re-reading");
    expect(ruledFn).toContain("gotCardId === v.to && gotHobbyiqCardId === v.to");
  });
});

// ── REPORT writes nothing (mocked container) ─────────────────────────────────

describe("REPORT writes nothing", () => {
  it("live: a full REPORT run against a mocked container calls no .replace at all", async () => {
    const catalog = mockCatalog({ [RULED_SLUG]: VERIFIED_ROW });
    const portfolio = mockPortfolio({ [DOC_ID]: baseDoc() });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await ruled({
        entries: [RULED_ENTRY],
        docs: [baseDoc()],
        container: portfolio as any,
        catalog: catalog as any,
      });
    } finally {
      logSpy.mockRestore();
    }
    expect(portfolio.replaced).toHaveLength(0);
  });

  it("the APPLY branch is gated on the module's APPLY constant, shared with every other mode", () => {
    expect(SRC).toContain('const APPLY = process.env.APPLY === "true" || process.env.BACKFILL_APPLY === "true";');
    const ruledFn = SRC.slice(SRC.indexOf("export async function ruled("), SRC.indexOf("\n// ── MODE=rederive"));
    expect(ruledFn).toMatch(/if \(!APPLY\) \{/);
    expect(ruledFn).toContain("Report only — nothing written.");
  });
});

// ── dispatch: MODE=ruled, RULED_LIST / SCOPE, and the workflow ──────────────

describe("MODE=ruled reads RULED_LIST (or SCOPE) and refuses without a list", () => {
  it("recognizes MODE=ruled as its own branch, separate from rule and rederive", () => {
    expect(SRC).toMatch(/const RULED = MODE === "ruled"/);
    expect(SRC).toMatch(/if \(RULED\) \{/);
  });

  it("RULED_LIST wins over SCOPE, and SCOPE is accepted as the fallback", () => {
    expect(SRC).toContain(
      'const RULED_LIST = String(process.env.RULED_LIST ?? process.env.SCOPE ?? "").trim();',
    );
  });

  it("refuses with no default list", () => {
    expect(SRC).toContain("MODE=ruled needs a scope. Pass RULED_LIST=");
    expect(SRC).toContain("there is no default list");
  });

  it("validates the whole list BEFORE any Cosmos read of the catalog", () => {
    const block = SRC.slice(SRC.indexOf("if (RULED) {"), SRC.indexOf("await ruled({"));
    expect(block).toContain("parseRuledList(raw)");
    expect(block.indexOf("parseRuledList(raw)")).toBeLessThan(block.indexOf("db.container(\"card_catalog\")"));
  });
});

describe("the runner can dispatch MODE=ruled with no workflow change", () => {
  const WORKFLOW = readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8");

  it("rederive-holding-identity is already in the script dropdown", () => {
    expect(WORKFLOW).toMatch(/- rederive-holding-identity/);
  });

  it("MODE and SCOPE are already forwarded unconditionally to every script", () => {
    expect(WORKFLOW).toContain("MODE: ${{ inputs.mode }}");
    expect(WORKFLOW).toContain("SCOPE: ${{ inputs.scope }}");
  });

  it("the shim passes env straight through, so RULED_LIST needs no new plumbing", () => {
    const SHIM = readFileSync(join(__dirname, "..", "scripts", "rederive-holding-identity.cjs"), "utf8");
    expect(SHIM).toContain("const env = { ...process.env };");
    expect(SHIM).toContain('if (!String(env.MODE ?? "").trim()) env.MODE = "rederive";');
  });
});
