import crypto from "crypto";
import { promisify } from "util";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { verifyAppleIdentityToken } from "./appleAuth.js";

type SubscriptionPlan = "free" | "pro" | "all-star";

interface AuthUserRecord {
  id: string;             // Cosmos id (== userId)
  userId: string;
  email: string;
  emailLower: string;
  usernameLower: string | null;
  aliases: string[];
  passwordHash: string;
  passwordAlgo?: "scrypt" | "sha256" | "apple-oauth";
  plan: SubscriptionPlan;
  createdAt: string;
  fullName?: string | null;
  appleSub?: string | null;
  docType: "user";
}

export interface AuthUser {
  userId: string;
  email: string;
  username?: string | null;
  fullName?: string | null;
  plan: SubscriptionPlan;
  createdAt: string;
}

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  sessionId?: string;
  error?: string;
}

// ─── Cosmos client (lazy init) ───────────────────────────────────────────────
let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;
const isTestMode = process.env.NODE_ENV === "test";
const memStore = new Map<string, AuthUserRecord>(); // fallback when Cosmos unset

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName = process.env.COSMOS_USERS_CONTAINER ?? "users";

      if (!endpoint && !connStr) {
        if (isTestMode) {
          console.log("[auth] TEST MODE: using in-memory user store");
          return null;
        }
        console.warn("[auth] COSMOS not configured — falling back to in-memory store");
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({
          endpoint: endpoint!,
          aadCredentials: new DefaultAzureCredential(),
        });
      }

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log("[auth] Cosmos DB users container ready");
      await seedAdminUsers(container);
      return container;
    } catch (err: any) {
      console.error(`[auth] Cosmos init failed, using in-memory: ${err.message}`);
      return null;
    }
  })();
  return _initPromise;
}

// ─── Seeded admin/personal users ─────────────────────────────────────────────

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

async function seedAdminUsers(container: Container): Promise<void> {
  for (const s of SEEDED_USERS) {
    try {
      const { resource } = await container.item(s.userId, s.userId).read<AuthUserRecord>();
      if (resource) continue;
    } catch {
      // not found — create below
    }
    const record: AuthUserRecord = {
      id: s.userId,
      userId: s.userId,
      email: s.email,
      emailLower: s.email.toLowerCase(),
      usernameLower: s.aliases[0]?.toLowerCase() ?? null,
      aliases: s.aliases,
      passwordHash: hashPassword(s.password),
      plan: s.plan,
      createdAt: new Date().toISOString(),
      docType: "user",
    };
    await container.items.upsert(record);
  }
}

function seedMemStore() {
  for (const s of SEEDED_USERS) {
    memStore.set(s.userId, {
      id: s.userId,
      userId: s.userId,
      email: s.email,
      emailLower: s.email.toLowerCase(),
      usernameLower: s.aliases[0]?.toLowerCase() ?? null,
      aliases: s.aliases,
      passwordHash: hashPassword(s.password),
      plan: s.plan,
      createdAt: new Date().toISOString(),
      docType: "user",
    });
  }
}
seedMemStore();

// ─── Session helpers ─────────────────────────────────────────────────────────

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET ?? "hobbyiq-admin-testing-session-secret";

function hashPassword(password: string): string {
  // Legacy SHA-256 — retained ONLY for verifying old hashes / seeded admin compat.
  return crypto.createHash("sha256").update(password).digest("hex");
}

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;

async function hashPasswordScrypt(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(
  password: string,
  record: AuthUserRecord,
): Promise<boolean> {
  const stored = record.passwordHash ?? "";
  if (stored.startsWith("scrypt$")) {
    const [, saltHex, hashHex] = stored.split("$");
    if (!saltHex || !hashHex) return false;
    try {
      const expected = Buffer.from(hashHex, "hex");
      const derived = await scryptAsync(
        password,
        Buffer.from(saltHex, "hex"),
        expected.length,
      );
      if (derived.length !== expected.length) return false;
      return crypto.timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }
  // Legacy SHA-256 fallback (seeded admins and any old rows)
  return stored === hashPassword(password);
}

function generateId(): string {
  return crypto.randomUUID();
}

function createSessionToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
      nonce: generateId(),
    }),
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function readSessionToken(
  sessionToken: string,
): { userId: string; expiresAt: number } | null {
  const [payload, signature] = sessionToken.split(".");
  if (!payload || !signature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest();
  const actualSignature = Buffer.from(signature, "base64url");
  if (actualSignature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { userId?: string; expiresAt?: number };
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
    username: user.aliases?.[0] ?? null,
    fullName: user.fullName ?? null,
    plan: user.plan,
    createdAt: user.createdAt,
  };
}

// ─── Storage helpers ─────────────────────────────────────────────────────────

async function findUserByIdentifier(
  identifier: string,
): Promise<AuthUserRecord | undefined> {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) return undefined;

  const container = await getContainer();
  if (!container) {
    return Array.from(memStore.values()).find(
      (u) =>
        u.emailLower === normalized ||
        u.usernameLower === normalized ||
        u.aliases.some((a) => a.toLowerCase() === normalized),
    );
  }

  const { resources } = await container.items
    .query<AuthUserRecord>({
      query:
        'SELECT TOP 1 * FROM c WHERE c.docType = "user" AND (c.emailLower = @id OR c.usernameLower = @id)',
      parameters: [{ name: "@id", value: normalized }],
    })
    .fetchAll();
  return resources[0];
}

async function findUserByAppleSub(
  appleSub: string,
): Promise<AuthUserRecord | undefined> {
  const container = await getContainer();
  if (!container) {
    return Array.from(memStore.values()).find((u) => u.appleSub === appleSub);
  }
  const { resources } = await container.items
    .query<AuthUserRecord>({
      query:
        'SELECT TOP 1 * FROM c WHERE c.docType = "user" AND c.appleSub = @sub',
      parameters: [{ name: "@sub", value: appleSub }],
    })
    .fetchAll();
  return resources[0];
}

async function readUser(userId: string): Promise<AuthUserRecord | undefined> {
  const container = await getContainer();
  if (!container) return memStore.get(userId);
  try {
    const { resource } = await container.item(userId, userId).read<AuthUserRecord>();
    return resource ?? undefined;
  } catch {
    return undefined;
  }
}

async function writeUser(record: AuthUserRecord): Promise<void> {
  const container = await getContainer();
  if (!container) {
    memStore.set(record.userId, record);
    return;
  }
  await container.items.upsert(record);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function signIn(
  identifier: string,
  password: string,
): Promise<AuthResult> {
  if (!identifier || !password) {
    return { success: false, error: "Email and password required" };
  }

  const user = await findUserByIdentifier(identifier);
  if (!user || !(await verifyPassword(password, user))) {
    return { success: false, error: "Invalid credentials" };
  }

  // Opportunistic upgrade: migrate legacy SHA-256 hashes to scrypt on successful login.
  if (!user.passwordHash.startsWith("scrypt$") && user.passwordHash !== "apple-oauth") {
    try {
      user.passwordHash = await hashPasswordScrypt(password);
      user.passwordAlgo = "scrypt";
      await writeUser(user);
    } catch {
      // non-fatal — login still succeeds with the legacy hash
    }
  }

  const sessionId = createSessionToken(user.userId);
  return { success: true, user: toAuthUser(user), sessionId };
}

export async function signOut(_sessionId: string): Promise<AuthResult> {
  return { success: true };
}

export async function getUserBySession(
  sessionId: string,
): Promise<AuthUser | null> {
  const session = readSessionToken(sessionId);
  if (!session) return null;
  const user = await readUser(session.userId);
  return user ? toAuthUser(user) : null;
}

/**
 * Set or change the username on an already-signed-in account. Used by
 * Apple Sign-In users (who don't pick a username at register-time) to
 * claim a display handle from the Account screen. Enforces the same
 * regex + uniqueness rules as registration.
 */
export async function setUsernameForSession(
  sessionId: string,
  rawUsername: string,
): Promise<AuthResult> {
  const session = readSessionToken(sessionId);
  if (!session) {
    return { success: false, error: "Invalid session" };
  }
  const username = (rawUsername ?? "").trim();
  if (!USERNAME_RE.test(username)) {
    return {
      success: false,
      error: "Username must be 3-30 chars (letters, numbers, . _ -)",
    };
  }
  const user = await readUser(session.userId);
  if (!user) {
    return { success: false, error: "User not found" };
  }
  // If they already have this exact username, treat as success (idempotent).
  if (user.usernameLower === username.toLowerCase()) {
    return { success: true, user: toAuthUser(user), sessionId };
  }
  const conflict = await findUserByIdentifier(username);
  if (conflict && conflict.userId !== user.userId) {
    return { success: false, error: "Username already taken" };
  }
  user.usernameLower = username.toLowerCase();
  user.aliases = [username, ...(user.aliases ?? []).filter((a) => a.toLowerCase() !== username.toLowerCase())];
  await writeUser(user);
  return { success: true, user: toAuthUser(user), sessionId };
}

// ─── Registration ────────────────────────────────────────────────────────────

export interface RegisterInput {
  identityToken?: string;   // Apple Sign-In
  email?: string;
  fullName?: string;
  username: string;
  password?: string;        // Email/password registration
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const username = (input.username ?? "").trim();
  if (!USERNAME_RE.test(username)) {
    return {
      success: false,
      error: "Username must be 3-30 chars (letters, numbers, . _ -)",
    };
  }

  let email = (input.email ?? "").trim();
  const fullName = (input.fullName ?? "").trim() || null;
  let appleSub: string | null = null;
  let passwordHash = "";

  if (input.identityToken) {
    // Apple Sign-In path
    let payload;
    try {
      payload = await verifyAppleIdentityToken(input.identityToken);
    } catch (err: any) {
      return { success: false, error: `Apple verification failed: ${err.message}` };
    }
    appleSub = payload.sub;
    if (!email) email = payload.email ?? "";
    passwordHash = "apple-oauth";

    const existingApple = await findUserByAppleSub(appleSub);
    if (existingApple) {
      const sessionId = createSessionToken(existingApple.userId);
      return { success: true, user: toAuthUser(existingApple), sessionId };
    }
  } else {
    // Email/password path
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, error: "Valid email required" };
    }
    const password = input.password ?? "";
    if (password.length < 8) {
      return { success: false, error: "Password must be at least 8 characters" };
    }
    passwordHash = await hashPasswordScrypt(password);
  }

  // Uniqueness checks
  if (email) {
    const existingEmail = await findUserByIdentifier(email);
    if (existingEmail) {
      return { success: false, error: "Email already registered" };
    }
  }
  const existingUsername = await findUserByIdentifier(username);
  if (existingUsername) {
    return { success: false, error: "Username already taken" };
  }

  const userId = appleSub
    ? `apple-${crypto.createHash("sha256").update(appleSub).digest("hex").slice(0, 24)}`
    : `user-${generateId()}`;

  const record: AuthUserRecord = {
    id: userId,
    userId,
    email,
    emailLower: email.toLowerCase(),
    usernameLower: username.toLowerCase(),
    aliases: [username],
    passwordHash,
    passwordAlgo: appleSub ? "apple-oauth" : "scrypt",
    plan: "free",
    createdAt: new Date().toISOString(),
    fullName,
    appleSub,
    docType: "user",
  };
  await writeUser(record);

  const sessionId = createSessionToken(userId);
  return { success: true, user: toAuthUser(record), sessionId };
}
