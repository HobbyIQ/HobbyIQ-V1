# TCG data-source permission requests — DRAFTS, not sent

**Drew's ruling, 2026-09-05.** For the non-Pokémon TCGs: **measure volume first,
then ask each publisher in writing before any ingest.** Nothing in this document
has been sent. Nothing may be ingested from any of these four sources until the
named party replies in writing and Drew says go.

The measurement is done (§1). The four drafts are §3. They are written for Drew
to send from a HobbyIQ address, over his name.

---

## 1. The volume, measured

Read-only census of `sold_comps`, run 2026-09-05 via
`backend/scripts/census-tcg-verticals.cjs`. Complete run, reconciled exactly
(65,518 sport rows = 65,518 game-attributed rows). Dollars are the summed sale
price of stored comps; the 90-day window opens 2026-06-07.

| game | rows | dollars | 90d rows | 90d dollars | publisher | source asked |
|---|---|---|---|---|---|---|
| One Piece Card Game | 21,454 | $6,887,807 | **12,170** | **$5,218,281** | Bandai | optcgapi |
| Yu-Gi-Oh! | 27,760 | $1,374,317 | 711 | $176,847 | Konami | YGOPRODeck |
| Magic: The Gathering | 8,897 | $1,612,027 | 476 | $48,368 | Wizards of the Coast | Scryfall |
| Disney Lorcana | 968 | $477,198 | 524 | $300,033 | Ravensburger / Disney | lorcana-api |
| *unknown TCG* | 6,439 | $377,901 | 1,524 | $192,504 | — | — |

**The finding that should drive the order of these requests.** One Piece is not
merely the largest of the four, it is almost the entire *live* market: 12,170 of
its 21,454 rows sold in the last 90 days, and $5.2M of its $6.9M. Yu-Gi-Oh has
more rows than Magic and Lorcana combined but only 711 recent ones — it is a
large *historical* pool that is barely trading in our data. Magic's dollars are
mostly vintage (Alpha / Beta / Arabian Nights, from the title sample). Lorcana is
small but more than half-live.

So the priority is **One Piece (Bandai) first**, then Lorcana, then Yu-Gi-Oh and
Magic — the reverse of what raw row counts alone would suggest.

**Stored-vertical caveat.** The sport→vertical refactor has not happened, so
these games are not cleanly separated in the `sport` field today: `mtg` and
`lorcana` hold **zero** rows while the actual Magic and Lorcana sales sit inside
`tcg-other` (9,911 rows) and `anime-tcg` (23,283 rows, dominated by One Piece).
The per-game split above is title-attributed in JS over paged rows. That
mis-filing is itself part of the cost of the refactor these numbers exist to
justify.

**The 6,439 unknown rows are not noise.** The sample is mostly Magic in
spellings no reasonable regex claims (`M:TG * Jeweled Bird * Arabian Nights`,
`MAGIC CARD (ID# 487249) ABUGames`, and a seller's typo `Magic the Garthering`),
plus genuinely other games (Hearthstone). They are reported rather than
allocated: guessing them into a game would inflate exactly the number a
publisher will check.

## 2. What we would be asking for, and what we would not

Identical across all four, and each draft says so plainly:

- **What we want:** the *checklist* — set names, card numbers, card names,
  rarities, printing/parallel names. The facts that identify a card.
- **What we do not want and will not take:** card images, card art, flavour
  text, rules text, or anything else that is the publisher's creative work.
- **What we do with it:** identify cards in a price database built from *our
  own* observed sales. We publish prices, never their catalogue.
- **What we will not do:** we operate no public data API and will not resell,
  redistribute or sublicense the checklist
  (project_no_public_data_api — the data is the app-user moat, and that
  commitment is as useful to them as it is to us).
- **Attribution:** offered up front, in whatever form they want it.

Three of the four sources are community projects rather than the publishers
themselves. Each draft is addressed to the **maintainers of the source** and says
explicitly that we are separately willing to approach the publisher — because
a community API's permission is not Konami's or Bandai's permission, and we
should not let a friendly reply from a hobby project stand in for a licence.
The Scryfall draft is the exception worth noting: Wizards' Fan Content Policy is
public and permissive about card data, so that one asks Scryfall about their
own terms and cites the policy rather than requesting a licence Wizards has
already granted publicly.

---

## 3. The drafts

### 3.1 — optcgapi (One Piece Card Game) — **send first**

> **Subject:** Permission to use optcgapi checklist data in a card-pricing app
>
> Hello,
>
> I'm Drew, the founder of HobbyIQ (hobbyiq.com) — a small trading-card
> portfolio and pricing app. I'm writing to ask permission before we use
> anything from optcgapi, rather than after.
>
> We track what cards actually sell for and show collectors the value of what
> they own. To do that we need to *identify* a card correctly — which set it's
> from, its card number, its rarity and parallel. Our sales data is our own; the
> checklist is the piece we don't have.
>
> One Piece is by a distance the most active TCG in our data: about 21,000
> recorded sales, of which roughly 12,000 happened in the last 90 days. Our
> users own these cards and we're currently identifying them poorly.
>
> Concretely, I'd like to ask:
>
> 1. May we use optcgapi's card data (set names, card numbers, card names,
>    rarities, parallel/printing names) to identify cards in our app?
> 2. Are there terms, rate limits or attribution requirements we should follow?
>    We'll take whatever you prefer — a credit line in-app, a link, both.
>
> What we would **not** use: card images, artwork or any rules text. We only
> need the identifying facts.
>
> I should also say what we won't do with it: HobbyIQ has no public data API and
> we don't plan to build one. We would not redistribute or resell your data —
> it would be used inside our own app to name cards correctly, nothing more.
>
> We're also happy to approach Bandai directly if you think that's the right
> route; I didn't want to use your work without asking you first either way.
>
> If there's a better contact for this, I'd be grateful for a pointer.
>
> Thank you for building and maintaining this,
> Drew — HobbyIQ, LLC

### 3.2 — lorcana-api (Disney Lorcana)

> **Subject:** Permission to use Lorcana checklist data in a card-pricing app
>
> Hello,
>
> I'm Drew, founder of HobbyIQ (hobbyiq.com), a trading-card portfolio and
> pricing app. I'd like to ask permission before using anything from
> lorcana-api.
>
> We show collectors what their cards are worth, based on sales we observe
> ourselves. What we lack is a reliable checklist to identify a card by — set,
> card number, name, rarity, and the enchanted/foil variants.
>
> Lorcana is still small in our data (about 970 recorded sales) but more than
> half of them are recent, so it's growing, and I'd rather have permission in
> place early than backfill an apology later.
>
> My questions:
>
> 1. May we use lorcana-api's card data (set names, card numbers, card names,
>    rarities, variant names) to identify cards in our app?
> 2. Any terms, rate limits or attribution you'd like us to honour?
>
> We would not use card images or artwork — Disney's, and not ours to take. Only
> the identifying facts.
>
> We run no public data API and won't redistribute or resell the data; it would
> be used inside our app to name cards correctly.
>
> If you'd prefer we take this to Ravensburger or Disney directly, please say
> so and we will.
>
> Thanks for maintaining this,
> Drew — HobbyIQ, LLC

### 3.3 — YGOPRODeck (Yu-Gi-Oh!)

> **Subject:** Permission to use YGOPRODeck card data in a card-pricing app
>
> Hello,
>
> I'm Drew, founder of HobbyIQ (hobbyiq.com), a trading-card portfolio and
> pricing app. I'm writing to ask permission before we use YGOPRODeck's data.
>
> We price cards from sales we observe ourselves, and to do that we have to
> identify each card properly — set, card number, name, rarity, edition. We have
> around 27,800 recorded Yu-Gi-Oh sales, so our users clearly own these cards;
> we're just identifying them badly today.
>
> I'd like to ask:
>
> 1. May we use YGOPRODeck's card and set data (names, numbers/passcodes, set
>    codes, rarities, editions) to identify cards in our app?
> 2. What terms, rate limits or attribution should we follow? I've seen your
>    API guidance and we'll abide by it — I wanted a person to say yes as well
>    as a docs page.
>
> We would not use card images or rules/effect text — only the identifying
> facts.
>
> We have no public data API and won't redistribute or resell the data.
>
> If you'd rather we sought Konami's permission directly, tell me and we will;
> I didn't want to build on your work without asking.
>
> Thank you,
> Drew — HobbyIQ, LLC

### 3.4 — Scryfall (Magic: The Gathering)

> **Subject:** Checking terms before using Scryfall data in a card-pricing app
>
> Hello,
>
> I'm Drew, founder of HobbyIQ (hobbyiq.com), a trading-card portfolio and
> pricing app. I'd like to check with you before using Scryfall's data.
>
> We price cards from sales we observe ourselves, and we need a checklist to
> identify a card by: set, collector number, name, rarity, finish and printing.
> We have roughly 8,900 recorded Magic sales, weighted heavily toward vintage
> (Alpha, Beta, Arabian Nights), where getting the printing right matters most.
>
> I understand Wizards' Fan Content Policy covers card data broadly, so this is
> really about *your* terms rather than a licence request:
>
> 1. Is our use — identifying cards inside a commercial pricing app —
>    consistent with how you'd like Scryfall data used?
> 2. We'll follow your API rate-limit guidance and attribution requirements; is
>    there a preferred credit wording?
> 3. Would you prefer we use the bulk data files rather than the API for this?
>    Happy to, if it's easier on your infrastructure.
>
> We would not use card images or artwork.
>
> We run no public data API and would not redistribute or resell the data.
>
> Thanks for the work you've put into Scryfall — it's the standard for a reason,
> Drew — HobbyIQ, LLC

---

## 4. What happens after a reply

Nothing automatic. There is no ingest lane for any of these games, and
`census-tcg-verticals` refuses `BACKFILL_APPLY=true` twice over (once in the
runner gate, once in the script, exit 3) precisely so that no dispatch can imply
a permission we have not received.

When a publisher or maintainer says yes, the reply gets filed here, and the
ingest is a separate PR that cites it. `project_pokemon_tcg_expansion_parked`
still parks the vertical behind the sport→vertical refactor regardless — a yes
from Bandai does not unpark it, it just means the refactor has somewhere to go.
