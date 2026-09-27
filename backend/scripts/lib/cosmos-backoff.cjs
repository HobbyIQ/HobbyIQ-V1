"use strict";
/**
 * cosmos-backoff.cjs -- one shared, bounded, application-level backoff for a
 * Cosmos 429 ("request rate is too large"), so a lane's own read/write loop
 * never has to retype the retry math scattered across two dozen scripts
 * (anomaly-force-scan.cjs, audit-orphan-causes.cjs, audit-catalog-duplicates.cjs,
 * apply-cpa-product-rule.cjs, ... — grepped 2026-09-27, none of them shared).
 *
 * ── THE INCIDENT THIS FIXES (run 36297136135, repoint-sales-isauto-flip.cjs,
 * baseball:2026 APPLY, 2026-09-27 05:26Z-06:04Z). A 429 inside a per-candidate
 * `catalogRowAt()` (a bare `cat.item(id, id).read()`, no retry at all) escaped
 * whatever window the @azure/cosmos SDK's OWN retry policy gave it and threw
 * all the way out of the run after 3,244 verified moves had already landed.
 * The SDK's default `retryOptions.maxRetryAttemptsOnThrottledRequests` is 9
 * with its own internal backoff, but under SUSTAINED throttling (this lane
 * scanning ~1M rows per cell while a 32-slot census fleet was still draining
 * RUs on the SAME account) that window is not bounded by anything the LANE
 * controls, and once it is exhausted the SDK throws a plain error the caller
 * must handle -- this lane did not, so the whole process died. `withBackoff`
 * is the bounded, logged, application-level layer ON TOP of the SDK's own
 * retry, not a replacement for it: it exists for exactly the case where the
 * SDK's retry has already given up.
 *
 * ── WHAT IT WRAPS. Any Cosmos call: a point `.read()`, an `.upsert()`, a
 * `.delete()`, a query's `.fetchNext()`. It does NOT change what the call
 * does or what it returns -- `withBackoff(fn)` resolves/rejects exactly as
 * `fn()` would, except a 429 is retried in place first.
 *
 * ── WHAT COUNTS AS RETRYABLE. A Cosmos 429 (`err.code === 429` or
 * `err.statusCode === 429`, plus the message shape the SDK throws when a
 * numeric code was not attached: "request rate is too large" per
 * cosmos-netstandard-sdk/3.18.0, the exact string from this incident's log).
 * Nothing else -- a 404, 412, or any non-throttling error passes straight
 * through on the FIRST attempt, unretried, exactly as every existing
 * `retry = (fn) => fn()` passthrough already behaves for those codes.
 *
 * ── BACKOFF SHAPE. Exponential with jitter: `min(maxMs, baseMs * 2^attempt)`,
 * jittered to `[0.5x, 1.0x)` of that value so a burst of callers hitting the
 * SAME 429 window do not all retry in lockstep and re-create the burst they
 * are backing off from. When the thrown error carries a Cosmos-supplied
 * `retryAfterInMs` (or the SDK's `headers["x-ms-retry-after-ms"]`), that value
 * is honoured INSTEAD of the computed backoff for that attempt -- the server
 * is telling the client exactly how long to wait, and guessing shorter than
 * that reproduces the throttling rather than escaping it.
 *
 * ── LOGGING. One line per retry, `[backoff] <label> 429 attempt k/N wait Xms`,
 * to stdout via the caller-visible `console.log` (the same data channel every
 * budgeted lane already narrates progress on) -- never silent, so a run that
 * is spending its whole budget backing off is legible in the log rather than
 * looking like it hung.
 *
 * ── EXHAUSTION. After `maxAttempts` retries all still see a 429, the ORIGINAL
 * error is rethrown, with `.message` prefixed by the label
 * (`[backoff] <label> exhausted after N attempts: <original message>`) so a
 * caller's own `catch` (and the operator reading the log) can tell which call
 * site gave up without re-deriving it from a bare Cosmos error. The original
 * error object's own fields (`code`, `statusCode`, `retryAfterInMs`, ...) are
 * preserved on the SAME object (mutated in place, not wrapped), so an existing
 * `e?.code === 429` check downstream keeps working unchanged.
 *
 * ── SEMANTICS. `withBackoff` changes ONLY how long a caller waits before a
 * Cosmos call is retried. It never changes what the call itself does: a
 * caller doing `create -> read-back -> delete` (relocateSoldComp) is still
 * doing exactly that after wrapping each step -- if the DELETE's retries
 * exhaust after a successful create+verify, the row is left resident at BOTH
 * addresses, exactly as `duplicatesLeft` already reports today; a move is
 * still never counted as lost.
 */

const RETRYABLE_MESSAGE_RE = /request rate is too large/i;

/** Does this error look like a Cosmos 429? Mirrors the shapes already
 *  checked across anomaly-force-scan.cjs / audit-orphan-causes.cjs / etc. */
function isThrottled(err) {
  if (!err) return false;
  const code = err.code ?? err.statusCode;
  if (code === 429 || code === "429" || Number(code) === 429) return true;
  if (typeof err.retryAfterInMs === "number") return true;
  if (err.headers && err.headers["x-ms-retry-after-ms"] != null) return true;
  return RETRYABLE_MESSAGE_RE.test(String(err?.message ?? ""));
}

/** The explicit wait a 429 carries, if any -- honoured INSTEAD of the
 *  computed backoff for that attempt. Cosmos surfaces this both as a typed
 *  `retryAfterInMs` field and, on some SDK paths, only as the raw
 *  `x-ms-retry-after-ms` response header. */
function retryAfterMsOf(err) {
  if (typeof err?.retryAfterInMs === "number" && err.retryAfterInMs >= 0) return err.retryAfterInMs;
  const header = err?.headers?.["x-ms-retry-after-ms"];
  if (header != null) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/** Exponential backoff with jitter: [0.5x, 1.0x) of min(maxMs, base*2^attempt). */
function computeBackoffMs(attempt, baseMs, maxMs) {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitterFloor = capped / 2;
  return Math.round(jitterFloor + Math.random() * jitterFloor);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn()`, retrying in place on a Cosmos 429 with bounded exponential
 * backoff + jitter, honouring the server's own `retryAfterInMs` when present.
 *
 * @param {() => Promise<any>} fn        the Cosmos call to run
 * @param {object} [opts]
 * @param {string} [opts.label]          identifies the call site in the retry
 *                                        log line and the exhausted-error message
 * @param {number} [opts.maxAttempts=8]  retries after the first attempt before
 *                                        giving up and rethrowing
 * @param {number} [opts.baseMs=500]     backoff base for the exponential curve
 * @param {number} [opts.maxMs=30000]    backoff ceiling per attempt
 * @param {(ms:number) => Promise<void>} [opts.wait]  injectable sleep, for tests
 * @param {(...args:any[]) => void} [opts.log]         injectable logger, for tests
 * @param {() => void} [opts.onThrottle]  called once per 429 seen (BEFORE the
 *                                        wait), so a caller can track a
 *                                        throttle-rate window without parsing
 *                                        the log lines this prints
 */
async function withBackoff(fn, opts = {}) {
  const {
    label = "cosmos",
    maxAttempts = 8,
    baseMs = 500,
    maxMs = 30000,
    wait = sleep,
    log = console.log,
    onThrottle,
  } = opts;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isThrottled(err) || attempt >= maxAttempts) {
        if (isThrottled(err) && attempt >= maxAttempts) {
          err.message = `[backoff] ${label} exhausted after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${err.message}`;
        }
        throw err;
      }
      if (typeof onThrottle === "function") { try { onThrottle(); } catch { /* never let a counter throw the retry */ } }
      const serverWait = retryAfterMsOf(err);
      const waitMs = serverWait != null ? serverWait : computeBackoffMs(attempt, baseMs, maxMs);
      log(`[backoff] ${label} 429 attempt ${attempt + 1}/${maxAttempts} wait ${waitMs}ms`);
      await wait(waitMs);
    }
  }
}

/** Bind a `retry`-shaped function (the `(fn) => fn()` passthrough convention
 *  used throughout scripts/lib) with a fixed label + options, for a caller
 *  that wants to hand the SAME configured retrier to several helpers
 *  (relocateSoldComp, drainQuery, ...) without repeating the options object. */
function makeRetrier(opts = {}) {
  return (fn) => withBackoff(fn, opts);
}

module.exports = { withBackoff, makeRetrier, isThrottled, retryAfterMsOf, computeBackoffMs };
