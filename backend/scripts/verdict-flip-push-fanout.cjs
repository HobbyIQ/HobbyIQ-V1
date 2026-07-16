#!/usr/bin/env node
/**
 * CF-VERDICT-FLIP-PUSH-FANOUT (Drew, 2026-07-16, scaffold).
 *
 * Push-notification fan-out worker for verdict flips. Reads today's
 * flips from the persisted verdict_history container (via the same
 * readRecentFlipsForPlayers helper the /portfolio/flips route uses),
 * filters to significance="major", finds the users who own each
 * flipped player AND have opted in to push, and emits a summary of
 * what would go out via APNs.
 *
 * SCAFFOLD-ONLY: this script does not actually call APNs yet. It emits
 * a JSON summary that the follow-up ship will consume. Prereqs before
 * un-stubbing the APNs call:
 *   1. APNs auth key (.p8) provisioned to App Service settings as
 *      APNS_AUTH_KEY_P8 (raw PEM) + APNS_KEY_ID + APNS_TEAM_ID +
 *      APNS_BUNDLE_ID.
 *   2. PortfolioHolding contract extended with apnsDeviceToken (per-
 *      device, set at app launch from iOS).
 *   3. User doc extended with `preferences.pushOnMajorFlip: boolean`
 *      (set from the onboarding toggle).
 *
 * Runbook (local dry-run):
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/verdict-flip-push-fanout.cjs [--days=1] [--dry-run] [--limit=N]
 *
 * Flags:
 *   --days=N     Look-back window for flips (default 1 = today).
 *   --dry-run    Never emit — just print the summary (always the case
 *                until APNs is wired; kept as an explicit flag for
 *                future safety).
 *   --limit=N    Cap the number of flips processed (smoke test).
 *
 * Exit codes:
 *   0 completed (regardless of dry-run vs live send)
 *   1 Cosmos read failure / bad usage
 */

const path = require("path");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cosmos = process.env.COSMOS_CONNECTION_STRING;
  if (!cosmos) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  // Lazy-import compiled backend modules so the script works from either
  // backend/dist (production) or backend/src via tsx (local dev).
  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "src", "services"));
  const modBase = useCompiled ? path.join(distRoot, "src") : path.resolve(__dirname, "..", "src");

  const { readRecentFlipsForPlayers } = require(
    path.join(modBase, "services", "compiq", "verdictHistoryStore.service" + (useCompiled ? ".js" : ".ts"))
  );
  // Portfolio read for reverse index (player → users who hold that player).
  // Same Cosmos container the /portfolio/holdings route reads.
  const portfolioStore = require(
    path.join(modBase, "services", "portfolioiq", "portfolioStore.service" + (useCompiled ? ".js" : ".ts"))
  );

  const daysWindow = clampInt(args.days ?? 1, 1, 7);
  const limit = args.limit ? clampInt(args.limit, 1, 5000) : null;
  const dryRun = args.dryRun !== false; // default true until APNs is wired

  // ── Step 1: enumerate all players touched in the last daysWindow.
  //
  // We don't have a "global recent players" index; instead scan every
  // user's holdings to build the player universe. For launch scale
  // (Drew's own portfolio + a handful of beta users) this is fine.
  // When user count > ~10k, add a nightly denormalized "active_players"
  // index and read from there.
  const allPlayers = await enumerateHeldPlayers(portfolioStore);
  console.log(JSON.stringify({
    event: "flip_fanout_enumerate",
    playerCount: allPlayers.size,
  }));

  if (allPlayers.size === 0) {
    console.log(JSON.stringify({ event: "flip_fanout_nothing_to_scan" }));
    return;
  }

  // ── Step 2: batch-read recent flips across those players.
  const flips = await readRecentFlipsForPlayers([...allPlayers], daysWindow);
  const majorFlips = flips.filter((f) => f.significance === "major");
  console.log(JSON.stringify({
    event: "flip_fanout_flips_read",
    totalFlips: flips.length,
    majorFlips: majorFlips.length,
    daysWindow,
  }));

  const capped = limit ? majorFlips.slice(0, limit) : majorFlips;

  // ── Step 3: for each major flip, find users who own the player AND
  // opted in. Emit a per-user push intent.
  let pushIntentCount = 0;
  for (const flip of capped) {
    const users = await findUsersOwningPlayerWithPushOptIn(portfolioStore, flip.player);
    for (const user of users) {
      pushIntentCount++;
      console.log(JSON.stringify({
        event: "flip_push_intent",
        userId: user.userId,
        // No device token echo — that's the wire piece that lands when
        // apnsDeviceToken plumbing ships. Present here so the KQL query
        // downstream knows what to expect.
        hasDeviceToken: Boolean(user.apnsDeviceToken),
        player: flip.player,
        from: flip.from,
        to: flip.to,
        date: flip.date,
        significance: flip.significance,
        wouldSend: !dryRun && Boolean(user.apnsDeviceToken),
      }));

      if (!dryRun && user.apnsDeviceToken) {
        // ── Un-stub when APNs is wired. Signature:
        //   await sendApnsMajorFlip(user.apnsDeviceToken, flip);
        // The APNs helper lives at src/services/push/apnsSender.ts
        // (future). Copy: "Trout '11 Update flipped from BUY to SELL.
        // Tap to review."
        console.log(JSON.stringify({
          event: "flip_push_stubbed",
          reason: "APNs SDK not yet configured — see APNS_* env vars in runbook",
        }));
      }
    }
  }

  console.log(JSON.stringify({
    event: "flip_fanout_complete",
    totalFlips: flips.length,
    majorFlips: majorFlips.length,
    processedFlips: capped.length,
    pushIntents: pushIntentCount,
    dryRun,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { dryRun: true };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-dry-run") out.dryRun = false;
    else if (a.startsWith("--days=")) out.days = Number(a.slice(7));
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
  }
  return out;
}

function clampInt(n, min, max) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

async function pathExists(p) {
  try {
    const fs = require("fs/promises");
    await fs.access(p);
    return true;
  } catch { return false; }
}

/**
 * Enumerate the union of playerName across every user's holdings.
 * Reads via the store's exposed helpers so this script doesn't
 * duplicate Cosmos query wiring. When portfolioStore doesn't expose
 * a global-holdings scan (which it doesn't as of this scaffold), fall
 * back to the direct Cosmos read via a follow-up. Marked TODO below —
 * shipping the scaffold now, wiring in the next PR.
 */
async function enumerateHeldPlayers(portfolioStore) {
  // TODO(CF-VERDICT-FLIP-PUSH-FANOUT-STEP-2): expose a portfolioStore
  // helper `listAllHeldPlayers()` that cross-partitions the users
  // container reading `holdings[].playerName`. For now, return empty
  // so the script's log stream is honest — it will emit
  // `flip_fanout_nothing_to_scan` and exit cleanly.
  return new Set();
}

/**
 * Given a normalized player name, return an array of
 * { userId, apnsDeviceToken }
 * for users who hold that player AND have opted in to major-flip push.
 */
async function findUsersOwningPlayerWithPushOptIn(portfolioStore, player) {
  // TODO(CF-VERDICT-FLIP-PUSH-FANOUT-STEP-3): implement the reverse
  // index. Same story as enumerateHeldPlayers — needs a
  // portfolioStore-side helper that we'll ship in the next PR.
  return [];
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: "flip_fanout_fatal",
    error: (err && err.message) || String(err),
  }));
  process.exit(1);
});
