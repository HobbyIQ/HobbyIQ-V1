import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_comps_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-cardhedge-comps timer past due")
    # CF-CARDHEDGE-SIGNAL-RENAME (2026-05-25, design at 80e9971): signal-
    # type label is "compsMomentum" so the source function writes to
    # compiq-signals/{slug}/compsMomentum.json and the aggregator reads
    # the new key.
    # CF-FN-COMPS-MIGRATION Sub-2a (2026-05-30): underlying data source
    # migrated from CardHedge to Cardsight; signal-payload contract
    # preserved verbatim (multiplier, signal, comp_count, median_price,
    # recent_avg, prior_avg). Function directory name (fn-cardhedge-comps)
    # deferred per CF-CARDHEDGE-NAMING-CLEANUP -- preserves the schedule
    # identity during cutover.
    run_for_all_players(
        "compsMomentum", get_comps_signal, extra_log="nightly 02:00 UTC"
    )
