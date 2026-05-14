import { promises as fs } from "fs";
import path from "path";

export interface PersistedBriefPayload<TPlayer = unknown> {
  date: string;
  generatedAt: string;
  mlb: TPlayer[];
  milb: TPlayer[];
}

type BriefStore<TPlayer = unknown> = Record<string, PersistedBriefPayload<TPlayer>>;

const STORE_PATH = process.env.DAILYIQ_BRIEF_STORE_PATH
  ? path.resolve(process.env.DAILYIQ_BRIEF_STORE_PATH)
  : path.resolve(process.cwd(), ".data", "dailyiq-briefs.json");

let writeQueue: Promise<void> = Promise.resolve();

async function readStore<TPlayer = unknown>(): Promise<BriefStore<TPlayer>> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as BriefStore<TPlayer>;
    }
  } catch {
    // Fall through to initialize an empty store.
  }
  const empty: BriefStore<TPlayer> = {};
  await fs.writeFile(STORE_PATH, JSON.stringify(empty, null, 2), "utf8");
  return empty;
}

async function persistStore<TPlayer = unknown>(store: BriefStore<TPlayer>): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
  }).catch(() => {
    // Keep queue alive for subsequent writes.
  });
  await writeQueue;
}

export async function getPersistedBriefByDate<TPlayer = unknown>(date: string): Promise<PersistedBriefPayload<TPlayer> | null> {
  const store = await readStore<TPlayer>();
  return store[date] ?? null;
}

export async function upsertPersistedBrief<TPlayer = unknown>(payload: PersistedBriefPayload<TPlayer>): Promise<void> {
  const store = await readStore<TPlayer>();
  store[payload.date] = payload;
  await persistStore(store);
}
