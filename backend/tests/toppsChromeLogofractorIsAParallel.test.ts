/**
 * CF-LOGOFRACTOR-IS-A-PARALLEL-NOT-A-PRODUCT (Drew ruling, 2026-09-28,
 * 02:50Z): "2024 Topps Chrome Logofractor is a same-numbered NAMED PARALLEL
 * of topps-chrome, not a product."
 *
 * PR #2478's investigation found the gap-analysis cell `2024|topps-chrome-
 * logofractor` (10,203 unbacked sales) was labelled a standalone product
 * never acquired, and that the parser (parseTitleIdentity.service.ts,
 * inferFamilySetKeyFromTitle) minted setKey `topps-chrome-logofractor` for
 * any title containing "logofractor", on a comment that claimed it was a
 * "ruled key" registered at productSetKeys.ts:479. It never was --
 * `grep -n topps-chrome-logofractor backend/src/services/catalog/
 * productSetKeys.ts` returns zero matches. Sourced against
 * baseballcardpedia.com and checklistinsider.com: 2024 Topps Chrome
 * Logofractor is a 200-card, skip-numbered rendition of the 300-card Topps
 * Chrome base set (200/200 checklist rows identical cardNumber/player pairs
 * to the base checklist), unserialized (~3,150 estimated copies, never a
 * printed serial). Bowman Logofractor is a DIFFERENT, genuinely standalone
 * printed /35 tier (parallelLadders.ts:228,266) and is untouched by this
 * fix.
 *
 * THE FIX, TWO FILES:
 *   parseTitleIdentity.service.ts -- a Topps Chrome title naming Logofractor
 *   now derives setKey `topps-chrome` with parallel `Logofractor` (or its
 *   colour-qualified sibling, "Gold Logofractor" etc. -- Logofractor is a
 *   FINISH_FAMILY_TOKENS word, same shape as Wave/Speckle: a colour in front
 *   of it names a different printed rung, not the same bare card). Bowman
 *   and Bowman Chrome Logofractor titles are unaffected -- they resolve via
 *   their own, earlier Bowman-brand rules and never reached the removed
 *   line.
 *   parallelPremiumFloors.ts -- the /35 print-run guess now requires
 *   "bowman" in the matched parallel name, so it never fires for Topps
 *   Chrome's unserialized Logofractor.
 *
 * REMATCH IMPLICATION: rematch-sold-comps.cjs re-derives each row's identity
 * by re-parsing its OWN title through this same parseTitleIdentity module
 * (see the script's own header, "OWN title plus its stored raw fields,
 * through parseTitleIdentity + ..."), so the parser fix alone is sufficient
 * for the ~10,203 stored `topps-chrome-logofractor` rows to re-derive as
 * `topps-chrome` + parallel Logofractor on the next rematch pass --
 * rematch-classify.cjs's R28-FINISH-IS-A-PARALLEL guard (and, for any row
 * outside R28's stricter checklist-backed test, normalizeSetKey's generic
 * unregistered-lexical-child collapse -- see
 * toppsChromeEditionIsTheProduct.test.ts's "MUTATION: an unregistered Chrome
 * key still collapses to the flagship") already exists to carry the
 * migration through; no new fold/alias code was needed.
 */
import { describe, it, expect } from "vitest";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
} from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { isProductSetKey } from "../src/services/catalog/productSetKeys.js";
import { inferPrintRun } from "../src/services/compiq/parallelPremiumFloors.js";

const setKeyOf = (title: string, cardNumber: string | null = null): string =>
  normalizeSetKey(inferSetKeyFromTitle(title, cardNumber));
const parallelOf = (title: string): string | undefined =>
  (parseListingIdentity(title) as { parallel?: string }).parallel;

describe("Topps Chrome Logofractor is a parallel, not a product", () => {
  it("derives setKey topps-chrome, never the unregistered topps-chrome-logofractor", () => {
    expect(setKeyOf("2024 Topps Chrome Logofractor Baseball #55 Base")).toBe("topps-chrome");
    expect(isProductSetKey("topps-chrome-logofractor")).toBe(false);
  });

  it.each([
    ["2024 Topps Chrome Logofractor Baseball #55 Base", "Logofractor"],
    ["2026 Topps Chrome Patrick Bailey Sean Murphy Gold Logofractor 37/50 Lot", "Gold Logofractor"],
    ["2025 TOPPS CHROME LOGOFRACTOR EDITION POWER PLAYERS BRYCE HARPER 10/25 PSA 10", "Logofractor"],
    ["2026 Topps Chrome Jonah Tong RC Blue LOGOFRACTOR /150 New York Mets Rookie #269", "Blue Logofractor"],
    ["2026 Topps Chrome Andy Pages #10 Topps 75th Logofractor /75 Los Angeles Dodgers", "Logofractor"],
  ])("parallel for %s -> %s", (title, wantParallel) => {
    expect(parallelOf(title)).toBe(wantParallel);
    expect(setKeyOf(title)).toBe("topps-chrome");
  });

  it("Bowman Logofractor is unchanged: still Bowman, still its own /35 parallel", () => {
    expect(setKeyOf("2026 Bowman Baseball #CPA-BB Bowman LogoFractor")).toBe("bowman");
    expect(parallelOf("2026 Bowman Edward Florentino Chrome Prospects Auto Bowman Logofractor /35")).toBe("Bowman Logofractor");
  });

  it("Bowman Chrome Logofractor is unchanged: still Bowman Chrome, still its own /35 parallel", () => {
    expect(setKeyOf("2026 Bowman Chrome Max Clark Bowman Logofractor #13/35! Tigers Sharp")).toBe("bowman-chrome");
    expect(parallelOf("2026 Bowman Chrome Joniel Hernandez 1st Bowman LogoFractor 10/35 #BCP-201 Padres")).toBe("Bowman Logofractor");
  });

  it("a Logofractor title with a card number lands on the same id as the base card, only the parallel segment differs", () => {
    const base = "2024 Topps Chrome #55 Shohei Ohtani Base";
    const logofractor = "2024 Topps Chrome Logofractor #55 Shohei Ohtani Base";
    expect(setKeyOf(logofractor)).toBe(setKeyOf(base));
    expect(setKeyOf(logofractor)).toBe("topps-chrome");
    expect(parallelOf(base)).not.toBe("Logofractor");
    expect(parallelOf(logofractor)).toBe("Logofractor");
  });
});

describe("parallelPremiumFloors: the /35 Logofractor floor is Bowman-only", () => {
  it("does not apply the /35 floor to unqualified or Topps Chrome Logofractor names", () => {
    expect(inferPrintRun("Logofractor")).toBeNull();
    expect(inferPrintRun("Logo Fractor")).toBeNull();
    expect(inferPrintRun("Gold Logofractor")).toBeNull();
    expect(inferPrintRun("Blue Logofractor")).toBeNull();
  });

  it("still applies the /35 floor when the name says Bowman", () => {
    expect(inferPrintRun("Bowman Logofractor")).toBe(35);
    expect(inferPrintRun("Bowman Logo Fractor")).toBe(35);
  });
});

describe("guard: parseTitleIdentity never mints an unregistered setKey for this family", () => {
  it.each([
    "2024 Topps Chrome Logofractor Baseball #55 Base",
    "2025 Topps Chrome Logofractor Edition - J.P. Crawford #181 Black Refractor /10",
    "2026 Topps Chrome LogoFractor Bryce Eldridge RC Orange /25 #254 SF Giants",
    "2026 Bowman Baseball #CPA-BB Bowman LogoFractor",
    "2026 Bowman Chrome Max Clark Bowman Logofractor #13/35! Tigers Sharp",
  ])("%s -> setKey is a registered productSetKey or the bare flagship", (title) => {
    const key = setKeyOf(title);
    expect(isProductSetKey(key) || ["topps-chrome", "bowman", "bowman-chrome"].includes(key)).toBe(true);
    expect(key).not.toBe("topps-chrome-logofractor");
  });
});
