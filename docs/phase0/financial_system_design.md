# HobbyIQ Financial System Design

**Created:** 2026-05-27
**Status:** V1 scope locked; V2 captured for prioritization

## Context

User raised the question: what's missing from running a complete financial system for a card business? Today's session locked V1 vs V2 scope decisions. This doc captures the strategic split and implementation phasing.

Today's iOS work shipped:
- Expense tracking design (see `expense_tracking_design.md` when Mac-side commit syncs; addendum capturing today's V1 refinements pending — **CF-EXPENSE-ADDENDUM-PENDING-SYNC**)
- ITEM_SOLD consumer pipeline (PR #100 backend + today's iOS work)
- Backend D.6 PortfolioLedgerEntry with granular fee fields

This doc covers everything beyond those.

### Note on cross-references

Two cross-environment-sync gaps exist as of this doc's creation:

1. **`docs/phase0/expense_tracking_design.md`** baseline was committed on the Mac-side work environment but has not synced to this repo's `origin/main` as of writing. References below point at the expected location; addendum capturing today's locked refinements (3 new categories, mileage entry type, business-use direct entry, PayPal heterogeneity, grading Option C with submission entity, "Being graded" inventory section) lands once the baseline syncs. Tracked as **CF-EXPENSE-ADDENDUM-PENDING-SYNC** — estimated ~30-45 min when baseline available.

2. References below to specific design specifics (FIFO methodology, acquisition source enum values, etc.) reflect today's locked decisions; should be verified against any Mac-side design docs once cross-environment sync completes.

## V1 implementation scope

Load-bearing for launch. Ships before mid-September moat target.

### V1.1 — FIFO cost basis methodology

Default cost basis method: FIFO (first in, first out).

When user owns multiple copies of same card and sells one, oldest acquisition's cost basis is deducted first.

Specific identification override: per-card capability for user to designate which specific copy was sold (tax-optimal for capital gains, requires identity-distinguishable cards).

Implementation:
- Backend: cost basis calculation logic in sale processing
- iOS: optional "which copy?" picker when selling multi-copy holdings
- Default: FIFO; manual override on user action

### V1.2 — Acquisition tracking with source detail

CardItem (or related model) gains:
- `acquisitionSource`: enum (eBay, COMC, MySlabs, LCS, show, trade, gift, inheritance, other)
- `acquisitionDate`: Date (existing; ensure required)
- `acquisitionMethod`: enum (cash, trade, gift, inherited)
- `acquisitionVendor`: String? (optional, e.g., specific seller name)
- `acquisitionNotes`: String?

Backend: schema additions to CardItem / PortfolioHolding
iOS: form additions to add-card flow + edit flow

### V1.3 — Receipt attachment on expense entries

Expense entries gain:
- `receiptPhoto`: photo attachment (similar to existing card photos)
- `receiptNotes`: String?

Backend: blob storage for receipt files; URL stored on expense entry
iOS: camera/photo picker on expense entry form
Reuse existing card photo storage infrastructure if possible.

### V1.4 — Inventory aging report

Computed view, not stored:
- Per-card holding duration (acquisitionDate to today, or to sale date)
- Aggregate: % of inventory < 1 year, ≥ 1 year, ≥ 2 years
- Tax implication labels: short-term (<1yr) vs long-term (≥1yr) for capital gains treatment

iOS: new view in reports section or inventory metadata
Backend: query endpoint or computed on-iOS from existing data

### V1.5 — Year-end tax export CSV

Single year-end export for CPA handoff:
- Period: calendar year (default; selectable)
- Includes: gross sales by category, COGS by category, expenses by category, net profit, inventory valuation at year-start and year-end
- Format: CSV downloadable
- Includes notes column for context (e.g., "Method: FIFO", "Inventory valuation: estimated market value at YYYY-12-31")

Backend: aggregation endpoint
iOS: settings → tax export action with year picker

### V1 effort estimate

Per earlier rebaseline analysis:
- Expense tracking (per addendum — pending sync, see CF above): ~22-30 hours
- FIFO cost basis explicit + override: ~8-12 hours
- Acquisition tracking enhancement: ~8-12 hours
- Receipt attachment: ~12-18 hours
- Aging report: ~6-10 hours
- Year-end tax export CSV: ~12-18 hours

**V1 total: ~68-100 hours focused work.** Calendar: 4-7 weeks at sustainable pace, 2-3 weeks dedicated.

## V2 implementation scope

Post-launch. Prioritizable based on real usage patterns. Captured as design now to preserve thinking; not committed to timeline.

### V2.1 — Trade tracking (cards-for-cards with FMV treatment)

Trade-out and trade-in treated as sale + purchase at fair market value. Both sides need cost basis. Net cash adjustment if any.

Estimated effort: 20-30 hours.

### V2.2 — Damage/loss tracking (casualty/theft)

Damaged cards: documented FMV at damage date, reduces remaining cost basis or creates loss entry.
Theft: police report linked, casualty loss treatment.

Estimated effort: 15-20 hours.

### V2.3 — Charitable donation tracking

FMV at donation date, recipient 501(c)(3), Form 8283 if >$500.

Estimated effort: 15-20 hours.

### V2.4 — Business entity context

User-configurable entity type in settings: sole prop / LLC single-member / LLC multi-member / S-corp.

Entity type drives report output:
- Sole prop / LLC single-member → Schedule C
- LLC multi-member → Form 1065
- S-corp → Form 1120-S

Estimated effort: 20-30 hours.

### V2.5 — Full Schedule C / Schedule D / Form 8949 output

Generated tax forms (not just data export). Year-end action produces filled forms.

Estimated effort: 30-50 hours (significant; tax form formatting + validation).

### V2.6 — Reports beyond P&L

- Cash flow statement (money in vs out per period)
- Inventory turnover (days-in-inventory, turnover rate)
- Margin analysis (gross margin by category: vintage vs modern, raw vs graded)
- Customer/vendor concentration

Estimated effort: 40-60 hours.

### V2.7 — Audit trail (change log)

Every change to financial data logged: who, what, when, why.

Estimated effort: 20-30 hours.

### V2.8 — Inventory valuation snapshots

Month-end / quarter-end / year-end automated snapshots of total inventory value.

Estimated effort: 15-25 hours.

### V2.9 — Bank/payment integration

Plaid integration for bank account sync. Match transactions to expenses. Surface unmatched charges.

Estimated effort: 60-100 hours (significant; OAuth flows, transaction matching, security).

### V2.10 — Multi-currency / international

Currency at transaction date, exchange rate, tax treatment.

Estimated effort: 30-50 hours.

## Strategic rationale: V1 vs V2 split

V1 ships the minimum viable financial system that:
- Handles personal tax filing (year-end CSV → CPA)
- Tracks the most-common expense and acquisition patterns
- Documents grading costs accurately (high audit-value)
- Supports inventory aging awareness

V2 expands to full ERP-grade business management:
- Generated tax forms vs CSV export
- Complex acquisition modes (trades, donations, losses)
- Business reporting beyond P&L
- Compliance infrastructure (audit trail, bank reconciliation)
- International / advanced use cases

V1 preserves the mid-September moat target by keeping iOS workstream calendar bounded. V2 becomes Q4 2026 / Q1 2027 work, prioritized by real usage patterns post-launch.

## Cross-references

- `docs/phase0/expense_tracking_design.md` — V1 expense tracking baseline (see CF-EXPENSE-ADDENDUM-PENDING-SYNC; Mac-side commit not yet synced to this repo's origin/main as of 2026-05-27)
- `docs/phase0/ios_state_assessment.md` — today's iOS baseline
- `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md` — overall roadmap (rebaseline addendum at end-of-doc; this V1/V2 split feeds the mid-September moat target buffer)
- Backend PR #100 — D.6 ITEM_SOLD ledger with granular fee fields
- PR E reconciliation UX (pending; per-card sale-time expense editing)

## Carry-forwards captured by this doc

- **CF-EXPENSE-ADDENDUM-PENDING-SYNC** — Mac-side `expense_tracking_design.md` baseline exists but hasn't synced to this repo's origin/main. Today's locked refinements (3 new categories, mileage entry type, business-use direct entry, PayPal heterogeneity, grading Option C with submission entity, "Being graded" inventory section) need to append to baseline once synced. Estimated 30-45 min when baseline available.
- **CF-FINANCIAL-SYSTEM-V2** — Post-launch scope per this design doc (V2.1 through V2.10). Prioritize by real usage patterns after V1 ships. Total estimated V2 effort: ~265-415 hours across 10 sub-items if all built; subset selection expected.

## Open questions

- Receipt storage: blob storage cost at scale (V1 mitigated by limited single-user volume)
- FIFO vs specific identification UX: how often does user actually override default?
- Year-end CSV format: what does CPA actually want? May need iteration after first tax season.
- Grading submission tier pricing: when user enters "PSA bulk service," should system auto-populate cost? (Today: user enters cost manually; V1.5 candidate when expense addendum syncs and grading flow is implemented.)
