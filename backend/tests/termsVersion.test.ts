// CF-TERMS-ACCEPTANCE. The version constant is duplicated across three
// runtimes (backend, web, iOS) because none of them can import from the
// others. Duplication is fine; DRIFT is not — a backend that has moved
// ahead re-prompts every user against text the clients still render at the
// old version. These tests pin them together.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  TERMS_VERSION,
  TERMS_URL,
  PRIVACY_URL,
  isCurrentTermsVersion,
} from "../src/services/legal/termsVersion";

const repoRoot = resolve(__dirname, "..", "..");

describe("isCurrentTermsVersion", () => {
  it("accepts only the exact current version", () => {
    expect(isCurrentTermsVersion(TERMS_VERSION)).toBe(true);
  });

  it("rejects a stale acceptance", () => {
    // The whole point: an old agreement is not consent to the new text.
    expect(isCurrentTermsVersion("2026-07-27")).toBe(false);
  });

  it("rejects absent or malformed acceptance", () => {
    expect(isCurrentTermsVersion(null)).toBe(false);
    expect(isCurrentTermsVersion(undefined)).toBe(false);
    expect(isCurrentTermsVersion("")).toBe(false);
    // A legacy boolean-shaped value must never read as accepted.
    expect(isCurrentTermsVersion("true")).toBe(false);
  });

  it("tolerates surrounding whitespace from a stored value", () => {
    expect(isCurrentTermsVersion(` ${TERMS_VERSION} `)).toBe(true);
  });
});

describe("terms constants", () => {
  it("uses a sortable ISO date so versions compare lexicographically", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("points at the canonical public pages", () => {
    expect(TERMS_URL).toBe("https://hobby-iq.com/terms");
    expect(PRIVACY_URL).toBe("https://hobby-iq.com/privacy");
  });
});

describe("cross-runtime version lockstep", () => {
  it("matches the web constant in apps/web/src/lib/legal.ts", () => {
    const webLegal = resolve(repoRoot, "apps/web/src/lib/legal.ts");
    expect(existsSync(webLegal)).toBe(true);

    const src = readFileSync(webLegal, "utf8");
    const match = src.match(/export const TERMS_VERSION\s*=\s*"([^"]+)"/);
    expect(match?.[1]).toBe(TERMS_VERSION);
  });

  it("matches the iOS constant once LegalTerms.swift exists", () => {
    const swift = resolve(repoRoot, "HobbyIQ/LegalTerms.swift");
    if (!existsSync(swift)) {
      // iOS gate not shipped yet — this assertion arms itself when the file
      // lands, rather than silently passing forever.
      expect(existsSync(swift)).toBe(false);
      return;
    }
    const src = readFileSync(swift, "utf8");
    const match = src.match(/static let termsVersion\s*=\s*"([^"]+)"/);
    expect(match?.[1]).toBe(TERMS_VERSION);
  });
});
