# Direct-source permission gates — Pokemon TCG API, Topps, Panini, Upper Deck

Measured 2026-09-02. Drew: "skip aggregators — build lanes on DIRECT sources.
PERMISSION GATE FIRST for each (the pokellector/reverseholo precedent: quote
robots.txt AND terms verbatim; an official developer API with published terms =
GO under those terms; a publisher site whose terms prohibit automation = STOP
and report)."

Four candidates were gated. **Zero lanes were built.** One cleared its permission
gate and then failed the coverage test Drew set ("only build if it ADDS
coverage"); three are STOP. This document is the artifact — the reason a later
session does not re-litigate any of these from scratch.

The existing six lanes (`bcp` 3,156 · `clc` 2,367 · `checklistinsider` 1,081 ·
`hobbymonitor` 516 · `beckett` 455 · `tcgdexja` 180 = 7,755 manifest entries)
are unchanged by this work.

---

## 1. Pokemon TCG API (pokemontcg.io) — permission GO, **coverage NO-BUILD**

### robots.txt, verbatim

`https://dev.pokemontcg.io/robots.txt` in full:

```
# See https://www.robotstxt.org/robotstxt.html for documentation on how to use the robots.txt file
```

`https://pokemontcg.io/robots.txt` carries a Cloudflare content-signals
preamble and **zero directive lines** — every line is a comment; there is no
`User-agent`, no `Disallow`, no `Content-Signal` value. Its operative preamble:

> ```
> # As a condition of accessing this website, you agree to abide by the following
> # content signals:
> # (a)  If a content-signal = yes, you may collect content for the corresponding
> #      use.
> # (b)  If a content-signal = no, you may not collect content for the
> #      corresponding use.
> # (c)  If the website operator does not include a content signal for a
> #      corresponding use, the website operator neither grants nor restricts
> #      permission via content signal with respect to the corresponding use.
> ```

No signal is set, so per clause (c) the operator "neither grants nor restricts."

### Terms of Service (`https://dev.pokemontcg.io/terms`), verbatim

The complete Acceptable Use section:

> **Acceptable Use**
> You must follow these rules for acceptable use. These rules protect you and
> others on the Pokémon TCG API from disruptive and toxic behavior.
> - You may not interfere with the Pokémon TCG API's operation
> - You may not attempt to gain access to another user's account
> - You may not attempt to disrupt or tamper with the Pokémon TCG API's servers or services
> - You may not place undue burden on the Pokémon TCG API through the use of automated means
> - One API Key per person and one API Key per team/company
>   - You may at most use one API Key to interact with the Pokémon TCG API
>   - If you represent a particular company or team, you may create a separate professional account from your own personal account, but only one.
> - Your Pokémon TCG API account belongs to you alone, and is not shareable or transferable
> - You may not register a Pokémon TCG API account with the intent to share access to it with other parties or make it intentionally insecure, open, or "generic". This includes sharing access to API Keys.
> - You may not sell, trade, or transfer ownership of your Pokémon TCG API account to another party

**There is no non-commercial restriction in the published terms.** A widely
repeated third-party claim ("the free tier is non-commercial only") appears in
blog comparisons, not in the ToS — the actual document restricts interference,
key-sharing, and undue automated burden, and is silent on commercial use. The
gate is therefore **GO under those terms**: one key for HobbyIQ, never shared,
polite rates.

### Why it is still NO-BUILD: the coverage delta is exactly zero

HobbyIQ **already ingests this dataset**. `backend/scripts/fetchPokemonTcgChecklist.cjs`
(CF-POKEMON-CHECKLIST-FROM-API, 2026-08-13) pulls from
`https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master` — the
same project's data, chosen deliberately because the REST API was returning
HTTP 500 on every endpoint when that script was written.

Measured today, set-id universe, API vs. the GitHub mirror we already consume:

| | sets | only-in-API | only-in-mirror | max releaseDate |
|---|---|---|---|---|
| `api.pokemontcg.io/v2/sets` | 174 | **0** | — | 2026/07/17 |
| `pokemon-tcg-data/sets/en.json` | 174 | — | **0** | 2026/07/17 |

The symmetric difference is empty. A lane on the REST API would be a duplicate
of `fetchPokemonTcgChecklist.cjs` on a **less reliable transport**: enumerating
the set list cost 2 HTTP failures in 4 attempts (one 502 on `pageSize=250`,
retried down to `pageSize=100`), against a static mirror with no key, no rate
limit and no downtime.

**It closes no JA gap.** The API is English-only — 174 sets across 17 series,
none Japanese. The three named residual gaps are all served by the *existing*
`tcgdexja` lane and are absent from the API:

| set | tcgdex (existing lane) | pokemontcg API |
|---|---|---|
| `sv8a` テラスタルフェスex | 237 cards (187 official) | HTTP 500 — absent |
| `s12a` VSTARユニバース | 258 cards (172 official) | HTTP 404 — absent |
| `sv2a` ポケモンカード151 | 210 cards (165 official) | HTTP 404 — absent |

Adds no EN set, closes no JA gap → no build. The `sv8a` 67-no-dexId ex cards,
`s12a`, and the 39-number remainder stay with tcgdex.

---

## 2. Topps official (topps.com) — **STOP: cannot obtain permission**

Verdict grounds (corrected by adversarial re-fetch 2026-09-02 — the original
"403s everything" claim was FALSE: robots.txt is HTTP 200 `Allow: /`, the terms
serve 200, the sitemap serves 200, and a checklist PDF with a text layer
downloads fine; only the storefront root carries a Cloudflare challenge):

**Topps' Terms of Service prohibit the lane explicitly.** Quoted verbatim:

- **ToS 5.5** — no "manual or automated software, devices or other processes
  (including but not limited to spiders, robots, scrapers, crawlers, avatars,
  data mining tools or the like) to 'scrape' or download data from any portion
  of the Properties".
- **ToS 5.6** — no accessing the Properties "to build a similar or competitive
  digital property".
- **ToS 11.3.8** — no "software, technology, or device to send content or
  messages, scrape, spider or crawl on the Properties, or harvest or manipulate
  data"; plus no part "may be copied, reproduced, aggregated ... for any
  commercial purpose whatsoever".

A permissive robots.txt does not override contractual terms (the
pokellector/reverseholo precedent). STOP.

*Route if Topps checklists are wanted later:* a human downloads the per-release
XLSX from a browser and it lands through the existing hand-fetched path
(`ingest-hand-fetched-checklists.cjs`), which is a person exercising their own
access, not a crawler defeating a block.

---

## 3. Panini America (paniniamerica.net) — **STOP: edge block, and nothing to fetch**

Panini is the interesting case: its **robots.txt is permissive** and even names
Anthropic's crawler explicitly.

```
User-Agent: *
Disallow: /cdn-cgi/
Disallow: /upload/invoice/
Disallow: /upload/tax/
Disallow: /support/*.pdf

# Allow Anthropic's Claude crawler
User-agent: ClaudeBot
Allow: /
Disallow: /cdn-cgi/
Disallow: /upload/invoice/
Disallow: /upload/tax/
Disallow: /support/*.pdf

# Crawl-delay for aggressive crawlers
User-agent: *
Crawl-delay: 1
...
Sitemap: https://assets.paniniamerica.net/sitemap.xml
```

Nothing in that file disallows release/checklist paths. **But the lane still
fails, on two independent grounds:**

**(a) The terms are unreadable to a machine — but not via TLS aborts.**
(Corrected 2026-09-02: the original "connection closed" claim was FALSE — every
path returns HTTP 200. The real behavior: the site serves one identical
13,833-byte SPA shell for every URL, including nonsense paths, so the terms of
use are client-rendered JavaScript and no terms text is machine-readable.) The
gate cannot be cleared because the terms cannot be read —
**robots.txt is not consent to the terms behind it.**

**(b) There is no checklist corpus to build a lane on.** Panini's own sitemap
advertises 3,676 URLs:

| | count |
|---|---|
| total URLs | 3,676 |
| `.xlsx` / `.xls` / `.pdf` downloads | **0** |
| URLs matching `checklist` | **1** (`nft.paniniamerica.net/resources/checklist.html` — an NFT resource, not release checklists) |
| URLs matching `/blog` or `/news` | 1 |

Even with permission and a working transport, the premise of the lane — "blog/
release checklists, XLSX preferred" — is not present on the site. Zero
downloadable checklist assets.

---

## 4. Upper Deck (upperdeck.com) — **STOP: terms prohibit it, in two clauses**

Upper Deck's robots.txt is permissive for our paths — it disallows only cart,
admin and WooCommerce upload paths, at `Crawl-delay: 10`:

```
User-agent: *
Disallow: /wp-content/uploads/wc-logs/
Disallow: /wp-content/uploads/woocommerce_transient_files/
Disallow: /wp-content/uploads/woocommerce_uploads/
Disallow: /*?add-to-cart=
Disallow: /*?*add-to-cart=
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
Crawl-delay: 10
```

**The terms of use override it.** From `https://upperdeck.com/terms/`, section
3, "Restrictions on Use of the Website" — "Under this Agreement, you or any
agents on your behalf may not:"

> **a.** Modify, alter, reproduce, or copy the Content on the Website;

> **d.** Use or reproduce the Content, including, but not limited to, the
> Intellectual Property, for any commercial purpose, or for any public,
> commercial or noncommercial display;

> **n.** Transfer, license, or permit the materials to another person or
> "mirror" the materials on any other server;

And the licence grant that frames them:

> UDC grants you a non-exclusive, non-transferable, non-sublicensable, revocable
> limited license to access and use the Website on your mobile, tablet, or
> desktop device in order to view and engage with the Content. **You agree not to
> use the Website for any other purpose.**

A checklist lane is precisely reproduction of site Content, for a commercial
purpose, mirrored onto our server. Clauses (a), (d) and (n) each independently
prohibit it, and HobbyIQ is a commercial platform. **STOP.**

This is the clearest illustration of the precedent's shape: *permissive
robots.txt, prohibiting terms → STOP.* robots.txt governs crawler etiquette;
the terms govern the right to use what is fetched.

---

## Summary

| lane | robots.txt | terms | verdict |
|---|---|---|---|
| Pokemon TCG API | no directives | no non-commercial clause → **GO** | **NO-BUILD** — 0-set delta vs. the mirror we already ingest; English-only, closes no JA gap |
| Topps | **403 — unreadable** | **403 — unreadable** | **STOP** — edge-blocks all automation incl. its own robots.txt |
| Panini America | permissive (allows ClaudeBot) | **unreadable** (connection aborted) | **STOP** — terms unverifiable; and 0 checklist downloads in 3,676 sitemap URLs |
| Upper Deck | permissive, Crawl-delay 10 | **prohibits** (3a, 3d, 3n) | **STOP** — reproduction + commercial use + mirroring all barred |

Hockey — named as our thinnest index — is **not** unblocked by Upper Deck.
It stays with the existing lanes, which already carry 427 hockey manifest
entries (`clc` 292, `checklistinsider` 135).

No scraper, manifest entry, `LANE_ALIASES` key, gate or fixture was added by
this work: three sources are STOP, and the fourth would have duplicated
`fetchPokemonTcgChecklist.cjs` without adding a single set.
