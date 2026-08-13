// CF-GRADED-CERT-STORE (Drew, 2026-08-13: "the question is cert # for
// searching. How would we do it with speed?").
//
// Activates the `graded_cert` container parked in the backlog since 2026-07-28.
//
// WHY THIS IS THE FAST SHAPE. A cert number is already a perfect partition key:
// {grader}:{cert} is globally unique, immutable, and known before the lookup.
// So a repeat lookup is a POINT READ — 1 RU — instead of a vendor round trip.
// Measured 2026-08-13:
//
//     PSA GetByCertNumber      412ms / 481ms / 778ms   every single lookup
//     Cosmos point read        1 RU  (tens of ms; single-digit in-region)
//
// For the scan-a-slab workflow, where a user looks up their own certs
// repeatedly, that is 0.5s EVERY time versus 0.5s ONCE, ever.
//
// WHAT IT STORES: identity, not price. certKey -> grader, grade, and the
// canonical cardId slug. Price then comes from our own sold_comps via that
// cardId, so once a cert is known the hot path touches no vendor at all. That
// is what makes this durable rather than merely cached — it matches the
// persist-vendor-lookups doctrine: every lookup grows an owned container.
//
// A cert is IMMUTABLE once graded — the slab's identity and grade never change
// — so entries never expire. Only the cardId link is refreshable, for when our
// catalog later learns the card the cert pointed at.

import { CosmosClient, type Container } from "@azure/cosmos";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const GRADED_CERT_CONTAINER = process.env.COSMOS_GRADED_CERT_CONTAINER ?? "graded_cert";

let _container: Container | null = null;

/** Container handle. Creates on first use with /certKey as the partition key —
 *  the whole point of the design, so a lookup is a single-partition read. */
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const { database } = await client.databases.createIfNotExists({ id: COSMOS_DATABASE });
    const { container } = await database.containers.createIfNotExists({
      id: GRADED_CERT_CONTAINER,
      partitionKey: { paths: ["/certKey"] },
    });
    _container = container;
    return _container;
  } catch { return null; }
}

export interface GradedCertDoc {
  /** `${grader}:${cert}` — id AND partition key, so reads are ~1 RU. */
  id: string;
  certKey: string;
  grader: string;              // PSA | BGS | SGC | CGC
  certNumber: string;
  grade: string | null;        // "10", "9.5", "AUTHENTIC"
  /** Canonical hobbyiqCardId once we can place the cert on a catalog card.
   *  Null when the cert resolved but its card is not in our catalog yet — the
   *  cert is still worth storing, and the link can be filled in later. */
  cardId: string | null;
  playerName: string | null;
  year: number | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean | null;
  totalPopulation: number | null;
  populationHigher: number | null;
  /** Grader payload as returned, for re-deriving identity if our parser improves. */
  raw: unknown;
  source: string;              // "psa-api" etc — which grader answered
  firstSeenAt: string;
  lastSeenAt: string;
}

export function certKeyFor(grader: string, cert: string): string {
  return `${String(grader ?? "").trim().toLowerCase()}:${String(cert ?? "").trim().toLowerCase()}`;
}

/** Point read. ~1 RU. Returns null on miss or when Cosmos is unconfigured. */
export async function readGradedCert(
  grader: string,
  cert: string,
): Promise<GradedCertDoc | null> {
  const key = certKeyFor(grader, cert);
  const c = await getContainer();
  if (!c) return null;
  try {
    const { resource } = await c.item(key, key).read<GradedCertDoc>();
    return resource ?? null;
  } catch (e) {
    if ((e as { code?: number }).code === 404) return null;
    return null;   // never fail a lookup on a cache miss path
  }
}

/**
 * Upsert a cert. Preserves firstSeenAt, and never overwrites a known cardId
 * with null — a later lookup that fails to place the card must not erase a
 * link we already established.
 */
export async function writeGradedCert(
  doc: Omit<GradedCertDoc, "id" | "certKey" | "firstSeenAt" | "lastSeenAt">,
): Promise<GradedCertDoc | null> {
  const c = await getContainer();
  if (!c) return null;
  const key = certKeyFor(doc.grader, doc.certNumber);
  const now = new Date().toISOString();
  const existing = await readGradedCert(doc.grader, doc.certNumber);
  const next: GradedCertDoc = {
    ...doc,
    id: key,
    certKey: key,
    cardId: doc.cardId ?? existing?.cardId ?? null,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
  };
  try {
    await c.items.upsert(next);
    return next;
  } catch { return null; }
}

/** Attach the canonical cardId to a cert we already hold — used when the
 *  catalog later learns the card (e.g. a checklist lands via the seed drainer)
 *  and a previously unplaceable cert becomes placeable. */
export async function linkCertToCard(
  grader: string,
  cert: string,
  cardId: string,
): Promise<boolean> {
  const existing = await readGradedCert(grader, cert);
  if (!existing) return false;
  const c = await getContainer();
  if (!c) return false;
  try {
    await c.items.upsert({ ...existing, cardId, lastSeenAt: new Date().toISOString() });
    return true;
  } catch { return false; }
}
