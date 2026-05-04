// Environment config loader for HobbyIQ backend
export function getConfig() {
  return {
    NODE_ENV: process.env.NODE_ENV || "development",
    PORT: process.env.PORT || 8080,
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || "*",
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    SERVICE_BUS_CONNECTION: process.env.SERVICE_BUS_CONNECTION,
    STORAGE_ACCOUNT_NAME: process.env.STORAGE_ACCOUNT_NAME,
    KEY_VAULT_NAME: process.env.KEY_VAULT_NAME,
    APPLICATIONINSIGHTS_CONNECTION_STRING: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    ENABLE_DEBUG_PRICING: process.env.ENABLE_DEBUG_PRICING === "true",
    ENABLE_AI_SEARCH: process.env.ENABLE_AI_SEARCH === "true",
    ENABLE_NOTIFICATIONS: process.env.ENABLE_NOTIFICATIONS === "true"
  };
}
