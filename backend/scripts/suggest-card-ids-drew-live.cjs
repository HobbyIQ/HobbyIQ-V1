#!/usr/bin/env node
// CF-CARDID-SUGGESTER (2026-07-12).
//
// Live E2E: generate cardId suggestions for Drew's 36 pending-review
// holdings by calling generateCardIdSuggestions against real Cosmos + CH.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CosmosClient } = require("@azure/cosmos");
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const dist = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "portfolioiq",
    "cardIdSuggester.service.js",
  );
  const { generateCardIdSuggestions } = await import(pathToFileURL(dist).href);

  console.log("▶ Running suggestions for", USER_ID);
  const started = Date.now();
  const summary = await generateCardIdSuggestions(USER_ID, { force: true });
  const ms = Date.now() - started;
  console.log();
  console.log("  processed:      ", summary.processed);
  console.log("  suggested:      ", summary.suggested);
  console.log("  noCandidates:   ", summary.noCandidates);
  console.log("  errors:         ", summary.errors);
  console.log("  duration:       ", ms, "ms");
  console.log();

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const { resources } = await client.database("hobbyiq").container("portfolio")
    .items.query({
      query: "SELECT * FROM c WHERE c.userId = @u",
      parameters: [{ name: "@u", value: USER_ID }],
    })
    .fetchAll();
  const doc = resources[0];
  const pending = Object.values(doc.holdings ?? {}).filter((h) => h.cardStatus === "pending-review");
  const withSug = pending.filter((h) => h.suggestedCardId);
  console.log("▶ Sample of 10 pending holdings + suggestions:");
  for (const h of pending.slice(0, 10)) {
    const suf = h.suggestedCardId
      ? `→ ${h.suggestionCandidate?.title ?? "?"} [conf ${h.suggestionConfidence}]`
      : "→ no candidate";
    console.log(
      "  " + (h.playerName ?? "?").padEnd(24)
      + " " + String(h.cardYear ?? "?").padStart(4)
      + " " + (h.parallel ?? "-").padEnd(18)
      + " " + suf,
    );
  }
  console.log();
  console.log(`▶ ${withSug.length}/${pending.length} pending holdings now have a cardId suggestion`);
}
main().catch((e) => { console.error(e); process.exit(1); });
