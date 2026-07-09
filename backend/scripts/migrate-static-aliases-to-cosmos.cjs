#!/usr/bin/env node
/**
 * CF-STATIC-ALIAS-MIGRATION (2026-07-08, Drew):
 *
 * Seeds the Cosmos search_aliases container from the in-code static
 * synonym maps (PARALLEL_SYNONYMS, GRADE_COMPANY_SYNONYMS,
 * SET_NAME_SYNONYMS). Idempotent: re-running preserves any admin/LLM
 * edits that came after the seed via the repository's merge logic.
 *
 * Run once after PR 1 deploys, then again any time the static maps
 * change (net-new seeds should propagate). Runtime: <5s for the
 * current ~40 canonical entries.
 *
 * Usage:
 *   COSMOS_ENDPOINT=... COSMOS_KEY=... node backend/scripts/migrate-static-aliases-to-cosmos.cjs
 *
 * The Anthropic key is NOT required for this script.
 */

const path = require("path");

async function main() {
  // Use tsx to import ESM modules directly. Faster to run via
  // `npx tsx` from the backend root or via the deploy pipeline's
  // node runtime with a compiled dist output. Fall through to a
  // compiled dist path when available; otherwise expect tsx.
  const distEntry = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "search",
    "aliasStore.service.js",
  );
  const distRepo = path.resolve(
    __dirname,
    "..",
    "dist",
    "repositories",
    "searchAliases.repository.js",
  );

  let staticSeedAliases;
  let upsertAlias;
  try {
    ({ staticSeedAliases } = await import(distEntry));
    ({ upsertAlias } = await import(distRepo));
  } catch (err) {
    console.error(
      "Cannot find dist output. Build first with `npm run build` or invoke via `npx tsx backend/scripts/migrate-static-aliases-to-cosmos.cjs`.",
    );
    console.error(err.message);
    process.exit(1);
  }

  console.log("[migrate-aliases] loading static seed...");
  const seed = staticSeedAliases();
  console.log(`[migrate-aliases] ${seed.length} canonical entries to upsert`);

  let ok = 0;
  let failed = 0;
  for (const entry of seed) {
    try {
      await upsertAlias(entry);
      ok++;
    } catch (err) {
      failed++;
      console.warn(
        `[migrate-aliases] failed for ${entry.category}:${entry.canonical}: ${err?.message ?? err}`,
      );
    }
  }
  console.log(`[migrate-aliases] DONE: ${ok} upserted, ${failed} failed`);
  if (failed > 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
