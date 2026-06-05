import crypto from "crypto";
import { promisify } from "util";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { verifyAppleIdentityToken } from "./appleAuth.js";

// CF-PAYMENTS-A (2026-06-02): plan enum rev. Was "free" | "pro" | "all-star".
// New tiers per the entitlements matrix in config/entitlements.ts. Legacy
// stored values in Cosmos ("pro", "all-star") are normalized at read time
// via normalizeLegacyPlan() below — no migration script required for this
// CF (no deploy).
export type SubscriptionPlan = "free" | "collector" | "investor" | "pro_seller";

/**
 * Read-time normalizer for any legacy plan strings still present in Cosmos
 * docs that haven't been re-written since the rename. Maps:
 *   "all-star" -> "pro_seller"  (highest legacy tier -> new top tier)
 *   "pro"      -> "collector"   (legacy mid-tier -> new entry paid tier)
 * Any unknown value falls back to "free".
 */
function normalizeLegacyPlan(raw: unknown): SubscriptionPlan {
  if (raw === "free" || raw === "collector" || raw === "investor" || raw === "pro_seller") {
    return raw;
  }
  if (raw === "all-star") return "pro_seller";
  if (raw === "pro") return "collector";
  return "free";
}

// CF-PAYMENTS-B1 (2026-06-02): time-windowed usage counters live on the
// user doc per the approved Option A storage model. windowKey resets at
// READ time in usageCounter.service.ts; this file owns the storage
// surface only. UsageCap mirrors the time-windowed entries in
// config/entitlements.ts GatedCap; we do not include write-counted caps
// here (those are counted from their own resources, not from the user
// doc).
export type UsageCap = "priceChecks" | "scans";

export interface UsageWindow {
  windowKey: string;   // "YYYY-MM-DD" for priceChecks, "YYYY-MM" for scans
  count: number;
}

export type UsageCounters = Partial<Record<UsageCap, UsageWindow>>;

// CF-PAYMENTS-APPLE-1 (2026-06-03): persisted subscription state from the
// Apple App Store Server API verifier. Cached on the user record so
// requireEntitlement + product UX don't re-hit Apple per request. Apple
// remains the source of truth; this cache is refreshed by /api/subscriptions/verify
// and (Phase 2) by the V2 notifications webhook + nightly safety-net job.
export interface AppleSubscriptionState {
  // Apple's stable identifier for the subscription across renewals.
  // Idempotency key for /api/subscriptions/verify.
  originalTransactionId: string;
  // ISO timestamp; null when the live API status is EXPIRED/REVOKED and
  // we couldn't read an expiry (rare).
  expiresAt: string | null;
  // ISO timestamp of the last successful verify/refresh.
  lastEventAt: string;
  // "Sandbox" | "Production" — Apple's enum value at verify time.
  environment: string;
  // The Apple productId that mapped to the current plan, for audit / future
  // grader-style adapters when we add more SKUs.
  productId: string;
}

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
  // CF-PAYMENTS-B1: time-windowed usage counters (optional on legacy rows).
  usage?: UsageCounters;
  // CF-PAYMENTS-APPLE-1: cached Apple subscription state. Absent on rows
  // that never went through /api/subscriptions/verify (free users + every
  // pre-Payments-Apple-1 record).
  appleSubscription?: AppleSubscriptionState;
  // CF-OWNER-OVERRIDE (2026-06-05): server-side comp. Authoritative tier
  // assignment that overrides BOTH the Apple-derived `plan` field AND the
  // "free" default. Read-modify-write at setUserSubscriptionState +
  // writeUser preserves this field naturally (full-doc upsert; no patch
  // ops on this path), so Apple/subscription webhooks cannot clear it.
  // Surfaced through toAuthUser → AuthUser.entitlementOverride; consumed
  // by effectivePlanFor() at every enforcement site (requireEntitlement,
  // requireCapacity, requireRateLimited) AND at /api/entitlements/me.
  entitlementOverride?: SubscriptionPlan | null;
}

export interface AuthUser {
  userId: string;
  email: string;
  username?: string | null;
  fullName?: string | null;
  plan: SubscriptionPlan;
  createdAt: string;
  // CF-PAYMENTS-B1: surfaced so requireRateLimited can read counts without
  // a second Cosmos round-trip (requireSession already loaded the doc).
  usage?: UsageCounters;
  // CF-PAYMENTS-APPLE-1: same passthrough rationale — surfaced so iOS can
  // read it via /api/auth/session for paywall "current subscription"
  // display, no extra round-trip needed.
  appleSubscription?: AppleSubscriptionState;
  // CF-OWNER-OVERRIDE (2026-06-05): server-side comp override. NULL or
  // absent → fall through to `plan`. See effectivePlanFor() — the single
  // shared resolver every gate/route reads through.
  entitlementOverride?: SubscriptionPlan | null;
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
      console.error(`[cosmos][auth] Cosmos init failed, using in-memory: ${err.message}`);
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
    plan: "pro_seller" as SubscriptionPlan,
  },
  {
    userId: "personal-justtheboysandcards",
    email: "justtheboysandcards@justtheboysandcards.com",
    aliases: ["JusttheBoysandCards"],
    password: "Carolina23",
    plan: "pro_seller" as SubscriptionPlan,
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

/**
 * Test-only: wipe the in-memory user store and re-seed the admin rows.
 * Lets test files that exercise full-suite-scanning behavior (the
 * subscriptions safety-net job is the first such case) isolate seeded
 * users from earlier tests' rows. Not exposed by name in production
 * since memStore is only used when Cosmos is unconfigured.
 */
export function _resetMemStoreForTests(): void {
  memStore.clear();
  seedMemStore();
}

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
    // CF-PAYMENTS-A: normalize legacy "pro" / "all-star" values to the new
    // enum so requireEntitlement sees a valid plan even for un-migrated rows.
    plan: normalizeLegacyPlan(user.plan),
    createdAt: user.createdAt,
    // CF-PAYMENTS-B1: passthrough the usage counter doc so requireRateLimited
    // can read counts without a second Cosmos read.
    usage: user.usage,
    // CF-PAYMENTS-APPLE-1: passthrough cached Apple subscription state.
    appleSubscription: user.appleSubscription,
    // CF-OWNER-OVERRIDE (2026-06-05): server-side comp override. NULL
    // or undefined → effectivePlanFor falls through to `plan`.
    entitlementOverride: user.entitlementOverride ?? null,
  };
}

// ─── CF-PAYMENTS-B1: usage counter writer ───────────────────────────────────
//
// Atomicity note: read-modify-write is acceptable at single-user-backend
// scale. Two concurrent requests for the same user *could* undercount by 1
// (each reads count=N, both write N+1). For Drew's solo backend this is
// non-issue. Migrate to Cosmos patch.add({path:"/usage/<cap>/count", value:1})
// once multi-tenant scaling matters.

/**
 * Set or overwrite the usage counter for a single cap on a user's record.
 * Caller (usageCounter.service.ts) owns the window-key + reset logic; this
 * function is a thin storage primitive. Silently no-ops if the user
 * doesn't exist (caller has already auth'd via requireSession, so this is
 * a defensive path only for tests that exercise the function directly
 * without a corresponding registered user).
 */
export async function setUserUsageCounter(
  userId: string,
  cap: UsageCap,
  payload: UsageWindow,
): Promise<void> {
  const user = await readUser(userId);
  if (!user) return;
  user.usage = { ...(user.usage ?? {}), [cap]: payload };
  await writeUser(user);
}

// ─── CF-PAYMENTS-APPLE-1: Apple subscription state writer ───────────────────
//
// Single primitive used by the subscriptions.service after a successful
// JWS verify + status check. Idempotency on originalTransactionId is the
// CALLER's responsibility (subscriptions.service compares
// incoming.originalTransactionId vs user.appleSubscription?.originalTransactionId
// and the stored plan before deciding what to write). This function just
// upserts the doc atomically.
//
// Returns the updated AuthUser projection so the caller can echo it back
// in the /verify response without an extra read.
export async function setUserSubscriptionState(
  userId: string,
  newPlan: SubscriptionPlan,
  apple: AppleSubscriptionState,
): Promise<AuthUser | null> {
  // CF-OWNER-OVERRIDE (2026-06-05): readUser + writeUser is a full-doc
  // round-trip (container.item().read<AuthUserRecord>() + items.upsert()),
  // so `entitlementOverride` rides through every Apple/webhook update
  // automatically — we never construct a partial object that could drop
  // it. Pinned by the webhook-no-clear test in subscriptionsNotifications.
  // DO NOT refactor this into a Cosmos patch op without re-pinning.
  const user = await readUser(userId);
  if (!user) return null;
  user.plan = newPlan;
  user.appleSubscription = apple;
  await writeUser(user);
  return toAuthUser(user);
}

// ─── CF-OWNER-OVERRIDE (2026-06-05): seed-script-side helpers ──────────────
//
// Two exports used by scripts/seedOwnerAccount.ts. Both are read-modify-
// write on the FULL user record (same mechanism that lets entitlement
// override survive every Apple webhook). The seed script never touches
// the password hash on an existing row.

/**
 * Lookup by email (case-insensitive). Returns null if not found. Wraps
 * the existing internal findUserByIdentifier path so the seed script
 * doesn't have to know about emailLower normalization.
 */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const trimmed = (email ?? "").trim();
  if (!trimmed) return null;
  const record = await findUserByIdentifier(trimmed);
  return record ? toAuthUser(record) : null;
}

/**
 * Set (or clear) the server-side entitlement override on an existing
 * user. Optionally claim a username at the same time (one atomic write).
 * NEVER touches the password hash, the Apple subscription state, or the
 * email — only the override field + (optionally) the username aliases.
 * Idempotent: re-running with the same args is a no-op write.
 *
 * Returns null when the user doesn't exist (caller should register
 * first), null also when the supplied username is malformed or conflicts
 * with another user. Otherwise returns the updated AuthUser projection.
 */
export async function setEntitlementOverride(
  userId: string,
  override: SubscriptionPlan | null,
  opts: { username?: string } = {},
): Promise<AuthUser | null> {
  const user = await readUser(userId);
  if (!user) return null;

  if (opts.username !== undefined) {
    const normalized = opts.username.trim();
    if (!USERNAME_RE.test(normalized)) return null;
    const lower = normalized.toLowerCase();
    if (user.usernameLower !== lower) {
      const conflict = await findUserByIdentifier(normalized);
      if (conflict && conflict.userId !== user.userId) return null;
      user.usernameLower = lower;
      user.aliases = [
        normalized,
        ...(user.aliases ?? []).filter((a) => a.toLowerCase() !== lower),
      ];
    }
  }

  user.entitlementOverride = override;
  await writeUser(user);
  return toAuthUser(user);
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

/**
 * CF-ACCOUNT-DELETION (2026-06-04): purge the user record. One doc per
 * user, id == userId, partition == userId. Returns true on success or
 * 404 (treated as already-purged for idempotency); false on transport
 * failure. Caller (accountDeletion.service) calls this LAST so the
 * session-invalidation timing closes only after every other purge has
 * landed.
 */
export async function deleteUserDoc(userId: string): Promise<boolean> {
  const container = await getContainer();
  if (!container) {
    memStore.delete(userId);
    return true;
  }
  try {
    await container.item(userId, userId).delete();
    return true;
  } catch (err: any) {
    if (err?.code === 404) return true;
    console.error("[auth] deleteUserDoc failed:", err?.message ?? err);
    return false;
  }
}

// CF-PAYMENTS-APPLE-2 (2026-06-03): originalTransactionId lookup. The /verify
// flow established the link (appleSubscription.originalTransactionId) so
// the notifications webhook can find the HobbyIQ user given just the
// Apple transaction. Returns undefined if no user has this txnId.
export async function findUserByOriginalTransactionId(
  originalTransactionId: string,
): Promise<AuthUser | undefined> {
  const container = await getContainer();
  if (!container) {
    const hit = Array.from(memStore.values()).find(
      (u) => u.appleSubscription?.originalTransactionId === originalTransactionId,
    );
    return hit ? toAuthUser(hit) : undefined;
  }
  const { resources } = await container.items
    .query<AuthUserRecord>({
      query:
        'SELECT TOP 1 * FROM c WHERE c.docType = "user" AND c.appleSubscription.originalTransactionId = @txnId',
      parameters: [{ name: "@txnId", value: originalTransactionId }],
    })
    .fetchAll();
  return resources[0] ? toAuthUser(resources[0]) : undefined;
}

// CF-PAYMENTS-APPLE-2: nightly safety-net source. Returns every user
// whose plan != free so the job can reconcile each against Apple. Reads
// only the fields the job needs (userId, plan, appleSubscription) — a
// full-row scan via container.items.readAll() would be wasteful and
// would also include the password hash. Implementation note: at single-
// user backend scale this is N=1; the SELECT is shaped to be ~free even
// when paid-user count grows.
export async function findAllPaidUsers(): Promise<AuthUser[]> {
  const container = await getContainer();
  if (!container) {
    return Array.from(memStore.values())
      .filter((u) => u.plan && u.plan !== "free")
      .map(toAuthUser);
  }
  const { resources } = await container.items
    .query<AuthUserRecord>({
      query:
        'SELECT * FROM c WHERE c.docType = "user" AND c.plan != "free"',
    })
    .fetchAll();
  return resources.map(toAuthUser);
}

// CF-PAYMENTS-APPLE-2-FIX (2026-06-03): bidirectional safety-net source.
// Returns users whose appleSubscription is set AND either currently paid
// OR lapsed within `lookbackDays` (default 40). The lapsed-bucket fix
// lets the nightly RESTORE a free user whose subscription Apple
// reactivated (refund reversal, grace-period restore, etc.) — the prior
// "paid only" predicate missed these.
//
// Bounded by `lookbackDays` so a long-churned subscription doesn't stay
// on every nightly scan forever. 40 days covers:
//   - Apple's standard subscription billing cycles + grace + retry
//   - The window where a refund reversal can still happen
// Past 40 days the user has effectively churned; if they resubscribe
// the /verify call from the app on Transaction.updates re-establishes
// the link and they're back in the scan set.
export async function findReconcilableUsers(
  lookbackDays = 40,
): Promise<AuthUser[]> {
  const cutoffIso = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const container = await getContainer();
  if (!container) {
    return Array.from(memStore.values())
      .filter((u) => Boolean(u.appleSubscription?.originalTransactionId))
      .filter(
        (u) =>
          (u.plan && u.plan !== "free") ||
          (typeof u.appleSubscription?.expiresAt === "string" &&
            u.appleSubscription.expiresAt > cutoffIso),
      )
      .map(toAuthUser);
  }
  const { resources } = await container.items
    .query<AuthUserRecord>({
      query:
        'SELECT * FROM c WHERE c.docType = "user" ' +
        'AND IS_DEFINED(c.appleSubscription.originalTransactionId) ' +
        'AND (c.plan != "free" OR c.appleSubscription.expiresAt > @cutoff)',
      parameters: [{ name: "@cutoff", value: cutoffIso }],
    })
    .fetchAll();
  return resources.map(toAuthUser);
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
