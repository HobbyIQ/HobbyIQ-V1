/**
 * CorpusEntry — the persisted record of one CompIQ pricing response,
 * captured via sampled production traffic for the regression harness's
 * Tier 3 corpus (diff-detection layer for future stage extractions).
 *
 * Construction is performed by the buildCorpusEntry() function (added in
 * a later commit of this PR). The builder constructs a fresh object from
 * a fixed whitelist — it MUST NOT spread, clone, or copy-then-delete a
 * request, response, headers, or any other ambient object. The whitelist
 * IS the privacy contract.
 *
 * @schemaVersion 2
 *   The literal `corpusEntrySchemaVersion: 2` is stamped on every entry
 *   so consumers can branch on schema generation. Bump when fields are
 *   added or removed; never re-purpose an existing field within a
 *   version.
 *
 *   Version history:
 *     v1 → v2: added top-level `querySource` field to distinguish
 *              free-text queries from card-id-pinned queries
 *              ("free_text" vs "card_id"). Bumped pre-launch with
 *              zero production entries; no migration required.
 *
 * @ttl 180 days, enforced at the Cosmos container level via
 *   `defaultTtl: 15552000`. Application code does NOT stamp a TTL field
 *   on entries — container TTL handles purge automatically. This keeps
 *   the corpus schema free of operational concerns.
 *
 * @privacy
 *   CorpusEntry is anonymization-by-omission. The TypeScript shape IS
 *   the privacy contract. Fields not listed below cannot be written,
 *   because the builder constructs a fresh object from a whitelist and
 *   is unit-tested against the full forbidden-field list (see
 *   corpusEntry.test.ts — the load-bearing test for this PR).
 *
 *   Forbidden in CorpusEntry — must NEVER appear at any depth, in any
 *   key name, or in any string value extracted verbatim from a request:
 *
 *     - User identity:
 *         userId, userEmail, accountId, customerId, username,
 *         displayName, profileId, anyone's email address or handle
 *
 *     - Auth material:
 *         sessionId, sessionToken, refreshToken, accessToken,
 *         Authorization header value, Bearer token, apiKey, csrfToken,
 *         any cookie value, any auth-derived field
 *
 *     - Network / location:
 *         IP address (ip, remoteAddress, clientIp),
 *         X-Forwarded-For, X-Real-IP,
 *         geographic data (country, region, city, lat/long, timezone)
 *
 *     - Device:
 *         deviceId, installId, advertisingId, userAgent, deviceModel,
 *         OS version, browser fingerprint, push token
 *
 *     - Correlation IDs that could re-identify a session:
 *         requestId, operationId, traceId, spanId,
 *         App Insights correlation IDs, X-Correlation-ID
 *
 *     - Commercial / entitlement:
 *         subscription tier, plan name, entitlement flags,
 *         purchase receipts, StoreKit transaction IDs
 *
 *     - Third-party identifiers from upstream comp sources:
 *         eBay item IDs, listing URLs, seller IDs, seller names,
 *         thumbnail / image URLs from source listings,
 *         marketplace order numbers
 *
 *     - Free-text user content from request bodies other than `query`:
 *         user notes, custom labels, portfolio names, alert names
 *
 *   Any addition to this interface REQUIRES updating the allowed-keys
 *   list in corpusEntry.test.ts (single source of truth for what may
 *   appear at the top level). Reviewers of any future PR touching this
 *   file should treat the privacy test as the gate.
 */
export interface CorpusEntry {
  /**
   * Schema generation. Literal `2` for the current corpus shape. The
   * builder stamps this value; consumers branch on it for migrations.
   *
   * v1 → v2: added querySource field to distinguish free-text queries
   * from card IDs.
   */
  corpusEntrySchemaVersion: 2;

  /**
   * ISO 8601 capture timestamp. Sourced from the injected Clock —
   * never from `new Date().toISOString()` directly. Determinism rule:
   * production uses SystemClock; harness uses FrozenClock so a replayed
   * request produces a byte-identical entry.
   */
  capturedAt: string;

  /**
   * Raw user query that produced this response. Capped at 500
   * characters at construction time by the builder; longer values are
   * truncated with a `...[truncated]` suffix. Not considered PII —
   * this is free-text search input over a cards-only domain
   * (player names, set names, card attributes). Forbidden fields above
   * already exclude user-supplied free-text from any other field.
   *
   * Semantics depend on the sibling `querySource` field:
   *   - querySource === "free_text": this is the user's literal query
   *     string (e.g. "luka prizm rookie auto").
   *   - querySource === "card_id": this is a Cardsight `cardsightCardId`
   *     stored in the `query` slot because the pricing request was
   *     pinned by ID and carried no free-text query. (Pre-2026-05-30
   *     this was a Card Hedge cardHedgeCardId; the CF-CARDHEDGE-HARD-
   *     CUTOVER migration switched the pinned-id namespace to Cardsight
   *     UUIDs. CF-CH-P5/P6 reintroduced CardHedge as a comp vendor but
   *     the `query` slot still carries the Cardsight UUID — CH
   *     provenance is captured separately on response.chProvenance.)
   */
  query: string;

  /**
   * Discriminator describing how to interpret the `query` field.
   *
   *   - "free_text": query is the user's literal search string.
   *   - "card_id":   query is a Cardsight cardsightCardId (UUID); the
   *                  request was pinned to a specific catalog entry and
   *                  carried no free-text query. When CardHedge served
   *                  the comps for this row, vendor provenance is on
   *                  response.chProvenance — the `query` slot remains
   *                  the Cardsight UUID for stable cross-vendor joins.
   *
   * Added in schema v2 to disambiguate /price-by-id traffic, which can
   * arrive either with or without a free-text query. Without this
   * discriminator a downstream analyst cannot tell whether `query`
   * holds a search string or an opaque catalog ID.
   */
  querySource: "free_text" | "card_id";

  /**
   * The route that handled this request. One of:
   *   "/api/compiq/search" | "/api/compiq/price" | "/api/compiq/bulk"
   * Kept as a plain string (not a union literal) so future endpoints
   * can be added without a schema version bump.
   */
  endpoint: string;

  /**
   * Wall-clock milliseconds spent producing the response. Sourced from
   * the route handler's own timing (start ms captured at request entry,
   * subtracted from clock.now() at response time). Not derived from
   * Application Insights or any correlation source.
   */
  responseDurationMs: number;

  /**
   * Snapshot of the non-PII portion of the API response. The builder
   * constructs this nested object explicitly from named source fields —
   * top-level response fields NOT listed here are dropped. Adding a
   * field here requires the same privacy-test update as adding a
   * top-level field.
   *
   * @aspirationalFields
   *   Some fields below describe values the corpus is INTENDED to
   *   capture, which the pricing engine may not yet emit on the wire.
   *   When the engine does not emit a field, the builder writes `null`
   *   (and the version sibling, where applicable, writes `0`). This is
   *   a deliberate forcing-function pattern: the corpus schema declares
   *   what we want to collect for analysis, and any gap surfaces at the
   *   operator-rollout verification gate (see corpus rollout step 6:
   *   sampled-entry inspection must confirm aspirational fields are
   *   populated before ramping sample rate beyond 0.01).
   *
   *   Aspirational fields in this version:
   *     - marketState                  (engine classifier may not yet emit)
   *     - marketStateSchemaVersion     (paired version for marketState)
   */
  response: {
    /**
     * Live fair market value computed by the pricing engine. `null`
     * when the engine produced no usable comps (thin market).
     */
    fairMarketValueLive: number | null;

    /**
     * Confidence score in [0, 1] from the pricing engine, or `null`
     * if unavailable.
     */
    confidence: number | null;

    /**
     * Identity of the pricing implementation that produced the
     * response. Currently always `"monolith"`; future module-engine
     * cutover will introduce other values.
     */
    pricingEngine: string;

    /**
     * Build-time git SHA (short form) of the deployed engine code.
     * Sourced from the GIT_SHA env var via engineMeta. Lets the
     * corpus attribute training rows to specific engine generations.
     */
    engineVersion: string;

    /**
     * Raw market-state classifier output, stored VERBATIM. No
     * normalization, no derivation, no enum-to-label translation in the
     * builder — the engine emits a string, the corpus stores that string.
     *
     * Expected Phase 1 values (engine's MarketState enum):
     *   "liquid" | "stale" | "cold" | "volatile" | "trending"
     * but the field type is intentionally `string | null` so the corpus
     * can carry any classifier output the engine produces, today or
     * later, without a schema bump. Readers MUST consult the sibling
     * `marketStateSchemaVersion` to decode the value correctly.
     *
     * `null` is written when the engine does not surface a market state
     * for the request (aspirational-field case — see @aspirationalFields
     * on the parent response block).
     */
    marketState: string | null;

    /**
     * Generation of the engine's MarketState enum at the moment this
     * entry was written. The decoder ring for `marketState`: a reader
     * loading corpus rows must use the value of this field to interpret
     * the matching `marketState` string against the correct enum
     * vintage.
     *
     * Bump whenever the MarketState enum gains, removes, or renames a
     * value. Existing rows are never rewritten — they retain the
     * version stamp that was current when they were captured, which
     * keeps historical entries faithfully decodable against past
     * enum versions.
     *
     * Value `0` means the engine did not emit a market state for this
     * request and `marketState` is `null`. Value `>= 1` means a
     * classifier output was captured under that enum generation.
     */
    marketStateSchemaVersion: number;

    /**
     * Number of comps the engine considered when computing the
     * response. `null` when the engine path did not surface a count.
     */
    sampleSize: number | null;

    /**
     * CF-CH-P6-CORPUS (2026-06-25): CardHedge vendor provenance for this
     * row. PRESENT ONLY when the comps that produced the response came
     * from CardHedger (via the P3 router seam + P5 engine wire-in).
     * ABSENT (omitted from the serialized JSON, NOT set to null) when
     * Cardsight served the comps — this preserves byte-identical
     * emission for Cardsight-sourced rows pre/post-P6 (additive
     * invariant).
     *
     * Fields:
     *   - vendor:        literal "cardhedge"; presence of the parent
     *                    object IS the vendor signal but the field is
     *                    explicit so analysts don't have to special-case
     *                    presence checks.
     *   - chCardId:      CardHedger's per-parallel card_id (the bridged
     *                    identity from `/v1/cards/card-match`). Optional
     *                    in this version — the engine surfaces it only
     *                    when the router exposes it on the routed
     *                    result, future passes will fill this in.
     *   - trustReason:   which trust-guard signal accepted the data —
     *                    "prices_by_card_honest" (primary) or
     *                    "title_cohesion_strong" (defense-in-depth).
     *                    Optional in this version for the same reason
     *                    as chCardId.
     *
     * Privacy: CardHedger card_id is an opaque vendor catalog ID, NOT
     * user-identifying data — analogous to engineVersion. The
     * trustReason enum carries no user content.
     */
    chProvenance?: {
      vendor: "cardhedge";
      chCardId?: string;
      trustReason?: "prices_by_card_honest" | "title_cohesion_strong";
      /**
       * CF-CH-THIN-COMP-PRIMARY (2026-06-26): how many CardHedge sales
       * the trust-guard accepted. Surfaced so analysts can stratify CH-
       * served rows by depth (n=1 thin "cardhedge-last-sale" vs n>=2
       * "cardhedge" with FMV). Optional — older rows omit it.
       */
      compCount?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Construction surface
// ---------------------------------------------------------------------------

/**
 * Minimal clock interface the builder needs. Local to this module by
 * design — production code (models/) must not depend on test
 * infrastructure (harness/). Any clock implementation that exposes
 * `iso(): string` satisfies it: the harness `Clock` (which has both
 * `now()` and `iso()`), an ad-hoc test fake, or a SystemClock shim.
 */
export interface IsoClock {
  iso(): string;
}

/**
 * Input contract for {@link buildCorpusEntry}. This type IS the public
 * call-site shape — exported alongside {@link CorpusEntry} so callers
 * (routes, the writer in services/corpus/) can declare typed
 * variables without reaching into the builder's implementation file.
 *
 * The builder reads ONLY the fields listed here. Any other property on
 * the options object (forbidden fields accidentally spread from a `req`
 * or `req.headers`) is ignored by construction — there is no
 * spread/clone/copy step anywhere in the builder.
 */
export interface BuildCorpusEntryOptions {
  /** Raw user query string; will be truncated at 500 chars if longer. */
  query: string;

  /**
   * Discriminator for the `query` field. "free_text" when query is the
   * user's literal search string; "card_id" when query holds a
   * Cardsight cardsightCardId because the request was pinned by ID.
   */
  querySource: "free_text" | "card_id";

  /** Route path that produced the response, e.g. "/api/compiq/search". */
  endpoint: string;

  /** Wall-clock milliseconds the route handler spent producing the response. */
  durationMs: number;

  /** Injected clock for `capturedAt`. Decouples production from `new Date()`. */
  clock: IsoClock;

  /**
   * Non-PII portion of the API response, structurally typed.
   * Whitelisted fields are read individually; anything else on this
   * object is ignored.
   */
  response: {
    fairMarketValueLive: number | null;
    confidence: number | null;
    pricingEngine: string;
    engineVersion: string;
    marketState: string | null;
    marketStateSchemaVersion: number;
    sampleSize: number | null;
    /**
     * CF-CH-P6-CORPUS: when present, builder copies through verbatim;
     * when undefined the field is omitted from the emitted entry
     * (preserves CS-row byte-identicality). See CorpusEntry.response
     * .chProvenance for full semantics.
     */
    chProvenance?: {
      vendor: "cardhedge";
      chCardId?: string;
      trustReason?: "prices_by_card_honest" | "title_cohesion_strong";
      /** CF-CH-THIN-COMP-PRIMARY (2026-06-26): see CorpusEntry.response.chProvenance.compCount. */
      compCount?: number;
    };
  };
}

/** Maximum length of the persisted `query` field. */
const MAX_QUERY_LEN = 500;

/** Suffix appended to a truncated query so analysts can see the cut. */
const TRUNCATION_SUFFIX = "...[truncated]";

/**
 * Truncate a query string to at most {@link MAX_QUERY_LEN} characters,
 * with a `...[truncated]` suffix indicating the cut. Pure function;
 * exported for reuse only if needed (currently unexported).
 */
function truncateQuery(q: string): string {
  if (q.length <= MAX_QUERY_LEN) return q;
  const head = q.slice(0, MAX_QUERY_LEN - TRUNCATION_SUFFIX.length);
  return head + TRUNCATION_SUFFIX;
}

/**
 * Build a {@link CorpusEntry} from a sampled pricing request/response.
 *
 * Privacy guarantee: this builder constructs a fresh object literal
 * from a fixed whitelist. There is no `{...opts}`, no `Object.assign`,
 * no `JSON.parse(JSON.stringify(opts))` — every field on the output
 * is read by an explicit named access from `opts`. Forbidden fields
 * cannot leak even if a caller passes them in.
 *
 * Determinism: with a frozen clock and identical inputs, two calls
 * produce byte-identical entries.
 *
 * @param opts Construction inputs; see {@link BuildCorpusEntryOptions}.
 * @returns A new {@link CorpusEntry}. Never throws on valid inputs.
 */
export function buildCorpusEntry(
  opts: BuildCorpusEntryOptions,
): CorpusEntry {
  // CF-CH-P6-CORPUS: chProvenance is whitelisted from a fresh literal —
  // the same anti-spread discipline applied to the rest of the builder.
  // Constructed conditionally so a CS row (chProvenance undefined on
  // input) produces an output WITHOUT the key at all; this preserves
  // byte-identical Cardsight-row emission pre/post P6 (additive
  // invariant; see corpusEntry.test.ts privacy contract).
  const ch = opts.response.chProvenance;
  const chPart =
    ch && ch.vendor === "cardhedge"
      ? {
          chProvenance: {
            vendor: "cardhedge" as const,
            ...(typeof ch.chCardId === "string" && ch.chCardId
              ? { chCardId: ch.chCardId }
              : {}),
            ...(ch.trustReason === "prices_by_card_honest" ||
            ch.trustReason === "title_cohesion_strong"
              ? { trustReason: ch.trustReason }
              : {}),
            // CF-CH-THIN-COMP-PRIMARY (2026-06-26): compCount whitelisted
            // when the engine surfaces a positive finite integer. Older
            // rows (engine pre-2026-06-26) emit no compCount and the
            // field is omitted entirely — additive against the existing
            // chProvenance byte shape.
            ...(typeof ch.compCount === "number" &&
            Number.isFinite(ch.compCount) &&
            ch.compCount > 0
              ? { compCount: Math.floor(ch.compCount) }
              : {}),
          },
        }
      : {};

  return {
    corpusEntrySchemaVersion: 2,
    capturedAt: opts.clock.iso(),
    query: truncateQuery(opts.query),
    querySource: opts.querySource,
    endpoint: opts.endpoint,
    responseDurationMs: opts.durationMs,
    response: {
      fairMarketValueLive: opts.response.fairMarketValueLive,
      confidence: opts.response.confidence,
      pricingEngine: opts.response.pricingEngine,
      engineVersion: opts.response.engineVersion,
      marketState: opts.response.marketState,
      marketStateSchemaVersion: opts.response.marketStateSchemaVersion,
      sampleSize: opts.response.sampleSize,
      ...chPart,
    },
  };
}
