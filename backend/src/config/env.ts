// Environment config loader for HobbyIQ backend

// CF-FINALIZE (2026-06-03): CORS_ALLOWED_ORIGINS parsing.
//
// Returns one of:
//   false       — REJECT all cross-origin requests (no Access-Control-
//                 Allow-Origin header is emitted). Triggered by an unset,
//                 empty, "none", or "false" env value. iOS-native callers
//                 (no Origin header) are unaffected — CORS only applies
//                 to browser cross-origin requests.
//   "*"         — wildcard (any origin allowed). Only when env value is
//                 literally "*".
//   string[]    — explicit allow-list, comma-separated in the env value.
//
// Was: a bare string fallback that, with CORS_ALLOWED_ORIGINS=false,
// produced the malformed "Access-Control-Allow-Origin: false" echo. The
// new shape gives the cors() middleware an unambiguous signal.
export function parseCorsAllowedOrigins(
  raw: string | undefined,
): boolean | string | string[] {
  const trimmed = (raw ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (trimmed === "" || lower === "none" || lower === "false") return false;
  if (trimmed === "*") return "*";
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getConfig() {
  return {
    NODE_ENV: process.env.NODE_ENV || "development",
    PORT: process.env.PORT || 8080,
    CORS_ALLOWED_ORIGINS: parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    SERVICE_BUS_CONNECTION: process.env.SERVICE_BUS_CONNECTION,
    STORAGE_ACCOUNT_NAME: process.env.STORAGE_ACCOUNT_NAME,
    KEY_VAULT_NAME: process.env.KEY_VAULT_NAME,
    APPLICATIONINSIGHTS_CONNECTION_STRING: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    // CF-DEAD-FLAG-SWEEP (audit PR #488, 2026-07-15): ENABLE_DEBUG_PRICING /
    // ENABLE_AI_SEARCH / ENABLE_NOTIFICATIONS retired — parsed into config
    // for months but never referenced. Also removed from infra/main.json
    // and infra/modules/app-service.bicep so App Service stops deploying
    // empty env values for them.
    OCR_INTERNAL_ENABLED: process.env.OCR_INTERNAL_ENABLED === "true",
    OCR_INTERNAL_KEY: process.env.OCR_INTERNAL_KEY || ""
  };
}
