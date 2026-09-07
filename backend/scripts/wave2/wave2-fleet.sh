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
normalize() {
  sed -e 's/\x1b\[[0-9;]*m//g' \
      -e 's/^[^\t]*\t[^\t]*\t//' \
      -e 's/^[[:space:]]*[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T[0-9:.]*Z[[:space:]]\{0,1\}//' "$1"
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

# The newest run of this workflow for `slot`, on this ref. Used to pick the run
# a dispatch created and to follow a self-relaunch to the next link.
latest_run_for_slot() {
  local slot="$1" since="$2"
  gh run list --repo "$REPO" --workflow=backfill-runner.yml --limit 60 \
    --json databaseId,createdAt,status,conclusion \
    --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | reverse | .[0].databaseId" 2>/dev/null
}

# Follow ONE SLOT to the end of its chain. Prints the final run's log to
# $LOGDIR/<phase>-slot-<N>.log and echoes the chain outcome word.
follow_slot() {
  local phase="$1" slot="$2" since="$3"
  local deadline=$(( $(date +%s) + MAX_CHAIN_MINUTES * 60 ))
  local log="$LOGDIR/$phase-slot-$slot.log"
  local run="" outcome=""

  while [ "$(date +%s)" -lt "$deadline" ]; do
    run=$(latest_run_for_slot "$slot" "$since")
    if [ -z "${run:-}" ] || [ "$run" = "null" ]; then sleep "$POLL_SECS"; continue; fi
    local st
    st=$(gh run view "$run" --repo "$REPO" --json status --jq .status 2>/dev/null)
    if [ "$st" != "completed" ]; then sleep "$POLL_SECS"; continue; fi

    gh run view "$run" --repo "$REPO" --log >"$log" 2>/dev/null || : >"$log"
    outcome=$(chain_outcome "$log")
    # A budget stop RELAUNCHES ITSELF. The slot is not done; wait for the next
    # link rather than judging this one.
    if [ "$outcome" = "budget" ]; then
      say "WAVE2 slot $slot: budget stop on run $run — following the relaunch"
      since=$(date -u -d "+1 second" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
      sleep "$POLL_SECS"; continue
    fi
    printf '%s' "$outcome"; return 0
  done
  printf 'timeout'; return 0
}

# ── PHASE: CENSUS ────────────────────────────────────────────────────────────
#
# 32 slots, report-only. #1950's scoped-apply prefilter does NOT apply here:
# it is gated on MODE === "apply-improve", so a census classifies every in-slot
# row and its `classified` is a whole-shard number — which is exactly what the
# I9 reference has to be.

phase_census() {
  local since; since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  say "WAVE2 CENSUS — $SLOTS slots, mode=census apply=false (report-only)"
  local s
  for s in $(seq 0 $((SLOTS - 1))); do dispatch census false improve "$s" || true; done
  [ "$DISPATCH" = "true" ] || { say "WAVE2 dry-run: dispatched nothing."; return 0; }

  local held=0 ok=0
  for s in $(seq 0 $((SLOTS - 1))); do
    local out; out=$(follow_slot census "$s" "$since")
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
  local s got=0
  for s in $(seq 0 $((SLOTS - 1))); do
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
  local since; since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local s
  for s in "${slots[@]}"; do dispatch apply-improve true improve "$s" || true; done
  [ "$DISPATCH" = "true" ] || { say "WAVE2 dry-run: dispatched nothing."; return 0; }

  local failed=0
  for s in "${slots[@]}"; do
    local out; out=$(follow_slot apply "$s" "$since")
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
