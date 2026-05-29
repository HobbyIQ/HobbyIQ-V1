"""Per-card comp prefetch -- STUBBED per CF-CARDHEDGE-HARD-CUTOVER.

History:
- Original: walked Cosmos `inventory` container nightly, ran Card Hedge
  identify/search + recent sales for every card, and persisted comps to
  `compiq-signals/{player-slug}/{card-id}/comps.json`. Also refreshed the
  90-day price floor in Cosmos via `update_floor_from_ebay` (CardHedge-
  primary).
- CF-CARDHEDGE-HARD-CUTOVER (2026-05-30): CardHedge subscription cancelled.
  This function is stubbed to a no-op. Timer trigger and Azure Function
  scaffolding are preserved so the future greenfield Cardsight Function
  (former Sub-2b) can replace the body without re-provisioning the
  Function App resource, App Insights binding, or schedule.

Future Cardsight Function should:
  1. Walk inventory container (same Cosmos source)
  2. Resolve canonical Cardsight cardId per inventory card (D9 lock from
     CF-FN-COMPS-MIGRATION design: exact-port the prior scoring algorithm
     to Cardsight catalog hit shape with parallels[] handling)
  3. Fetch pricing via shared/cardsight.py:get_pricing (preserved at
     1fa9124)
  4. Persist comps + refresh cosmos_floor via Cardsight-backed equivalent
"""

from __future__ import annotations

import logging
from typing import Any


def run_prefetch() -> dict[str, Any]:
    """No-op until greenfield Cardsight Function replaces this body.

    Returns the same shape the prior implementation returned so the
    Azure entry point (__init__.py) and any test harness can rely on
    the contract.
    """
    logging.info(
        "fn-nightly-comp-prefetch: stubbed (CF-CARDHEDGE-HARD-CUTOVER); "
        "no-op pending Cardsight replacement"
    )
    return {"processed": 0, "errors": 0, "stubbed": True}
