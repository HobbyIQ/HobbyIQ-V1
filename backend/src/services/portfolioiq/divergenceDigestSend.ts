// divergenceDigestSend.ts — the cost-basis divergence + projection-bound
// digest, with a delivery result that is READ, not discarded.
//
// D13 (2026-08-29) — alert gates prove delivery. The digest lived inline
// in repriceHoldingsForUser behind three swallows: the emailService
// import `.catch(() => ({ sendEmail: null }))`, `sendEmail(...).catch(() =>
// {})`, and an outer `catch {}` — and `{ delivered: false, devLogged: true }`
// (ACS unconfigured) was never looked at. The recipient was a literal with
// no override. So a digest that never left the building was
// indistinguishable from one that did.
//
// Contract:
//   sendDivergenceDigest → { delivered, reason } and NEVER throws.
//   Not delivered → console.warn {event:"cost_basis_digest_not_delivered",
//                   reason, users, rows}   (warn-level: App Insights query)
//   Delivered     → console.log  {event:"cost_basis_digest_delivered", ...}
//   Recipient     → OPS_ALERT_EMAIL (trimmed) else the historical literal.
//                   The address is never logged.

import type {
  BoundedProjectionAlert,
  CostBasisDivergenceAlert,
} from "../compiq/boundedProjectionAlerts.service.js";
import type { SendEmailInput, SendEmailResult } from "../emailService.js";

/** Historical recipient. Fallback only — override via OPS_ALERT_EMAIL. */
const DEFAULT_DIGEST_RECIPIENT = "drew@justtheboysandcards.com";

export function resolveDigestRecipient(): string {
  return process.env.OPS_ALERT_EMAIL?.trim() || DEFAULT_DIGEST_RECIPIENT;
}

export type DigestNotDeliveredReason =
  | "email-module-unavailable"
  | "acs-unconfigured"
  | "email-provider-failed"
  | "send-threw"
  | (string & {});

export interface DivergenceDigestResult {
  delivered: boolean;
  reason: DigestNotDeliveredReason | null;
  users: number;
  rows: number;
}

export type SendEmailFn = (input: SendEmailInput) => Promise<SendEmailResult>;

async function defaultSendEmail(): Promise<SendEmailFn | null> {
  try {
    const mod = await import("../emailService.js");
    return typeof mod.sendEmail === "function" ? mod.sendEmail : null;
  } catch {
    return null;
  }
}

export function buildDivergenceDigestContent(input: {
  userId: string;
  hits: BoundedProjectionAlert[];
  divergenceHits: CostBasisDivergenceAlert[];
}): { subject: string; plainText: string; html: string } {
  const { userId, hits, divergenceHits } = input;
  const boundsPreview = hits.slice(0, 10).map((h) => {
    const pctRaw = Math.round((h.rawMultiplier - 1) * 1000) / 10;
    const pctBounded = Math.round((h.bounded - 1) * 1000) / 10;
    return `  ${h.playerName ?? "?"} — rate ${(h.rate * 100).toFixed(1)}%/wk × ${h.weeksSinceSale.toFixed(1)}wk → raw ${pctRaw >= 0 ? "+" : ""}${pctRaw}% (bounded ${pctBounded >= 0 ? "+" : ""}${pctBounded}%) [${h.direction}]`;
  }).join("\n");
  const boundsOverflow = hits.length > 10 ? `\n\n... and ${hits.length - 10} more` : "";
  // Divergence section — sort by absolute % first so the biggest gaps
  // (like the Hartman 85% loss) surface at the top.
  const divergenceSorted = [...divergenceHits].sort((a, b) => Math.abs(b.gainLossPct) - Math.abs(a.gainLossPct));
  const divergencePreview = divergenceSorted.slice(0, 10).map((d) => {
    const pct = Math.round(d.gainLossPct * 1000) / 10;
    const cost = Math.round(d.costBasis);
    const fmv = Math.round(d.fmv);
    const label = d.cardTitle ?? d.playerName ?? d.slug ?? d.holdingId;
    const method = d.fmvRung ? ` [${d.fmvRung}]` : d.fmvMethod ? ` [${d.fmvMethod}]` : "";
    return `  ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%  $${cost} → $${fmv}  ${label}${method}`;
  }).join("\n");
  const divergenceOverflow = divergenceHits.length > 10 ? `\n\n... and ${divergenceHits.length - 10} more` : "";
  const parts: string[] = [];
  const htmlParts: string[] = [];
  if (divergenceHits.length > 0) {
    parts.push(
      `${divergenceHits.length} cost-basis vs FMV divergence${divergenceHits.length === 1 ? "" : "s"} ` +
      `(>40% AND >$500):\n${divergencePreview}${divergenceOverflow}`,
    );
    htmlParts.push(`<p><strong>${divergenceHits.length} cost-basis vs FMV divergence${divergenceHits.length === 1 ? "" : "s"}</strong></p><pre style="font-family:monospace;font-size:13px;background:#f6f8fa;padding:12px;border-radius:6px">${divergencePreview}${divergenceOverflow}</pre>`);
  }
  if (hits.length > 0) {
    parts.push(
      `${hits.length} projection-multiplier bound hit${hits.length === 1 ? "" : "s"}:\n${boundsPreview}${boundsOverflow}`,
    );
    htmlParts.push(`<p><strong>${hits.length} projection-multiplier bound hit${hits.length === 1 ? "" : "s"}</strong></p><pre style="font-family:monospace;font-size:13px;background:#f6f8fa;padding:12px;border-radius:6px">${boundsPreview}${boundsOverflow}</pre>`);
  }
  const subject = divergenceHits.length > 0
    ? `[HobbyIQ] ${divergenceHits.length} pricing divergence${divergenceHits.length === 1 ? "" : "s"} + ${hits.length} bound hit${hits.length === 1 ? "" : "s"} in reprice for ${userId}`
    : `[HobbyIQ] ${hits.length} projection-bound hit${hits.length === 1 ? "" : "s"} in reprice for ${userId}`;
  return {
    subject,
    plainText:
      `Reprice for userId=${userId}.\n\n` +
      parts.join("\n\n") +
      `\n\nKQL: search for event in ("cost_basis_fmv_divergence", "bounded_projection_alert") in App Insights.`,
    html: `<p>Reprice for <strong>${userId}</strong>.</p>${htmlParts.join("")}<p>KQL: search for <code>event in ("cost_basis_fmv_divergence", "bounded_projection_alert")</code> in App Insights.</p>`,
  };
}

/**
 * Send the digest and SAY what happened. Never throws; never logs the
 * recipient address.
 */
export async function sendDivergenceDigest(
  input: {
    userId: string;
    hits: BoundedProjectionAlert[];
    divergenceHits: CostBasisDivergenceAlert[];
  },
  deps: { sendEmail?: SendEmailFn | null } = {},
): Promise<DivergenceDigestResult> {
  const rows = input.hits.length + input.divergenceHits.length;
  const users = new Set<string>([input.userId, ...input.divergenceHits.map((d) => d.userId)].filter(Boolean)).size;
  const finish = (delivered: boolean, reason: DigestNotDeliveredReason | null): DivergenceDigestResult => {
    const result = { delivered, reason, users, rows };
    if (delivered) {
      console.log(JSON.stringify({ event: "cost_basis_digest_delivered", users, rows, divergences: input.divergenceHits.length, boundHits: input.hits.length }));
    } else {
      console.warn(JSON.stringify({ event: "cost_basis_digest_not_delivered", reason, users, rows }));
    }
    return result;
  };

  if (rows === 0) return { delivered: false, reason: "nothing-to-send", users, rows };

  const sendEmail = deps.sendEmail === undefined ? await defaultSendEmail() : deps.sendEmail;
  if (!sendEmail) return finish(false, "email-module-unavailable");

  const content = buildDivergenceDigestContent(input);
  let result: SendEmailResult;
  try {
    result = await sendEmail({ to: resolveDigestRecipient(), ...content });
  } catch {
    return finish(false, "send-threw");
  }
  if (result?.delivered === true) return finish(true, null);
  if (result?.devLogged) return finish(false, "acs-unconfigured");
  return finish(false, result?.error || "email-provider-failed");
}
