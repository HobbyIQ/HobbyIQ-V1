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
  if   printf '%s' "$n" | grep -aq 'rematch-sold-comps: STARTUP REFUSED'; then printf 'startup-refused'
  elif [ ! -s "$f" ];                                                     then printf 'empty-log'
  elif printf '%s' "$n" | grep -aq 'rematch-sold-comps: STARTUP ok' \
       && ! printf '%s' "$n" | grep -aqE '^rematch-sold-comps  MODE=';    then printf 'died-in-startup'
  elif printf '%s' "$n" | grep -aqE 'stopped at the .*budget';            then printf 'budget'
  elif printf '%s' "$n" | grep -aqE 'finishLane: exiting code 0( |$)';    then printf 'finished'
  elif printf '%s' "$n" | grep -aqE 'finishLane: exiting code [0-9]+';    then printf 'verdict'
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
  if   printf '%s' "$n" | grep -aqE 'canaries REGRESSED';                     then printf 'regressed'
  elif printf '%s' "$n" | grep -aqE 'canaries hold -- the shard may stand';   then printf 'hold'
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

dispatch() {
  local mode="$1" apply="$2" scope="$3" slot="$4"
  local cmd=(gh workflow run backfill-runner.yml --repo "$REPO" --ref "$REF"
             -f script=rematch-sold-comps
             -f mode="$mode" -f apply="$apply" -f scope="$scope"
             -f slot="$slot" -f slots="$SLOTS" -f concurrency="$CONCURRENCY")
  if [ "$DISPATCH" != "true" ]; then
    say "WAVE2 dry-run: ${cmd[*]}"
    return 0
  fi
  "${cmd[@]}" >/dev/null || { warn "dispatch failed for slot $slot"; return 1; }
  say "WAVE2 dispatched slot $slot ($mode apply=$apply scope=$scope)"
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
IDENTIFY_TIMEOUT_MINUTES="${WAVE2_IDENTIFY_TIMEOUT_MINUTES:-15}"

# Does THIS log belong to THIS dispatch? Takes a log file, the mode and the
# slot. Returns 0 only when all three identity facts are present.
#
# THE SLOT MATCH CARRIES THE `/`. The banner spells it `slot 0/32`, and matching
# a bare `slot 1` would also match `slot 13/32` -- an off-by-a-digit that would
# reintroduce the very bug this function exists to kill. `SLOT: N` and `slot=N`
# are accepted as alternates because the workflow echoes the input that way in
# its env block, but the lane banner is primary: it is the only spelling that
# also proves MODE.
run_log_identifies_slot() {
  local log="$1" mode="$2" slot="$3" n
  [ -s "$log" ] || return 1
  n=$(normalize "$log")
  # 1. THE SCRIPT. The workflow's own confirmation line, printed by every run
  #    before it runs anything. This is the line that unmasked the park lane.
  printf '%s' "$n" | grep -aq 'Script confirmed: backend/scripts/rematch-sold-comps\.cjs' || return 1
  # 2 + 3. MODE AND SLOT, from the one banner that states both at once.
  printf '%s' "$n" | grep -aqE "^rematch-sold-comps  MODE=${mode}  .*[[:space:]]slot ${slot}/[0-9]+" && return 0
  # The lane banner is absent on a run that died BEFORE printing one -- and a
  # startup refusal is a real outcome for this slot that must stay readable. So
  # fall back to the workflow's echoed inputs, which exist from the first step,
  # but only BOTH together and only alongside the script line proven above.
  printf '%s' "$n" | grep -aqE "^(SLOT: ${slot}|slot=${slot})([^0-9]|$)" || return 1
  printf '%s' "$n" | grep -aqE "(MODE: ${mode}|mode=${mode})([^-a-z]|$)" || return 1
  return 0
}

# Find the run THIS dispatch created for THIS slot by reading candidates' logs
# until one identifies itself. Prints the run id, or prints nothing and returns
# 1 after IDENTIFY_TIMEOUT_MINUTES.
#
# Candidates are every backfill-runner run created at or after `since`, OLDEST
# FIRST -- oldest first because the fleet dispatches 32 slots in a loop and the
# run we want is usually behind newer ones by the time anything starts. Rejected
# ids are remembered, so a stranger's log is downloaded once rather than once
# per poll.
find_run_for_slot() {
  local mode="$1" slot="$2" since="$3"
  local deadline=$(( $(date +%s) + IDENTIFY_TIMEOUT_MINUTES * 60 ))
  local probe="$LOGDIR/.probe-$mode-$slot.log"
  local rejected=" " ids id st

  while [ "$(date +%s)" -lt "$deadline" ]; do
    ids=$(gh run list --repo "$REPO" --workflow=backfill-runner.yml --limit 100 \
            --json databaseId,createdAt,status \
            --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | .[].databaseId" 2>/dev/null)
    for id in ${ids:-}; do
      case "$rejected" in *" $id "*) continue ;; esac
      # A QUEUED run has no log yet. It is not rejected; it is not ready.
      st=$(gh run view "$id" --repo "$REPO" --json status --jq .status 2>/dev/null)
      [ "$st" = "queued" ] && continue
      gh run view "$id" --repo "$REPO" --log >"$probe" 2>/dev/null || : >"$probe"
      if run_log_identifies_slot "$probe" "$mode" "$slot"; then
        rm -f "$probe"
        printf '%s' "$id"; return 0
      fi
      # An IN-PROGRESS run may not have printed its banner yet, so it stays a
      # candidate. Only a COMPLETED run that never identified itself is somebody
      # else's for good.
      [ "$st" = "completed" ] && rejected="$rejected$id "
    done
    sleep "$POLL_SECS"
  done
  rm -f "$probe"
  return 1
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
  say "WAVE2 CENSUS — shard table $SLOTS slots, driving [$(selected_slots | tr "\n" " ")], mode=census apply=false (report-only)"
  local s
  local selected; selected=$(selected_slots)
  for s in $selected; do dispatch census false improve "$s" || true; done
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
