import { User, Session, SubscriptionPlan, AuthResponse } from "./types";
import crypto from "crypto";

// In-memory user/session store (replace with DB in prod)
const users: Record<string, User> = {};
const sessions: Record<string, Session> = {};

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function signUp(email: string, password: string): Promise<AuthResponse> {
  if (!email || !password) return { success: false, error: "Email and password required" };
  if (Object.values(users).find(u => u.email === email)) return { success: false, error: "Email already registered" };
  const userId = generateId();
  const user: User = {
    userId,
    email,
    passwordHash: hashPassword(password),
    plan: "free",
    createdAt: new Date().toISOString(),
  };
  users[userId] = user;
  return { success: true, user };
}

export async function signIn(email: string, password: string): Promise<AuthResponse> {
  const user = Object.values(users).find(u => u.email === email);
  if (!user) return { success: false, error: "Invalid credentials" };
  if (user.passwordHash !== hashPassword(password)) return { success: false, error: "Invalid credentials" };
  const sessionId = generateId();
  const session: Session = {
    sessionId,
    userId: user.userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(), // 7 days
  };
  sessions[sessionId] = session;
  return { success: true, user, sessionId };
}

export async function signOut(sessionId: string): Promise<AuthResponse> {
  delete sessions[sessionId];
  return { success: true };
}

export async function getSession(sessionId: string): Promise<Session | null> {
  return sessions[sessionId] || null;
}

export async function getUserBySession(sessionId: string): Promise<User | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  return users[session.userId] || null;
}

export async function getUserById(userId: string): Promise<User | null> {
  return users[userId] || null;
}

export async function setUserPlan(userId: string, plan: SubscriptionPlan): Promise<boolean> {
  const user = users[userId];
  if (!user) return false;
  user.plan = plan;
  return true;
}
