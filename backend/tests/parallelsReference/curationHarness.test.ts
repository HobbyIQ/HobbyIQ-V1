// Unit tests for Path Z curation harness (issue #33 Phase 2b-iv-a).
//
// All tests use synthetic HTML — no real network calls, no Cosmos writes.

import { describe, expect, it, vi } from "vitest";
import {
  COLOR_TOKENS,
  commitProposal,
  extractProposalFromArticle,
  extractProposalFromHtml,
  htmlToText,
  inferAutograph,
  inferColor,
  renderProposalMarkdown,
  validateProposal,
  type ParallelAttributesEntry,
  type ParallelAttributesProposal,
} from "../../src/services/parallelsReference/curationHarness.js";
import {
  parallelAttributesId,
  type ParallelAttributesRecord,
} from "../../src/services/parallelsReference/ingestion.js";

const NOW = "2025-01-15T00:00:00.000Z";
const TARGET_SET = "2024 Bowman Chrome Baseball";
const SOURCE_URL = "https://www.cardboardconnection.com/2024-bowman-chrome-baseball-cards";

// ─── htmlToText ─────────────────────────────────────────────────────────────

describe("htmlToText", () => {
  it("strips tags and decodes common entities", () => {
    const html = `<p>Hello&nbsp;<b>World</b> &amp; friends</p>`;
    expect(htmlToText(html)).toBe("Hello World & friends");
  });

  it("turns block tags into newlines so line-based parsing works", () => {
    const html = `<ul><li>Refractor (#/499)</li><li>Gold (#/50)</li></ul>`;
    const t = htmlToText(html);
    expect(t.split("\n")).toEqual(["Refractor (#/499)", "Gold (#/50)"]);
  });

  it("drops <script> and <style> blocks", () => {
    const html = `<style>.x{color:red}</style><p>Refractor (#/499)</p><script>alert(1)</script>`;
    expect(htmlToText(html)).toBe("Refractor (#/499)");
  });
});

// ─── inferColor / inferAutograph ───────────────────────────────────────────

describe("inferColor", () => {
  it("returns a known color when present", () => {
    expect(inferColor("Blue Refractor")).toBe("Blue");
    expect(inferColor("Gold Refractor")).toBe("Gold");
    expect(inferColor("Orange Refractor")).toBe("Orange");
    expect(inferColor("SuperFractor")).toBe("SuperFractor");
  });

  it("prefers multi-word tokens over single-word substrings", () => {
    expect(inferColor("Aqua Lava Refractor")).toBe("Aqua Lava");
  });

  it("returns null when no color token matches", () => {
    expect(inferColor("Refractor")).toBeNull();
    expect(inferColor("Atomic Refractor")).toBe("Atomic"); // Atomic is in vocabulary
  });

  it("exposes a non-empty vocabulary", () => {
    expect(COLOR_TOKENS.length).toBeGreaterThan(10);
  });
});

describe("inferAutograph", () => {
  it("detects autograph hint in name or surrounding context", () => {
    expect(inferAutograph("Gold Refractor Auto", "")).toBe(true);
    expect(inferAutograph("Gold Refractor", "Autograph parallels include")).toBe(true);
    expect(inferAutograph("Refractor Signature", "")).toBe(true);
  });

  it("does not false-positive on names without auto markers", () => {
    expect(inferAutograph("Gold Refractor", "Limited to /50 copies")).toBe(false);
  });
});

// ─── extractProposalFromHtml ───────────────────────────────────────────────

describe("extractProposalFromHtml — bullet-list format", () => {
  const html = `
    <html><head><title>2024 Bowman Chrome Baseball Cards Checklist</title></head>
    <body>
      <h2>Parallels</h2>
      <ul>
        <li>Refractor (#/499)</li>
        <li>Aqua Refractor (#/199)</li>
        <li>Blue Refractor (#/150)</li>
        <li>Gold Refractor (#/50)</li>
        <li>Orange Refractor (#/25)</li>
        <li>Red Refractor (#/5)</li>
        <li>SuperFractor 1/1</li>
      </ul>
    </body></html>
  `;

  it("extracts every bullet-line print-run entry", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    const names = p.entries.map((e) => e.parallelName).sort();
    expect(names).toEqual(
      ["Aqua Refractor", "Blue Refractor", "Gold Refractor", "Orange Refractor", "Red Refractor", "Refractor", "SuperFractor"].sort()
    );
  });

  it("captures the print run for /N entries", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    const byName = Object.fromEntries(p.entries.map((e) => [e.parallelName, e.printRun]));
    expect(byName["Refractor"]).toBe(499);
    expect(byName["Gold Refractor"]).toBe(50);
    expect(byName["Red Refractor"]).toBe(5);
  });

  it("captures the 1/1 SuperFractor as printRun=1", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    const sf = p.entries.find((e) => e.parallelName === "SuperFractor");
    expect(sf?.printRun).toBe(1);
  });

  it("infers color for each entry from the name vocabulary", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    const byName = Object.fromEntries(p.entries.map((e) => [e.parallelName, e.color]));
    expect(byName["Gold Refractor"]).toBe("Gold");
    expect(byName["Red Refractor"]).toBe("Red");
    expect(byName["Aqua Refractor"]).toBe("Aqua");
    expect(byName["Refractor"]).toBeNull();
  });

  it("sets isAutograph=false when no auto markers present", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    for (const e of p.entries) expect(e.isAutograph).toBe(false);
  });

  it("emits a tierWithinSet=null reminder warning when any entries are produced", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    expect(p.warnings.some((w) => /tierWithinSet/.test(w))).toBe(true);
  });

  it("populates a web-research sourceCitation on each entry", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    for (const e of p.entries) {
      expect(e.sourceCitation.type).toBe("web-research");
      if (e.sourceCitation.type === "web-research") {
        expect(e.sourceCitation.url).toBe(SOURCE_URL);
        expect(e.sourceCitation.siteName).toBe("Cardboard Connection");
        expect(e.sourceCitation.date).toBe(NOW);
      }
    }
  });

  it("extracts the article title from <title>", () => {
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    expect(p.sourceTitle).toBe("2024 Bowman Chrome Baseball Cards Checklist");
  });
});

describe("extractProposalFromHtml — autograph context", () => {
  it("flags entries inside an autograph block", () => {
    const html = `
      <h3>Autograph parallels</h3>
      <ul>
        <li>Gold Refractor Auto (#/50)</li>
        <li>Red Refractor Autograph (#/5)</li>
      </ul>
    `;
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    expect(p.entries.length).toBeGreaterThan(0);
    for (const e of p.entries) expect(e.isAutograph).toBe(true);
  });
});

describe("extractProposalFromHtml — empty / negative cases", () => {
  it("returns 0 entries and a 'no patterns matched' warning when none found", () => {
    const html = `<p>This article has no parallel data at all.</p>`;
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    expect(p.entries).toEqual([]);
    expect(p.warnings.some((w) => /No print-run patterns matched/.test(w))).toBe(true);
  });

  it("dedupes repeated mentions of the same parallel (same isAutograph) — last wins", () => {
    const html = `
      <p>Gold Refractor (#/50)</p>
      <p>Gold Refractor (#/50)</p>
    `;
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    const golds = p.entries.filter((e) => e.parallelName === "Gold Refractor");
    expect(golds.length).toBe(1);
  });

  it("ignores absurd print runs (> 10000)", () => {
    const html = `<p>Bogus parallel (#/99999)</p>`;
    const p = extractProposalFromHtml(html, { sourceUrl: SOURCE_URL, targetSet: TARGET_SET, now: NOW });
    expect(p.entries.length).toBe(0);
  });
});

// ─── extractProposalFromArticle (network wrapper) ──────────────────────────

describe("extractProposalFromArticle", () => {
  it("delegates to fetchImpl and then extractProposalFromHtml", async () => {
    const html = `<ul><li>Refractor (#/499)</li></ul>`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => html,
    } as Response);
    const p = await extractProposalFromArticle(SOURCE_URL, TARGET_SET, fetchMock as any);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(p.entries.length).toBe(1);
    expect(p.entries[0].parallelName).toBe("Refractor");
  });

  it("rejects non-http URLs", async () => {
    const fetchMock = vi.fn();
    await expect(
      extractProposalFromArticle("file:///etc/passwd", TARGET_SET, fetchMock as any)
    ).rejects.toThrow(/must be http/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on non-200 responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "",
    } as Response);
    await expect(
      extractProposalFromArticle(SOURCE_URL, TARGET_SET, fetchMock as any)
    ).rejects.toThrow(/HTTP 404/);
  });
});

// ─── validateProposal ──────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ParallelAttributesEntry> = {}): ParallelAttributesEntry {
  return {
    parallelName: "Gold Refractor",
    color: "Gold",
    printRun: 50,
    isAutograph: false,
    parentVariant: null,
    tierWithinSet: 5, // owner-filled placeholder
    sourceCitation: {
      type: "web-research",
      url: SOURCE_URL,
      siteName: "Cardboard Connection",
      date: NOW,
      note: "test",
    },
    matchedText: "Gold Refractor (#/50)",
    ...overrides,
  };
}

function makeProposal(entries: ParallelAttributesEntry[]): ParallelAttributesProposal {
  return {
    sourceUrl: SOURCE_URL,
    sourceTitle: "test article",
    extractedAt: NOW,
    targetSet: TARGET_SET,
    entries,
    warnings: [],
  };
}

describe("validateProposal", () => {
  it("returns 0 errors for a fully-populated proposal", () => {
    const errs = validateProposal(makeProposal([makeEntry()]), { reviewedBy: "owner", reviewedAt: NOW });
    expect(errs).toEqual([]);
  });

  it("flags tierWithinSet=null as a blocking error", () => {
    const errs = validateProposal(makeProposal([makeEntry({ tierWithinSet: null })]), {
      reviewedBy: "owner",
      reviewedAt: NOW,
    });
    expect(errs.some((e) => /tierWithinSet is null/.test(e))).toBe(true);
  });

  it("flags duplicate composite IDs", () => {
    const errs = validateProposal(makeProposal([makeEntry(), makeEntry()]), {
      reviewedBy: "owner",
      reviewedAt: NOW,
    });
    expect(errs.some((e) => /duplicate composite id/.test(e))).toBe(true);
  });

  it("rejects '|' inside parallelName (reserved for composite id)", () => {
    const errs = validateProposal(makeProposal([makeEntry({ parallelName: "Gold|Refractor" })]), {
      reviewedBy: "owner",
      reviewedAt: NOW,
    });
    expect(errs.some((e) => /reserved/.test(e) || /'\|'/.test(e))).toBe(true);
  });

  it("rejects empty reviewedBy", () => {
    const errs = validateProposal(makeProposal([makeEntry()]), { reviewedBy: "" });
    expect(errs.some((e) => /reviewedBy/.test(e))).toBe(true);
  });

  it("rejects empty entries array", () => {
    const errs = validateProposal(makeProposal([]), { reviewedBy: "owner", reviewedAt: NOW });
    expect(errs.some((e) => /entries is empty/.test(e))).toBe(true);
  });

  it("rejects non-positive printRun", () => {
    const errs = validateProposal(makeProposal([makeEntry({ printRun: 0 })]), {
      reviewedBy: "owner",
      reviewedAt: NOW,
    });
    expect(errs.some((e) => /printRun/.test(e))).toBe(true);
  });
});

// ─── commitProposal (with in-memory Cosmos container stub) ─────────────────

function makeFakeContainer() {
  const store = new Map<string, ParallelAttributesRecord>();
  const container = {
    items: {
      upsert: async (rec: ParallelAttributesRecord) => {
        // Mimic Cosmos: id is the document key within partition /set.
        store.set(`${rec.set}|${rec.id}`, JSON.parse(JSON.stringify(rec)));
        return { resource: rec, statusCode: 200 } as any;
      },
    },
  };
  return { container: container as any, store };
}

describe("commitProposal", () => {
  it("writes each entry as a parallel_attributes record using the composite id", async () => {
    const { container, store } = makeFakeContainer();
    const proposal = makeProposal([
      makeEntry({ parallelName: "Refractor", color: null, printRun: 499 }),
      makeEntry({ parallelName: "Gold Refractor", color: "Gold", printRun: 50 }),
    ]);
    const result = await commitProposal(container, proposal, { reviewedBy: "owner", reviewedAt: NOW });
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(store.size).toBe(2);
    const expectedId1 = parallelAttributesId(TARGET_SET, "Refractor", false);
    expect(store.has(`${TARGET_SET}|${expectedId1}`)).toBe(true);
  });

  it("is idempotent: running twice produces the same record set with no duplicates", async () => {
    const { container, store } = makeFakeContainer();
    const proposal = makeProposal([makeEntry()]);
    await commitProposal(container, proposal, { reviewedBy: "owner", reviewedAt: NOW });
    await commitProposal(container, proposal, { reviewedBy: "owner", reviewedAt: NOW });
    expect(store.size).toBe(1);
  });

  it("refuses to commit when validation has errors (e.g., tierWithinSet null)", async () => {
    const { container, store } = makeFakeContainer();
    const proposal = makeProposal([makeEntry({ tierWithinSet: null })]);
    await expect(
      commitProposal(container, proposal, { reviewedBy: "owner", reviewedAt: NOW })
    ).rejects.toThrow(/cannot commit proposal/);
    expect(store.size).toBe(0);
  });
});

// ─── renderProposalMarkdown ────────────────────────────────────────────────

describe("renderProposalMarkdown", () => {
  it("renders a header, metadata, and a row per entry", () => {
    const md = renderProposalMarkdown(makeProposal([makeEntry()]));
    expect(md).toMatch(/^# Curation proposal — 2024 Bowman Chrome Baseball/);
    expect(md).toMatch(/Source URL/);
    expect(md).toMatch(/\| Gold Refractor \|/);
  });

  it("flags missing tierWithinSet in the table", () => {
    const md = renderProposalMarkdown(makeProposal([makeEntry({ tierWithinSet: null })]));
    expect(md).toMatch(/\*\*REQUIRED\*\*/);
  });

  it("includes warnings when present", () => {
    const p = makeProposal([makeEntry()]);
    p.warnings = ["test warning"];
    const md = renderProposalMarkdown(p);
    expect(md).toMatch(/## Warnings/);
    expect(md).toMatch(/test warning/);
  });
});

// ─── Phase 3 (issue #25) — printRun=null is a valid persisted state ─────────
//
// Per backend/docs/parallels-reference-schema.md §2.3 (Phase 3 reframe):
// printRun is an OPTIONAL enhancement field. tierWithinSet remains required;
// printRun=null is NOT a curation incompleteness signal. These tests pin that
// behavior at the curation-harness boundary so a future regression cannot
// silently re-introduce a printRun requirement.

describe("Phase 3 — printRun=null is a valid commit", () => {
  it("validateProposal returns 0 errors when printRun is null and tierWithinSet is set", () => {
    const errs = validateProposal(
      makeProposal([makeEntry({ printRun: null, tierWithinSet: 4 })]),
      { reviewedBy: "owner", reviewedAt: NOW },
    );
    expect(errs).toEqual([]);
  });

  it("commitProposal successfully writes a record with printRun=null", async () => {
    const { container, store } = makeFakeContainer();
    const proposal = makeProposal([
      makeEntry({
        parallelName: "Blue Refractor",
        color: "Blue",
        printRun: null, // print run unknown / not publicly available
        tierWithinSet: 4,
      }),
    ]);
    const result = await commitProposal(container, proposal, {
      reviewedBy: "owner",
      reviewedAt: NOW,
    });
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(store.size).toBe(1);
    const expectedId = parallelAttributesId(TARGET_SET, "Blue Refractor", false);
    const stored = store.get(`${TARGET_SET}|${expectedId}`);
    expect(stored).toBeDefined();
    expect(stored!.printRun).toBeNull();
    expect(stored!.tierWithinSet).toBe(4);
  });

  it("tierWithinSet remains required — printRun=null does NOT loosen the tier check", () => {
    // Phase 3 contract: printRun optional, tierWithinSet stays mandatory.
    // Regression guard: a curator dropping BOTH should still be rejected
    // exactly on the tierWithinSet error.
    const errs = validateProposal(
      makeProposal([makeEntry({ printRun: null, tierWithinSet: null })]),
      { reviewedBy: "owner", reviewedAt: NOW },
    );
    expect(errs.some((e) => /tierWithinSet is null/.test(e))).toBe(true);
    // And no errors should reference printRun for the null-printRun case.
    expect(errs.every((e) => !/printRun/.test(e))).toBe(true);
  });
});
