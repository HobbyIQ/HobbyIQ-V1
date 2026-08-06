#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-PHOTOS (Drew, 2026-08-06).
 *
 * Attaches an imageUrl to card_catalog card + variant tree nodes by
 * mining representative photos from sold_comps. Search UIs today render
 * a placeholder for tree nodes because tokens were built from CH catalog
 * metadata, which doesn't ship images.
 *
 * Selection policy:
 *   1. Prefer TCA sale rows over CardHedge (better quality, current
 *      source of record).
 *   2. Prefer imageUrl on the row that matches the exact variant
 *      (parallelSlug === variant.parallelSlug) when patching a variant
 *      node; otherwise any sale for the slug is fine for the card node.
 *   3. Upgrade eBay thumbnail URLs (/s-l140.webp) to /s-l1600.jpg so
 *      the stored URL survives at print-quality later.
 *   4. Only patch nodes that don't already have imageUrl set.
 *
 * Env:
 *   PHOTO_APPLY   true = write; default dry-run
 *   PHOTO_KINDS   default "card,variant"
 *   PHOTO_MAX     default 0 (unbounded)
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.PHOTO_APPLY === "true";
const KINDS = (process.env.PHOTO_KINDS ?? "card,variant").split(",").map((s) => s.trim()).filter(Boolean);
const MAX = Number(process.env.PHOTO_MAX ?? 0);

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const db = new CosmosClient(conn).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
const catalog: Container = db.container("card_catalog");
const sc: Container = db.container("sold_comps");

interface Node {
  id: string;
  cardId: string;
  kind: string;
  hobbyiqCardId?: string | null;
  parallelSlug?: string | null;
  imageUrl?: string | null;
}

interface Sale {
  imageUrl?: string | null;
  source?: string | null;
  soldAt?: string | null;
  parallelSlug?: string | null;
}

function upgradeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  return String(u)
    .replace(/\/s-l\d+\.webp$/i, "/s-l1600.jpg")
    .replace(/\/s-l\d+\.jpg$/i, "/s-l1600.jpg");
}

function scoreSale(sale: Sale, wantParallel: string | null): number {
  let s = 0;
  if (String(sale.source ?? "").startsWith("tca")) s += 10;
  if (wantParallel && sale.parallelSlug === wantParallel) s += 5;
  if (sale.imageUrl) s += 1;
  return s;
}

/** Exact hobbyiqCardId match — used for variants where the stripped
 *  variant slug matches sold_comps rows directly. */
async function pickImageExact(slug: string): Promise<string | null> {
  const { resources } = await sc.items.query<Sale>({
    query: `SELECT TOP 20 c.imageUrl, c.source, c.soldAt, c.parallelSlug
            FROM c WHERE c.hobbyiqCardId = @s AND IS_DEFINED(c.imageUrl) AND c.imageUrl != null
            ORDER BY c.soldAt DESC`,
    parameters: [{ name: "@s", value: slug }],
  }).fetchAll();
  if (resources.length === 0) return null;
  resources.sort((a, b) => scoreSale(b, null) - scoreSale(a, null));
  return upgradeUrl(resources[0].imageUrl ?? null);
}

/** STARTSWITH match — used for card kind nodes where sold_comps
 *  hobbyiqCardIds are fully-decorated child slugs like `<cardId>:...`.
 *  Prefers TCA + base parallel (parallelSlug='base') where present. */
async function pickImageAnyChild(cardRoot: string): Promise<string | null> {
  const prefix = cardRoot + ":";
  const { resources } = await sc.items.query<Sale>({
    query: `SELECT TOP 20 c.imageUrl, c.source, c.soldAt, c.parallelSlug
            FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p) AND IS_DEFINED(c.imageUrl) AND c.imageUrl != null
            ORDER BY c.soldAt DESC`,
    parameters: [{ name: "@p", value: prefix }],
  }).fetchAll();
  if (resources.length === 0) return null;
  resources.sort((a, b) => {
    // Prefer TCA source and base parallel
    const aBase = a.parallelSlug === "base" ? 5 : 0;
    const bBase = b.parallelSlug === "base" ? 5 : 0;
    return (scoreSale(b, null) + bBase) - (scoreSale(a, null) + aBase);
  });
  return upgradeUrl(resources[0].imageUrl ?? null);
}

async function main(): Promise<void> {
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — attach photos to kinds=${KINDS.join(",")}`);
  const kindsList = KINDS.map((_, i) => `@k${i}`).join(",");
  const params: Array<{ name: string; value: string }> = KINDS.map((k, i) => ({ name: `@k${i}`, value: k }));
  const query = `SELECT c.id, c.cardId, c.kind, c.hobbyiqCardId, c.parallelSlug, c.imageUrl
                 FROM c WHERE c.kind IN (${kindsList})
                   AND (NOT IS_DEFINED(c.imageUrl) OR c.imageUrl = null OR c.imageUrl = "")`;
  const it = catalog.items.query<Node>({ query, parameters: params }, { maxItemCount: 200 });

  let scanned = 0, hit = 0, miss = 0, patched = 0, errors = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const n of resources) {
      scanned++;
      // Two shapes to bridge:
      //   card:    id="card::hiq:sport:year:set:num", cardId="hiq:..." (root)
      //   variant: id="variant::hiq:...:parallel:autoStatus", cardId=root
      // sold_comps.hobbyiqCardId is always the fully-decorated child slug
      // (e.g. hiq:...:rainbow-foil:no-auto), so:
      //   variant match: strip "variant::" from id → exact match
      //   card match:    STARTSWITH the cardId prefix + ":" → any child
      let img: string | null = null;
      if (n.kind === "variant") {
        const stripped = n.id.startsWith("variant::") ? n.id.slice("variant::".length) : n.id;
        img = await pickImageExact(stripped);
      } else {
        img = await pickImageAnyChild(n.cardId);
      }
      if (!img) { miss++; }
      else {
        hit++;
        if (APPLY) {
          try {
            await catalog.item(n.id, n.cardId).patch({
              operations: [
                { op: "set", path: "/imageUrl", value: img },
                { op: "set", path: "/imageAttachedAt", value: new Date().toISOString() },
              ],
            } as never);
            patched++;
          } catch (e) {
            errors++;
            if (errors <= 3) console.error(`  ! patch ${n.id}: ${(e as Error).message}`);
          }
        }
      }
      if (MAX > 0 && scanned >= MAX) break;
      if (scanned % 100 === 0) {
        const el = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        process.stderr.write(`  scanned=${scanned} hit=${hit} miss=${miss} patched=${patched}  ${Math.round(scanned / el)}/s\r`);
      }
    }
    if (MAX > 0 && scanned >= MAX) break;
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:  ${scanned.toLocaleString()}`);
  console.log(`  hit:      ${hit.toLocaleString()}`);
  console.log(`  miss:     ${miss.toLocaleString()}`);
  console.log(`  patched:  ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:   ${errors}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
