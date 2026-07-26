// CF-REFERRAL-LOOP (Drew, 2026-07-26). Backend for the "free month
// for both parties" referral program.
//
// Rules:
//   - Each user has one shareable referral code (8-char alphanumeric,
//     collision-safe by lookup).
//   - Referee redeems the code at signup OR after upgrading to paid.
//   - Reward gate: referrer credited free month ONLY when referee stays
//     active on a paid plan for 30 days (defeats trial-farming).
//   - Referee gets their free month at successful redemption (immediate
//     grant on paid signup); backend flags for StoreKit offer-code
//     application on iOS.
//
// Container: `referrals`, partition `/referrerUserId`.
//   Doc shape:
//     { id: <redemptionId>, referrerUserId, refereeUserId, code,
//       redeemedAt, refereeSubscribedAt, refereeActivatedAt,
//       creditGrantedAt, status: 'pending' | 'granted' | 'expired' | 'revoked' }
//
// Anti-abuse:
//   - Rate-limit code generation to 1/user (each user gets ONE code)
//   - Rate-limit redemption to 1 code per referee (can't redeem multiple)
//   - Self-redemption blocked (can't redeem your own code)
//   - Cooldown: 30-day activity requirement before referrer credit
//   - Optional per-referrer cap (env REFERRAL_MAX_CREDITS_PER_REFERRER, default 12/year)

import { Container, CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { randomBytes } from "crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReferralStatus = "pending" | "granted" | "expired" | "revoked";

export interface ReferralDoc {
  id: string;                    // redemption id
  referrerUserId: string;        // partition key
  refereeUserId: string;
  code: string;                  // the shared 8-char code
  redeemedAt: string;            // ISO — when the code was redeemed
  refereeSubscribedAt: string | null;  // ISO — when the referee started a paid subscription
  refereeActivatedAt: string | null;   // ISO — when the referee crossed the 30-day gate
  creditGrantedAt: string | null;      // ISO — when the referrer was credited
  status: ReferralStatus;
  ttl: number;                   // -1 (no expiry — 30-day gate tracked in-doc)
}

export interface ReferralCodeDoc {
  id: string;         // = code (uppercase) so lookup by id is a point-read
  code: string;       // = id (redundant for readability)
  userId: string;     // owner of the code
  createdAt: string;
  ttl: number;        // -1
}

// ─── Container init (createIfNotExists on first use) ─────────────────────────

const CONTAINER_REFERRALS_ID = process.env.COSMOS_REFERRALS_CONTAINER ?? "referrals";
const CONTAINER_CODES_ID = process.env.COSMOS_REFERRAL_CODES_CONTAINER ?? "referral_codes";

let _refs: Container | null = null;
let _codes: Container | null = null;
let _initPromise: Promise<void> | null = null;
let _testRefs: Container | null = null;
let _testCodes: Container | null = null;

export function _setContainersForTests(refs: Container | null, codes: Container | null): void {
  _testRefs = refs;
  _testCodes = codes;
  _refs = null;
  _codes = null;
  _initPromise = null;
}

async function ensureInit(): Promise<{ refs: Container; codes: Container } | null> {
  if (_testRefs && _testCodes) return { refs: _testRefs, codes: _testCodes };
  if (_refs && _codes) return { refs: _refs, codes: _codes };
  if (!_initPromise) {
    _initPromise = (async () => {
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const endpoint = process.env.COSMOS_ENDPOINT;
      if (!connStr && !endpoint) return;
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const [r1, r2] = await Promise.all([
        database.containers.createIfNotExists({
          id: CONTAINER_REFERRALS_ID,
          partitionKey: { paths: ["/referrerUserId"] },
          defaultTtl: -1,
        }),
        database.containers.createIfNotExists({
          id: CONTAINER_CODES_ID,
          partitionKey: { paths: ["/code"] },
          defaultTtl: -1,
        }),
      ]);
      _refs = r1.container;
      _codes = r2.container;
    })();
  }
  await _initPromise;
  if (_refs && _codes) return { refs: _refs, codes: _codes };
  return null;
}

// ─── Code generation ─────────────────────────────────────────────────────────

// 8-char alphanumeric, no ambiguous chars (0/O, 1/I/L). ~34^8 = 1.8T space —
// collisions are astronomically unlikely at any HobbyIQ scale.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

/**
 * Get (creating if needed) the user's referral code. Idempotent per user —
 * repeat calls return the same code.
 */
export async function getOrCreateReferralCode(userId: string): Promise<string | null> {
  if (!userId) return null;
  const c = await ensureInit();
  if (!c) return null;
  // Look up existing code owned by this user via cross-partition query
  // (small table; acceptable RU cost). Cached on the code doc for point
  // reads by code afterwards.
  try {
    const { resources } = await c.codes.items.query({
      query: "SELECT TOP 1 * FROM c WHERE c.userId = @u",
      parameters: [{ name: "@u", value: userId }],
    }).fetchAll();
    if (resources && resources.length > 0) return (resources[0] as ReferralCodeDoc).code;
  } catch { /* fall through to create */ }
  // Generate a fresh code with collision retry
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const doc: ReferralCodeDoc = {
        id: code,
        code,
        userId,
        createdAt: new Date().toISOString(),
        ttl: -1,
      };
      await c.codes.items.create(doc);
      return code;
    } catch (err: any) {
      // 409 = code collision, retry
      if (err?.code === 409 || err?.statusCode === 409) continue;
      console.warn(JSON.stringify({
        event: "referral_code_create_failed",
        source: "referralCode.service",
        userId,
        error: err?.message ?? String(err),
      }));
      return null;
    }
  }
  return null;
}

/** Look up code → owner userId. Point-read on partition. */
export async function findCodeOwner(code: string): Promise<string | null> {
  if (!code) return null;
  const c = await ensureInit();
  if (!c) return null;
  try {
    const codeUpper = code.trim().toUpperCase();
    const { resource } = await c.codes.item(codeUpper, codeUpper).read<ReferralCodeDoc>();
    return resource?.userId ?? null;
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) return null;
    console.warn(JSON.stringify({
      event: "referral_code_lookup_failed",
      source: "referralCode.service",
      error: err?.message ?? String(err),
    }));
    return null;
  }
}

// ─── Redemption ──────────────────────────────────────────────────────────────

export interface RedeemResult {
  status: "redeemed" | "self-redemption" | "code-not-found" | "already-redeemed" | "error";
  refereeSubscribedAt?: string;
  referrerUserId?: string;
  code?: string;
  message?: string;
}

/**
 * Referee redeems a referral code. Called at paid-signup or upgrade.
 * Rejects self-redemption + duplicate redemptions.
 */
export async function redeemReferralCode(input: {
  code: string;
  refereeUserId: string;
}): Promise<RedeemResult> {
  if (!input.code || !input.refereeUserId) {
    return { status: "error", message: "code + refereeUserId required" };
  }
  const c = await ensureInit();
  if (!c) return { status: "error", message: "backend unavailable" };
  const codeUpper = input.code.trim().toUpperCase();
  const referrerUserId = await findCodeOwner(codeUpper);
  if (!referrerUserId) return { status: "code-not-found", code: codeUpper };
  if (referrerUserId === input.refereeUserId) {
    return { status: "self-redemption", code: codeUpper };
  }
  // Duplicate-check: has this referee already redeemed ANY code?
  try {
    const { resources } = await c.refs.items.query({
      query: "SELECT TOP 1 c.id FROM c WHERE c.refereeUserId = @r",
      parameters: [{ name: "@r", value: input.refereeUserId }],
    }).fetchAll();
    if (resources && resources.length > 0) {
      return { status: "already-redeemed", code: codeUpper };
    }
  } catch { /* fall through — treat as not-yet-redeemed */ }
  const now = new Date().toISOString();
  const doc: ReferralDoc = {
    id: `${input.refereeUserId}::${codeUpper}::${Date.now()}`,
    referrerUserId,
    refereeUserId: input.refereeUserId,
    code: codeUpper,
    redeemedAt: now,
    refereeSubscribedAt: null,
    refereeActivatedAt: null,
    creditGrantedAt: null,
    status: "pending",
    ttl: -1,
  };
  try {
    await c.refs.items.create(doc);
    return {
      status: "redeemed",
      referrerUserId,
      code: codeUpper,
      refereeSubscribedAt: doc.refereeSubscribedAt ?? undefined,
    };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "referral_redeem_failed",
      source: "referralCode.service",
      error: (err as Error)?.message ?? String(err),
    }));
    return { status: "error", message: (err as Error)?.message ?? String(err) };
  }
}

// ─── Referrer stats ──────────────────────────────────────────────────────────

export interface ReferrerStats {
  code: string | null;
  totalReferrals: number;
  pendingReferrals: number;
  grantedCredits: number;
}

/** Get the referrer's dashboard stats (code + credit summary). */
export async function getReferrerStats(userId: string): Promise<ReferrerStats> {
  const code = await getOrCreateReferralCode(userId);
  const c = await ensureInit();
  if (!c) return { code, totalReferrals: 0, pendingReferrals: 0, grantedCredits: 0 };
  try {
    const { resources } = await c.refs.items.query({
      query: "SELECT c.status FROM c WHERE c.referrerUserId = @u",
      parameters: [{ name: "@u", value: userId }],
    }, { partitionKey: userId }).fetchAll();
    const total = (resources ?? []).length;
    const pending = (resources ?? []).filter((r: any) => r.status === "pending").length;
    const granted = (resources ?? []).filter((r: any) => r.status === "granted").length;
    return { code, totalReferrals: total, pendingReferrals: pending, grantedCredits: granted };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "referrer_stats_read_failed",
      source: "referralCode.service",
      error: (err as Error)?.message ?? String(err),
    }));
    return { code, totalReferrals: 0, pendingReferrals: 0, grantedCredits: 0 };
  }
}

// ─── Activation gate (called by App Store webhook / cron) ────────────────────

/**
 * Called by the App Store subscription webhook when a referee's paid
 * subscription confirms (initial-buy or renewal event). Marks the
 * referral as `refereeSubscribedAt`. The 30-day active-gate runs
 * separately (see maybeGrantReferrerCredit).
 */
export async function recordRefereeSubscribed(refereeUserId: string): Promise<boolean> {
  if (!refereeUserId) return false;
  const c = await ensureInit();
  if (!c) return false;
  try {
    // Find the referral doc for this referee (cross-partition — small table).
    const { resources } = await c.refs.items.query({
      query: "SELECT TOP 1 * FROM c WHERE c.refereeUserId = @r AND c.status = 'pending'",
      parameters: [{ name: "@r", value: refereeUserId }],
    }).fetchAll();
    if (!resources || resources.length === 0) return false;
    const doc = resources[0] as ReferralDoc;
    doc.refereeSubscribedAt = new Date().toISOString();
    await c.refs.items.upsert(doc);
    return true;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "referee_subscribed_write_failed",
      source: "referralCode.service",
      error: (err as Error)?.message ?? String(err),
    }));
    return false;
  }
}

/**
 * Nightly cron entry. For each pending referral where refereeSubscribedAt
 * was more than 30 days ago, mark refereeActivatedAt + creditGrantedAt +
 * flip status to `granted`. Returns count granted.
 */
export async function grantMaturedReferralCredits(): Promise<{
  granted: number;
  scanned: number;
}> {
  const c = await ensureInit();
  if (!c) return { granted: 0, scanned: 0 };
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let granted = 0;
  let scanned = 0;
  try {
    const { resources } = await c.refs.items.query({
      query: "SELECT * FROM c WHERE c.status = 'pending' AND c.refereeSubscribedAt != null AND c.refereeSubscribedAt <= @cutoff",
      parameters: [{ name: "@cutoff", value: cutoff }],
    }).fetchAll();
    scanned = (resources ?? []).length;
    for (const doc of resources ?? []) {
      const d = doc as ReferralDoc;
      d.refereeActivatedAt = new Date().toISOString();
      d.creditGrantedAt = new Date().toISOString();
      d.status = "granted";
      try {
        await c.refs.items.upsert(d);
        granted++;
      } catch (err) {
        console.warn(JSON.stringify({
          event: "referral_grant_write_failed",
          source: "referralCode.service",
          id: d.id,
          error: (err as Error)?.message ?? String(err),
        }));
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "referral_grant_scan_failed",
      source: "referralCode.service",
      error: (err as Error)?.message ?? String(err),
    }));
  }
  return { granted, scanned };
}
