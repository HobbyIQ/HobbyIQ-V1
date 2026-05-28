// CF-UNIFIED-SEARCH-AND-CERT v1 W2 — cert-grader registry.
//
// Per design doc 23038d7 §1. Module-level Map keyed by grader id. Each
// v1.5 grader CF adds one `registerCertGrader(...)` call (in index.ts);
// nothing else changes.
//
// Collision is a programming error (two grader files claiming the same
// id), not a runtime condition — throws synchronously at register time
// so the bug surfaces in CI / startup logs rather than silently
// shadowing one grader with another.

import type { CertGrader } from "./certGrader.js";

const _registry = new Map<string, CertGrader>();

export function registerCertGrader(grader: CertGrader): void {
  if (_registry.has(grader.id)) {
    throw new Error(`Cert grader id collision: ${grader.id}`);
  }
  _registry.set(grader.id, grader);
}

/** Returns all registered graders, in insertion order. */
export function listCertGraders(): CertGrader[] {
  return [..._registry.values()];
}

/**
 * Returns the subset of registered graders whose `recognizes(input)`
 * returns true. Used by the W3 dispatcher to decide cert-vs-freetext
 * mode and which grader(s) to fan lookup out to.
 */
export function findRecognizingGraders(input: string): CertGrader[] {
  return [..._registry.values()].filter((g) => g.recognizes(input));
}

export function getCertGrader(id: string): CertGrader | undefined {
  return _registry.get(id);
}

/**
 * Test-only escape hatch — do not call from production code.
 *
 * Lets tests reset registry state between cases without monkey-patching
 * the Map. NOT re-exported from index.ts — only certGraders/*.test.ts
 * imports this directly. Calling this from a request handler would
 * empty the grader registry mid-flight and break every subsequent
 * cert lookup until the next process restart.
 */
export function __resetRegistryForTest(): void {
  _registry.clear();
}
