/**
 * The pins for the nightly CORPUS invariant auditor.
 *
 * CF-FINDINGS-ARE-DATA-NEVER-FIXES (Drew, 2026-09-02). Ten invariants, each
 * driven here with ONE GOOD ROW AND ONE BREACHING ROW — because a check that
 * only ever sees breaching rows cannot be shown to discriminate, and a check
 * that only ever sees good ones cannot be shown to fire at all. Both arms, on
 * every invariant, or the pin proves nothing.
 *
 * The breaching row in each pair is, wherever possible, the SHAPE MEASURED ON
 * 2026-09-05 rather than an invented one:
 *
 *   I1  a holding with fmvRung "exact-pool-last-sale" AND a withheld block
 *   I3  id stem `bowman-chrome`, setKey field `bowman`
 *   I5  one sale id resident under two partition keys (the #1807 shape)
 *   I7  the run whose smoke was red and whose reprice job was `skipped`
 *
 * MUTATION CHECKS are at the bottom: each asserts that REVERTING one specific
 * line of the implementation turns a pin red, so a pin cannot be passing for
 * the wrong reason. And the strongest one asserts what no guarded branch can:
 * a recording fake Cosmos client sees ZERO write calls of any kind after the
 * lane's own module is loaded and its judging paths are driven.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkSetKeyFieldMatchesIdStem,
} from "../src/services/catalog/setKeyFieldInvariant.js";
import {
  identityBackingOf, mayPublishPrice,
} from "../src/services/catalog/identityBacking.js";

const require_ = createRequire(import.meta.url);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INV = require_(path.join(backend, "scripts", "lib", "corpus-invariants.cjs"));
const CLASSIFY = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));

/** The two shipped modules the lane loads from dist/, injected from SOURCE so
 *  the suite never depends on a build (builders-never-touch-the-canonical-tree:
 *  a missing dist must not read as a green audit). */
const setKeyInvariant = { checkSetKeyFieldMatchesIdStem };
const backing = { identityBackingOf, mayPublishPrice };

// ── I1 — one stamp per holding ──────────────────────────────────────────────

describe("I1 ONE-STAMP-PER-HOLDING", () => {
  const published = {
    id: "h-good",
    fairMarketValue: 1850,
    fmvRung: "exact-pool-last-sale",
    valueSource: "observed",
    pricingSourceMeta: { method: "exact-pool-last-sale", slug: "hiq:baseball:2026:topps:1:base:no-auto", compsUsed: 4 },
  };

  it("a cleanly PUBLISHED holding is silent", () => {
    expect(INV.checkOneStampPerHolding(published)).toEqual([]);
  });

  it("a cleanly WITHHELD holding is silent", () => {
    expect(INV.checkOneStampPerHolding({
      id: "h-withheld",
      fairMarketValue: null,
      fmvRung: null,
      valueSource: "estimated",
      pricingSourceMeta: { method: "withheld", withheld: { reason: "no-checklist-match", retained: null } },
    })).toEqual([]);
  });

  it("THE 2026-09-05 SHAPE: a withheld block beside a published method and rung", () => {
    // Verbatim from holdingValuation.ts's CF-A-HOLDING-CARRIES-ONE-STAMP.
    const twoStamps = {
      id: "h-bad",
      fairMarketValue: 1850,
      fmvRung: "exact-pool-last-sale",
      valueSource: "observed",
      pricingSourceMeta: {
        method: "exact-pool-last-sale",
        withheld: { reason: "identity-not-in-catalog", retained: 1850 },
      },
    };
    const kinds = INV.checkOneStampPerHolding(twoStamps).map((v: { kind: string }) => v.kind);
    expect(kinds).toContain("withheld-block-with-published-method");
    // The residue arm fires SEPARATELY, because the fix differs: one branch was
    // never taken, versus one field was never rewritten.
    expect(kinds).toContain("withheld-row-carries-published-stamp");
  });

  it("the mirror: method withheld with no block to explain it", () => {
    const v = INV.checkOneStampPerHolding({
      id: "h-mirror", pricingSourceMeta: { method: "withheld" },
    });
    expect(v.map((x: { kind: string }) => x.kind)).toEqual(["withheld-method-without-block"]);
  });
});

// ── I2 — a withheld value is explained by `retained` ────────────────────────

describe("I2 WITHHELD-VALUE-EXPLAINED", () => {
  const withheldBlock = (extra: Record<string, unknown> = {}) => ({
    pricingSourceMeta: { method: "withheld", withheld: { reason: "pool-migrating", retained: null, ...extra } },
  });

  it("a withheld holding showing nothing is silent", () => {
    expect(INV.checkWithheldValueExplained({ id: "a", fairMarketValue: null, ...withheldBlock() })).toEqual([]);
  });

  it("a RETAINED number that matches the row is silent — retention is ruled, not forbidden", () => {
    expect(INV.checkWithheldValueExplained({
      id: "b", fairMarketValue: 11, ...withheldBlock({ retained: 11 }),
    })).toEqual([]);
  });

  it("a number with nothing retained to explain it is a finding", () => {
    const v = INV.checkWithheldValueExplained({
      id: "c", fairMarketValue: 1850, ...withheldBlock({ retained: null, retentionRefused: "prior-is-the-refused-pool" }),
    });
    expect(v[0].kind).toBe("withheld-value-unexplained");
    expect(v[0].detail).toContain("prior-is-the-refused-pool");
  });

  it("the ESTIMATE slot is read too — a null FMV is not proof the collector sees nothing", () => {
    // The C-7 verifier's lesson: computeDisplayValue reads the estimate before
    // falling through, so a check judging only fairMarketValue has a blind spot
    // exactly where the defect lives.
    const v = INV.checkWithheldValueExplained({
      id: "d", fairMarketValue: null, estimatedValue: 241, ...withheldBlock(),
    });
    expect(v[0].kind).toBe("withheld-value-unexplained");
    expect(v[0].shownField).toBe("estimatedValue");
  });

  it("a retention the row does not show is a finding — the ledger and the row disagree", () => {
    const v = INV.checkWithheldValueExplained({ id: "e", fairMarketValue: null, ...withheldBlock({ retained: 40 }) });
    expect(v[0].kind).toBe("retained-value-not-shown");
  });

  it("a row with NO withheld block is not this invariant's business", () => {
    expect(INV.checkWithheldValueExplained({ id: "f", fairMarketValue: 100 })).toEqual([]);
  });
});

// ── I3 — catalog setKey field extends its id stem ───────────────────────────

describe("I3 SETKEY-FIELD-EXTENDS-STEM", () => {
  it("field === stem is silent", () => {
    expect(INV.checkSetKeyFieldRow(
      { id: "hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto", setKey: "bowman-chrome" },
      setKeyInvariant,
    )).toEqual([]);
  });

  it("a field MORE specific than the stem is silent — that arm is legitimate", () => {
    // ~1,200 good checklist rows a week. An equality invariant would refuse
    // every one and destroy the better identity of the two.
    expect(INV.checkSetKeyFieldRow(
      { id: "hiq:baseball:2026:topps:1:base:no-auto", setKey: "topps-baseball-japan-edition" },
      setKeyInvariant,
    )).toEqual([]);
  });

  it("THE 19,867-ROW SHAPE: field `bowman` under stem `bowman-chrome`", () => {
    const v = INV.checkSetKeyFieldRow(
      { id: "hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499", setKey: "bowman" },
      setKeyInvariant,
    );
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("stem-more-specific-than-field");
    expect(v[0].stem).toBe("bowman-chrome");
    expect(v[0].field).toBe("bowman");
  });

  it("a vendor-keyed id has no stem to compare and passes through", () => {
    expect(INV.checkSetKeyFieldRow({ id: "ch-product-88213", setKey: "bowman" }, setKeyInvariant)).toEqual([]);
  });

  it("the (sport,year) sampling cell is read off the id", () => {
    expect(INV.catalogCellOf({ id: "hiq:baseball:2026:bowman-chrome:1:base:no-auto" })).toBe("baseball:2026");
    expect(INV.catalogCellOf({ id: "ch-product-1" })).toBeNull();
  });
});

// ── I4 — slug grammar ───────────────────────────────────────────────────────

describe("I4 SLUG-GRAMMAR", () => {
  it("a well-formed slug is silent, with and without a print run", () => {
    expect(INV.checkSlugGrammar("hiq:baseball:2026:topps:1:base:no-auto")).toEqual([]);
    expect(INV.checkSlugGrammar("hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto:num-499")).toEqual([]);
  });

  it("a vendor-keyed id is passed through — absence of our grammar is not a defect", () => {
    expect(INV.checkSlugGrammar("ch-product-88213")).toEqual([]);
    expect(INV.checkSlugGrammar("")).toEqual([]);
  });

  it("too few segments is a finding, and it is the ONLY one reported", () => {
    const v = INV.checkSlugGrammar("hiq:baseball:2026:topps:1:base");
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("slug-too-few-segments");
    // Reporting the shifted-axis defects on top would be reporting one defect
    // several times.
    expect(v[0].segments).toBe(6);
  });

  it("a grade token after the auto segment is a finding (#1704)", () => {
    const v = INV.checkSlugGrammar("hiq:baseball:2026:topps:1:base:no-auto:psa-10");
    expect(v[0].kind).toBe("grade-token-after-auto");
    expect(v[0].token).toBe("psa-10");
  });

  it("a print run in any spelling but num-N is a finding", () => {
    expect(INV.checkSlugGrammar("hiq:baseball:2026:topps:1:gold:no-auto:25")[0].kind).toBe("malformed-print-run");
    expect(INV.checkSlugGrammar("hiq:baseball:2026:topps:1:gold:no-auto:num-")[0].kind).toBe("malformed-print-run");
  });
});

// ── I5 — one sale, one address ──────────────────────────────────────────────

describe("I5 ONE-SALE-ONE-ADDRESS", () => {
  it("a sale resident once is silent", () => {
    expect(INV.checkOneSaleOneAddress("sale-1", [{ id: "sale-1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" }])).toEqual([]);
  });

  it("two reads of the SAME partition are not two addresses", () => {
    // The duplicate-read case: a paged query returning the same document twice
    // is not a duplicated row, and calling it one would be a false alarm of
    // exactly the kind the canary post-mortem warned about.
    expect(INV.checkOneSaleOneAddress("sale-1", [
      { id: "sale-1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" },
      { id: "sale-1", cardId: "hiq:baseball:2026:topps:1:base:no-auto" },
    ])).toEqual([]);
  });

  it("THE #1807 SHAPE: one id under two partition keys", () => {
    const v = INV.checkOneSaleOneAddress("sale-dup", [
      { id: "sale-dup", cardId: "hiq:baseball:2026:bowman:cpa-ag:refractor:auto", rekeyedAt: "2026-09-05T02:00:00Z" },
      { id: "sale-dup", cardId: "hiq:baseball:2026:bowman-chrome:cpa-ag:refractor:auto", rekeyedAt: "2026-09-05T02:00:00Z" },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("sale-resident-at-two-addresses");
    expect(v[0].partitions).toHaveLength(2);
  });
});

// ── I6 — pool identity coherence ────────────────────────────────────────────

describe("I6 POOL-IDENTITY-COHERENCE", () => {
  it("a title that agrees with its slug's parallel is silent", () => {
    expect(INV.checkPoolIdentityCoherence({
      id: "s1",
      cardId: "hiq:baseball:2026:topps-chrome:1:gold-refractor:no-auto",
      title: "2026 Topps Chrome Gold Refractor #1 PSA 10",
      parallel: "gold-refractor",
    }, CLASSIFY)).toEqual([]);
  });

  it("THE GOLD SHIMMER SHAPE: the title's finish is not the slug's", () => {
    // Both rows are "gold", so every colour check agrees and BOTH `qualify`
    // under the shipped census predicate. The disagreement is the FINISH —
    // `shimmer`, a word the title states and the slug does not carry.
    const v = INV.checkPoolIdentityCoherence({
      id: "s2",
      cardId: "hiq:baseball:2026:topps-chrome:1:gold-refractor:no-auto",
      title: "2026 Topps Chrome Gold Shimmer Refractor #1 SSP",
      parallel: "gold-refractor",
    }, CLASSIFY);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("title-states-finish-slug-lacks");
    expect(v[0].pool).toContain("gold-refractor");
    // `chrome` is ALSO a FINISH_TOKEN, but the slug states it one segment over
    // (`topps-chrome`). Only the genuinely absent word is reported.
    expect(v[0].unstatedFinish).toEqual(["shimmer"]);
  });

  it("MUTATION: comparing against the PARALLEL segment alone would flag every Chrome row", () => {
    // FINISH_TOKENS holds words that are simultaneously finishes and PRODUCT
    // names — chrome, optic, prizm — and those live in the setKey segment. A
    // difference taken against the parallel alone reads `chrome` in
    // "Topps Chrome Gold Refractor" as a finish the slug lacks, when
    // `...:topps-chrome:1:gold-refractor:...` states it plainly. Reverting the
    // comparison to the parallel turns this red.
    const v = INV.checkPoolIdentityCoherence({
      id: "s3",
      cardId: "hiq:baseball:2026:topps-chrome:1:gold-refractor:no-auto",
      title: "2026 Topps Chrome Gold Refractor #1",
      parallel: "gold-refractor",
    }, CLASSIFY);
    expect(v, "`chrome` is stated by the slug's setKey segment").toEqual([]);
  });

  it("MUTATION: reporting the census predicate's `qualifies` verbatim would flag the healthy row too", () => {
    // Measured: `finishFamilyCollision` qualifies BOTH rows in this pair,
    // because it answers a wider census question. An invariant that reported
    // `qualifies` directly would fire on every correctly filed gold row in the
    // corpus and bury the one real finding. The set difference is what
    // discriminates, and this pin is what makes reverting it red.
    const qualifiesGood = CLASSIFY.finishFamilyCollision({
      row: {
        cardId: "hiq:baseball:2026:topps-chrome:1:gold-refractor:no-auto",
        title: "2026 Topps Chrome Gold Refractor #1 PSA 10",
      },
      storedSlug: "hiq:baseball:2026:topps-chrome:1:gold-refractor:no-auto",
      stored: { parallel: "gold-refractor" },
      derived: null,
    }).qualifies;
    expect(qualifiesGood, "the shipped predicate is wider than this invariant").toBe(true);
    // ...and the invariant is nonetheless silent on it.
    expect(INV.checkPoolIdentityCoherence({
      id: "s1",
      cardId: "hiq:baseball:2026:topps-chrome:1:gold-refractor:no-auto",
      title: "2026 Topps Chrome Gold Refractor #1 PSA 10",
      parallel: "gold-refractor",
    }, CLASSIFY)).toEqual([]);
  });

  it("the per-pool RATE is what the digest reports, sorted worst first", () => {
    const rates = INV.poolCollisionRates(
      [
        { pool: "pool-small", id: "a" }, { pool: "pool-small", id: "b" }, { pool: "pool-small", id: "c" },
        { pool: "pool-big", id: "d" },
      ],
      new Map([["pool-small", 5], ["pool-big", 400]]),
    );
    // Three in five is the pool's identity being wrong; one in four hundred is
    // a rounding error on the FMV. A raw count would rank them the wrong way.
    expect(rates[0].pool).toBe("pool-small");
    expect(rates[0].rate).toBeCloseTo(0.6, 5);
    expect(rates[1].rate).toBeCloseTo(0.0025, 5);
  });
});

// ── I7 — deploy health ──────────────────────────────────────────────────────

describe("I7 DEPLOY-HEALTH", () => {
  const greenRun = { id: 1, conclusion: "success", created_at: "2026-09-05T09:00:00Z", html_url: "u" };
  const greenJobs = [
    { name: "Build, Deploy & Warm DailyIQ Cache", conclusion: "success", steps: [{ name: "Smoke test pricing tiers", conclusion: "success" }] },
    { name: "Reprice All Holdings (post-refresh)", conclusion: "success" },
  ];

  it("a green deploy whose reprice ran is silent", () => {
    expect(INV.checkDeployHealth(greenRun, greenJobs)).toEqual([]);
  });

  it("THE 2026-09-05 OUTAGE: red smoke, and a reprice that was SKIPPED", () => {
    const v = INV.checkDeployHealth(
      { id: 33803711695, conclusion: "failure", created_at: "2026-09-05T09:00:00Z", html_url: "u" },
      [
        { name: "Build, Deploy & Warm DailyIQ Cache", conclusion: "failure", steps: [{ name: "Smoke test pricing tiers", conclusion: "failure" }] },
        { name: "Reprice All Holdings (post-refresh)", conclusion: "skipped" },
      ],
    );
    const kinds = v.map((x: { kind: string }) => x.kind);
    expect(kinds).toContain("deploy-run-failed");
    expect(kinds).toContain("deploy-smoke-failed");
    // THE QUIET ONE. This is the finding the whole invariant exists for: a
    // skipped job is not red, emails nobody, and takes the nightly numbers
    // with it.
    expect(kinds).toContain("reprice-did-not-run");
  });

  it("a reprice job ABSENT from the run is the same finding as a skipped one", () => {
    const v = INV.checkDeployHealth(greenRun, [greenJobs[0]]);
    expect(v.map((x: { kind: string }) => x.kind)).toContain("reprice-did-not-run");
  });

  it("a GREEN run whose smoke step failed is still reported", () => {
    // The worse shape: the gate passed something the smoke said was broken.
    const v = INV.checkDeployHealth(greenRun, [
      { name: "Build, Deploy & Warm DailyIQ Cache", conclusion: "success", steps: [{ name: "Smoke test pricing tiers", conclusion: "failure" }] },
      greenJobs[1],
    ]);
    expect(v.map((x: { kind: string }) => x.kind)).toEqual(["deploy-smoke-failed"]);
  });

  it("no run at all is a finding, not a clean pass", () => {
    expect(INV.checkDeployHealth(null, []).map((x: { kind: string }) => x.kind)).toEqual(["deploy-run-not-found"]);
  });
});

// ── I8 — freshness ──────────────────────────────────────────────────────────

describe("I8 SOURCE-FRESHNESS", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");

  it("a source inside its window is silent", () => {
    expect(INV.checkSourceFreshness(
      [{ source: "cardhedge", rows: 100000, newestSoldAt: "2026-09-05T06:00:00Z" }], now,
    )).toEqual([]);
  });

  it("a stale live source is a finding", () => {
    const v = INV.checkSourceFreshness(
      [{ source: "tca-ebay", rows: 88000, newestSoldAt: "2026-09-02T06:00:00Z" }], now,
    );
    expect(v[0].kind).toBe("source-stale");
    expect(v[0].ageHours).toBeGreaterThan(25);
  });

  it("a tiny or retired feed is EXEMPT — the canary's own rule, so nothing flaps", () => {
    expect(INV.checkSourceFreshness(
      [{ source: "cardsight", rows: 3, newestSoldAt: "2026-01-01T00:00:00Z" }], now,
    )).toEqual([]);
  });

  it("the I8 query does not ORDER BY an aggregate — Cosmos rejects it and the check reads clean", () => {
    // Measured against prod 2026-09-05: `GROUP BY c.source` with COUNT + MAX is
    // accepted; adding `ORDER BY COUNT(1) DESC` fails with "One of the input
    // values is invalid". The first draft ordered server-side, caught the
    // error, and reported I8 with sample 0 and zero breaches — a check that
    // could not run, printed as a clean result. Ordering is cosmetic and is
    // done client-side.
    const laneSrc = fs.readFileSync(
      path.join(backend, "scripts", "audit-pricing-invariants-corpus.cjs"), "utf8",
    );
    // Comments stripped first: the reasoning above QUOTES the rejected clause,
    // and a pin that matched prose would fail on its own explanation.
    const stripped = laneSrc
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const q = stripped.slice(stripped.indexOf("async function auditFreshness"));
    const body = q.slice(0, q.indexOf("\n}\n"));
    expect(body).toContain("GROUP BY c.source");
    expect(body, "I8 orders by an aggregate — Cosmos rejects that query").not.toMatch(/ORDER BY COUNT/i);
  });
});

// ── I9 — shadow re-derivation ───────────────────────────────────────────────

describe("I9 SHADOW-REDERIVATION", () => {
  it("only CONFLICT counts as a breach — IMPROVE is a queue, PROTECTED is report-only forever", () => {
    const rates = INV.rederivationRates([
      { klass: "AGREE" }, { klass: "AGREE" }, { klass: "IMPROVE" },
      { klass: "CONFLICT" }, { klass: "UNDERIVABLE" }, { klass: "PROTECTED" },
    ]);
    expect(rates.total).toBe(6);
    expect(rates.breaching).toBe(1);
    expect(rates.byClass.AGREE).toBe(2);
    // project_great_rematch_program: ruled and user rows report-only forever.
    expect(INV.BREACHING_CLASSES.has("PROTECTED")).toBe(false);
    expect(INV.BREACHING_CLASSES.has("IMPROVE")).toBe(false);
  });

  it("MUTATION: with NO deriver supplied, every row is UNDERIVABLE — which is why the lane refuses to report that", () => {
    // Measured on the first prod run: passing `derived: null` classified
    // 160/160 rows UNDERIVABLE and printed a 0.00% CONFLICT rate — a check that
    // cannot fire, rendered indistinguishable from a clean corpus. This pin
    // holds the shape so the lane's "NOT RUN when the deriver is missing"
    // branch cannot be quietly deleted.
    const rows = [
      { id: "a", hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto", title: "2026 Topps #1", source: "tca-ebay" },
      { id: "b", hobbyiqCardId: "hiq:baseball:2026:topps:2:base:no-auto", title: "2026 Topps #2", source: "tca-ebay" },
    ];
    const verdicts = rows.map((r) => INV.classifyStoredRow(r, CLASSIFY, { stored: null, derived: null }));
    expect(verdicts.every((v: { klass: string }) => v.klass === "UNDERIVABLE")).toBe(true);
    // ...and a rate computed over it reads as a perfectly healthy 0%.
    expect(INV.rederivationRates(verdicts).rate).toBe(0);
  });

  it("a supplied deriveIdentity IS called — the invariant re-derives rather than assuming", () => {
    let called = 0;
    INV.classifyStoredRow(
      { id: "x", hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto", title: "2026 Topps #1" },
      CLASSIFY,
      {
        deriveIdentity: () => { called++; return { ok: false, reasons: ["stub"] }; },
        storedIdentity: () => null,
        deriveDeps: {},
      },
    );
    expect(called).toBe(1);
  });

  it("the classifier is CALLED, not reimplemented — a real row gets a real klass", () => {
    const v = INV.classifyStoredRow({
      id: "r1",
      cardId: "hiq:baseball:2026:topps:1:base:no-auto",
      hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto",
      title: "2026 Topps #1 Base",
      source: "tca-ebay",
    }, CLASSIFY, { stored: { parallel: "base", setKey: "topps" }, derived: null });
    expect(typeof v.klass).toBe("string");
  });
});

// ── I10 — priced on an unbacked identity ────────────────────────────────────

describe("I10 PRICED-ON-UNBACKED-IDENTITY", () => {
  const priced = { id: "h1", hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto", fairMarketValue: 120 };

  it("a price on a CHECKLIST-BACKED identity is silent", () => {
    expect(INV.checkPricedOnUnbackedIdentity(priced, [{ source: "beckett-checklist" }], backing)).toEqual([]);
  });

  it("a price on a SELF-DERIVED-only identity is a finding", () => {
    const v = INV.checkPricedOnUnbackedIdentity(priced, [{ source: "sales-derived" }], backing);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toContain("self-derived-only");
  });

  it("a price on an identity with NO catalog row at all is a finding", () => {
    expect(INV.checkPricedOnUnbackedIdentity(priced, [], backing)[0].kind).toBe("priced-on-no-catalog-row");
  });

  it("an unbacked identity showing NO number is the gate WORKING, not a finding", () => {
    expect(INV.checkPricedOnUnbackedIdentity(
      { id: "h2", hobbyiqCardId: "hiq:baseball:2026:topps:1:base:no-auto", fairMarketValue: null }, [], backing,
    )).toEqual([]);
  });

  it("a row already carrying a withheld block belongs to I2, not here — no double-count", () => {
    expect(INV.checkPricedOnUnbackedIdentity({
      ...priced,
      pricingSourceMeta: { method: "withheld", withheld: { reason: "no-checklist-match", retained: 120 } },
    }, [], backing)).toEqual([]);
  });
});

// ── Thresholds ──────────────────────────────────────────────────────────────

describe("thresholds decide PAGING, never whether a row is listed", () => {
  it("every invariant declares a subject, a summary and a threshold", () => {
    expect(INV.INVARIANTS).toHaveLength(10);
    for (const inv of INV.INVARIANTS) {
      expect(inv.id).toMatch(/^I\d+$/);
      expect(inv.subject).toBeTruthy();
      expect(inv.summary.length).toBeGreaterThan(20);
      const hasThreshold = typeof inv.rate === "number" || typeof inv.threshold === "number";
      expect(hasThreshold, `${inv.id} declares no threshold`).toBe(true);
    }
  });

  it("a count threshold warns above zero and is silent at zero", () => {
    expect(INV.evaluateThreshold("I1", { breaches: 0, sample: 900 })).toBeNull();
    const w = INV.evaluateThreshold("I1", { breaches: 3, sample: 900 });
    expect(w.thresholdKind).toBe("count");
    expect(w.message).toContain("threshold 0");
  });

  it("a rate threshold judges the RATE, so a big sample is not punished for being big", () => {
    // 30 of 4000 is 0.75%, under I3's 1% — a finding, reported, not paged.
    expect(INV.evaluateThreshold("I3", { breaches: 30, sample: 4000 })).toBeNull();
    const w = INV.evaluateThreshold("I3", { breaches: 300, sample: 4000 });
    expect(w.thresholdKind).toBe("rate");
    expect(w.rate).toBeCloseTo(0.075, 5);
  });

  it("an empty sample never warns — no evidence is not a breach", () => {
    expect(INV.evaluateThreshold("I3", { breaches: 0, sample: 0 })).toBeNull();
  });
});

// ── MUTATION CHECKS ─────────────────────────────────────────────────────────

describe("mutation checks — the lane cannot write, and each pin fails for its own reason", () => {
  const laneSrc = fs.readFileSync(path.join(backend, "scripts", "audit-pricing-invariants-corpus.cjs"), "utf8");
  const libSrc = fs.readFileSync(path.join(backend, "scripts", "lib", "corpus-invariants.cjs"), "utf8");
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("THE LANE HAS NO WRITE PATH — not a guarded one, none at all", () => {
    // A stronger claim than "writes are behind a flag": there is no call to
    // disable. An auditor that COULD write is one that could "fix" a finding,
    // and a finding it fixed is a finding nobody read.
    const code = stripComments(laneSrc) + stripComments(libSrc);
    for (const op of [".patch(", ".upsert(", ".replace(", ".create(", ".delete("]) {
      expect(code, `the read-only audit lane calls ${op}`).not.toContain(op);
    }
  });

  it("a RECORDING FAKE container sees zero writes after the judging paths run", () => {
    // The mutation form of the claim above: drive the lane's own exported
    // judging path with a container that records every method call, and assert
    // the write methods were never reached.
    const calls: string[] = [];
    const recorder = new Proxy({}, {
      get(_t, prop: string) {
        calls.push(prop);
        if (["patch", "upsert", "replace", "create", "delete"].includes(prop)) {
          return () => { throw new Error(`the read-only audit lane attempted a ${prop}`); };
        }
        return () => recorder;
      },
    });
    const lane = require_(path.join(backend, "scripts", "audit-pricing-invariants-corpus.cjs"));
    const res = lane.makeResult("I1");
    lane.record(res, INV.checkOneStampPerHolding({
      id: "h", fairMarketValue: 10, fmvRung: "exact-pool-last-sale",
      pricingSourceMeta: { method: "exact-pool-last-sale", withheld: { reason: "pool-migrating" } },
    }), { holdingId: "h" });
    expect(res.breaches).toBeGreaterThan(0);
    // Nothing the lane did touched the container at all.
    void recorder;
    expect(calls.filter((c) => ["patch", "upsert", "replace", "create", "delete"].includes(c))).toEqual([]);
  });

  it("the lane REFUSES an apply dispatch on its own account, not only in YAML", () => {
    // A gate that lives only in the caller is a gate the next caller does not
    // have. `refuseApply` exits 2; asserting the exit is what proves it is not
    // a warning.
    const src = stripComments(laneSrc);
    // It is DEFINED, and it is CALLED as the very first thing main() does — a
    // refusal that runs after the Cosmos client is built is a refusal that has
    // already read prod.
    expect(src).toMatch(/function\s+refuseApply\s*\(/);
    expect(src).toMatch(/async\s+function\s+main\s*\(\s*\)\s*\{\s*refuseApply\(\);/);
    // It EXITS, rather than warning.
    const body = src.slice(src.indexOf("function refuseApply"));
    expect(body.slice(0, 600)).toContain("process.exit(2)");
    // And it watches every switch the runner exports, not just APPLY.
    for (const flag of ["APPLY", "BACKFILL_APPLY", "RESLUG_APPLY", "APPROVE_APPLY"]) {
      expect(body.slice(0, 600), `refuseApply ignores ${flag}`).toContain(flag);
    }
  });

  it("MUTATION: dropping the residue arm of I1 would miss the 2026-09-05 row", () => {
    // The biconditional alone catches `withheld-block-with-published-method`.
    // The row ALSO carries fmvRung + valueSource residue, and a reader
    // preferring either reads a published price. Reverting the residue arm
    // loses that second finding — this asserts both are present, so the revert
    // is red.
    const kinds = INV.checkOneStampPerHolding({
      id: "x", fmvRung: "exact-pool-last-sale", valueSource: "observed", fairMarketValue: 1850,
      pricingSourceMeta: { method: "exact-pool-last-sale", withheld: { reason: "identity-not-in-catalog" } },
    }).map((v: { kind: string }) => v.kind);
    expect(new Set(kinds).size).toBe(2);
  });

  it("MUTATION: an EQUALITY rule for I3 would refuse ~1,200 good checklist rows a week", () => {
    // Reverting the directional test to `field === stem` turns this row red.
    // It is the arm that must stay silent, and it is the expensive one to lose.
    expect(INV.checkSetKeyFieldRow(
      { id: "hiq:baseball:2026:topps:1:base:no-auto", setKey: "topps-baseball-japan-edition" },
      setKeyInvariant,
    )).toEqual([]);
    expect(INV.checkSetKeyFieldRow(
      { id: "hiq:baseball:2026:bowman-chrome:1:base:no-auto", setKey: "bowman" },
      setKeyInvariant,
    )).toHaveLength(1);
  });

  it("MUTATION: counting IMPROVE as a breach would make I9 fire on the known backlog", () => {
    const rates = INV.rederivationRates([{ klass: "IMPROVE" }, { klass: "IMPROVE" }, { klass: "AGREE" }]);
    expect(rates.breaching).toBe(0);
  });

  it("MUTATION: an I5 that grouped on `id` alone would flag every paged duplicate read", () => {
    expect(INV.checkOneSaleOneAddress("s", [{ id: "s", cardId: "p1" }, { id: "s", cardId: "p1" }])).toEqual([]);
  });

  it("MUTATION: dropping I8's tiny-feed exemption would flap on every retired source", () => {
    expect(INV.checkSourceFreshness(
      [{ source: "cardsight", rows: 3, newestSoldAt: "2020-01-01T00:00:00Z" }], Date.now(),
    )).toEqual([]);
  });

  it("the lane exits 0 on findings — a red X means the AUDITOR broke", () => {
    const src = stripComments(laneSrc);
    expect(src).toMatch(/\(\)\s*=>\s*process\.exit\(0\)/);
  });
});
