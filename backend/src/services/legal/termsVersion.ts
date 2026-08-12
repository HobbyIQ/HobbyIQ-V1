// CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Server-side source of truth for
// which Terms version a user must have agreed to.
//
// Acceptance is stored as a VERSION STRING, never a boolean. A stored
// `termsAccepted: true` from last year is not consent to this year's text,
// and §14 of the Terms commits us to notice on material change. Bumping
// this constant is that mechanism: every user whose stored version no
// longer matches is re-prompted on next sign-in.
//
// Keep in lockstep with:
//   apps/web/src/lib/legal.ts  → TERMS_VERSION
//   HobbyIQ/LegalTerms.swift   → termsVersion
// All three MUST carry the same value.
//
// Bump procedure: publish the new Terms page, update all three constants in
// the SAME PR, then deploy. Deploying the backend ahead of the clients
// re-prompts users against text they can't read yet.

export const TERMS_VERSION = "2026-08-12";

/** Public URL of the canonical Terms, surfaced to clients so the consent
 *  UI always links the exact text being agreed to. */
export const TERMS_URL = "https://hobby-iq.com/terms";
export const PRIVACY_URL = "https://hobby-iq.com/privacy";

/** True when a stored acceptance still satisfies the current Terms. */
export function isCurrentTermsVersion(accepted: string | null | undefined): boolean {
  return typeof accepted === "string" && accepted.trim() === TERMS_VERSION;
}
