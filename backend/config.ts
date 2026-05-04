// Centralized config loader for Azure deployment
// Loads from environment variables, Key Vault, or .env as fallback

import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 8080,
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  serviceBusConnection: process.env.SERVICE_BUS_CONNECTION || '',
  storageAccount: process.env.AZURE_STORAGE_ACCOUNT || '',
  appInsightsConnectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || '',
  keyVaultName: process.env.KEY_VAULT_NAME || '',
  environment: process.env.NODE_ENV || 'production',
};
