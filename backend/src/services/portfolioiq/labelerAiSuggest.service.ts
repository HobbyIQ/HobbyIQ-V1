// CF-LABELER-AI-SUGGEST (Drew, 2026-08-01). Uses Azure OpenAI to
// suggest a canonical parallel + print run + refractor flag given a
// card variant's CH catalog entry (variant name + image URL + set).
// Drew reviews and confirms — cuts labeling time from ~30s to ~5s
// per variant while preserving human authority.
//
// Prompt design: give the model our canonical parallel vocabulary
// (same list the labeler dropdown uses) and let it pick one. Include
// the image URL so the model can see the actual card (needed for
// visually-distinguished parallels like Blue vs Refractor).

interface SuggestInput {
  chVariant: string;
  set: string;
  cardNumber: string;
  cardYear: number;
  playerName: string;
  imageUrl: string | null;
  currentGuess?: string;  // rule-based guess to seed the prompt
}

export interface SuggestOutput {
  parallel: string | null;
  printRun: number | null;
  isRefractor: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  usedImage: boolean;
}

const CANONICAL_VOCAB = [
  "Base", "Refractor", "Blue Refractor", "Green Refractor", "Red Refractor",
  "Gold Refractor", "Orange Refractor", "Purple Refractor", "Yellow Refractor",
  "Black Refractor", "Aqua Refractor", "Mojo Refractor", "Speckle Refractor",
  "Blue Wave Refractor", "Green Wave Refractor", "Gold Wave Refractor",
  "Red Wave Refractor", "Blue Shimmer Refractor", "Green Shimmer Refractor",
  "Red Shimmer Refractor", "Orange Shimmer Refractor", "Blue Lava Refractor",
  "Green Lava Refractor", "Red Lava Refractor", "Aqua Lava Refractor",
  "X-Fractor", "Black X-Fractor", "Sparkle Refractor", "Mini Diamond",
  "Superfractor", "1/1",
];

export async function suggestLabelFromCatalogVariant(input: SuggestInput): Promise<SuggestOutput | null> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";
  if (!endpoint || !apiKey || !deployment) return null;

  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const system = `You are a sports card catalog labeling assistant. Given a card variant from CardHedge's catalog, classify it into HobbyIQ's canonical parallel vocabulary.

Canonical vocabulary (choose EXACTLY one):
${CANONICAL_VOCAB.join(", ")}

Rules:
- "Base" means unnumbered non-refractor matte finish (chrome auto with no color, no numbering).
- "Refractor" is the standard refractor (unnumbered or /499 base refractor).
- Named colors (Blue, Green, etc.) map to their "-Refractor" variant when the card is from a Bowman Chrome or Topps Chrome product line.
- Wave/Shimmer/Lava variants are patterned refractors — always paired with a color.
- X-Fractor is distinct from Refractor (checkered pattern).
- Print run rules (baseball reference): Blue Refractor /150, Green Refractor /99, Gold Refractor /50, Orange Refractor /25, Red Refractor /5, Superfractor /1. Colors vary by product.
- Return "high" confidence when the variant name maps cleanly. "medium" for ambiguous names. "low" when you're guessing.

Return STRICT JSON: {"parallel": "...", "printRun": 150 or null, "isRefractor": true/false, "confidence": "high"|"medium"|"low", "reasoning": "brief"}`;

  const userMsg = `Card variant to classify:
- Player: ${input.playerName}
- CardHedge variant name: "${input.chVariant}"
- Set: ${input.set}
- CardNumber: ${input.cardNumber}
- Year: ${input.cardYear}
${input.currentGuess ? `- Current rule-based guess: ${input.currentGuess}` : ""}

Classify to the canonical vocabulary. Return JSON only.`;

  const body = {
    messages: [
      { role: "system", content: system },
      input.imageUrl
        ? {
            role: "user",
            content: [
              { type: "text", text: userMsg },
              { type: "image_url", image_url: { url: input.imageUrl } },
            ],
          }
        : { role: "user", content: userMsg },
    ],
    temperature: 0.1,
    max_tokens: 300,
    response_format: { type: "json_object" },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`labelerAiSuggest HTTP ${res.status}`);
      return null;
    }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as {
      parallel?: string;
      printRun?: number | null;
      isRefractor?: boolean;
      confidence?: "high" | "medium" | "low";
      reasoning?: string;
    };
    if (!parsed.parallel) return null;
    return {
      parallel: parsed.parallel,
      printRun: typeof parsed.printRun === "number" ? parsed.printRun : null,
      isRefractor: parsed.isRefractor === true,
      confidence: parsed.confidence ?? "low",
      reasoning: parsed.reasoning ?? "",
      usedImage: !!input.imageUrl,
    };
  } catch (err) {
    console.warn("labelerAiSuggest error:", (err as Error)?.message);
    return null;
  }
}
