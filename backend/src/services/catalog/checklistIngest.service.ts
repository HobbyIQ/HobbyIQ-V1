/**
 * CF-CATALOG-FIRST — Tier 2 (Drew, 2026-08-04). LLM extraction of a
 * card release's checklist from a published source (Topps product
 * page, Beckett checklist, manual paste). Produces canonical rows
 * for card_catalog.
 *
 * Design doc: backend/docs/catalog-first-architecture.md
 *
 * Contract:
 *   input:  { source, sourceUrl, rawContent, contextHints }
 *   output: strict JSON matching ChecklistExtraction schema
 *
 * The LLM is prompted with a strict schema. The response is JSON-
 * parsed and validated before ANY Cosmos write. On validation
 * failure the extraction is returned as `{ok:false, error:"..."}`
 * so the caller can retry or surface it.
 */

export interface ChecklistExtractionInput {
  source: "topps-product-page" | "beckett-checklist" | "manual-text" | "generic-url";
  sourceUrl: string | null;
  rawContent: string;             // HTML or plain text
  contextHints: {
    year: number;
    sport: string;
    setName: string;              // e.g. "2024 Bowman Chrome"
    subset?: string | null;       // e.g. "Prospect Autographs"
  };
}

export interface ChecklistParallel {
  name: string;                   // "Blue Refractor"
  slug: string;                   // "blue-refractor"
  printRun: number | null;
  isSsp: boolean;
}

export interface ChecklistCard {
  cardNumber: string;
  player: string;
  isAuto: boolean;
  parallels: ChecklistParallel[];
}

export interface ChecklistExtraction {
  ok: true;
  release: {
    year: number;
    sport: string;
    setKey: string;
    setName: string;
    productLine: string | null;
  };
  cards: ChecklistCard[];
  reasoning: string;
  tokenCost: {
    prompt: number;
    completion: number;
  };
}

export interface ChecklistExtractionError {
  ok: false;
  error: string;
  rawResponse?: string;
}

const SYSTEM_PROMPT = `You extract a trading-card release checklist for HobbyIQ. Output STRICT JSON matching this shape:

{
  "release": {
    "year": <number>,
    "sport": "baseball" | "basketball" | "football" | "hockey" | "soccer" | "pokemon" | "other",
    "setKey": <kebab-case setKey; STRIP any year prefix and sport suffix; e.g. "bowman-chrome", "topps-chrome", "score">,
    "setName": <original set name from context>,
    "productLine": <optional subset, e.g. "prospect-autographs" or "chrome-rookies"; null if none>
  },
  "cards": [
    {
      "cardNumber": <string; strip # prefix; keep dashes; UPPERCASE>,
      "player": <full name; strip team names; strip "Jr." variants consistently keeping "Jr.">,
      "isAuto": <true if the card is an autograph card; false for base>,
      "parallels": [
        {
          "name": <canonical name; e.g. "Blue Refractor", "Refractor", "Superfractor", "Base">,
          "slug": <lowercase kebab of name>,
          "printRun": <numeric print run, null if unnumbered>,
          "isSsp": <true if the parallel is a Super Short Print (unnumbered but rarer than base)>
        }
      ]
    }
  ],
  "reasoning": <brief string, < 200 chars, explaining any judgment calls>
}

Rules:
- Every card MUST have at least one parallel (the base variant).
- Common parallel canonicalizations:
  - "True Blue" → "Blue Refractor"
  - "Mega Refractor" → "Mojo Refractor"
  - "1st" (as in "1st Bowman") → part of the setName, not the parallel
  - "Superfractor" is /1 unless explicitly numbered otherwise
  - "Refractor" is the base refractor tier
  - Bowman Chrome / Topps Chrome "Black & White Shimmer" is DIFFERENT from "Black & White Red Ink" (different parallels)
- Card numbers: keep the exact format from the source (e.g. "CPA-BWJ", "BCP-102", "US100", "1a"). Do not renumber.
- Autographs are usually numbered separately from base rookies. Bowman Chrome Prospect Autographs uses "CPA-" prefix.
- If the source page lists cards in a table, extract EVERY row. Do not skip.
- If a card lists no explicit parallels, assume Base + Refractor + Blue + Green + Gold + Orange + Red (standard Bowman Chrome ladder). Only apply this when the source explicitly shows a partial list AND context.setName contains "Bowman Chrome".
- Print runs are numeric. "/5" → 5, "/150" → 150, "Superfractor 1/1" → 1.
- SSPs (Super Short Prints) are unnumbered but rarer than base — mark isSsp=true and printRun=null. Common SSPs in Bowman: Black & White Red Ink, Black & White Gold Ink, Superfractor Autographs.

Do NOT invent cards. If the source is thin (< 20 cards), return only what's there.

Output valid JSON only. No prose outside the JSON object.`;

export async function extractChecklistWithLlm(
  input: ChecklistExtractionInput,
): Promise<ChecklistExtraction | ChecklistExtractionError> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";
  if (!endpoint || !apiKey || !deployment) {
    return { ok: false, error: "Azure OpenAI env not configured" };
  }
  if (!input.rawContent || input.rawContent.length < 100) {
    return { ok: false, error: "rawContent too short — need at least 100 chars" };
  }
  // Truncate very long content to keep prompt cost bounded. 40K chars is
  // typically enough for a full release checklist while staying inside
  // gpt-4o-mini's 128K context.
  const content = input.rawContent.length > 40000
    ? input.rawContent.slice(0, 40000) + "\n[...truncated for prompt budget...]"
    : input.rawContent;

  const userMessage = `Extract the checklist from this source.

Context hints:
  year: ${input.contextHints.year}
  sport: ${input.contextHints.sport}
  setName: ${input.contextHints.setName}
${input.contextHints.subset ? `  subset: ${input.contextHints.subset}\n` : ""}
Source URL: ${input.sourceUrl ?? "(pasted content)"}

Content:
${content}

Return the JSON.`;

  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const body = {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
    response_format: { type: "json_object" as const },
    max_tokens: 16000,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return { ok: false, error: `Azure OpenAI HTTP ${resp.status}: ${errText.slice(0, 400)}` };
  }
  const json = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = json.choices?.[0]?.message?.content ?? "";
  if (!raw) return { ok: false, error: "empty LLM response", rawResponse: JSON.stringify(json) };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse: ${(err as Error).message}`,
      rawResponse: raw.slice(0, 2000),
    };
  }

  const validation = validateExtraction(parsed);
  if (!validation.ok) {
    return { ok: false, error: validation.error, rawResponse: raw.slice(0, 2000) };
  }

  return {
    ok: true,
    release: validation.release,
    cards: validation.cards,
    reasoning: validation.reasoning,
    tokenCost: {
      prompt: json.usage?.prompt_tokens ?? 0,
      completion: json.usage?.completion_tokens ?? 0,
    },
  };
}

interface ValidationOk {
  ok: true;
  release: ChecklistExtraction["release"];
  cards: ChecklistCard[];
  reasoning: string;
}
interface ValidationFail {
  ok: false;
  error: string;
}

function validateExtraction(raw: Record<string, unknown>): ValidationOk | ValidationFail {
  const release = raw.release as Record<string, unknown> | undefined;
  if (!release || typeof release !== "object") {
    return { ok: false, error: "missing release object" };
  }
  const year = Number(release.year);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { ok: false, error: `invalid release.year: ${release.year}` };
  }
  const sport = String(release.sport ?? "").trim().toLowerCase();
  if (!sport) return { ok: false, error: "missing release.sport" };
  const setKey = String(release.setKey ?? "").trim();
  if (!setKey) return { ok: false, error: "missing release.setKey" };
  const setName = String(release.setName ?? "").trim();

  const rawCards = raw.cards;
  if (!Array.isArray(rawCards)) return { ok: false, error: "cards is not an array" };
  if (rawCards.length === 0) return { ok: false, error: "cards array is empty" };

  const cards: ChecklistCard[] = [];
  const seenNumbers = new Set<string>();
  for (let i = 0; i < rawCards.length; i++) {
    const c = rawCards[i] as Record<string, unknown>;
    const cardNumber = String(c.cardNumber ?? "").trim().toUpperCase();
    const player = String(c.player ?? "").trim();
    if (!cardNumber) return { ok: false, error: `card[${i}] missing cardNumber` };
    if (!player) return { ok: false, error: `card[${i}] (${cardNumber}) missing player` };
    if (seenNumbers.has(cardNumber)) {
      return { ok: false, error: `duplicate cardNumber: ${cardNumber}` };
    }
    seenNumbers.add(cardNumber);
    const isAuto = c.isAuto === true;
    const rawParallels = Array.isArray(c.parallels) ? c.parallels : [];
    if (rawParallels.length === 0) return { ok: false, error: `card ${cardNumber} has no parallels` };
    const parallels: ChecklistParallel[] = [];
    for (const rp of rawParallels) {
      const p = rp as Record<string, unknown>;
      const name = String(p.name ?? "").trim();
      const slug = String(p.slug ?? "").trim().toLowerCase();
      if (!name) continue;
      parallels.push({
        name,
        slug: slug || name.toLowerCase().replace(/\s+/g, "-"),
        printRun: typeof p.printRun === "number" && Number.isFinite(p.printRun) ? Math.round(p.printRun) : null,
        isSsp: p.isSsp === true,
      });
    }
    if (parallels.length === 0) return { ok: false, error: `card ${cardNumber} had no valid parallels after normalize` };
    cards.push({ cardNumber, player, isAuto, parallels });
  }

  const productLine = release.productLine != null
    ? String(release.productLine).trim() || null
    : null;
  return {
    ok: true,
    release: { year, sport, setKey, setName, productLine },
    cards,
    reasoning: String(raw.reasoning ?? "").slice(0, 500),
  };
}
