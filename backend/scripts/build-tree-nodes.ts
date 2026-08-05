#!/usr/bin/env -S npx tsx
/**
 * CF-TREE-BUILDER (Drew, 2026-08-05).
 *
 * Builds Card → Variant → Grade tree nodes in `card_catalog`.
 *
 * For each unique (year, setKey, cardNumber) in the baseball pool:
 *   1. Upsert one Card doc.
 *   2. For each BCCP checklist parallel that applies, upsert a Variant doc.
 *   3. For each observed (gradeCompany, gradeValue) in sold_comps for
 *      that card's slug family, upsert a Grade doc.
 *
 * All three doc types share the same partition key (cardId = the root
 * card's canonical id), so a card-panel read hits one partition.
 *
 * Existing card_catalog rows are NOT touched — this is additive.
 *
 * Modes:
 *   DRY RUN (default)  — enumerates the work, writes nothing
 *   APPLY (opt-in)     — TREE_APPLY=true actually upserts
 *
 * Scope:
 *   TREE_YEAR=YYYY     — only that year
 *   TREE_SPORT=x       — default: baseball
 *   MAX_CARDS=N        — cap for a slice test
 *
 * Documentation: backend/docs/tree-schema.md
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import { readFileSync, existsSync } from "fs";

const APPLY = process.env.TREE_APPLY === "true";
const TREE_YEAR = process.env.TREE_YEAR ? Number(process.env.TREE_YEAR) : null;
const TREE_SPORT = process.env.TREE_SPORT || "baseball";
const MAX_CARDS = process.env.MAX_CARDS ? Number(process.env.MAX_CARDS) : 0;
const BCCP_ROOT = process.env.BCCP_ROOT || "c:/tmp/bccp";

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
const client = new CosmosClient(conn);
const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
const catalog = db.container("card_catalog");
const soldComps = db.container("sold_comps");

function slug(s: string | null | undefined): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Normalize BCCP parallel names — strip parenthetical serial-numbered
// hints, singularize the known plural roots, keep everything else.
const PLURAL_ROOTS = ["refractor", "prizm", "auto", "autograph", "mojo", "foil", "shimmer", "wave"];
function normalizeParallelName(raw: string): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/\((?:serial-?numbered[^)]+|one-of-one|1\/1|[^)]*of[^)]+)\)/gi, "").trim();
  s = s.replace(/\s+/g, " ");
  const parts = s.split(" ").map((w) => {
    const lower = w.toLowerCase();
    for (const root of PLURAL_ROOTS) if (lower === root + "s") return w.slice(0, -1);
    return w;
  });
  return parts.join(" ");
}

interface CardIdentity {
  sport: string;
  year: number;
  setKey: string;
  cardNumber: string;
  playerName: string | null;
  brand: string | null;
  parentSetKey: string | null;
  rookie: boolean;
}

interface VariantSpec {
  parallel: string;
  parallelSlug: string;
  isAuto: boolean;
  printRun: number | null;
  distribution: string | null;
  source: "bccp" | "clc" | "pool" | "holding-only";
}

function cardIdOf(c: CardIdentity): string {
  return `hiq:${c.sport}:${c.year}:${c.setKey}:${c.cardNumber.toLowerCase()}`;
}

function variantIdOf(c: CardIdentity, v: VariantSpec): string {
  const parts = [
    "hiq", c.sport, String(c.year), c.setKey, c.cardNumber.toLowerCase(),
    v.parallelSlug, v.isAuto ? "auto" : "no-auto",
  ];
  if (v.printRun) parts.push(`num-${v.printRun}`);
  return parts.join(":");
}

function gradeIdOf(variantSlug: string, gradeCompany: string | null, gradeValue: number | null): string {
  const g = gradeCompany
    ? `${gradeCompany.toLowerCase()}${String(gradeValue ?? "").replace(".", "-")}`
    : "raw";
  return `${variantSlug}:${g}`;
}

interface BccpProduct {
  parallels?: Array<{ section: string; name: string; printRun: number | null }>;
}

const bccpCache = new Map<string, BccpProduct | null>();
function loadBccpProduct(year: number, setKey: string): BccpProduct | null {
  const key = `${year}::${setKey}`;
  if (bccpCache.has(key)) return bccpCache.get(key) ?? null;
  const candidates = [
    `${BCCP_ROOT}/${year}/${year}-${setKey}.json`,
    `${BCCP_ROOT}/${year}/${year}-${setKey.replace(/-/g, " ")}.json`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const doc = JSON.parse(readFileSync(p, "utf8")) as BccpProduct;
        bccpCache.set(key, doc);
        return doc;
      } catch { /* fall through */ }
    }
  }
  bccpCache.set(key, null);
  return null;
}

function collectVariantsFromBccp(bccp: BccpProduct): VariantSpec[] {
  const seen = new Set<string>();
  const out: VariantSpec[] = [
    { parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null, distribution: null, source: "bccp" },
  ];
  seen.add("base:no-auto");
  for (const p of bccp.parallels ?? []) {
    if (p.section !== "(root)") continue;
    const normalized = normalizeParallelName(p.name);
    const parallelSlug = slug(normalized);
    const key = `${parallelSlug}:no-auto${p.printRun ? ":num-" + p.printRun : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      parallel: normalized,
      parallelSlug,
      isAuto: false,
      printRun: p.printRun ?? null,
      distribution: null,
      source: "bccp",
    });
  }
  return out;
}

interface CardCounts { cards: number; variants: number; grades: number; }

async function enumerateBaseballCards(year: number | null, sport: string, cap: number): Promise<CardIdentity[]> {
  const yearClause = year ? " AND c.year = @year" : "";
  const params = year ? [{ name: "@year", value: year }, { name: "@sport", value: sport }] : [{ name: "@sport", value: sport }];
  const query = `SELECT DISTINCT c.year, c.setKey, c.cardNumber, c.playerName, c.brand, c.parentSetKey, c.rookie
                 FROM c WHERE c.sport = @sport
                   AND c.source = "bulk-build-from-pool"
                   AND IS_DEFINED(c.cardNumber) AND c.cardNumber != null AND c.cardNumber != ""${yearClause}`;
  const it = catalog.items.query<{
    year: number; setKey: string; cardNumber: string; playerName?: string | null;
    brand?: string | null; parentSetKey?: string | null; rookie?: boolean;
  }>({ query, parameters: params }, { maxItemCount: 500 });
  const dedup = new Map<string, CardIdentity>();
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      const c: CardIdentity = {
        sport, year: r.year, setKey: r.setKey, cardNumber: String(r.cardNumber),
        playerName: r.playerName ?? null,
        brand: r.brand ?? null,
        parentSetKey: r.parentSetKey ?? null,
        rookie: r.rookie === true,
      };
      const key = cardIdOf(c);
      if (!dedup.has(key)) dedup.set(key, c);
      if (cap && dedup.size >= cap) return [...dedup.values()];
    }
    process.stderr.write(`  scan ${dedup.size} cards\r`);
  }
  process.stderr.write("\n");
  return [...dedup.values()];
}

async function observeGradesForVariant(card: CardIdentity, variantSlug: string): Promise<Array<{
  gradeCompany: string | null; gradeValue: number | null; n: number;
}>> {
  const { resources } = await soldComps.items.query({
    query: `SELECT c.gradeCompany, c.gradeValue, COUNT(1) AS n
            FROM c WHERE c.hobbyiqCardId = @slug
              AND c.price > 0
            GROUP BY c.gradeCompany, c.gradeValue`,
    parameters: [{ name: "@slug", value: variantSlug }],
  }, { maxItemCount: 200 }).fetchAll();
  const merged = new Map<string, { gradeCompany: string | null; gradeValue: number | null; n: number }>();
  for (const r of resources as Array<{ gradeCompany: string | null; gradeValue: number | string | null; n: number }>) {
    const gv = r.gradeValue == null ? null : Number(r.gradeValue);
    const key = r.gradeCompany ? `${r.gradeCompany.toUpperCase()}::${gv}` : "raw";
    const acc = merged.get(key);
    if (acc) acc.n += r.n;
    else merged.set(key, { gradeCompany: r.gradeCompany ? r.gradeCompany.toUpperCase() : null, gradeValue: gv, n: r.n });
  }
  return [...merged.values()];
}

async function upsertMany(docs: Record<string, unknown>[]): Promise<{ ok: number; err: number }> {
  if (!APPLY) return { ok: docs.length, err: 0 };
  const byPk = new Map<string, Record<string, unknown>[]>();
  for (const d of docs) {
    const pk = String(d.cardId);
    let arr = byPk.get(pk);
    if (!arr) { arr = []; byPk.set(pk, arr); }
    arr.push(d);
  }
  let ok = 0, err = 0;
  for (const [pk, arr] of byPk) {
    for (let i = 0; i < arr.length; i += 50) {
      const chunk = arr.slice(i, i + 50);
      const ops = chunk.map((d) => ({ operationType: "Upsert" as const, partitionKey: pk, resourceBody: d }));
      try {
        const results = await catalog.items.bulk(ops as never);
        for (const r of results) {
          if (r.statusCode >= 200 && r.statusCode < 300) ok++;
          else err++;
        }
      } catch { err += chunk.length; }
    }
  }
  return { ok, err };
}

async function main(): Promise<void> {
  console.log(`▸ Tree builder — sport=${TREE_SPORT}${TREE_YEAR ? ` year=${TREE_YEAR}` : ""} ${APPLY ? "APPLY" : "DRY-RUN"}`);
  const cards = await enumerateBaseballCards(TREE_YEAR, TREE_SPORT, MAX_CARDS);
  console.log(`  enumerated: ${cards.length.toLocaleString()} unique cards`);
  if (cards.length === 0) { console.log("  nothing to do"); return; }

  const counts: CardCounts = { cards: 0, variants: 0, grades: 0 };
  const now = new Date().toISOString();
  let processed = 0;
  const startedAt = Date.now();

  for (const card of cards) {
    processed++;
    const cardCanonicalId = cardIdOf(card);
    const cardDocId = `card::${cardCanonicalId}`;

    const cardDoc = {
      id: cardDocId,
      cardId: cardCanonicalId,
      kind: "card",
      parentId: null,
      canonicalCardId: cardCanonicalId,
      sport: card.sport,
      year: card.year,
      setKey: card.setKey,
      cardNumber: card.cardNumber,
      playerName: card.playerName,
      brand: card.brand,
      parentSetKey: card.parentSetKey,
      rookie: card.rookie,
      source: "tree-builder-v1",
      builtAt: now,
    };

    // Variant enumeration: BCCP for the year+setKey if available, else
    // just Base as a fallback.
    const bccp = loadBccpProduct(card.year, card.setKey);
    const variantSpecs: VariantSpec[] = bccp
      ? collectVariantsFromBccp(bccp)
      : [{ parallel: "Base", parallelSlug: "base", isAuto: false, printRun: null, distribution: null, source: "pool" }];

    const variantDocs: Record<string, unknown>[] = [];
    const gradeDocs: Record<string, unknown>[] = [];

    for (const v of variantSpecs) {
      const variantSlug = variantIdOf(card, v);
      const variantDocId = `variant::${variantSlug}`;
      variantDocs.push({
        id: variantDocId,
        cardId: cardCanonicalId,
        kind: "variant",
        parentId: cardDocId,
        canonicalCardId: cardCanonicalId,
        variantSlug,
        parallel: v.parallel,
        parallelSlug: v.parallelSlug,
        isAuto: v.isAuto,
        printRun: v.printRun,
        distribution: v.distribution,
        source: v.source,
        builtAt: now,
      });
      const grades = await observeGradesForVariant(card, variantSlug);
      for (const g of grades) {
        const gradeSlug = gradeIdOf(variantSlug, g.gradeCompany, g.gradeValue);
        const gradeDocId = `grade::${gradeSlug}`;
        gradeDocs.push({
          id: gradeDocId,
          cardId: cardCanonicalId,
          kind: "grade",
          parentId: variantDocId,
          canonicalCardId: cardCanonicalId,
          variantSlug,
          gradeSlug,
          gradeCompany: g.gradeCompany,
          gradeValue: g.gradeValue,
          gradeLabel: g.gradeCompany ? `${g.gradeCompany} ${g.gradeValue ?? "?"}` : "Raw",
          materializedAt: now,
          observedSalesAtBuild: g.n,
        });
      }
    }

    counts.cards++;
    counts.variants += variantDocs.length;
    counts.grades += gradeDocs.length;

    const { err } = await upsertMany([cardDoc, ...variantDocs, ...gradeDocs]);
    if (err > 0) console.error(`  ! ${err} upsert errors on ${card.year} ${card.setKey} #${card.cardNumber}`);

    if (processed % 100 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const rate = Math.round(processed / Math.max(1, elapsed));
      process.stderr.write(`  ${processed}/${cards.length} cards · ${counts.variants} variants · ${counts.grades} grades · ${rate} card/s\r`);
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n\n▸ Done in ${elapsed}s`);
  console.log(`  Card docs:    ${counts.cards.toLocaleString()}`);
  console.log(`  Variant docs: ${counts.variants.toLocaleString()}`);
  console.log(`  Grade docs:   ${counts.grades.toLocaleString()}`);
  console.log(`  ${APPLY ? "UPSERTED to card_catalog" : "DRY-RUN, nothing written"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
