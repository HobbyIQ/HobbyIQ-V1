/**
 * CF-AN-INSERT-NAMES-ITSELF-IN-THE-PARALLEL-COLUMN (2026-09-05).
 *
 * A staged checklist file can be perfectly well-formed against the CSV
 * contract -- right header, right column order, every cell a legal value --
 * and still destroy the product it describes, because the contract says
 * "blank means unknown" and cannot say "this particular blank is wrong".
 *
 * `1997-metal-universe-magnetic-field-baseball.csv` was staged by #1774 with
 * every `parallel` cell blank. Magnetic Field is a 10-card INSERT whose cards
 * are numbered 1-10, and the 1997 Metal Universe BASE set is numbered 1-250.
 * The two numbering runs overlap completely, so with a blank parallel every
 * insert row derived the BASE card's slug:
 *
 *     Magnetic Field #2  Jeff Bagwell   -> hiq:baseball:1997:metal-universe:2:base:no-auto
 *     BASE           #2  Brady Anderson -> hiq:baseball:1997:metal-universe:2:base:no-auto
 *
 * Ten different players, ten slugs already held by ten OTHER players. An
 * APPLY would have overwritten the base rows with insert identities: one row,
 * two cards, one pool -- the exact inverse of `one card, one row, one pool`.
 *
 * The insert's name is the only thing that separates them, and the `parallel`
 * column is where the slug can carry it. That is not a special case invented
 * here: it is the convention every other staged insert already follows
 * (`insert-diamond-dominance` -> "Diamond Dominance", `insert-home-run-
 * hysteria` -> "Home Run Hysteria"). Blank still means unknown -- here the
 * name was KNOWN, so blank was simply wrong.
 *
 * The second half of this file pins the print run that #1783 could not write.
 * Griffey's D24 is a Diamond Dominance insert serial-numbered to 1500, stated
 * by two independent permissive sources, and the staged file left the column
 * blank -- so a /1500 insert was indistinguishable from an unnumbered card and
 * #1783 correctly refused to fuse it into the base pool.
 *
 * These are MUTATION pins on the staged data, not on the ingester: revert
 * either CSV cell and these tests fail.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service";

const CHECKLISTS = path.resolve(__dirname, "..", "data", "checklists");

type Row = Record<string, string>;

/** The contract's own parse: header read by name, quoted commas respected. */
function readChecklistCsv(file: string): Row[] {
  const text = fs.readFileSync(path.join(CHECKLISTS, file), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.startsWith("#"));
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const parts: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { parts.push(cur); cur = ""; }
      else cur += ch;
    }
    parts.push(cur);
    const r: Row = {};
    header.forEach((h, i) => { r[h] = (parts[i] ?? "").trim(); });
    return r;
  });
}

const MAGNETIC_FIELD = "magnetic-field/1997-metal-universe-magnetic-field-baseball.csv";
const BLACK_DIAMOND = "diamond-dominance/1999-upper-deck-black-diamond.csv";

describe("a staged insert names itself in the parallel column", () => {
  it("gives every Magnetic Field row a non-blank parallel", () => {
    const rows = readChecklistCsv(MAGNETIC_FIELD);
    expect(rows).toHaveLength(10);
    const blank = rows.filter((r) => r.parallel.trim() === "");
    expect(blank).toHaveLength(0);
  });

  it("names it exactly once, and names it 'Magnetic Field'", () => {
    const rows = readChecklistCsv(MAGNETIC_FIELD);
    expect(new Set(rows.map((r) => r.parallel))).toEqual(new Set(["Magnetic Field"]));
    expect(new Set(rows.map((r) => r.category))).toEqual(new Set(["insert-magnetic-field"]));
  });

  it("keeps Ripken on #8 — the card number is the checklist's, not ours", () => {
    const rows = readChecklistCsv(MAGNETIC_FIELD);
    const ripken = rows.filter((r) => /ripken/i.test(r.player));
    expect(ripken).toHaveLength(1);
    expect(ripken[0].cardNumber).toBe("8");
    expect(ripken[0].parallel).toBe("Magnetic Field");
  });

  it("collides with the base set on EVERY card number — which is why the parallel is load-bearing", () => {
    // The reason a blank parallel is fatal here and harmless in a set whose
    // insert has its own numbering run. Measured against the staged base file,
    // not asserted from memory.
    const insert = readChecklistCsv(MAGNETIC_FIELD);
    const base = readChecklistCsv("scraped/1997-metal-universe-baseball.csv")
      .filter((r) => r.category === "base");
    const baseNumbers = new Set(base.map((r) => r.cardNumber));
    const overlapping = insert.filter((r) => baseNumbers.has(r.cardNumber));
    expect(overlapping).toHaveLength(10);

    // ...and on most of them the base card is a DIFFERENT PLAYER, so the
    // overwrite would not even be self-evident from the row it replaced.
    const basePlayerByNumber = new Map(base.map((r) => [r.cardNumber, r.player]));
    const differentPlayer = insert.filter(
      (r) => basePlayerByNumber.get(r.cardNumber) !== r.player,
    );
    expect(differentPlayer.length).toBeGreaterThanOrEqual(8);
  });

  it("leaves the 1:12 pack odds in `rarity`, never in printRun", () => {
    // CF-RARITY-IS-NOT-A-PRINT-RUN: an odds statement counts packs, a serial
    // counts copies of one card.
    const rows = readChecklistCsv(MAGNETIC_FIELD);
    for (const r of rows) {
      expect(r.printRun).toBe("");
      expect(r.rarity).toMatch(/1:12/);
    }
  });
});

describe("Diamond Dominance carries the serial its own source states", () => {
  it("stamps /1500 on all 30 Diamond Dominance rows", () => {
    const dd = readChecklistCsv(BLACK_DIAMOND)
      .filter((r) => r.category === "insert-diamond-dominance");
    expect(dd).toHaveLength(30);
    expect(new Set(dd.map((r) => r.printRun))).toEqual(new Set(["1500"]));
  });

  it("puts Griffey on D24 with the print run his own listing states", () => {
    const dd = readChecklistCsv(BLACK_DIAMOND)
      .filter((r) => r.category === "insert-diamond-dominance");
    const griffey = dd.filter((r) => /griffey/i.test(r.player));
    expect(griffey).toHaveLength(1);
    expect(griffey[0].cardNumber).toBe("D24");
    expect(griffey[0].printRun).toBe("1500");
    expect(griffey[0].parallel).toBe("Diamond Dominance");
  });

  it("leaves Mystery Numbers BLANK — its serial is a function of the card, not the set", () => {
    // BCP: each Mystery Numbers card is serial-numbered to its sequential
    // number x100 (M1 = /100 ... M30 = /3000). One flat figure here would be
    // the well-formed wrong print run that no later sweep can see, which is
    // the whole reason `blank means unknown` outranks `fill it in`.
    const mystery = readChecklistCsv(BLACK_DIAMOND)
      .filter((r) => r.category === "insert-mystery-numbers");
    expect(mystery).toHaveLength(30);
    expect(new Set(mystery.map((r) => r.printRun))).toEqual(new Set([""]));
  });

  it("leaves the base run's own ladder alone — it is not in this file", () => {
    // The Double/Triple/Quadruple ladder is range-scoped AND carries a
    // three-player exception (checklist-gap-source-map.md 3.1 / 3.2). It
    // belongs to the fixed ladder scraper; writing it here from a flat figure
    // is the cross-join this repo already retired once.
    const base = readChecklistCsv(BLACK_DIAMOND).filter((r) => r.category === "base");
    expect(base).toHaveLength(120);
    expect(new Set(base.map((r) => r.printRun))).toEqual(new Set([""]));
    expect(new Set(base.map((r) => r.parallel))).toEqual(new Set([""]));
  });
});

describe("both files still satisfy the one checklist format", () => {
  it("keeps the six required columns, in order, on both files", () => {
    const REQUIRED = ["category", "cardNumber", "parallel", "isAuto", "printRun", "player"];
    for (const file of [MAGNETIC_FIELD, BLACK_DIAMOND]) {
      const header = fs.readFileSync(path.join(CHECKLISTS, file), "utf8")
        .split(/\r?\n/)[0].split(",").map((h) => h.trim());
      expect(header.slice(0, 6)).toEqual(REQUIRED);
    }
  });

  it("keeps every category a legal one, and every isAuto a boolean literal", () => {
    for (const file of [MAGNETIC_FIELD, BLACK_DIAMOND]) {
      for (const r of readChecklistCsv(file)) {
        expect(r.category).toMatch(/^(base|insert-[a-z0-9-]+|auto-[a-z0-9-]+)$/);
        expect(["true", "false"]).toContain(r.isAuto);
        if (r.printRun !== "") expect(Number.isInteger(Number(r.printRun))).toBe(true);
        expect(r.player.trim()).not.toBe("");
      }
    }
  });

  it("pairs each CSV with a manifest naming its source and a fixed-point setKey", () => {
    for (const file of [MAGNETIC_FIELD, BLACK_DIAMOND]) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(CHECKLISTS, file.replace(/\.csv$/, ".manifest.json")), "utf8"),
      );
      expect(manifest.sourceUrl).toMatch(/^https?:\/\//);
      expect(manifest.sport).toBe("baseball");
      expect(typeof manifest.year).toBe("number");
      expect(String(manifest.setKey).trim()).not.toBe("");
      // The ingester reads the column literally only under this flag; both
      // files rely on it to keep the insert's name.
      expect(manifest.parallelColumnAuthoritative).toBe(true);
    }
  });
});

describe("the slugs the ingester would actually mint", () => {
  // The CSV assertions above are necessary but not sufficient: the failure was
  // only ever visible in the DERIVED id. Derive it the way
  // ingest-scraped-checklist.cjs does and pin the ids themselves.
  const slugFor = (o: {
    year: number; setKey: string; cardNumber: string; parallel: string; printRun: number | null;
  }) => computeHobbyIqCardId({
    sport: "baseball",
    year: o.year,
    setKey: o.setKey,
    cardNumber: o.cardNumber,
    parallel: o.parallel,
    isAuto: false,
    printRun: o.printRun,
    authoritativeSetKey: true,
  });

  it("separates Magnetic Field #8 from base #8 — both are Cal Ripken Jr.", () => {
    const insert = slugFor({ year: 1997, setKey: "metal-universe", cardNumber: "8", parallel: "Magnetic Field", printRun: null });
    const base = slugFor({ year: 1997, setKey: "metal-universe", cardNumber: "8", parallel: "", printRun: null });
    expect(insert).toBe("hiq:baseball:1997:metal-universe:8:magnetic-field:no-auto");
    expect(base).toBe("hiq:baseball:1997:metal-universe:8:base:no-auto");
    expect(insert).not.toBe(base);
  });

  it("mints ten DISTINCT Magnetic Field slugs, none of them a base slug", () => {
    const inserts = [1,2,3,4,5,6,7,8,9,10].map((n) =>
      slugFor({ year: 1997, setKey: "metal-universe", cardNumber: String(n), parallel: "Magnetic Field", printRun: null }));
    expect(new Set(inserts).size).toBe(10);
    for (const id of inserts) expect(id).toContain(":magnetic-field:");
    const bases = [1,2,3,4,5,6,7,8,9,10].map((n) =>
      slugFor({ year: 1997, setKey: "metal-universe", cardNumber: String(n), parallel: "", printRun: null }));
    // Zero overlap: this is the number that was 10 before the fix.
    expect(inserts.filter((id) => bases.includes(id))).toHaveLength(0);
  });

  it("gives Griffey D24 the insert AND the serial, and normalizes the setKey", () => {
    const id = slugFor({ year: 1999, setKey: "upper-deck-black-diamond", cardNumber: "D24", parallel: "Diamond Dominance", printRun: 1500 });
    expect(id).toBe("hiq:baseball:1999:upper-deck-black-diamond:d24:diamond-dominance:no-auto:num-1500");
    // The bare spelling the holding still carries reaches the same product.
    expect(slugFor({ year: 1999, setKey: "black-diamond", cardNumber: "D24", parallel: "Diamond Dominance", printRun: 1500 })).toBe(id);
    // ...and is NOT the base slug #1783 refused to write it to.
    expect(id).not.toBe(slugFor({ year: 1999, setKey: "black-diamond", cardNumber: "D24", parallel: "", printRun: null }));
  });

  it("would not have carried the serial with the column left blank", () => {
    // The mutation this pins: drop the printRun and the :num- tail disappears,
    // which is exactly the state that made a /1500 insert look unnumbered.
    const withRun = slugFor({ year: 1999, setKey: "upper-deck-black-diamond", cardNumber: "D24", parallel: "Diamond Dominance", printRun: 1500 });
    const without = slugFor({ year: 1999, setKey: "upper-deck-black-diamond", cardNumber: "D24", parallel: "Diamond Dominance", printRun: null });
    expect(withRun).toContain(":num-1500");
    expect(without).not.toContain(":num-");
  });
});
