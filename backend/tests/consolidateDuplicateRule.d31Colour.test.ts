/**
 * D31's colour key, pinned against GROUND TRUTH.
 *
 * This is the test that stops two wrong readings from coming back. Both were
 * written, measured against real rows, and REFUTED -- and both are the kind of
 * thing a later reader would "simplify" the rule into:
 *
 *   (a) collapse scrape runs to the PUBLISHER -> the 2025 Topps Chrome #79
 *       printing plates read as "one publisher names both" = two cards. A plate
 *       is a 1/1; there is no refractor plate. A real duplicate stays split.
 *   (b) discriminate on PRINT RUN -> Topps Finest #197's `uncommon` and
 *       `uncommon-refractor`, both un-numbered from ONE checklistcenter string,
 *       MERGE. Drew named those as TWO cards, 600 of them. This direction
 *       destroys real cards.
 *
 * The surviving discriminator is the SOURCE STRING (one scrape run).
 */
import { describe, expect, it } from "vitest";
import {
  decideDuplicateGroup,
  oneSourceNamesBothColourForms,
  type DupRow,
} from "../src/services/catalog/duplicateWinnerRule.js";

const row = (id: string, source: string, parallelSlug: string, extra: Partial<DupRow> = {}): DupRow => ({
  id,
  source,
  parallelSlug,
  sport: "baseball",
  year: 2025,
  setKey: "topps-chrome",
  cardNumber: "79",
  isAuto: false,
  playerName: "Test Player",
  ...extra,
});

describe("D31 colour key -- the five ground-truth cases", () => {
  it("Topps Finest #197: ONE source string names uncommon AND uncommon-refractor => TWO CARDS", () => {
    // Drew named these as two cards, 600 of them. Both are UN-NUMBERED, which
    // is why a print-run discriminator merges them and is wrong.
    const rows = [
      row("hiq:baseball:2024:topps-finest:197:uncommon:no-auto", "checklistcenter", "uncommon", { setKey: "topps-finest", cardNumber: "197", year: 2024 }),
      row("hiq:baseball:2024:topps-finest:197:uncommon-refractor:no-auto", "checklistcenter", "uncommon-refractor", { setKey: "topps-finest", cardNumber: "197", year: 2024 }),
    ];
    expect(oneSourceNamesBothColourForms(rows)).toMatchObject({ both: true, source: "checklistcenter" });

    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.why).toBe("d31-one-source-names-both-colour-forms");
  });

  it("2000 Bowman Chrome retro-future: ONE source names both forms => TWO CARDS", () => {
    const rows = [
      row("hiq:baseball:2000:bowman-chrome:1:retro-future:no-auto", "baseballcardpedia", "retro-future", { setKey: "bowman-chrome", cardNumber: "1", year: 2000 }),
      row("hiq:baseball:2000:bowman-chrome:1:retro-future-refractor:no-auto", "baseballcardpedia", "retro-future-refractor", { setKey: "bowman-chrome", cardNumber: "1", year: 2000 }),
    ];
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.why).toBe("d31-one-source-names-both-colour-forms");
  });

  it("2025 Topps Chrome #79 printing plates: two RUNS of one site => ONE CARD", () => {
    // A printing plate is a 1/1. There is no refractor plate, so this MUST fold
    // -- and it is exactly the case a publisher-collapse reading blocks forever.
    const rows = [
      row("hiq:baseball:2025:topps-chrome:79:printing-plates-black:no-auto", "checklistcenter", "printing-plates-black"),
      row("hiq:baseball:2025:topps-chrome:79:printing-plates-black-refractor:no-auto", "checklistcenter-2026-08-29", "printing-plates-black-refractor"),
    ];
    expect(oneSourceNamesBothColourForms(rows)).toEqual({ both: false });

    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("consolidate");
    if (d.kind === "consolidate") expect(d.losers).toHaveLength(1);
  });

  it("2025 Topps Chrome #79 gold-lava: two RUNS of one site => ONE CARD", () => {
    const rows = [
      row("hiq:baseball:2025:topps-chrome:79:gold-lava:no-auto", "checklistcenter", "gold-lava"),
      row("hiq:baseball:2025:topps-chrome:79:gold-lava-refractor:no-auto", "checklistcenter-2026-08-29", "gold-lava-refractor"),
    ];
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("consolidate");
  });

  it("2025 Topps Chrome #7 gold-wave: two different SITES => ONE CARD", () => {
    const rows = [
      row("hiq:baseball:2025:topps-chrome:7:gold-wave:no-auto", "checklistcenter", "gold-wave", { cardNumber: "7" }),
      row("hiq:baseball:2025:topps-chrome:7:gold-wave-refractor:no-auto", "checklistinsider-2026-08-27", "gold-wave-refractor", { cardNumber: "7" }),
    ];
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("consolidate");
  });
});

describe("D31 colour key -- a derived twin never votes", () => {
  it("a derived row carrying both forms does NOT make the group two cards", () => {
    // The retracted rule MINTED many of these. Our own seed is not a site
    // saying a card exists, so it must not block the fold that cleans it up.
    const rows = [
      row("hiq:baseball:2025:topps-chrome:79:gold:no-auto", "ingest-auto-seed", "gold"),
      row("hiq:baseball:2025:topps-chrome:79:gold-refractor:no-auto", "ingest-auto-seed", "gold-refractor"),
      row("hiq:baseball:2025:topps-chrome:79:gold-refractor:no-auto:cc", "checklistcenter", "gold-refractor"),
    ];
    expect(oneSourceNamesBothColourForms(rows)).toEqual({ both: false });
    const d = decideDuplicateGroup({ rows });
    expect(d.kind).toBe("consolidate");
    // The checklist row survives; both derived rows fold onto it.
    if (d.kind === "consolidate") {
      expect(d.winner.source).toBe("checklistcenter");
      expect(d.losers).toHaveLength(2);
    }
  });
});
