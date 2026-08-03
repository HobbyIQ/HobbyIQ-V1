// CF-TITLE-PARSER-AI (Drew, 2026-08-01). Fallback for titles the
// regex-based parseListingIdentity can't parse. Uses Azure OpenAI
// to extract (cardNumber, parallel, isAuto, printRun) from a raw
// eBay/marketplace title. Cached by title hash so cost is bounded
// (same title = one LLM call ever).
//
// Trigger: preIngestClean calls this ONLY when the regex parser
// returned null for cardNumber AND the title has meaningful content.
// Prevents the cost of parsing every title while catching the long
// tail of weird formats.

import { CosmosClient, type Container } from "@azure/cosmos";
import { createHash } from "crypto";

export interface AiParsedTitle {
  cardNumber: string | null;
  parallel: string;
  isAuto: boolean;
  printRun: number | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  // CF-AI-FULL-IDENTITY (Drew, 2026-08-03). Extended fields for TCA
  // firehose fallback — regex can extract these for sports, but Pokemon
  // and non-standard titles need LLM inference. Optional so existing
  // callers keep their contract unchanged.
  cardYear?: number | null;
  playerName?: string | null;
  setName?: string | null;
  sport?: string | null;      // baseball | basketball | football | hockey | soccer | pokemon | tcg-other | non-sport | null
}

const CACHE_CONTAINER_ID = process.env.COSMOS_TITLE_PARSE_CACHE_CONTAINER ?? "title_parse_cache";
const CACHE_TTL_SEC = 90 * 24 * 3600; // 90 days

let cachedContainer: Container | null = null;
async function getCacheContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const { database } = await client.databases.createIfNotExists({ id: process.env.COSMOS_DATABASE ?? "hobbyiq" });
    const { container } = await database.containers.createIfNotExists({
      id: CACHE_CONTAINER_ID,
      partitionKey: { paths: ["/titleHash"] },
      defaultTtl: CACHE_TTL_SEC,
    });
    cachedContainer = container;
    return container;
  } catch { return null; }
}

function hashTitle(title: string): string {
  return createHash("sha256").update(title.trim().toLowerCase()).digest("hex").slice(0, 32);
}

// CF-LLM-RATE-LIMIT (Drew, 2026-08-03). Azure OpenAI gpt-4o-mini
// defaults to modest TPM/RPM. Semaphore caps in-flight per app
// instance; excess awaits. Env-var overridable so we can tune without
// redeploys. After bumping the deployment to 500K TPM / 5K RPM, 20
// concurrent is safely under the ceiling (20 × 2/sec ≈ 40 calls/sec,
// vs 42/sec TPM ceiling at 200 tokens/call).
const LLM_MAX_INFLIGHT = Math.max(1, Number(process.env.LLM_MAX_INFLIGHT ?? "20"));
let llmInflight = 0;
const llmWaitQueue: Array<() => void> = [];
async function acquireLlmSlot(): Promise<void> {
  if (llmInflight < LLM_MAX_INFLIGHT) { llmInflight++; return; }
  await new Promise<void>((resolve) => llmWaitQueue.push(resolve));
  llmInflight++;
}
function releaseLlmSlot(): void {
  llmInflight--;
  const next = llmWaitQueue.shift();
  if (next) next();
}

export async function parseTitleWithAi(title: string, imageUrl?: string | null): Promise<AiParsedTitle | null> {
  if (!title || typeof title !== "string" || title.trim().length < 10) return null;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";
  if (!endpoint || !apiKey || !deployment) return null;
  // Vision fallback flag — when true and imageUrl present, send the
  // image URL as a second content part. gpt-4o-mini supports vision;
  // the model reads the card and cross-references our text extraction.
  const useVision = process.env.LLM_VISION_ENABLED === "true"
    && typeof imageUrl === "string"
    && /^https?:\/\//.test(imageUrl);

  // Cache key includes vision-mode so text-only + vision responses cache
  // separately (they can produce different fields, especially cardYear
  // and playerName on Pokemon/vintage titles).
  const titleHash = useVision ? `v:${hashTitle(title)}` : hashTitle(title);

  // Cache hit?
  const cache = await getCacheContainer();
  if (cache) {
    try {
      const { resource } = await cache.item(titleHash, titleHash).read();
      if (resource) return (resource as { parsed: AiParsedTitle }).parsed;
    } catch { /* cache miss */ }
  }

  // Cache miss — call LLM
  const system = `You extract card identity from marketplace listing titles for HobbyIQ. Return STRICT JSON.

Fields:
  cardNumber: string | null    e.g. "CPA-EHA", "BCP-102", "US100", "150", "37/109" (TCG format). null if unknown.
  parallel:   string           canonical parallel name (e.g. "Blue Refractor", "Refractor", "Base"). Default "Base" if unknown.
  isAuto:     boolean          true if title indicates autograph.
  printRun:   number | null    e.g. 150 for "/150", 25 for "#/25". null if unnumbered.
  cardYear:   number | null    e.g. 2011, 2024. For "2003-04" use 2003. For Pokemon sets: "Team Rocket Returns"=2004, "Ascended Heroes"=2025, "151"=2023, "Lost Origin"=2022, "SV"=2023+, "Neo Revelation"=2001. null if truly unknown.
  playerName: string | null    Real name of the player OR Pokemon/character name. For "Mike Trout" return "Mike Trout". For "Dark Houndoom" return "Dark Houndoom". Strip trailing team names ("Yankees", "Lakers"). null only if no identifiable subject.
  setName:    string | null    Brand + product line, e.g. "Topps Chrome", "Panini Prizm", "Pokemon SV", "Bowman Chrome Prospects". null if only a year+player known.
  sport:      string | null    ONE of: baseball, basketball, football, hockey, soccer, pokemon, yugioh, tcg-other, non-sport, null.
  confidence: "high" | "medium" | "low"
  reasoning:  brief string (< 80 chars) — why you chose these values.

Rules:
- "True Blue" = "Blue Refractor" (Bowman market shortening).
- "Mega Refractor" = "Mojo Refractor".
- "Mojo" (any color) implies Refractor (Blue Mojo → Blue Mojo Refractor).
- If title contains PSA/BGS/SGC number, ignore that (grade parsing is separate).
- Pokemon titles: playerName = character name (Charizard, Blastoise, etc). cardNumber uses X/Y format (37/109). sport = "pokemon".
- Non-sports/non-TCG collectibles (Funko, Marvel, Star Wars, sealed products): sport = "non-sport".
- Sealed boxes / product not a single card: return cardNumber=null, playerName=null (skips at ingest).

Return JSON only.`;

  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  // Text-only user content OR mixed text+image parts when vision is on.
  const userContent: unknown = useVision
    ? [
        { type: "text", text: `Title: "${title}"\n\nUse the image to disambiguate identity when the title is ambiguous. Return JSON.` },
        { type: "image_url", image_url: { url: imageUrl!, detail: "low" } },
      ]
    : `Title: "${title}"\n\nReturn JSON.`;
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    temperature: 0.05,
    max_tokens: 250,
    response_format: { type: "json_object" },
  };

  // Acquire semaphore slot before hitting Azure OpenAI
  await acquireLlmSlot();
  try {
    // Fetch with 429 retry (Azure returns retry-after when throttled)
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (r.status !== 429) { res = r; break; }
      // Honor Retry-After if provided, else exp backoff (1s / 4s / 12s)
      const retryAfter = Number(r.headers.get("retry-after") ?? "");
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(4, attempt - 1);
      if (attempt === 3) { res = r; break; }
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 15_000)));
    }
    if (!res || !res.ok) return null;
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as Partial<AiParsedTitle>;
    if (!parsed) return null;
    const out: AiParsedTitle = {
      cardNumber: typeof parsed.cardNumber === "string" && parsed.cardNumber.trim().length > 0 ? parsed.cardNumber.trim() : null,
      parallel: typeof parsed.parallel === "string" && parsed.parallel.trim().length > 0 ? parsed.parallel.trim() : "Base",
      isAuto: parsed.isAuto === true,
      printRun: typeof parsed.printRun === "number" && Number.isFinite(parsed.printRun) && parsed.printRun > 0 ? parsed.printRun : null,
      confidence: parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low",
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : "",
      cardYear: typeof parsed.cardYear === "number" && Number.isFinite(parsed.cardYear) && parsed.cardYear > 1800 && parsed.cardYear < 2100 ? parsed.cardYear : null,
      playerName: typeof parsed.playerName === "string" && parsed.playerName.trim().length > 0 ? parsed.playerName.trim() : null,
      setName: typeof parsed.setName === "string" && parsed.setName.trim().length > 0 ? parsed.setName.trim() : null,
      sport: typeof parsed.sport === "string" && parsed.sport.trim().length > 0 ? parsed.sport.trim().toLowerCase() : null,
    };
    // Cache result
    if (cache) {
      try {
        await cache.items.upsert({
          id: titleHash,
          titleHash,
          title: title.slice(0, 500),
          parsed: out,
          computedAt: new Date().toISOString(),
          ttl: CACHE_TTL_SEC,
        });
      } catch { /* cache write is soft */ }
    }
    return out;
  } catch {
    return null;
  } finally {
    releaseLlmSlot();
  }
}
