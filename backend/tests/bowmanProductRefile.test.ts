/**
 * CF-IT-CAME-OUT-OF-BOWMAN (Drew, 2026-08-13, re-affirmed 2026-09-05).
 *
 * The pins for `scripts/lib/bowman-product-refile.cjs` -- the pure decisions
 * behind the repair lane. They drive exactly the code the fleet runs.
 *
 * The mutation checks the ruling asks for:
 *   - drop the different-player guard                     -> red
 *   - let a collision-number sale with no player move     -> red
 *   - let the re-mint move a segment other than the product -> red
 *   - repair the LEGITIMATE direction (field extends stem) -> red
 *   - let a dry run write                                  -> red (recording fake)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const B = require_("../scripts/lib/bowman-product-refile.cjs");
const REL = require_("../scripts/lib/relocate-sold-comp.cjs");

const catalogRow = (over: Record<string, unknown> = {}) => ({
  id: "hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499",
  setKey: "bowman",
  setName: "2026 Bowman Baseball",
  playerName: "Adrian Gil",
  cardNumber: "CPA-AG",
  source: "checklistcenter-2026-08-29",
  ...over,
});

describe("the drift it repairs is DIRECTIONAL", () => {
  it("a stale-generic field under a more specific stem is the defect", () => {
    expect(B.isStaleGenericField("bowman", "bowman-chrome")).toBe(true);
    expect(B.isStaleGenericField("bowman", "bowman-paper")).toBe(true);
    expect(B.isStaleGenericField("bowman", "bowman-chrome-sapphire")).toBe(true);
  });

  // THE MUTATION CHECK for "repair the legitimate direction too". These are
  // 1,223 rows a week and they are the BETTER identity of the two.
  it("a field that EXTENDS its stem is left alone — it is not this defect", () => {
    expect(B.isStaleGenericField("topps-baseball-japan-edition", "topps")).toBe(false);
    expect(B.isStaleGenericField("bowman", "bowman")).toBe(false);
    expect(B.isStaleGenericField("", "bowman")).toBe(false);
  });

  it("a clean row is skipped by name, never silently", () => {
    const p = B.planCatalogRefile({ row: catalogRow({ setKey: "bowman-chrome" }) });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(B.SKIP.NOT_DRIFTED);
  });
});

describe("only the product segment may move", () => {
  const S = "hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499";

  it("accepts a product-only change", () => {
    const r = B.onlyProductSegmentMoves(S, S.replace(":bowman-chrome:", ":bowman:"));
    expect(r.ok).toBe(true);
    expect(r.differing).toEqual(["setKey"]);
  });

  // THE MUTATION CHECK: a re-mint that also renumbered the card is some other
  // disagreement wearing this lane's clothes.
  it("REFUSES a re-mint that also moves the card number or the parallel", () => {
    expect(B.onlyProductSegmentMoves(S, S.replace(":cpa-ag:", ":cpa-ah:")).ok).toBe(false);
    expect(B.onlyProductSegmentMoves(S, S.replace(":refractor:", ":base:")).ok).toBe(false);
    expect(B.onlyProductSegmentMoves(S, S.replace(":num-499", "")).ok).toBe(false);
  });

  it("a plan whose re-mint moves another axis skips with the axis named", () => {
    const p = B.planCatalogRefile({
      row: catalogRow(),
      destSlug: "hiq:baseball:2026:bowman:cpa-ah:refractor:auto:num-499",
    });
    expect(p.move).toBe(false);
    expect(p.reason).toMatch(/^remint-moves-more-than-the-product:/);
  });
});

describe("the happy path: a Bowman CPA row goes home", () => {
  it("moves to the bowman stem when the destination is empty", () => {
    const p = B.planCatalogRefile({
      row: catalogRow(),
      destSlug: "hiq:baseball:2026:bowman:cpa-ag:refractor:auto:num-499",
      destPlayerName: null,
    });
    expect(p.move).toBe(true);
    expect(p.dest).toContain(":bowman:");
    expect(p.evidence.rule).toMatch(/CF-IT-CAME-OUT-OF-BOWMAN/);
  });

  it("moves when the destination holds the SAME player, spelled differently", () => {
    const p = B.planCatalogRefile({
      row: catalogRow(),
      destSlug: "hiq:baseball:2026:bowman:cpa-ag:refractor:auto:num-499",
      destPlayerName: "adrian  gil",
    });
    expect(p.move).toBe(true);
  });

  it("a protected row is report-only forever", () => {
    const p = B.planCatalogRefile({
      row: catalogRow(),
      destSlug: "hiq:baseball:2026:bowman:cpa-ag:refractor:auto:num-499",
      isProtected: true,
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(B.SKIP.PROTECTED);
  });

  it("a row that states no product name cannot be re-minted from anything", () => {
    const p = B.planCatalogRefile({ row: catalogRow({ setName: null }), destSlug: null });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(B.SKIP.NO_SET_NAME);
  });
});

/**
 * THE ABSOLUTE GUARD. This is the whole reason the lane can be trusted with
 * 19,867 rows: CPA-AG is Adrian Gil in Bowman and Angeibel Gomez in Bowman
 * Chrome, and merging them pools two people's cards irreversibly.
 */
describe("the absolute guard: a different player at the destination", () => {
  // THE MUTATION CHECK: delete the guard and this goes green with a merge.
  it("REFUSES the move and names BOTH players", () => {
    const p = B.planCatalogRefile({
      row: catalogRow({ playerName: "Angeibel Gomez", setKey: "bowman" }),
      destSlug: "hiq:baseball:2026:bowman:cpa-ag:refractor:auto:num-499",
      destPlayerName: "Adrian Gil",
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(B.SKIP.DEST_DIFFERENT_PLAYER);
    expect(p.evidence.player).toBe("Angeibel Gomez");
    expect(p.evidence.destPlayer).toBe("Adrian Gil");
  });

  // A null is NOT agreement -- cpaProductRule says so in as many words.
  it("a row with no player of its own cannot clear the guard", () => {
    const p = B.planCatalogRefile({
      row: catalogRow({ playerName: null }),
      destSlug: "hiq:baseball:2026:bowman:cpa-ag:refractor:auto:num-499",
      destPlayerName: "Adrian Gil",
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe(B.SKIP.ROW_HAS_NO_PLAYER);
  });

  it("all nine collisions refuse, none merge", () => {
    const nine = [
      ["cpa-em", "Edgar Montero", "Ezequiel Melbourne"],
      ["cpa-la", "Luis Arana", "Louis Andujar"],
      ["cpa-df", "Dauri Fernandez", "Diego Frontado"],
      ["cpa-hl", "Henry Lalane", "Hyun Seung Lee"],
      ["cpa-wa", "Wehiwa Aloy", "Wandy Asigen"],
      ["cpa-js", "Juan Sanchez", "Jaider Suarez"],
      ["cpa-bc", "Billy Carlson", "Brandon Clarke"],
      ["cpa-ag", "Adrian Gil", "Angeibel Gomez"],
      ["bcp-151", "Seong-Jun Kim", "Slater de Brun"],
    ];
    for (const [num, bowmanPlayer, chromePlayer] of nine) {
      const p = B.planCatalogRefile({
        row: catalogRow({
          id: `hiq:baseball:2026:bowman-chrome:${num}:base:auto`,
          playerName: chromePlayer,
          cardNumber: num.toUpperCase(),
        }),
        destSlug: `hiq:baseball:2026:bowman:${num}:base:auto`,
        destPlayerName: bowmanPlayer,
      });
      expect(p.move, `${num} must not merge`).toBe(false);
      expect(p.reason).toBe(B.SKIP.DEST_DIFFERENT_PLAYER);
    }
  });
});

/**
 * THE SALE SIDE. Drew, 2026-09-05: a sale on a collision number with no
 * readable player PARKS -- "never default to either side".
 */
describe("a sale returns to Bowman only when a checklist says who it is", () => {
  const sale = (over: Record<string, unknown> = {}) => ({
    id: "sale-1",
    cardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto",
    hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto",
    cardNumber: "CPA-EHA",
    playerName: "Eric Hartman",
    title: "2026 Bowman Eric Hartman Braves 1st Bowman Chrome Prospect Auto #CPA-EHA",
    ...over,
  });

  it("moves when a bowman checklist names the player and Chrome does not", () => {
    const p = B.planSaleRefile({
      row: sale(),
      destSlug: "hiq:baseball:2026:bowman:cpa-eha:base:auto",
      bowmanClaims: { playerName: "Eric Hartman" },
      chromeClaims: null,
    });
    expect(p.move).toBe(true);
  });

  // THE MUTATION CHECK for the park ruling.
  it("PARKS a collision-number sale whose player cannot be read", () => {
    const p = B.planSaleRefile({
      row: sale({ cardNumber: "CPA-AG", playerName: null, title: "2026 Bowman #CPA-AG Auto" }),
      destSlug: "hiq:baseball:2026:bowman:cpa-ag:base:auto",
      bowmanClaims: { playerName: "Adrian Gil" },
      chromeClaims: { playerName: "Angeibel Gomez" },
      isCollisionNumber: true,
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("collision-number-no-player");
    expect(p.evidence.parks).toBe(true);
    // It never picks a side.
    expect(p.dest).toBeNull();
  });

  it("a readable player on a collision number still decides the card", () => {
    const p = B.planSaleRefile({
      row: sale({ cardNumber: "CPA-AG", playerName: "Adrian Gil" }),
      destSlug: "hiq:baseball:2026:bowman:cpa-ag:base:auto",
      bowmanClaims: { playerName: "Adrian Gil" },
      chromeClaims: { playerName: "Angeibel Gomez" },
      isCollisionNumber: true,
    });
    expect(p.move).toBe(true);
  });

  it("SKIPS when no bowman checklist claims the player", () => {
    const p = B.planSaleRefile({
      row: sale(),
      destSlug: "hiq:baseball:2026:bowman:cpa-eha:base:auto",
      bowmanClaims: null,
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("no-bowman-checklist-claims-this-player");
  });

  it("SKIPS when BOTH checklists claim the same player — we cannot tell which product", () => {
    const p = B.planSaleRefile({
      row: sale(),
      destSlug: "hiq:baseball:2026:bowman:cpa-eha:base:auto",
      bowmanClaims: { playerName: "Eric Hartman" },
      chromeClaims: { playerName: "Eric Hartman" },
    });
    expect(p.move).toBe(false);
    expect(p.reason).toBe("both-checklists-claim-this-player");
  });

  it("every refusal names a reason — there is no silent skip", () => {
    const plans = [
      B.planSaleRefile({ row: sale({ playerName: null }) }),
      B.planSaleRefile({ row: sale(), bowmanClaims: null }),
      B.planSaleRefile({ row: sale(), isProtected: true }),
      B.planCatalogRefile({ row: catalogRow({ setKey: "bowman-chrome" }) }),
      B.planCatalogRefile({ row: catalogRow({ setName: null }) }),
    ];
    for (const p of plans) {
      expect(p.move).toBe(false);
      expect(typeof p.reason).toBe("string");
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * THE DRY RUN IS PROVEN WRITE-FREE BY MEASUREMENT, not by intent.
 *
 * A recording fake stands in for the Cosmos container and counts every write
 * it is asked to make. `dryRun: true` must leave that count at zero.
 */
describe("a dry run writes nothing (recording fake)", () => {
  const recordingPool = () => {
    const calls: string[] = [];
    return {
      calls,
      items: {
        upsert: async (d: unknown) => { calls.push("upsert"); return { resource: d }; },
        query: () => ({ fetchAll: async () => ({ resources: [0] }) }),
      },
      item: () => ({
        read: async () => { calls.push("read"); return { resource: null }; },
        delete: async () => { calls.push("delete"); return {}; },
      }),
    };
  };

  it("relocateSoldComp in dryRun mode touches nothing", async () => {
    const pool = recordingPool();
    const out = await REL.relocateSoldComp(pool, {
      keep: { id: "s1", cardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto" },
      drop: [{ id: "s1", cardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto" }],
      dryRun: true,
    });
    expect(out.ok).toBe(true);
    expect(out.stage).toBe("dry-run");
    expect(out.wouldDelete).toBe(1);
    // THE MUTATION CHECK: let the dry run through to the write and this fails.
    expect(pool.calls).toEqual([]);
  });

  it("a real relocate upserts and verifies BEFORE it deletes — CF-A-SALE-IS-NEVER-LOST", async () => {
    const order: string[] = [];
    const keep = { id: "s1", cardId: "hiq:baseball:2026:bowman:cpa-eha:base:auto" };
    const pool = {
      items: { upsert: async (d: unknown) => { order.push("upsert"); return { resource: d }; } },
      item: (id: string, pk: string) => ({
        read: async () => {
          order.push("read");
          return { resource: pk === keep.cardId ? { ...keep } : null };
        },
        delete: async () => { order.push("delete"); return {}; },
      }),
    };
    const out = await REL.relocateSoldComp(pool, {
      keep,
      drop: [{ id: "s1", cardId: "hiq:baseball:2026:bowman-chrome:cpa-eha:base:auto" }],
    });
    expect(out.ok).toBe(true);
    // The delete is LAST, and an upsert+verify precede it.
    expect(order.indexOf("upsert")).toBeLessThan(order.indexOf("delete"));
    expect(order.lastIndexOf("read")).toBeLessThan(order.indexOf("delete"));
  });
});

/**
 * CF-A-REPORT-THAT-CANNOT-FAIL-LIKE-THE-APPLY-IS-NOT-A-REHEARSAL.
 *
 * Run 33974629259 (APPLY) died on its FIRST row with refiled=0:
 *
 *   moveCatalogRow: newSlug says setKey "bowman" but the row's id says
 *   "bowman-chrome" (hiq:baseball:2026:bowman-chrome:bcp-102:base:no-auto ->
 *   hiq:baseball:2026:bowman:bcp-102:base:no-auto) and no setKey change was
 *   asked for -- a cross-product move is not a move
 *
 * The report run before it was clean, because REPORT skipped `moveCatalogRow`
 * entirely and only APPLY reached it. Two paths, never the same code.
 *
 * These pins drive the REAL `moveCatalogRow` -- never a stub -- against a
 * recording fake container, on that exact row shape.
 */
describe("the catalog move declares its setKey change (real moveCatalogRow)", () => {
  // The sibling suite in this file's neighbourhood mocks `@azure/cosmos` and
  // calls vi.resetModules(); these pins import the REAL catalogRowOps and pass
  // their own fake container, so they must not inherit that module registry.
  // Without this the suite passes alone and fails when run beside it -- an
  // order-dependent pin is a pin nobody can trust.
  beforeEach(() => { vi.resetModules(); vi.doUnmock("@azure/cosmos"); });
  afterEach(() => { vi.resetModules(); });

  const OLD_ID = "hiq:baseball:2026:bowman-chrome:bcp-102:base:no-auto";
  const NEW_ID = "hiq:baseball:2026:bowman:bcp-102:base:no-auto";

  const row = () => ({
    id: OLD_ID, cardId: OLD_ID, hobbyiqCardId: OLD_ID,
    sport: "baseball", year: 2026, cardYear: 2026,
    setKey: "bowman", setName: "2026 Bowman Baseball",
    cardNumber: "BCP-102", parallel: "Base", parallelSlug: "base",
    isAuto: false, printRun: null,
    playerName: "Eric Hartman", playerSlug: "eric-hartman",
    source: "checklistcenter-2026-08-29", confidence: 0.95, vendorIds: {},
  });

  const fakeContainer = () => {
    const writes: string[] = [];
    return {
      writes,
      items: {
        upsert: async (d: unknown) => { writes.push("upsert"); return { resource: d }; },
        query: () => ({
          fetchNext: async () => ({ resources: [], continuationToken: undefined }),
          fetchAll: async () => ({ resources: [] }),
        }),
      },
      item: () => ({
        read: async () => ({ resource: null }),
        patch: async () => { writes.push("patch"); return {}; },
        delete: async () => { writes.push("delete"); return {}; },
      }),
    };
  };

  it("REFUSES the move when the setKey change is NOT declared — the exact prod error", async () => {
    const { moveCatalogRow } = await import("../src/services/catalog/catalogRowOps.service.js");
    const cat = fakeContainer();
    await expect(
      moveCatalogRow(cat as never, row() as never, NEW_ID, {}, { reason: "test" }),
    ).rejects.toThrow(/cross-product move is not a move/);
    expect(cat.writes).toEqual([]);
  });

  // THE FIX. Declaring the destination's own stem satisfies the guard.
  it("ACCEPTS the move when the destination's stem is declared", async () => {
    const { moveCatalogRow } = await import("../src/services/catalog/catalogRowOps.service.js");
    const cat = fakeContainer();
    const destSetKey = B.idStem(NEW_ID);
    expect(destSetKey).toBe("bowman");
    const res = await moveCatalogRow(
      cat as never, row() as never, NEW_ID, { setKey: destSetKey },
      { reason: "test", repointNormalizedSetKey: true },
    );
    expect(res.action).toBe("move");
    expect(res.newSlug).toBe(NEW_ID);
    expect(cat.writes).toContain("upsert");
  });

  // REPORT/APPLY PARITY: dryRun runs every guard and writes nothing. This is
  // what makes the report a real rehearsal of the apply.
  it("dryRun exercises the SAME guard and writes nothing", async () => {
    const { moveCatalogRow } = await import("../src/services/catalog/catalogRowOps.service.js");

    const bad = fakeContainer();
    await expect(
      moveCatalogRow(bad as never, row() as never, NEW_ID, {}, { reason: "test", dryRun: true }),
    ).rejects.toThrow(/cross-product move is not a move/);
    expect(bad.writes).toEqual([]);

    const good = fakeContainer();
    const res = await moveCatalogRow(
      good as never, row() as never, NEW_ID, { setKey: B.idStem(NEW_ID) },
      { reason: "test", dryRun: true },
    );
    expect(res.action).toBe("move");
    expect(good.writes).toEqual([]);
  });

  // The declaration is read off the SLUG, so the thing declared and the thing
  // written cannot disagree.
  it("the declared setKey is the destination's own stem, for every bucket", () => {
    expect(B.idStem("hiq:baseball:2026:bowman:bcp-102:base:no-auto")).toBe("bowman");
    expect(B.idStem("hiq:baseball:2007:bowman:bp-4:blue:no-auto:num-500")).toBe("bowman");
    expect(B.idStem(NEW_ID)).toBe("bowman");
  });
});

/**
 * ── THE CANARY ATTRIBUTES THIS LANE'S OWN WRITES ──────────────────────────
 *
 * Run 34009971035 (2026-09-06T03:49:51Z→03:53:47Z, MODE=sales, APPLY, scope
 * baseball:2026:bowman-chrome) refiled 1,835 sales exactly as ruled and was
 * then failed by its own canary, exit 3, "a collision may have been merged":
 *
 *     cpa-ag  16 -> 5      cpa-em  17 -> 8
 *     cpa-hl  87 -> 7      cpa-wa  91 -> 15      bcp-151  0 -> 0
 *
 * Nothing merged. Read against the pool afterwards, every single departed row
 * carried that run's `reslugedFrom` stamp and the CF-IT-CAME-OUT-OF-BOWMAN
 * reason, landed on `hiq:baseball:2026:bowman:<num>:base:auto`, and named the
 * BOWMAN-side player; the collision player's rows never moved. Source drop
 * equalled destination gain in all four pools (11/9/80/76). The anchors ARE
 * the address the sales lane drains, so the gate was firing on success.
 *
 * These pin the fix, and the mutations that must stay red:
 *   - a delta the ledger explains exactly            -> PASS
 *   - one row's write missing from the ledger        -> FAIL (the mutation)
 *   - a pool the ledger never names                  -> another writer, PASS
 *   - no ledger at all                               -> STRICT, FAIL
 */
describe("the canary attributes this lane's own writes", () => {
  const P = (n: string) => `hiq:baseball:2026:bowman-chrome:${n}:base:auto`;

  // The four pools exactly as run 34009971035 left them, with the ledger the
  // lane now emits for the moves it actually made.
  const RUN = [
    { num: "cpa-ag", before: 16, after: 5, out: 11 },
    { num: "cpa-em", before: 17, after: 8, out: 9 },
    { num: "cpa-hl", before: 87, after: 7, out: 80 },
    { num: "cpa-wa", before: 91, after: 15, out: 76 },
  ];

  it("the run that was falsely halted now PASSES, every pool attributed", () => {
    for (const { num, before, after, out } of RUN) {
      const v = B.attributeCanary(P(num), before, after, { fromCount: out, toCount: 0 });
      expect(v.verdict).toBe("ATTRIBUTED");
      expect(v.ok).toBe(true);
      // The arithmetic is printed, not asserted on trust.
      expect(v.expected).toBe(after);
      expect(v.from).toBe(out);
      expect(v.delta).toBe(after - before);
    }
  });

  it("the untouched anchor is UNCHANGED, not merely un-blamed", () => {
    // bcp-151 was 0 -> 0. A pool that did not move must not be dressed up as
    // an attributed change.
    const v = B.attributeCanary(P("bcp-151"), 0, 0, undefined);
    expect(v.verdict).toBe("UNCHANGED");
    expect(v.ok).toBe(true);
  });

  // ── THE MUTATION ────────────────────────────────────────────────────────
  // Drop ONE row from the ledger and the pool must go red. This is the whole
  // guarantee: attribution relaxes the gate exactly as far as the lane can
  // prove it wrote, and not one row further.
  it("one row's write missing from the ledger still FAILS", () => {
    const v = B.attributeCanary(P("cpa-hl"), 87, 7, { fromCount: 79, toCount: 0 });
    expect(v.verdict).toBe("UNEXPLAINED");
    expect(v.ok).toBe(false);
    expect(v.expected).toBe(8);          // 87 - 79
    expect(v.note).toMatch(/cannot account for/);
  });

  it("a pool the ledger never names is ANOTHER writer's change, not this lane's damage", () => {
    // sold_comps has many writers -- the CardHedge daily ingest, the dedup
    // cron, the ingest lanes. A lane that wrote nothing here cannot have
    // damaged it. #1711/#1727.
    const v = B.attributeCanary(P("cpa-ag"), 16, 20, undefined);
    expect(v.verdict).toBe("OTHER-WRITER");
    expect(v.ok).toBe(true);
    expect(v.from).toBe(0);
    expect(v.to).toBe(0);
  });

  it("rows arriving IN a pool are attributed too — a refile changes both ends", () => {
    const v = B.attributeCanary("hiq:baseball:2026:bowman:cpa-hl:base:auto", 473, 553, { fromCount: 0, toCount: 80 });
    expect(v.verdict).toBe("ATTRIBUTED");
    expect(v.expected).toBe(553);
    expect(v.ok).toBe(true);
  });

  // ── THE GATE DEGRADES CLOSED ────────────────────────────────────────────
  it("no ledger at all is STRICT — a checker that cannot attribute hands out no passes", () => {
    const explicitNull = B.attributeCanary(P("cpa-hl"), 87, 7, null);
    expect(explicitNull.verdict).toBe("UNEXPLAINED");
    expect(explicitNull.ok).toBe(false);
    expect(explicitNull.note).toMatch(/no write ledger/);

    // A caller that omits the argument entirely is a caller with no ledger.
    // `undefined` as an ABSENT argument must not be read as the relaxing
    // "ledger exists, does not name this pool" case.
    const omitted = (B.attributeCanary as (...a: unknown[]) => { verdict: string; ok: boolean })(P("cpa-hl"), 87, 7);
    expect(omitted.verdict).toBe("UNEXPLAINED");
    expect(omitted.ok).toBe(false);
  });

  it("an anchor that could not be re-read is UNCONFIRMED, never a pass", () => {
    // A count we did not take cannot clear the canary.
    const v = B.attributeCanary(P("cpa-wa"), 91, null, { fromCount: 76, toCount: 0 });
    expect(v.verdict).toBe("UNCONFIRMED");
    expect(v.unread).toBe(true);
    expect(v.ok).toBe(false);
  });

  it("a REPORT-only run cannot be relaxed by an empty ledger", () => {
    // The lane passes `null` under !APPLY precisely so that a dry run which
    // moved a pool is still proven wrong BY MEASUREMENT rather than excused
    // by the absence of writes it claims not to have made.
    const v = B.attributeCanary(P("cpa-ag"), 16, 5, null);
    expect(v.ok).toBe(false);
  });

  // A ROW COUNTED IN TWO POOLS MUST BE RECORDED IN TWO POOLS.
  //
  // `poolCount` ORs cardId and hobbyiqCardId, so a row whose two identity
  // fields disagree is counted in BOTH pools -- 5 of the 8 rows left in the
  // cpa-em anchor are exactly that (cardId on the Chrome slug, hobbyiqCardId
  // already on Bowman). The lane records the departure under both addresses;
  // if it recorded only `reslugedFrom` the OTHER anchor would show an
  // unattributed drop and the lane would be failed for a move it fully
  // accounted for -- the same false halt, one level down.
  it("a split-identity row drains both anchors, and both are attributed", () => {
    // The chrome anchor loses the row even though reslugedFrom named Bowman.
    const chrome = B.attributeCanary(P("cpa-em"), 17, 16, { fromCount: 1, toCount: 0 });
    expect(chrome.verdict).toBe("ATTRIBUTED");
    expect(chrome.ok).toBe(true);

    // Recording only one side is the regression this guards: the anchor drops
    // but the ledger says the lane took nothing out of it.
    const unrecorded = B.attributeCanary(P("cpa-em"), 17, 16, { fromCount: 0, toCount: 0 });
    expect(unrecorded.verdict).toBe("UNEXPLAINED");
    expect(unrecorded.ok).toBe(false);
  });
});
