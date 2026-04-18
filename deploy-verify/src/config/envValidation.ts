import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  // Add more required env vars as needed
});

export function validateEnv(env: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error('Invalid environment configuration: ' + JSON.stringify(result.error.issues));
  }
}
