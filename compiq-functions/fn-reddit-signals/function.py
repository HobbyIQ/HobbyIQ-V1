"""Reddit signal collector.

Tracks mention velocity across collector subreddits. A spike in 24hr mentions
vs the 7-day daily average is a leading indicator of card-price movement.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

import praw

SUBREDDITS = ["baseballcards", "sportscards", "baseball"]


def get_reddit_signal(player_name: str) -> dict:
    try:
        reddit = praw.Reddit(
            client_id=os.environ["REDDIT_CLIENT_ID"],
            client_secret=os.environ["REDDIT_CLIENT_SECRET"],
            user_agent="CompIQ/1.0",
        )
    except Exception:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "signal": "auth_failed",
            "updated_at": datetime.utcnow().isoformat(),
        }

    now = datetime.utcnow()
    cutoff_24h = (now - timedelta(hours=24)).timestamp()
    cutoff_7d = (now - timedelta(days=7)).timestamp()
    mentions_24h, mentions_7d, upvote_score = 0, 0, 0
    top_posts: list[dict] = []

    for sub_name in SUBREDDITS:
        try:
            for post in reddit.subreddit(sub_name).search(
                player_name, sort="new", time_filter="week", limit=100
            ):
                if post.created_utc > cutoff_7d:
                    mentions_7d += 1
                    upvote_score += int(post.score or 0)
                    if post.created_utc > cutoff_24h:
                        mentions_24h += 1
                        top_posts.append(
                            {"title": post.title, "score": int(post.score or 0)}
                        )
        except Exception:
            # one bad subreddit shouldn't kill the signal
            continue

    weekly_avg = mentions_7d / 7
    velocity_ratio = mentions_24h / weekly_avg if weekly_avg > 0 else 1.0
    multiplier = round(
        max(0.90, min(1.20, 1.0 + (velocity_ratio - 1.0) * 0.15)), 3
    )

    return {
        "player": player_name,
        "mentions_24h": mentions_24h,
        "mentions_7d": mentions_7d,
        "velocity_ratio": round(velocity_ratio, 2),
        "upvote_score": upvote_score,
        "multiplier": multiplier,
        "signal": "spiking"
        if velocity_ratio > 2.0
        else "rising"
        if velocity_ratio > 1.2
        else "stable",
        "top_posts": sorted(top_posts, key=lambda x: x["score"], reverse=True)[:3],
        "updated_at": datetime.utcnow().isoformat(),
    }
