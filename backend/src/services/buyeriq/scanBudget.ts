// CF-BUYERIQ-SCAN-BUDGET (Drew, 2026-09-02). A vendor-call budget for
// the deal scan.
//
// WHY: every card the scanner prices against live asks costs one eBay
// Browse call on a MISS. The Browse free tier is 5000 calls/day
// (ebayListingSearch.service, ebayActiveListingsCache.service), and the
// scanner is not the only consumer — the daily listings snapshot job
// (dailyListingsSnapshotJob: top-500 players), Card Detail's active
// listings, and listing-range all draw on the same pool. So the scan
// takes a SLICE, not the whole tier.
//
// THE PINNED BEHAVIOUR: when the budget is exhausted the scan STOPS and
// says so. It does not:
//   - silently return a short feed as though it were complete,
//   - fall back to stale-at-any-age cache and present it as live,
//   - or keep calling the vendor past the cap.
// A truncated scan is reported as truncated, with the reason and the
// count of cards never examined. A caller that cannot tell a complete
// scan from an aborted one will eventually make a buying decision on a
// feed that silently omitted the best deal.
//
// Cache reads are FREE and are not charged to the budget — that is the
// entire point of the 12h ebay_active_listings_cache. Only a live
// Browse fetch spends.
//
// Env:
//   BUYERIQ_SCAN_VENDOR_CALL_BUDGET   max live Browse calls per scan (default 400)

/** Default slice of the 5000/day eBay Browse tier this scan may spend.
 *  400 leaves the daily snapshot job (top-500 players) and interactive
 *  Card Detail / listing-range traffic their own headroom. */
export const DEFAULT_VENDOR_CALL_BUDGET = 400;

/** Hard ceiling regardless of env — a misconfigured env var must not be
 *  able to hand the whole daily tier to one scan. */
export const MAX_VENDOR_CALL_BUDGET = 2000;

export type BudgetStopReason = "vendor-call-budget-exhausted";

export interface ScanBudgetState {
  /** Live vendor calls this scan may still spend. */
  remaining: number;
  /** Live vendor calls spent so far. */
  spent: number;
  /** Cache hits served — free, never charged. */
  cacheHits: number;
  /** The budget this scan started with. */
  limit: number;
}

/**
 * A single-scan vendor-call budget. Not shared across scans and not
 * persisted: it bounds ONE run. The daily tier is protected by the
 * combination of this per-run cap and the 12h cache.
 */
export class ScanBudget {
  private readonly limit: number;
  private spent = 0;
  private cacheHits = 0;
  private exhausted = false;

  constructor(limit: number = readBudgetFromEnv()) {
    this.limit = Math.max(0, Math.min(MAX_VENDOR_CALL_BUDGET, Math.floor(limit)));
  }

  /** True when a live vendor call may still be made. */
  canSpend(): boolean {
    return this.spent < this.limit;
  }

  /** Charge one live vendor call. Returns false (and charges nothing)
   *  when the budget is already exhausted — callers MUST check the
   *  return and stop, not proceed. */
  spend(): boolean {
    if (!this.canSpend()) {
      this.exhausted = true;
      return false;
    }
    this.spent += 1;
    return true;
  }

  /** Record a free cache hit. Never charged against the budget. */
  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  /** True once a spend() was refused — the scan must report truncation. */
  isExhausted(): boolean {
    return this.exhausted;
  }

  state(): ScanBudgetState {
    return {
      remaining: Math.max(0, this.limit - this.spent),
      spent: this.spent,
      cacheHits: this.cacheHits,
      limit: this.limit,
    };
  }
}

export function readBudgetFromEnv(): number {
  const raw = process.env.BUYERIQ_SCAN_VENDOR_CALL_BUDGET;
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_VENDOR_CALL_BUDGET;
  return Math.min(MAX_VENDOR_CALL_BUDGET, Math.floor(n));
}
