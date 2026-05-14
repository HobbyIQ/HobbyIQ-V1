type AnyObject = Record<string, unknown>;

const DEFAULT_PSA_BASE_URL = "https://api.psacard.com/publicapi";

export class PsaApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status = 500, code = "PSA_API_ERROR") {
    super(message);
    this.name = "PsaApiError";
    this.status = status;
    this.code = code;
  }
}

export interface PsaCertLookupResult {
  source: "psa-public-api";
  certNumber: string;
  certificationType: "PSA" | "DNA" | "UNKNOWN";
  card: {
    year: string | null;
    brand: string | null;
    category: string | null;
    cardNumber: string | null;
    subject: string | null;
    variety: string | null;
    grade: string | null;
    gradeDescription: string | null;
    specId: number | null;
    itemStatus: string | null;
    totalPopulation: number | null;
    populationHigher: number | null;
  } | null;
  raw: unknown;
}

function asObject(value: unknown): AnyObject | null {
  return value && typeof value === "object" ? (value as AnyObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBearerToken(rawToken: string): string {
  return rawToken.startsWith("Bearer ") ? rawToken : `Bearer ${rawToken}`;
}

function readPsaBearerToken(): string {
  const token = String(process.env.PSA_API_BEARER_TOKEN ?? process.env.PSA_BEARER_TOKEN ?? "").trim();
  if (!token) {
    throw new PsaApiError("PSA API token not configured", 500, "PSA_TOKEN_MISSING");
  }
  return normalizeBearerToken(token);
}

function readPsaBaseUrl(): string {
  return String(process.env.PSA_API_BASE_URL ?? DEFAULT_PSA_BASE_URL).replace(/\/$/, "");
}

export async function lookupPsaCertByNumber(certNumber: string): Promise<PsaCertLookupResult> {
  const normalizedCertNumber = certNumber.trim();
  if (!normalizedCertNumber) {
    throw new PsaApiError("certNumber is required", 400, "PSA_CERT_MISSING");
  }

  const token = readPsaBearerToken();
  const timeoutMs = Number(process.env.PSA_API_TIMEOUT_MS ?? 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${readPsaBaseUrl()}/cert/GetByCertNumber/${encodeURIComponent(normalizedCertNumber)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: token,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PsaApiError("PSA token unauthorized or expired", 502, "PSA_AUTH_FAILED");
      }
      if (response.status === 429) {
        throw new PsaApiError("PSA API quota exceeded", 429, "PSA_QUOTA_EXCEEDED");
      }
      throw new PsaApiError(`PSA request failed (${response.status})`, 502, "PSA_REQUEST_FAILED");
    }

    let parsed: unknown = rawText;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Keep raw text when upstream sends non-JSON payloads.
    }

    const root = asObject(parsed);
    const psaCert = root ? asObject(root.PSACert) : null;
    const dnaCert = root ? asObject(root.DNACert) : null;
    const card = psaCert ?? dnaCert;

    return {
      source: "psa-public-api",
      certNumber: normalizedCertNumber,
      certificationType: psaCert ? "PSA" : dnaCert ? "DNA" : "UNKNOWN",
      card: card
        ? {
            year: asString(card.Year),
            brand: asString(card.Brand),
            category: asString(card.Category),
            cardNumber: asString(card.CardNumber),
            subject: asString(card.Subject),
            variety: asString(card.Variety),
            grade: asString(card.CardGrade) ?? asString(card.Grade),
            gradeDescription: asString(card.GradeDescription),
            specId: asNumber(card.SpecID),
            itemStatus: asString(card.ItemStatus),
            totalPopulation: asNumber(card.TotalPopulation),
            populationHigher: asNumber(card.PopulationHigher),
          }
        : null,
      raw: parsed,
    };
  } catch (error: unknown) {
    if (error instanceof PsaApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new PsaApiError("PSA request timed out", 504, "PSA_TIMEOUT");
    }
    const message = error instanceof Error ? error.message : "Unknown PSA request failure";
    throw new PsaApiError(message, 502, "PSA_REQUEST_ERROR");
  } finally {
    clearTimeout(timer);
  }
}
