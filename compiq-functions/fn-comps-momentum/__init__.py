import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_comps_signal, process_player_set_queue


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-comps-momentum timer past due")
    # CF-COMPSMOMENTUM-GREENFIELD-CARDSIGHT (2026-05-30) -- greenfield
    # successor to the deleted fn-cardhedge-comps. Schedule preserves the
    # 02:00 UTC nightly cadence so the signal aggregator at 02:15 UTC
    # reads fresh `compsMomentum.json` blobs. Signal-payload contract
    # preserved verbatim (multiplier, signal, comp_count, median_price,
    # recent_avg, prior_avg) per CF-CARDHEDGE-SIGNAL-RENAME (80e9971).
    # Vendor-neutral directory name per D-disposition (a) lock from
    # CF-CARDHEDGE-HARD-CUTOVER (10ad39d).
    #
    # CF-PLAYER-IN-SET-HISTORY (2026-06-09) -- left existing per-player
    # tick UNTOUCHED. The aggregator at 02:15 UTC still expects the
    # legacy compsMomentum.json blobs. The new per-(player, set)
    # extension runs AFTER as a second pass; failures in either pass
    # do not affect the other.
    try:
        run_for_all_players(
            "compsMomentum", get_comps_signal, extra_log="nightly 02:00 UTC"
        )
    except Exception:  # noqa: BLE001
        logging.exception("fn-comps-momentum per-player pass failed (continuing)")

    # CF-PLAYER-IN-SET-HISTORY (2026-06-09) -- drain the usage-seeded
    # queue. Backend writes (player, set, year) tuples to
    # compiq-signals/_seed/player-set-queue.json on every /price-by-id
    # call; this pass walks the oldest-first window (capped at
    # MAX_PER_NIGHT), aggregates sales across the player's cards in
    # that set, writes a fresh snapshot per (player, set), and APPENDS
    # one history entry per (player, set) per night. The history is
    # the moat -- accrual builds the directional record over time.
    try:
        process_player_set_queue()
    except Exception:  # noqa: BLE001
        logging.exception("fn-comps-momentum player-in-set pass failed (continuing)")
