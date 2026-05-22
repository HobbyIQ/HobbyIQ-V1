import logging

import azure.functions as func

from shared import run_for_all_players

from .function import get_youtube_signal


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-youtube-signals timer past due")
    run_for_all_players("youtube", get_youtube_signal, extra_log="every 6hr")
