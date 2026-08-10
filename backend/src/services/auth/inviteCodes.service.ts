// CF-INVITE-ONLY-SIGNUP (Drew, 2026-08-10). Invite-code gating for new
// account creation. Gate is env-driven so it can be flipped on/off
// without code deploys.
//
// Env:
//   SIGNUP_INVITE_REQUIRED=true   → registerUser rejects any new
//                                    account without a valid code.
//                                    Absent/false: legacy free-signup.
//
// Container: invite_codes (partition /code, auto-created on first read)
//
// Row shape:
//   { id: "<CODE>", code: "<CODE>", createdAt, createdBy, expiresAt?,
//     maxUses, usesRemaining, claimedBy: [{userId, at}], notes?, status }
//
// status transitions:
//   active → exhausted   when usesRemaining hits 0
//   active → revoked     when admin calls revokeInviteCode
//
// Redemption is idempotent by (code, userId) — same user redeeming
// twice doesn't double-decrement (defensive; registerUser calls this
// exactly once per successful account creation).

import { CosmosClient, Container } from "@azure/cosmos";
import { randomBytes } from "crypto";

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const conn = process.env.COSMOS_CONNECTION_STRING;
    if (!conn) return null;
    try {
      const client = new CosmosClient(conn);
      const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
      const { container } = await db.containers.createIfNotExists({
        id: "invite_codes",
        partitionKey: { paths: ["/code"] },
      });
      _container = container;
      return _container;
    } catch (err) {
      console.error("[invite-codes] container init failed:", err);
      return null;
    }
  })();
  return _initPromise;
}

export type InviteCodeStatus = "active" | "exhausted" | "revoked";

export interface InviteCode {
  id: string;              // == code (also partition key)
  code: string;
  createdAt: string;       // ISO
  createdBy: string;       // userId of minter, or "admin-cli"
  expiresAt?: string | null;
  maxUses: number;         // total allowed redemptions (default 1)
  usesRemaining: number;   // decremented on each claim
  claimedBy: Array<{ userId: string; at: string }>;
  notes?: string | null;
  status: InviteCodeStatus;
  // CF-INVITE-PLAN-GRANT (Drew, 2026-08-10). When set, redemption of
  // this code auto-applies entitlementOverride on the new user's
  // record. Grants ride with the invite, not the account — so
  // "founding invite = pro seller" is baked in at mint time and
  // survives future signup-flow refactors.
  grantsPlan?: "free" | "collector" | "investor" | "pro_seller" | null;
}

export interface MintOptions {
  code?: string;            // custom code (else auto-generated)
  maxUses?: number;         // default 1
  expiresAt?: string | null;
  notes?: string | null;
  createdBy?: string;       // default "admin-cli"
  grantsPlan?: "free" | "collector" | "investor" | "pro_seller" | null;
}

/** Generate a friendly, memorable-ish code: HOBBYIQ-<6 chars>. */
export function generateInviteCode(): string {
  // Base32-ish alphabet (no ambiguous 0/O/1/I/L)
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[buf[i] % alphabet.length];
  return `HOBBYIQ-${out}`;
}

/** Feature flag: require invite for every new account. Default OFF. */
export function isInviteRequired(): boolean {
  return String(process.env.SIGNUP_INVITE_REQUIRED ?? "").toLowerCase() === "true";
}

export async function mintInviteCode(opts: MintOptions = {}): Promise<InviteCode | null> {
  const c = await getContainer();
  if (!c) return null;
  const code = (opts.code ?? generateInviteCode()).trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,64}$/.test(code)) {
    throw new Error(`invite code must match /^[A-Z0-9-]{4,64}$/ (got: ${code})`);
  }
  const maxUses = Math.max(1, Math.min(10000, Math.floor(opts.maxUses ?? 1)));
  const doc: InviteCode = {
    id: code,
    code,
    createdAt: new Date().toISOString(),
    createdBy: opts.createdBy ?? "admin-cli",
    expiresAt: opts.expiresAt ?? null,
    maxUses,
    usesRemaining: maxUses,
    claimedBy: [],
    notes: opts.notes ?? null,
    status: "active",
    grantsPlan: opts.grantsPlan ?? null,
  };
  try {
    const { resource } = await c.items.create(doc);
    return (resource as InviteCode) ?? doc;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 409) throw new Error("invite code already exists");
    throw err;
  }
}

export async function readInviteCode(code: string): Promise<InviteCode | null> {
  const c = await getContainer();
  if (!c) return null;
  const upper = code.trim().toUpperCase();
  try {
    const { resource } = await c.item(upper, upper).read<InviteCode>();
    return resource ?? null;
  } catch (err) {
    const status = (err as { code?: number })?.code;
    if (status === 404) return null;
    throw err;
  }
}

/**
 * Validate + reserve an invite. Returns { ok: true } if the code exists
 * and has capacity + isn't expired/revoked. Actual consumption
 * (decrement + append claimedBy) happens via consumeInviteCode AFTER the
 * account write succeeds — this two-step keeps the code available if
 * account creation fails partway through.
 */
export async function validateInviteCode(
  rawCode: string,
): Promise<{ ok: true; code: InviteCode } | { ok: false; error: string }> {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "Invite code required" };
  const row = await readInviteCode(code);
  if (!row) return { ok: false, error: "Invalid invite code" };
  if (row.status === "revoked") return { ok: false, error: "Invite code has been revoked" };
  if (row.status === "exhausted" || row.usesRemaining <= 0) return { ok: false, error: "Invite code fully redeemed" };
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    return { ok: false, error: "Invite code expired" };
  }
  return { ok: true, code: row };
}

/**
 * Consume the invite — decrement usesRemaining and append the claim
 * audit entry. Best-effort: a failure here is logged but doesn't undo
 * the account creation. Uses read-modify-write; concurrent redemptions
 * of the same code race benignly (small overshoot possible in the
 * worst case; the redeem UI shows a "code fully redeemed" error on the
 * loser next time either user tries again).
 */
export async function consumeInviteCode(code: string, userId: string): Promise<void> {
  const c = await getContainer();
  if (!c) return;
  const upper = String(code || "").trim().toUpperCase();
  if (!upper) return;
  try {
    const row = await readInviteCode(upper);
    if (!row) return;
    // Idempotency: if this userId already appears in claimedBy, don't
    // decrement again.
    if (row.claimedBy.some((c) => c.userId === userId)) return;
    row.usesRemaining = Math.max(0, row.usesRemaining - 1);
    row.claimedBy = [...row.claimedBy, { userId, at: new Date().toISOString() }];
    if (row.usesRemaining === 0) row.status = "exhausted";
    await c.item(upper, upper).replace(row);
  } catch (err) {
    console.warn("[invite-codes] consume failed for", upper, "user", userId, ":", (err as Error)?.message);
  }
}

export async function listInviteCodes(): Promise<InviteCode[]> {
  const c = await getContainer();
  if (!c) return [];
  const { resources } = await c.items
    .query<InviteCode>({ query: "SELECT * FROM c ORDER BY c.createdAt DESC" })
    .fetchAll();
  return resources;
}

export async function revokeInviteCode(code: string): Promise<InviteCode | null> {
  const c = await getContainer();
  if (!c) return null;
  const upper = String(code || "").trim().toUpperCase();
  const row = await readInviteCode(upper);
  if (!row) return null;
  row.status = "revoked";
  const { resource } = await c.item(upper, upper).replace(row);
  return (resource as InviteCode) ?? row;
}
