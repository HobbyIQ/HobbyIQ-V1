"""News sentiment signal collector.

Fetches headlines from Google News RSS and NewsAPI, scores each with OpenAI
for card-value impact, then applies instant keyword flags for high-impact
events (injury, suspension, awards, milestones, trades).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta

import feedparser
import requests
from openai import OpenAI

KEYWORD_FLAGS = {
    "injury": ["injured", "IL", "disabled list", "surgery", "torn", "fracture"],
    "suspension": ["suspended", "banned", "PED", "investigation", "DUI"],
    "retirement": ["retired", "retiring", "career over", "hanging up"],
    "award": [
        "MVP",
        "Cy Young",
        "Hall of Fame",
        "Gold Glove",
        "Silver Slugger",
    ],
    "milestone": [
        "record",
        "milestone",
        "500th",
        "3000th",
        "no-hitter",
        "perfect game",
    ],
    "trade": ["traded", "acquired", "signed", "free agent", "extension"],
}


def _openai_client() -> OpenAI:
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def fetch_headlines(player_name: str) -> list[str]:
    headlines: list[str] = []

    rss_url = (
        f"https://news.google.com/rss/search"
        f"?q={player_name.replace(' ', '+')}+baseball&hl=en-US&gl=US&ceid=US:en"
    )
    try:
        for entry in feedparser.parse(rss_url).entries[:20]:
            title = getattr(entry, "title", None)
            if title:
                headlines.append(title)
    except Exception:
        pass

    api_key = os.environ.get("NEWS_API_KEY", "")
    if api_key:
        try:
            resp = requests.get(
                "https://newsapi.org/v2/everything",
                params={
                    "q": f"{player_name} baseball",
                    "from": (datetime.utcnow() - timedelta(days=7)).strftime(
                        "%Y-%m-%d"
                    ),
                    "sortBy": "publishedAt",
                    "pageSize": 20,
                    "apiKey": api_key,
                },
                timeout=15,
            )
            for article in resp.json().get("articles", []) or []:
                title = article.get("title")
                if title:
                    headlines.append(title)
        except Exception:
            pass

    return list(dict.fromkeys(headlines))  # dedupe, preserve order


def score_headline(client: OpenAI, headline: str, player_name: str) -> float:
    try:
        resp = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=80,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"You are a baseball card market analyst. Score this "
                        f"headline for its likely impact on {player_name}'s card "
                        f'value. Return ONLY valid JSON: {{"score": X, "reason": "string"}} '
                        f"Score: -1.0 (very negative for card value) to 1.0 (very positive). "
                        f"Positive: MVP, record, HOF, World Series, milestone, comeback. "
                        f"Negative: injury, suspension, slump, retirement, scandal, weak team trade. "
                        f'Headline: "{headline}"'
                    ),
                }
            ],
        )
        content = resp.choices[0].message.content or "{}"
        return float(json.loads(content).get("score", 0.0))
    except Exception:
        return 0.0


def detect_flags(headlines: list[str]) -> dict:
    text = " ".join(headlines).lower()
    return {
        k: any(kw.lower() in text for kw in kws)
        for k, kws in KEYWORD_FLAGS.items()
    }


def get_news_signal(player_name: str) -> dict:
    headlines = fetch_headlines(player_name)
    if not headlines:
        return {
            "player": player_name,
            "multiplier": 1.0,
            "sentiment": "no_data",
            "updated_at": datetime.utcnow().isoformat(),
        }

    try:
        client = _openai_client()
    except Exception:
        client = None

    scores: list[float] = []
    if client is not None:
        for h in headlines[:10]:
            scores.append(score_headline(client, h, player_name))

    avg_score = sum(scores) / len(scores) if scores else 0.0
    multiplier = round(max(0.80, min(1.20, 1.0 + (avg_score * 0.20))), 3)

    flags = detect_flags(headlines)
    if flags.get("injury") or flags.get("suspension"):
        multiplier = min(multiplier, 0.85)
    if flags.get("award") or flags.get("milestone"):
        multiplier = max(multiplier, 1.15)

    return {
        "player": player_name,
        "headline_count": len(headlines),
        "avg_sentiment_score": round(avg_score, 3),
        "multiplier": multiplier,
        "sentiment": "positive"
        if avg_score > 0.2
        else "negative"
        if avg_score < -0.2
        else "neutral",
        "keyword_flags": flags,
        "top_headline": headlines[0] if headlines else None,
        "updated_at": datetime.utcnow().isoformat(),
    }
