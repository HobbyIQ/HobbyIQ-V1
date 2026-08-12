//
//  LegalTerms.swift
//  HobbyIQ
//
//  CF-TERMS-ACCEPTANCE (Drew, 2026-08-12). Client-side mirror of the Terms
//  version the user is agreeing to at account creation.
//
//  The version is a STRING, not a boolean. Acceptance is recorded against a
//  specific published text, so when the Terms materially change we bump this
//  constant and users are re-prompted — a stored "true" from an older text
//  is not consent to the new one (Terms §14).
//
//  Keep in lockstep with:
//    backend/src/services/legal/termsVersion.ts → TERMS_VERSION
//    apps/web/src/lib/legal.ts                  → TERMS_VERSION
//  All three MUST carry the same value. backend/tests/termsVersion.test.ts
//  fails the build if they drift.
//

import Foundation

enum LegalTerms {
    /// Must equal TERMS_VERSION in the backend + web constants.
    static let termsVersion = "2026-08-12"

    static let termsURL = URL(string: "https://hobby-iq.com/terms")!
    static let privacyURL = URL(string: "https://hobby-iq.com/privacy")!

    /// Shown next to the consent toggle. Called out explicitly because §20
    /// binds the user to arbitration and a class action waiver, which a
    /// reasonable person would not assume from "Terms and Conditions."
    static let consentSummary =
        "The Terms include a binding arbitration provision and class action waiver."
}
