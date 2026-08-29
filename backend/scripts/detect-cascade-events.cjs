#!/usr/bin/env node
/**
 * CF-CASCADE-ALERTS (Drew, 2026-07-17). Nightly: scan every stored
 * stratified player trend, run cascade detection, upsert fired events
 * to cascade_events.
 *
 * Runs AFTER the player-trends nightly (which writes the source data).
 */

const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "services"));
  if (!useCompiled) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }
  const { detectCascades } = require(
    path.join(distRoot, "services", "portfolioiq", "cascadeDetect.service.js"),
  );
  const {
    upsertCascadeEvents,
    readRecentEventsForPlayers,
  } = require(
    path.join(distRoot, "services", "portfolioiq", "cascadeEventStore.service.js"),
  );
  // CF-CASCADE-APNS-PUSH (Drew, 2026-07-17). Fan-out to APNs for the
  // subset of newly-detected events that aren't already stored.
  const { sendCascadeAlertsForNewEvents, cascadePushExitCode } = require(
    path.join(distRoot, "services", "portfolioiq", "cascadeNotify.service.js"),
  );
  // D13 (2026-08-29): the sender no-ops without APNS_*; ask before
  // trusting a zero. The workflow must pass the five APNs vars.
  const { isPushProviderConfigured } = require(
    path.join(distRoot, "services", "notification.service.js"),
  );

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const trends = db.container(process.env.COSMOS_PLAYER_TRENDS_CONTAINER ?? "player_trends");

  const t0 = Date.now();
  console.log(JSON.stringify({ event: "cascade_detect_start" }));

  // Read every stored player-trend row (cross-partition, ~500 rows).
  const iter = trends.items.query({
    query: "SELECT c.player, c.computedAt, c.raw, c.graded FROM c",
  }, { maxItemCount: 1000 });

  const inputs = [];
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (!page.resources) continue;
    for (const row of page.resources) {
      if (!row.player) continue;
      inputs.push({
        player: row.player,
        raw: row.raw ? {
          momentum: Number(row.raw.momentum),
          direction: row.raw.direction,
          qualifyingCards: Number(row.raw.qualifyingCards),
          velocityPerWeek: Number(row.raw.velocityPerWeek ?? 0),
        } : null,
        graded: row.graded ? {
          momentum: Number(row.graded.momentum),
          direction: row.graded.direction,
          qualifyingCards: Number(row.graded.qualifyingCards),
          velocityPerWeek: Number(row.graded.velocityPerWeek ?? 0),
        } : null,
        computedAt: row.computedAt ?? new Date().toISOString(),
      });
    }
  }

  const result = detectCascades(inputs);

  // CF-CASCADE-APNS-PUSH (Drew, 2026-07-17). Dedup pushes against events
  // already stored in the last 24h so re-running the nightly (or the
  // detector firing twice for the same player on the same day) doesn't
  // spam users. `detectedAt` is stamped once per detectCascades run so
  // id-level uniqueness alone doesn't dedup — we need per-player window
  // dedup.
  const uniqSlugs = [...new Set(result.events.map((e) => e.playerSlug))];
  const lookbackSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let alreadyFired = new Set();
  if (uniqSlugs.length > 0) {
    try {
      const existing = await readRecentEventsForPlayers(uniqSlugs, lookbackSince);
      alreadyFired = new Set(existing.map((e) => e.playerSlug));
    } catch (err) {
      console.error(JSON.stringify({
        event: "cascade_detect_dedup_query_failed",
        error: err && err.message ? err.message : String(err),
      }));
      // Fail-closed on dedup: if we can't read prior events, skip pushes
      // rather than risk spamming.
      alreadyFired = new Set(uniqSlugs);
    }
  }
  const newEvents = result.events.filter((e) => !alreadyFired.has(e.playerSlug));

  const upserted = await upsertCascadeEvents(result.events);

  const pushProviderConfigured = isPushProviderConfigured();
  let notify = { sent: 0, failed: 0, optedInUsers: 0 };
  if (newEvents.length > 0) {
    try {
      notify = await sendCascadeAlertsForNewEvents(newEvents);
    } catch (err) {
      console.error(JSON.stringify({
        event: "cascade_detect_notify_failed",
        error: err && err.message ? err.message : String(err),
      }));
    }
  }

  console.log(JSON.stringify({
    event: "cascade_detect_complete",
    scanned: result.scanned,
    detected: result.detected,
    upserted,
    newEvents: newEvents.length,
    optedInUsers: notify.optedInUsers ?? 0,
    pushSent: notify.sent,
    pushFailed: notify.failed,
    pushProviderConfigured,
    elapsedMs: Date.now() - t0,
    topEvents: result.events.slice(0, 10).map((e) => ({
      player: e.player,
      severity: e.severity,
      ratio: e.detectionInput.momentumRatio,
      gradedMomentum: e.detectionInput.gradedMomentum,
      rawMomentum: e.detectionInput.rawMomentum,
    })),
  }));

  // D13 (2026-08-29): a zero because nobody was owed a push is fine; a
  // zero because the sender does not exist is the defect this script
  // hid for six weeks. Red, with the reason on one line.
  const exitCode = cascadePushExitCode({
    newEvents: newEvents.length,
    optedInUsers: notify.optedInUsers ?? 0,
    providerConfigured: pushProviderConfigured,
  });
  if (exitCode !== 0) {
    console.error(
      `::error::cascade push provider NOT configured — ${newEvents.length} new event(s) owed to ` +
      `${notify.optedInUsers} opted-in user(s) and every send no-op'd (need APNS_KEY_ID/APNS_TEAM_ID/` +
      `APNS_BUNDLE_ID/APNS_KEY_P8 in the workflow env)`,
    );
  }
  process.exit(exitCode);
}

async function pathExists(p) {
  try {
    const fs = require("fs/promises");
    await fs.access(p);
    return true;
  } catch { return false; }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "cascade_detect_fatal", error: err.message ?? String(err) }));
  process.exit(1);
});
