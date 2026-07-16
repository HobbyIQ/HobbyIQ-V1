#!/usr/bin/env node
/**
 * CF-AUTO-FLAG-GAP-PROBE (2026-07-11, Drew).
 *
 * The reference-catalog stress test (2026-07-11) flagged 4 "soft matches"
 * where the workbook says a parallel has an auto variant but Cosmos has
 * only base variants. Before adding auto ParallelDocs to Cosmos, verify
 * these auto variants actually exist in the CardHedge catalog — CH's
 * card_search hits are the closest thing to ground truth we have.
 *
 * Output per candidate: number of CH matches with "auto" in the title
 * (heuristic) so we can see which are real vs which are workbook errors.
 *
 * Runbook:
 *   CARD_HEDGE_API_KEY="..." node backend/scripts/probe-auto-flag-gaps.cjs
 *
 * Read-only: no Cosmos writes, no CH mutations.
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CANDIDATES = [
  { productKey: "bowman-chrome", year: 2024, parallel: "Green Refractor" },
  { productKey: "bowman-chrome", year: 2024, parallel: "Yellow Refractor" },
  { productKey: "bowman-chrome", year: 2024, parallel: "Red Refractor" },
  { productKey: "bowman-draft", year: 2022, parallel: "Purple Refractor" },
];

async function main() {
  if (!process.env.CARD_HEDGE_API_KEY) {
    console.error("CARD_HEDGE_API_KEY not set");
    process.exit(1);
  }
  const distClient = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "compiq",
    "cardhedge.client.js",
  );
  const { identifyCard } = await import(pathToFileURL(distClient).href);

  // Sample player + card number per bucket to give identifyCard something
  // concrete to resolve. If the AI matcher finds this specific SKU, the
  // auto variant exists in CH's catalog. If it can't, the variant either
  // doesn't exist or has zero sales history.
  const PROBES = [
    {
      bucket: "bowman-chrome/2024 Green Refractor",
      queries: [
        "2024 Bowman Chrome Prospects Kristian Campbell Green Refractor Auto BCP-25",
        "2024 Bowman Chrome Prospects Chase DeLauter Green Refractor Auto",
      ],
    },
    {
      bucket: "bowman-chrome/2024 Yellow Refractor",
      queries: [
        "2024 Bowman Chrome Prospects Kristian Campbell Yellow Refractor Auto BCP-25",
        "2024 Bowman Chrome Prospects Chase DeLauter Yellow Refractor Auto",
      ],
    },
    {
      bucket: "bowman-chrome/2024 Red Refractor",
      queries: [
        "2024 Bowman Chrome Prospects Kristian Campbell Red Refractor Auto BCP-25",
        "2024 Bowman Chrome Prospects Chase DeLauter Red Refractor Auto",
      ],
    },
    {
      bucket: "bowman-draft/2022 Purple Refractor",
      queries: [
        "2022 Bowman Draft Chrome Elly De La Cruz Purple Refractor Auto CDA-EDLC",
        "2022 Bowman Draft Druw Jones Purple Refractor Auto",
      ],
    },
  ];

  for (const p of PROBES) {
    console.log(`\n▶ ${p.bucket}`);
    for (const q of p.queries) {
      try {
        const hit = await identifyCard(q);
        if (hit && hit.card_id) {
          const title = hit.title ?? `${hit.year} ${hit.set} #${hit.number}`;
          const matchesParallel = String(title).toLowerCase().includes(
            p.bucket.split(" ").slice(1).join(" ").replace(" refractor", "").toLowerCase(),
          );
          console.log(`  ✓ identifyCard hit for "${q.slice(0, 60)}...":`);
          console.log(`      title: ${title}`);
          console.log(`      variant: ${hit.variant ?? "(none)"}`);
          console.log(`      confidence: ${hit.confidence ?? "?"}`);
        } else {
          console.log(`  ✗ no match for "${q.slice(0, 60)}..."`);
        }
      } catch (err) {
        console.error(`  ✗ probe error: ${err.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
