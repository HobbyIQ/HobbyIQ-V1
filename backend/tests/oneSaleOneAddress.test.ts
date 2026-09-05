import { describe, it, expect } from "vitest";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { resolveVertical } from "../src/services/portfolioiq/resolveVertical.service.js";

/**
 * CF-ONE-SALE-ONE-ADDRESS / CF-BOWMAN-DEFAULT-NOT-EVIDENCE (2026-09-05).
 *
 * WHY THESE ARE ONE FILE. A sold_comps row's PARTITION KEY is `cardId`, and
 * `cardId` is a pure function of the title parse (`hiq:${slug.slice(4)}`),
 * while its `id` is `${source}::${externalId}` and never moves. So every
 * place the parse GUESSES rather than reads is a place the same sale can be
 * written to a second address on a later ingest -- a split pool and a double
 * count. Measured (PR #1827): 31.4% of 500 sampled tca-ebay ids were resident
 * under >= 2 partition keys.
 *
 * These pin the two guesses that were still live, and the accounting bug that
 * hid a third.
 */
describe("CF-BOWMAN-DEFAULT-NOT-EVIDENCE: a maker default is not a parse", () => {
  it("a brand-less Sapphire title parks as Unknown instead of guessing Bowman", () => {
    // The defect: "Sapphire" is a FINISH, not a product. This title names no
    // manufacturer at all, and the old rule answered "Bowman Chrome Sapphire"
    // because Bowman Sapphire is the commonest -- a guess dressed as a parse,
    // which then became the partition key.
    expect(inferSetKeyFromTitle("2023 Sapphire Julio Rodriguez #12 PSA 10")).toBe("Unknown");
  });

  it("still reads Bowman when the title actually says Bowman", () => {
    // The fix must not cost us the evidence-backed answer.
    expect(inferSetKeyFromTitle("2023 Bowman Chrome Sapphire Jackson Holliday #BCP-1")).toBe("Bowman Chrome Sapphire");
  });

  it("still routes a NAMED rival brand to that brand, not to Bowman", () => {
    // Regression guard for the Topps half of the older fix.
    expect(inferSetKeyFromTitle("2023 Topps Chrome Sapphire Corbin Carroll #1")).toBe("Topps Chrome Sapphire");
  });

  it("the terminal fallback stays Unknown for a title naming no product", () => {
    // Blank means unknown, never a default. A rookie baseball card whose
    // brand is unstated is not a Bowman card.
    expect(inferSetKeyFromTitle("1994 Baseball Rookie Card #55 Mint")).toBe("Unknown");
  });
});

describe("CF-A-DEFAULTED-SPORT-IS-NOT-EVIDENCE", () => {
  it("reports confident=false and reason=defaulted when nothing proves the sport", () => {
    // `sport` is the FIRST slug segment, therefore part of the partition key.
    // The resolver has always known when it was guessing; the ingest writer
    // now records that verdict instead of discarding it.
    const r = resolveVertical({ title: "1989 Star Rookie #12 Mint", fallback: "baseball" });
    expect(r.vertical).toBe("baseball");
    expect(r.confident).toBe(false);
    expect(r.reason).toBe("defaulted");
  });

  it("reports confident=true when a sport keyword proves it", () => {
    const r = resolveVertical({ title: "1989 Topps Baseball Ken Griffey Jr #41", fallback: "baseball" });
    expect(r.confident).toBe(true);
    expect(r.reason).toBe("sport-keyword");
  });
});
