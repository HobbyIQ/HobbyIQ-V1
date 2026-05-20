import crypto from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

type SubscriptionPlan = "free" | "pro" | "all-star";

interface AuthUserRecord {
  userId: string;
  email: string;
  aliases: string[];
  passwordHash: string;
  plan: SubscriptionPlan;
  createdAt: string;
}

export interface AuthUser {
  userId: string;
  email: string;
  plan: SubscriptionPlan;
  createdAt: string;
}

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  sessionId?: string;
  error?: string;
}

const users: Record<string, AuthUserRecord> = {};
const dataDir = path.resolve(process.cwd(), ".data");
const authUsersPath = path.join(dataDir, "auth-users.json");

const SEEDED_USERS = [
  {
    userId: "admin-testing-hobbyiq",
    email: "drew@justtheboysandcards.com",
    aliases: ["HobbyIQ"],
    password: "Baseball25",
    plan: "all-star" as SubscriptionPlan,
  },
  {
    userId: "personal-justtheboysandcards",
    email: "justtheboysandcards@justtheboysandcards.com",
    aliases: ["JusttheBoysandCards"],
    password: "Carolina23",
    plan: "all-star" as SubscriptionPlan,
  },
];

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_SECRET = process.env.AUTH_SESSION_SECRET ?? "hobbyiq-admin-testing-session-secret";

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function generateId(): string {
  return crypto.randomUUID();
}

function createSessionToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    nonce: generateId(),
  })).toString("base64url");

  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readSessionToken(sessionToken: string): { userId: string; expiresAt: number } | null {
  const [payload, signature] = sessionToken.split(".");
  if (!payload || !signature) return null;

  const expectedSignature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest();
  const actualSignature = Buffer.from(signature, "base64url");
  if (actualSignature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { userId?: string; expiresAt?: number };
    if (!decoded.userId || typeof decoded.expiresAt !== "number") return null;
    if (decoded.expiresAt <= Date.now()) return null;
    return { userId: decoded.userId, expiresAt: decoded.expiresAt };
  } catch {
    return null;
  }
}

function toAuthUser(user: AuthUserRecord): AuthUser {
  return {
    userId: user.userId,
    email: user.email,
    plan: user.plan,
    createdAt: user.createdAt,
  };
}

function seedUsers() {
  for (const seededUser of SEEDED_USERS) {
    users[seededUser.userId] = {
      userId: seededUser.userId,
      email: seededUser.email,
      aliases: seededUser.aliases,
      passwordHash: hashPassword(seededUser.password),
      plan: seededUser.plan,
      createdAt: new Date().toISOString(),
    };
  }
}

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function loadPersistedUsers() {
  try {
    const raw = await readFile(authUsersPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, AuthUserRecord>;
    for (const [userId, user] of Object.entries(parsed)) {
      users[userId] = user;
    }
  } catch {
    // No persisted auth store yet. Seed users below.
  }
}

async function persistUsers() {
  await ensureDataDir();
  await writeFile(authUsersPath, JSON.stringify(users, null, 2), "utf8");
}

function findUser(identifier: string): AuthUserRecord | undefined {
  const normalized = identifier.trim().toLowerCase();
  return Object.values(users).find((user) => {
    const normalizedEmail = user.email.trim().toLowerCase();
    if (normalizedEmail === normalized) return true;
    return user.aliases.some((alias) => alias.trim().toLowerCase() === normalized);
  });
}

function createUserRecord(email: string, password: string): AuthUserRecord {
  const normalizedEmail = email.trim();
  return {
    userId: `user-${generateId()}`,
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    plan: "free",
    createdAt: new Date().toISOString(),
  };
}

seedUsers();
const authStoreReady = (async () => {
  await loadPersistedUsers();
  await persistUsers();
})();

export async function signIn(identifier: string, password: string): Promise<AuthResult> {
  await authStoreReady;

  if (!identifier || !password) {
    return { success: false, error: "Email and password required" };
  }

  const user = findUser(identifier);
  if (!user || user.passwordHash !== hashPassword(password)) {
    return { success: false, error: "Invalid credentials" };
  }

  const sessionId = createSessionToken(user.userId);
  return { success: true, user: toAuthUser(user), sessionId };
}

export async function signUp(identifier: string, password: string): Promise<AuthResult> {
  await authStoreReady;

  if (!identifier || !password) {
    return { success: false, error: "Username and password required" };
  }

  const normalized = identifier.trim().toLowerCase();
  const existingUser = Object.values(users).find((user) => user.email.trim().toLowerCase() === normalized);
  if (existingUser) {
    return { success: false, error: "An account already exists for that email" };
  }

  const user = createUserRecord(identifier, password);
  users[user.userId] = user;
  await persistUsers();

  const sessionId = createSessionToken(user.userId);
  return { success: true, user: toAuthUser(user), sessionId };
}

export async function signOut(_sessionId: string): Promise<AuthResult> {
  await authStoreReady;
  return { success: true };
}

export async function getUserBySession(sessionId: string): Promise<AuthUser | null> {
  await authStoreReady;

  const session = readSessionToken(sessionId);
  if (!session) return null;

  const user = users[session.userId];
  return user ? toAuthUser(user) : null;
}
