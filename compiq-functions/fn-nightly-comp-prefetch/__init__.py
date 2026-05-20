import logging

import azure.functions as func

from .function import run_prefetch


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-nightly-comp-prefetch timer past due")
    result = run_prefetch()
    logging.info("nightly comp prefetch summary: %s", result)
