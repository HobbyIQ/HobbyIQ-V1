// CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). One source of truth for which
// version of the Terms a user has agreed to.
//
// Acceptance is recorded against TERMS_VERSION, not a boolean. When the
// Terms materially change, bump this constant and every existing user is
// re-prompted on next sign-in — a stored `true` against last year's text
// is not consent to this year's text. Section 14 of the Terms commits us
// to notice on material change; the version bump is the mechanism.
//
// Keep in lockstep with backend/src/services/legal/termsVersion.ts and
// HobbyIQ/LegalTerms.swift. All three MUST carry the same value.

export const TERMS_VERSION = "2026-08-12";
export const TERMS_EFFECTIVE_DATE = "2026-08-12";
export const TERMS_LAST_UPDATED = "2026-08-12";

/** Legal entity behind the HobbyIQ product.
 *
 *  Changed 2026-08-12: the operating entity is now HobbyIQ, LLC (Georgia).
 *  The prior published Terms named Just The Boys And Cards LLC and set
 *  Delaware governing law — both superseded. Anything still citing the old
 *  entity (CLAUDE.md, App Store / Stripe metadata) needs the same update. */
export const LEGAL_ENTITY = "HobbyIQ, LLC";
export const LEGAL_JURISDICTION = "State of Georgia, USA";
export const LEGAL_CONTACT_EMAIL = "drew@hobby-iq.com";

/** Registered notice address (Terms §25). This is the address at which
 *  DMCA notifications and arbitration opt-outs are served — it is legally
 *  operative text, not decoration. Confirmed by Drew 2026-08-12. */
export const LEGAL_ADDRESS_LINES = [
  "3546 Highgrove Way NE",
  "Brookhaven, GA 30319",
] as const;
