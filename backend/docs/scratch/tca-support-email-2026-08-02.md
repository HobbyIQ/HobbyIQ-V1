# TCA support email — draft

**Subject:** HobbyIQ — daily-cap on Enterprise + bulk historical delivery ask

Hi team,

Drew here from HobbyIQ (Enterprise subscriber). Two related asks after our first day of large-scale ingest testing:

**1. Daily cap on our account**

We hit `"Daily sales limit reached. Upgrade your plan for more."` after ~1 hour of ingesting from `/api/v1/market/sales`. Our Enterprise plan was pitched as unlimited daily quota + unlimited lookback — can you:

- Confirm the exact daily-sales cap on our account (API key ending in `…03746c2498d05`)?
- Raise it to actual unlimited if that's what the tier includes?
- If there's a hard per-day cap by design, what's the number, and what's the escalation path to increase it?

**2. Bulk historical delivery**

We're backfilling eBay sports sales from your earliest indexed date (2014-07-08 per `/platforms` — 7,051,882 records). At paginated `/sales` rates + our current daily cap, this would take many months.

Do you offer bulk delivery for Enterprise customers — CSV over S3, a signed pre-URL, or a snapshot dump? Even a one-time drop of the current pool (all eBay + sports + auction house records you have) would be a massive unlock for us, and I assume it doesn't consume paginated-query quota.

**3. Per-second rate limit clarification**

Separate from the daily cap, we've seen some 429 responses in short bursts (5+ concurrent requests). What's the per-second (or per-minute) rate limit on our Enterprise key?

Happy to hop on a call — ET-based, flexible timezone.

Best,
Drew Vabulas
Founder, HobbyIQ · Just The Boys and Cards LLC
dvabulas@outlook.com

---

**Notes for Drew:**

- Sending this email is the fastest unblock. Their sales/support should respond in <24h.
- The "bulk historical delivery" ask is the real prize — if they can send us a CSV of what they have today, we're caught up instantly and only need incremental thereafter.
- Ref the key ending only, never the full key.
- If they push back on "unlimited," fall back to asking for the highest daily cap they offer.
