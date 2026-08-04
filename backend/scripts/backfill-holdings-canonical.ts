#!/usr/bin/env -S npx tsx
/**
 * CF-CATALOG-FIRST P0.3 — holding canonical backfill (Drew, 2026-08-04).
 *
 * For every portfolio holding without a cardId (or with a stale
 * hobbyiqCardId), run its identity through the catalog matcher and
 * attach the canonical slug in-place. Same pattern as the sold-comps
 * backfill but scoped to the portfolio container.
 *
 * Fixes cases like Griffey #396 where the holding has full identity
 * (year, product, cardNumber, playerName) but no cardId → recent-sales
 * endpoint can't query and pricing falls through to legacy fuzzy matching.
 *
 * Usage:
 *   npx tsx backend/scripts/backfill-holdings-canonical.ts \
 *     [--user <userId>] [--dry-run] [--auto-approve]
 *
 * Without --user, backfills EVERY user's holdings. With --user, scopes
 * to a single user (safer for the initial rollout).
 */

import { CosmosClient } from "@azure/cosmos";
import { createInterface } from "readline";
import { canonicalize, canonicalizeParallelName } from "../src/services/catalog/catalogMatcher.service.js";

interface Args {
  user?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === "--user") { args.user = val; i++; }
    else if (flag === "--dry-run") { args.dryRun = true; }
    else if (flag === "--auto-approve" || flag === "-y") { args.autoApprove = true; }
  }
  return args;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

interface Holding {
  id: string;
  cardId?: string;
  hobbyiqCardId?: string;
  cardYear?: number;
  cardNumber?: string;
  parallel?: string;
  isAuto?: boolean;
  printRun?: number | null;
  playerName?: string;
  product?: string;
  setName?: string;
  sport?: string;
  cardStatus?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  console.log(`\n▸ Holding canonical backfill`);
  console.log(`  scope: ${args.user ? `user ${args.user}` : "ALL users"}`);
  if (args.dryRun) console.log(`  DRY RUN — no Cosmos writes`);

  const client = new CosmosClient(conn);
  const portfolio = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("portfolio");

  const query = args.user
    ? "SELECT c.id, c.userId, c.holdings FROM c WHERE c.userId = @u"
    : "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)";
  const params = args.user ? [{ name: "@u", value: args.user }] : [];
  const { resources: users } = await portfolio.items.query(
    { query, parameters: params },
    { enableCrossPartitionQuery: true },
  ).fetchAll();

  console.log(`\n▸ Scanning holdings across ${users.length} user doc(s)...`);
  interface Candidate {
    userId: string;
    holdingId: string;
    holding: Holding;
    reason: string;
  }
  const candidates: Candidate[] = [];
  let totalHoldings = 0;
  for (const u of users) {
    const map = (u as { holdings?: Record<string, Holding> }).holdings ?? {};
    const userId = (u as { userId?: string }).userId;
    if (!userId) continue;
    for (const [hid, h] of Object.entries(map)) {
      totalHoldings++;
      if (h.cardStatus === "sold" || h.cardStatus === "pending-review") continue;
      if (!h.cardNumber || !h.cardYear || !h.sport) continue;
      const canonParallel = canonicalizeParallelName(h.parallel ?? "Base");
      // Candidate when cardId is missing OR parallel isn't already canonical
      const needsBackfill = !h.cardId || (h.parallel && h.parallel !== canonParallel);
      if (needsBackfill) {
        candidates.push({
          userId,
          holdingId: hid,
          holding: h,
          reason: !h.cardId ? "no-cardId" : "parallel-not-canonical",
        });
      }
    }
  }
  console.log(`  ✓ ${totalHoldings} holdings scanned, ${candidates.length} candidates for backfill`);

  if (candidates.length === 0) {
    console.log(`\n▸ Every holding already canonical — nothing to do.`);
    process.exit(0);
  }

  console.log(`\n▸ Reasons:`);
  const reasonCounts = new Map<string, number>();
  for (const c of candidates) reasonCounts.set(c.reason, (reasonCounts.get(c.reason) ?? 0) + 1);
  for (const [r, n] of reasonCounts) console.log(`  ${r.padEnd(24)} ${n}`);

  console.log(`\n▸ Sample (first 10):`);
  for (const c of candidates.slice(0, 10)) {
    const h = c.holding;
    console.log(`   [${c.reason.padEnd(22)}] ${h.cardYear} ${h.product ?? h.setName ?? "?"} #${h.cardNumber} ${h.parallel ?? ""} — ${h.playerName ?? "?"}`);
  }

  if (args.dryRun) {
    console.log(`\n▸ DRY RUN — done.`);
    process.exit(0);
  }
  if (!args.autoApprove) {
    const ans = await ask(`\n  Approve backfilling ${candidates.length} holdings? [y/N] `);
    if (!/^y(es)?$/i.test(ans)) {
      console.log("Aborted — nothing written.");
      process.exit(0);
    }
  }

  console.log(`\n▸ Backfilling (per-user batches)...`);
  // Group candidates by userId so we do one read/write per user (Cosmos
  // portfolio doc is per-user; we mutate the map and write back once).
  const byUser = new Map<string, Candidate[]>();
  for (const c of candidates) {
    let arr = byUser.get(c.userId);
    if (!arr) { arr = []; byUser.set(c.userId, arr); }
    arr.push(c);
  }
  let patched = 0, errors = 0;
  let doneUsers = 0;
  const totalUsers = byUser.size;
  for (const [userId, userCandidates] of byUser.entries()) {
    try {
      const { resource: doc } = await portfolio.item(userId, userId).read();
      if (!doc) { errors += userCandidates.length; doneUsers++; continue; }
      let mutated = false;
      for (const c of userCandidates) {
        const h = doc.holdings[c.holdingId];
        if (!h) continue;
        const canonParallel = canonicalizeParallelName(h.parallel ?? "Base");
        try {
          const match = await canonicalize({
            sport: h.sport!,
            year: h.cardYear!,
            setName: h.product ?? h.setName ?? "",
            cardNumber: h.cardNumber!,
            parallel: canonParallel,
            isAuto: h.isAuto === true,
            printRun: typeof h.printRun === "number" ? h.printRun : null,
            player: h.playerName ?? null,
            source: "user-verified",   // trusted — user owns this card
          });
          h.parallel = canonParallel;
          if (!h.cardId) h.cardId = match.slug;
          h.hobbyiqCardId = match.slug;
          mutated = true;
          patched++;
        } catch (err) {
          errors++;
          if (errors < 5) console.warn(`  ! ${c.holdingId}: ${(err as Error).message}`);
        }
      }
      if (mutated) {
        await portfolio.item(userId, userId).replace(doc);
      }
    } catch (err) {
      errors++;
      if (errors < 5) console.warn(`  ! user ${userId}: ${(err as Error).message}`);
    }
    doneUsers++;
    process.stdout.write(`  ...user ${doneUsers}/${totalUsers}, patched ${patched}, err ${errors}\r`);
  }

  console.log(`\n▸ Done:`);
  console.log(`   patched: ${patched}`);
  console.log(`   errors: ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
