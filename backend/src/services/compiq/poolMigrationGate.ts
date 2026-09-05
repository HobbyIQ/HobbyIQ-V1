/**
 * CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL (Drew, 2026-09-04).
 *
 * THE DEFECT. A newly minted identity is repriceable before its pool re-key
 * finishes, and the engine cannot tell the difference between "this tier has
 * no sales" and "this tier's sales have not arrived yet". Measured in the
 * 2026-09-04 audit of Drew's holdings:
 *
 *   The 1987 Topps Traded Tiffany Maddux row was minted at 14:37Z. The GREAT
 *   REMATCH began moving that identity's 350 sales onto it. At 18:56Z — four
 *   hours in, with 17 of 350 sales migrated — a reprice ran. It found the
 *   PSA 10 tier EMPTY, concluded there was no PSA 10 market, and priced the
 *   card off the PSA 8 / PSA 9 rows that HAD arrived, through the grade
 *   curve. It published $240 for a card worth ~$1,500.
 *
 * Every step of that was correct given what the engine could see, which is
 * precisely the problem: an empty tier is EVIDENCE OF ABSENCE only when the
 * pool is settled. Mid-migration it is evidence of nothing at all, and a
 * grade-curve estimate built on a partial pool is not a thin answer — it is a
 * confident wrong answer, published as a number with a rung beside it.
 *
 * THE RULE. When an identity's pool may still be migrating, the rungs that
 * read the SHAPE of the pool — the exact rung and the graded-to-raw curve —
 * must not price it. The reprice publishes `withheld` with reason
 * `pool-migrating`, the PRIOR value retained and labelled, and NEVER a
 * fallback number: a fallback is exactly what produced the $240. The refusal
 * stands until the rematch marks the identity settled.
 *
 * WHY NOT SIMPLY WAIT FOR AN EMPTY TIER TO FILL. Because the failure is
 * silent and the number is plausible. $240 for a Maddux Tiffany looks like a
 * price; nothing about it announces that 333 sales were still in flight.
 *
 * ── THE SETTLE SIGNAL ──────────────────────────────────────────────────────
 *
 * The GREAT REMATCH's write ledger (#1727) is a JSON file on the runner's
 * local disk (`WRITE_LEDGER_OUT`, default /tmp/rematch-write-ledger.json),
 * read by the canary gate in the SAME job and uploaded as an artifact. It is
 * the right RECORD and the wrong MEDIUM: the engine runs in App Service and
 * can never read a runner's /tmp. So the settle signal is a durable marker
 * the rematch writes ALONGSIDE the ledger, in Cosmos, keyed the way the gate
 * needs to ask.
 *
 * TWO KEYS, because the rematch and the question have different shapes. The
 * shard axis is `(cardYear, sportClass, hashPart)` — `setKey` is NOT a shard
 * dimension, so a slice cannot claim "every row of this setKey is done" — but
 * a slice CAN name the pools it touched, which is what `ledgerNote` already
 * accumulates per slug. So:
 *
 *   identity marker   `rematch_control` doc, id `identity::<slug>` — written
 *                     when a slice that TOUCHED that pool completes. This is
 *                     the precise signal, and the ledger already holds the
 *                     data: `pools[slug]` is exactly the set to write.
 *   scope marker      id `scope::<year>::<setKey>` — written when every slice
 *                     covering that (year, setKey) has completed, for the
 *                     bulk case where a whole product was re-keyed at once.
 *
 * A marker says `settledAt`. Its ABSENCE is not "settled"; see the failure
 * direction below.
 *
 * ── FAILURE DIRECTION: THE AGE WINDOW FAILS CLOSED, THE MARKER FAILS OPEN ──
 *
 * There are two precedents in this repo and they point opposite ways.
 * `resolveValuationIdentity` fails OPEN (an unaskable catalog prices the id as
 * given). `rematch-canary-check.cjs:389` fails CLOSED (an absent ledger means
 * every canary is treated as touched, strict rules apply).
 *
 * This gate follows the canary, but only inside a bounded window, because the
 * two are answering different questions:
 *
 *   - A row minted MORE than `POOL_SETTLE_HOURS` ago is settled by default.
 *     Migration is hours, not days; without this bound an absent marker would
 *     withhold every price on every un-migrated identity in the catalog
 *     forever, which is a far worse outage than the one being fixed.
 *   - A row minted WITHIN that window is treated as MIGRATING unless a marker
 *     says otherwise. Inside the window, absence of evidence is not evidence
 *     of settlement — that is the exact inference that published $240.
 *
 * So a marker can only ever RELEASE a price early, never withhold one. That
 * asymmetry is deliberate: the marker is an optimization, and a gate whose
 * safety depends on a marker being present is a gate that fails the day the
 * rematch crashes before writing one.
 *
 * ── WHAT IS GATED, AND WHAT IS NOT ─────────────────────────────────────────
 *
 * Gated: the EXACT rung and the graded-to-raw curve — the rungs whose answer
 * is a function of which sales are present. `shouldGateRung` names them.
 *
 * NOT gated: a rung that reads OTHER identities entirely (a player index, a
 * family baseline). Those do not read this pool, so a partial migration does
 * not corrupt them.
 *
 * ── CF-A-GATE-THAT-FIRES-ABOVE-EVERY-RUNG-IS-NOT-A-RUNG-GATE (#1811) ───────
 *
 * `shouldGateRung` shipped in #1776 documented, exported and TESTED — and
 * never called. The gate fired unconditionally ABOVE the whole ladder, so a
 * freshly minted identity withheld even when the only rung that could answer
 * was one that never reads its pool at all: a family baseline over sibling
 * cards, a cross-setkey read of the same card in another product, a player
 * index over forty OTHER cards. Those answers are evidence a rematch on THIS
 * identity's pool cannot possibly have disturbed, and withholding them is not
 * caution — it is blanking a good price for a reason that does not apply to
 * it. The Maddux defect was a HALF-ARRIVED POOL being read as a whole one;
 * a rung that reads no part of that pool cannot commit it.
 *
 * So the withhold now follows the rung that actually answered:
 *
 *   own-pool rung      withhold. `fairMarketValue` null, reason
 *                      `pool-migrating`, prior retained and labelled. No
 *                      fallback is substituted — a substitute is exactly what
 *                      produced the $240.
 *   other-identity rung publish, LABELLED `pool-migrating`. The number is
 *                      admissible; the reader is still told this identity's
 *                      pool was mid-migration when it was priced, because a
 *                      better number may follow within hours.
 *
 * The doctrine that a migrating identity publishes no number from its OWN
 * pool is unchanged. What changed is that "its own pool" is now measured
 * against the rung that answered, not asserted over all of them.
 *
 * THE CLASSIFICATION, and why each rung lands where it does:
 *
 *   OWN-POOL (gated)
 *     exact-pool-*              reads the requested tier's own sales. The
 *                               migrating half IS the answer.
 *     grade-curve-estimate      this identity's OTHER tiers × a ratio. Which
 *                               tiers are observed is the input, and
 *                               mid-migration that shape is a partial view.
 *     graded-pool-inverse       this identity's own graded children ÷ the
 *                               multiplier. The $240 rung, literally.
 *     cross-grade-fallback      this identity's largest OTHER tier, rescaled.
 *                               Same pool, different tier.
 *     player-index-projection   NOT an other-identity rung, despite reading
 *                               other cards for the RATIO. It is reached only
 *                               inside the `tier.valueSource === "observed"`
 *                               branch, and its ANCHOR is `lastRealComp` —
 *                               this identity's own newest sale at this tier.
 *                               A half-migrated pool changes which sale is
 *                               newest, so it changes the anchor, so the rung
 *                               is a function of what has arrived. #1776's
 *                               classifier called it not-gated; that was
 *                               harmless only while the gate fired above
 *                               every rung and nothing consulted the answer.
 *
 *   OTHER-IDENTITIES (labelled, not withheld)
 *     Every rung the gated ladder (`computeHobbyIqFmv`, `skipExactPool: true`)
 *     can return, reached ONLY at section 3 — after this identity's pool has
 *     been found empty at EVERY grade, which is why it reads no part of it:
 *       sibling-estimate, sibling-parallel, cross-parallel, neighbor-parallel,
 *       same-printrun-cross-parallel, cross-setkey, cross-printrun,
 *       printrun-discovery, family-baseline, product-tier, composite-neighbor,
 *       rare-card-anchor, hot-raw-same-card-anchor, grade-cross-raw,
 *       tiered-momentum-card, tiered-momentum-player.
 *     `no-basis` is not a rung that priced anything, so it is not gated
 *     either — there is no number to withhold.
 *
 * This module decides ADMISSIBILITY per rung; it never picks a replacement,
 * and it never promotes a rung the ladder did not itself reach.
 */
import { CosmosClient, type Container } from "@azure/cosmos";

/**
 * How long after a catalog row is minted its pool is presumed to be still
 * migrating, absent a marker saying otherwise.
 *
 * Six hours: the observed Maddux window was 4h19m from mint (14:37Z) to the
 * bad reprice (18:56Z) with the migration still running, and a full 32-slot
 * rematch pass over a large product runs longer than that. Six hours covers
 * the observed case with margin while keeping the window far short of the
 * daily 5AM ET refresh, so no identity is gated across two cycles.
 */
export const POOL_SETTLE_HOURS = 6;

/** The Cosmos container holding the rematch's settle markers. */
export const REMATCH_CONTROL_CONTAINER = "rematch_control";

/** The marker the rematch writes when a slice that touched an identity ends. */
export interface RematchSettleMarker {
  /** `identity::<slug>` or `scope::<year>::<setKey>`. */
  id: string;
  kind: "identity" | "scope";
  /** The identity or scope this marker settles. */
  key: string;
  /** ISO instant the covering slice(s) completed. Presence == settled. */
  settledAt: string;
  /** The run that wrote it, for attribution back to the ledger artifact. */
  runId: string | null;
  /** Rows the covering slice(s) re-keyed into this pool. */
  rowsWritten: number;
}

/** The marker id for one identity's settle state. */
export function identityMarkerId(slug: string): string {
  return `identity::${String(slug ?? "").trim()}`;
}

/** The marker id for a (year, setKey) scope's settle state. */
export function scopeMarkerId(year: number | null, setKey: string | null): string {
  return `scope::${year ?? "?"}::${String(setKey ?? "?").trim()}`;
}

/**
 * The label code a PUBLISHED price carries when this identity's pool was
 * still migrating but the rung that answered reads other identities.
 *
 * It is a caveat, not a refusal: the number is admissible, and the reader is
 * told that a better one — from this card's own sales — may follow within
 * hours. Named as a constant, following `INDEPENDENCE_UNVERIFIED_CODE`, so
 * the label union has one source of truth.
 */
export const POOL_MIGRATING_LABEL_CODE = "pool-migrating" as const;

/**
 * Does this rung read the MIGRATING identity's own pool?
 *
 * True → the rung's answer is a function of which of this identity's sales
 * have arrived, so a migrating pool must not price it: the caller withholds.
 * False → the rung reads OTHER identities entirely, so a partial migration of
 * this pool cannot have disturbed it: the caller publishes and LABELS.
 *
 * The classification is enumerated in this module's header. Note that
 * `player-index-projection` is OWN-POOL despite reading other cards for its
 * ratio — its anchor is this identity's own newest sale at this tier, and a
 * half-migrated pool changes which sale that is.
 *
 * Unknown and absent labels are NOT gated, matching `isExactPoolRung`: a rung
 * this vocabulary does not name is a rung reached through the gated ladder,
 * which runs only after this identity's pool was found empty at every grade.
 * `no-basis` names no price, so there is nothing to withhold.
 */
export function shouldGateRung(rungLabel: string | null | undefined): boolean {
  const r = String(rungLabel ?? "");
  if (!r) return false;
  return r.startsWith("exact-pool-")
    || r === "grade-curve-estimate"
    || r === "graded-pool-inverse"
    || r === "cross-grade-fallback"
    // Anchored on THIS identity's newest sale at THIS tier. See the header.
    || r === "player-index-projection";
}

export interface PoolMigrationInput {
  /** The catalog row's immutable mint instant, or null when unknown. */
  observedAt: string | null;
  /** A settle marker for this identity or its scope, when one was read. */
  marker: { settledAt: string | null } | null;
  /** Evaluation instant; defaults to now. */
  nowMs?: number;
  /** Override for the window, in hours. */
  settleHours?: number;
}

export interface PoolMigrationVerdict {
  /** True when the pool may still be migrating and shape-reading rungs must
   *  not price it. */
  migrating: boolean;
  /** Why, in one machine-readable token. */
  because:
    | "settled-marker"        // the rematch said this identity is done
    | "outside-settle-window" // minted long enough ago to be settled by default
    | "no-mint-timestamp"     // the row carries no observedAt: presumed old
    | "within-settle-window"; // minted recently, no marker: MIGRATING
  /** Hours since mint, when it could be computed. */
  ageHours: number | null;
}

/**
 * Is this identity's pool still migrating?
 *
 * Order matters and is the whole doctrine:
 *   1. An explicit settle marker RELEASES, whatever the age.
 *   2. No mint timestamp means the row predates the field — presumed settled,
 *      because the alternative is gating the entire historical catalog.
 *   3. Outside the window: settled.
 *   4. Inside the window with no marker: MIGRATING. Absence of evidence is
 *      not evidence of settlement.
 */
export function assessPoolMigration(input: PoolMigrationInput): PoolMigrationVerdict {
  if (input.marker?.settledAt) {
    return { migrating: false, because: "settled-marker", ageHours: ageHoursOf(input) };
  }
  const ageHours = ageHoursOf(input);
  if (ageHours === null) {
    return { migrating: false, because: "no-mint-timestamp", ageHours: null };
  }
  const windowHours = input.settleHours ?? POOL_SETTLE_HOURS;
  return ageHours >= windowHours
    ? { migrating: false, because: "outside-settle-window", ageHours }
    : { migrating: true, because: "within-settle-window", ageHours };
}

/**
 * Read the settle marker for an identity, falling back to its (year, setKey)
 * scope marker.
 *
 * Returns null when Cosmos is not configured, when the container does not
 * exist yet (the rematch has not written its first marker), or on any read
 * error. Null means "no marker", which inside the settle window means
 * MIGRATING — the fail-closed direction. That is deliberate: this read must
 * never be the reason a bad price gets published, so every failure mode
 * lands on the safe side, and the only thing a marker can do is release a
 * price EARLY.
 *
 * A point read on the identity marker is 1 RU; the scope read runs only when
 * the identity has no marker of its own. Both are skipped entirely for rows
 * outside the settle window, because `assessPoolMigration` short-circuits on
 * the marker before the age check only when one was supplied — callers pass
 * the marker lazily via this function, which the gate calls once per
 * valuation of a freshly minted identity and never for the settled majority.
 */
export async function readSettleMarker(
  slug: string | null,
  year: number | null,
  setKey: string | null,
): Promise<{ settledAt: string | null } | null> {
  const id = String(slug ?? "").trim();
  if (!id) return null;
  const container = getControlContainer();
  if (!container) return null;
  const read = async (docId: string): Promise<{ settledAt: string | null } | null> => {
    try {
      const { resource } = await container.item(docId, docId).read<RematchSettleMarker>();
      const settledAt = typeof resource?.settledAt === "string" && resource.settledAt.trim()
        ? resource.settledAt
        : null;
      return settledAt ? { settledAt } : null;
    } catch { return null; }
  };
  return (await read(identityMarkerId(id))) ?? (await read(scopeMarkerId(year, setKey)));
}

let _controlContainer: Container | null = null;
function getControlContainer(): Container | null {
  if (_controlContainer) return _controlContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _controlContainer = new CosmosClient(conn)
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_REMATCH_CONTROL_CONTAINER ?? REMATCH_CONTROL_CONTAINER);
    return _controlContainer;
  } catch { return null; }
}

function ageHoursOf(input: PoolMigrationInput): number | null {
  const t = Date.parse(String(input.observedAt ?? ""));
  if (!Number.isFinite(t)) return null;
  const now = input.nowMs ?? Date.now();
  // A mint instant in the FUTURE is clock skew, not a fresh row. Treat it as
  // age zero — the conservative read, since a future timestamp is exactly the
  // shape a just-minted row takes when two machines disagree by a second.
  return Math.max(0, (now - t) / 3_600_000);
}
