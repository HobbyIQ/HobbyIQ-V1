"""Signal aggregator.

Reads each per-player signal blob, blends them with weights, applies the
H8 card-show calendar overlay, and writes one aggregated.json per player.
This is the only file the MCP server reads.
"""

from __future__ import annotations

from datetime import datetime

from shared import load_signal, save_signal
from shared.show_calendar import get_show_calendar_signal
from shared.pack_calendar import get_pack_release_signal
from shared.career_arc import career_arc_signal
from shared.playoff_calendar import get_playoff_signal

WEIGHTS = {
    "cardhedge": 0.20,
    "ebay": 0.20,
    "reddit": 0.15,
    "trends": 0.15,
    "odds": 0.15,
    "stats": 0.10,
    "news": 0.05,
}

# YouTube is folded in alongside Reddit/Trends as a tertiary social signal —
# averaged into the social weight rather than given its own slice, so the
# core seven-source weight table stays balanced.
SOCIAL_BLEND_KEYS = ("reddit", "trends", "youtube")


def aggregate_signals(player_name: str) -> dict:
    signals = {k: load_signal(player_name, k) for k in WEIGHTS}
    # M10 — YouTube loaded alongside but blended into the social slice so
    # weights still sum to 1.0.
    youtube = load_signal(player_name, "youtube") or {}
    yt_mult = float(youtube.get("multiplier", 1.0))

    social_avg = (
        float(signals["reddit"].get("multiplier", 1.0))
        + float(signals["trends"].get("multiplier", 1.0))
        + yt_mult
    ) / 3.0

    combined = 0.0
    for k, w in WEIGHTS.items():
        if k in ("reddit", "trends"):
            combined += social_avg * w
        else:
            combined += float(signals[k].get("multiplier", 1.0)) * w

    flags: list[str] = []
    if signals["stats"].get("direction") == "cold":
        flags.append("player_slump")
    if signals["news"].get("sentiment") == "negative":
        flags.append("negative_news")
    if signals["trends"].get("trend") == "spiking":
        flags.append("search_spike")
    if signals["reddit"].get("signal") == "spiking":
        flags.append("reddit_buzz")
    if signals["ebay"].get("signal") == "hot":
        flags.append("ebay_demand_high")
    if signals["odds"].get("signal") == "award_contender":
        flags.append("award_contender")
    if signals["stats"].get("milestone"):
        flags.append(f"milestone: {signals['stats']['milestone']}")
    if signals["news"].get("keyword_flags", {}).get("injury"):
        flags.append("injury_risk")
    ch = signals.get("cardhedge", {})
    if ch.get("signal") == "rising":
        flags.append("cardhedge_comps_rising")
    elif ch.get("signal") == "falling":
        flags.append("cardhedge_comps_falling")
    elif ch.get("signal") in {"no_data", "no_match", "no_id"}:
        flags.append("cardhedge_no_data")

    # H5 — surface BIN trend at the aggregate level so the MCP can include
    # it in the pricing prompt without a second blob read.
    ebay_sig = signals.get("ebay", {})
    bin_signal = ebay_sig.get("bin_signal")
    bin_drop_pct = ebay_sig.get("bin_drop_pct")
    if bin_signal in ("sellers_dropping", "sellers_dropping_fast"):
        flags.append(f"bin_dropping: {bin_signal} ({bin_drop_pct}%)")

    # H7 — sell-through.
    str_signal = ebay_sig.get("str_signal")
    sell_through_rate = ebay_sig.get("sell_through_rate")
    if str_signal == "weak_demand":
        flags.append(f"low_sell_through: {sell_through_rate}")

    # H8 — card-show calendar overlay (multiplicative on top of weighted blend).
    show = get_show_calendar_signal()
    show_mult = float(show.get("show_multiplier", 1.0))
    if show_mult != 1.0:
        combined *= show_mult
        if show["show_phase"] == "pre_show":
            flags.append(
                f"pre_show: {show['show_name']} in {show['days_to_show']} days"
            )
        elif show["show_phase"] == "during":
            flags.append(f"show_active: {show['show_name']}")
        elif show["show_phase"] == "post_show":
            flags.append(f"post_show_softening: {show['show_name']}")

    # M6 — pack release calendar overlay.
    pack = get_pack_release_signal()
    pack_mult = float(pack.get("release_multiplier", 1.0))
    if pack_mult != 1.0:
        combined *= pack_mult
        flags.append(
            f"{pack['release_phase']}: {pack['release_name']} ({pack['days_to_release']}d)"
        )

    # M9 — playoff roster overlay.
    playoff = get_playoff_signal(player_name)
    playoff_mult = float(playoff.get("multiplier", 1.0))
    if playoff_mult != 1.0:
        combined *= playoff_mult
        flags.append(playoff["signal"])

    # M4 + M5 — career arc (HOF ballot countdown / contract year).
    arc = career_arc_signal(player_name)
    arc_mult = float(arc.get("multiplier", 1.0))
    if arc_mult != 1.0:
        combined *= arc_mult
        flags.extend(arc.get("signal_flags", []))

    # M10 — YouTube hype flag (already blended into multiplier above).
    if youtube.get("signal") in {"spiking", "rising"}:
        flags.append(f"youtube_{youtube['signal']}")
    elif youtube.get("signal") == "fading":
        flags.append("youtube_fading")

    combined = round(max(0.70, min(1.50, combined)), 3)

    result = {
        "player": player_name,
        "final_multiplier": combined,
        "predicted_direction": (
            "rising"
            if combined > 1.08
            else "falling"
            if combined < 0.93
            else "stable"
        ),
        "signal_flags": flags,
        "components": {
            **{k: signals[k].get("multiplier", 1.0) for k in WEIGHTS},
            "youtube": yt_mult,
        },
        "component_signals": {
            **{
                k: signals[k].get(
                    "signal",
                    signals[k].get("trend", signals[k].get("sentiment", "unknown")),
                )
                for k in WEIGHTS
            },
            "youtube": youtube.get("signal", "unknown"),
        },
        # H5 / H7 pass-through for MCP prompt market-structure block
        "bin_signal": bin_signal,
        "bin_drop_pct": bin_drop_pct,
        "sell_through_rate": sell_through_rate,
        "str_signal": str_signal,
        # H8 pass-through
        "show_phase": show.get("show_phase"),
        "show_name": show.get("show_name"),
        "days_to_show": show.get("days_to_show"),
        "show_multiplier": show_mult,
        # M6 pack release
        "release_phase": pack.get("release_phase"),
        "release_name": pack.get("release_name"),
        "days_to_release": pack.get("days_to_release"),
        "release_multiplier": pack_mult,
        # M9 playoff
        "playoff_signal": playoff.get("signal"),
        "playoff_window": playoff.get("window"),
        "playoff_multiplier": playoff_mult,
        # M4/M5 career arc
        "career_arc_signal": arc.get("signal_flags", []),
        "career_arc_multiplier": arc_mult,
        "updated_at": datetime.utcnow().isoformat(),
    }

    save_signal(player_name, "aggregated", result)
    return result
