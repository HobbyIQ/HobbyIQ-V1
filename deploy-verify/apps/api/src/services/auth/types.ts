// Auth/session models

export interface User {
  userId: string;
  email: string;
  passwordHash: string;
  plan: SubscriptionPlan;
  createdAt: string;
}

export interface Session {
  sessionId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export type SubscriptionPlan = "free" | "pro" | "all-star";

export interface AuthResponse {
  success: boolean;
  user?: User;
  sessionId?: string;
  error?: string;
}
