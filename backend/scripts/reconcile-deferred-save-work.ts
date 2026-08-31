/**
 * CF-CARD-SAVE-FAST (Drew, 2026-08-31) — the reconcile half of the deferral.
 *
 * `updateHolding` now runs the reprice and the comp emit AFTER the response.
 * The marker that records the debt is written by the same Cosmos write that
 * persists the edit, so work is never owed without being recorded. This script
 * pays down anything the in-process lane did not finish — a crashed worker, an
 * App Service recycle, a Cosmos blip between the response and the work.
 *
 * Every deferred op is idempotent (the comp upserts on the fixed
 * `holding::<id>` key; the reprice recomputes from current state), so a replay
 * converges rather than duplicating.
 *
 * Usage:
 *   npx tsx scripts/reconcile-deferred-save-work.ts --user <userId>
 *   npx tsx scripts/reconcile-deferred-save-work.ts --user <userId> --dry-run
 *
 * Reads COSMOS_CONNECTION_STRING from the environment. Pipe it in directly:
 *   az webapp config appsettings list --name HobbyIQ3 -g rg-hobbyiq-dev \
 *     --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv
 *
 * --dry-run REPORTS the outstanding debt without running any of it, which is
 * the safe way to answer "is the deferred lane keeping up?" against prod.
 */

import {
  reconcileDeferredSaveWork,
  readUserDoc,
} from "../src/services/portfolioiq/portfolioStore.service.js";
import { readPending } from "../src/services/portfolioiq/holdingSaveDeferredWork.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const userId = arg("user");
  const dryRun = process.argv.includes("--dry-run");

  if (!userId) {
    console.error("Refusing to run: --user <userId> is required.");
    console.error("This script walks ONE user's holdings; it has no whole-scope mode.");
    process.exit(2);
    return;
  }

  console.log(
    `[reconcile-deferred-save-work] user=${userId} mode=${dryRun ? "DRY-RUN (reports only)" : "APPLY"}`,
  );

  if (dryRun) {
    const doc = await readUserDoc(userId);
    // CF-HOLDINGS-IS-A-MAP: walk the map's values; a JOIN over an object
    // iterates nothing and would report a reassuring zero.
    const entries = Object.entries(doc.holdings ?? {});
    const owed = entries
      .map(([id, h]) => ({ id, pending: readPending(h as PortfolioHolding) }))
      .filter((r) => r.pending !== null);

    console.log(`scanned=${entries.length} owed=${owed.length}`);
    for (const row of owed) {
      console.log(
        `  ${row.id}  ops=${row.pending!.ops.join(",")}  since=${row.pending!.at}  attempts=${row.pending!.attempts}`,
      );
    }
    if (entries.length === 0) {
      console.warn("scanned 0 holdings — verify the userId before trusting owed=0.");
    }
    return;
  }

  const result = await reconcileDeferredSaveWork(userId);
  console.log(
    `scanned=${result.scanned} replayed=${result.replayed} exhausted=${result.exhausted.length}`,
  );
  if (result.exhausted.length > 0) {
    // These have burned their retry budget. They are reported, never silently
    // dropped — a holding stuck here means real work is still unpaid.
    console.warn(`exhausted (needs a look): ${result.exhausted.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("[reconcile-deferred-save-work] failed:", err);
  process.exit(1);
});
