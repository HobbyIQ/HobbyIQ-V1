import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_news_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-news-signals timer past due")
    run_for_all_players("news", get_news_signal, extra_log="every 3hr")
