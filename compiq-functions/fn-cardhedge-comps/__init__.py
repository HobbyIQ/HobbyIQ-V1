import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_cardhedge_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-cardhedge-comps timer past due")
    # CF-CARDHEDGE-SIGNAL-RENAME (2026-05-25, design at 80e9971): signal-
    # type label is "compsMomentum" so the source function writes to
    # compiq-signals/{slug}/compsMomentum.json and the aggregator reads
    # the new key. Function file name (fn-cardhedge-comps) DEFERRED per
    # design — name still reflects the data source (CardHedge API).
    run_for_all_players(
        "compsMomentum", get_cardhedge_signal, extra_log="nightly 02:00 UTC"
    )
