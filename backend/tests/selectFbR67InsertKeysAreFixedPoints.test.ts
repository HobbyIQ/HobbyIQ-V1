// R67 (Drew, ruling round of 2026-09-19): 2024 PANINI SELECT FOOTBALL --
// FOUR MORE NAMED INSERT ROOTS.
//
// The 33 keys in selectFbInsertSetsAreTheirOwnCardSets.test.ts were
// registered under R60 to clear a genuine id COLLISION with base. This file
// answers R67's separate question -- a named insert prices in its own pool,
// whether or not its address already happens to be collision-safe -- for
// four more roots the module's own prefix-based fold could not connect on
// its own: the colour word sits in the MIDDLE of the category name, not a
// trailing suffix, and the plain tier's parallel column is blank, so
// categorySubsetSlug's suffix-strip has nothing to strip against.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { isProductSetKey, productParentOf } from "../src/services/catalog/productSetKeys";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service";

const require_ = createRequire(import.meta.url);
const IS = require_(path.join(__dirname, "..", "scripts", "lib", "insert-set-key.cjs"));

const FIXTURE = path.join(
  __dirname, "..", "data", "checklists", "scraped",
  "acq-2026-09-18-panini-select-fb", "2024-panini-select-football.csv",
);

const SELECT_FB_R67_INSERTS = [
  "2025-xrc",
  "prime-selections-signatures",
  "2025-xrc-redemption",
  "2025-xrc-mystery-autograph-redemption",
];

function readSelectCsv(): Array<Record<string, string>> {
  const raw = fs.readFileSync(FIXTURE, "utf8");
  const lines = raw.trim().split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function rosterOf(rows: Array<{ cardNumber: string; player: string }>) {
  return new Set(
    rows.map((r) => {
      const num = String(r.cardNumber).trim().toLowerCase();
      const players = String(r.player).split("/").map((p) => p.trim().toLowerCase()).filter(Boolean).sort().join("/");
      return `${num}::${players}`;
    }),
  );
}

describe("R67 roster rule: a colour word in the MIDDLE of the name, plus a real redemption placeholder", () => {
  it("2025-xrc colour variants (BLACK/GOLD/TIE-DYE sandwiched before Prizm) are exact roster subsets of the plain tier", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const rows = readSelectCsv();
    function rosterOfCategory(cat: string) {
      return rosterOf(rows.filter((r) => r.category === cat));
    }
    const plain = rosterOfCategory("insert-2025-xrc-prizm");
    for (const colour of ["black", "gold", "tie-dye"]) {
      const cr = rosterOfCategory(`insert-2025-xrc-${colour}-prizm`);
      expect(cr.size, `${colour} must have rows`).toBeGreaterThan(0);
      expect([...cr].every((t) => plain.has(t)), `${colour} must be a subset of plain`).toBe(true);
    }
  });

  it("prime-selections-signatures: nine tag/colour spellings agree on every SHARED number, zero disagreement", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const rows = readSelectCsv();
    function rosterOfCategory(cat: string) {
      return rosterOf(rows.filter((r) => r.category === cat));
    }
    const cats = [
      "insert-prime-selections-prizm-signatures",
      "insert-prime-selections-black-prizm-signatures",
      "insert-prime-selections-black-prizm-brand-logo-signatures",
      "insert-prime-selections-black-prizm-laundry-nike-signatures",
      "insert-prime-selections-black-prizm-nfl-shield-signatures",
      "insert-prime-selections-gold-prizm-jersey-number-signatures",
      "insert-prime-selections-green-prizm-team-logo-signatures",
      "insert-prime-selections-neon-orange-pulsar-prizm-signatures",
      "insert-prime-selections-tie-dye-prizm-signatures",
    ];
    const plain = rosterOfCategory(cats[0]);
    for (const cat of cats.slice(1)) {
      const r = rosterOfCategory(cat);
      const plainByNum = new Map([...plain].map((t) => t.split("::") as [string, string]));
      let disagree = 0;
      for (const t of r) {
        const [num, player] = t.split("::");
        if (plainByNum.has(num) && plainByNum.get(num) !== player) disagree++;
      }
      expect(disagree, `${cat} must not disagree with the plain roster on any shared number`).toBe(0);
    }
  });

  it("a redemption placeholder ('QB1', 'XRCAuto1') SHARES its card numbers with the real-player insert but names a different 'player' at every one -- exactly the R30 defect a rung cannot be", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const rows = readSelectCsv();
    function rosterOfCategory(cat: string) {
      return rosterOf(rows.filter((r) => r.category === cat));
    }
    const realPlayers = rosterOfCategory("insert-2025-xrc-prizm");
    const redemption = rosterOfCategory("insert-2025-xrc-prizm-redemption");
    const realByNum = new Map([...realPlayers].map((t) => t.split("::") as [string, string]));
    const redemptionByNum = new Map([...redemption].map((t) => t.split("::") as [string, string]));
    // The redemption card physically occupies the SAME numbered slot as the
    // eventual real card (that is what "redemption" means), so the numbers
    // DO overlap -- and every one of them names a placeholder, never the real
    // player, which is why it cannot be folded as a colour rung of the real
    // insert: R67's roster rule requires the SAME player at a shared number,
    // and this is the disagreement case the rule is built to catch.
    let sharedNumbers = 0, disagreeOnPlayer = 0;
    for (const [num, placeholder] of redemptionByNum) {
      if (realByNum.has(num)) {
        sharedNumbers++;
        if (realByNum.get(num) !== placeholder) disagreeOnPlayer++;
      }
    }
    expect(sharedNumbers).toBeGreaterThan(0);
    expect(disagreeOnPlayer).toBe(sharedNumbers);
    expect([...redemption].every((t) => /^(qb|rb|wr|te|def)\d/.test(t.split("::")[1]))).toBe(true);
  });

  it("the two redemption clusters (non-auto and auto/signed) never overlap each other either", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const rows = readSelectCsv();
    function rosterOfCategory(cat: string) {
      return rosterOf(rows.filter((r) => r.category === cat));
    }
    const plainRedemption = rosterOfCategory("insert-2025-xrc-prizm-redemption");
    const autoRedemption = rosterOfCategory("auto-2025-xrc-mystery-autograph-black-prizm-redemption");
    const plainNums = new Set([...plainRedemption].map((t) => t.split("::")[0]));
    const autoNums = new Set([...autoRedemption].map((t) => t.split("::")[0]));
    expect([...autoNums].some((n) => plainNums.has(n))).toBe(false);
  });
});

describe("Select FB R67 insert keys", () => {
  it("registers every measured root", () => {
    expect(SELECT_FB_R67_INSERTS.length).toBe(4);
    const missing = SELECT_FB_R67_INSERTS.filter((sub) => !isProductSetKey(`panini-select-${sub}`));
    expect(missing).toEqual([]);
  });

  it("every key is a normalizeSetKey FIXED POINT — the whole point of registering", () => {
    const collapsed = SELECT_FB_R67_INSERTS
      .map((sub) => `panini-select-${sub}`)
      .filter((key) => normalizeSetKey(key) !== key)
      .map((key) => `${key} -> ${normalizeSetKey(key)}`);
    expect(collapsed).toEqual([]);
  });

  it("each nests under panini-select", () => {
    for (const sub of SELECT_FB_R67_INSERTS) {
      const key = `panini-select-${sub}`;
      expect(productParentOf(key), `${key} must nest under panini-select`).toBe("panini-select");
    }
  });

  it("2025-xrc-mystery-autograph-redemption no longer collapses onto the real signed insert", () => {
    // Measured before registering: normalizeSetKey("panini-select-2025-xrc-
    // mystery-autograph-redemption") returned "panini-select-2025-xrc-
    // mystery-autograph" -- a substring match onto the ALREADY-registered
    // signed insert, which this key fixes.
    expect(normalizeSetKey("panini-select-2025-xrc-mystery-autograph-redemption"))
      .toBe("panini-select-2025-xrc-mystery-autograph-redemption");
  });

  it("does not disturb the already-registered signed sibling 2025-xrc-mystery-autograph", () => {
    expect(productParentOf("panini-select-2025-xrc-mystery-autograph")).toBe("panini-select");
    expect(normalizeSetKey("panini-select-2025-xrc-mystery-autograph"))
      .toBe("panini-select-2025-xrc-mystery-autograph");
  });

  it("the whole file still passes clean with the REAL production id after this batch", () => {
    if (!fs.existsSync(FIXTURE)) return;
    const rows = readSelectCsv();
    const { computeHobbyIqCardId } = require_(
      path.join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
    );
    for (const r of rows) (r as Record<string, string>).setKey = "panini-select";
    const plan = IS.planFile({
      rows,
      productSetKey: "panini-select",
      computeId: (r: Record<string, string>) => {
        try {
          return computeHobbyIqCardId({
            sport: "football", year: 2024, setKey: r.setKey,
            cardNumber: String(r.cardNumber),
            parallel: r.parallel || "Base",
            isAuto: r.isAuto === "true",
            printRun: r.printRun ? Number(r.printRun) : null,
            authoritativeSetKey: true,
          });
        } catch { return null; }
      },
      normalize: normalizeSetKey,
    });
    expect(plan.verdict).toBe("pass");
    expect(plan.ids).toBe(rows.length);
  });
});

describe("Tiers are listed, not touched (open question, per instruction)", () => {
  it("lists the five tiers seen in this file; three are already registered (#2231), two are not -- neither changed here", () => {
    // Concourse, Club Level, Field Level, Premier Level, Suite Level -- no
    // Courtside Level in THIS football file. #2231 registered concourse,
    // premier-level and field-level; club-level and suite-level are NOT
    // registered and currently fold to bare panini-select. This PR does not
    // register, fold, or otherwise touch ANY tier -- listed for the record
    // only, per instruction, so Drew's separate tier ruling has the full
    // picture when it comes.
    const registeredByOthers = ["concourse", "field-level", "premier-level"];
    const notYetRegistered = ["club-level", "suite-level"];
    for (const tier of registeredByOthers) {
      expect(isProductSetKey(`panini-select-${tier}`), `${tier} is registered by #2231, not this PR`).toBe(true);
    }
    for (const tier of notYetRegistered) {
      expect(isProductSetKey(`panini-select-${tier}`), `${tier} stays unregistered -- held for the open tier question`).toBe(false);
    }
  });
});
