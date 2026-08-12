// CF-CHECKLIST-NARROW-SCHEMA-FIX (Drew, 2026-08-12). Pins card_catalog
// query text against the real row schema.
//
// The bug this guards: checklistNarrow queried `c.player`, `c.number`,
// `c.releaseName` and `c.setName` — none of which exist on a card_catalog
// row — and compared `c.year` (a NUMBER) against a STRING. Cosmos does not
// error on either mistake. It returns zero rows, which is indistinguishable
// from "no match", so the query looked like it worked while resolving
// nothing for ten days and burning ~145k RU/s on cross-partition scans.
//
// Unit tests with hand-made fixtures cannot catch this: a fixture written
// from the same wrong mental model matches the wrong query perfectly. The
// only thing that catches it is checking the query against the SCHEMA.
//
// So: extract every `c.<field>` reference from the SQL in the ingest path
// and assert each one is a field card_catalog actually has.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const SRC = resolve(__dirname, "..", "src");

/** Fields observed on real card_catalog rows + declared on CardCatalogEntry.
 *  Verified 2026-08-12 against a live row:
 *    { year: 2025, cardYear: 2025, playerName: "Noah Cameron",
 *      cardNumber: "67", source: "cardhedge", sport: "baseball" }
 *  Add to this list only after confirming the field exists on real rows —
 *  not because a query wants it to. */
const CARD_CATALOG_FIELDS = new Set([
  "id", "cardId", "hobbyiqCardId", "sport", "year", "cardYear", "setKey",
  "cardNumber", "parallel", "parallelSlug", "isAuto", "printRun",
  "playerName", "playerSlug", "vendorIds", "referenceImage", "source",
  "confidence", "observedAt", "lastSeenAt", "compCount", "searchText",
  "verificationStatus", "gradeTier", "salesSummary", "imageUrl",
]);

/** Field names that LOOK plausible but do not exist — the exact trap. */
const KNOWN_PHANTOM_FIELDS = ["player", "number", "releaseName", "setName", "parallels"];

/** Pull the SQL string out of every `query: "..."` literal in a file. */
function extractQueries(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /query:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function fieldsReferenced(sql: string): string[] {
  const out = new Set<string>();
  const re = /\bc\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.add(m[1]);
  return [...out];
}

const PERSIST = resolve(SRC, "services/portfolioiq/persistVendorSalesToPool.service.ts");

/** Files whose ONLY container is card_catalog — every `FROM c` is a catalog
 *  query, so the whole file can be schema-checked. */
const CATALOG_ONLY_FILES = [
  resolve(SRC, "services/catalog/catalogVerify.service.ts"),
  resolve(SRC, "services/catalog/resolveSetKey.service.ts"),
];

/** persistVendorSalesToPool queries BOTH card_catalog and sold_comps, and the
 *  SQL does not name its container. The catalog queries are the ones filtering
 *  on the catalog's `source` enum — sold_comps rows have no such column. */
function isCatalogQuery(sql: string): boolean {
  return /c\.source\s+IN\s*\(/i.test(sql);
}

describe("card_catalog queries match the real row schema", () => {
  for (const file of [...CATALOG_ONLY_FILES, PERSIST]) {
    const short = file.split(/[\\/]/).slice(-1)[0];
    const catalogOnly = CATALOG_ONLY_FILES.includes(file);

    it(`${short}: every c.<field> exists on card_catalog`, () => {
      const queries = extractQueries(file)
        .filter((q) => /FROM c/i.test(q))
        .filter((q) => (catalogOnly ? true : isCatalogQuery(q)));
      expect(queries.length, `${short} should contain at least one catalog query`).toBeGreaterThan(0);

      const unknown: string[] = [];
      for (const sql of queries) {
        for (const f of fieldsReferenced(sql)) {
          if (!CARD_CATALOG_FIELDS.has(f)) unknown.push(`${f}  (in: ${sql.slice(0, 90)}…)`);
        }
      }
      expect(unknown, `unknown card_catalog fields in ${short}`).toEqual([]);
    });

    it(`${short}: references none of the known phantom fields`, () => {
      const sqlAll = extractQueries(file).join(" ");
      const found = KNOWN_PHANTOM_FIELDS.filter((f) => new RegExp(`\\bc\\.${f}\\b`).test(sqlAll));
      expect(found, `phantom fields resurfaced in ${short}`).toEqual([]);
    });
  }

  it("compares year numerically, never as a string", () => {
    const file = resolve(SRC, "services/portfolioiq/persistVendorSalesToPool.service.ts");
    const src = readFileSync(file, "utf8");

    // `year` is stored as a NUMBER. Cosmos '=' is type-strict, so binding a
    // string silently matches nothing.
    expect(src).not.toMatch(/name:\s*"@y"\s*,\s*value:\s*String\(/);
    expect(src).toMatch(/name:\s*"@y"\s*,\s*value:\s*Number\(/);
  });

  it("bounds the cross-partition catalog scans with TOP", () => {
    // Only the card_catalog scans — sold_comps queries are partition-scoped
    // by cardId and are not the RU problem.
    const queries = extractQueries(PERSIST).filter(isCatalogQuery);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q, `unbounded catalog scan: ${q.slice(0, 80)}…`).toMatch(/SELECT\s+TOP\s+\d+/i);
    }
  });
});
