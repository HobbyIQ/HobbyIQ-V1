// src/config/env.ts
import dotenv from "dotenv";
dotenv.config();


function parseEnvVar(key: string, fallback: any, required = false): any {
  const val = process.env[key];
  if (val === undefined || val === "") {
    if (required && process.env.AI_MODE === "azure") {
      // Beta: suppress env var warning
    }
    return fallback;
  }
  if (typeof fallback === "number") return Number(val);
  if (typeof fallback === "boolean") return val === "true";
  return val;
}

export const env = {
  PORT: parseEnvVar("PORT", 4000),
  NODE_ENV: parseEnvVar("NODE_ENV", "development"),
  CLIENT_APP_URL: parseEnvVar("CLIENT_APP_URL", "https://hobbyiq-andjgvhgfbhfcuhv.centralus-01.azurewebsites.net"),
  AI_MODE: parseEnvVar("AI_MODE", "mock"),
  AZURE_OPENAI_ENDPOINT: parseEnvVar("AZURE_OPENAI_ENDPOINT", "", true),
  AZURE_OPENAI_API_KEY: parseEnvVar("AZURE_OPENAI_API_KEY", "", true),
  AZURE_OPENAI_DEPLOYMENT: parseEnvVar("AZURE_OPENAI_DEPLOYMENT", "", true),
  AZURE_AI_SEARCH_ENDPOINT: parseEnvVar("AZURE_AI_SEARCH_ENDPOINT", "", true),
  AZURE_AI_SEARCH_API_KEY: parseEnvVar("AZURE_AI_SEARCH_API_KEY", "", true),
  AZURE_AI_SEARCH_INDEX: parseEnvVar("AZURE_AI_SEARCH_INDEX", "", true),
  AZURE_STORAGE_CONNECTION_STRING: parseEnvVar("AZURE_STORAGE_CONNECTION_STRING", "", true),
  AZURE_STORAGE_CONTAINER: parseEnvVar("AZURE_STORAGE_CONTAINER", "", true),
  REDIS_URL: parseEnvVar("REDIS_URL", "", true),
  APPLICATIONINSIGHTS_CONNECTION_STRING: parseEnvVar("APPLICATIONINSIGHTS_CONNECTION_STRING", "", true),
  ENABLE_LEARNING_JOBS: parseEnvVar("ENABLE_LEARNING_JOBS", true),
  ENABLE_AUTO_WEIGHT_UPDATES: parseEnvVar("ENABLE_AUTO_WEIGHT_UPDATES", false),
  ENABLE_PROMPT_EXPERIMENTS: parseEnvVar("ENABLE_PROMPT_EXPERIMENTS", true),
  MAX_WEEKLY_WEIGHT_CHANGE: parseEnvVar("MAX_WEEKLY_WEIGHT_CHANGE", 0.05),
  MIN_SAMPLE_SIZE_FOR_RECALIBRATION: parseEnvVar("MIN_SAMPLE_SIZE_FOR_RECALIBRATION", 25),
  DEFAULT_ALERT_COOLDOWN_MINUTES: parseEnvVar("DEFAULT_ALERT_COOLDOWN_MINUTES", 180),
};

export function checkLearningReadiness() {
  if (env.AI_MODE !== "azure") return { ready: true, mode: env.AI_MODE, missing: [] };
  const required = [
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_DEPLOYMENT",
    "AZURE_AI_SEARCH_ENDPOINT",
    "AZURE_AI_SEARCH_API_KEY",
    "AZURE_AI_SEARCH_INDEX",
    "AZURE_STORAGE_CONNECTION_STRING",
    "AZURE_STORAGE_CONTAINER",
    "REDIS_URL",
    "APPLICATIONINSIGHTS_CONNECTION_STRING"
  ];
  const missing = required.filter(k => !process.env[k]);
  return { ready: missing.length === 0, mode: env.AI_MODE, missing };
}
