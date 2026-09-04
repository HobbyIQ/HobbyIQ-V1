/**
 * runner-shard-scope.cjs -- an inherited `slots` is not a chosen shard.
 *
 * CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, 2026-09-04; generalised
 * runner-wide 2026-09-04).
 *
 * THE OUTAGE. .github/workflows/backfill-runner.yml exports `slot` and `slots`
 * to EVERY whitelisted script, and BOTH carry a workflow-wide default --
 * `slot: "0"`, `slots: "16"`. So the near-universal binding
 *
 *   const SLOT  = Number(process.env.SLOT  ?? 0);
 *   const SLOTS = Number(process.env.SLOTS ?? 1);   // <- never sees undefined
 *
 * NEVER bound 1. Every dispatch of every such script sharded itself sixteen
 * ways and swept slot 0 only, while fifteen sixteenths of the population sat
 * untouched. The run stayed green, the banner printed `slot 0/16` as though it
 * were configuration, and the reconciliation line balanced honestly:
 *
 *   run 33899174030 (report)  slot 0/16  rows scanned 11 (+2,046 other slots)
 *   run 33899784003 (APPLY)   slot 0/16  "APPLIED ... intended 11 =
 *                                         written 0 + skipped 11"
 *
 * An under-sweep that reconciles honestly is the worst failure mode available:
 * every signal a reviewer checks -- exit code, banner, reconciliation --
 * says success.
 *
 * THE TIE CANNOT BE BROKEN FROM THE ENVIRONMENT. `slot=0 slots=16` is
 * byte-identical whether the dispatcher chose it or inherited it, so no amount
 * of `?? 1` defaulting can help -- the value is never undefined. The rule:
 *
 *   slot > 0      only a deliberate dispatch names a non-zero slot, and such a
 *                 run is by definition one of a fan-out.
 *   SHARD=true    the explicit opt-in for slot 0 of a REAL fan-out, so a
 *                 genuine 16-way run still works and slot 0 is not
 *                 double-covered.
 *
 * Everything else -- unset, empty, and the inherited `slot=0 slots=16` --
 * sweeps EVERY row. This is the doctrine that already makes the inherited
 * `scope=refractor` mean "no setKey filter": a scope nobody chose is not a
 * scope.
 *
 * ONE helper, not a copy per script. #1756 fixed two Tiffany lanes in place;
 * fifty-one more scripts carried the identical read, and fifty-one more copies
 * of this reasoning is fifty-one more places for it to drift.
 *
 * USAGE
 *
 *   const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
 *   const SHARD_SCOPE = runnerShardScope();
 *   const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
 *   ...
 *   const mine = (key) => !SHARDED || shardOf(key) === SLOT;
 *   console.log(SHARD_SCOPE.banner());
 *
 * When SHARDED is false, SLOTS is 1 -- so an existing `SLOTS === 1 || ...`
 * guard keeps working unchanged, and a `% SLOTS` shard function degenerates to
 * a single shard rather than silently dropping rows.
 *
 * SCRIPTS WITH THEIR OWN FAN-OUT DEFAULT (rematch-sold-comps: 32,
 * normalize-catalog-format: 16) are NOT this defect: they declare sharding as
 * their normal operating mode and are always dispatched per slot. They pass
 * `alwaysShard: true` and keep sharding whatever the env says.
 */

"use strict";

const AFFIRMATIVE = /^(1|true|yes|on)$/i;

/**
 * Decide whether THIS run is a shard of a fan-out, or a full sweep.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  env to read (default process.env)
 * @param {number} [opts.defaultSlots]    slots when the dispatch names none and
 *                                        the script shards by default
 * @param {boolean} [opts.alwaysShard]    true for scripts whose normal mode IS
 *                                        a fan-out (rematch-sold-comps,
 *                                        normalize-catalog-format). They shard
 *                                        on the env alone.
 * @param {string|number} [opts.slotArg]  an explicit CLI `--slot` (engine-backtest,
 *                                        repair-missing-search-fields). A flag typed
 *                                        on a command line IS a choice, so it opts in
 *                                        the same way a non-zero slot does -- including
 *                                        `--slot 0`, which no default can produce.
 * @param {string|number} [opts.slotsArg] an explicit CLI `--slots`.
 * @param {string} [opts.label]           script name, for the banner
 * @returns {{SHARDED:boolean, SLOT:number, SLOTS:number, SLOTS_REQUESTED:number,
 *            SHARD_OPT_IN:boolean, inheritedDefault:boolean, mine:(k:number)=>boolean,
 *            banner:()=>string}}
 */
function runnerShardScope(opts = {}) {
  const env = opts.env || process.env;
  const alwaysShard = opts.alwaysShard === true;

  // A CLI flag is unambiguously a CHOICE -- nothing defaults it -- so it both
  // supplies the value and counts as the opt-in, even for `--slot 0`.
  const cliSlot = opts.slotArg === undefined || opts.slotArg === null ? "" : String(opts.slotArg).trim();
  const cliSlots = opts.slotsArg === undefined || opts.slotsArg === null ? "" : String(opts.slotsArg).trim();
  const rawSlot = cliSlot || String(env.SLOT ?? "").trim();
  const rawSlots = cliSlots || String(env.SLOTS ?? "").trim();

  const parsedSlot = Number(rawSlot || 0);
  const SLOT = Number.isFinite(parsedSlot) && parsedSlot >= 0 ? parsedSlot : 0;

  const parsedSlots = Number(rawSlots || (opts.defaultSlots ?? 1));
  const SLOTS_REQUESTED = Number.isFinite(parsedSlots) && parsedSlots >= 1
    ? Math.floor(parsedSlots)
    : 1;

  const SHARD_OPT_IN = AFFIRMATIVE.test(String(env.SHARD ?? "").trim());

  // A non-zero slot is self-evidently deliberate: no default names one.
  // Slot 0 needs the explicit opt-in, because slot 0 is the default.
  const chosen = SLOT > 0 || SHARD_OPT_IN || cliSlot !== "";
  const SHARDED = SLOTS_REQUESTED > 1 && (alwaysShard || chosen);

  // The inherited-default tell: more than one slot was asked for, slot 0, and
  // nobody opted in. This is the exact shape that ran #1745 and #1752 at 1/16.
  const inheritedDefault = SLOTS_REQUESTED > 1 && !chosen && !alwaysShard;

  const SLOTS = SHARDED ? SLOTS_REQUESTED : 1;

  const mine = (shardIndex) => !SHARDED || Number(shardIndex) === SLOT;

  const banner = () => {
    const who = opts.label ? `${opts.label}  ` : "";
    if (SHARDED) {
      return `${who}sharding ON -- slot ${SLOT}/${SLOTS}. THIS RUN COVERS 1/${SLOTS} OF THE POPULATION; `
        + `dispatch every slot 0..${SLOTS - 1} or the sweep is partial.`;
    }
    if (inheritedDefault) {
      return `${who}sharding OFF -- this run sweeps EVERY row `
        + `(slots=${rawSlots} is the runner's inherited default, not a chosen shard; `
        + `pass SHARD=true with slot=0 to fan out).`;
    }
    return `${who}sharding OFF -- this run sweeps EVERY row.`;
  };

  return { SHARDED, SLOT, SLOTS, SLOTS_REQUESTED, SHARD_OPT_IN, inheritedDefault, mine, banner };
}

module.exports = { runnerShardScope };
