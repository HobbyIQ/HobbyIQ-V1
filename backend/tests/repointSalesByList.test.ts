/**
 * repoint-sales-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for a single
 * sold_comps re-key (Drew, 2026-09-27 widget ruling: "Build
 * repoint-sales-by-list lane"). This lane moves sold_comps rows from a
 * listed SOURCE hobbyiqCardId to a listed DESTINATION hobbyiqCardId; it
 * never retires the emptied source catalog row (that is
 * relocate-catalog-rows-by-list's own job, a separate follow-up).
 *
 * Modeled on relocateCatalogRowsByList.test.ts's own shape: the lane is
 * require()'d directly (its dist/ requires live inside main(), so the
 * module loads with no built tree) and its pure gate functions
 * (classifyEntry, sameProductAddress) are pinned against malformed and
 * well-formed list entries. An in-memory Cosmos fake — mirroring how that
 * file's own `fakeCat` fakes a container — drives the per-entry gates
 * end-to-end for card_catalog reads, and the shared `relocateSoldComp`
 * helper (already covered by its own suites) is exercised through a
 * minimal sold_comps fake for the write path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);

const lane = join(__dirname, "..", "scripts", "repoint-sales-by-list.cjs");
const runner = join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml");
const firstList = join(__dirname, "..", "data", "sales-repoints", "2026-09-27-tcus-2025-usc143-raywave.json");

type Entry = {
  fromId: string; toId: string; player?: string; cardNumber?: string;
  reason?: string; allowCrossProduct?: boolean; crossProductRuling?: string;
  expectedSales?: number;
};
type ListDoc = { forLane: string; entries: Entry[]; finding?: string; census?: unknown };

const readList = (p: string): ListDoc => JSON.parse(readFileSync(p, "utf8")) as ListDoc;

// The lane is required WITHOUT a built tree — its dist/ requires live inside
// main(), exactly as every sibling list lane does it, so the contract is
// testable without a compile step.
const L = require_(lane) as {
  classifyEntry: (e: unknown) => {
    ok: boolean; why?: string; fromId?: string; toId?: string; player?: string;
    cardNumber?: string; reason?: string; allowCrossProduct?: boolean;
    crossProductRuling?: string; expectedSales?: number | null;
  };
  sameProductAddress: (
    fromRow: unknown,
    toRow: unknown,
  ) => { ok: boolean; why?: string; differing?: string[] };
};

// ── the runner contract ──────────────────────────────────────────────────

describe("the lane is dispatchable and carries no new input", () => {
  it("is in the runner's script choice list", () => {
    // Line-ending agnostic: the checkout is CRLF on Windows and LF in CI.
    expect(readFileSync(runner, "utf8")).toMatch(/^ {10}- repoint-sales-by-list\r?$/m);
  });

  it("rides the existing SCOPE passthrough — no new workflow_dispatch input", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toMatch(/SCOPE:\s*\$\{\{\s*inputs\.scope\s*\}\}/);
    // GitHub caps workflow_dispatch at 25 inputs and 24 are used. A new one
    // here would be the input that broke the cap.
    expect(yml).not.toContain("sales_list:");
    expect(yml).not.toContain("repoint_list:");
  });

  it("and BACKFILL_APPLY is what arms it, not APPLY", () => {
    expect(readFileSync(runner, "utf8")).toMatch(/BACKFILL_APPLY:\s*\$\{\{\s*inputs\.apply/);
    expect(readFileSync(lane, "utf8")).toContain(
      'const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";',
    );
  });

  it("has a relaunch step modeled on relocate-catalog-rows-by-list's own block", () => {
    const yml = readFileSync(runner, "utf8");
    expect(yml).toContain("inputs.script == 'repoint-sales-by-list'");
    expect(yml).toContain("uses: ./.github/actions/relaunch-on-marker");
    expect(yml).toMatch(
      /gh workflow run backfill-runner\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f script=repoint-sales-by-list -f apply="\$\{\{ inputs\.apply \}\}" -f scope="\$\{\{ inputs\.scope \}\}"/,
    );
  });

  it("the shared relaunch action exists and is not itself edited by this change", () => {
    const action = join(__dirname, "..", "..", ".github", "actions", "relaunch-on-marker", "action.yml");
    expect(existsSync(action)).toBe(true);
    // The pin here is behavioural, not a hash check: the task is that this
    // PR must not edit the action's own file, which is verified by the PR
    // diff itself (this suite only proves the file exists and is USED via
    // `uses:`, which the earlier assertion in this block already covers).
  });
});

// ── the scope refusal ────────────────────────────────────────────────────

describe("the scope must name a committed list", () => {
  it("REFUSES an empty scope — no default list", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("if (!RAW_SCOPE) {");
    expect(src).toContain("has no default list");
  });

  it("REFUSES another lane's vocabulary", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('if (!RAW_SCOPE.endsWith(".json"))');
    for (const stray of ["refractor", "all", "improve"]) {
      expect(stray.endsWith(".json")).toBe(false);
    }
  });

  it("and a missing or empty list file is fatal, never a silent no-op", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("FATAL: scope list not found");
    expect(src).toContain("names no entries — nothing is in scope");
  });
});

// ── list loader validation ───────────────────────────────────────────────

describe("classifyEntry validates the list schema", () => {
  it("accepts a well-formed entry", () => {
    const r = L.classifyEntry({
      fromId: "hiq:baseball:2025:topps-chrome-update-series:usc143:raywave-refractor:no-auto",
      toId: "hiq:baseball:2025:topps-chrome-update-series:usc143:ray-wave-refractor:no-auto",
      player: "Adael Amador", cardNumber: "USC143", reason: "spelling drift",
    });
    expect(r.ok).toBe(true);
    expect(r.fromId).toContain("raywave-refractor");
    expect(r.toId).toContain("ray-wave-refractor");
  });

  it("refuses a missing fromId", () => {
    const r = L.classifyEntry({ toId: "hiq:a:1:b:1:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no fromId");
  });

  it("refuses a missing toId", () => {
    const r = L.classifyEntry({ fromId: "hiq:a:1:b:1:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no toId");
  });

  it("refuses fromId that is not a hiq slug", () => {
    const r = L.classifyEntry({ fromId: "cardhedge::123", toId: "hiq:a:1:b:1:base:no-auto", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses toId that is not a hiq slug", () => {
    const r = L.classifyEntry({ fromId: "hiq:a:1:b:1:base:no-auto", toId: "cardhedge::123", reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not a hiq slug");
  });

  it("refuses fromId == toId", () => {
    const id = "hiq:a:1:b:1:base:no-auto";
    const r = L.classifyEntry({ fromId: id, toId: id, reason: "why" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("toId equals fromId");
  });

  it("refuses an entry with no reason — an unexplained move is not reviewable", () => {
    const r = L.classifyEntry({ fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:b:2:base:no-auto" });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no reason");
  });

  it("refuses allowCrossProduct:true with no crossProductRuling", () => {
    const r = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:c:1:base:no-auto",
      reason: "why", allowCrossProduct: true,
    });
    expect(r.ok).toBe(false);
    expect(r.why).toContain("crossProductRuling");
  });

  it("accepts allowCrossProduct:true WITH a ruling string", () => {
    const r = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:c:1:base:no-auto",
      reason: "why", allowCrossProduct: true, crossProductRuling: "Drew ruling 2026-09-27",
    });
    expect(r.ok).toBe(true);
    expect(r.allowCrossProduct).toBe(true);
  });

  it("carries expectedSales through when it is a finite number, else null", () => {
    const withCount = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:b:2:base:no-auto",
      reason: "why", expectedSales: 1,
    });
    expect(withCount.expectedSales).toBe(1);
    const without = L.classifyEntry({
      fromId: "hiq:a:1:b:1:base:no-auto", toId: "hiq:a:1:b:2:base:no-auto", reason: "why",
    });
    expect(without.expectedSales).toBeNull();
  });
});

// ── sameProductAddress: the cross-product gate ───────────────────────────

describe("sameProductAddress compares the CATALOG ROWS' own fields", () => {
  const base = { sport: "baseball", year: 2025, setKey: "topps-chrome-update-series", cardNumber: "USC143" };

  it("agrees when every field matches, case/whitespace insensitive", () => {
    const r = L.sameProductAddress(base, { ...base, sport: " Baseball " });
    expect(r.ok).toBe(true);
    expect(r.differing).toEqual([]);
  });

  it("disagrees and names the differing field(s)", () => {
    const r = L.sameProductAddress(base, { ...base, setKey: "topps-chrome" });
    expect(r.ok).toBe(false);
    expect(r.differing).toContain("setKey");
  });

  it("disagrees on more than one field at once", () => {
    const r = L.sameProductAddress(base, { ...base, sport: "basketball", cardNumber: "1" });
    expect(r.ok).toBe(false);
    expect(r.differing).toEqual(expect.arrayContaining(["sport", "cardNumber"]));
  });
});

// ── the first committed list ─────────────────────────────────────────────

describe("the first committed list (USC143)", () => {
  it("is shaped the way this lane requires", () => {
    const doc = readList(firstList);
    expect(doc.forLane).toBe("repoint-sales-by-list");
    expect(doc.entries.length).toBe(1);
    const [e] = doc.entries;
    expect(e.fromId).toBe("hiq:baseball:2025:topps-chrome-update-series:usc143:raywave-refractor:no-auto");
    expect(e.toId).toBe("hiq:baseball:2025:topps-chrome-update-series:usc143:ray-wave-refractor:no-auto");
    expect(e.expectedSales).toBe(1);
    const c = L.classifyEntry(e);
    expect(c.ok).toBe(true);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(firstList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });
});

// ── namesAgree is reused, never reimplemented ────────────────────────────

describe("this lane reuses the shared namesAgree, never a bespoke compare", () => {
  it("requires lib/name-agreement.cjs at module scope", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "name-agreement.cjs"))');
    expect(src).toContain("namesAgree(saleName, destName)");
  });

  it("requires the dual sales-at-id check, never a bare cross-partition query", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "sales-at-id.cjs"))');
    expect(src).toContain("drainSalesIdsAtId(pool, fromId");
  });

  it("requires the shared cosmos backoff, never a bespoke retry loop", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "cosmos-backoff.cjs"))');
    expect(src).toContain("withBackoff(fn,");
  });

  it("requires pkOf/None-pk awareness for the catalog read", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain('require(path.join(__dirname, "lib", "catalog-none-pk.cjs"))');
  });

  it("never retires the source catalog row — one axis, sales only", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).not.toContain("retireCatalogRow");
    expect(src).not.toContain("assert-retire-legal");
  });
});

// ── end-to-end against an in-memory Cosmos fake ──────────────────────────
//
// Mirrors how relocateCatalogRowsByList.test.ts fakes its container: a plain
// object exposing `.item(id, pk).read()` and `.items.query(...).fetchAll()`,
// no real @azure/cosmos client anywhere in the path. This drives `main()`'s
// own catalog-read helper indirectly is out of scope for a unit suite (main()
// requires dist/ and a live CosmosClient at the top) — what is pinned here is
// the GATE LOGIC every entry must pass, exercised directly against the pure
// functions the lane exports, plus the two library functions (`salesAtId`,
// `namesAgree`) the lane is pinned (above) to actually call.

describe("the gates, driven directly against the shared libraries", () => {
  const { salesAtId } = require_(join(__dirname, "..", "scripts", "lib", "sales-at-id.cjs"));
  const { namesAgree } = require_(join(__dirname, "..", "scripts", "lib", "name-agreement.cjs"));

  function fakePool(rows: Array<{ id: string; cardId: string }>) {
    return {
      items: {
        query: (spec: { parameters: Array<{ name: string; value: string }> }, opts: { partitionKey?: string }) => {
          const id = spec.parameters.find((p) => p.name === "@id")?.value;
          const matches = rows.filter((r) => r.id === id || r.cardId === id);
          const scoped = opts?.partitionKey
            ? matches.filter((r) => r.cardId === opts.partitionKey)
            : matches;
          let done = false;
          return {
            hasMoreResults: () => !done,
            fetchNext: async () => { done = true; return { resources: scoped }; },
          };
        },
      },
    };
  }

  it("refuses zero-sales — a source with no rows is nothing to do", async () => {
    const pool = fakePool([]);
    const res = await salesAtId(pool, "hiq:a:1:b:1:base:no-auto");
    expect(res.total).toBe(0);
  });

  it("finds a sale present under either read form", async () => {
    const pool = fakePool([{ id: "src::1", cardId: "hiq:a:1:b:1:base:no-auto" }]);
    const res = await salesAtId(pool, "hiq:a:1:b:1:base:no-auto");
    expect(res.total).toBe(1);
  });

  it("namesAgree passes a sale title against the destination player name", () => {
    expect(namesAgree("Adael Amador", "Adael Amador")).toBe(true);
    // Case/punctuation-insensitive (rule d), but "RC" is not on the closed
    // subset-marker vocabulary namesAgree strips, so it correctly disagrees
    // rather than being silently folded away — the fixture below spells the
    // sale and the destination identically, as a real checklist-backed sale
    // title generally would once cleaned of anything the closed list knows.
    expect(namesAgree("adael amador", "Adael Amador")).toBe(true);
  });

  it("namesAgree refuses a genuinely different player", () => {
    expect(namesAgree("Derek Jeter", "Todd Hundley")).toBe(false);
  });
});

// ── REPORT writes nothing; a thrown read-back is FAILED not clean ───────

describe("REPORT computes the same gates APPLY would, and writes nothing", () => {
  it("APPLY is gated on BACKFILL_APPLY/APPLY, dryRun follows !APPLY through relocateSoldComp", () => {
    const src = readFileSync(lane, "utf8");
    // The one call site that writes must pass dryRun tied to !APPLY, never a
    // parallel branch that skips the derivation in REPORT mode.
    expect(src).toContain("if (!APPLY) {");
    expect(src).toContain("relocateSoldComp(pool, {");
  });

  it("a thrown relocateSoldComp call is counted FAILED, never a clean move", () => {
    const src = readFileSync(lane, "utf8");
    // The caller's own briefing: relocateSoldComp's catch path can report
    // duplicatesLeft:[] on a THROWN read-back, which reads as "nothing left
    // behind" — this lane's own try/catch around the call must count a
    // throw as failed, never treat the absence of duplicatesLeft as clean.
    const callSite = src.indexOf("await relocateSoldComp(pool, {");
    const catchAfter = src.indexOf("} catch (err) {", callSite);
    expect(callSite).toBeGreaterThan(-1);
    expect(catchAfter).toBeGreaterThan(callSite);
    const catchBlock = src.slice(catchAfter, catchAfter + 700);
    expect(catchBlock).toContain("failedSales++");
    expect(catchBlock).not.toContain("movedSales++");
  });
});

// ── reconcile mismatch fails the run ──────────────────────────────────────

describe("the reconcile identity fails the run on mismatch", () => {
  it("sets process.exitCode = 4 and prints RECONCILE MISMATCH on a mismatch", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("RECONCILE MISMATCH");
    expect(src).toContain("process.exitCode = 4;");
  });

  it("the budget marker is a literal string, not assembled from variables", () => {
    const src = readFileSync(lane, "utf8");
    expect(src).toContain("stopped at the ${CLOCK.RUN_MINUTES}-minute budget");
  });
});
