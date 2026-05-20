"""SearchIQ — natural-language intent classifier for the unified search bar.

POST /api/search-intent
    Body: {"query": "what's a 2011 topps update mike trout #us175 worth"}
    Returns:
    {
      "ok": true,
      "query": "<echoed>",
      "intents": ["price", "stats"],
      "entities": {
        "playerName": "Mike Trout",
        "year": 2011,
        "set": "Topps Update",
        "cardNumber": "US175",
        "variant": null,
        "grade": null,
        "is_grading_question": false,
        "is_owned_card": false
      },
      "confidence": 0.92,
      "model": "gpt-4o"
    }

Intents (any subset, in priority order):
  "price"       — user wants a predicted price / comp
  "grade"       — user is asking about grading (PSA 10 odds, worth grading?)
  "stats"       — user is asking about player performance / season stats
  "inventory"   — user is asking about a card they OWN ("my mookie", "in my collection")
  "search"      — generic card lookup with no other intent

The orchestrator on the iOS side fans out only to the IQs that match the
returned intents, so over-firing this means wasted spend.

Soft-fails on OpenAI errors: returns intent=["search"] with no entities so
the iOS layer falls through to plain card-search. NEVER raises.
"""

from __future__ import annotations

import json
import logging
import os

import azure.functions as func
from openai import AzureOpenAI, OpenAI

_VALID_INTENTS = {"price", "grade", "stats", "inventory", "search"}

_SYSTEM_PROMPT = """You are SearchIQ, the intent classifier for a baseball
card collector app. The user types a natural-language query and you must
extract structured intent + entities.

Return ONLY valid JSON with this exact shape:
{
  "intents": ["price" | "grade" | "stats" | "inventory" | "search", ...],
  "entities": {
    "playerName": string | null,
    "year": integer | null,
    "set": string | null,
    "cardNumber": string | null,
    "variant": string | null,
    "grade": string | null,
    "is_grading_question": boolean,
    "is_owned_card": boolean
  },
  "confidence": number between 0 and 1
}

Intent rules:
- "price"     : asking value / worth / sell-for / predicted price / comps
- "grade"     : asking PSA/BGS odds, "should I grade", grade value bump
- "stats"     : asking about player performance, MVP odds, recent games
- "inventory" : user references their own collection ("my", "I own", "in my collection")
- "search"    : generic lookup with no other clear intent — include alone if nothing else fits

Multiple intents are allowed. Order them by priority (most-relevant first).

Entity rules:
- year is a 4-digit integer (1980–2099) only if explicitly present
- cardNumber: keep formatting like "US175", "#42", "RC-1" — strip leading "#"
- grade examples: "PSA 10", "BGS 9.5", "raw"
- is_grading_question: true ONLY if the user is asking whether to grade a card
- is_owned_card: true if the query implies the user already owns it
- playerName: full name, properly capitalized; null if not identifiable
- set: full set name like "Topps Update", "Bowman Chrome Draft", "Topps Chrome"

NEVER return prose, NEVER wrap in markdown, NEVER add commentary.
"""


def _client() -> OpenAI | AzureOpenAI:
    """Build an OpenAI client. Prefers Azure OpenAI when configured."""
    az_endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
    az_key = os.environ.get("AZURE_OPENAI_API_KEY")
    az_api = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-08-01-preview")
    if az_endpoint and az_key:
        return AzureOpenAI(
            azure_endpoint=az_endpoint, api_key=az_key, api_version=az_api
        )
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def _model_name() -> str:
    # Azure deployments reuse the deployment name as the "model" parameter.
    return (
        os.environ.get("AZURE_OPENAI_DEPLOYMENT")
        or os.environ.get("OPENAI_MODEL")
        or "gpt-4o"
    )


def _fallback(query: str, reason: str) -> dict:
    return {
        "ok": False,
        "query": query,
        "intents": ["search"],
        "entities": {
            "playerName": None,
            "year": None,
            "set": None,
            "cardNumber": None,
            "variant": None,
            "grade": None,
            "is_grading_question": False,
            "is_owned_card": False,
        },
        "confidence": 0.0,
        "reason": reason,
    }


def _coerce_year(v) -> int | None:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    if 1900 <= n <= 2099:
        return n
    return None


def _coerce_str(v) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    return s or None


def _coerce_card_number(v) -> str | None:
    s = _coerce_str(v)
    if not s:
        return None
    return s.lstrip("#").strip() or None


def _normalize_intents(raw) -> list[str]:
    if not isinstance(raw, list):
        return ["search"]
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            v = item.strip().lower()
            if v in _VALID_INTENTS and v not in out:
                out.append(v)
    return out or ["search"]


def _normalize_entities(raw) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    return {
        "playerName": _coerce_str(raw.get("playerName")),
        "year": _coerce_year(raw.get("year")),
        "set": _coerce_str(raw.get("set")),
        "cardNumber": _coerce_card_number(raw.get("cardNumber")),
        "variant": _coerce_str(raw.get("variant")),
        "grade": _coerce_str(raw.get("grade")),
        "is_grading_question": bool(raw.get("is_grading_question", False)),
        "is_owned_card": bool(raw.get("is_owned_card", False)),
    }


def classify(query: str) -> dict:
    q = (query or "").strip()
    if not q:
        return _fallback("", "empty_query")
    if len(q) > 500:
        q = q[:500]

    try:
        client = _client()
    except Exception as e:  # noqa: BLE001
        logging.warning("[search-intent] client init failed: %s", e)
        return _fallback(q, f"client_init: {e}")

    try:
        resp = client.chat.completions.create(
            model=_model_name(),
            max_tokens=300,
            temperature=0.0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": q},
            ],
        )
        content = resp.choices[0].message.content or "{}"
        parsed = json.loads(content)
    except Exception as e:  # noqa: BLE001
        logging.warning("[search-intent] openai failed: %s", e)
        return _fallback(q, f"openai_error: {e}")

    intents = _normalize_intents(parsed.get("intents"))
    entities = _normalize_entities(parsed.get("entities"))
    try:
        confidence = float(parsed.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    # Light heuristic backup: if entities.is_owned_card is true, ensure
    # "inventory" is present. This covers "my mookie betts rookie" cases
    # where the model picks "price" but forgets to add "inventory".
    if entities["is_owned_card"] and "inventory" not in intents:
        intents = ["inventory", *intents]
    if entities["is_grading_question"] and "grade" not in intents:
        intents = ["grade", *intents]

    return {
        "ok": True,
        "query": q,
        "intents": intents,
        "entities": entities,
        "confidence": round(confidence, 3),
        "model": _model_name(),
    }


def _json(payload: dict, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload), mimetype="application/json", status_code=status
    )


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except Exception:
        return _json({"error": "Body must be JSON"}, 400)

    query = body.get("query") if isinstance(body, dict) else None
    if not isinstance(query, str) or not query.strip():
        return _json({"error": "Missing 'query' string"}, 400)

    return _json(classify(query))
