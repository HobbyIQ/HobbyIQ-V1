import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const F = req(path.resolve(__dirname, "../scripts/lib/finish-collision-refile.cjs"));
const K = req(path.resolve(__dirname, "../scripts/lib/rematch-classify.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } =
  req(path.resolve(__dirname, "../scripts/lib/relocate-sold-comp.cjs"));

/**
 * CF-FINISH-FAMILY-COLLISION (Drew, 2026-09-05) -- the write half of #1790.
 *
 * These pins drive the SHIPPED predicate, scripts/lib/finish-collision-refile.cjs,
 * with REAL row shapes read read-only off the live pool on 2026-09-05. A test
 * against a re-implementation would pin nothing, which is the whole reason the
 * decision lives in a lib rather than inside the driver.
 *
 * Every assertion has a MUTATION CHECK beside it: the same row with exactly one
 * guard's input reverted, asserted to stop being a move. A guard nothing can
 * break is a guard nothing has proved.
 */

// ── real rows, quoted from the live pool ────────────────────────────────────

/** Drew's Marconi German -- the row #1790 was written for. A Gold Shimmer sale
 *  addressed to the Gold Refractor pool, keyed by a CardHedge bubble id, so the
 *  `hiq:` address lives on `hobbyiqCardId` alone. */
const GERMAN_STORED = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-refractor:auto:num-50";
const GERMAN_DEST = "hiq:baseball:2026:bowman-chrome:cpa-mg:gold-shimmer-refractor:auto:num-50";

const germanRow = (over: Record<string, unknown> = {}) => ({
  id: "cardhedge::ch-comp::1778541264103x262828165280045280::2026-06-17T21:06:00.000Z::10250",
  cardId: "1778541264103x262828165280045280",
  hobbyiqCardId: GERMAN_STORED,
  title: "2026 Bowman Marconi German 1st Auto CPA-MG Gold Shimmer /50 - Raw",
  setName: "Bowman Chrome",
  source: "cardhedge",
  parallel: "Gold",
  parallelSlug: "blue-refractor",
  sport: "baseball",
  cardYear: 2026,
  cardNumber: "CPA-MG",
  isAuto: true,
  printRun: 50,
  price: 102.5,
  soldAt: "2026-06-17T21:06:00.000Z",
  ...over,
});

const germanStored = (over: Record<string, unknown> = {}) => ({
  sport: "baseball", cardYear: 2026, setKey: "bowman-chrome", cardNumber: "CPA-MG",
  parallel: "Gold", isAuto: true, printRun: 50, gradeCompany: null, gradeValue: null,
  ...over,
});

/** A 2025 Topps Chrome rookie auto whose title says "Blue RayWave" while the
 *  slug says `blue-logofractor`. Read live 2026-09-05; the lane's own report
 *  run over baseball:2025:topps-chrome named it as a would-write. */
const ELLIS_STORED = "hiq:baseball:2025:topps-chrome:ra-de:blue-logofractor:auto:num-150";
const ELLIS_DEST = "hiq:baseball:2025:topps-chrome:ra-de:blue-ray-wave-refractor:auto:num-150";

const ellisRow = (over: Record<string, unknown> = {}) => ({
  id: "tca-ebay::EBAY-v1|2025toppschrome|ra-de|0",
  cardId: ELLIS_STORED,
  hobbyiqCardId: ELLIS_STORED,
  title: "2025 Topps Chrome Rookie Autographs Duke Ellis #RA-DE Blue RayWave /150 (AU,RC)",
  setName: "Topps Chrome",
  source: "tca-ebay",
  parallel: "Blue Logofractor",
  sport: "baseball",
  cardYear: 2025,
  cardNumber: "RA-DE",
  isAuto: true,
  printRun: 150,
  price: 44,
  soldAt: "2026-07-02T00:00:00.000Z",
  ...over,
});

const ellisStored = (over: Record<string, unknown> = {}) => ({
  sport: "baseball", cardYear: 2025, setKey: "topps-chrome", cardNumber: "RA-DE",
  parallel: "Blue Logofractor", isAuto: true, printRun: 150,
  gradeCompany: null, gradeValue: null,
  ...over,
});

/** The default catalog facts: the checklist lists the name, the destination is
 *  strictly backed, the product has strict rows, no subsetted row shares the
 *  number. Each pin reverts exactly ONE of these. */
const plan = (over: Record<string, unknown> = {}) =>
  F.planFinishCollisionRefile({
    row: germanRow(),
    stored: germanStored(),
    storedSlug: germanRow().cardId,
    destSlug: GERMAN_DEST,
    checklistParallel: "Gold Shimmer Refractor",
    destBacked: true,
    subsettedNamesAtNumber: new Set(),
    productHasStrictRows: true,
    ...over,
  });

// ── A1: the classifier's own verdict, not a second title reader ─────────────

describe("A1 -- the CLASSIFIER flags it, and this lane calls the same function", () => {
  it("moves the German row: a Gold Shimmer sale off the Gold Refractor pool", () => {
    const p = plan();
    expect(p.move).toBe(true);
    expect(p.dest).toBe(GERMAN_DEST);
    expect(p.evidence.family).toBe("gold");
    expect(p.evidence.titleFamilyWords).toContain("shimmer");
    // #1790's widening is load-bearing here: the `hiq:` address is on
    // hobbyiqCardId because cardId is a CardHedge bubble id.
    expect(p.evidence.addressField).toBe("hobbyiqCardId");
    expect(p.evidence.addressSlug).toBe(GERMAN_STORED);
  });

  it("moves the Ellis row: a Blue RayWave sale off the Blue Logofractor pool", () => {
    const p = F.planFinishCollisionRefile({
      row: ellisRow(), stored: ellisStored(), storedSlug: ellisRow().cardId,
      destSlug: ELLIS_DEST, checklistParallel: "Blue Raywave Refractor",
      destBacked: true, subsettedNamesAtNumber: new Set(), productHasStrictRows: true,
    });
    expect(p.move).toBe(true);
    expect(p.dest).toBe(ELLIS_DEST);
    // An hiq-keyed row reads off cardId exactly as it did before #1790.
    expect(p.evidence.addressField).toBe("cardId");
  });

  it("the verdict comes from K.finishFamilyCollision -- same row, same answer", () => {
    // Not a re-implementation: the lane's evidence IS the classifier's evidence.
    const direct = K.finishFamilyCollision({
      row: germanRow(), storedSlug: germanRow().cardId, stored: germanStored(), derived: null,
    });
    expect(direct.qualifies).toBe(true);
    expect(plan().evidence.storedSlugParallel).toBe(direct.evidence.storedSlugParallel);
    expect(plan().evidence.family).toBe(direct.evidence.family);
  });

  it("MUTATION: a title that AGREES with the slug is not a collision", () => {
    // Same row, title rewritten to say what the slug says. Agreement is not a
    // collision, and this lane must have nothing to say about it.
    const p = plan({
      row: germanRow({ title: "2026 Bowman Marconi German 1st Auto CPA-MG Gold Refractor /50 - Raw" }),
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("not-a-finish-family-collision");
  });

  it("MUTATION: a row with no hiq: address anywhere stays silent", () => {
    const p = plan({ row: germanRow({ hobbyiqCardId: null }) });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("not-a-finish-family-collision");
  });
});

// ── A2: only the parallel and printRun segments may move ───────────────────

describe("A2 -- ONLY the parallel/printRun segments move", () => {
  it("names the differing segment, and it is the parallel", () => {
    const d = F.segmentsThatDiffer(GERMAN_STORED, GERMAN_DEST);
    expect(d.ok).toBe(true);
    expect(d.differing).toEqual(["parallel"]);
    expect(plan().evidence.differingSegments).toEqual(["parallel"]);
  });

  it("a print-run change alone is allowed -- the run belongs to the parallel", () => {
    const d = F.segmentsThatDiffer(GERMAN_STORED, GERMAN_DEST.replace("num-50", "num-25"));
    expect(d.ok).toBe(true);
    expect(d.differing.sort()).toEqual(["parallel", "printRun"]);
  });

  it("MUTATION: a destination that moves setKey is a RIVAL READING, not a refile", () => {
    // The real shape this refuses, read live 2026-09-05: 227 rows in one
    // 2025 topps-chrome report slice whose destination crossed into
    // topps-chrome-update. The lane has no authority over which card this is.
    const dest = GERMAN_DEST.replace("bowman-chrome", "bowman");
    const p = plan({ destSlug: dest });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("axis-refusal:identity-segments-move:setKey");
  });

  it("MUTATION: a destination that moves cardNumber is refused", () => {
    const p = plan({ destSlug: GERMAN_DEST.replace("cpa-mg", "cpa-vf") });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("axis-refusal:identity-segments-move:cardNumber");
  });

  it("MUTATION: a destination that flips the auto flag is refused", () => {
    const p = plan({ destSlug: GERMAN_DEST.replace(":auto:", ":no-auto:") });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("axis-refusal:identity-segments-move:autoFlag");
  });

  it("MUTATION: sport and year are identity too", () => {
    expect(F.segmentsThatDiffer(GERMAN_STORED, GERMAN_DEST.replace(":baseball:", ":basketball:")).ok).toBe(false);
    expect(F.segmentsThatDiffer(GERMAN_STORED, GERMAN_DEST.replace(":2026:", ":2025:")).ok).toBe(false);
  });

  it("MUTATION: DROPPING the guard entirely would let a setKey move through", () => {
    // The counterfactual that makes the guard's absence visible: with only the
    // movable-segment names removed from consideration, the same destination
    // that A2 refuses becomes 'just a different slug'.
    const differing = ["setKey", "parallel"];
    expect(differing.every((n) => F.MOVABLE_SEGMENTS.has(n))).toBe(false);
    expect(["parallel", "printRun"].every((n) => F.MOVABLE_SEGMENTS.has(n))).toBe(true);
  });

  it("a destination identical to the stored slug is not a move", () => {
    const p = plan({ destSlug: GERMAN_STORED });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("axis-refusal:destination-equals-stored");
  });

  it("slugParts locates the auto flag by VALUE, so a subset segment survives", () => {
    const withSubset = "hiq:baseball:2026:bowman-chrome:sub-1st-bowman:cpa-mg:gold-refractor:auto:num-50";
    const parts = F.slugParts(withSubset);
    expect(parts.subset).toBe("sub-1st-bowman");
    expect(parts.cardNumber).toBe("cpa-mg");
    expect(parts.parallel).toBe("gold-refractor");
    expect(parts.printRun).toBe("50");
    // ...and the subset is IDENTITY: a destination that dropped it is refused.
    expect(F.segmentsThatDiffer(withSubset, GERMAN_DEST).ok).toBe(false);
  });
});

// ── A3: the destination is checklist-backed ────────────────────────────────

describe("A3 -- the destination is CHECKLIST-BACKED, both halves", () => {
  it("MUTATION: drop the checklist-backed assertion and the move is refused", () => {
    const p = plan({ destBacked: false });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("destination-not-checklist-backed");
    // Reported with its destination, so the report can name what was not backed.
    expect(p.dest).toBe(GERMAN_DEST);
  });

  it("MUTATION: the corpus naming no parallel for the family is a refusal", () => {
    // The corpus's SILENCE is a refusal, never a licence to compose a parallel
    // of our own (CF-NO-SYNTHETIC-PARALLELS-ONLY-ACTUALS).
    expect(plan({ checklistParallel: null, destSlug: null }).reason)
      .toBe("checklist-names-no-parallel-for-this-family");
    expect(plan({ checklistParallel: null }).move).toBe(false);
    expect(plan({ destSlug: null }).move).toBe(false);
  });

  it("the destination name carries the COLLISION'S COLOUR, not just the family", () => {
    // The half VOCAB.checklistParallelForFamily deliberately lacks: it takes
    // the shortest name carrying the family words and would offer
    // "shimmer refractor", dropping the gold. Refiling onto the uncoloured
    // Shimmer pool is one card in two pools with our fingerprints on it.
    const names = new Set(["shimmer refractor", "gold shimmer refractor", "green shimmer refractor"]);
    const picked = F.checklistNameForCollision({
      names, family: "gold", titleFamilyTokens: ["shimmer"],
      parallelTokensOf: (n: string) => (/shimmer/.test(n) ? ["shimmer"] : []),
      titleWords: ["2026", "bowman", "marconi", "german", "gold", "shimmer", "raw"],
    });
    expect(picked).toBe("gold shimmer refractor");
  });

  it("MUTATION: no listed name carries the colour -> no destination", () => {
    const picked = F.checklistNameForCollision({
      names: new Set(["shimmer refractor", "green shimmer refractor"]),
      family: "gold", titleFamilyTokens: ["shimmer"],
      parallelTokensOf: (n: string) => (/shimmer/.test(n) ? ["shimmer"] : []),
      titleWords: ["gold", "shimmer"],
    });
    expect(picked).toBeNull();
  });

  it("MUTATION: a second colour the title never says is not offered", () => {
    const picked = F.checklistNameForCollision({
      names: new Set(["gold green shimmer refractor"]),
      family: "gold", titleFamilyTokens: ["shimmer"],
      parallelTokensOf: () => ["shimmer"],
      titleWords: ["gold", "shimmer"],
    });
    expect(picked).toBeNull();
  });

  it("a corpus that carries no such product yields no destination", () => {
    expect(F.checklistNameForCollision({
      names: null, family: "gold", titleFamilyTokens: ["shimmer"],
      parallelTokensOf: () => ["shimmer"], titleWords: ["gold", "shimmer"],
    })).toBeNull();
  });
});

// ── A4: ruled and user rows are report-only forever ────────────────────────

describe("A4 -- PROTECTED is report-only FOREVER", () => {
  it("MUTATION: drop the protected-row refusal and a user-verified row moves", () => {
    const p = plan({ row: germanRow({ verifiedByUser: true }) });
    expect(p.move).toBe(false);
    expect(p.reason).toMatch(/^protected:/);
    expect(p.reason).toContain("verifiedByUser");
    // Counterfactual: the SAME row without the flag is a move, so the refusal
    // is what stopped it and not some other assertion.
    expect(plan().move).toBe(true);
  });

  it("an ebay-user-purchase is protected", () => {
    const p = plan({ row: germanRow({ source: "ebay-user-purchase" }) });
    expect(p.move).toBe(false);
    expect(p.reason).toMatch(/^protected:/);
  });

  it("a row carrying a drew-ruling relocation reason is protected", () => {
    const p = plan({ row: germanRow({ rekeyedReason: "drew-ruling-red-ink-is-the-bw-shimmer-ssp" }) });
    expect(p.move).toBe(false);
    expect(p.reason).toMatch(/^protected:/);
  });

  it("the tier comes from the CLASSIFIER, so a new protected source protects this lane too", () => {
    // Not a local source list: the predicate is K.provenanceTier, and every
    // source K.PROTECTED_SOURCES names is refused here the day it is added.
    for (const src of K.PROTECTED_SOURCES) {
      expect(plan({ row: germanRow({ source: src }) }).move).toBe(false);
    }
    expect(K.PROTECTED_SOURCES.size).toBeGreaterThan(0);
  });

  it("PROTECTED is checked BEFORE the destination, so a protected row never reaches the write shape", () => {
    // Even with every other input absent, the reason is the protection.
    const p = plan({ row: germanRow({ verifiedByUser: true }), destSlug: null, checklistParallel: null, destBacked: false });
    expect(p.reason).toMatch(/^protected:/);
  });
});

// ── A5: an ambiguous finish word is a skip ─────────────────────────────────

describe("A5 -- an insert set sharing the number is AMBIGUOUS, and ambiguous is a skip", () => {
  it("a subsetted checklist row at this number refuses the move", () => {
    const p = plan({ subsettedNamesAtNumber: new Set(["1st Bowman"]) });
    expect(p.move).toBe(false);
    expect(p.reason).toContain("ambiguous:finish-word-names-two-card-families");
    expect(p.reason).toContain("1st bowman");
  });

  it("MUTATION: unanswerable is ambiguous -- absent beats wrong", () => {
    const p = plan({ productHasStrictRows: false });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("ambiguous:checklist-cannot-answer-subset-clash");
  });

  it("blank subsetNames neither create nor join a clash", () => {
    // Blank means UNKNOWN, never "Base"
    // (CF-EVERY-INGEST-USES-THE-ONE-CHECKLIST-FORMAT).
    expect(F.finishIsAmbiguousAtNumber({
      subsettedNamesAtNumber: new Set(["", "  "]), productHasStrictRows: true,
    }).ambiguous).toBe(false);
  });

  it("ONE subsetted row is the threshold here, not two", () => {
    // The census's clashMap compares subsetted rows against EACH OTHER and so
    // needs two. This compares them against the UNSUBSETTED parallel the lane
    // moves a row onto, so one is already a shared address.
    expect(F.finishIsAmbiguousAtNumber({
      subsettedNamesAtNumber: new Set(["Chrome Prospects"]), productHasStrictRows: true,
    }).ambiguous).toBe(true);
    expect(F.finishIsAmbiguousAtNumber({
      subsettedNamesAtNumber: new Set(), productHasStrictRows: true,
    }).ambiguous).toBe(false);
  });
});

// ── the write shape ────────────────────────────────────────────────────────

/** A call-RECORDING stand-in for a Cosmos container. Every method appends to
 *  `calls` before doing anything, so "no write happened" is provable as "no
 *  call happened at all" rather than inferred from an unchanged store. */
function recordingPool(seed: Record<string, unknown>[]) {
  const key = (id: string, cardId: string) => `${cardId} ${id}`;
  const store = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  for (const d of seed) store.set(key(String(d.id), String(d.cardId)), { ...d });
  const notFound = () => Object.assign(new Error("NotFound"), { code: 404 });
  return {
    store,
    calls,
    item(id: string, cardId: string) {
      return {
        read: async () => {
          calls.push(`read ${key(id, cardId)}`);
          const r = store.get(key(id, cardId));
          if (!r) throw notFound();
          return { resource: { ...r } };
        },
        delete: async () => {
          calls.push(`delete ${key(id, cardId)}`);
          if (!store.delete(key(id, cardId))) throw notFound();
          return {};
        },
      };
    },
    items: {
      upsert: async (doc: Record<string, unknown>) => {
        calls.push(`upsert ${key(String(doc.id), String(doc.cardId))}`);
        store.set(key(String(doc.id), String(doc.cardId)), { ...doc });
        return { resource: { ...doc } };
      },
    },
  };
}

/** The lane's per-row write, exactly as the driver performs it. */
async function runLaneMove(
  pool: ReturnType<typeof recordingPool>,
  row: Record<string, unknown>,
  dryRun: boolean,
) {
  const p = F.planFinishCollisionRefile({
    row, stored: germanStored(), storedSlug: row.cardId,
    destSlug: GERMAN_DEST, checklistParallel: "Gold Shimmer Refractor",
    destBacked: true, subsettedNamesAtNumber: new Set(), productHasStrictRows: true,
  });
  expect(p.move).toBe(true);
  const keep = stripSystem(row);
  const oldPk = String(row.cardId ?? "");
  if (oldPk && !oldPk.startsWith("hiq:")) keep.vendorCardIdWas = oldPk;
  keep.cardId = p.dest;
  keep.hobbyiqCardId = p.dest;
  keep.parallel = "Gold Shimmer Refractor";
  keep.parallelBefore = String(row.parallel ?? "");
  keep.rekeyedFrom = p.evidence.addressSlug;
  keep.rekeyedAt = new Date().toISOString();
  keep.rekeyedReason = F.REASON;
  keep.rekeyedEvidence = { titleQuoted: p.evidence.titleQuoted, rule: F.REASON_LONG };
  keep.contentHash = contentHashOf(keep);
  const res = await relocateSoldComp(pool, {
    keep,
    drop: [{ id: row.id, cardId: row.cardId }],
    verifyFields: ["cardId", "hobbyiqCardId", "parallel", "contentHash", "rekeyedFrom"],
    dryRun,
  });
  return { res, keep, plan: p };
}

describe("the dry run is provably write-free", () => {
  it("a report-mode move performs NO container call at all", async () => {
    const pool = recordingPool([germanRow()]);
    const { res } = await runLaneMove(pool, germanRow(), /* dryRun */ true);

    expect(res.stage).toBe("dry-run");
    expect(res.ok).toBe(true);
    // The guarantee stated as the ABSENCE OF EVERY CALL -- not as an unchanged
    // store, which a compensating pair of writes could also produce.
    expect(pool.calls).toEqual([]);
    expect(pool.store.size).toBe(1);
    expect([...pool.store.values()][0].hobbyiqCardId).toBe(GERMAN_STORED);
  });

  it("the SAME row in apply mode moves both fields and drops the old row", async () => {
    // The counterfactual: identical input, dryRun off. If this did not write,
    // the test above would prove nothing.
    const pool = recordingPool([germanRow()]);
    const { res, keep } = await runLaneMove(pool, germanRow(), /* dryRun */ false);

    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.duplicatesLeft).toHaveLength(0);
    // upsert -> read back -> delete, in that order: a sale is never lost.
    expect(pool.calls.filter((c) => c.startsWith("upsert"))).toHaveLength(1);
    expect(pool.calls.filter((c) => c.startsWith("delete"))).toHaveLength(1);
    expect(pool.calls.findIndex((c) => c.startsWith("upsert")))
      .toBeLessThan(pool.calls.findIndex((c) => c.startsWith("delete")));

    const rows = [...pool.store.values()];
    expect(rows).toHaveLength(1);
    // BOTH identity fields land -- the exact-pool reader ORs them, so a move
    // that rewrites one has not moved the sale.
    expect(rows[0].cardId).toBe(GERMAN_DEST);
    expect(rows[0].hobbyiqCardId).toBe(GERMAN_DEST);
    // The vendor partition key is preserved as provenance, not lost.
    expect(rows[0].vendorCardIdWas).toBe("1778541264103x262828165280045280");
    // The ledger, with the QUOTED TITLE as its evidence.
    expect(rows[0].rekeyedFrom).toBe(GERMAN_STORED);
    expect(rows[0].rekeyedReason).toBe(F.REASON);
    expect(String(rows[0].rekeyedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((rows[0].rekeyedEvidence as Record<string, unknown>).titleQuoted)
      .toContain("Gold Shimmer /50");
    // The sale itself is carried across untouched.
    expect(rows[0].price).toBe(102.5);
    expect(rows[0].title).toBe(germanRow().title);
    // THE HASH FOLLOWS THE ADDRESS -- cardId is its first component.
    expect(rows[0].contentHash).toBe(keep.contentHash);
    expect(rows[0].contentHash).not.toBe(contentHashOf(germanRow()));
  });

  it("MUTATION: a hash left at the old address is invisible to pre-write dedup", () => {
    const moved = { ...germanRow(), cardId: GERMAN_DEST, hobbyiqCardId: GERMAN_DEST };
    expect(contentHashOf(moved)).not.toBe(contentHashOf(germanRow()));
  });
});

// ── the lane source keeps its guarantees ───────────────────────────────────

const script = readFileSync(
  path.join(__dirname, "..", "scripts", "repair-finish-collision-refile.cjs"), "utf8",
);

describe("the lane refuses an unnamed scope", () => {
  it("has a scope refusal that runs before any Cosmos read", () => {
    expect(script).toContain("FATAL: SCOPE is REQUIRED");
    expect(script.indexOf("FATAL: SCOPE is REQUIRED"))
      .toBeLessThan(script.indexOf("process.env.COSMOS_CONNECTION_STRING"));
  });

  it("the inherited default and 'all' are refused, never treated as everything", () => {
    const lane = req(path.resolve(__dirname, "../scripts/repair-finish-collision-refile.cjs"));
    expect(lane.INHERITED_SCOPES.has("refractor")).toBe(true);
    expect(lane.INHERITED_SCOPES.has("all")).toBe(true);
    expect(lane.INHERITED_SCOPES.has("")).toBe(true);
    // The scope shape is sport:year:setKey and nothing else parses.
    expect(lane.PRODUCT_RE.test("baseball:2026:bowman-chrome")).toBe(true);
    expect(lane.PRODUCT_RE.test("refractor")).toBe(false);
    expect(lane.PRODUCT_RE.test("all")).toBe(false);
    expect(lane.PRODUCT_RE.test("bowman-chrome")).toBe(false);
  });

  it("reads BACKFILL_APPLY, which is what the runner exports", () => {
    expect(script).toContain('String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true"');
  });

  it("a REPORT-mode run that moved a pool exits 3", () => {
    expect(script).toContain("a REPORT-ONLY run changed this pool by");
    expect(script).toContain("process.exit(3)");
  });

  it("verifies BOTH identity fields by read -- the pool reader ORs them", () => {
    expect(script).toContain('verifyFields: ["cardId", "hobbyiqCardId", "parallel", "contentHash", "rekeyedFrom"]');
  });

  it("reconciles intended = written + skipped + failed", () => {
    expect(script).toContain("reconciled: intended");
    expect(script).toContain('reportWrites({ job: "repair-finish-collision-refile"');
  });

  it("shards OPT-IN through the #1765 helper, on the row's own id", () => {
    expect(script).toContain("runnerShardScope");
    expect(script).toContain("SHARD_SCOPE.mine(shardIndex(r.id))");
  });

  it("SELECTs the whole row -- a projection would drop fields on the re-key", () => {
    expect(script).toContain("SELECT * FROM c WHERE STARTSWITH");
  });
});

// ── THE RUNNER CONTRACT ────────────────────────────────────────────────────
//
// The runner execs generically -- `node "backend/scripts/${{ inputs.script }}.cjs"`
// -- so the `script` DROPDOWN is the only gate that exists. A script absent
// from that list cannot be dispatched at all, which makes dropdown membership a
// real contract.

const runner = readFileSync(
  path.join(__dirname, "..", "..", ".github", "workflows", "backfill-runner.yml"), "utf8",
).replace(/\r\n/g, "\n");

describe("the runner can dispatch this lane", () => {
  it("the script is on the whitelist", () => {
    expect(runner).toContain("          - repair-finish-collision-refile\n");
  });

  it("the scope gate refuses the inherited default in BOTH modes", () => {
    expect(runner).toContain("The finish-collision refile names its scope");
    // No `inputs.apply` in the condition: a report over an unnamed scope is
    // refused exactly as an apply is.
    expect(runner).toContain("if: ${{ inputs.script == 'repair-finish-collision-refile' }}");
    expect(runner).toContain('[ "$SCOPE" = "refractor" ]');
  });

  it("has a relaunch step that forwards apply and scope VERBATIM", () => {
    const step = runner.slice(runner.indexOf("Self-relaunch the finish-collision refile"));
    expect(step).toContain("-f script=repair-finish-collision-refile");
    // #1578: a report that relaunches as a write is the defect that rule
    // exists to stop, and hardcoding EITHER value is how it happens.
    expect(step).toContain('-f apply="${{ inputs.apply }}"');
    expect(step).toContain('-f scope="${{ inputs.scope }}"');
    expect(step).not.toContain("-f apply=\"true\"");
  });

  it("adds NO new workflow_dispatch input -- GitHub caps at 25 and 24 are used", () => {
    const inputsBlock = runner.slice(runner.indexOf("    inputs:"), runner.indexOf("permissions:"));
    const names = [...inputsBlock.matchAll(/^      ([a-z_]+):$/gm)].map((m) => m[1]);
    expect(names.length).toBeLessThanOrEqual(25);
    // The scope rides the EXISTING `scope` input.
    expect(names).toContain("scope");
    expect(names).not.toContain("products");
    expect(names).not.toContain("finish_family");
  });

  it("the predicate lib is checked before the lane reaches Cosmos", () => {
    expect(runner).toContain("The finish-collision predicate lib is present");
    expect(runner).toContain("for LIB in finish-collision-refile rematch-classify relocate-sold-comp");
  });
});
