export interface IntegrationsConfig {
  ebayEnabled: boolean;
  psaEnabled: boolean;
  ebaySyncInventoryEnabled: boolean;
  ebaySyncOrdersEnabled: boolean;
  psaSyncSubmissionsEnabled: boolean;
  psaSyncCertsEnabled: boolean;
  syncDefaultLookbackDays: number;
  syncMaxPagesPerRun: number;
  encryptTokens: boolean;
  autoMatchToPortfolioEnabled: boolean;
  ebayClientId: string;
  ebayClientSecret: string;
  ebayRedirectUri: string;
  psaClientId: string;
  psaClientSecret: string;
  psaRedirectUri: string;
}

export const integrationsConfig: IntegrationsConfig = {
  ebayEnabled: process.env.INTEGRATIONS_EBAY_ENABLED === 'true',
  psaEnabled: process.env.INTEGRATIONS_PSA_ENABLED === 'true',
  ebaySyncInventoryEnabled: process.env.INTEGRATIONS_EBAY_SYNC_INVENTORY === 'true',
  ebaySyncOrdersEnabled: process.env.INTEGRATIONS_EBAY_SYNC_ORDERS === 'true',
  psaSyncSubmissionsEnabled: process.env.INTEGRATIONS_PSA_SYNC_SUBMISSIONS === 'true',
  psaSyncCertsEnabled: process.env.INTEGRATIONS_PSA_SYNC_CERTS === 'true',
  syncDefaultLookbackDays: Number(process.env.INTEGRATIONS_DEFAULT_LOOKBACK_DAYS ?? 30),
  syncMaxPagesPerRun: Number(process.env.INTEGRATIONS_MAX_PAGES_PER_RUN ?? 20),
  encryptTokens: process.env.INTEGRATIONS_ENCRYPT_TOKENS !== 'false',
  autoMatchToPortfolioEnabled: process.env.INTEGRATIONS_AUTO_MATCH_TO_PORTFOLIO === 'true',
  ebayClientId: process.env.EBAY_CLIENT_ID || '',
  ebayClientSecret: process.env.EBAY_CLIENT_SECRET || '',
  ebayRedirectUri: process.env.EBAY_REDIRECT_URI || '',
  psaClientId: process.env.PSA_CLIENT_ID || '',
  psaClientSecret: process.env.PSA_CLIENT_SECRET || '',
  psaRedirectUri: process.env.PSA_REDIRECT_URI || '',
};
