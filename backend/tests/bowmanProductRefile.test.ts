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
import { describe, it, expect } from "vitest";
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
