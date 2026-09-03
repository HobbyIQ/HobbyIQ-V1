/**
 * CF-MATERIALIZE-UNGRADED-PARENTS (Drew, 2026-08-31).
 *
 * The inverse job: mint the ungraded parent where only graded children exist,
 * so a raw holding can resolve. What has to stay true:
 *
 *   - the parent is minted from the child, carrying its fields MINUS grade
 *   - a row that already exists is never overwritten -- pinned THROUGH THE
 *     PRODUCTION WRITE PATH, not by calling mergeCatalogEntries directly
 *   - the source classifies DERIVED, so it can never adjudicate or outvote
 *   - the grade suffix is parsed by the canonical positional parser
 *
 * PREREQ: `npm run build`. This suite requires the script, which lazily loads
 * dist/ modules, and the write-path tests import the compiled service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  catalogAuthorityOf,
  canAdjudicate,
  isDerived,
  authorityRank,
} from "../src/services/catalog/catalogAuthority.service";
import { cardIdentityKey } from "../src/services/portfolioiq/cardIdentityKey.service";

// ── the fake Cosmos the PRODUCTION write path talks to ──────────────────────
//
// CF-PIN-THE-PATH-PRODUCTION-USES. The previous version of this file pinned
// "never overwrite" by calling mergeCatalogEntries(incoming, existing) directly
// -- supplying the `existing` argument that the production path was in fact
// never fetching. Both tests passed while the shipped code blind-upserted,
// because upsertCatalogEntry(row, { known: null }) forces existing=null and
// mergeCatalogEntries then computes winnerIsIncoming = !existing = true.
//
// So the guard is pinned here through upsertCatalogEntry itself, with Cosmos
// faked underneath. The store models the two things that actually matter: a
// point read keyed (id, partitionKey), and the cross-partition
// "SELECT TOP 1 * WHERE c.id = @id" fallback that finds a row sitting under a
// FOREIGN partition key -- the case the deleted hand-rolled guard could not see.
interface FakeRow { id: string; cardId?: string; [k: string]: unknown }

// getContainer() returns null when this is unset, which would make every
// write-path test pass vacuously against a no-op. The CosmosClient below is
// mocked, so this value is never dialled -- it only gets us past that guard.
process.env.COSMOS_CONNECTION_STRING =
  "AccountEndpoint=https://vitest.invalid:443/;AccountKey=dml0ZXN0LW9ubHktbm90LWEtcmVhbC1rZXk=;";

const store = {
  /** keyed `${partitionKey} ${id}` -- so a row can hide under a foreign pk */
  docs: new Map<string, FakeRow>(),
  reset() { this.docs.clear(); },
  put(row: FakeRow, partitionKey?: string) {
    this.docs.set(`${partitionKey ?? row.cardId ?? row.id} ${row.id}`, row);
  },
  all(): FakeRow[] { return [...this.docs.values()]; },
};

let pointReads = 0;
let fallbackQueries = 0;

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    database() {
      return {
        container: () => ({
          item: (id: string, pk: string) => ({
            read: async () => {
              pointReads++;
              const hit = store.docs.get(`${pk} ${id}`);
              if (!hit) { const e = new Error("NotFound") as Error & { code: number }; e.code = 404; throw e; }
              return { resource: hit };
            },
          }),
          items: {
            query: (spec: { parameters?: { name: string; value: unknown }[] }) => ({
              fetchAll: async () => {
                fallbackQueries++;
                const wantId = spec.parameters?.find((p) => p.name === "@id")?.value;
                return { resources: store.all().filter((r) => r.id === wantId).slice(0, 1) };
              },
            }),
            upsert: async (row: FakeRow) => { store.put(row); return { resource: row }; },
          },
        }),
      };
    }
  },
}));

// Imported AFTER the mock is declared so the service's CosmosClient is the fake.
const { upsertCatalogEntry, mergeCatalogEntries } = await import(
  "../src/services/portfolioiq/cardCatalog.service"
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildParentRow, parentDisplayName, writeParent, chooseTemplate, PARENT_SOURCE,
} = require("../scripts/materialize-ungraded-parents.cjs");

// The script's OWN call site. Tests drive this rather than calling
// upsertCatalogEntry themselves, so a mutation to how the script writes -- e.g.
// reintroducing `{ known: null }` -- turns this suite red instead of sailing
// past it, which is exactly what happened last time.
const writeViaScript = (row: unknown) => writeParent(upsertCatalogEntry, row);

const PARENT = "hiq:basketball:1993:topps-finest:110:base:no-auto";

const child = (over: Record<string, unknown> = {}) => ({
  id: "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10",
  cardId: "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10",
  hobbyiqCardId: "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10",
  parentSlug: PARENT,
  sport: "basketball",
  year: 1993,
  setKey: "topps-finest",
  // The shape prod actually carries: setName ALREADY embeds the year and the
  // sport. A clean "Topps Finest" here is what let the first version of this
  // suite pass while the dry run minted "1993 1993 Topps Finest Basketball ...".
  setName: "1993 Topps Finest Basketball",
  cardNumber: "110",
  parallel: "Base",
  isAuto: false,
  printRun: null,
  playerName: "Michael Jordan",
  // The shape prod actually carries: the child's name ENDS IN ITS GRADE, and
  // is independently malformed (doubled year, sport interpolated).
  displayName: "1993 1993 Topps Finest Basketball Michael Jordan #110 PSA 10",
  subsetName: "Main Set",
  imageUrl: "https://example.test/110.jpg",
  gradeCompany: "PSA",
  gradeValue: 10,
  gradeQualifier: null,
  gradeTier: "psa-10",
  gradedIdentitySource: "sold_comps",
  observedCompCount: 1,
  source: "ingest-auto-seed-graded",
  confidence: 0.85,
  verificationStatus: "verified",
  searchTokens: ["jordan", "topps-finest", "psa-10", "psa", "10"],
  vendorIds: {},
  _rid: "x", _self: "y", _etag: "z", _ts: 1,
  ...over,
});

beforeEach(() => { store.reset(); pointReads = 0; fallbackQueries = 0; });

describe("the parent is the child minus its grade", () => {
  it("mints the parent at the parent slug", () => {
    const row = buildParentRow(child(), PARENT);
    expect(row.id).toBe(PARENT);
    expect(row.cardId).toBe(row.id);
    expect(row.hobbyiqCardId).toBe(row.id);
  });

  it("carries the identity fields the checklist knew", () => {
    // The graded builder once hand-listed fields and silently dropped
    // subsetName/imageUrl from every row. Spread, don't list.
    const row = buildParentRow(child(), PARENT);
    expect(row.playerName).toBe("Michael Jordan");
    expect(row.subsetName).toBe("Main Set");
    expect(row.imageUrl).toBe("https://example.test/110.jpg");
    expect(row.cardNumber).toBe("110");
    expect(row.parallel).toBe("Base");
  });

  it("drops every trace of the grade dimension", () => {
    const row = buildParentRow(child(), PARENT);
    for (const k of ["gradeCompany", "gradeValue", "gradeQualifier", "gradeTier", "parentSlug"]) {
      expect(row[k], `${k} must not survive onto an ungraded parent`).toBeUndefined();
    }
  });

  it("strips grade tokens from searchTokens so the parent is not findable as a graded card", () => {
    const row = buildParentRow(child(), PARENT);
    expect(row.searchTokens).toContain("jordan");
    expect(row.searchTokens).not.toContain("psa-10");
    expect(row.searchTokens).not.toContain("psa");
  });

  it("does not inherit the child's Cosmos metadata", () => {
    const row = buildParentRow(child(), PARENT);
    for (const k of ["_rid", "_self", "_etag", "_ts"]) expect(row[k]).toBeUndefined();
  });

  it("records which child attested it", () => {
    const row = buildParentRow(child(), PARENT);
    expect(row.derivedFromGradedChild).toBe("hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10");
  });

  it("refuses when the parent slug is the child's own slug", () => {
    expect(buildParentRow(child(), "hiq:basketball:1993:topps-finest:110:base:no-auto:psa-10")).toBeNull();
    expect(buildParentRow(child(), "")).toBeNull();
  });
});

describe("a parent must not be displayed as a graded card", () => {
  // BLOCKER, measured on prod: 587/587 would-be parents inherited a grade in
  // displayName. The row whose only purpose is letting a RAW holding resolve
  // would have read "... #110 PSA 10" to the person holding the raw card.
  it("never carries a grade token in displayName", () => {
    const row = buildParentRow(child(), PARENT);
    expect(row.displayName).not.toMatch(/\b(psa|bgs|sgc|cgc|hga|ags|tag|ace)\b/i);
    expect(row.displayName).not.toContain("PSA 10");
  });

  it("composes the name from the parent's own identity rather than inheriting", () => {
    const row = buildParentRow(child(), PARENT);
    expect(row.displayName).toBe("1993 Topps Finest Michael Jordan #110");
    // and specifically NOT the child's malformed inherited string
    expect(row.displayName).not.toBe(child().displayName);
  });

  it("does not restate the year or the sport that setName already carries", () => {
    // Caught by the first prod dry run, not by this suite: setName is
    // "1993 Topps Finest Basketball", so composing year + setName produced
    // "1993 1993 Topps Finest Basketball ...". The set half comes from the
    // canonical setKey instead.
    const row = buildParentRow(child(), PARENT);
    expect(row.displayName).not.toMatch(/1993\s+1993/);
    expect(row.displayName).not.toMatch(/Basketball/);
  });

  it("mints ONE spelling of the set no matter how setName was spelled", () => {
    // This one scope holds six setName spellings, down to a bare "Finest".
    // setKey is canonical, so every parent in a product gets the same name.
    const spellings = [
      "1993 Topps Finest Baseball", "1993 topps-finest Baseball",
      "1993 Topps Finest", "1993 finest Baseball", "Finest", undefined,
    ];
    const names = spellings.map((setName) => parentDisplayName(child({ setName })));
    expect(new Set(names).size, "one product must yield one set name").toBe(1);
    expect(names[0]).toBe("1993 Topps Finest Michael Jordan #110");
  });

  it("does not reproduce the doubled year the inherited names carry", () => {
    const row = buildParentRow(child(), PARENT);
    expect(row.displayName).not.toMatch(/1993\s+1993/);
  });

  it("names a real parallel but not 'Base', which is the absence of one", () => {
    expect(parentDisplayName(child({ parallel: "Refractor" }))).toContain("Refractor");
    expect(parentDisplayName(child({ parallel: "Base" }))).not.toMatch(/\bBase\b/);
  });

  it("omits what it does not know instead of inventing it", () => {
    // CF-EVERY-INGEST-USES-THE-ONE-CHECKLIST-FORMAT: blank means unknown.
    const name = parentDisplayName(child({ playerName: "", cardNumber: "" }));
    expect(name).toBe("1993 Topps Finest");
    expect(name).not.toMatch(/undefined|null|Base|#\s*$/);
  });

  it("MUTATION GUARD: strips the inherited name even when nothing composable remains", () => {
    // The composed name is spread AFTER ...rest, so while composition succeeds
    // it masks the inherited value and removing the strip changes nothing. The
    // strip only proves itself here: when year/set/player/number are all
    // unknown, composition returns undefined, and WITHOUT the explicit strip
    // the child's "... PSA 10" rides through ...rest onto the parent.
    const row = buildParentRow(
      {
        hobbyiqCardId: "hiq:x:0:s:1:base:no-auto:psa-10",
        displayName: "1993 Topps Finest Michael Jordan #110 PSA 10",
        gradeTier: "psa-10",
      },
      "hiq:x:0:s:1:base:no-auto",
    );
    expect(row.displayName, "an uncomposable parent must have NO name, not the child's graded one")
      .toBeUndefined();
  });

  it("carries auto and print run, which are identity and not grade", () => {
    const name = parentDisplayName(child({ isAuto: true, printRun: 50, parallel: "Gold" }));
    expect(name).toContain("Gold");
    expect(name).toContain("Auto");
    expect(name).toContain("/50");
  });
});

describe("the child's own observations do not become the parent's", () => {
  // BLOCKER: both leaked through the ...rest spread onto 587/587 rows.
  it("does not inherit gradedIdentitySource — the parent has no tier to attest", () => {
    expect(buildParentRow(child(), PARENT).gradedIdentitySource).toBeUndefined();
  });

  it("does not inherit observedCompCount — the parent observed none of them", () => {
    expect(buildParentRow(child(), PARENT).observedCompCount).toBeUndefined();
  });
});

describe("the source classifies DERIVED, and that is load-bearing", () => {
  it("is derived — not unknown", () => {
    // The whole reason the name extends `ingest-auto-seed`: catalogAuthorityOf
    // matches DERIVED by prefix, so a plain descriptive name falls through to
    // `unknown`, which ranks BELOW derived and is skipped by isDerived sweeps.
    expect(catalogAuthorityOf(PARENT_SOURCE)).toBe("derived");
    expect(isDerived(PARENT_SOURCE)).toBe(true);
  });

  it("guards the naming trap that would have shipped", () => {
    // Pinned as a decision on record: this is why the source is not called
    // `graded-attested`. The prod rows named `sales-attested` show the same bug.
    expect(catalogAuthorityOf("graded-attested")).toBe("unknown");
    expect(catalogAuthorityOf("sales-attested")).toBe("unknown");
    expect(authorityRank(PARENT_SOURCE)).toBeGreaterThan(authorityRank("graded-attested"));
  });

  it("can never adjudicate a setKey, and is never VERIFIED-able by provenance", () => {
    expect(canAdjudicate(PARENT_SOURCE)).toBe(false);
    expect(catalogAuthorityOf(PARENT_SOURCE)).not.toBe("checklist");
    const row = buildParentRow(child(), PARENT);
    // Even though the CHILD was stamped "verified", the parent is not.
    expect(row.verificationStatus).toBe("provisional");
    expect(row.source).toBe(PARENT_SOURCE);
  });
});

describe("an existing row is never overwritten — THROUGH THE PRODUCTION WRITE PATH", () => {
  // Every test here calls upsertCatalogEntry the way the script calls it: with
  // NO `known` override. That is the point. Passing { known: null } -- what the
  // script used to do -- makes all of these pass vacuously while the row is
  // blind-upserted, which is exactly the defect this suite failed to catch.

  it("does not overwrite an existing CHECKLIST row, even at higher confidence", async () => {
    store.put({
      id: PARENT, cardId: PARENT, source: "checklistcenter", confidence: 0.4,
      playerName: "Michael Jordan", displayName: "checklist name", vendorIds: {},
    });
    const incoming = buildParentRow(child(), PARENT);
    incoming.confidence = 0.99;

    await writeViaScript(incoming);

    const after = store.docs.get(`${PARENT} ${PARENT}`)!;
    expect(after.source, "a derived parent must never outvote a checklist row").toBe("checklistcenter");
    expect(after.displayName).toBe("checklist name");
  });

  it("does not overwrite an existing derived row it cannot outrank on confidence", async () => {
    store.put({
      id: PARENT, cardId: PARENT, source: "ingest-auto-seed", confidence: 0.85,
      playerName: "Michael Jordan", vendorIds: {},
    });
    await writeViaScript(buildParentRow(child(), PARENT));
    expect(store.docs.get(`${PARENT} ${PARENT}`)!.source).toBe("ingest-auto-seed");
  });

  it("MUTATION GUARD: finds an existing row hiding under a FOREIGN partition key", async () => {
    // This is the test that fails if the guard is weakened back to a bare
    // point-read. The row is stored under a foreign partition key, so
    // (id, id) misses it; only getCatalogEntry's cross-partition fallback --
    // which runs ONLY because we pass no `known` -- can see it.
    store.put(
      { id: PARENT, cardId: "some-vendor-bubble-id", source: "checklistcenter", confidence: 0.4, vendorIds: {} },
      "some-vendor-bubble-id",
    );

    await writeViaScript(buildParentRow(child(), PARENT));

    expect(fallbackQueries, "the cross-partition fallback must actually run").toBeGreaterThan(0);
    const survivors = store.all().filter((r) => r.id === PARENT);
    expect(survivors.every((r) => r.source === "checklistcenter"),
      "a partition-shadowed checklist row must still win").toBe(true);
  });

  it("MUTATION GUARD: the write path really does read before it writes", async () => {
    // Pins the mechanism itself. If someone reintroduces `{ known: null }`,
    // no read happens at all and this drops to zero.
    store.put({ id: PARENT, cardId: PARENT, source: "checklistcenter", confidence: 0.4, vendorIds: {} });
    await writeViaScript(buildParentRow(child(), PARENT));
    expect(pointReads + fallbackQueries,
      "upsertCatalogEntry must look for an existing row before writing").toBeGreaterThan(0);
  });

  it("REGRESSION: { known: null } blind-upserts — proving why the script must not pass it", async () => {
    // Documents the defect rather than trusting a comment. This is the shipped
    // behaviour the script used to rely on for its safety claim.
    store.put({ id: PARENT, cardId: PARENT, source: "checklistcenter", confidence: 0.4, vendorIds: {} });
    await upsertCatalogEntry(buildParentRow(child(), PARENT), { known: null });
    expect(store.docs.get(`${PARENT} ${PARENT}`)!.source,
      "with known:null the authority ranking never runs and the checklist row is lost",
    ).toBe(PARENT_SOURCE);
  });

  it("writes the parent when nothing is there — the job still does its job", async () => {
    const outcome = await writeViaScript(buildParentRow(child(), PARENT));
    expect(outcome).toBe("minted");
    const after = store.docs.get(`${PARENT} ${PARENT}`)!;
    expect(after.id).toBe(PARENT);
    expect(after.displayName).toBe("1993 Topps Finest Michael Jordan #110");
  });

  it("reports a losing write as 'raced', never as a mint", async () => {
    // The counters have to be honest about this: a call that returned is not a
    // row that was created. If a race were counted as minted, reconcileWrites
    // would balance on work that never happened.
    store.put({ id: PARENT, cardId: PARENT, source: "checklistcenter", confidence: 0.4, vendorIds: {} });
    expect(await writeViaScript(buildParentRow(child(), PARENT))).toBe("raced");
  });

  it("is idempotent: a second run neither duplicates nor mutates", async () => {
    await writeViaScript(buildParentRow(child(), PARENT));
    const first = { ...store.docs.get(`${PARENT} ${PARENT}`)! };
    await writeViaScript(buildParentRow(child(), PARENT));
    const rows = store.all().filter((r) => r.id === PARENT);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe(first.source);
    expect(rows[0].displayName).toBe(first.displayName);
  });

  it("still ranks correctly at the merge level (unit view of the same rule)", () => {
    const incoming = buildParentRow(child(), PARENT);
    incoming.confidence = 0.99;
    const existing = {
      id: PARENT, source: "beckett-scraped-2026-08-19", confidence: 0.5,
      playerName: "Michael Jordan", vendorIds: {},
    } as never;
    const { merged, winnerIsIncoming } = mergeCatalogEntries(incoming as never, existing, new Date().toISOString());
    expect(winnerIsIncoming).toBe(false);
    expect((merged as { source: string }).source).toBe("beckett-scraped-2026-08-19");
  });
});

describe("the template child is chosen deterministically", () => {
  // BLOCKER: "first child wins" made the template a function of Cosmos page
  // order. This drives the SCRIPT'S chooseTemplate -- reducing exactly as
  // main() does -- rather than reimplementing the rule in the test.
  const pick = (children: { hobbyiqCardId: string }[]) =>
    children.reduce<{ hobbyiqCardId: string } | undefined>(
      (acc, r) => chooseTemplate(acc, r), undefined,
    )!.hobbyiqCardId;

  it("picks the same child regardless of the order the pages arrived in", () => {
    const kids = [
      { hobbyiqCardId: `${PARENT}:psa-9` },
      { hobbyiqCardId: `${PARENT}:psa-10` },
      { hobbyiqCardId: `${PARENT}:psa-7` },
    ];
    const forward = pick(kids);
    const reversed = pick([...kids].reverse());
    expect(forward).toBe(reversed);
    expect(forward).toBe(`${PARENT}:psa-10`);   // lowest slug, lexicographically
  });

  it("is stable across every ordering of the same children", () => {
    const kids = [
      { hobbyiqCardId: `${PARENT}:psa-8` },
      { hobbyiqCardId: `${PARENT}:psa-10` },
      { hobbyiqCardId: `${PARENT}:bgs-9-5` },
    ];
    const orderings = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ].map((o) => pick(o.map((i) => kids[i])));
    expect(new Set(orderings).size, "one identity must yield one template").toBe(1);
    expect(orderings[0]).toBe(`${PARENT}:bgs-9-5`);
  });

  it("falls back to id when a child carries no hobbyiqCardId", () => {
    const chosen = chooseTemplate(
      { id: `${PARENT}:psa-9` }, { id: `${PARENT}:psa-10` },
    );
    expect(chosen.id).toBe(`${PARENT}:psa-10`);
  });
});

describe("the counters describe what they claim to describe", () => {
  // MAJOR: `parents already present` was computed as
  // gradedSeen - unparsable - wanted.size -- graded CHILDREN minus the missing
  // set. On prod it reported 209/280 where the truth was 3/10.
  it("counts distinct PARENTS present, not the graded children pointing at them", () => {
    const present = new Set([PARENT]);
    const rows = [
      { hobbyiqCardId: `${PARENT}:psa-7`, gradeTier: "psa-7" },
      { hobbyiqCardId: `${PARENT}:psa-9`, gradeTier: "psa-9" },
      { hobbyiqCardId: `${PARENT}:psa-10`, gradeTier: "psa-10" },
    ];
    const parentsPresent = new Set<string>();
    const wanted = new Map<string, unknown>();
    let gradedSeen = 0; const unparsable = 0;
    for (const r of rows) {
      gradedSeen++;
      const p = cardIdentityKey(r as never)!;
      if (present.has(p)) { parentsPresent.add(p); continue; }
      wanted.set(p, r);
    }
    // Three graded children, ONE parent. The old formula said 3.
    expect(parentsPresent.size).toBe(1);
    expect(gradedSeen - unparsable - wanted.size).toBe(3);
    expect(parentsPresent.size).not.toBe(gradedSeen - unparsable - wanted.size);
  });

  it("reconciles honestly when a budget stop cuts the run short", async () => {
    const { reconcileWrites } = await import("../src/services/ops/writeReconciliation");
    // 500 parents in scope, the loop stopped after attempting 100 and writing
    // all 100. Counting intent pre-loop (500) invents a 400-row shortfall.
    expect(reconcileWrites({ job: "t", intended: 500, written: 100 }).ok).toBe(false);
    expect(reconcileWrites({ job: "t", intended: 100, written: 100 }).ok).toBe(true);
  });
});

describe("the grade suffix is parsed by the canonical parser", () => {
  it("matches the graded-identity convention: parent + ':' + tier", () => {
    expect(cardIdentityKey({ hobbyiqCardId: "hiq:baseball:2026:bowman:bp-102:base:no-auto:psa-9-5" } as never))
      .toBe("hiq:baseball:2026:bowman:bp-102:base:no-auto");
    expect(cardIdentityKey({ hobbyiqCardId: `${PARENT}:psa-10` } as never)).toBe(PARENT);
  });

  it("does NOT mistake a card number beginning psa- for a grade", () => {
    // The 221-false-positive trap: `psa-th2` is a CARD NUMBER in segment 4.
    // A non-positional regex would strip it and mint a garbage parent.
    const slug = "hiq:football:2024:bowman:psa-th2:sky-blue:no-auto:num-499";
    expect(cardIdentityKey({ hobbyiqCardId: slug } as never)).toBe(slug);
  });

  it("preserves a print run — that is identity, not grade", () => {
    const slug = "hiq:baseball:2026:bowman:bp-102:gold:no-auto:num-50";
    expect(cardIdentityKey({ hobbyiqCardId: slug } as never)).toBe(slug);
  });
});
