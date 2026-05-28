// player_trends partition + completeness probe.
//
// Originally built for CF-PLAYERTRENDS-QUERY-FAILURE (closed as
// classification A 2026-05-28; see docs/phase0/cosmos_21_failure_rate_
// investigation.md). Retained as a reusable diagnostic for two
// recurring questions on the `player_trends` container:
//
//   1. How many partitions exist? (readPartitionKeyRanges)
//   2. Is data on the container reachable / complete from
//      getPlayerScoreByName's query shape? (completeness check across
//      known players + determinism via second pass)
//
// Also useful as the verification harness for CF-PLAYERNAME-
// CANONICALIZATION — after the canonicalization fix ships, re-run this
// script and the now-mismatched names (e.g., "Bobby Witt Jr." with
// period) should match deterministically.
//
// Read-only — no mutations to player_trends.
//
// Required env:
//   COSMOS_CONNECTION_STRING

const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = "hobbyiq";
const CONTAINER = "player_trends";

// Known players from this session's portfolio sweeps. Each of these was
// repriced via /api/portfolio/holdings/:id/refresh recently — every
// reprice fires upsertPlayerScore (per playerScore.service.ts header
// line 7) so a player_trends row should exist for each.
const KNOWN_PLAYERS = [
  "Mike Trout",
  "Greg Maddux",
  "Ken Griffey Jr.",
  "Bobby Witt Jr.",
  "Caleb Bonemer",
  "John Gilbert",
  "Bobby Cox",
  "Tommy White",
];

// Pathological inputs to compare against the production query shape.
const PATHOLOGICAL_INPUTS = [
  { label: "empty string", value: "" },
  { label: "single char", value: "X" },
  { label: "leading/trailing space (matches normalized lookup)", value: "  Mike Trout  " },
  { label: "non-ASCII", value: "Yoán Moncada" },
  { label: "random uuid (definitely not a player)", value: "8f3e5c2a-1b4d-4e6f-9c8a-7b5d2e1f9a3c" },
];

const QUERY = 'SELECT TOP 1 * FROM c WHERE LOWER(c["playerName"]) = @name';

function summarizeError(err) {
  const e = err || {};
  return {
    code: e.code ?? null,
    substatus: e.substatus ?? null,
    activityId: e.activityId ?? null,
    name: e.name ?? null,
    message: typeof e.message === "string" ? e.message.slice(0, 500) : null,
    body: e.body ?? null,
    headers: e.headers ?? null,
  };
}

async function runOne(container, label, playerName) {
  const normalized = (playerName ?? "").trim().toLowerCase();
  const iter = container.items.query({
    query: QUERY,
    parameters: [{ name: "@name", value: normalized }],
  });

  const out = {
    label,
    playerName,
    normalized,
    rowCount: 0,
    requestCharge: null,
    activityId: null,
    continuationToken: null,
    diagnostics: null,
    error: null,
    firstRow: null,
  };

  try {
    // fetchNext gives us per-page details. For a TOP 1 cross-partition
    // query the iterator should resolve in one call.
    const resp = await iter.fetchNext();
    out.rowCount = resp.resources?.length ?? 0;
    out.requestCharge = resp.requestCharge ?? null;
    out.activityId = resp.activityId ?? null;
    out.continuationToken = resp.continuationToken ?? null;
    // Capture select diagnostic fields without dumping the whole giant blob.
    const d = resp.diagnostics;
    if (d) {
      const cs = d.clientSideRequestStatistics;
      out.diagnostics = {
        clientSide: cs ? {
          requestStartTimeUTC: cs.requestStartTimeUTC ?? null,
          requestEndTimeUTC: cs.requestEndTimeUTC ?? null,
          requestCount: cs.requestCount ?? null,
          retryCount: cs.retryCount ?? null,
          metadataDuration: d.metadataLookupDuration ?? null,
          // Some SDK versions expose locationEndpointsContacted
          locationEndpoints: cs.locationEndpointsContacted ?? null,
        } : null,
      };
    }
    if (out.rowCount > 0) {
      const r = resp.resources[0];
      out.firstRow = {
        id: r.id,
        playerId: r.playerId,
        playerName: r.playerName,
        playerIQScore: r.playerIQScore,
        updatedAt: r.updatedAt,
      };
    }
  } catch (err) {
    out.error = summarizeError(err);
  }
  return out;
}

async function probePkRanges(container) {
  // Use the SDK's internal partition info via readPartitionKeyRanges
  // if available; otherwise emit a hint to the report.
  try {
    const ranges = [];
    const pkrIter = container.readPartitionKeyRanges();
    let page;
    do {
      page = await pkrIter.fetchNext();
      for (const r of (page.resources ?? [])) {
        ranges.push({
          id: r.id,
          minInclusive: r.minInclusive,
          maxExclusive: r.maxExclusive,
          status: r.status,
        });
      }
    } while (page.hasMoreResults);
    return { ok: true, count: ranges.length, ranges };
  } catch (err) {
    return { ok: false, error: summarizeError(err) };
  }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(2);
  }

  const client = new CosmosClient(conn);
  const db = client.database(DB_NAME);
  const container = db.container(CONTAINER);

  console.log("=== PARTITION COUNT (readPartitionKeyRanges) ===");
  const pkr = await probePkRanges(container);
  console.log(JSON.stringify(pkr, null, 2));
  console.log("");

  console.log("=== KNOWN PLAYERS COMPLETENESS CHECK ===");
  for (const name of KNOWN_PLAYERS) {
    const result = await runOne(container, "known", name);
    console.log(JSON.stringify(result));
  }
  console.log("");

  console.log("=== PATHOLOGICAL INPUTS ===");
  for (const p of PATHOLOGICAL_INPUTS) {
    const result = await runOne(container, p.label, p.value);
    console.log(JSON.stringify(result));
  }
  console.log("");

  // Repeat the known-players check to see if hit/miss is stable across
  // calls — flips would suggest non-deterministic partition fan-out.
  console.log("=== KNOWN PLAYERS — SECOND PASS (determinism check) ===");
  for (const name of KNOWN_PLAYERS) {
    const result = await runOne(container, "known-pass2", name);
    console.log(JSON.stringify(result));
  }
  console.log("");

  console.log("=== END ===");
}

main().catch((e) => {
  console.error("FATAL:", e?.message || e);
  if (e?.body) console.error("BODY:", JSON.stringify(e.body));
  process.exit(1);
});
