/**
 * Drew, 2026-08-31, asked of BNR-VGJ: "isn't it under bowman chrome set?" —
 * then "ok, do it". The NSCC wrapper-redemption promo says Bowman Chrome on the
 * card, so the question is fair. It is still its own product, by the same test
 * the Mega Box rule uses:
 *
 *   Numbering does NOT collide (every card is BNR- prefixed; Bowman Chrome base
 *   is 1..N and BCP1..BCP250), so unlike Mega Box the collapse corrupts no
 *   individual card.
 *
 *   Prices do. 2018 #BNR-AJ — Aaron Judge, signed National card /3 — sold at
 *   $500 BGS 9, BELOW his ordinary #100 Gold /50 at $725-$900 PSA 10.
 *
 * The catalog had already settled it: 780 rows across 2017-2023 keyed
 * bowman-chrome-nscc, holding zero comps because ingest could not reach the key.
 */
import { describe, expect, it } from "vitest";
import { normalizeSetKey, resolveSetKeyForSlug } from "../src/services/portfolioiq/hobbyIqCardId.service";

const n = normalizeSetKey as (s: string) => string;

describe("bowman-chrome-nscc — the rule has to MAP the spellings that exist", () => {
  // Every one of these appears in prod as a catalog setName or a source's set
  // name. A rule that only matched the canonical key would be useless.
  it.each([
    "bowman-chrome-nscc",
    "2018 Bowman Chrome Nscc Baseball",
    "2019 Bowman Chrome Nscc Baseball",
    "2023 Bowman Chrome National Convention Baseball",
    "2018 Bowman Chrome National Wrapper Redemption",
    "Bowman Chrome National Sports Collectors Convention Wrapper Redemption",
    "Bowman NSCC",
  ])("%s maps to bowman-chrome-nscc", (s) => {
    expect(n(s)).toBe("bowman-chrome-nscc");
  });

  it("resolves the same through the slug path the ingester uses", () => {
    expect(resolveSetKeyForSlug("baseball", "2018 Bowman Chrome National Wrapper Redemption", 2018))
      .toBe("bowman-chrome-nscc");
  });

  // Ordering in the rule table is load-bearing: this rule sits above the plain
  // /bowman-chrome/ rule, and must not swallow its neighbours.
  it.each([
    ["2018 Bowman Chrome", "bowman-chrome"],
    ["Bowman Chrome Sapphire", "bowman-chrome-sapphire"],
    ["Bowman Chrome Mega Box", "bowman-chrome-mega-box"],
    ["Panini National Treasures", "panini-national-treasures"],
    ["2018 National Treasures", "panini-national-treasures"],
  ])("%s still resolves to %s", (input, want) => {
    expect(n(input)).toBe(want);
  });

  it("is Bowman-scoped — a Topps national promo never becomes a Bowman key", () => {
    expect(n("Topps National Convention").startsWith("bowman")).toBe(false);
    expect(n("Topps NSCC Wrapper Redemption").startsWith("bowman")).toBe(false);
  });
});
