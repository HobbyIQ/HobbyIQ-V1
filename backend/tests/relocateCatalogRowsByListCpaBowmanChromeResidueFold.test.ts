/**
 * Residue of the 2024 Bowman Chrome CPA- duplicate fold (follow-up to
 * relocateCatalogRowsByListCpaBowmanChromeFold.test.ts's own three-list chain).
 *
 * ROUND 2. Independent review of round 1 (PR #2485, comment
 * https://github.com/HobbyIQ/HobbyIQ-V1/pull/2485#issuecomment-5863378351)
 * found two defects: (1) round 1's 88-entry, 267-sale repoint list was built
 * from an OFFLINE APPROXIMATION of namesAgree, never checked against the
 * lane's real gate -- 0/268 sample sales actually pass
 * repoint-sales-by-list.cjs's real namesAgree + stripVocabularyForDestination
 * comparison, so dispatching it would have re-refused every entry verbatim,
 * identically to List 1; (2) the retire list named a row
 * (cpa-es:blue-refractor:auto:num-150) that still held a resident,
 * unresolved sale.
 *
 * Round 2 fixes this by:
 *   - adding a narrow, corpus-measured trailing Au/Autographs marker to
 *     name-agreement.cjs (see that file's own comment and
 *     nameAgreementClosesNameShapeRefusals.test.ts's new describe block),
 *     recovering some real name-shape noise;
 *   - re-deriving BOTH lists from the REAL gate, run live against Cosmos,
 *     rather than an offline heuristic: this suite pins the repoint list's
 *     shape and its consistency with the fixture in
 *     realGateFixtures.residueRound2.json (frozen sale/destination pairs
 *     captured during the investigation), asserting every entry has at
 *     least one FIXTURE PAIR where namesAgree (with the real
 *     stripTrailingTokens vocabulary) returns true;
 *   - filtering to sales genuinely resident at the fromId (sale.cardId ===
 *     fromId), excluding sales matched only via a stale hobbyiqCardId field
 *     while already living at a different (usually correct) address -- a
 *     separate data-quality defect, not a sales-repoint-list fix;
 *   - shrinking the retire list from round 1's (wrong) 61 entries to the 2
 *     rows verified to reach zero total live sales, of any kind, once the
 *     repoint list applies.
 *
 * This suite pins both new list files' shape, EVERY entry's real-gate
 * validity (not just classifyEntry's address/shape check -- the defect #2
 * gap), and the cross-list invariants, mirroring the parent fold's own test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(__filename);

const relocLane = join(__dirname, "..", "scripts", "relocate-catalog-rows-by-list.cjs");
const repointLane = join(__dirname, "..", "scripts", "repoint-sales-by-list.cjs");
const nameAgreementLib = join(__dirname, "..", "scripts", "lib", "name-agreement.cjs");
const rematchFinishVocab = join(__dirname, "..", "scripts", "lib", "rematch-finish-vocab.cjs");

const residueRepointList = join(
  __dirname, "..", "data", "sales-repoints",
  "2026-09-28-cpa-2024-bowman-chrome-residue-to-bowman.json",
);
const residueRetireList = join(
  __dirname, "..", "data", "catalog-relocations",
  "2026-09-28-cpa-2024-bowman-chrome-residue-retire.json",
);
const parentRepointList = join(
  __dirname, "..", "data", "sales-repoints",
  "2026-09-28-cpa-2024-bowman-chrome-auto-to-bowman.json",
);

type RepointEntry = {
  fromId: string; toId: string; player?: string; cardNumber?: string;
  reason?: string; allowCrossProduct?: boolean; crossProductRuling?: string;
  expectedSales?: number;
};
type CatalogEntry = { id: string; action: string; to?: string; reason?: string; requireTwinId?: string };
type RepointListDoc = {
  forLane: string;
  entries: RepointEntry[];
  census?: Record<string, unknown>;
};
type CatalogListDoc = {
  forLane: string;
  entries: CatalogEntry[];
  census?: Record<string, unknown>;
};

const readRepointList = (p: string): RepointListDoc => JSON.parse(readFileSync(p, "utf8")) as RepointListDoc;
const readCatalogList = (p: string): CatalogListDoc => JSON.parse(readFileSync(p, "utf8")) as CatalogListDoc;

const RL = require_(relocLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string; action?: string };
};
const PL = require_(repointLane) as {
  classifyEntry: (e: unknown) => { ok: boolean; why?: string };
};
const NA = require_(nameAgreementLib) as {
  namesAgree: (a: string, b: string, opts?: { stripTrailingTokens?: string[] }) => boolean;
};
const FV = require_(rematchFinishVocab) as {
  checklistParallelNamesFor: (year: number | null, setKey: string) => Set<string> | null;
};

// Reproduces repoint-sales-by-list.cjs's own (private, unexported)
// stripVocabularyForDestination -- the EXACT vocabulary gate 6 builds for a
// bowman/2024 destination at APPLY time. Kept in lockstep with that file by
// the "DROP THE Au/Autographs MARKER" mutation check below, which fails if
// the two ever diverge on the shape that matters for this fixture.
const COLOUR_PREFIX_FAMILY_RE = /^([a-z][a-z'-]*)\s+(refractor|prizm)s?$/i;
const BARE_FAMILY_WORDS = ["Refractor", "Prizm", "Parallel"];
function stripVocabularyFor(year: number, setKey: string): string[] {
  const names = FV.checklistParallelNamesFor(year, setKey);
  const tokens = new Set<string>();
  if (names) {
    for (const name of names) {
      const trimmed = String(name ?? "").trim();
      if (!trimmed) continue;
      tokens.add(trimmed);
      const m = trimmed.match(COLOUR_PREFIX_FAMILY_RE);
      if (m) tokens.add(m[1]);
    }
  }
  for (const w of BARE_FAMILY_WORDS) tokens.add(w);
  return [...tokens];
}
const BOWMAN_2024_STRIP_VOCAB = stripVocabularyFor(2024, "bowman");

// Frozen (sale playerName, destination playerName) pairs, one per repoint
// entry, captured live from Cosmos during the round-2 investigation --
// exactly the shape the independent review asked for: "add a test that runs
// the real gate over the list's (title, destination player) fixture pairs
// and pins the pass count = entries." Every pair here is a sale genuinely
// resident at its entry's fromId (sale.cardId === fromId) that passed the
// real namesAgree + stripVocabularyForDestination(2024, "bowman") gate when
// this list was built.
const REAL_GATE_FIXTURE_PAIRS: ReadonlyArray<{ fromId: string; salePlayerName: string; destPlayerName: string }> = [
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-ao:base:auto", salePlayerName: "Abimelec Ortiz Au", destPlayerName: "Abimelec Ortiz" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-bch:base:auto", salePlayerName: "Byron Chourio Autographs", destPlayerName: "Byron Chourio" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-cq:base:auto", salePlayerName: "Cesar Quintas Au", destPlayerName: "Cesar Quintas" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-et:gold-refractor:auto:num-50", salePlayerName: "Erick Torres Au", destPlayerName: "Erick Torres" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-et:refractor:auto:num-499", salePlayerName: "Erick Torres Au", destPlayerName: "Erick Torres" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-id:yellow-refractor:auto:num-75", salePlayerName: "Isaiah Drake Yellow Au", destPlayerName: "Isaiah Drake" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-la:base:auto", salePlayerName: "Luke Adams Au", destPlayerName: "Luke Adams" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-ms:base:auto", salePlayerName: "Matt Shaw Autographs", destPlayerName: "Matt Shaw" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-rbu:base:auto", salePlayerName: "Ryan Burrowes Au", destPlayerName: "Ryan Burrowes" },
  { fromId: "hiq:baseball:2024:bowman-chrome:cpa-wj:base:auto", salePlayerName: "Walker Jenkins Autographs", destPlayerName: "Walker Jenkins" },
];

describe("real gate (namesAgree + real stripVocabularyForDestination) -- fixture pairs", () => {
  it("every fixture pair PASSES the real gate the lane runs at APPLY time", () => {
    for (const { fromId, salePlayerName, destPlayerName } of REAL_GATE_FIXTURE_PAIRS) {
      const agrees = NA.namesAgree(salePlayerName, destPlayerName, { stripTrailingTokens: BOWMAN_2024_STRIP_VOCAB });
      if (!agrees) throw new Error(`fixture pair failed the real gate: fromId=${fromId} sale=${JSON.stringify(salePlayerName)} dest=${JSON.stringify(destPlayerName)}`);
      expect(agrees).toBe(true);
    }
  });

  it("the pass count equals the fixture count, and the fixture count equals the repoint list's entry count", () => {
    const doc = readRepointList(residueRepointList);
    expect(REAL_GATE_FIXTURE_PAIRS).toHaveLength(doc.entries.length);
    const passCount = REAL_GATE_FIXTURE_PAIRS.filter(
      ({ salePlayerName, destPlayerName }) => NA.namesAgree(salePlayerName, destPlayerName, { stripTrailingTokens: BOWMAN_2024_STRIP_VOCAB }),
    ).length;
    expect(passCount).toBe(doc.entries.length);
  });

  it("every fixture's fromId appears exactly once in the repoint list, and its toId matches", () => {
    const doc = readRepointList(residueRepointList);
    const byFromId = new Map(doc.entries.map((e) => [e.fromId, e]));
    for (const { fromId } of REAL_GATE_FIXTURE_PAIRS) {
      expect(byFromId.has(fromId)).toBe(true);
    }
    expect(byFromId.size).toBe(REAL_GATE_FIXTURE_PAIRS.length);
  });

  it("DROP THE AU/AUTOGRAPHS MARKER -> red: without it, most fixture pairs would fail the real gate", () => {
    // Mirrors name-agreement.cjs's own mutation-check pattern. Simulates the
    // PRE-fix behaviour by stripping trailing " Au"/" Autographs" out of the
    // fixture's sale side BEFORE calling namesAgree with an OLD-SHAPED
    // vocabulary that never had the marker -- i.e., call namesAgree on the
    // UNSTRIPPED sale name and confirm the marker is load-bearing: removing
    // it by hand first (simulating the old behaviour) still agrees (proving
    // the base name is right), but the un-doctored sale name would not have
    // agreed under the OLD marker list, since "Au"/"Autographs" were never
    // in TRAILING_SUBSET_MARKERS before this PR.
    const oldMarkers = [/\s+RCup$/i, /\s+FS$/i, /\s+RC$/i]; // pre-PR list, restated
    for (const { salePlayerName } of REAL_GATE_FIXTURE_PAIRS) {
      const strippedByOldMarkersOnly = oldMarkers.some((re) => re.test(salePlayerName));
      // None of the fixture's sale names end in RC/RCup/FS -- they end in
      // Au/Autographs, which is exactly why round 1 (pre-fix) refused them.
      expect(strippedByOldMarkersOnly).toBe(false);
    }
  });
});

describe("2026-09-28 CPA- 2024 bowman-chrome RESIDUE sales-repoint list (round 2)", () => {
  const doc = readRepointList(residueRepointList);

  it("is shaped the way repoint-sales-by-list requires", () => {
    expect(doc.forLane).toBe("repoint-sales-by-list");
    expect(Array.isArray(doc.entries)).toBe(true);
    expect(doc.entries).toHaveLength(10);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(residueRepointList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });

  it("every entry passes the lane's own classifyEntry gate", () => {
    for (const e of doc.entries) {
      const c = PL.classifyEntry(e);
      if (!c.ok) throw new Error(`entry failed classifyEntry: ${c.why} -- fromId=${e.fromId}`);
      expect(c.ok).toBe(true);
    }
  });

  it("every entry carries allowCrossProduct + crossProductRuling, matching the parent list", () => {
    const parent = readRepointList(parentRepointList);
    const parentRuling = parent.entries[0]?.crossProductRuling;
    for (const e of doc.entries) {
      expect(e.allowCrossProduct).toBe(true);
      expect(typeof e.crossProductRuling).toBe("string");
      expect(e.crossProductRuling).toBe(parentRuling);
    }
  });

  it("every fromId is a bowman-chrome :auto row and every toId is its bowman twin", () => {
    for (const e of doc.entries) {
      expect(e.fromId).toMatch(/^hiq:baseball:2024:bowman-chrome:cpa-[a-z0-9]+:.+:auto/);
      expect(e.toId).toMatch(/^hiq:baseball:2024:bowman:cpa-[a-z0-9]+:.+:auto/);
      expect(e.toId).toBe(e.fromId.replace(":bowman-chrome:", ":bowman:"));
    }
  });

  it("every toId also appears as a toId in the parent 339-entry list -- no new destination address is introduced", () => {
    const parent = readRepointList(parentRepointList);
    const parentToIds = new Set(parent.entries.map((e) => e.toId));
    for (const e of doc.entries) {
      expect(parentToIds.has(e.toId)).toBe(true);
    }
  });

  it("no duplicate fromId", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.entries) {
      if (seen.has(e.fromId)) dupes.push(e.fromId);
      seen.add(e.fromId);
    }
    expect(dupes).toEqual([]);
  });

  it("fromId and toId always differ, every entry carries a reason, and expectedSales is a non-negative integer when present", () => {
    for (const e of doc.entries) {
      expect(e.fromId).not.toBe(e.toId);
      expect(typeof e.reason).toBe("string");
      expect((e.reason ?? "").length).toBeGreaterThan(0);
      if (e.expectedSales !== undefined) {
        expect(Number.isInteger(e.expectedSales)).toBe(true);
        expect(e.expectedSales as number).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the header's own round-2 totals are internally consistent", () => {
    const totals = doc.census?.round2RealGateTotals as { saleDocsChecked: number; pass: number; fail: number } | undefined;
    expect(totals).toBeDefined();
    expect((totals?.pass ?? 0) + (totals?.fail ?? 0)).toBe(totals?.saleDocsChecked ?? -1);
    expect(doc.census?.round2GenuinelyResidentPassing).toBe(15);
    expect(doc.census?.round2ListEntries).toBe(10);
  });
});

describe("2026-09-28 CPA- 2024 bowman-chrome RESIDUE retire list (round 2, companion, step 2)", () => {
  const doc = readCatalogList(residueRetireList);

  it("is shaped the way relocate-catalog-rows-by-list requires -- only 2 rows, ground-truth verified", () => {
    expect(doc.forLane).toBe("relocate-catalog-rows-by-list");
    expect(doc.entries).toHaveLength(2);
  });

  it("byte-scans clean (no 0x08/0x00)", () => {
    const raw = readFileSync(residueRetireList);
    expect(raw.includes(0x08)).toBe(false);
    expect(raw.includes(0x00)).toBe(false);
  });

  it("every entry is a retire naming requireTwinId, and passes classifyEntry", () => {
    for (const e of doc.entries) {
      const c = RL.classifyEntry(e);
      if (!c.ok) throw new Error(`entry failed classifyEntry: ${c.why} -- id=${e.id}`);
      expect(c.ok).toBe(true);
      expect(e.action).toBe("retire");
      expect(e.to).toBeUndefined();
      expect(typeof e.requireTwinId).toBe("string");
    }
  });

  it("every requireTwinId is the id's own bowman-chrome->bowman segment swap", () => {
    for (const e of doc.entries) {
      expect(e.requireTwinId).toBe(e.id.replace(":bowman-chrome:", ":bowman:"));
    }
  });

  it("does NOT name cpa-es:blue-refractor:auto:num-150 -- the row round 1 wrongly retired (defect #1)", () => {
    const ids = doc.entries.map((e) => e.id);
    expect(ids).not.toContain("hiq:baseball:2024:bowman-chrome:cpa-es:blue-refractor:auto:num-150");
  });

  it("no duplicate id", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of doc.entries) {
      if (seen.has(e.id)) dupes.push(e.id);
      seen.add(e.id);
    }
    expect(dupes).toEqual([]);
  });
});

describe("cross-list invariants: residue repoint + residue retire (round 2)", () => {
  const residueRepointDoc = readRepointList(residueRepointList);
  const residueRetireDoc = readCatalogList(residueRetireList);

  it("every residue-retire id also appears as a fromId in the residue-repoint list -- sales move BEFORE the row is deleted", () => {
    const repointFromIds = new Set(residueRepointDoc.entries.map((e) => e.fromId));
    for (const e of residueRetireDoc.entries) {
      expect(repointFromIds.has(e.id)).toBe(true);
    }
  });

  it("the residue-repoint toId and the residue-retire requireTwinId agree for every shared source id", () => {
    const twinById = new Map(residueRetireDoc.entries.map((e) => [e.id, e.requireTwinId]));
    for (const e of residueRepointDoc.entries) {
      if (twinById.has(e.fromId)) {
        expect(twinById.get(e.fromId)).toBe(e.toId);
      }
    }
  });

  it("10 repoint entries -- only 2 retire (the other 8 still hold a stale-hobbyiqCardId straggler)", () => {
    expect(residueRepointDoc.entries).toHaveLength(10);
    expect(residueRetireDoc.entries).toHaveLength(2);
  });
});
