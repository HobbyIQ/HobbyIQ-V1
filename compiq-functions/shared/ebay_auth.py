"""Shared eBay OAuth helper used by fn-ebay-signals and fn-price-floor."""

from __future__ import annotations

import os

import requests


def get_ebay_token() -> str:
    """Client-credentials OAuth token for the eBay Browse API."""
    resp = requests.post(
        "https://api.ebay.com/identity/v1/oauth2/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        auth=(os.environ["EBAY_APP_ID"], os.environ["EBAY_CERT_ID"]),
        data={
            "grant_type": "client_credentials",
            "scope": "https://api.ebay.com/oauth/api_scope",
        },
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]
