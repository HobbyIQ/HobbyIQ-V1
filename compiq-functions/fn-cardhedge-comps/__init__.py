import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_cardhedge_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-cardhedge-comps timer past due")
    run_for_all_players(
        "cardhedge", get_cardhedge_signal, extra_log="nightly 02:00 UTC"
    )
