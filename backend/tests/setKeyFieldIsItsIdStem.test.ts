/**
 * CF-A-ROWS-SETKEY-FIELD-IS-ITS-ID-STEM (Drew, 2026-09-05).
 *
 * A catalog row is ADDRESSED by its id, and segment 3 of that id is the
 * product. The `setKey` field must name that same product. 19,867 stored 2026
 * Bowman rows do not (census 2026-09-05), and the population was still growing
 * at ~4,700 rows/week when this was written.
 *
 * These pins are the mutation checks the ruling asks for:
 *   - delete the guard call in `upsertCatalogEntry`                     -> red
 *   - drop `authoritativeSetKey: true` from a checklist ingest's mint   -> red
 *   - make the invariant a bare equality (field === stem)               -> red
 *     (it would refuse `topps-baseball-japan-edition` over stem `topps`,
 *      1,223 legitimate rows in the last 7 days)
 *   - let a collision number pool without a player                      -> red
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkSetKeyFieldMatchesIdStem,
  assertSetKeyFieldMatchesIdStem,
  setKeyFieldExtendsStem,
  idSetKeyStem,
} from "../src/services/catalog/setKeyFieldInvariant.js";
import { deriveCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service.js";
import {
  decideCollisionPark,
  findInitialsCollision,
  COLLISION_NUMBER_NO_PLAYER,
} from "../src/services/catalog/initialsCollisionPark.js";

describe("the invariant reads the id structurally", () => {
  it("the stem is segment 3", () => {
    expect(idSetKeyStem("hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499"))
      .toBe("bowman-chrome");
    expect(idSetKeyStem(null)).toBe("");
  });
});

describe("the invariant is DIRECTIONAL, not an equality", () => {
  it("passes the ordinary row where field === stem", () => {
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2026:bowman:1:base:no-auto", setKey: "bowman",
    })).toBeNull();
  });

  // THE MUTATION CHECK for "make it a bare equality". These rows are the
  // MAJORITY of legitimate live drift (1,223 in 7 days, all from the
  // highest-authority checklist sources) and an equality would refuse them.
  it("passes a field that EXTENDS the stem — a named release of the product", () => {
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2023:topps:98:cherry-blossom:no-auto:num-99",
      setKey: "topps-baseball-japan-edition",
    })).toBeNull();
    expect(setKeyFieldExtendsStem("topps-chrome-logofractor-edition", "topps-chrome")).toBe(true);
  });

  // THE DEFECT. This is the 2026 Bowman shape, exactly as stored.
  it("REFUSES a stale-generic field whose stem is more specific", () => {
    const v = checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499",
      setKey: "bowman",
    });
    expect(v?.reason).toBe("stem-more-specific-than-field");
    expect(v?.field).toBe("bowman");
    expect(v?.stem).toBe("bowman-chrome");
  });

  it("REFUSES the bowman-paper and sapphire shapes too", () => {
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2007:bowman-paper:bp4:blue:no-auto:num-500", setKey: "bowman",
    })?.reason).toBe("stem-more-specific-than-field");
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2026:bowman-chrome-sapphire:bcp-1:base:no-auto", setKey: "bowman",
    })?.reason).toBe("stem-more-specific-than-field");
  });

  // Siblings, unrelated on BOTH arms -- catalogRowOps names this exact pair as
  // the case neither the ladder nor the lexical test may fold.
  it("REFUSES two unrelated products", () => {
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2026:bowman-chrome-sapphire:bcp-1:base:no-auto",
      setKey: "bowman-sapphire",
    })?.reason).toBe("field-unrelated-to-stem");
  });

  // `panini-optic` resolves THROUGH `donruss-optic` in the product table --
  // a rival SPELLING of one product, not two products -- so the stem legitimately
  // extends the field and this is the stale-generic arm, not the unrelated one.
  it("names a rival spelling as stale-generic, not unrelated", () => {
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:basketball:2021:panini-optic:1:base:no-auto", setKey: "donruss-optic",
    })?.reason).toBe("stem-more-specific-than-field");
  });

  it("leaves alone what it cannot judge: non-hiq ids and blank fields", () => {
    expect(checkSetKeyFieldMatchesIdStem({ id: "ch:12345", setKey: "bowman" })).toBeNull();
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2026:bowman:1:base:no-auto", setKey: "",
    })).toBeNull();
    expect(checkSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2026:bowman:1:base:no-auto",
    })).toBeNull();
  });

  it("the throwing form names the rule", () => {
    expect(() => assertSetKeyFieldMatchesIdStem({
      id: "hiq:baseball:2026:bowman-chrome:cpa-ag:base:auto", setKey: "bowman",
    })).toThrow(/CF-A-ROWS-SETKEY-FIELD-IS-ITS-ID-STEM/);
  });
});

/**
 * THE MINT PATHS. Every public way a "2026 Bowman Baseball" CPA row can be
 * built must land field == stem. Before this PR the checklist lanes minted the
 * slug WITHOUT `authoritativeSetKey`, so the id took the chrome-prefix repair
 * and the field kept the caller's spelling.
 */
describe("every mint path lands a 2026 Bowman CPA row with field == stem", () => {
  const CPA = {
    sport: "baseball", year: 2026, setKey: "2026 Bowman Baseball",
    cardNumber: "CPA-AG", parallel: "Refractor", isAuto: true, printRun: 499,
    playerName: "Adrian Gil", source: "checklist" as const, confidence: 0.95,
  };

  it("deriveCatalogEntry with authoritativeSetKey keeps the card in Bowman", () => {
    const e = deriveCatalogEntry({ ...CPA, authoritativeSetKey: true })!;
    expect(e.id).toContain(":bowman:");
    expect(e.setKey).toBe("bowman");
    expect(checkSetKeyFieldMatchesIdStem(e)).toBeNull();
  });

  // CF-CPA-IS-AMBIGUOUS-FROM-2023 (2026-09-05). The vendor path no longer
  // repairs a 2026 CPA- number at all: Bowman Draft has used CPA- since 2023,
  // so a bare "Bowman" text is no longer evidence of Chrome and the override
  // stands down. Both halves still move TOGETHER -- which is the property this
  // test exists for -- they now move to `bowman`, which is also where the
  // authoritative path lands. The two mint paths CONVERGE instead of filing
  // one card at two addresses, and that convergence is the whole point: this
  // very drift is the 19,867-row population the census measured.
  it("deriveCatalogEntry WITHOUT the flag moves both halves together", () => {
    const e = deriveCatalogEntry({ ...CPA, authoritativeSetKey: false })!;
    expect(e.id).toContain(":bowman:");
    expect(e.setKey).toBe("bowman");
    expect(checkSetKeyFieldMatchesIdStem(e)).toBeNull();
  });

  // Whatever the caller passes, the constructor cannot emit a drifted row.
  it("no value of authoritativeSetKey can produce drift", () => {
    for (const flag of [true, false, undefined]) {
      const e = deriveCatalogEntry({ ...CPA, authoritativeSetKey: flag })!;
      expect(checkSetKeyFieldMatchesIdStem(e)).toBeNull();
    }
  });

  // CF-CPA-IS-AMBIGUOUS-FROM-2023 turns this from a hazard into a guarantee.
  // A checklist that FORGETS the flag used to re-home Adrian Gil onto Angeibel
  // Gomez's Chrome address -- the exact split the 2026-09-05 census measured at
  // 19,867 rows. With the override scoped to <=2022 the two paths now agree,
  // so forgetting the flag can no longer move a 2026 CPA card off its product.
  //
  // The collision itself is still protected, and by the rule built for it:
  // #1802's initialsCollisionPark parks a CPA-AG SALE that reads no player
  // rather than pooling it on either claimant. Identity safety for the nine
  // collisions comes from the player gate, never from this override -- which
  // could not tell Adrian Gil from Angeibel Gomez in the first place.
  it("a checklist that forgets the flag no longer re-homes Adrian Gil", () => {
    const withFlag = deriveCatalogEntry({ ...CPA, authoritativeSetKey: true })!;
    const without = deriveCatalogEntry({ ...CPA, authoritativeSetKey: false })!;
    expect(without.id).toBe(withFlag.id);
    expect(without.id).toContain(":bowman:");
    expect(without.id).not.toContain(":bowman-chrome:");
  });
});

/**
 * THE CHOKE POINT. `upsertCatalogEntry` is the one function every compliant
 * writer passes through, so the guard lives there. A drifted doc -- the shape
 * `ensureCatalogRow` and the CSV ingest used to hand-roll -- must be REFUSED,
 * not silently repaired.
 */
describe("upsertCatalogEntry refuses a drifted row at the choke point", () => {
  const OLD = process.env.COSMOS_CONNECTION_STRING;
  let upserts: unknown[] = [];

  beforeEach(async () => {
    upserts = [];
    vi.resetModules();
    process.env.COSMOS_CONNECTION_STRING =
      "AccountEndpoint=https://localhost:1/;AccountKey=Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFy;";
    vi.doMock("@azure/cosmos", () => {
      class CosmosClient {
        database() {
          return {
            container: () => ({
              items: {
                upsert: async (d: unknown) => { upserts.push(d); return { resource: d }; },
                query: () => ({ fetchAll: async () => ({ resources: [] }) }),
              },
              item: () => ({ read: async () => ({ resource: null }) }),
            }),
          };
        }
      }
      return { CosmosClient };
    });
  });

  afterEach(() => {
    vi.doUnmock("@azure/cosmos");
    vi.resetModules();
    if (OLD === undefined) delete process.env.COSMOS_CONNECTION_STRING;
    else process.env.COSMOS_CONNECTION_STRING = OLD;
  });

  const row = (id: string, setKey: string) => ({
    id, cardId: id, hobbyiqCardId: id,
    sport: "baseball", year: 2026, cardYear: 2026, setKey,
    cardNumber: "CPA-AG", parallel: "Refractor", parallelSlug: "refractor",
    isAuto: true, printRun: 499, playerName: "Adrian Gil", playerSlug: "adrian-gil",
    vendorIds: {}, source: "ingest-auto-seed", confidence: 0.85,
  }) as never;

  it("writes a well-formed row", async () => {
    const { upsertCatalogEntry } = await import("../src/services/portfolioiq/cardCatalog.service.js");
    const out = await upsertCatalogEntry(
      row("hiq:baseball:2026:bowman:cpa-ag:refractor:auto:num-499", "bowman"),
    );
    expect(out).not.toBeNull();
    expect(upserts).toHaveLength(1);
  });

  // THE MUTATION CHECK: delete the guard call in upsertCatalogEntry and this
  // goes green with a drifted row on disk.
  it("REFUSES the drifted row and writes NOTHING", async () => {
    const { upsertCatalogEntry } = await import("../src/services/portfolioiq/cardCatalog.service.js");
    const out = await upsertCatalogEntry(
      row("hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499", "bowman"),
    );
    expect(out).toBeNull();
    expect(upserts).toHaveLength(0);
  });

  it("still accepts a field that EXTENDS the stem", async () => {
    const { upsertCatalogEntry } = await import("../src/services/portfolioiq/cardCatalog.service.js");
    const out = await upsertCatalogEntry(
      row("hiq:baseball:2023:topps:98:base:no-auto", "topps-baseball-japan-edition"),
    );
    expect(out).not.toBeNull();
    expect(upserts).toHaveLength(1);
  });
});

/**
 * CF-A-COLLISION-NUMBER-WITH-NO-PLAYER-PARKS (Drew, 2026-09-05):
 * "a NEW sale titled only '2026 Bowman ... CPA-AG' with no player readable
 *  PARKS -- identityUnverified, no pool, prices nothing until the title or a
 *  player field resolves it (never default to either side)."
 */
describe("a collision number with no readable player parks", () => {
  it("knows the nine measured collisions, hyphen- and case-insensitively", () => {
    expect(findInitialsCollision({ sport: "baseball", year: 2026, cardNumber: "CPA-AG" })).toBeTruthy();
    expect(findInitialsCollision({ sport: "baseball", year: 2026, cardNumber: "cpaag" })).toBeTruthy();
    expect(findInitialsCollision({ sport: "baseball", year: 2026, cardNumber: "BCP-151" })).toBeTruthy();
  });

  it("a number that is NOT a measured collision is one card, untouched", () => {
    // 230 of the 239 shared numbers name the SAME player on both stems.
    expect(findInitialsCollision({ sport: "baseball", year: 2026, cardNumber: "CPA-EHA" })).toBeNull();
    expect(decideCollisionPark({ sport: "baseball", year: 2026, cardNumber: "CPA-EHA" }).kind).toBe("ok");
    // A different year is a different checklist.
    expect(findInitialsCollision({ sport: "baseball", year: 2021, cardNumber: "CPA-AG" })).toBeNull();
  });

  // THE MUTATION CHECK: default to either side and this goes red.
  it("PARKS the sale that names a collision number and no player", () => {
    const d = decideCollisionPark({ sport: "baseball", year: 2026, cardNumber: "CPA-AG", playerName: null });
    expect(d.kind).toBe("park");
    if (d.kind !== "park") throw new Error("unreachable");
    expect(d.reason).toBe(COLLISION_NUMBER_NO_PLAYER);
    expect(d.claimants.map((c) => c.playerName).sort()).toEqual(["Adrian Gil", "Angeibel Gomez"]);
    // It never picks a side.
    expect(d).not.toHaveProperty("setKey");
  });

  it("blank and whitespace are 'nobody told us', never agreement", () => {
    for (const p of [null, undefined, "", "   "]) {
      expect(decideCollisionPark({ sport: "baseball", year: 2026, cardNumber: "CPA-AG", playerName: p }).kind)
        .toBe("park");
    }
  });

  // A readable player RESOLVES the card -- that is the whole point of the gate.
  it("a readable player pools normally, on either side", () => {
    expect(decideCollisionPark({
      sport: "baseball", year: 2026, cardNumber: "CPA-AG", playerName: "Adrian Gil",
    }).kind).toBe("ok");
    expect(decideCollisionPark({
      sport: "baseball", year: 2026, cardNumber: "CPA-AG", playerName: "Angeibel Gomez",
    }).kind).toBe("ok");
  });
});
