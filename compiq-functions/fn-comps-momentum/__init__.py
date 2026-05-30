import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_comps_signal


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
    run_for_all_players(
        "compsMomentum", get_comps_signal, extra_log="nightly 02:00 UTC"
    )
