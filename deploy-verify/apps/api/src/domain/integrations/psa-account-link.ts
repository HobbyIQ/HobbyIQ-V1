export interface PsaAccountLink {
  linkId: string;
  userId: string;
  psaUserId?: string | null;
  accessTokenEncrypted?: string | null;
  refreshTokenEncrypted?: string | null;
  tokenExpiresAt?: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
