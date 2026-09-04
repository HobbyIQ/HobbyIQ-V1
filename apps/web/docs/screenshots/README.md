# Portfolio holding card — mobile rebuild (2026-09-04)

Renders of `/app/portfolio` captured with Playwright against a real `next dev`
server, dark theme, `deviceScaleFactor: 2`.

| File | Viewport | What it shows |
| --- | --- | --- |
| `portfolio-mobile-390-before.png` | 390×844, iPhone | The reported defect |
| `portfolio-mobile-390-after.png` | 390×844, iPhone | The rebuilt card |
| `portfolio-desktop-1280-after.png` | 1280×900 | Desktop, unchanged |
| `portfolio-mobile-390-verified-check.png` | 390×844, iPhone | CF-VERIFIED-IS-A-CHECK (below) |
| `portfolio-desktop-1280-verified-check.png` | 1280×900 | CF-VERIFIED-IS-A-CHECK (below) |

## The verified marker — CF-VERIFIED-IS-A-CHECK (2026-09-04)

Drew: *"Rather than say Verified — let's just do a green check for it next to
the card details."*

The `-verified-check` pair shows the result at both viewports. Two holdings
are stubbed so the change and its boundary are visible in one frame:

- **Bobby Witt Jr. #CPA-BWJ** — `identityVerified: true`. A green check sits
  immediately after the card number on the title line. No word, no pill.
- **Ken Griffey Jr. #1** — `identityVerified: false`. No check, and the
  **UNVERIFIED** chip is exactly where it was. An unverified identity is
  actionable ("open Edit and pick the card"), so it keeps words; a row that
  merely lacked a mark would say nothing about what to do.

Every other chip is untouched — the provenance chip ("unknown · rung not
reported") renders on both rows, as before.

Measured by `docs/harness/verified-check-check.mjs`, 9 assertions × 2
viewports, all passing: one visible check, no "VERIFIED" text, UNVERIFIED
present, the check on the title line rather than the chips band, not clipped
by the card edge, `aria-label` present, no horizontal overflow, no
overlapping text inside any card.

## What was wrong

At ~390px every holding rendered as ONE `flex items-center` row, so the title,
the grade, the method chip, the status badges and the P&L all competed for a
single line box:

1. the method chip ("observed · from the last sale of this card,
   trend-adjusted") wrapped into a 1–2-word-per-line column taller than
   everything else in the card;
2. the P&L block — last in the row, with a fixed `min-w-20` — drew **on top of**
   the VERIFIED / self-anchored / low-confidence badge;
3. the title truncated to "1987 Bellingham …", so the card could not be named;
4. four unrelated elements shared one row.

## What changed

A breakpoint, not a redesign. Below `md` the card is three stacked bands —
title / figures / chips; at `md` and above the original row renders unchanged.
Both layouts render ONE `statusChips` fragment, so the badge vocabulary can
never drift between phone and desktop.

The mobile title leads with the player and card number and gives the product
its own clamped line, because `formatCardTitle` composes year + product +
parallel + player + number in that order — right for a wide row, but it puts
the two parts that NAME the card last, where a narrow clamp eats them. Both
halves come from `formatCardContext`, which `formatCardTitle` also composes
from, so the two can never disagree.

## Reproducing

The renders come from a throwaway harness — a `next dev` server pointed at a
small mock of `/api/auth/session` + `/api/portfolio/` (every other route 404s,
which is what makes the dashboard and market strip self-suppress). Point
`NEXT_PUBLIC_API_BASE` at the mock, seed `hobbyiq_session_id` in
`localStorage`, and screenshot at 390×844 and 1280×900.

## Measured, not eyeballed

Assertions run against the live DOM at both states:

- **text overlap inside cards**: 12 before → **0 after** (including the exact
  `✓ VERIFIED` × P&L collision that was reported)
- **desktop holdings list**: **0 of 2,816,000 pixels** differ before vs after
- **horizontal overflow**: none at 320 / 360 / 390 / 414 / 640 / 767 / 768 / 1024
- **touch targets**: holding cards 200–239px tall (min 44px)
