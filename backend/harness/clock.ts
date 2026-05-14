/**
 * Clock — the only sanctioned source of "now" inside the pricing engine.
 *
 * Determinism rule: stages/, pipeline/, and models/ must read time
 * through this interface. Direct Date.now() / new Date() in those dirs
 * will fail the pre-commit lint (wired in Step 2).
 */
export interface Clock {
  /** Milliseconds since epoch. Use this everywhere instead of Date.now(). */
  now(): number;
  /** ISO 8601 string. Use this for snapshots, never new Date().toISOString(). */
  iso(): string;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  iso(): string {
    return new Date().toISOString();
  }
}

export class FrozenClock implements Clock {
  private readonly fixedMs: number;
  constructor(isoOrMs: string | number) {
    this.fixedMs =
      typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
    if (!Number.isFinite(this.fixedMs)) {
      throw new Error(`FrozenClock: invalid time ${isoOrMs}`);
    }
  }
  now(): number {
    return this.fixedMs;
  }
  iso(): string {
    return new Date(this.fixedMs).toISOString();
  }
}

/**
 * Canonical baseline clock for harness runs. Every Tier 1 / Tier 2 case
 * is evaluated at this moment unless the case overrides it. Bumping
 * this value invalidates all snapshots and requires an ADR.
 */
export const HARNESS_BASELINE_ISO = "2026-05-14T12:00:00.000Z";

export function harnessClock(overrideIso?: string): FrozenClock {
  return new FrozenClock(overrideIso ?? HARNESS_BASELINE_ISO);
}
