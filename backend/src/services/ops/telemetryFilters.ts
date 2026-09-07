// CF-TELEMETRY-VOLUME (2026-09-07). Drops the Cosmos gateway health ping from
// dependency telemetry.
//
// WHY. The 2026-09-07 investigation (#1977,
// backend/docs/reports/2026-09-07-app-service-recycles-and-telemetry-loss.md)
// measured AppDependencies at 215,692,220 rows over 7 days — ~356,000/hour —
// overwhelmingly one shape:
//
//   DependencyType: HTTP   Name: "GET /"   Target: hobbyiq-comps.documents.azure.com
//   DurationMs: 1          ResultCode: 200
//
// Those are Cosmos SDK metadata/health pings, recorded individually. They carry
// no diagnostic value — a 1ms 200 on the account root tells us nothing we would
// ever query — and they made App Insights UNREADABLE: the query API times out
// on windows as short as five minutes, which is what made the recycle
// investigation take a forensic activity-log dig instead of a KQL query. At
// PerGB2018 they are also a live and rising bill.
//
// WHAT IS DROPPED — deliberately narrow, all four must hold:
//   1. the span is an outgoing HTTP CLIENT call (never a server span, so an
//      inbound request to our own "GET /" can never match),
//   2. the target host is a *.documents.azure.com Cosmos account,
//   3. the route is the account root ("/" or empty — never a real db/coll path,
//      so no query, read, write or feed is ever dropped),
//   4. it was fast (<= 5ms) AND successful (2xx/3xx).
//
// The duration and success clauses are the load-bearing safety property: a slow
// root call or a failing one is exactly the signal worth keeping, so a Cosmos
// outage or latency regression still shows up in telemetry at full fidelity.
// This filters noise, never evidence.

/** Max duration (ms) for a root-path Cosmos call to count as a health ping. */
export const COSMOS_PING_MAX_DURATION_MS = 5;

/**
 * The subset of an OpenTelemetry span this decision actually reads. Kept as a
 * plain structural type so the rule is unit-testable against a fake envelope
 * without constructing a real SDK span.
 */
export interface DependencyEnvelope {
  /** OTel SpanKind. 2 = CLIENT (outgoing). Anything else is not a dependency. */
  kind?: number;
  attributes?: Record<string, unknown>;
  durationMs?: number;
}

/**
 * OTel SpanKind.CLIENT.
 *
 * The enum is INTERNAL=0, SERVER=1, CLIENT=2, PRODUCER=3, CONSUMER=4 — verified
 * against @opentelemetry/api at runtime, and pinned by a test that imports the
 * real enum rather than trusting this line. Getting it wrong is silent: a
 * filter keyed to the wrong kind matches nothing, drops nothing, and still
 * passes any test written against its own constant.
 *
 * Hard-coded rather than imported so this module needs no dependency on the
 * OTel API package, which is present only transitively.
 */
export const SPAN_KIND_CLIENT = 2;

function firstString(
  attrs: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function firstNumber(
  attrs: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    // Some instrumentations stringify status codes.
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

/**
 * True when the span is a Cosmos gateway health ping that carries no
 * diagnostic value and should not be exported.
 *
 * Reads both the current (`server.address`, `url.path`, `http.request.method`,
 * `http.response.status_code`) and legacy (`net.peer.name`, `http.url`,
 * `http.target`, `http.method`, `http.status_code`) OTel semantic-convention
 * attribute names, because the Cosmos SDK's own instrumentation and the undici
 * instrumentation registered in server.ts do not agree on which set they emit.
 */
export function isCosmosGatewayPing(span: DependencyEnvelope): boolean {
  // 1. Outgoing client call only. A server span is our own inbound traffic.
  if (span.kind !== undefined && span.kind !== SPAN_KIND_CLIENT) return false;

  const attrs = span.attributes ?? {};

  // 2. Target must be a Cosmos account host.
  let host = firstString(
    attrs,
    "server.address",
    "net.peer.name",
    "peer.service",
    "http.host",
  );
  const rawUrl = firstString(attrs, "url.full", "http.url");
  if (!host && rawUrl) {
    try {
      host = new URL(rawUrl).hostname;
    } catch {
      /* not parseable — leave host undefined and refuse to drop */
    }
  }
  if (!host) return false;
  const hostname = host.toLowerCase().split(":")[0];
  if (!hostname.endsWith(".documents.azure.com")) return false;

  // 3. Route must be the account root. Never a real db/collection path.
  let path = firstString(attrs, "url.path", "http.target", "http.route");
  if (path === undefined && rawUrl) {
    try {
      path = new URL(rawUrl).pathname;
    } catch {
      /* fall through */
    }
  }
  if (path === undefined) return false;
  const cleanPath = path.split("?")[0];
  if (cleanPath !== "/" && cleanPath !== "") return false;

  // The report's rows are "GET /". Only ever drop a GET; a write to the root
  // would be something we have not seen and should not silently discard.
  const method = firstString(attrs, "http.request.method", "http.method");
  if (method !== undefined && method.toUpperCase() !== "GET") return false;

  // 4a. Fast. A slow root call is a latency signal worth keeping.
  if (span.durationMs === undefined) return false;
  if (!(span.durationMs <= COSMOS_PING_MAX_DURATION_MS)) return false;

  // 4b. Successful. A failing ping is exactly the evidence worth keeping.
  const status = firstNumber(
    attrs,
    "http.response.status_code",
    "http.status_code",
  );
  if (status === undefined) return false;
  if (status < 200 || status >= 400) return false;

  return true;
}
