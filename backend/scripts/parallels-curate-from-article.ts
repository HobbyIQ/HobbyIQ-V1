#!/usr/bin/env node
// Phase 2b-iv-a — Path Z curation CLI wrapper (issue #33).
//
// Usage:
//   npx --yes tsx backend/scripts/parallels-curate-from-article.ts \
//     <article-url> <set-name> [--dry-run] [--reviewed-by=<id>] [--yes]
//
// Flow:
//   1. Fetch the article HTML (via Node fetch).
//   2. Run the pure extractor → ParallelAttributesProposal.
//   3. Print the proposal as a markdown table for owner review.
//   4. Validate.
//   5. If --dry-run, stop here (NO Cosmos writes).
//   6. Else: prompt "Commit N entries to dev Cosmos? Press y to confirm."
//   7. On 'y', call commitProposal(); otherwise abort.
//
// Path Z principle: agent NEVER auto-commits. Owner explicitly confirms.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import * as url from "node:url";

import {
  buildCosmosClient,
  getParallelsContainers,
} from "../src/services/parallelsReference/ingestion.js";
import {
  commitProposal,
  extractProposalFromArticle,
  renderProposalMarkdown,
  validateProposal,
} from "../src/services/parallelsReference/curationHarness.js";

// ─── Load .env.harness-local ────────────────────────────────────────────────

const here = path.dirname(url.fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env.harness-local");
if (fs.existsSync(envFile)) {
  const raw = fs.readFileSync(envFile, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (process.env[k] == null && k && v) process.env[k] = v;
  }
}

// ─── CLI parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  articleUrl: string;
  targetSet: string;
  dryRun: boolean;
  reviewedBy: string;
  autoYes: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let dryRun = false;
  let reviewedBy = process.env.HOBBYIQ_REVIEWER ?? "owner";
  let autoYes = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes" || a === "-y") autoYes = true;
    else if (a.startsWith("--reviewed-by=")) reviewedBy = a.slice("--reviewed-by=".length);
    else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    throw new Error(
      "Usage: parallels-curate-from-article.ts <article-url> <set-name> [--dry-run] [--reviewed-by=<id>] [--yes]"
    );
  }
  return {
    articleUrl: positional[0],
    targetSet: positional[1],
    dryRun,
    reviewedBy,
    autoYes,
  };
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[curate] article = ${args.articleUrl}`);
  console.log(`[curate] target set = ${args.targetSet}`);
  console.log(`[curate] dry-run = ${args.dryRun}`);
  console.log(`[curate] reviewedBy = ${args.reviewedBy}`);
  console.log("");

  // Step 1 + 2: fetch + extract.
  const proposal = await extractProposalFromArticle(args.articleUrl, args.targetSet);

  // Step 3: render for owner review.
  console.log(renderProposalMarkdown(proposal));
  console.log("");

  // Step 4: validate.
  const validationErrors = validateProposal(proposal, { reviewedBy: args.reviewedBy });
  if (validationErrors.length > 0) {
    console.log("---");
    console.log(`Validation found ${validationErrors.length} issue(s):`);
    for (const e of validationErrors) console.log(`  - ${e}`);
    console.log("");
  }

  // Step 5: dry-run short-circuit.
  if (args.dryRun) {
    console.log("--dry-run set; NO Cosmos writes. Exiting.");
    return;
  }

  // If validation has any errors that aren't owner-fill-in placeholders, refuse.
  // The owner is expected to edit the proposal (or update this script) before
  // re-running without --dry-run.
  if (validationErrors.length > 0) {
    console.error(
      "Refusing to commit: resolve the validation errors above (set tierWithinSet on each entry) before re-running without --dry-run."
    );
    process.exitCode = 1;
    return;
  }

  // Step 6: confirmation.
  if (!args.autoYes) {
    const answer = await prompt(
      `Commit ${proposal.entries.length} entries to dev Cosmos? Press y to confirm: `
    );
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted by user. No writes performed.");
      return;
    }
  }

  // Step 7: commit.
  const client = buildCosmosClient();
  const { parallelAttributes } = await getParallelsContainers(client);
  const result = await commitProposal(parallelAttributes, proposal, {
    reviewedBy: args.reviewedBy,
  });
  console.log("");
  console.log(
    `Commit complete: attempted=${result.attempted} succeeded=${result.succeeded} failed=${result.failed}`
  );
  for (const r of result.results) {
    const status = r.ok ? "OK " : "ERR";
    console.log(`  [${status}] ${r.id}${r.error ? ` — ${r.error}` : ""}`);
  }
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
});
