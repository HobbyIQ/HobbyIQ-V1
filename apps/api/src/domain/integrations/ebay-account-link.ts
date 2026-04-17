export interface EbayAccountLink {
  linkId: string;
  userId: string;
  ebayUserId?: string | null;
  username?: string | null;
  accessTokenEncrypted?: string | null;
  refreshTokenEncrypted?: string | null;
  tokenExpiresAt?: string | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
