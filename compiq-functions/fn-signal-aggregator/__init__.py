import logging

import azure.functions as func

from shared import tracked_players

from .function import aggregate_signals


def main(timer: func.TimerRequest) -> None:
    if timer.past_due:
        logging.warning("fn-signal-aggregator timer past due")
    players = tracked_players()
    logging.info("[aggregator] aggregating %d player(s)", len(players))
    for name in players:
        try:
            result = aggregate_signals(name)
            logging.info(
                "[aggregator] %s -> %.3fx (%s)",
                name,
                result["final_multiplier"],
                result["predicted_direction"],
            )
        except Exception as exc:  # noqa: BLE001
            logging.exception("[aggregator] %s failed: %s", name, exc)
