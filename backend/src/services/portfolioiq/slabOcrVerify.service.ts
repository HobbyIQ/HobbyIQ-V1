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
  // CF-SLAB-OCR-PARALLEL (Drew, 2026-07-29). Parallel and subset are
  // often on the slab label ("REFRACTOR", "GOLD /50", "1ST BOWMAN
  // CHROME AUTO", "SAPPHIRE") but NOT always — the LLM should extract
  // only what the label actually prints. Null when the label doesn't
  // include it (e.g. base cards).
  parallel: string | null;     // e.g. "REFRACTOR", "GOLD REFRACTOR", "SAPPHIRE"
  subset: string | null;       // e.g. "1ST BOWMAN CHROME AUTOGRAPH", "PROSPECTS", "ROOKIE"
  printRun: number | null;     // e.g. 50 for "/50", when printed
  isAuto: boolean | null;      // true if "AUTO"/"AUTOGRAPH" appears on label
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
    parallel: {
      type: ["string", "null"],
      description: "Parallel/variant name as printed on the label. Examples: 'REFRACTOR', 'GOLD REFRACTOR', 'SAPPHIRE', 'PRIZM', 'MOJO REFRACTOR', 'ORANGE REFRACTOR /25'. Null when the label doesn't call out a specific parallel (base cards).",
    },
    subset: {
      type: ["string", "null"],
      description: "Subset name as printed. Examples: '1ST BOWMAN CHROME AUTOGRAPH', 'CHROME PROSPECTS', 'ROOKIE', 'ALL-STAR ROOKIE'. Null when no subset is named.",
    },
    printRun: {
      type: ["number", "null"],
      description: "Print-run denominator when '/N' appears on the label. E.g. 50 for '/50', 499 for '/499'. Null when unnumbered.",
    },
    isAuto: {
      type: ["boolean", "null"],
      description: "True when 'AUTO' or 'AUTOGRAPH' appears on the label. False when the label clearly does NOT include auto text. Null if uncertain.",
    },
    confidence: {
      type: "number",
      description: "Your self-assessed confidence that the extraction is correct, from 0 to 1. Discount for blur, glare, occlusion, unusual angles.",
    },
  },
  required: [
    "hasSlab", "grader", "gradeValue", "gradeLabel", "certNumber",
    "year", "brand", "playerName", "cardNumber",
    "parallel", "subset", "printRun", "isAuto",
    "confidence",
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
- parallel: extract only if the label EXPLICITLY names one — "REFRACTOR", "GOLD REFRACTOR", "SAPPHIRE", "PRIZM", "MOJO REFRACTOR", "SPECKLE REFRACTOR", "1ST WAVE REFRACTOR". If the label just says "BOWMAN CHROME" with no parallel modifier, this is null (base). Do NOT infer parallel from the card image — only from the LABEL TEXT.
- subset: extract subset text as printed — "1ST BOWMAN CHROME AUTOGRAPH", "CHROME PROSPECTS", "ROOKIE", "ALL-STAR ROOKIE". Null when no subset is named.
- printRun: extract N when "/N" or "N/M" appears on the label (report the M denominator). Null when unnumbered.
- isAuto: true when "AUTO" or "AUTOGRAPH" appears on the label; false when clearly absent; null when uncertain.
- confidence: your honest self-assessment. If the label is blurry or partially cropped, discount accordingly.
- Return ONLY the JSON object matching the provided schema. No prose.`;

/** Rewrite common vendor thumbnail URLs to their full-resolution
 *  equivalents. Critical for OCR: slab-label text at 140px is
 *  unreadable; at 1600px it's crisp. Silent-safe — returns the
 *  original URL when no rewrite pattern matches.
 *
 *  eBay pattern: s-l64.jpg / s-l140.jpg / s-l500.jpg → s-l1600.jpg */
export function upscaleImageUrl(url: string): string {
  if (!url) return url;
  // eBay image sizes: s-l{N}.jpg, s-l{N}.webp
  return url.replace(/\/s-l\d+(\.(?:jpg|jpeg|png|webp))/i, "/s-l1600$1");
}

/** Extract structured slab-label fields from a card image.
 *  Does NOT check SLAB_OCR_ENABLED — that gate belongs to the call
 *  site (imageVerifyJob) so exploratory tools (prototype-slab-ocr.cjs)
 *  can invoke this directly without flipping the prod flag. */
export async function extractSlabLabel(imageUrl: string): Promise<SlabExtractResult> {
  const t0 = Date.now();
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

  const highResUrl = upscaleImageUrl(imageUrl);

  const { AzureOpenAI } = await import("openai");
  const client = new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion });

  // CF-SLAB-OCR-RETRY (Drew, 2026-07-29). First batch apply against
  // 200 rows saw many 429s from gpt-4o-mini's TPM cap. Retry with
  // exponential backoff on 429/500/503; give up on 4xx-not-429 and
  // network-level failures. Never throws — returns SlabExtractResult
  // either way.
  const MAX_ATTEMPTS = 3;
  let lastError: string = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
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
                { type: "image_url", image_url: { url: highResUrl, detail: "high" } },
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
      const msg = (e as Error).message ?? String(e);
      lastError = msg;
      const isRetryable = /\b(429|500|502|503|504)\b/i.test(msg) || /rate\s?limit|throttl|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        return {
          ok: false,
          error: `LLM call failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${msg}`,
          modelUsed: deployment,
          durationMs: Date.now() - t0,
        };
      }
      // Exponential backoff with jitter: 1s, 3s, 7s
      const delayMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 1000) - 500;
      await new Promise(res => setTimeout(res, Math.max(500, delayMs)));
    }
  }
  return {
    ok: false,
    error: `LLM call failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    modelUsed: deployment,
    durationMs: Date.now() - t0,
  };
}

// ─── Comparison ──────────────────────────────────────────────────────

export interface SlabIdentityCheck {
  matched: boolean;
  agreements: string[];   // fields where slab agrees with parsed identity
  disagreements: string[]; // fields where slab clearly disagrees
  // CF-SLAB-OCR-ADOPT (Drew, 2026-07-29). When parser is null on a
  // field but the slab has a confident value, we "adopt" the slab
  // value as an agreement — and the caller can apply it as a
  // correction on approve. Prototype v5 showed multiple cases where
  // the parser had no cardNumber but the LLM cleanly read one from
  // the label; that's a strict IMPROVEMENT the queue should absorb.
  adopted: Array<{ field: "cardNumber" | "parallel" | "printRun" | "isAuto" | "gradeCompany" | "gradeValue"; value: string | number | boolean }>;
  detail: string;
}

export interface ParsedIdentity {
  year: number | null;
  cardNumber: string | null;
  playerName: string | null;
  gradeCompany: string | null;
  gradeValue: number | null;
  setKey: string | null;
  parallel: string | null;
  printRun: number | null;
  isAuto: boolean | null;
}

/** Compare an extracted slab label against a parsed identity. Returns
 *  matched=true when there's strong multi-field agreement (with any
 *  parser-null field the slab confidently filled treated as an
 *  "adoption" rather than a blocker). Silent-safe: never throws;
 *  returns matched=false on unusable inputs.
 *
 *  Match bar: (year AND (cardNumber OR adopted-cardNumber)) AND
 *             player agreement AND grader NOT-disagreed AND
 *             confidence >= 0.6. */
export function checkSlabAgainstIdentity(
  slab: SlabLabel | null | undefined,
  identity: ParsedIdentity,
): SlabIdentityCheck {
  const agreements: string[] = [];
  const disagreements: string[] = [];
  const adopted: SlabIdentityCheck["adopted"] = [];

  if (!slab || slab.hasSlab === false) {
    return {
      matched: false,
      agreements,
      disagreements,
      adopted,
      detail: "no slab detected in image",
    };
  }

  // Grader match — case-insensitive.
  // ADOPTION: parser had no grader (thought card was raw) but slab
  // clearly shows one at HIGH confidence — adopt (this is a big data
  // improvement because raw vs graded FMV differs 5-30x). Bar 0.9,
  // stricter than other adoptions.
  if (identity.gradeCompany && slab.grader) {
    if (identity.gradeCompany.toUpperCase() === slab.grader.toUpperCase()) {
      agreements.push(`grader=${slab.grader}`);
    } else {
      disagreements.push(`grader: parsed=${identity.gradeCompany} slab=${slab.grader}`);
    }
  } else if (!identity.gradeCompany && slab.grader && slab.confidence >= 0.9) {
    adopted.push({ field: "gradeCompany", value: slab.grader });
    agreements.push(`grader=${slab.grader} (adopted)`);
  }

  // Grade value — exact numeric equality (handles half-grades).
  // Same adoption pattern for the numeric grade.
  if (identity.gradeValue != null && slab.gradeValue != null) {
    if (Math.abs(identity.gradeValue - slab.gradeValue) < 0.01) {
      agreements.push(`grade=${slab.gradeValue}`);
    } else {
      disagreements.push(`grade: parsed=${identity.gradeValue} slab=${slab.gradeValue}`);
    }
  } else if (identity.gradeValue == null && slab.gradeValue != null && slab.confidence >= 0.9) {
    adopted.push({ field: "gradeValue", value: slab.gradeValue });
    agreements.push(`grade=${slab.gradeValue} (adopted)`);
  }

  // Year — exact 4-digit match
  if (identity.year != null && slab.year != null) {
    if (identity.year === slab.year) {
      agreements.push(`year=${slab.year}`);
    } else {
      disagreements.push(`year: parsed=${identity.year} slab=${slab.year}`);
    }
  }

  // cardNumber — normalized: strip #, hyphens, uppercase, AND strip
  // leading zeros on pure-numeric card numbers ("87" == "087").
  // ADOPTION: parser-null + slab-has-value → adopt as agreement.
  const parsedCardNumber = (identity.cardNumber ?? "").trim();
  if (parsedCardNumber && slab.cardNumber) {
    const normalize = (s: string) => {
      const stripped = s.toUpperCase().replace(/^#/, "").replace(/[-\s]/g, "");
      // Leading-zero strip: pure-digit strings only ("087" → "87").
      // Preserves letter-prefixed numbers (BCP-102 → BCP102).
      if (/^\d+$/.test(stripped)) return stripped.replace(/^0+/, "") || "0";
      return stripped;
    };
    if (normalize(parsedCardNumber) === normalize(slab.cardNumber)) {
      agreements.push(`cardNumber=${slab.cardNumber}`);
    } else {
      disagreements.push(`cardNumber: parsed=${identity.cardNumber} slab=${slab.cardNumber}`);
    }
  } else if (!parsedCardNumber && slab.cardNumber && slab.confidence >= 0.8) {
    // Parser had no cardNumber; slab has one at high confidence → adopt.
    adopted.push({ field: "cardNumber", value: slab.cardNumber });
    agreements.push(`cardNumber=${slab.cardNumber} (adopted)`);
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

  // Parallel — case-insensitive contains OR adopt when parser had "base"/null.
  // Parallel is often absent from the slab; NEVER treat missing as disagreement.
  if (slab.parallel) {
    const parsedParallel = (identity.parallel ?? "").toLowerCase().trim();
    const labelParallel = slab.parallel.toLowerCase();
    const isBaseParsed = !parsedParallel || parsedParallel === "base";
    if (isBaseParsed && slab.confidence >= 0.8) {
      adopted.push({ field: "parallel", value: slab.parallel });
      agreements.push(`parallel=${slab.parallel} (adopted)`);
    } else if (parsedParallel && (labelParallel.includes(parsedParallel) || parsedParallel.includes(labelParallel))) {
      agreements.push(`parallel=${slab.parallel}`);
    } else if (parsedParallel && !isBaseParsed) {
      // Both known, neither contains the other → soft disagreement,
      // does NOT block the match (parallel language varies).
      disagreements.push(`parallel(soft): parsed=${identity.parallel} slab=${slab.parallel}`);
    }
  }

  // printRun — adopt when parser is null; verify when both present
  if (slab.printRun != null) {
    if (identity.printRun == null && slab.confidence >= 0.8) {
      adopted.push({ field: "printRun", value: slab.printRun });
      agreements.push(`printRun=${slab.printRun} (adopted)`);
    } else if (identity.printRun === slab.printRun) {
      agreements.push(`printRun=${slab.printRun}`);
    } else if (identity.printRun != null) {
      disagreements.push(`printRun: parsed=${identity.printRun} slab=${slab.printRun}`);
    }
  }

  // isAuto — adopt when parser is null; verify when both present
  if (slab.isAuto != null) {
    if (identity.isAuto == null && slab.confidence >= 0.8) {
      adopted.push({ field: "isAuto", value: slab.isAuto });
      agreements.push(`isAuto=${slab.isAuto} (adopted)`);
    } else if (identity.isAuto === slab.isAuto) {
      agreements.push(`isAuto=${slab.isAuto}`);
    } else if (identity.isAuto != null && identity.isAuto !== slab.isAuto) {
      // Only flag as disagreement when identity says NO but slab says
      // YES (or vice versa). Preserve HIGHER trust: label is truth.
      disagreements.push(`isAuto: parsed=${identity.isAuto} slab=${slab.isAuto}`);
    }
  }

  // Match decision (relaxed): matched when
  //   year AGREED
  //   AND (cardNumber AGREED — either exact or adopted)
  //   AND player AGREED
  //   AND grader NOT-disagreed (if both were known)
  //   AND confidence >= 0.6
  //
  // Adopted counts as agreement. Soft parallel/printRun/isAuto
  // disagreements do NOT block the match — those are informational.
  const yearAgreed = agreements.some(a => a.startsWith("year="));
  const cardNumberAgreed = agreements.some(a => a.startsWith("cardNumber="));
  const playerAgreed = agreements.some(a => a === "player");
  const graderDisagreed = disagreements.some(d => d.startsWith("grader:"));
  const hardDisagreement = disagreements.some(d =>
    d.startsWith("grader:") || d.startsWith("year:") || d.startsWith("cardNumber:") || d.startsWith("grade:")
  );

  const matched = yearAgreed
    && cardNumberAgreed
    && playerAgreed
    && !hardDisagreement
    && !graderDisagreed
    && slab.confidence >= 0.6;

  const detail = matched
    ? `slab-verified: agreements=[${agreements.join(", ")}] confidence=${slab.confidence.toFixed(2)}`
    : `slab-inconclusive: agreements=[${agreements.join(", ")}] disagreements=[${disagreements.join(", ")}] confidence=${slab.confidence.toFixed(2)}`;

  return { matched, agreements, disagreements, adopted, detail };
}
