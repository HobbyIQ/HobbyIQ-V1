import crypto from "crypto";
import { promisify } from "util";
import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { verifyAppleIdentityToken } from "./appleAuth.js";
import { effectivePlanFor } from "../config/entitlements.js";
import { TERMS_VERSION, isCurrentTermsVersion } from "./legal/termsVersion.js";

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
  // CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). The Terms version this user
  // agreed to, stamped at account creation. Absent on every pre-2026-08-12
  // row — those users are re-prompted on next sign-in, which is correct:
  // we have no record of them agreeing to the current text.
  termsAcceptedVersion?: string;
  termsAcceptedAt?: string;
  // CF-PAYMENTS-B1: time-windowed usage counters (optional on legacy rows).
  usage?: UsageCounters;
  // CF-PAYMENTS-APPLE-1: cached Apple subscription state. Absent on rows
  // that never went through /api/subscriptions/verify (free users + every
  // pre-Payments-Apple-1 record).
  appleSubscription?: AppleSubscriptionState;
  // CF-PUBLIC-SELLER-STOREFRONT (Drew, 2026-07-27): when true AND
  // effective plan is Pro Seller, hobby-iq.com/u/<username> renders a
  // public storefront showing the user's inventory (photos + card
  // titles + FMV, no purchase price or P&L). Default off — opt-in only.
  publicShareEnabled?: boolean;
  // CF-STRIPE-SUBSCRIPTIONS (Drew, 2026-07-27): web-side subscription
  // wiring. stripeCustomerId is the persistent customer object we
  // reference for portal + repeat checkout. stripeSubscriptionId is
  // the most-recent active subscription; when it moves to canceled or
  // past_due, the webhook re-derives `plan` and clears this field.
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePriceId?: string;
  stripeSubscriptionStatus?:
    | "active"
    | "trialing"
    | "past_due"
    | "canceled"
    | "incomplete"
    | "incomplete_expired"
    | "unpaid";
  // CF-OWNER-OVERRIDE (2026-06-05): server-side comp. Authoritative tier
  // assignment that overrides BOTH the Apple-derived `plan` field AND the
  // "free" default. Read-modify-write at setUserSubscriptionState +
  // writeUser preserves this field naturally (full-doc upsert; no patch
  // ops on this path), so Apple/subscription webhooks cannot clear it.
  // Surfaced through toAuthUser → AuthUser.entitlementOverride; consumed
  // by effectivePlanFor() at every enforcement site (requireEntitlement,
  // requireCapacity, requireRateLimited) AND at /api/entitlements/me.
  entitlementOverride?: SubscriptionPlan | null;
  // CF-ONBOARDING (Drew, 2026-07-27): user clicked "hide the checklist"
  // on the /app/welcome banner. Persists across sessions.
  onboardingDismissed?: boolean;
  // CF-FIRST-RUN (Drew, 2026-09-02): the guided first-run funnel's
  // progress — which steps are done, which lane they picked, and whether
  // they skipped or finished. Lives HERE, on the user doc, rather than in
  // a new container: it is small, it is read exactly once per session
  // alongside the fields around it, and it is per-user by definition.
  // Absent on every pre-2026-09-02 row, which reads as "never started" —
  // correct, since those accounts predate the funnel. The shape mirrors
  // FirstRunProgress in apps/web/src/lib/firstRun.ts; that module's
  // normalizeProgress() is the one parser and tolerates anything stored
  // here that it does not recognise.
  firstRun?: {
    status?: "active" | "skipped" | "completed";
    completedSteps?: string[];
    lane?: string | null;
    startedAt?: string | null;
    updatedAt?: string | null;
  };
  // CF-EMAIL-VERIFICATION (Drew, 2026-07-27): opt-in email verification.
  // Absent on legacy rows → treat as unverified. `verifiedAt` set when
  // the user clicks the link in the verification email. `pending` holds
  // the current outstanding token + its expiry so a fresh send-verify
  // replaces the old one (only the most-recent token is valid). We don't
  // gate any surface on this yet — the field is here so a future PR can
  // require verification for e.g. bulk uploads or public storefront.
  emailVerification?: {
    verifiedAt?: string | null;
    pending?: {
      token: string;         // 32-byte hex, single-use
      expiresAt: string;     // ISO
      sentTo: string;        // email address the link was mailed to
      sentAt: string;        // ISO
    } | null;
  };
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
  // CF-PUBLIC-SELLER-STOREFRONT (Drew, 2026-07-27): opt-in flag Pro
  // Sellers flip to publish their inventory at hobby-iq.com/u/<username>.
  publicShareEnabled?: boolean;
  // CF-STRIPE-SUBSCRIPTIONS (Drew, 2026-07-27): passed through to the
  // session middleware so /stripe/checkout + /stripe/portal can read
  // the persisted customer id without a second Cosmos round-trip.
  stripeCustomerId?: string;
  stripeSubscriptionStatus?: AuthUserRecord["stripeSubscriptionStatus"];
  // CF-EMAIL-VERIFICATION (Drew, 2026-07-27): surfaced booleans only —
  // the raw token never leaves the backend. `emailVerified` is true iff
  // the user has clicked their verification link at least once; it
  // stays true even if the email later changes (we clear it on email
  // change in a future PR when email-change is user-facing).
  emailVerified?: boolean;
  emailVerificationPending?: boolean;
  // CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). `termsAccepted` is the gate
  // clients read: true only when the stored version equals the CURRENT
  // Terms version. A user who accepted an older version reads false and
  // gets re-prompted. `termsAcceptedVersion` is surfaced for support and
  // audit ("which text did they agree to?").
  termsAccepted?: boolean;
  termsAcceptedVersion?: string | null;
  termsAcceptedAt?: string | null;
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
      return container;
    } catch (err: any) {
      console.error(`[cosmos][auth] Cosmos init failed, using in-memory: ${err.message}`);
      return null;
    }
  })();
  return _initPromise;
}

// ─── CF-OWNER-OVERRIDE-CLEANUP (2026-06-05) ─────────────────────────────────
//
// REMOVED from production: seedAdminUsers(container) call inside
// getContainer(). The old seed re-created two hardcoded admin docs
// against Cosmos on every container init, which made account deletion
// impossible — a deleted seed user reappeared the instant any auth code
// path next ran. Owner / comped accounts are now managed via
// scripts/seedOwnerAccount.ts + setEntitlementOverride() (CF-OWNER-
// OVERRIDE, 2026-06-05). The seed script does NOT bake credentials into
// source.
//
// KEPT for tests ONLY: the in-memory seed below. It runs only when
// NODE_ENV === "test" so dozens of existing test files that signIn as
// the "HobbyIQ" fixture continue to work without modification. The seed
// values are TEST FIXTURES; they only land in memStore, which is itself
// only consulted when Cosmos is unconfigured (test mode). Production
// boots configure Cosmos and never read memStore.
//
// Security note: the password strings "Baseball25" and "Carolina23"
// were on origin/main before this commit; rotate anywhere reused.

const SEEDED_USERS: ReadonlyArray<{
  userId: string;
  email: string;
  aliases: string[];
  password: string;
  plan: SubscriptionPlan;
}> = [
  {
    userId: "admin-testing-hobbyiq",
    email: "drew@justtheboysandcards.com",
    aliases: ["HobbyIQ"],
    password: "Baseball25",
    plan: "pro_seller",
  },
  {
    userId: "personal-justtheboysandcards",
    email: "justtheboysandcards@justtheboysandcards.com",
    aliases: ["JusttheBoysandCards"],
    password: "Carolina23",
    plan: "pro_seller",
  },
];

function seedMemStore(): void {
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

// IIFE gated on test mode: production boots never touch this; tests
// always start with the in-memory fixture present.
if (isTestMode) {
  seedMemStore();
}

/**
 * Test-only: wipe the in-memory user store and re-seed the test
 * fixtures between tests. The safety-net job scans every paid user in
 * memStore — without this reset, prior test users still resolve to
 * "paid" and consume the mocked status queue out of order.
 */
export function _resetMemStoreForTests(): void {
  memStore.clear();
  if (isTestMode) seedMemStore();
}

// ─── Session helpers ─────────────────────────────────────────────────────────

// CF-SESSION-TTL-30D (Drew, 2026-08-11). Bumped from 7d → 30d.
// HobbyIQ is a portfolio-tracking app users check daily/weekly; a
// 7-day forced re-login was high friction. 30d matches SaaS industry
// standard (Notion/Linear/most card platforms). Sliding renewal on
// activity is a natural follow-up if we want zero-friction sessions.
// Only affects NEW logins — existing tokens carry their original 7d
// expiry until they naturally roll over.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

// CF-AUTH-SESSION-SECRET-FAIL-CLOSED (Drew, 2026-07-26, prod-readiness
// audit P0.3). The prior fallback to a hardcoded literal was a
// launch-day exploit vector — a missing/blanked env var would silently
// let every session token in prod be signed with a value visible in
// git history. Fail-closed at module load: throw if the env var is
// unset, blank, or matches the retired literal, so bad deploys can't
// silently re-enable the exploit.
//
// The exact-string check is deliberate — the literal used to appear in
// two files (authService.ts + ebayAuth.service.ts) as a matching
// fallback; both now guard against it.
const RETIRED_DEFAULT_SECRET = "hobbyiq-admin-testing-session-secret";
function resolveSessionSecret(): string {
  const raw = process.env.AUTH_SESSION_SECRET;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("AUTH_SESSION_SECRET is unset — refusing to start. Set a high-entropy value in App Service application settings.");
  }
  if (raw.trim() === RETIRED_DEFAULT_SECRET) {
    throw new Error("AUTH_SESSION_SECRET is set to the retired hardcoded default — refusing to start. Rotate to a high-entropy value.");
  }
  if (raw.trim().length < 32) {
    throw new Error(`AUTH_SESSION_SECRET is too short (length=${raw.trim().length}) — refusing to start. Minimum 32 chars; recommended 64+.`);
  }
  return raw;
}
const SESSION_SECRET = resolveSessionSecret();

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
  const rawPlan = normalizeLegacyPlan(user.plan);
  return {
    userId: user.userId,
    email: user.email,
    username: user.aliases?.[0] ?? null,
    fullName: user.fullName ?? null,
    // CF-PAYMENTS-A: normalize legacy "pro" / "all-star" values to the new
    // enum so requireEntitlement sees a valid plan even for un-migrated rows.
    //
    // CF-EFFECTIVE-PLAN-IN-AUTH-RESPONSE (Drew, 2026-07-31). Return the
    // EFFECTIVE plan (override → raw plan) so every consumer of the auth
    // shape — sidebar chip, storefront gate, iOS plan badge — sees the
    // comped tier without having to read entitlementOverride separately.
    // Previously the wire returned raw user.plan which meant a God-mode
    // account (entitlementOverride=pro_seller, plan=free) rendered as
    // "Free" everywhere except middleware that already called
    // effectivePlanFor. Idempotent for gates that re-apply the resolver
    // (override of override = override).
    plan: effectivePlanFor({ plan: rawPlan, entitlementOverride: user.entitlementOverride ?? null }),
    createdAt: user.createdAt,
    // CF-PAYMENTS-B1: passthrough the usage counter doc so requireRateLimited
    // can read counts without a second Cosmos read.
    usage: user.usage,
    // CF-PAYMENTS-APPLE-1: passthrough cached Apple subscription state.
    appleSubscription: user.appleSubscription,
    // CF-OWNER-OVERRIDE (2026-06-05): server-side comp override. NULL
    // or undefined → effectivePlanFor falls through to `plan`.
    entitlementOverride: user.entitlementOverride ?? null,
    publicShareEnabled: user.publicShareEnabled ?? false,
    stripeCustomerId: user.stripeCustomerId,
    stripeSubscriptionStatus: user.stripeSubscriptionStatus,
    emailVerified: Boolean(user.emailVerification?.verifiedAt),
    emailVerificationPending: Boolean(user.emailVerification?.pending?.token),
    // CF-TERMS-ACCEPTANCE: compare against the CURRENT version, not a
    // presence check — an old acceptance must read as not-accepted.
    termsAccepted: isCurrentTermsVersion(user.termsAcceptedVersion),
    termsAcceptedVersion: user.termsAcceptedVersion ?? null,
    termsAcceptedAt: user.termsAcceptedAt ?? null,
  };
}

/** CF-TERMS-ACCEPTANCE: stamp the user's agreement to the current Terms.
 *  Idempotent — re-accepting the same version just refreshes the timestamp.
 *  Returns false when the user doesn't exist. */
export async function recordTermsAcceptance(
  userId: string,
  version: string = TERMS_VERSION,
): Promise<boolean> {
  const user = await readUser(userId);
  if (!user) return false;
  user.termsAcceptedVersion = version;
  user.termsAcceptedAt = new Date().toISOString();
  await writeUser(user);
  return true;
}

/** CF-TERMS-ACCEPTANCE: has this user agreed to the CURRENT Terms? */
export async function hasAcceptedCurrentTerms(userId: string): Promise<boolean> {
  const user = await readUser(userId);
  return isCurrentTermsVersion(user?.termsAcceptedVersion);
}

/** CF-PUBLIC-SELLER-STOREFRONT: internal helper for the public storefront
 *  route. Looks a user up by their public username (case-insensitive) and
 *  returns the full record so the route can read holdings + plan. Public
 *  route MUST NOT expose the record itself — only the safe surface fields. */
export async function findUserRecordByUsername(username: string): Promise<AuthUserRecord | undefined> {
  return findUserByIdentifier(username);
}

/** CF-MESSAGING-USERNAMES (Drew, 2026-07-27). Resolve userId → display
 *  handle for message inbox / thread rendering. Returns just {userId,
 *  username} so callers can render a human-readable name without ever
 *  seeing password hashes, email addresses, or any other row content. */
export async function findUserDisplayById(
  userId: string,
): Promise<{ userId: string; username: string | null } | null> {
  const raw = (userId ?? "").trim();
  if (!raw) return null;
  const rec = await readUser(raw);
  if (!rec) return null;
  return { userId: rec.userId, username: rec.aliases?.[0] ?? null };
}

/** CF-MESSAGING-USERNAMES: batch variant. Deduplicates ids and returns
 *  a map of userId → username (nullable when unknown). One Cosmos read
 *  per id today; migrate to a single IN-query once the inbox routinely
 *  needs > 10 lookups. */
export async function findUserDisplaysByIds(
  userIds: ReadonlyArray<string>,
): Promise<Record<string, string | null>> {
  const unique = Array.from(new Set(userIds.map((u) => (u ?? "").trim()).filter(Boolean)));
  const out: Record<string, string | null> = {};
  await Promise.all(
    unique.map(async (id) => {
      const rec = await readUser(id).catch(() => undefined);
      out[id] = rec?.aliases?.[0] ?? null;
    }),
  );
  return out;
}

/** CF-PUBLIC-SELLER-STOREFRONT: toggle the opt-in flag from an authed
 *  session. Idempotent — writing the same value twice is a no-op after
 *  the first write. */
export async function setPublicShareEnabled(userId: string, enabled: boolean): Promise<boolean> {
  const user = await readUser(userId);
  if (!user) return false;
  user.publicShareEnabled = enabled;
  await writeUser(user);
  return true;
}

/** CF-ONBOARDING: read/write the dismissed flag. Absent → false. */
export async function readOnboardingDismissed(userId: string): Promise<boolean> {
  const user = await readUser(userId);
  return Boolean(user?.onboardingDismissed);
}
export async function setOnboardingDismissed(userId: string, dismissed: boolean): Promise<boolean> {
  const user = await readUser(userId);
  if (!user) return false;
  user.onboardingDismissed = dismissed;
  await writeUser(user);
  return true;
}

/** CF-FIRST-RUN (Drew, 2026-09-02): read/write the guided-funnel progress
 *  record. Same read-modify-write-the-whole-doc lane as every helper
 *  above, which is what keeps a concurrent write to an unrelated field
 *  (a Stripe webhook, say) from clobbering progress and vice versa.
 *
 *  Absent → undefined, and the route turns that into the empty record.
 *  This layer does NOT validate the shape: apps/web's normalizeProgress()
 *  is the single parser, and duplicating its rules here would give us two
 *  places for them to disagree. */
export async function readFirstRunProgress(
  userId: string,
): Promise<AuthUserRecord["firstRun"] | undefined> {
  const user = await readUser(userId);
  return user?.firstRun;
}

export async function setFirstRunProgress(
  userId: string,
  progress: NonNullable<AuthUserRecord["firstRun"]>,
): Promise<boolean> {
  const user = await readUser(userId);
  if (!user) return false;
  user.firstRun = progress;
  await writeUser(user);
  return true;
}

/** CF-STRIPE-SUBSCRIPTIONS: persist the Stripe customer id on first
 *  checkout so subsequent portal + repeat-checkout calls can reuse it. */
export async function setStripeCustomerId(userId: string, stripeCustomerId: string): Promise<boolean> {
  const user = await readUser(userId);
  if (!user) return false;
  user.stripeCustomerId = stripeCustomerId;
  await writeUser(user);
  return true;
}

/** CF-STRIPE-SUBSCRIPTIONS: apply a subscription state transition from
 *  a webhook event. Maps priceId to plan tier via env vars. Setting
 *  plan=null clears the paid plan back to "free" (used on cancel). */
export async function applyStripeSubscriptionState(
  userId: string,
  state: {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    stripePriceId?: string;
    stripeSubscriptionStatus?: AuthUserRecord["stripeSubscriptionStatus"];
    plan?: SubscriptionPlan;
  },
): Promise<boolean> {
  const user = await readUser(userId);
  if (!user) return false;
  if (state.stripeCustomerId) user.stripeCustomerId = state.stripeCustomerId;
  if (state.stripeSubscriptionId !== undefined) {
    user.stripeSubscriptionId = state.stripeSubscriptionId || undefined;
  }
  if (state.stripePriceId !== undefined) {
    user.stripePriceId = state.stripePriceId || undefined;
  }
  if (state.stripeSubscriptionStatus !== undefined) {
    user.stripeSubscriptionStatus = state.stripeSubscriptionStatus;
  }
  if (state.plan !== undefined) {
    user.plan = state.plan;
  }
  await writeUser(user);
  return true;
}

/** CF-STRIPE-SUBSCRIPTIONS: look a user up by their Stripe customer id.
 *  Used by the webhook to find who a subscription belongs to when the
 *  event only carries `customer`, not `client_reference_id`. */
export async function findUserByStripeCustomerId(stripeCustomerId: string): Promise<AuthUserRecord | undefined> {
  const trimmed = stripeCustomerId.trim();
  if (!trimmed) return undefined;
  const container = await getContainer();
  if (!container) {
    return Array.from(memStore.values()).find((u) => u.stripeCustomerId === trimmed);
  }
  const { resources } = await container.items
    .query<AuthUserRecord>({
      query: 'SELECT TOP 1 * FROM c WHERE c.docType = "user" AND c.stripeCustomerId = @id',
      parameters: [{ name: "@id", value: trimmed }],
    })
    .fetchAll();
  return resources[0];
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
  // CF-RESERVED-USERNAMES: allow-list check runs BEFORE the uniqueness
  // scan so an owner-reserved handle (empty allow-list) is rejected the
  // same way whether or not somebody has already tried to grab it.
  if (isUsernameReserved(username, user.emailLower)) {
    return { success: false, error: "Username already taken" };
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
  // CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). When SIGNUP_INVITE_REQUIRED
  // env var is true, new accounts must present a valid invite code.
  // Existing Apple Sign-In users (already-created appleSub match) skip
  // the check because they're logging in, not creating an account.
  inviteCode?: string | null;
  // CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Clients that present the
  // agreement before calling /register send true (or omit it — creating an
  // account is itself agreement per §1). Send false ONLY to create an
  // account without consent on record; that user is then gated by
  // `termsAccepted: false` on the session until they accept.
  acceptedTerms?: boolean;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

// CF-RESERVED-USERNAMES (Drew, 2026-07-27). Handles that can only be
// claimed by pre-approved accounts. Everyone else who tries — at signup
// OR at change-username — sees "Username already taken." The reservation
// is enforced case-insensitively (usernames are stored lowercased).
//
// Key: lowercased handle. Value: array of lowercased emails the handle
// is claimable by. Empty array = owner-only (nobody can claim until Drew
// updates this table with a specific email).
//
// Drew is currently the only "owner" — future me can turn this into a
// runtime-configurable list if the list grows, but hardcoded-here-in-a-PR
// is the right latency/security tradeoff for a small allow-list.
const RESERVED_USERNAMES: Readonly<Record<string, ReadonlyArray<string>>> = {
  drew: ["dvabulas@outlook.com"],
  luke: ["lsinnard1002@gmail.com"],
  jordan: ["jwduggan2@gmail.com"],
  lutz: ["zacklutzfranco@gmail.com"],
  // Handles reserved for the owner to distribute later. Anyone else
  // trying to claim them gets a "taken" error today.
  oliver: [],
  beau: [],
  justtheboysandcards: [],
  hobbyiq: [],
};

/** CF-RESERVED-USERNAMES: returns true when this (handle, email) pair
 *  is blocked. Case-insensitive on both handle + email. Owner-only
 *  handles (empty allow-list) return true for every email. */
function isUsernameReserved(rawUsername: string, requesterEmail: string | null | undefined): boolean {
  const handle = String(rawUsername ?? "").trim().toLowerCase();
  if (!handle) return false;
  const allowlist = RESERVED_USERNAMES[handle];
  if (!allowlist) return false; // not reserved at all
  const email = String(requesterEmail ?? "").trim().toLowerCase();
  if (!email) return true;      // must be logged in with an allow-listed email
  return !allowlist.includes(email);
}

/** CF-RESERVED-USERNAMES: cheap availability probe used by the client
 *  before submit. Returns { available, reason? }. Availability check
 *  runs the same three gates as setUsernameForSession: regex, reserved
 *  list, uniqueness. Passes { requesterEmail } when the caller is
 *  logged in so we can green-light their own currently-held handle. */
export async function isUsernameAvailable(
  rawUsername: string,
  opts: { requesterEmail?: string | null; requesterUserId?: string | null } = {},
): Promise<{ available: boolean; reason?: string }> {
  const trimmed = String(rawUsername ?? "").trim();
  if (!USERNAME_RE.test(trimmed)) {
    return { available: false, reason: "Username must be 3-30 chars (letters, numbers, . _ -)" };
  }
  if (isUsernameReserved(trimmed, opts.requesterEmail ?? null)) {
    return { available: false, reason: "Username already taken" };
  }
  const conflict = await findUserByIdentifier(trimmed);
  if (conflict && conflict.userId !== (opts.requesterUserId ?? null)) {
    return { available: false, reason: "Username already taken" };
  }
  return { available: true };
}

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
      // Login path (existing Apple user). No invite check — they already
      // have an account, they're just signing in through Apple again.
      const sessionId = createSessionToken(existingApple.userId);
      return { success: true, user: toAuthUser(existingApple), sessionId };
    }
    // Falls through — NEW Apple account, invite gate applies below.
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
  // CF-RESERVED-USERNAMES: block reserved handles at registration time
  // so a bad actor can't grab one during a race. Owner-only handles
  // return "taken" for every email.
  if (isUsernameReserved(username, email || null)) {
    return { success: false, error: "Username already taken" };
  }
  const existingUsername = await findUserByIdentifier(username);
  if (existingUsername) {
    return { success: false, error: "Username already taken" };
  }

  // CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). Gate NEW-account creation
  // on a valid invite code when SIGNUP_INVITE_REQUIRED=true. Reached
  // only after uniqueness checks — so an existing user retrying signup
  // still sees "email already registered", not the invite error. Apple
  // Sign-In existing users (login path) already returned above.
  const { isInviteRequired, validateInviteCode, consumeInviteCode } = await import("./auth/inviteCodes.service.js");
  let inviteCodeToConsume: string | null = null;
  // CF-INVITE-PLAN-GRANT (Drew, 2026-08-10). Plan grants ride with the
  // invite code — captured here so the new user's record can be stamped
  // with entitlementOverride before writeUser. Applies BEFORE writeUser
  // so the first record write includes the override (no separate
  // read-modify-write later).
  let grantsPlan: SubscriptionPlan | null = null;
  if (isInviteRequired()) {
    const raw = String(input.inviteCode ?? "").trim();
    if (!raw) {
      return { success: false, error: "Invite code required to create an account" };
    }
    const check = await validateInviteCode(raw);
    if (!check.ok) {
      return { success: false, error: check.error };
    }
    inviteCodeToConsume = check.code.code;
    if (check.code.grantsPlan) {
      grantsPlan = check.code.grantsPlan as SubscriptionPlan;
    }
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
    // CF-INVITE-PLAN-GRANT (Drew, 2026-08-10). entitlementOverride is
    // the correct field per CF-OWNER-OVERRIDE — it beats both
    // Apple-derived plan AND the free default at every gate
    // (effectivePlanFor). Whatever the code granted lands here.
    entitlementOverride: grantsPlan,
    createdAt: new Date().toISOString(),
    fullName,
    appleSub,
    docType: "user",
    // CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Creating an account IS the
    // act of agreement (§1 and the closing acknowledgment of the Terms),
    // so the version is stamped here rather than left for a later prompt.
    // The client is responsible for showing the agreement before it calls
    // /register; `acceptedTerms: false` records nothing and the user is
    // gated by `termsAccepted` on the session until they agree.
    ...(input.acceptedTerms === false
      ? {}
      : {
          termsAcceptedVersion: TERMS_VERSION,
          termsAcceptedAt: new Date().toISOString(),
        }),
  };
  await writeUser(record);

  // Best-effort invite consume (audit trail + usesRemaining decrement).
  // A failure here is logged inside consumeInviteCode but doesn't
  // rollback the account — user got in, invite tracking is secondary.
  if (inviteCodeToConsume) {
    void consumeInviteCode(inviteCodeToConsume, userId);
  }

  const sessionId = createSessionToken(userId);
  return { success: true, user: toAuthUser(record), sessionId };
}

// ─── CF-CHANGE-PASSWORD (Drew, 2026-07-27) ──────────────────────────────────
//
// Change the password on an already-signed-in email/password account.
// Apple-OAuth accounts (passwordAlgo === "apple-oauth") CANNOT change
// their password here — the identity provider owns it — so we surface
// a "sign-in method doesn't support password change" error rather than
// silently rewriting the hash. All other paths verify the current
// password before writing the new scrypt hash.
//
// Reasoning for min-length checks matching registerUser:
// - Keep symmetry with registration (8 chars, same regex not enforced —
//   just a length floor). Future PR can add complexity rules once we
//   have HIBP / breach-check infra.
// - We don't check "new != old" because a user re-typing their same
//   password is not a security issue, just a UX oddity; the client
//   surfaces that if it matters.

export async function changePasswordForSession(
  sessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<AuthResult> {
  const session = readSessionToken(sessionId);
  if (!session) {
    return { success: false, error: "Invalid session" };
  }
  const user = await readUser(session.userId);
  if (!user) {
    return { success: false, error: "User not found" };
  }
  if (user.passwordAlgo === "apple-oauth") {
    return {
      success: false,
      error: "Password change isn't available for Apple Sign-In accounts.",
    };
  }
  const currentOk = await verifyPassword(currentPassword, user);
  if (!currentOk) {
    return { success: false, error: "Current password is incorrect" };
  }
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return { success: false, error: "New password must be at least 8 characters" };
  }
  user.passwordHash = await hashPasswordScrypt(newPassword);
  user.passwordAlgo = "scrypt";
  await writeUser(user);
  return { success: true, user: toAuthUser(user), sessionId };
}

// ─── CF-EMAIL-VERIFICATION (Drew, 2026-07-27) ────────────────────────────────
//
// Two-step flow:
//   1) POST /api/auth/send-verification (session-gated) → issueEmailVerification
//      writes a new random token onto the user record and returns the token
//      + email so the caller (route handler) hands it to emailService for
//      delivery. Overwrites any prior pending token, so a resend is safe.
//   2) GET /api/auth/verify-email?token=T (public) → consumeEmailVerification
//      finds the user carrying that pending token, checks expiry, sets
//      `verifiedAt`, and clears `pending`.
//
// Design choices:
// - Token is 32 random bytes (256 bits) as base64url — 43 chars, single-use,
//   opaque. Never derived from userId or email.
// - Storage lives on the user doc, not a side container: single-user backend,
//   no need to spend a container + index policy on tokens that only exist
//   for 24h.
// - We store the exact email the link was mailed to (`sentTo`) so if the
//   user changes their address between issue and click, the click doesn't
//   silently verify a stale address.

const VERIFICATION_TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Issue a new email-verification token for the given user. Overwrites any
 * previous pending token — resend is a full replacement, not additive.
 * Returns the token + destination email so the caller can hand them to the
 * mailer, or null if the user doesn't exist / has no email on file.
 */
export async function issueEmailVerification(
  userId: string,
): Promise<{ token: string; email: string; expiresAt: string } | null> {
  const user = await readUser(userId);
  if (!user) return null;
  const email = (user.email ?? "").trim();
  if (!email) return null;
  const token = generateVerificationToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
  const now = new Date().toISOString();
  user.emailVerification = {
    verifiedAt: user.emailVerification?.verifiedAt ?? null,
    pending: {
      token,
      expiresAt,
      sentTo: email,
      sentAt: now,
    },
  };
  await writeUser(user);
  return { token, email, expiresAt };
}

/**
 * Consume a verification token. If it matches an outstanding pending token
 * that hasn't expired AND still points at the user's current email, marks
 * verified + clears pending. Returns the updated AuthUser projection or null
 * on any failure (unknown token, expired, email-changed).
 *
 * Lookup: scans users by pending token. At single-user backend scale this
 * is O(n) with n≈small; if that changes, add a Cosmos index on
 * `emailVerification.pending.token` and a partitioned lookup. The scan is
 * scoped to docType="user" AND IS_DEFINED(pending.token) so it's cheap.
 */
export async function consumeEmailVerification(
  token: string,
): Promise<{ user: AuthUser } | null> {
  const t = (token ?? "").trim();
  if (!t) return null;

  const container = await getContainer();
  let hit: AuthUserRecord | undefined;
  if (!container) {
    hit = Array.from(memStore.values()).find(
      (u) => u.emailVerification?.pending?.token === t,
    );
  } else {
    const { resources } = await container.items
      .query<AuthUserRecord>({
        query:
          'SELECT TOP 1 * FROM c WHERE c.docType = "user" ' +
          'AND IS_DEFINED(c.emailVerification.pending.token) ' +
          'AND c.emailVerification.pending.token = @t',
        parameters: [{ name: "@t", value: t }],
      })
      .fetchAll();
    hit = resources[0];
  }
  if (!hit) return null;

  const pending = hit.emailVerification?.pending;
  if (!pending) return null;
  if (Date.parse(pending.expiresAt) <= Date.now()) return null;
  // Email-changed-between-issue-and-click: reject rather than silently
  // verify a stale address.
  if (pending.sentTo.toLowerCase() !== (hit.email ?? "").toLowerCase()) return null;

  hit.emailVerification = {
    verifiedAt: new Date().toISOString(),
    pending: null,
  };
  await writeUser(hit);
  return { user: toAuthUser(hit) };
}

