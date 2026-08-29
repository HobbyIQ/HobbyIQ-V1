// CF-IMPORT-BE (2026-06-21) — parser tests (numeric + date + header
// auto-map + file parser + collision detector). All pure-function tests,
// no Cardsight HTTP, no Cosmos writes.

import { describe, it, expect } from "vitest";
import { parseNumeric } from "../src/services/portfolioiq/import/numericParser.js";
import { parseDate } from "../src/services/portfolioiq/import/dateParser.js";
import { autoMapHeaders } from "../src/services/portfolioiq/import/headerAutoMap.js";
import { detectCollision } from "../src/services/portfolioiq/import/collisionDetector.js";
import { parseHoldingsFile } from "../src/services/portfolioiq/import/fileParser.js";
import * as XLSX from "xlsx";

// ─── parseNumeric — strict mode (round-trip path) ───────────────────────

describe("CF-IMPORT-BE — parseNumeric strict mode (round-trip path)", () => {
  it("plain numbers parse ok", () => {
    expect(parseNumeric(123, "strict")).toEqual({ value: 123, outcome: "ok" });
    expect(parseNumeric("123.45", "strict")).toEqual({ value: 123.45, outcome: "ok" });
    expect(parseNumeric("-12.5", "strict")).toEqual({ value: -12.5, outcome: "ok" });
  });

  it("empty/null/sentinel → empty", () => {
    expect(parseNumeric("", "strict").outcome).toBe("empty");
    expect(parseNumeric(null, "strict").outcome).toBe("empty");
    expect(parseNumeric("N/A", "strict").outcome).toBe("empty");
    expect(parseNumeric("-", "strict").outcome).toBe("empty");
  });

  it("currency/commas/percent → REJECTED (round-trip drift is corruption)", () => {
    expect(parseNumeric("$123.45", "strict").outcome).toBe("rejected");
    expect(parseNumeric("1,234.56", "strict").outcome).toBe("rejected");
    expect(parseNumeric("50%", "strict").outcome).toBe("rejected");
  });
});

// ─── parseNumeric — lenient mode (arbitrary path) ──────────────────────

describe("CF-IMPORT-BE — parseNumeric lenient mode (arbitrary path)", () => {
  it("currency prefixes stripped (Excel onboarding case)", () => {
    expect(parseNumeric("$123.45", "lenient")).toEqual({ value: 123.45, outcome: "ok" });
    expect(parseNumeric("€50", "lenient")).toEqual({ value: 50, outcome: "ok" });
    expect(parseNumeric("£1234", "lenient")).toEqual({ value: 1234, outcome: "ok" });
  });

  it("thousands separators stripped", () => {
    expect(parseNumeric("1,234.56", "lenient")).toEqual({ value: 1234.56, outcome: "ok" });
    expect(parseNumeric("$1,234,567.89", "lenient")).toEqual({ value: 1234567.89, outcome: "ok" });
  });

  it("CF-IMPORT-VOLUME: trailing % → FLAGGED (don't-guess, replaces pre-volume ÷100 coercion)", () => {
    // Pre-CF-IMPORT-VOLUME: "50%" → 0.5 (silently coerced).
    // Post:  no user-editable column has percentage semantics, so this is
    // a user typo, not a ratio. Flag for review.
    const r1 = parseNumeric("50%", "lenient");
    expect(r1.outcome).toBe("flagged");
    expect(r1.value).toBeNull();
    expect(r1.reason).toContain("trailing %");

    const r2 = parseNumeric("12.5%", "lenient");
    expect(r2.outcome).toBe("flagged");
    expect(r2.value).toBeNull();
  });

  it("parenthesized negatives (accounting)", () => {
    expect(parseNumeric("(1,234.56)", "lenient")).toEqual({ value: -1234.56, outcome: "ok" });
  });

  it("whitespace stripped", () => {
    expect(parseNumeric("  $1,234.56  ", "lenient")).toEqual({ value: 1234.56, outcome: "ok" });
  });

  it("genuinely non-numeric → FLAGGED (not rejected, not batch-fail)", () => {
    expect(parseNumeric("about $20", "lenient").outcome).toBe("flagged");
    expect(parseNumeric("price: TBD", "lenient").outcome).toBe("flagged");
    // value MUST be null on flag; the row stays in the preview for user
    // resolution, never silently coerced.
    expect(parseNumeric("about $20", "lenient").value).toBeNull();
  });
});

// ─── parseDate — confidence classification ──────────────────────────────

describe("CF-IMPORT-BE — parseDate", () => {
  it("ISO 8601 → confident", () => {
    expect(parseDate("2026-04-15")).toEqual({ value: "2026-04-15", confidence: "confident" });
    expect(parseDate("2026-04-15T00:00:00Z").confidence).toBe("confident");
  });

  it("Excel serial → confident", () => {
    // 45397 = roughly Apr 15, 2024 (depends on Excel epoch convention)
    const r = parseDate(45397);
    expect(r.confidence).toBe("confident");
    expect(r.value).toMatch(/^2024-/);
  });

  it("month-name formats → confident", () => {
    expect(parseDate("Apr 15, 2026").value).toBe("2026-04-15");
    expect(parseDate("April 15, 2026").value).toBe("2026-04-15");
    expect(parseDate("15 Apr 2026").value).toBe("2026-04-15");
    expect(parseDate("2026-Apr-15").value).toBe("2026-04-15");
  });

  it("unambiguous DD/MM (day > 12) → confident", () => {
    // 25/04/2026 — 25 can't be a month, so must be DD/MM
    expect(parseDate("25/04/2026").value).toBe("2026-04-25");
  });

  it("unambiguous MM/DD (day > 12) → confident", () => {
    // 04/25/2026 — same logic in reverse
    expect(parseDate("04/25/2026").value).toBe("2026-04-25");
  });

  it("AMBIGUOUS dd/mm vs mm/dd (both <= 12) → flagged, not guessed (don't-guess discipline)", () => {
    // 12/05/2024 could be Dec 5 OR May 12; we don't pick
    const r = parseDate("12/05/2024");
    expect(r.confidence).toBe("ambiguous");
    expect(r.value).toBeNull();
    expect(r.reason).toContain("disambiguate");
  });

  it("empty/null/sentinel → empty", () => {
    expect(parseDate("").confidence).toBe("empty");
    expect(parseDate(null).confidence).toBe("empty");
    expect(parseDate("N/A").confidence).toBe("empty");
  });

  it("garbage → invalid", () => {
    expect(parseDate("not a date").confidence).toBe("invalid");
    expect(parseDate("2026-99-99").confidence).toBe("invalid");
  });
});

// ─── autoMapHeaders ────────────────────────────────────────────────────

describe("CF-IMPORT-BE — autoMapHeaders", () => {
  it("detects round-trip sheet by holdingId presence", () => {
    const r = autoMapHeaders(["holdingId", "playerName", "cardYear"]);
    expect(r.isRoundTrip).toBe(true);
  });

  it("detects round-trip sheet by cardId presence", () => {
    const r = autoMapHeaders(["cardId", "playerName"]);
    expect(r.isRoundTrip).toBe(true);
  });

  it("arbitrary sheet (no round-trip anchors) → isRoundTrip false", () => {
    const r = autoMapHeaders(["Player", "Year", "Card", "Paid"]);
    expect(r.isRoundTrip).toBe(false);
  });

  it("maps common synonyms to canonical columns", () => {
    const r = autoMapHeaders(["Player", "Year", "Brand", "Paid", "Cert", "Auto"]);
    expect(r.mapping["Player"]).toBe("playerName");
    expect(r.mapping["Year"]).toBe("cardYear");
    expect(r.mapping["Brand"]).toBe("product");
    expect(r.mapping["Paid"]).toBe("purchasePrice");
    expect(r.mapping["Cert"]).toBe("certNumber");
    expect(r.mapping["Auto"]).toBe("isAuto");
  });

  it("case-insensitive header matching", () => {
    const r = autoMapHeaders(["PLAYER", "year", "Paid"]);
    expect(r.mapping["PLAYER"]).toBe("playerName");
    expect(r.mapping["year"]).toBe("cardYear");
  });

  it("unrecognized headers → unmapped list (user reconciles)", () => {
    const r = autoMapHeaders(["Player", "Some Custom Column"]);
    expect(r.mapping["Some Custom Column"]).toBeNull();
    expect(r.unmapped).toContain("Some Custom Column");
  });
});

// ─── collision detector ────────────────────────────────────────────────

describe("CF-IMPORT-BE — collision detector (the #2 guard, Hartman-4× scenario)", () => {
  const HARTMAN_HOLDINGS = {
    "h1": { id: "h1", cardId: "befe9bcc", parallel: "Blue X-Fractor /150", isAuto: true, playerName: "Eric Hartman" },
    "h2": { id: "h2", cardId: "befe9bcc", parallel: "Blue X-Fractor /150", isAuto: true, playerName: "Eric Hartman" },
    "h3": { id: "h3", cardId: "befe9bcc", parallel: "Blue X-Fractor /150", isAuto: true, playerName: "Eric Hartman" },
    "h4": { id: "h4", cardId: "befe9bcc", parallel: "Blue X-Fractor /150", isAuto: true, playerName: "Eric Hartman" },
  } as Record<string, import("../src/types/portfolioiq.types.js").PortfolioHolding>;

  it("Hartman-4× re-import: collision detected on all 4 existing holdings", () => {
    const r = detectCollision(
      { cardId: "befe9bcc", holdingId: null, parallel: "Blue X-Fractor /150", gradeCompany: null, gradeValue: null, serialNumber: null },
      HARTMAN_HOLDINGS,
    );
    expect(r.collides).toBe(true);
    expect(r.existingHoldingIds).toHaveLength(4);
    // Default skip when no holdingId on incoming row (preserves user intent)
    expect(r.defaultAction).toBe("skip");
  });

  it("4-prime refinement: incoming holdingId + cardId match → defaultAction flips to update-cost", () => {
    const r = detectCollision(
      { cardId: "befe9bcc", holdingId: "h2", parallel: "Blue X-Fractor /150", gradeCompany: null, gradeValue: null, serialNumber: null },
      HARTMAN_HOLDINGS,
    );
    expect(r.collides).toBe(true);
    expect(r.defaultAction).toBe("update-cost");
    expect(r.reason).toContain("round-trip");
  });

  it("no existing match → no collision", () => {
    const r = detectCollision(
      { cardId: "different-card", holdingId: null, parallel: "Blue X-Fractor /150", gradeCompany: null, gradeValue: null, serialNumber: null },
      HARTMAN_HOLDINGS,
    );
    expect(r.collides).toBe(false);
  });

  // CF-IMPORT-RESOLVES-TO-CHECKLIST (D12-b, 2026-08-29): a row with no id is
  // keyed by what it SAYS it is. The old contract here ("no cardId → no
  // collision check possible") let the entire unresolved population — which,
  // with the resolver stubbed, was every arbitrary-sheet row — bypass dedup.
  it("no cardId on incoming row → keyed by the title tuple, still checked", () => {
    const r = detectCollision(
      { cardId: null, holdingId: null, parallel: "Blue X-Fractor /150", gradeCompany: null, gradeValue: null, serialNumber: null,
        playerName: "Eric Hartman", cardYear: 2024, product: "Bowman Chrome", cardNumber: "CPA-EH" },
      { "h1": { id: "h1", cardId: null, parallel: "Blue X-Fractor /150", playerName: "Eric Hartman", cardYear: 2024, product: "Bowman Chrome", cardNumber: "CPA-EH" } as unknown as import("../src/types/portfolioiq.types.js").PortfolioHolding },
    );
    expect(r.collides).toBe(true);
    expect(r.keyedBy).toBe("title");
    expect(r.existingHoldingIds).toEqual(["h1"]);
    expect(r.reason).not.toContain("no collision check possible");
  });

  it("no cardId AND no title on incoming row → nothing to compare (the only no-check case)", () => {
    const r = detectCollision(
      { cardId: null, holdingId: null, parallel: null, gradeCompany: null, gradeValue: null, serialNumber: null },
      HARTMAN_HOLDINGS,
    );
    expect(r.collides).toBe(false);
    expect(r.reason).toContain("nothing to compare");
  });

  it("a resolved row matches an existing holding on hobbyiqCardId, and on the title tuple when the ids differ", () => {
    type H = import("../src/types/portfolioiq.types.js").PortfolioHolding;
    const SLUG = "hiq:baseball:2024:bowman-chrome:cpa-eh:blue-refractor:auto:num-150";
    const existing = {
      "legacy": { id: "legacy", cardId: "befe9bcc", hobbyiqCardId: SLUG, parallel: "Blue Refractor" } as unknown as H,
      "titled": { id: "titled", cardId: "1675907831540x1", playerName: "Eric Hartman", cardYear: 2024, product: "Bowman Chrome", cardNumber: "CPA-EH", parallel: "Blue Refractor" } as unknown as H,
      "other": { id: "other", cardId: "1675907831540x2", playerName: "Someone Else", cardYear: 2024, product: "Bowman Chrome", cardNumber: "CPA-SE", parallel: "Blue Refractor" } as unknown as H,
    };
    const r = detectCollision(
      { cardId: SLUG, holdingId: null, parallel: "Blue Refractor", gradeCompany: null, gradeValue: null, serialNumber: null,
        playerName: "Eric Hartman", cardYear: 2024, product: "Bowman Chrome", cardNumber: "CPA-EH" },
      existing,
    );
    expect(r.collides).toBe(true);
    expect([...r.existingHoldingIds].sort()).toEqual(["legacy", "titled"]);
    expect(r.keyedBy).toBe("slug");
  });

  it("different grade → not a collision", () => {
    // Same cardId but different grade = different physical card
    const r = detectCollision(
      { cardId: "befe9bcc", holdingId: null, parallel: "Blue X-Fractor /150", gradeCompany: "PSA", gradeValue: 10, serialNumber: null },
      HARTMAN_HOLDINGS,
    );
    expect(r.collides).toBe(false);
  });
});

// ─── CSV cells arrive as text (CF-IMPORT-SERIAL-IS-TEXT, D12-b) ─────────

describe("CF-IMPORT-SERIAL-IS-TEXT — the CSV reader delivers text; the columns parse themselves", () => {
  const csv = (rows: string[]) => rows.join("\n") + "\n";

  it("a Serial cell '/50' or '12/50' stays text — it is a print run, not a 1950 date", () => {
    const res = parseHoldingsFile(csv([
      "Player,Year,Brand,Card #,Serial,Cert,Auto,Paid",
      "Marconi German,2026,Bowman Chrome,CPA-MG,/50,12345678,TRUE,120",
      "Marconi German,2026,Bowman Chrome,CPA-MG,12/50,,FALSE,$95.50",
    ]), "csv");
    expect(res.rows[0]!.cells["serialNumber"]?.value).toBe("/50");
    expect(res.rows[1]!.cells["serialNumber"]?.value).toBe("12/50");
    expect(res.rows[0]!.cells["certNumber"]?.value).toBe("12345678");
    expect(res.rows[0]!.cells["cardNumber"]?.value).toBe("CPA-MG");
    // The typed columns still parse: the reader stopped typing, the parsers did not.
    expect(res.rows[0]!.cells["cardYear"]?.value).toBe(2026);
    expect(res.rows[0]!.cells["isAuto"]?.value).toBe(true);
    expect(res.rows[1]!.cells["isAuto"]?.value).toBe(false);
    expect(res.rows[0]!.cells["purchasePrice"]?.value).toBe(120);
    expect(res.rows[1]!.cells["purchasePrice"]?.value).toBe(95.5);
  });
});

// ─── file parser (xlsx round-trip detection + path strictness) ──────────

describe("CF-IMPORT-BE — parseHoldingsFile (path detection + parsing)", () => {
  function makeXlsx(headers: string[], rows: unknown[][]): Buffer {
    const data = [headers, ...rows];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Holdings");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  it("round-trip sheet (holdingId present) → isRoundTrip true, strict numeric parse", () => {
    const buf = makeXlsx(
      ["holdingId", "playerName", "cardYear", "purchasePrice"],
      [["h1", "Eric Hartman", 2026, 100], ["h2", "Paul Skenes", 2024, 250.50]],
    );
    const r = parseHoldingsFile(buf, "xlsx");
    expect(r.isRoundTrip).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.cells["purchasePrice"]?.value).toBe(100);
    expect(r.rows[1]!.cells["purchasePrice"]?.value).toBe(250.50);
  });

  it("round-trip sheet + formatted numeric → REJECTED (strict mode flag)", () => {
    const buf = makeXlsx(
      ["holdingId", "playerName", "purchasePrice"],
      [["h1", "Eric Hartman", "$100"]],
    );
    const r = parseHoldingsFile(buf, "xlsx");
    expect(r.isRoundTrip).toBe(true);
    expect(r.rows[0]!.flags.some(f => f.column === "purchasePrice")).toBe(true);
    expect(r.rows[0]!.cells["purchasePrice"]?.outcome).toBe("rejected");
  });

  it("arbitrary sheet (no holdingId) → isRoundTrip false + auto-map proposed", () => {
    const buf = makeXlsx(
      ["Player", "Year", "Paid", "Auto"],
      [["Eric Hartman", 2026, "$100", "yes"]],
    );
    const r = parseHoldingsFile(buf, "xlsx");
    expect(r.isRoundTrip).toBe(false);
    expect(r.autoMap.mapping["Player"]).toBe("playerName");
    expect(r.autoMap.mapping["Paid"]).toBe("purchasePrice");
    // Lenient parse: $100 → 100, "yes" → true
    expect(r.rows[0]!.cells["purchasePrice"]?.value).toBe(100);
    expect(r.rows[0]!.cells["isAuto"]?.value).toBe(true);
  });

  it("arbitrary sheet + ambiguous date → flagged on row", () => {
    const buf = makeXlsx(
      ["Player", "Year", "Date"],
      [["Eric Hartman", 2026, "12/05/2024"]],
    );
    const r = parseHoldingsFile(buf, "xlsx");
    expect(r.isRoundTrip).toBe(false);
    expect(r.rows[0]!.flags.some(f => f.column === "purchaseDate")).toBe(true);
  });

  it("computed columns on a round-trip sheet are IGNORED, not warn-if-edited", () => {
    // Per the banked guardrail: read-only set is ignored, never per-value detection
    const buf = makeXlsx(
      ["holdingId", "playerName", "fairMarketValue", "currentValue"],
      [["h1", "Eric Hartman", 999999, 999999]], // user "edited" these — engine should ignore
    );
    const r = parseHoldingsFile(buf, "xlsx");
    // Computed columns shouldn't appear in the row's cells (filtered at parse)
    expect(r.rows[0]!.cells["fairMarketValue"]).toBeUndefined();
    expect(r.rows[0]!.cells["currentValue"]).toBeUndefined();
    // No flag fired for these (intentional silence)
    expect(r.rows[0]!.flags.find(f => f.column === "fairMarketValue")).toBeUndefined();
  });
});
