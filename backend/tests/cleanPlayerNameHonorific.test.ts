/**
 * CF-A-COMMA-BEFORE-JR-IS-NOT-A-TEAM (D33, Drew 2026-08-30).
 *
 * The "Find this card" picker listed "Bobby Witt, Jr." and "Bobby Witt" as
 * two different players for the SAME card, off the SAME page, because the two
 * baseballcardpedia converters disagreed:
 *
 *   scrape-baseballcardpedia.cjs  stripped a TRAILING comma only  -> "Bobby Witt, Jr."
 *   scrape-bcp-ladders.cjs        truncated at the FIRST comma    -> "Bobby Witt"
 *
 * Neither equals the canonical "Bobby Witt Jr.". Both are fixed, and the
 * canonical cleanPlayerName learns the one embedded comma its docblock had
 * excluded -- the honorific suffix, and only that one.
 */
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { cleanPlayerName } from "../src/services/portfolioiq/cardCatalog.service.js";

const require_ = createRequire(import.meta.url);
const L = require_(path.resolve(__dirname, "../scripts/scrape-bcp-ladders.cjs"));

describe("canonical cleanPlayerName: the honorific comma", () => {
  it.each([
    ["Bobby Witt, Jr.", "Bobby Witt Jr."],
    ["Ken Griffey, Jr", "Ken Griffey Jr"],
    ["Ronald Acuna, II", "Ronald Acuna II"],
    ["Vladimir Guerrero, Sr.", "Vladimir Guerrero Sr."],
    ["Cal Ripken, III", "Cal Ripken III"],
  ])("%j -> %j", (input, want) => {
    expect(cleanPlayerName(input)).toBe(want);
  });

  it("keeps the D15 trailing-punctuation behaviour", () => {
    // CF-A-NAME-DOES-NOT-END-IN-A-COMMA: Beckett's "Max Williams,".
    expect(cleanPlayerName("Max Williams,")).toBe("Max Williams");
    expect(cleanPlayerName("Max Williams ")).toBe("Max Williams");
    expect(cleanPlayerName("Max Williams;")).toBe("Max Williams");
  });

  it("is IDEMPOTENT — a clean name is never touched", () => {
    for (const n of ["Bobby Witt Jr.", "Mike Trout", "Ronald Acuna Jr.", "Cal Ripken III"]) {
      expect(cleanPlayerName(n)).toBe(n);
      expect(cleanPlayerName(cleanPlayerName(n))).toBe(cleanPlayerName(n));
    }
  });

  it("leaves Last, First ALONE — that is a different defect", () => {
    // The existing docblock declines embedded commas on purpose; this change
    // carves out the honorific suffix and nothing else.
    expect(cleanPlayerName("Smith, John")).toBe("Smith, John");
    expect(cleanPlayerName("Griffey, Ken")).toBe("Griffey, Ken");
  });

  it("survives empty and nullish input", () => {
    expect(cleanPlayerName(null)).toBe("");
    expect(cleanPlayerName(undefined)).toBe("");
    expect(cleanPlayerName("")).toBe("");
  });
});

describe("the ladders converter keeps the honorific and still drops the team", () => {
  const player = (li: string) => L.parseCards(li)[0]?.player;

  it("keeps ', Jr.' — the defect Drew saw", () => {
    // Was "Bobby Witt": the ", Team" strip truncated at the first comma.
    expect(player("<li>BD-152 Bobby Witt, Jr.</li>")).toBe("Bobby Witt Jr.");
  });

  it("still strips ', Team'", () => {
    expect(player("<li>BD-50 Mike Trout, Angels</li>")).toBe("Mike Trout");
  });

  it("handles both at once, in page order", () => {
    expect(player("<li>BD-99 Ronald Acuna, Jr., Braves</li>")).toBe("Ronald Acuna Jr.");
  });

  it("agrees with the canonical cleaner on the real fixture row", () => {
    expect(player("<li>BD-152 Bobby Witt, Jr.</li>")).toBe(cleanPlayerName("Bobby Witt, Jr."));
  });
});

describe("the other bcp scraper agrees, so the picker sees ONE player", () => {
  /**
   * scrape-baseballcardpedia.cjs is a CLI script; its cleanPlayerName is read
   * out of the source and evaluated alone rather than importing the module.
   */
  const load = (): ((s: string) => string | null) => {
    const fs = require_("node:fs");
    const src = fs.readFileSync(path.resolve(__dirname, "../scripts/scrape-baseballcardpedia.cjs"), "utf8");
    const m = src.match(/function cleanPlayerName\(raw\) \{[\s\S]*?\n\}/);
    if (!m) throw new Error("cleanPlayerName not found in scrape-baseballcardpedia.cjs");
    // eslint-disable-next-line no-new-func
    return new Function(`${m[0]}; return cleanPlayerName;`)();
  };

  it("writes the same spelling as the ladders converter and the canonical cleaner", () => {
    const scraperClean = load();
    const want = "Bobby Witt Jr.";
    expect(scraperClean("Bobby Witt, Jr.")).toBe(want);
    expect(L.parseCards("<li>BD-152 Bobby Witt, Jr.</li>")[0].player).toBe(want);
    expect(cleanPlayerName("Bobby Witt, Jr.")).toBe(want);
  });

  it("keeps its own trailing-metadata behaviour", () => {
    const scraperClean = load();
    expect(scraperClean("Max Williams,")).toBe("Max Williams");
    expect(scraperClean("Mike Trout")).toBe("Mike Trout");
    expect(scraperClean("Smith, John")).toBe("Smith, John");
  });
});
