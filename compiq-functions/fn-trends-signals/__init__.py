import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_trends_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-trends-signals timer past due")
    run_for_all_players("trends", get_trends_signal, extra_log="every 6hr")
