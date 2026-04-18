import dotenv from 'dotenv';
dotenv.config();

export interface ProviderConfig {
  ebay: {
    enabled: boolean;
    clientId?: string;
    clientSecret?: string;
    authConfigured: boolean;
    syncEnabled: boolean;
    dryRun: boolean;
  };
  psa: {
    enabled: boolean;
    apiKey?: string;
    authConfigured: boolean;
    syncEnabled: boolean;
    dryRun: boolean;
  };
  redis: {
    enabled: boolean;
    url?: string;
    reachable: boolean;
  };
  queue: {
    enabled: boolean;
    provider?: string;
    reachable: boolean;
  };
  encryption: {
    enabled: boolean;
    keyConfigured: boolean;
  };
  email: {
    enabled: boolean;
    provider?: string;
    configured: boolean;
  };
}

function required(name: string, fallback?: string): string {
  const val = process.env[name] || fallback;
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}

export function loadProviderConfig(): ProviderConfig {
  return {
    ebay: {
      enabled: process.env.EBAY_ENABLED === 'true',
      clientId: process.env.EBAY_CLIENT_ID,
      clientSecret: process.env.EBAY_CLIENT_SECRET,
      authConfigured: !!process.env.EBAY_CLIENT_ID && !!process.env.EBAY_CLIENT_SECRET,
      syncEnabled: process.env.EBAY_SYNC_ENABLED !== 'false',
      dryRun: process.env.EBAY_DRY_RUN === 'true',
    },
    psa: {
      enabled: process.env.PSA_ENABLED === 'true',
      apiKey: process.env.PSA_API_KEY,
      authConfigured: !!process.env.PSA_API_KEY,
      syncEnabled: process.env.PSA_SYNC_ENABLED !== 'false',
      dryRun: process.env.PSA_DRY_RUN === 'true',
    },
    redis: {
      enabled: !!process.env.REDIS_URL,
      url: process.env.REDIS_URL,
      reachable: true, // Set by health check
    },
    queue: {
      enabled: !!process.env.QUEUE_PROVIDER,
      provider: process.env.QUEUE_PROVIDER,
      reachable: true, // Set by health check
    },
    encryption: {
      enabled: !!process.env.ENCRYPTION_KEY,
      keyConfigured: !!process.env.ENCRYPTION_KEY,
    },
    email: {
      enabled: !!process.env.EMAIL_PROVIDER,
      provider: process.env.EMAIL_PROVIDER,
      configured: !!process.env.EMAIL_PROVIDER,
    },
  };
}
