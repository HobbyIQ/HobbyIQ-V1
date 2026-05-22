import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_ebay_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-ebay-signals timer past due")
    run_for_all_players("ebay", get_ebay_signal, extra_log="every 4hr")
