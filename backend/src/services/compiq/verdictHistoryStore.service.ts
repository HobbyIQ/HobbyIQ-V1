// CF-VERDICT-FLIP-ALERTS (Drew, 2026-07-13, PR #428): persist daily
// verdicts per player + detect flips between snapshots. Powers
// "Eric Hartman just went STRONG BULL" alerts + a "recent flips"
// discovery surface.
//
// Container: `verdict_history`, partition `/player`. 180-day TTL.
// Doc: { id: `${player}::${YYYY-MM-DD}`, player, date, verdict, ... }

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const TTL_SEC = 180 * 24 * 3600;

type Verdict =
  | "strong_bull" | "bull" | "mixed" | "supply_tight" | "static"
  | "oversupply" | "bear" | "soft" | "weak" | "unavailable";

export interface VerdictDoc {
  id: string;
  player: string;
  date: string;
  verdict: Verdict;
  salesDirection: "up" | "down" | "static" | null;
  listingsDirection: "up" | "down" | "static" | null;
  generatedAt: string;
  ttl: number;
}

export interface VerdictFlip {
  player: string;
  date: string;
  from: Verdict;
  to: Verdict;
  significance: "major" | "minor";   // major = crosses bull/bear boundary
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerId =
        process.env.COSMOS_VERDICT_HISTORY_CONTAINER ?? "verdict_history";
      if (!endpoint && !connStr) return null;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({
        endpoint: endpoint!,
        aadCredentials: new DefaultAzureCredential(),
      });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerId,
        partitionKey: { paths: ["/player"] },
        defaultTtl: -1,
      });
      _container = container;
      return container;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "verdict_history_init_failed",
        source: "verdictHistoryStore.service",
        error: (err as Error)?.message ?? String(err),
      }));
      return null;
    }
  })();
  return _initPromise;
}

function normalizePlayer(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

/**
 * "Major" flips are ones that cross the bull/bear divide — those are
 * the events a user notification should fire on. "Minor" is any other
 * change (e.g. mixed → bull, static → mixed).
 */
const BULL_VERDICTS: ReadonlySet<Verdict> = new Set(["strong_bull", "bull", "supply_tight"]);
const BEAR_VERDICTS: ReadonlySet<Verdict> = new Set(["bear", "soft", "weak", "oversupply"]);

function significance(from: Verdict, to: Verdict): "major" | "minor" {
  const fromBull = BULL_VERDICTS.has(from);
  const fromBear = BEAR_VERDICTS.has(from);
  const toBull = BULL_VERDICTS.has(to);
  const toBear = BEAR_VERDICTS.has(to);
  if ((fromBull && toBear) || (fromBear && toBull)) return "major";
  // Crossing INTO strong_bull from anywhere is also major (rare + wanted)
  if (to === "strong_bull" && from !== "strong_bull") return "major";
  return "minor";
}

/**
 * Persist today's verdict for a player AND return the flip (if any) vs
 * the most-recent prior day.
 */
export async function recordVerdictAndDetectFlip(input: {
  playerDisplay: string;
  verdict: Verdict;
  salesDirection: "up" | "down" | "static" | null;
  listingsDirection: "up" | "down" | "static" | null;
  today?: string;   // YYYY-MM-DD; defaults to today UTC
}): Promise<VerdictFlip | null> {
  const c = await getContainer();
  if (!c) return null;

  const player = normalizePlayer(input.playerDisplay);
  const date = input.today ?? new Date().toISOString().slice(0, 10);
  const doc: VerdictDoc = {
    id: `${player}::${date}`,
    player,
    date,
    verdict: input.verdict,
    salesDirection: input.salesDirection,
    listingsDirection: input.listingsDirection,
    generatedAt: new Date().toISOString(),
    ttl: TTL_SEC,
  };

  // Read the most recent PRIOR day's verdict (before writing today's).
  const priorDate = new Date(Date.parse(date) - 86_400_000)
    .toISOString().slice(0, 10);
  let prior: VerdictDoc | null = null;
  try {
    // Peek back up to 7 days for the most recent prior verdict — snapshots
    // can miss days.
    const q = {
      query: "SELECT TOP 1 * FROM c WHERE c.player = @p AND c.date < @today ORDER BY c.date DESC",
      parameters: [
        { name: "@p", value: player },
        { name: "@today", value: date },
      ],
    };
    const { resources } = await c.items.query(q, { partitionKey: player }).fetchAll();
    prior = resources[0] as VerdictDoc | undefined ?? null;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "verdict_history_read_error",
      source: "verdictHistoryStore.service",
      player, error: (err as Error)?.message ?? String(err),
    }));
  }

  try {
    await c.items.upsert(doc as any);
  } catch (err) {
    console.warn(JSON.stringify({
      event: "verdict_history_upsert_error",
      source: "verdictHistoryStore.service",
      player, date, error: (err as Error)?.message ?? String(err),
    }));
  }

  if (!prior || prior.verdict === input.verdict) return null;

  const flip: VerdictFlip = {
    player,
    date,
    from: prior.verdict,
    to: input.verdict,
    significance: significance(prior.verdict, input.verdict),
  };
  console.log(JSON.stringify({
    event: "verdict_flip_detected",
    source: "verdictHistoryStore.service",
    ...flip,
    priorDate: prior.date,
  }));
  return flip;
}

/** Recent verdicts for a player, oldest → newest. Useful for iOS' "history" tape. */
export async function readVerdictHistory(
  playerDisplay: string,
  days: number = 30,
): Promise<VerdictDoc[]> {
  const c = await getContainer();
  if (!c) return [];
  const player = normalizePlayer(playerDisplay);
  const cutoff = new Date(Date.now() - days * 86_400_000)
    .toISOString().slice(0, 10);
  const q = {
    query: "SELECT * FROM c WHERE c.player = @p AND c.date >= @cutoff ORDER BY c.date",
    parameters: [
      { name: "@p", value: player },
      { name: "@cutoff", value: cutoff },
    ],
  };
  try {
    const { resources } = await c.items.query(q, { partitionKey: player }).fetchAll();
    return resources as VerdictDoc[];
  } catch (err) {
    console.warn(JSON.stringify({
      event: "verdict_history_range_error",
      source: "verdictHistoryStore.service",
      player, error: (err as Error)?.message ?? String(err),
    }));
    return [];
  }
}

/**
 * CF-VERDICT-FLIP-ALERTS-WIRE (Drew, 2026-07-16, iOS-prep): walk a
 * player's persisted verdict history and return every day-over-day
 * flip inside the window. Ordered oldest → newest. Empty when the
 * player has fewer than 2 days of data or the verdict was stable
 * across every consecutive-day pair.
 *
 * Read-only mirror of the flip-detection logic in
 * recordVerdictAndDetectFlip — same significance rules, no writes.
 * Feeds the /players/:player/verdict-history route (detail sheet
 * flip strip) and the /portfolio/flips route (inventory-row dots).
 */
export async function readRecentFlips(
  playerDisplay: string,
  days: number = 30,
): Promise<VerdictFlip[]> {
  const history = await readVerdictHistory(playerDisplay, days);
  if (history.length < 2) return [];
  const player = normalizePlayer(playerDisplay);
  const flips: VerdictFlip[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const cur = history[i];
    if (prev.verdict === cur.verdict) continue;
    flips.push({
      player,
      date: cur.date,
      from: prev.verdict,
      to: cur.verdict,
      significance: significance(prev.verdict, cur.verdict),
    });
  }
  return flips;
}

/**
 * Batch mirror of readRecentFlips over a list of players. Runs the
 * per-player reads with bounded concurrency so a 50-holding portfolio
 * doesn't fan out into a Cosmos storm. Concurrency = 8 matches the
 * pattern used elsewhere in the store layer (see
 * portfolioStore.repriceHoldingsForUser).
 */
export async function readRecentFlipsForPlayers(
  playersDisplay: ReadonlyArray<string>,
  days: number = 7,
): Promise<VerdictFlip[]> {
  const CONCURRENCY = 8;
  const out: VerdictFlip[] = [];
  const dedupe = new Set<string>(); // player -> already added key
  const seen = new Set<string>();   // dedupe requested players by normalized name
  const requestQueue: string[] = [];
  for (const p of playersDisplay) {
    const norm = normalizePlayer(String(p ?? ""));
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    requestQueue.push(p);
  }
  for (let i = 0; i < requestQueue.length; i += CONCURRENCY) {
    const slice = requestQueue.slice(i, i + CONCURRENCY);
    const chunk = await Promise.all(slice.map((p) => readRecentFlips(p, days)));
    for (const flips of chunk) {
      for (const f of flips) {
        const k = `${f.player}|${f.date}|${f.from}|${f.to}`;
        if (dedupe.has(k)) continue;
        dedupe.add(k);
        out.push(f);
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
  return out;
}

export function _setContainerForTests(container: Container | null): void {
  _container = container;
  _initPromise = null;
}
