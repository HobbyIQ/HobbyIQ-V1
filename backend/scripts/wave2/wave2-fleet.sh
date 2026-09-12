#!/usr/bin/env bash
# wave2-fleet.sh — the WAVE 2 fleet driver.
#
# CF-VERIFY-EACH-SLOT-BY-ITS-BANNER-NEVER-BY-RUN-CONCLUSION.
#
# WHAT THIS IS. WAVE 2 is the population-wide IMPROVE apply of the GREAT
# REMATCH: the ~44k writable `unknown`-keyed rows, the soccer competition rows,
# the Hoops 3,057, the Bowman Chrome Draft rows, the Pokémon finish/era rows.
# It runs in TWO PHASES over the same 32-slot shard table:
#
#   census   mode=census apply=false  — every slot, report-only. Produces the
#            per-slot `census-slot-<N>.json` artifact, which is BOTH the new I9
#            reference (via rebaseline-i9-reference.cjs) AND the expected
#            writable count each apply slot is gated against.
#   apply    mode=apply-improve apply=true scope=improve — the writes, in
#            waves of 4, slot 0 first as the canary.
#
# WHY A BANNER AND NOT A CONCLUSION. A green run is not a written row and a red
# run is not a lost one. Eighteen slots of the 2026-09-07 fleet died in 55-70
# SECONDS at a startup refusal and were reported as kills at the 150-minute
# ceiling (#1963); ten killed APPLY shards of retire-self-derived-identities
# reported "finished within budget" with the work half done (#1906). Both were
# visible in the log and invisible in the conclusion. So every gate in this
# file reads the LOG of the run — the census "rows classified" line, the apply
# "re-keyed / skipped / failed / not reached" block and its `intended = written
# + ...` reconciliation — and a slot with no readable banner is NOT PASSED, it
# is HELD.
#
# THE SELF-RELAUNCH IS PART OF A SLOT. The runner re-dispatches a slot that hit
# its 140-minute budget (`stopped at the ... budget`), so ONE SLOT IS A CHAIN OF
# RUNS, not one run. This driver follows the chain to its end before it judges
# the slot, and a chain that ends on a STARTUP REFUSED or a kill is HELD.
#
# NO NEW WORKFLOW INPUTS. Everything here dispatches the seven that exist:
# script, apply, mode, scope, slot, slots, concurrency.
#
# USAGE
#   backend/scripts/wave2/wave2-fleet.sh census          # 32 slots, report-only
#   backend/scripts/wave2/wave2-fleet.sh collect <dir>   # download census artifacts
#   backend/scripts/wave2/wave2-fleet.sh canary          # slot 0 apply, gated
#   backend/scripts/wave2/wave2-fleet.sh apply           # slots 1..31, waves of 4
#
# `apply` and `canary` REFUSE without WAVE2_CENSUS_DIR pointing at collected
# census artifacts: an apply with no expected writable count has no gate.
#
# DRY RUN. WAVE2_DISPATCH=false prints every `gh workflow run` it would issue
# and dispatches nothing. That is the default — an apply must be armed by hand.
set -uo pipefail

REPO="${WAVE2_REPO:-HobbyIQ/HobbyIQ-V1}"
REF="${WAVE2_REF:-main}"
SLOTS="${WAVE2_SLOTS:-32}"
# WHICH slots this invocation drives -- NOT how many the shard table has.
# WAVE2_SLOTS is the DENOMINATOR: it is dispatched as `-f slots=` and it decides
# which rows a slot owns, so lowering it to run one slot would silently re-shard
# the corpus and make the run's census meaningless. WAVE2_ONLY_SLOTS instead
# selects a SUBSET of the same 32-slot table to dispatch and follow -- a comma
# list, e.g. `WAVE2_ONLY_SLOTS=0` to verify the driver end-to-end on slot 0
# alone. Empty (the default) means every slot.
ONLY_SLOTS="${WAVE2_ONLY_SLOTS:-}"
CONCURRENCY="${WAVE2_CONCURRENCY:-16}"
WAVE_SIZE="${WAVE2_WAVE_SIZE:-4}"
# The verdict-equality band. An apply slot must write within ±BAND% of the
# writable count its own census measured. Outside it, the slot is HELD: either
# the corpus moved under us or the apply is writing a class the census did not
# count, and both are reasons to stop the fleet rather than to keep dispatching.
BAND_PCT="${WAVE2_BAND_PCT:-5}"
CENSUS_DIR="${WAVE2_CENSUS_DIR:-}"
DISPATCH="${WAVE2_DISPATCH:-false}"
POLL_SECS="${WAVE2_POLL_SECS:-60}"
# A slot's chain may relaunch several times under the 180-minute job ceiling.
MAX_CHAIN_MINUTES="${WAVE2_MAX_CHAIN_MINUTES:-600}"
LOGDIR="${WAVE2_LOGDIR:-/tmp/wave2}"
# THE DISPATCH STAGGER (2026-09-11). On 2026-09-08/09 the census fan-out
# dispatched all 32 slots in one tight loop with no ceiling on how many ran at
# once, and each of the 18 slots that could not finish in one budget
# re-dispatched itself every ~2h10m forever -- ~26 runners held for ~20 hours
# before a human cancelled 28 runs. `preflight_lane` refuses to START a fresh
# fan-out into an already-stalled queue, but nothing stopped THIS driver from
# being the thing that stalls it. So the census phase now polls the
# in_progress count before EVERY dispatch and waits for room, capping how many
# of ITS OWN slots can be in flight at once -- independent of whatever else is
# using the shared backfill-runner lane.
#
# 2026-09-12: "independent of whatever else is using the shared lane" was the
# INTENT here from the start but not what the code measured -- see the
# comment above inflight_state_dir() for the gap between the two and the
# per-slot chain table that closes it.
MAX_INFLIGHT_CENSUS_SLOTS="${WAVE2_MAX_INFLIGHT_CENSUS_SLOTS:-8}"
INFLIGHT_POLL_SECS="${WAVE2_INFLIGHT_POLL_SECS:-30}"

mkdir -p "$LOGDIR"

say()  { printf '%s\n' "$*"; }
warn() { printf 'WAVE2 !! %s\n' "$*" >&2; }
die()  { printf 'WAVE2 REFUSED — %s\n' "$*" >&2; exit 2; }

# ── BANNER READERS ───────────────────────────────────────────────────────────
#
# Each reader takes a log FILE and prints ONE number, or prints nothing and
# returns nonzero. Nothing here infers: a number that is not in the log is
# absent, and absent is never zero. `grep -a` throughout because a runner log
# can carry bytes that make grep call it binary and print nothing at all.
#
# CF-CLASSIFY-READS-THE-REPORT-NOT-THE-LINE-SHAPE (#1868). THE DEFECT THIS FILE
# WOULD OTHERWISE HAVE SHIPPED WITH. `gh run view --log` prefixes EVERY line
# with `<job>\t<step>\t<ISO timestamp> `, so a `^`-anchored grep against a
# captured log matches NOTHING and returns a silent zero — which is how a whole
# night's classification once reported all-zeros. Every reader below therefore
# runs its log through `normalize` FIRST, which strips that prefix and any ANSI
# and leaves a raw capture (`| tee`, a fixture) untouched. Anchors are then
# safe, and they are worth keeping: `  failed  N` must not match the `failed`
# inside a per-row `FAILED at ...` line.
# THE LOG CONTAINS THE GATE'S OWN GREP PATTERNS, AND THAT IS NOT HYPOTHETICAL.
# `gh run view --log` includes each step's SCRIPT as Actions echoes it, so the
# relaunch step's own `grep -aqE "stopped at the .*budget"` appears in the log
# as text. Measured on run 33947033673: `chain_outcome` read `budget` from a
# run that never hit its budget, because it matched the workflow's echoed
# command rather than the lane's banner. Two lines, both wearing an Actions
# marker the lane's own stdout can never carry:
#
#   ##[group]Run if grep -aqE "stopped at the .*budget" ...
#   ESC[36;1mif grep -aqE "stopped at the .*budget" ...ESC[0m
#
# So those are dropped FIRST — before ANSI is stripped, because the escape
# sequence is the evidence — and only then is the prefix removed. A raw capture
# has neither and passes through untouched.
#
# NOTE THE TWO SPELLINGS OF THE ESCAPE. `gh run view --log` does not hand back a
# real ESC byte for a command echo: run 33947033673 stores the literal two
# characters `^` `[` (verified with od -c). A pattern written as $'\x1b[' therefore
# matches NOTHING in a captured log, which is how the first attempt at this
# filter still read `budget` off an echoed grep. Both spellings are excluded --
# the literal caret-bracket a capture carries, and the real escape a live
# terminal would.
normalize() {
  local ESC; ESC=$(printf '\033')
  grep -av -e '##\[' -e '\^\[\[' -e "${ESC}\[" "$1" \
    | sed -e "s/${ESC}\[[0-9;]*m//g" \
          -e 's/^[^\t]*\t[^\t]*\t//' \
          -e 's/^[[:space:]]*[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T[0-9:.]*Z[[:space:]]\{0,1\}//'
}

# "CENSUS  slot 0/32  rows classified 514,583"
census_classified() {
  local n
  n=$(normalize "$1" | grep -aoE '^CENSUS  slot [0-9]+/[0-9]+  rows classified [0-9,]+' \
      | tail -1 | grep -oE '[0-9,]+$' | tr -d ,)
  [ -n "${n:-}" ] || return 1
  printf '%s' "$n"
}

# "  IMPROVE           20,867    4.06%   AUTO ..." — the class line's count.
census_class() {
  local klass="$2" n
  n=$(normalize "$1" | grep -aoE "^  ${klass}[[:space:]]+[0-9,]+" \
      | tail -1 | grep -oE '[0-9,]+' | tr -d ,)
  [ -n "${n:-}" ] || return 1
  printf '%s' "$n"
}

# "  re-keyed   1,234" on an apply; "  would re-key   1,234" on a report.
apply_written() {
  local n
  n=$(normalize "$1" | grep -aoE '^  (re-keyed|would re-key)[[:space:]]+[0-9,]+' \
      | tail -1 | grep -oE '[0-9,]+$' | tr -d ,)
  [ -n "${n:-}" ] || return 1
  printf '%s' "$n"
}

apply_field() {
  local label="$2" n
  n=$(normalize "$1" | grep -aoE "^  ${label}[[:space:]]+[0-9,]+" | tail -1 | grep -oE '[0-9,]+$' | tr -d ,)
  [ -n "${n:-}" ] || return 1
  printf '%s' "$n"
}

# "  intended 5 = written 4 + skipped 1 + failed 0 + not reached 0"
# Returns 0 only when the line is PRESENT and BALANCES. A missing line is not a
# balanced one: the script exits 4 on drift, and a log without the line never
# reached its summary.
apply_reconciled() {
  local line i w s fa nr
  line=$(normalize "$1" | grep -aoE '^  intended [0-9,]+ = written [0-9,]+ \+ skipped [0-9,]+ \+ failed [0-9,]+ \+ not reached [0-9,]+' | tail -1)
  [ -n "${line:-}" ] || return 1
  i=$(printf '%s' "$line" | grep -oE 'intended [0-9,]+' | grep -oE '[0-9,]+' | tr -d ,)
  w=$(printf '%s' "$line" | grep -oE 'written [0-9,]+'  | grep -oE '[0-9,]+' | tr -d ,)
  s=$(printf '%s' "$line" | grep -oE 'skipped [0-9,]+'  | grep -oE '[0-9,]+' | tr -d ,)
  fa=$(printf '%s' "$line" | grep -oE 'failed [0-9,]+'  | grep -oE '[0-9,]+' | tr -d ,)
  nr=$(printf '%s' "$line" | grep -oE 'not reached [0-9,]+' | grep -oE '[0-9,]+' | tr -d ,)
  [ "$((w + s + fa + nr))" -eq "$i" ] || return 1
  printf '%s' "$i"
}

# The four outcomes the runner itself distinguishes, read from the lane's log.
# Printed as one word so a caller can branch on it.
chain_outcome() {
  local f="$1" n
  n=$(normalize "$f")
  if   grep -aq 'rematch-sold-comps: STARTUP REFUSED' <<< "$n"; then printf 'startup-refused'
  elif [ ! -s "$f" ];                                                     then printf 'empty-log'
  elif grep -aq 'rematch-sold-comps: STARTUP ok' <<< "$n" \
       && ! grep -aqE '^rematch-sold-comps  MODE=' <<< "$n";    then printf 'died-in-startup'
  elif grep -aqE 'stopped at the .*budget' <<< "$n";            then printf 'budget'
  elif grep -aqE 'finishLane: exiting code 0( |$)' <<< "$n";    then printf 'finished'
  elif grep -aqE 'finishLane: exiting code [0-9]+' <<< "$n";    then printf 'verdict'
  else                                                                         printf 'killed'
  fi
}

# ── THE CANARY GATE THE SCRIPT ITSELF RUNS ───────────────────────────────────
#
# Every apply shard runs a before/apply/after canary triple IN ITS OWN JOB, and
# `rematch-canary-check.cjs` MODE=after exits 5 on a regression. That is a
# stronger, attributed claim than anything this driver could compute from
# outside: it reads the write ledger on the same runner, so a canary pool this
# shard never wrote in cannot be blamed on it (#1711/#1727).
#
# So the fleet does not re-derive it — it READS ITS VERDICT, and treats an
# ABSENT verdict as a hold. A shard whose canary line never printed did not
# pass its canary; it failed to produce one, which is the same reason a missing
# banner is not a zero.
canary_verdict() {
  local n; n=$(normalize "$1")
  if   grep -aqE 'canaries REGRESSED' <<< "$n";                     then printf 'regressed'
  elif grep -aqE 'canaries hold -- the shard may stand' <<< "$n";   then printf 'hold'
  else                                                                            printf 'absent'
  fi
}

# ── DISPATCH + FOLLOW ────────────────────────────────────────────────────────

# ── PREFLIGHT: IS THE LANE MOVING AT ALL? ────────────────────────────────────
#
# Measured 2026-09-07, while taking this driver's own shape proof: 30
# backfill-runner runs QUEUED and ZERO in_progress, the oldest waiting over two
# and a half hours and never starting. Other workflows ran normally in the same
# window, so it was the backfill lane specifically — the fleet's own dispatch
# pattern (121 runner runs in a day, each holding a 180-minute job slot)
# exhausting the concurrent-job allowance and starving every later dispatch,
# including its own self-relaunches.
#
# Adding 32 more 180-minute jobs to that queue does not start 32 jobs; it ages
# them. The driver would eventually report them as `timeout`, correctly but
# slowly, and this query says the same thing in one call. So it is checked
# BEFORE dispatching, not discovered after.
#
# WAVE2_SKIP_PREFLIGHT=true bypasses it for a deliberate queue-behind.
preflight_lane() {
  [ "${WAVE2_SKIP_PREFLIGHT:-false}" = "true" ] && return 0
  local counts queued running
  counts=$(gh run list --repo "$REPO" --workflow=backfill-runner.yml --limit 60 \
             --json status --jq '"\([.[]|select(.status=="queued")]|length) \([.[]|select(.status=="in_progress")]|length)"' 2>/dev/null)
  [ -n "${counts:-}" ] || { warn "could not read the backfill lane's state — proceeding blind"; return 0; }
  queued=${counts%% *}; running=${counts##* }
  say "WAVE2 preflight: backfill-runner lane has $queued queued, $running in progress"
  # A deep queue with NOTHING running is a stalled lane, not a busy one.
  if [ "${queued:-0}" -ge 10 ] && [ "${running:-0}" -eq 0 ]; then
    die "the backfill lane is STALLED — $queued queued and none running. Dispatching $SLOTS more 180-minute jobs would only age them. Clear or cancel the stale queue first, or set WAVE2_SKIP_PREFLIGHT=true to queue behind it deliberately."
  fi
  return 0
}

# ── THE STAGGER'S OWN SLOT TABLE (2026-09-12) ───────────────────────────────
#
# THE DEFECT THIS REPLACES. The original `inflight_census_count` counted every
# queued/in_progress run on the SHARED backfill-runner.yml lane created since
# the phase started -- no filter on script, mode or slot. Measured tonight: 6
# real census slots plus 2 unrelated baseline-pool-snapshot cron runs read as
# "8 in flight" against a cap of 8, and slot 10+ never dispatched though this
# fleet genuinely had room. The workflow has no free-text or marker INPUT to
# filter on -- `script` is a fixed dropdown (see the `on.workflow_dispatch`
# block above) -- and `gh run list`'s `displayTitle`/`name` are the workflow's
# STATIC name for every run regardless of script/mode/slot (the same fact
# `find_run_for_slot`'s "THE STEP NAMES ARE NOT AN ALTERNATIVE" comment
# already established for job step names), so neither can substitute.
#
# THE FIX IS A TABLE OF THIS FLEET'S OWN CHAINS, ONE ROW PER SLOT --
# `$LOGDIR/.inflight-<tag>/<slot>.run_id` -- keyed by the run id THIS driver
# dispatched for that slot, or a self-relaunch successor of that run. A
# slot's row is never a foreign run: it starts from a run id `dispatch()`
# itself just created, and moves only to a run id `run_log_identifies_slot`
# positively identifies (the SAME log check every other verdict in this file
# uses, never touched here) as MODE=census slot N.
#
# CHAINS, NOT RUNS (the second defect named alongside the first). A link that
# stops at its budget is not the end of the slot -- `relaunch-on-marker`
# dispatches the successor inline, in the same job step, seconds after the
# predecessor's completed status is visible. So a slot whose current link just
# went `budget` must still count as ONE in-flight slot for a grace window
# after that completion: the successor is real but not yet visible to
# `gh run list`, and undercounting it is exactly the race that would let a
# 9th dispatch through while 8 chains are still alive.
INFLIGHT_BUDGET_GRACE_SECS="${WAVE2_INFLIGHT_BUDGET_GRACE_SECS:-90}"

# Where this phase's per-slot tracking rows live. Cleared per invocation of
# phase_census (never across CLI runs) so a stale row from an earlier session
# cannot mis-attribute a run id that has since finished and moved on.
inflight_state_dir() { printf '%s/.inflight-%s' "$LOGDIR" "$1"; }

inflight_reset_state() {
  local tag="$1"
  rm -rf "$(inflight_state_dir "$tag")"
  mkdir -p "$(inflight_state_dir "$tag")"
}

# Record the run THIS dispatch just created as slot `$2`'s current chain link.
# Called only from dispatch()'s success path, so `run_id` is always a run this
# driver itself created -- never a candidate found by searching the lane.
inflight_track_dispatch() {
  local tag="$1" slot="$2" run_id="$3" dir
  dir="$(inflight_state_dir "$tag")"
  mkdir -p "$dir"
  printf '%s' "$run_id" >"$dir/$slot.run_id"
  rm -f "$dir/$slot.budget_at"
}

# Refresh ONE slot's row against `gh` and print whether it still counts as
# in-flight ("1" or "0"). Never touches a run id this driver did not itself
# attach: the only way a new id ever lands in the row is
# run_log_identifies_slot() confirming it as MODE=census slot N's successor,
# the identical check follow_slot() gates its own verdict reads on.
inflight_refresh_slot() {
  local tag="$1" slot="$2" dir run_id st
  dir="$(inflight_state_dir "$tag")"
  run_id=$(cat "$dir/$slot.run_id" 2>/dev/null) || return 1
  [ -n "${run_id:-}" ] || return 1

  st=$(gh run view "$run_id" --repo "$REPO" --json status --jq .status 2>/dev/null)
  case "$st" in
    queued|in_progress)
      rm -f "$dir/$slot.budget_at"
      printf '1'; return 0
      ;;
    completed)
      local log="$LOGDIR/.probe-inflight-$tag-$slot.log"
      gh run view "$run_id" --repo "$REPO" --log >"$log" 2>/dev/null || : >"$log"
      if ! run_log_identifies_slot "$log" census "$slot"; then
        # Not a run we can attribute to this slot's census -- stop tracking it
        # rather than guessing. A slot with no attributable row is simply not
        # counted (never assumed in-flight, never assumed clear): the next
        # dispatch loop iteration for THIS slot has not happened yet, so there
        # is nothing further to track until it does.
        rm -f "$log" "$dir/$slot.run_id" "$dir/$slot.budget_at"
        printf '0'; return 0
      fi
      if [ "$(chain_outcome "$log")" = "budget" ]; then
        rm -f "$log"
        # First time we have seen THIS link report budget: stamp the grace
        # window clock. Re-checking the same completed run on a later poll
        # must not keep resetting the clock -- only replacing run_id with a
        # newly found successor (below) clears it.
        [ -s "$dir/$slot.budget_at" ] || date +%s >"$dir/$slot.budget_at"
        # Look for the successor now: find_run_for_slot with a short discovery
        # window and NO completion wait (WAVE2_IDENTIFY_TIMEOUT_MINUTES=0 would
        # be a no-op deadline in bash's integer arithmetic, so a one-shot probe
        # is done inline instead of borrowing the full finder's blocking loop).
        local since succ
        since=$(date -u -d "@$(( $(cat "$dir/$slot.budget_at") - 5 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
                || date -u +%Y-%m-%dT%H:%M:%SZ)
        succ=$(inflight_find_successor census "$slot" "$since" "$run_id")
        if [ -n "${succ:-}" ]; then
          printf '%s' "$succ" >"$dir/$slot.run_id"
          rm -f "$dir/$slot.budget_at"
          printf '1'; return 0
        fi
        # No successor visible yet. Still counts as in-flight while inside the
        # grace window -- the chain is not over, `gh run list` just has not
        # shown the new run yet.
        local age=$(( $(date +%s) - $(cat "$dir/$slot.budget_at") ))
        if [ "$age" -lt "$INFLIGHT_BUDGET_GRACE_SECS" ]; then
          printf '1'; return 0
        fi
        warn "slot $slot: budget stop on run $run_id but no self-relaunch successor became visible within ${INFLIGHT_BUDGET_GRACE_SECS}s -- no longer counted in-flight."
        rm -f "$dir/$slot.run_id" "$dir/$slot.budget_at"
        printf '0'; return 0
      fi
      # Any other completed outcome (finished, verdict, killed, startup-refused,
      # died-in-startup) ends the chain for stagger purposes -- follow_slot is
      # what judges the slot; this table only tracks whether it is still using
      # a runner slot.
      rm -f "$log" "$dir/$slot.run_id" "$dir/$slot.budget_at"
      printf '0'; return 0
      ;;
    *)
      # gh failed or returned nothing for a run id we DO hold -- not proof the
      # run ended, so it is not dropped from the table. Read as "cannot
      # confirm" rather than "clear", the same non-fatal-but-not-optimistic
      # posture wait_for_inflight_room already takes on a whole-query failure.
      return 1
      ;;
  esac
}

# A single, non-blocking probe for a budget-stopped slot's self-relaunch
# successor: the SAME identification find_run_for_slot uses (script + MODE +
# slot, off the completed log -- run_log_identifies_slot, untouched), but
# capped to one pass over the candidate list with no polling loop, because
# inflight_refresh_slot is itself called repeatedly from the stagger's own
# poll loop and must not block behind a second nested wait.
inflight_find_successor() {
  local mode="$1" slot="$2" since="$3" exclude="$4"
  local ids id st probe
  ids=$(gh run list --repo "$REPO" --workflow=backfill-runner.yml --limit 100 \
          --json databaseId,createdAt --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | .[].databaseId" 2>/dev/null)
  for id in ${ids:-}; do
    [ "$id" = "$exclude" ] && continue
    st=$(gh run view "$id" --repo "$REPO" --json status --jq .status 2>/dev/null)
    case "$st" in
      queued|in_progress)
        printf '%s' "$id"; return 0
        ;;
      completed)
        probe="$LOGDIR/.probe-successor-$mode-$slot.log"
        gh run view "$id" --repo "$REPO" --log >"$probe" 2>/dev/null || : >"$probe"
        if run_log_identifies_slot "$probe" "$mode" "$slot"; then
          rm -f "$probe"
          printf '%s' "$id"; return 0
        fi
        rm -f "$probe"
        ;;
    esac
  done
  return 1
}

# How many of THIS driver's own census CHAINS are currently in flight: every
# tracked slot whose inflight_refresh_slot() call returns "1". `tag` scopes
# the state table to one phase_census invocation. Prints NOTHING (not "0")
# and returns nonzero if any tracked slot's status could not be confirmed --
# same "cannot confirm, don't guess" contract the old whole-query read had,
# just evaluated per row instead of per call.
inflight_census_count() {
  local tag="$1" dir slot n=0 r
  dir="$(inflight_state_dir "$tag")"
  [ -d "$dir" ] || { printf '0'; return 0; }
  for f in "$dir"/*.run_id; do
    [ -e "$f" ] || continue
    slot=$(basename "$f" .run_id)
    r=$(inflight_refresh_slot "$tag" "$slot") || return 1
    [ "$r" = "1" ] && n=$((n + 1))
  done
  printf '%s' "$n"
}

# Block until fewer than MAX_INFLIGHT_CENSUS_SLOTS of this driver's own
# CHAINS (tracked in `$tag`'s state table) are in flight. Never blocks
# forever: a `gh` failure is read as "cannot confirm room" and proceeds rather
# than wedging the fleet on a transient API error, the same non-fatal posture
# preflight_lane takes on the same failure.
wait_for_inflight_room() {
  local tag="$1" n
  while :; do
    n=$(inflight_census_count "$tag")
    if [ -z "${n:-}" ]; then
      warn "could not read in-flight census count — proceeding without the stagger for this dispatch"
      return 0
    fi
    [ "$n" -lt "$MAX_INFLIGHT_CENSUS_SLOTS" ] && return 0
    say "WAVE2 stagger: $n slot(s) already in flight (cap $MAX_INFLIGHT_CENSUS_SLOTS) — waiting for room"
    sleep "$INFLIGHT_POLL_SECS"
  done
}

dispatch() {
  local mode="$1" apply="$2" scope="$3" slot="$4" inflight_tag="${5:-}"
  local cmd=(gh workflow run backfill-runner.yml --repo "$REPO" --ref "$REF"
             -f script=rematch-sold-comps
             -f mode="$mode" -f apply="$apply" -f scope="$scope"
             -f slot="$slot" -f slots="$SLOTS" -f concurrency="$CONCURRENCY")
  if [ "$DISPATCH" != "true" ]; then
    say "WAVE2 dry-run: ${cmd[*]}"
    return 0
  fi
  # KEEP WHAT `gh` PRINTS. It emits the new run's URL on success, and that URL
  # is the ONLY local evidence a run was actually created. Measured while
  # verifying this change on 2026-09-08 13:13Z: a dispatch exited 0 and created
  # NO run -- the lane list has a clean gap where it should be -- and because
  # the output went to /dev/null the fleet announced "dispatched slot 0" and
  # then spent fifteen minutes hunting a run that never existed. The finder
  # correctly reported `unfound`, but the driver could have said so at once.
  local out rc
  out=$("${cmd[@]}" 2>&1); rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "dispatch failed for slot $slot (gh exit $rc): $(printf '%s' "$out" | tr '\n' ' ')"
    return 1
  fi
  # `gh workflow run` prints the run URL on success. No URL means gh accepted
  # the request without creating a run, which is NOT a dispatch -- say so here
  # rather than leaving the finder to discover it fifteen minutes later.
  local url; url=$(printf '%s' "$out" | grep -aoE 'https://github.com/[^ ]*/actions/runs/[0-9]+' | tail -1)
  if [ -z "${url:-}" ]; then
    warn "slot $slot: gh exited 0 but printed no run URL -- NOTHING WAS DISPATCHED. gh said: $(printf '%s' "$out" | tr '\n' ' ')"
    return 1
  fi
  say "WAVE2 dispatched slot $slot ($mode apply=$apply scope=$scope) -> $url"
  # THE STAGGER'S OWN TABLE. `$inflight_tag`, when given (only the census
  # phase's dispatch loop passes it), seeds this slot's in-flight tracking row
  # with the run id `gh` just handed back. This is a SEED, not a trusted
  # identity: inflight_refresh_slot() never counts a completed run toward the
  # cap without first passing it through run_log_identifies_slot, the same
  # check follow_slot() gates every verdict on -- so a URL that (rarely) named
  # the wrong run is simply dropped from the table once it completes and fails
  # that check, never miscounted as a foreign slot's chain link.
  if [ -n "$inflight_tag" ]; then
    local run_id; run_id=$(printf '%s' "$url" | grep -aoE '[0-9]+$')
    [ -n "${run_id:-}" ] && inflight_track_dispatch "$inflight_tag" "$slot" "$run_id"
  fi
}

# -- THE FINDER: A RUN IS THIS SLOT'S ONLY WHEN ITS OWN LOG SAYS SO ----------
#
# CF-A-RUN-IS-IDENTIFIED-BY-ITS-LOG-NOT-BY-ITS-TIMING (#1974). THE DEFECT THIS
# REPLACES. The finder that stood here took `slot` as an argument and NEVER USED
# IT. It asked `gh run list` for the newest backfill-runner run created after
# the dispatch timestamp and returned that, for every slot. backfill-runner is a
# SHARED lane -- every repair, retire and park script in the repo dispatches it
# -- so "newest run on this workflow" names whatever else happened to be
# dispatched in the same minute.
#
# Measured 2026-09-08 01:44Z: all 32 census slots reported `outcome=killed`, and
# the run the fleet followed for slot 0 was a PARK LANE -- its log says
# `Script confirmed: backend/scripts/relocate-pool-rows-by-list.cjs`. Thirty-two
# verdicts were read off one stranger's run; the census runs themselves were
# never opened. `killed` was not a measurement of anything. It was the shape a
# foreign log makes when you ask it questions it has no answer to -- every
# banner reader found nothing, and `chain_outcome`'s else-branch calls "nothing"
# a kill.
#
# THE FIX IS POSITIVE IDENTIFICATION, NOT A NARROWER WINDOW. Timing cannot
# separate two runs dispatched in the same second, and no amount of
# window-tightening makes it able to. The run must SAY WHO IT IS, and the runner
# already prints every fact needed, on two lines it emits unconditionally:
#
#   Script confirmed: backend/scripts/rematch-sold-comps.cjs   (workflow, always)
#   rematch-sold-comps  MODE=census  READ ONLY  slot 0/32 ...  (lane, at startup)
#
# The second line carries script name, MODE and SLOT together, which is what
# makes it decisive: a census of slot 7 cannot be mistaken for slot 0's, and an
# apply-improve run cannot be mistaken for a census. A candidate failing ANY of
# the three is REJECTED and polling continues -- it is not "close enough", it is
# someone else's run.
#
# AND THE GIVE-UP IS NAMED `unfound`, NEVER `killed`. Those are opposite facts:
# `killed` claims we read a run and it died; `unfound` says we never found the
# run at all. Reporting the second as the first is exactly how #1974 read as a
# fleet-wide failure rather than as a broken finder.
#
# HOW LONG TO WAIT FOR A RUN TO NAME ITSELF -- TWO SEPARATE CLOCKS
# (2026-09-11, replacing the single IDENTIFY_TIMEOUT_MINUTES this comment used
# to describe).
#
# THE DEFECT. Run 34360565942 -- a real census slot, not a stranger -- was
# reported `unfound`. `find_run_for_slot`'s own deadline bounded the ENTIRE
# search, and `gh run view --log` refuses outright while a run is in_progress
# (see run_log_identifies_slot's header), so identification necessarily
# happens at COMPLETION. A 140-minute census run therefore had to be found,
# confirmed in_progress, watched, AND have its completed log read to confirm
# identity -- all inside one 15-minute window whose own comment already
# admitted "the window spans queue time plus the run itself" and told the
# operator to raise it by hand rather than fixing the clock. The run was
# found, was correctly the right one, and was still discarded because it had
# not FINISHED inside a timeout meant for FINDING it.
#
# THE FIX SPLITS THE TWO QUESTIONS A CALLER WAS CONFLATING:
#
#   DISCOVERY   "does a candidate exist that COULD be ours?" -- bounded by
#               IDENTIFY_TIMEOUT_MINUTES (15m default). This covers the case
#               nothing was ever dispatched, or the dispatch never queued a
#               job (the #1974 failure this file's `dispatch()` already
#               guards). A queued/running candidate satisfies discovery the
#               moment it is SEEN -- it does not have to finish first.
#   COMPLETION  "has the candidate we are already watching finished, so its
#               log can be read?" -- once a NOT-YET-REJECTED in_progress
#               candidate has been seen, waiting for it to complete is no
#               longer a search and must not share the search's clock. It is
#               bounded by RUN_COMPLETION_TIMEOUT_MINUTES instead, sized for
#               the longest a budgeted lane can legitimately run
#               (RUN_MINUTES + reserve + verify, same arithmetic
#               runner-budget.cjs documents) rather than for how long an
#               operator is willing to watch a `gh run list` poll.
#
# A candidate that COMPLETES and turns out to be a stranger (rejected by
# run_log_identifies_slot) does not consume the completion clock for the NEXT
# candidate -- discovery resumes and gets its own fresh window, because a
# stranger finishing tells us nothing about whether another dispatch is still
# queued behind it.
IDENTIFY_TIMEOUT_MINUTES="${WAVE2_IDENTIFY_TIMEOUT_MINUTES:-15}"
RUN_COMPLETION_TIMEOUT_MINUTES="${WAVE2_RUN_COMPLETION_TIMEOUT_MINUTES:-200}"

# Does THIS log belong to THIS dispatch? Takes a log file, the mode and the
# slot. Returns 0 only when all three identity facts are present.
#
# THE SLOT MATCH CARRIES THE `/`. The banner spells it `slot 0/32`, and matching
# a bare `slot 1` would also match `slot 13/32` -- an off-by-a-digit that would
# reintroduce the very bug this function exists to kill. `SLOT: N` and `slot=N`
# are accepted as alternates because the workflow echoes the input that way in
# its env block, but the lane banner is primary: it is the only spelling that
# also proves MODE.
#
# NOTE THE HERESTRINGS, AND WHY THEY ARE NOT `printf | grep`. MEASURED against
# the real 755KB log of run 34232404064 -- the FIRST full-size capture this
# function ever saw: `printf '%s' "$n" | grep -aq PATTERN` RETURNS FAILURE ON A
# SUCCESSFUL MATCH. `grep -q` exits the instant it matches, printf then dies of
# SIGPIPE (141), and this file's `set -o pipefail` promotes that to the
# pipeline's status -- so the `&&` never fires and a run that DID identify
# itself is rejected. Every fixture in the test suite is small enough that
# printf finishes before grep exits, which is why all 88 pins passed while the
# real log failed. A herestring feeds grep without a pipe, so there is no
# SIGPIPE and no pipefail interaction. Same fix in chain_outcome and
# canary_verdict, which read the same large logs the same way.
run_log_identifies_slot() {
  local log="$1" mode="$2" slot="$3" n
  [ -s "$log" ] || return 1
  n=$(normalize "$log")
  # 1. THE SCRIPT. The workflow's own confirmation line, printed by every run
  #    before it runs anything. This is the line that unmasked the park lane.
  grep -aq 'Script confirmed: backend/scripts/rematch-sold-comps\.cjs' <<< "$n" || return 1
  # 2 + 3. MODE AND SLOT, from the one banner that states both at once.
  grep -aqE "^rematch-sold-comps  MODE=${mode}  .*[[:space:]]slot ${slot}/[0-9]+" <<< "$n" && return 0
  # The lane banner is absent on a run that died BEFORE printing one -- and a
  # startup refusal is a real outcome for this slot that must stay readable. So
  # fall back to the workflow's echoed inputs, which exist from the first step,
  # but only BOTH together and only alongside the script line proven above.
  grep -aqE "^(SLOT: ${slot}|slot=${slot})([^0-9]|$)" <<< "$n" || return 1
  grep -aqE "(MODE: ${mode}|mode=${mode})([^-a-z]|$)" <<< "$n" || return 1
  return 0
}

# Find the run THIS dispatch created for THIS slot by reading candidates' logs
# until one identifies itself. Prints the run id, or prints nothing and returns
# 1 after the relevant clock (see the two-clock comment above) runs out.
#
# Candidates are every backfill-runner run created at or after `since`, OLDEST
# FIRST -- oldest first because the fleet dispatches 32 slots in a loop and the
# run we want is usually behind newer ones by the time anything starts. Rejected
# ids are remembered, so a stranger's log is downloaded once rather than once
# per poll.
find_run_for_slot() {
  local mode="$1" slot="$2" since="$3"
  local discover_deadline=$(( $(date +%s) + IDENTIFY_TIMEOUT_MINUTES * 60 ))
  local probe="$LOGDIR/.probe-$mode-$slot.log"
  local rejected=" " ids id st
  # THE WATCHED CANDIDATE. Once a not-yet-rejected run is seen queued or
  # in_progress, it is "found" for discovery purposes -- what remains is only
  # waiting for it to COMPLETE, which is bounded by its own clock below, never
  # by discover_deadline. Empty means "nothing watched yet".
  local watched="" watch_deadline=0

  while :; do
    if [ -n "$watched" ]; then
      # COMPLETION CLOCK. A candidate is already attached; do not re-poll
      # `gh run list` (or age it out) while it may still be legitimately
      # running -- just ask whether IT is done.
      if [ "$(date +%s)" -ge "$watch_deadline" ]; then
        warn "slot $slot: run $watched has not completed within ${RUN_COMPLETION_TIMEOUT_MINUTES}m of being watched -- giving up on it as a candidate."
        rejected="$rejected$watched "
        watched=""
      else
        st=$(gh run view "$watched" --repo "$REPO" --json status --jq .status 2>/dev/null)
        if [ "$st" = "completed" ]; then
          gh run view "$watched" --repo "$REPO" --log >"$probe" 2>/dev/null || : >"$probe"
          if run_log_identifies_slot "$probe" "$mode" "$slot"; then
            rm -f "$probe"
            printf '%s' "$watched"; return 0
          fi
          # A completed stranger frees the completion clock; discovery gets a
          # FRESH discover_deadline, because a stranger finishing says nothing
          # about whether our own dispatch is still queued behind it.
          rejected="$rejected$watched "
          watched=""
          discover_deadline=$(( $(date +%s) + IDENTIFY_TIMEOUT_MINUTES * 60 ))
        fi
        # Still queued or in_progress: fall through to the sleep at the
        # bottom and check again next poll. No deadline applies here.
      fi
    else
      # DISCOVERY CLOCK. No candidate is attached yet.
      if [ "$(date +%s)" -ge "$discover_deadline" ]; then
        rm -f "$probe"
        return 1
      fi
      ids=$(gh run list --repo "$REPO" --workflow=backfill-runner.yml --limit 100 \
              --json databaseId,createdAt,status \
              --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | .[].databaseId" 2>/dev/null)
      for id in ${ids:-}; do
        case "$rejected" in *" $id "*) continue ;; esac
        st=$(gh run view "$id" --repo "$REPO" --json status --jq .status 2>/dev/null)
        # A QUEUED or IN-PROGRESS run is a legitimate candidate the moment it
        # is SEEN -- `gh run view --log` refuses outright while a run is
        # running ("logs will be available when it is complete"), so
        # identification necessarily happens at completion, and completion is
        # exactly what the WATCH clock below now waits for instead of the
        # search clock. Discovery's job ends here.
        #
        # THE STEP NAMES ARE NOT AN ALTERNATIVE, and that was measured rather
        # than assumed. `--json jobs` does expose step names live, but they
        # are the workflow's STATIC step list -- every backfill-runner run has
        # the same one. Compared 34232404064 (this fleet's census) against
        # 34231277782 (the park lane): both carry "Canary gate AFTER the
        # rematch apply", "Upload the shard census", "Self-relaunch
        # rematch-sold-comps ...". Nothing in a step name varies with
        # `script`, `mode` or `slot`, so a step-name match would re-create
        # #1974 exactly. Only the log says who a run is.
        if [ "$st" = "queued" ] || [ "$st" = "in_progress" ]; then
          watched="$id"
          watch_deadline=$(( $(date +%s) + RUN_COMPLETION_TIMEOUT_MINUTES * 60 ))
          break
        fi
        if [ "$st" = "completed" ]; then
          gh run view "$id" --repo "$REPO" --log >"$probe" 2>/dev/null || : >"$probe"
          if run_log_identifies_slot "$probe" "$mode" "$slot"; then
            rm -f "$probe"
            printf '%s' "$id"; return 0
          fi
          rejected="$rejected$id "
        fi
        # An unreadable status ($st empty -- gh failed) is neither watched nor
        # rejected; the next poll asks again.
      done
    fi
    sleep "$POLL_SECS"
  done
}

# Follow ONE SLOT to the end of its chain. Prints the final run's log to
# $LOGDIR/<phase>-slot-<N>.log and echoes the chain outcome word.
#
# THE SAME IDENTITY CHECK GUARDS THE VERDICT READ. Finding the right run once is
# not enough. A chain follows a self-relaunch onto a NEW run id, and that link
# is found the same way the first was -- by identifying itself -- so the fleet
# cannot drift onto a stranger between links either. And the completed log is
# re-checked before a single banner is read off it: the run was identified while
# in progress, and this proves the file being grepped is still that run's.
follow_slot() {
  local phase="$1" slot="$2" since="$3" mode="${4:-census}"
  local deadline=$(( $(date +%s) + MAX_CHAIN_MINUTES * 60 ))
  local log="$LOGDIR/$phase-slot-$slot.log"
  local run="" outcome="" st=""

  while [ "$(date +%s)" -lt "$deadline" ]; do
    run=$(find_run_for_slot "$mode" "$slot" "$since") || {
      warn "slot $slot: NO run identified itself as rematch-sold-comps MODE=$mode slot $slot within ${IDENTIFY_TIMEOUT_MINUTES}m of $since -- this is not a kill, it is a run we never found."
      printf 'unfound'; return 0
    }
    say "WAVE2 slot $slot: attached to run $run -- identified by its own log (rematch-sold-comps, MODE=$mode, slot $slot)" >&2

    while [ "$(date +%s)" -lt "$deadline" ]; do
      st=$(gh run view "$run" --repo "$REPO" --json status --jq .status 2>/dev/null)
      [ "$st" = "completed" ] && break
      sleep "$POLL_SECS"
    done
    [ "$st" = "completed" ] || { printf 'timeout'; return 0; }

    gh run view "$run" --repo "$REPO" --log >"$log" 2>/dev/null || : >"$log"
    if ! run_log_identifies_slot "$log" "$mode" "$slot"; then
      warn "slot $slot: run $run's completed log does not identify as MODE=$mode slot $slot -- refusing to read a verdict out of it."
      printf 'unfound'; return 0
    fi
    outcome=$(chain_outcome "$log")
    # A budget stop RELAUNCHES ITSELF. The slot is not done; wait for the next
    # link rather than judging this one.
    if [ "$outcome" = "budget" ]; then
      say "WAVE2 slot $slot: budget stop on run $run -- following the relaunch" >&2
      since=$(date -u -d "+1 second" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
      sleep "$POLL_SECS"; continue
    fi
    printf '%s' "$outcome"; return 0
  done
  printf 'timeout'; return 0
}

# The slots this invocation drives, as a space-separated list: WAVE2_ONLY_SLOTS
# when set, otherwise 0..SLOTS-1. Refuses a slot outside the table rather than
# dispatching a shard index the runner would read as out of range.
selected_slots() {
  local s
  if [ -z "$ONLY_SLOTS" ]; then
    seq 0 $((SLOTS - 1))
    return 0
  fi
  for s in ${ONLY_SLOTS//,/ }; do
    case "$s" in
      ''|*[!0-9]*) die "WAVE2_ONLY_SLOTS contains '$s', which is not a slot number." ;;
    esac
    [ "$s" -lt "$SLOTS" ] || die "WAVE2_ONLY_SLOTS names slot $s, but the shard table has only $SLOTS slots (0..$((SLOTS - 1)))."
    printf '%s\n' "$s"
  done
}

# ── PHASE: CENSUS ────────────────────────────────────────────────────────────
#
# 32 slots, report-only. #1950's scoped-apply prefilter does NOT apply here:
# it is gated on MODE === "apply-improve", so a census classifies every in-slot
# row and its `classified` is a whole-shard number — which is exactly what the
# I9 reference has to be.

phase_census() {
  preflight_lane
  local since; since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # THE STAGGER'S TABLE TAG. One per phase_census invocation, never reused
  # across a CLI run -- inflight_reset_state wipes any row a previous
  # invocation in this same $LOGDIR left behind, so a stale run id from a
  # prior session cannot be counted toward THIS fan-out's cap.
  local tag="census-$$"
  inflight_reset_state "$tag"
  say "WAVE2 CENSUS — shard table $SLOTS slots, driving [$(selected_slots | tr "\n" " ")], mode=census apply=false (report-only), stagger cap $MAX_INFLIGHT_CENSUS_SLOTS (own chains only, grace ${INFLIGHT_BUDGET_GRACE_SECS}s)"
  local s
  local selected; selected=$(selected_slots)
  # THE STAGGER: at most MAX_INFLIGHT_CENSUS_SLOTS of THIS FLEET'S OWN CHAINS
  # -- tracked in `$tag`'s per-slot table, never the shared lane's whole
  # queued/in_progress count -- in flight at once. Checked BEFORE every
  # dispatch, not only the first, so the cap holds across the whole fan-out
  # and not just at its start -- see the 2026-09-11 comment above
  # MAX_INFLIGHT_CENSUS_SLOTS and the 2026-09-12 comment above
  # inflight_state_dir for why a shared-lane count over-attributed foreign
  # runs (a snapshot cron, an ad-hoc dispatch) to this fleet's own cap.
  if [ "$DISPATCH" = "true" ]; then
    for s in $selected; do
      wait_for_inflight_room "$tag"
      dispatch census false improve "$s" "$tag" || true
    done
  else
    for s in $selected; do dispatch census false improve "$s" || true; done
  fi
  [ "$DISPATCH" = "true" ] || { say "WAVE2 dry-run: dispatched nothing."; return 0; }

  local held=0 ok=0
  for s in $selected; do
    local out; out=$(follow_slot census "$s" "$since" census)
    local log="$LOGDIR/census-slot-$s.log"
    if [ "$out" != "finished" ]; then
      warn "slot $s census outcome=$out — HELD"; held=$((held + 1)); continue
    fi
    local c; c=$(census_classified "$log") || { warn "slot $s: no 'rows classified' banner — HELD"; held=$((held+1)); continue; }
    local imp; imp=$(census_class "$log" IMPROVE) || imp="?"
    say "WAVE2 slot $s census: classified $c  IMPROVE $imp"
    ok=$((ok + 1))
  done
  say "WAVE2 CENSUS done: $ok slot(s) read, $held held."
  [ "$held" -eq 0 ]
}

# ── PHASE: COLLECT ───────────────────────────────────────────────────────────
#
# Download every slot's census artifact into one directory, which is what
# rebaseline-i9-reference.cjs --from consumes and what the apply gate reads its
# expected writable count from. The artifact is `rematch-census-slot-<N>-<runId>`
# and it already exists — the workflow uploads it on `always()` for every
# rematch-sold-comps run (backfill-runner.yml, "Upload the shard census").

phase_collect() {
  local dir="${1:-$LOGDIR/census-artifacts}"
  mkdir -p "$dir"
  say "WAVE2 COLLECT -> $dir"
  # Collect only the slots this invocation drives. A WAVE2_ONLY_SLOTS=0 run has
  # no artifact for slots 1..31 and never claimed to, so warning about all 31 of
  # them would bury the one line that matters.
  local s got=0
  for s in $(selected_slots); do
    # -p matches the artifact name prefix; the newest run wins.
    if gh run download --repo "$REPO" --dir "$dir" -p "rematch-census-slot-$s-*" 2>/dev/null; then
      got=$((got + 1))
    else
      warn "no census artifact for slot $s"
    fi
  done
  local n; n=$(find "$dir" -name 'census-slot-*.json' | wc -l | tr -d ' ')
  say "WAVE2 COLLECT: $got download(s), $n census-slot JSON file(s) in $dir"
  say "WAVE2 next:  node backend/scripts/rebaseline-i9-reference.cjs --from $dir"
  [ "$n" -gt 0 ]
}

# The expected writable count for a slot: its census's IMPROVE count, read from
# the collected artifact. THIS is the number the apply is gated against.
expected_writable() {
  local slot="$1"
  local f; f=$(find "$CENSUS_DIR" -name "census-slot-$slot.json" | head -1)
  [ -n "${f:-}" ] || return 1
  node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const n=Number(j?.counts?.IMPROVE);
    if(!Number.isFinite(n)){process.exit(1);}
    process.stdout.write(String(n));
  ' "$f"
}

# ── PHASE: APPLY ─────────────────────────────────────────────────────────────

# Judge ONE finished apply slot against its census. Returns 0 = PASS.
gate_apply_slot() {
  local slot="$1" log="$2" expected="$3" canary="${4:-false}"
  local w; w=$(apply_written "$log") || { warn "slot $slot: no 're-keyed' banner — HELD"; return 1; }
  local sk fl nr
  sk=$(apply_field "$log" skipped)       || sk="?"
  fl=$(apply_field "$log" failed)        || fl="?"
  nr=$(apply_field "$log" "not reached") || nr="?"
  apply_reconciled "$log" >/dev/null || { warn "slot $slot: intended/written reconciliation ABSENT or DRIFTED — HELD"; return 1; }
  say "WAVE2 slot $slot apply: written $w / skipped $sk / refused-or-failed $fl / not reached $nr  (reconciled; census writable $expected)"

  # THE SHARD'S OWN CANARY IS THE FIRST GATE, because it is the ATTRIBUTED one.
  # A regression here stops the fleet outright — the next shard is not censused
  # and not dispatched, and the diff goes to Drew.
  local cv; cv=$(canary_verdict "$log")
  case "$cv" in
    hold)      ;;
    regressed) warn "slot $slot CANARY REGRESSION — this shard is damage, not an improvement. STOP THE FLEET."; return 1 ;;
    *)         warn "slot $slot: NO canary verdict in the log — a shard with no canary did not pass one. HELD."; return 1 ;;
  esac

  # THE CANARY IS A CEILING, NOT A BAND. Slot 0 goes first precisely because
  # nothing has been proven yet, so the only claim it must satisfy is that it
  # did not write MORE than its census said was writable. An apply that
  # out-writes its own census is writing rows the census never classified.
  if [ "$canary" = "true" ]; then
    if [ "$w" -gt "$expected" ]; then
      warn "CANARY slot $slot wrote $w > census writable $expected — HOLD THE FLEET"; return 1
    fi
    say "WAVE2 CANARY slot $slot PASS ($w <= $expected)"
    return 0
  fi

  # VERDICT EQUALITY. |written - expected| must be within BAND_PCT of expected.
  # An expected of 0 admits only a written of 0: there is no percentage band
  # around zero, and a slot that writes into a class its census found empty is
  # the exact shape of a scope failure.
  if [ "$expected" -eq 0 ]; then
    [ "$w" -eq 0 ] || { warn "slot $slot wrote $w where its census found 0 writable — HELD"; return 1; }
    return 0
  fi
  local lo=$(( expected - expected * BAND_PCT / 100 ))
  local hi=$(( expected + expected * BAND_PCT / 100 ))
  if [ "$w" -lt "$lo" ] || [ "$w" -gt "$hi" ]; then
    warn "slot $slot wrote $w, outside ±${BAND_PCT}% of census writable $expected ($lo..$hi) — HELD"; return 1
  fi
  return 0
}

run_apply_slots() {
  local canary="$1"; shift
  local slots=("$@")
  preflight_lane
  local since; since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local s
  for s in "${slots[@]}"; do dispatch apply-improve true improve "$s" || true; done
  [ "$DISPATCH" = "true" ] || { say "WAVE2 dry-run: dispatched nothing."; return 0; }

  local failed=0
  for s in "${slots[@]}"; do
    local out; out=$(follow_slot apply "$s" "$since" apply-improve)
    local log="$LOGDIR/apply-slot-$s.log"
    case "$out" in
      startup-refused)
        warn "slot $s STARTUP REFUSED — the lane never began work; NOTHING was written and the slot is UNSTARTED. HOLD."
        failed=$((failed + 1)); continue ;;
      finished) ;;
      *)
        warn "slot $s outcome=$out — not a clean finish. HELD."
        failed=$((failed + 1)); continue ;;
    esac
    local exp; exp=$(expected_writable "$s") || { warn "slot $s: no census artifact — cannot gate. HELD."; failed=$((failed+1)); continue; }
    gate_apply_slot "$s" "$log" "$exp" "$canary" || failed=$((failed + 1))
  done
  [ "$failed" -eq 0 ]
}

phase_canary() {
  [ -n "$CENSUS_DIR" ] || die "WAVE2_CENSUS_DIR is unset — an apply with no census has no gate."
  say "WAVE2 CANARY — slot 0, mode=apply-improve scope=improve apply=true"
  run_apply_slots true 0
}

phase_apply() {
  [ -n "$CENSUS_DIR" ] || die "WAVE2_CENSUS_DIR is unset — an apply with no census has no gate."
  say "WAVE2 APPLY — slots 1..$((SLOTS - 1)) in waves of $WAVE_SIZE"
  local wave=() s
  for s in $(seq 1 $((SLOTS - 1))); do
    wave+=("$s")
    if [ "${#wave[@]}" -eq "$WAVE_SIZE" ]; then
      run_apply_slots false "${wave[@]}" || die "a slot in wave [${wave[*]}] was HELD — the fleet stops here."
      wave=()
    fi
  done
  if [ "${#wave[@]}" -gt 0 ]; then
    run_apply_slots false "${wave[@]}" || die "a slot in wave [${wave[*]}] was HELD — the fleet stops here."
  fi
  say "WAVE2 APPLY complete."
}

case "${1:-}" in
  census)  phase_census ;;
  collect) phase_collect "${2:-}" ;;
  canary)  phase_canary ;;
  apply)   phase_apply ;;
  *) die "usage: wave2-fleet.sh census|collect [dir]|canary|apply" ;;
esac
