// CF-CARDHEDGE-LEARN-CORPUS (2026-07-04) — Cosmos persistence of the
// calibration events that let HobbyIQ prove standalone quality before
// retiring the third-party reference signal.
//
// Strategic frame (Drew, 2026-07-04): "Our entire goal is to learn from
// CH; when we get access to eBay we will then be able to do it on our
// own." Every priced request already fires calibration events to
// stdout / App Insights, but log retention is ~30 min platform-wide.
// Persisting the same events to Cosmos gives us a queryable corpus we
// can join at scale — the raw material for training our own model.
//
// SCHEMA:
//   db        = COSMOS_DB ?? "hobbyiq"
//   container = "cardhedge_learn_corpus"
//   partition = /cardId
//   doc id    = ${eventType}:${cardId}:${grade ?? "*"}:${epochMs}
//
// Every write is fire-and-forget. Errors are caught + warned; the corpus
// is a training artifact, not a load-bearing runtime dependency.
//
// CONTAINER LIFECYCLE: createIfNotExists on first write — same pattern
// as predictionCorpus.service.ts:104. No manual az CLI provisioning
// needed; the container appears the first time a real request fires a
// corpus persistence call.
//
// PORTABILITY: `referenceVendor` is captured on every row so future
// migration can filter historical rows by vendor. Schema is designed
// to accept observed data from any source (CH today, eBay later,
// blended eventually) via the same shape.

import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

const DB_NAME = process.env.COSMOS_DB ?? process.env.COSMOS_DATABASE ?? "hobbyiq";
const CONTAINER_NAME =
  process.env.COSMOS_CARDHEDGE_LEARN_CORPUS_CONTAINER ?? "cardhedge_learn_corpus";

let cachedContainer: Container | null = null;
let initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const conn = process.env.COSMOS_CONNECTION_STRING;
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;

      let client: CosmosClient | null = null;
      if (conn) {
        client = new CosmosClient(conn);
      } else if (endpoint && key) {
        client = new CosmosClient({ endpoint, key });
      } else if (endpoint) {
        client = new CosmosClient({
          endpoint,
          aadCredentials: new DefaultAzureCredential(),
        });
      } else {
        return null;
      }

      const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
      const { container } = await database.containers.createIfNotExists({
        id: CONTAINER_NAME,
        partitionKey: { paths: ["/cardId"] },
      });
      cachedContainer = container;
      return container;
    } catch (err) {
      console.warn(
        "[cardhedgeLearnCorpus] init failed:",
        (err as Error).message,
      );
      return null;
    }
  })();

  return initPromise;
}

// ─── Event types + document shapes ────────────────────────────────────────

/** Every doc carries these root fields — the common join surface. */
interface BaseCorpusDoc {
  id: string;
  cardId: string;          // partition key
  eventType: CorpusEventType;
  source: string;          // e.g. "compiq.price-by-id"
  referenceVendor: string; // "cardhedge" today; whatever backing signal is used
  ts: number;              // epoch ms
  ts_iso: string;
  docType: "cardhedgeLearnCorpus";
}

export type CorpusEventType =
  | "reference_prices"
  | "observed_grade_curve"
  | "cert_lookup"
  | "card_panel";

/** Per-grade reference-price snapshot from the third-party model. */
interface ReferencePricesDoc extends BaseCorpusDoc {
  eventType: "reference_prices";
  player: string | null;
  grades: Array<{
    grade: string;
    grader: string | null;
    referencePrice: number;
    displayOrder: number | null;
  }>;
}

/** HobbyIQ's per-grade observed values from raw sales. */
interface ObservedGradeCurveDoc extends BaseCorpusDoc {
  eventType: "observed_grade_curve";
  totalSampleCount: number;
  grades: Array<{
    grade: string;
    grader: string | null;
    sampleCount: number;
    observedMedian: number | null;
    valueSource: "observed" | "estimated" | "unavailable";
    estimatedMultiplier: number | null;
    confidenceScore: number;
    newestSaleDate: string | null;
  }>;
}

/** A user-driven cert lookup — actual graded transaction data. */
interface CertLookupDoc extends BaseCorpusDoc {
  eventType: "cert_lookup";
  cert: string;
  grader: string;
  grade: string | null;
  player: string | null;
  matchConfidence: number | null;
  referencePrice: number | null;
  priceSampleCount: number;
}

/** Panel composition — an audit event proving iOS got a full read. */
interface CardPanelDoc extends BaseCorpusDoc {
  eventType: "card_panel";
  identityResolved: boolean;
  gradeCurveSampleCount: number;
  referenceRowCount: number;
}

// ─── Public write helpers ────────────────────────────────────────────────

/** Compose a stable-shape id so each event type + cardId + grade combo can
 *  be located deterministically. The trailing epoch makes each write unique. */
function makeDocId(
  eventType: CorpusEventType,
  cardId: string,
  gradeOrStar: string,
  epochMs: number,
): string {
  const safeCardId = cardId.replace(/[^\w-]/g, "_");
  const safeGrade = gradeOrStar.replace(/[^\w.-]/g, "_");
  return `${eventType}:${safeCardId}:${safeGrade}:${epochMs}`;
}

async function upsertOrWarn(doc: BaseCorpusDoc): Promise<void> {
  try {
    const container = await getContainer();
    if (!container) return; // No Cosmos config — silently no-op (dev / test)
    await container.items.upsert(doc);
  } catch (err) {
    console.warn(
      `[cardhedgeLearnCorpus] write failed (event=${doc.eventType}, cardId=${doc.cardId}):`,
      (err as Error)?.message ?? err,
    );
  }
}

const REF_VENDOR = "cardhedge";

export function persistReferencePrices(input: {
  source: string;
  cardId: string;
  player: string | null;
  grades: Array<{
    grade: string;
    grader: string | null;
    referencePrice: number;
    displayOrder: number | null;
  }>;
}): void {
  const ts = Date.now();
  const doc: ReferencePricesDoc = {
    id: makeDocId("reference_prices", input.cardId, "*", ts),
    cardId: input.cardId,
    eventType: "reference_prices",
    source: input.source,
    referenceVendor: REF_VENDOR,
    ts,
    ts_iso: new Date(ts).toISOString(),
    docType: "cardhedgeLearnCorpus",
    player: input.player,
    grades: input.grades,
  };
  void upsertOrWarn(doc);
}

export function persistObservedGradeCurve(input: {
  source: string;
  cardId: string;
  totalSampleCount: number;
  grades: Array<{
    grade: string;
    grader: string | null;
    sampleCount: number;
    observedMedian: number | null;
    valueSource: "observed" | "estimated" | "unavailable";
    estimatedMultiplier: number | null;
    confidenceScore: number;
    newestSaleDate: string | null;
  }>;
}): void {
  const ts = Date.now();
  const doc: ObservedGradeCurveDoc = {
    id: makeDocId("observed_grade_curve", input.cardId, "*", ts),
    cardId: input.cardId,
    eventType: "observed_grade_curve",
    source: input.source,
    referenceVendor: REF_VENDOR,
    ts,
    ts_iso: new Date(ts).toISOString(),
    docType: "cardhedgeLearnCorpus",
    totalSampleCount: input.totalSampleCount,
    grades: input.grades,
  };
  void upsertOrWarn(doc);
}

export function persistCertLookup(input: {
  source: string;
  cardId: string | null;
  cert: string;
  grader: string;
  grade: string | null;
  player: string | null;
  matchConfidence: number | null;
  referencePrice: number | null;
  priceSampleCount: number;
}): void {
  // Cert lookups can carry a null cardId when CH fails to resolve — skip
  // the write in that case; there's no partition key.
  if (!input.cardId) return;
  const ts = Date.now();
  const doc: CertLookupDoc = {
    id: makeDocId("cert_lookup", input.cardId, input.cert, ts),
    cardId: input.cardId,
    eventType: "cert_lookup",
    source: input.source,
    referenceVendor: REF_VENDOR,
    ts,
    ts_iso: new Date(ts).toISOString(),
    docType: "cardhedgeLearnCorpus",
    cert: input.cert,
    grader: input.grader,
    grade: input.grade,
    player: input.player,
    matchConfidence: input.matchConfidence,
    referencePrice: input.referencePrice,
    priceSampleCount: input.priceSampleCount,
  };
  void upsertOrWarn(doc);
}

export function persistCardPanel(input: {
  source: string;
  cardId: string;
  identityResolved: boolean;
  gradeCurveSampleCount: number;
  referenceRowCount: number;
}): void {
  const ts = Date.now();
  const doc: CardPanelDoc = {
    id: makeDocId("card_panel", input.cardId, "*", ts),
    cardId: input.cardId,
    eventType: "card_panel",
    source: input.source,
    referenceVendor: REF_VENDOR,
    ts,
    ts_iso: new Date(ts).toISOString(),
    docType: "cardhedgeLearnCorpus",
    identityResolved: input.identityResolved,
    gradeCurveSampleCount: input.gradeCurveSampleCount,
    referenceRowCount: input.referenceRowCount,
  };
  void upsertOrWarn(doc);
}
