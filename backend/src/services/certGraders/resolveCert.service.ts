// CF-CERT-READ-THROUGH (Drew, 2026-08-13: "lets do it").
//
// One entry point for "given a cert number, what card is this and what is it
// worth" — fast on repeat, and independent of CardHedge.
//
// TWO PROBLEMS THIS SOLVES AT ONCE.
//
// 1. SPEED. Every lookup was a live vendor round trip. Measured 2026-08-13:
//      PSA GetByCertNumber   412 / 481 / 778 ms   every time
//      Cosmos point read     1 RU, tens of ms     after the first
//    A cert is immutable once graded, so the second lookup of a cert never
//    needs to leave our database.
//
// 2. IT WAS DEAD. /api/compiq/lookup-by-cert called getFmvByCert +
//    getPricesByCert, both in cardhedge.client. With CH_RUNTIME_DISABLED=true
//    in prod, headers() returns null and both return null — the endpoint has
//    been returning nothing at all. Routing through the grader registry
//    (PSA today, BGS/SGC/CGC as adapters land) removes that dependency.
//
// PRICING COMES FROM OUR OWN POOL. The store keeps cert -> canonical cardId,
// so once a cert is known its value is answered from sold_comps. That is the
// difference between caching a vendor and owning the answer.

import {
  readGradedCert,
  writeGradedCert,
  type GradedCertDoc,
} from "./gradedCertStore.service.js";
import { getCertGrader, findRecognizingGraders } from "./registry.js";
import "./index.js";   // side-effect: registers the shipped graders

export interface ResolvedCert {
  grader: string;
  certNumber: string;
  grade: string | null;
  /** Canonical hobbyiqCardId, when the cert's card is in our catalog. */
  cardId: string | null;
  playerName: string | null;
  year: number | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean | null;
  totalPopulation: number | null;
  populationHigher: number | null;
  /** "store" when served from graded_cert (fast path), "grader" on a miss. */
  servedFrom: "store" | "grader";
  elapsedMs: number;
}

function toResolved(doc: GradedCertDoc, servedFrom: "store" | "grader", elapsedMs: number): ResolvedCert {
  return {
    grader: doc.grader,
    certNumber: doc.certNumber,
    grade: doc.grade,
    cardId: doc.cardId,
    playerName: doc.playerName,
    year: doc.year,
    setName: doc.setName,
    cardNumber: doc.cardNumber,
    parallel: doc.parallel,
    isAuto: doc.isAuto,
    totalPopulation: doc.totalPopulation,
    populationHigher: doc.populationHigher,
    servedFrom,
    elapsedMs,
  };
}

/**
 * Resolve a cert to a card identity.
 *
 * Order: point read (1 RU) -> grader lookup -> persist -> return.
 * `forceRefresh` skips the store read, for the rare case of re-deriving
 * identity after the parser improves.
 */
export async function resolveCert(
  grader: string,
  certNumber: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<ResolvedCert | null> {
  const started = Date.now();
  const cert = String(certNumber ?? "").trim();
  const graderId = String(grader ?? "").trim().toLowerCase();
  if (!cert) return null;

  if (!opts.forceRefresh) {
    const hit = await readGradedCert(graderId, cert);
    if (hit) return toResolved(hit, "store", Date.now() - started);
  }

  // Miss — ask the grader. Prefer the named grader; fall back to whichever
  // recognizes the number's shape, so a caller that omits the grader (a bare
  // scanned cert) still resolves.
  const adapter = getCertGrader(graderId) ?? findRecognizingGraders(cert)[0];
  if (!adapter) return null;

  let identity;
  let raw: unknown = null;
  try {
    const result = await adapter.lookup(cert);
    raw = result.cardRaw;
    identity = adapter.toCardIdentity(result);

    const doc = await writeGradedCert({
      grader: adapter.id.toUpperCase(),
      certNumber: cert,
      grade: identity.grade ?? null,
      // Left null here: placing the cert on a catalog card is a separate,
      // fallible step (below). Storing the cert is still worth it — the
      // identity and grade are authoritative even when the card is not in
      // our catalog yet.
      cardId: null,
      playerName: identity.player ?? null,
      year: identity.year ?? null,
      setName: identity.setName ?? null,
      cardNumber: identity.cardNumber ?? null,
      parallel: identity.parallel ?? null,
      isAuto: identity.isAuto ?? null,
      totalPopulation: identity.totalPopulation ?? null,
      populationHigher: identity.populationHigher ?? null,
      raw,
      source: `${adapter.id}-api`,
    });
    if (!doc) return null;

    // Place it on a catalog card so pricing can come from our own pool.
    // Best-effort and non-blocking for the caller's identity answer: a cert we
    // cannot place is still a resolved cert, and linkCertToCard can fill this
    // in later once the checklist lands via the seed drainer.
    void (async () => {
      try {
        const { canonicalize } = await import("../catalog/catalogMatcher.service.js");
        const { linkCertToCard } = await import("./gradedCertStore.service.js");
        const match = await canonicalize({
          sport: "baseball",
          year: identity.year ?? null,
          setName: identity.setName ?? "",
          cardNumber: identity.cardNumber ?? "",
          parallel: identity.parallel ?? null,
          isAuto: Boolean(identity.isAuto),
          playerName: identity.player ?? "",
          source: "cert",
        } as never);
        // Only a strong match — a cert is authoritative about the CARD, so
        // pinning it to the wrong catalog row would be worse than leaving it
        // unlinked and pricing from nothing.
        if (match?.found && match.slug && match.confidence >= 0.9) {
          await linkCertToCard(adapter.id.toUpperCase(), cert, match.slug);
        }
      } catch { /* link is an optimisation, never a failure */ }
    })();

    return toResolved(doc, "grader", Date.now() - started);
  } catch {
    // CertGraderError (not found / rate limited / upstream down) — the caller
    // decides how to surface it. Nothing is written on a failed lookup.
    return null;
  }
}
