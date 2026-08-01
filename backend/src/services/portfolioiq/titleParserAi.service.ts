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

export async function parseTitleWithAi(title: string): Promise<AiParsedTitle | null> {
  if (!title || typeof title !== "string" || title.trim().length < 10) return null;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";
  if (!endpoint || !apiKey || !deployment) return null;

  const titleHash = hashTitle(title);

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
  cardNumber: string | null    e.g. "CPA-EHA", "BCP-102", "US100", "150". null if unknown.
  parallel:   string           canonical parallel name (e.g. "Blue Refractor", "Refractor", "Base"). Default "Base" if unknown.
  isAuto:     boolean          true if title indicates autograph (auto, autograph, hard-signed, or an auto-only cardNumber like CPA-*, BCPA-*, TCRA-*).
  printRun:   number | null    e.g. 150 for "/150", 25 for "#/25". null if unnumbered.
  confidence: "high" | "medium" | "low"
  reasoning:  brief string (< 80 chars) — why you chose these values.

Rules:
- "True Blue" = "Blue Refractor" (Bowman market shortening).
- "Mega Refractor" = "Mojo Refractor".
- "Mojo" (any color) implies Refractor (Blue Mojo → Blue Mojo Refractor).
- If title contains PSA/BGS/SGC number, ignore that (grade parsing is separate).
- If title lacks a cardNumber pattern (#XXX-XXX or #NNN), return null for cardNumber.

Return JSON only.`;

  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Title: "${title}"\n\nReturn JSON.` },
    ],
    temperature: 0.05,
    max_tokens: 200,
    response_format: { type: "json_object" },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
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
  }
}
