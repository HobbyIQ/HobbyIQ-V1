import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_reddit_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-reddit-signals timer past due")
    run_for_all_players("reddit", get_reddit_signal, extra_log="every 2hr")
