// CF-SLAB-OCR-VERIFY (Drew, 2026-07-29).
//
// Tier-2 verification via LLM vision extraction of GRADED SLAB LABELS.
//
// Existing Tier 2 (vision-tokens) does a generic OCR pass + string-match
// for {player, cardNumber, year} appearing anywhere in the extracted
// text. That misses on slab-focused images because the interesting text
// lives inside a labeled region with fixed layout — bare token search
// can't tell "PSA GEM MT 10" from a coincidental "10" in some other
// image region.
//
// This tier uses an Azure OpenAI vision model to extract STRUCTURED
// fields from the slab label:
//   { grader, gradeValue, certNumber, year, brand, playerName,
//     cardNumber, hasSlab, confidence }
//
// Then compares those fields against the parsed hobbyiqCardId identity.
// Verified if grader agrees AND (year AND cardNumber agree). Half-grade
// tolerance (9.5 ~ 9.5), case-insensitive, cardNumber normalized
// (strip # and hyphens; uppercase).
//
// When the image doesn't contain a slab (raw cards), extraction
// returns hasSlab=false and the caller falls through to vision-tokens
// or manual.
//
// Env:
//   AZURE_OPENAI_ENDPOINT             — required (shared with market-read)
//   AZURE_OPENAI_API_KEY | _KEY       — required
//   AZURE_OPENAI_DEPLOYMENT_SLAB_OCR  — preferred vision-capable deployment
//   AZURE_OPENAI_DEPLOYMENT           — fallback deployment
//   AZURE_OPENAI_API_VERSION          — default 2024-08-01-preview
//   SLAB_OCR_ENABLED=true             — feature flag (default off)

export interface SlabLabel {
  hasSlab: boolean;
  grader: "PSA" | "BGS" | "SGC" | "CGC" | "HGA" | "TAG" | "GMA" | null;
  gradeValue: number | null;   // e.g. 10, 9.5, 8
  gradeLabel: string | null;   // e.g. "GEM MT 10", "MINT 9", "PRISTINE 10 BLACK LABEL"
  certNumber: string | null;
  year: number | null;
  brand: string | null;        // as printed on label — "TOPPS CHROME", "BOWMAN", "PANINI PRIZM"
  playerName: string | null;
  cardNumber: string | null;
  confidence: number;          // model's self-assessed 0..1
}

export interface SlabExtractResult {
  ok: boolean;
  label?: SlabLabel;
  error?: string;
  rawResponse?: string;
  modelUsed?: string;
  durationMs: number;
}

const SLAB_LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    hasSlab: {
      type: "boolean",
      description: "True if the image shows a graded card slab (PSA/BGS/SGC/CGC/etc). False if the card is raw or the slab is not visible.",
    },
    grader: {
      type: ["string", "null"],
      enum: ["PSA", "BGS", "SGC", "CGC", "HGA", "TAG", "GMA", null],
      description: "The grading company printed on the slab label.",
    },
    gradeValue: {
      type: ["number", "null"],
      description: "Numeric grade value. E.g. 10 for a Gem Mint 10, 9.5 for a BGS 9.5, 8 for a Mint 8. Never null when a slab is visible.",
    },
    gradeLabel: {
      type: ["string", "null"],
      description: "Full grade text as printed. E.g. 'GEM MT 10', 'MINT 9', 'PRISTINE 10 BLACK LABEL', 'AUTHENTIC'.",
    },
    certNumber: {
      type: ["string", "null"],
      description: "Certification / serial number printed on the label. Digits only when possible.",
    },
    year: {
      type: ["number", "null"],
      description: "4-digit card year as printed on the label. E.g. 2024, 2018.",
    },
    brand: {
      type: ["string", "null"],
      description: "Brand and product line as printed on the label. E.g. 'TOPPS CHROME', 'BOWMAN CHROME', 'PANINI PRIZM'. Include the product qualifier (Chrome, Prizm, Heritage) when present.",
    },
    playerName: {
      type: ["string", "null"],
      description: "Player name as printed on the label. Format: 'FIRST LAST'.",
    },
    cardNumber: {
      type: ["string", "null"],
      description: "Card number as printed on the label. Keep any letter prefix (BCP-102, CPA-EHA, US1). Strip leading '#'.",
    },
    confidence: {
      type: "number",
      description: "Your self-assessed confidence that the extraction is correct, from 0 to 1. Discount for blur, glare, occlusion, unusual angles.",
    },
  },
  required: [
    "hasSlab", "grader", "gradeValue", "gradeLabel", "certNumber",
    "year", "brand", "playerName", "cardNumber", "confidence",
  ],
} as const;

const SYSTEM_PROMPT = `You are a sports card slab label OCR extractor. Given an image of a graded sports card, extract the label fields into structured JSON.

Slab label layouts you must recognize:
- PSA: red border, "PSA" logo, year + brand + player + card # + grade ("GEM MT 10", "MINT 9", "NM-MT 8"). The white flip below the red bar contains the grade.
- BGS (Beckett): black/silver/gold label. Grade appears with 4 subgrades (Centering/Corners/Edges/Surface). "PRISTINE 10 BLACK LABEL" is a distinct designation.
- SGC: green/blue label, large numeric grade, year + player + brand + card #.
- CGC: white label with "CGC" logo, similar layout to PSA.
- HGA / TAG / GMA: less common, use their own colored labels.

Rules:
- If no slab is visible (raw card, no holder), set hasSlab=false and all other fields to null.
- Extract EXACTLY what the label says — do not correct spelling, do not translate brand names.
- cardNumber: preserve letter prefix (BCP-102, CPA-EHA), strip leading '#'.
- gradeValue: numeric only. For "GEM MT 10" that's 10. For "9.5" that's 9.5.
- confidence: your honest self-assessment. If the label is blurry or partially cropped, discount accordingly.
- Return ONLY the JSON object matching the provided schema. No prose.`;

export async function extractSlabLabel(imageUrl: string): Promise<SlabExtractResult> {
  const t0 = Date.now();
  if (process.env.SLAB_OCR_ENABLED !== "true") {
    return { ok: false, error: "SLAB_OCR_ENABLED flag off", durationMs: Date.now() - t0 };
  }

  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? "").trim();
  const apiKey = (process.env.AZURE_OPENAI_API_KEY ?? process.env.AZURE_OPENAI_KEY ?? "").trim();
  const deployment = (
    process.env.AZURE_OPENAI_DEPLOYMENT_SLAB_OCR
    ?? process.env.AZURE_OPENAI_DEPLOYMENT
    ?? ""
  ).trim();
  const apiVersion = (process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview").trim();
  if (!endpoint || !apiKey || !deployment) {
    return { ok: false, error: "Azure OpenAI env not configured", durationMs: Date.now() - t0 };
  }
  if (!imageUrl) {
    return { ok: false, error: "empty imageUrl", durationMs: Date.now() - t0 };
  }

  try {
    const { AzureOpenAI } = await import("openai");
    const client = new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion });
    const response = await client.chat.completions.create(
      {
        model: deployment,
        temperature: 0,
        max_tokens: 500,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "slab_label",
            strict: true,
            schema: SLAB_LABEL_SCHEMA,
          },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the slab label fields from this card image." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      },
      { signal: AbortSignal.timeout(30_000) },
    );

    const raw = response.choices[0]?.message?.content ?? "";
    if (!raw) {
      return { ok: false, error: "empty LLM response", modelUsed: deployment, durationMs: Date.now() - t0 };
    }

    let label: SlabLabel;
    try {
      label = JSON.parse(raw) as SlabLabel;
    } catch (e) {
      return {
        ok: false,
        error: `JSON parse failed: ${(e as Error).message}`,
        rawResponse: raw.slice(0, 500),
        modelUsed: deployment,
        durationMs: Date.now() - t0,
      };
    }

    return {
      ok: true,
      label,
      rawResponse: raw.slice(0, 500),
      modelUsed: deployment,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      error: `LLM call failed: ${(e as Error).message}`,
      modelUsed: deployment,
      durationMs: Date.now() - t0,
    };
  }
}

// ─── Comparison ──────────────────────────────────────────────────────

export interface SlabIdentityCheck {
  matched: boolean;
  agreements: string[];   // fields where slab agrees with parsed identity
  disagreements: string[]; // fields where slab clearly disagrees
  detail: string;
}

export interface ParsedIdentity {
  year: number | null;
  cardNumber: string | null;
  playerName: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  setKey: string | null;
}

/** Compare an extracted slab label against a parsed identity. Returns
 *  matched=true only when there's strong multi-field agreement. Silent-
 *  safe: never throws; returns matched=false on unusable inputs. */
export function checkSlabAgainstIdentity(
  slab: SlabLabel | null | undefined,
  identity: ParsedIdentity,
): SlabIdentityCheck {
  const agreements: string[] = [];
  const disagreements: string[] = [];

  if (!slab || slab.hasSlab === false) {
    return {
      matched: false,
      agreements,
      disagreements,
      detail: "no slab detected in image",
    };
  }

  // Grader match — case-insensitive
  if (identity.gradeCompany && slab.grader) {
    if (identity.gradeCompany.toUpperCase() === slab.grader.toUpperCase()) {
      agreements.push(`grader=${slab.grader}`);
    } else {
      disagreements.push(`grader: parsed=${identity.gradeCompany} slab=${slab.grader}`);
    }
  }

  // Grade value — exact numeric equality (handles half-grades)
  if (identity.gradeValue != null && slab.gradeValue != null) {
    if (Math.abs(identity.gradeValue - slab.gradeValue) < 0.01) {
      agreements.push(`grade=${slab.gradeValue}`);
    } else {
      disagreements.push(`grade: parsed=${identity.gradeValue} slab=${slab.gradeValue}`);
    }
  }

  // Year — exact 4-digit match
  if (identity.year != null && slab.year != null) {
    if (identity.year === slab.year) {
      agreements.push(`year=${slab.year}`);
    } else {
      disagreements.push(`year: parsed=${identity.year} slab=${slab.year}`);
    }
  }

  // cardNumber — normalized: strip #, hyphens, uppercase
  if (identity.cardNumber && slab.cardNumber) {
    const normalize = (s: string) => s.toUpperCase().replace(/^#/, "").replace(/[-\s]/g, "");
    if (normalize(identity.cardNumber) === normalize(slab.cardNumber)) {
      agreements.push(`cardNumber=${slab.cardNumber}`);
    } else {
      disagreements.push(`cardNumber: parsed=${identity.cardNumber} slab=${slab.cardNumber}`);
    }
  }

  // Player name — fuzzy: normalize both, check either contains other
  if (identity.playerName && slab.playerName) {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    const parsed = normalize(identity.playerName);
    const label = normalize(slab.playerName);
    if (parsed && label && (parsed === label || parsed.includes(label) || label.includes(parsed))) {
      agreements.push(`player`);
    } else {
      disagreements.push(`player: parsed=${identity.playerName} slab=${slab.playerName}`);
    }
  }

  // Brand — fuzzy: slug the label brand and check it starts with parsed setKey
  if (identity.setKey && slab.brand) {
    const slugified = slab.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (slugified.startsWith(identity.setKey) || identity.setKey.startsWith(slugified.split("-")[0])) {
      agreements.push(`brand=${slab.brand}`);
    } else {
      disagreements.push(`brand: parsed=${identity.setKey} slab=${slab.brand}`);
    }
  }

  // Match decision: matched when we have year+cardNumber agreement AND
  // no disagreement on grader (if both known). This is the auto-approve
  // bar; anything short falls through to manual.
  const yearAgreed = agreements.some(a => a.startsWith("year="));
  const cardNumberAgreed = agreements.some(a => a.startsWith("cardNumber="));
  const graderDisagreed = disagreements.some(d => d.startsWith("grader:"));

  const matched = yearAgreed && cardNumberAgreed && !graderDisagreed && slab.confidence >= 0.6;

  const detail = matched
    ? `slab-verified: agreements=[${agreements.join(", ")}] confidence=${slab.confidence.toFixed(2)}`
    : `slab-inconclusive: agreements=[${agreements.join(", ")}] disagreements=[${disagreements.join(", ")}] confidence=${slab.confidence.toFixed(2)}`;

  return { matched, agreements, disagreements, detail };
}
