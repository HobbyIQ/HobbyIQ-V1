# HobbyIQ Financial System Design

**Created:** 2026-05-27
**Status:** V1 scope locked; V2 captured for prioritization

## Context

User raised the question: what's missing from running a complete financial system for a card business? Today's session locked V1 vs V2 scope decisions. This doc captures the strategic split and implementation phasing.

Today's repo state (verified 2026-05-24):
- 1 verified iOS commit: ecd25b9 (Bug 2 fix — card tap not opening detail sheet in InventoryIQ)
- ITEM_SOLD consumer pipeline: backend PR #100 shipped; iOS-side consumer NOT yet implemented
- Backend D.6 PortfolioLedgerEntry with granular fee fields (PR #100)

This doc covers the broader financial system V1/V2 scope decided in conversation. Today's expense tracking V1 decisions are captured **inline in this doc** as the single source of truth (Section 3 below).

### Corrective note (2026-05-24)

An earlier version of this doc cross-referenced a `docs/phase0/expense_tracking_design.md` baseline as if it existed in a Mac-side environment awaiting sync. Subsequent verification confirmed no such file exists in this repo or in any branch on origin. The cross-reference was based on an incorrect understanding of repo state.

As of this corrective commit, expense tracking V1 design decisions (categories, mileage, business-use, PayPal, grading flow, inventory section) are captured **inline in Section V1.0 below** rather than via cross-reference. A standalone `expense_tracking_design.md` may be created in a future session if scope warrants, but is not pending.

## V1 implementation scope

Load-bearing for launch. Ships before mid-September moat target.

### V1.0 — Expense tracking V1 (inline source-of-truth, per corrective note above)

Decisions captured in conversation 2026-05-24. Inlined here because the previously-cross-referenced `expense_tracking_design.md` does not exist.

**13 categories (locked):**

1. Subscriptions — recurring
2. Supplies — one-time or recurring
3. Shipping supplies — one-time or recurring
4. Postage — per-transaction
5. Shows — per-event (table fees, parking, food, hotel)
6. Travel for acquisitions — per-trip (gas, mileage, food, hotel)
7. PayPal fees — period-level for V1 (heterogeneous handling deferred to V2)
8. Phone fees — recurring (user enters business portion directly)
9. Internet fees — recurring (user enters business portion directly)
10. Photography/listing prep — one-time (NOT amortized)
11. Storage — recurring
12. Grading costs — via per-card flow (see grading section)
13. Other — catch-all

**Mileage as own entry type:** distinct from cash expense. User enters miles + date + purpose; system applies current federal mileage rate at entry time. Stored value: miles + dollars-at-rate. Re-calculation on annual federal rate updates uses stored miles, not stored dollars. Per-trip metadata: from/to, purpose, optional notes.

**Phone/internet business-use:** user enters business portion directly (e.g., "$30 monthly for HobbyIQ portion of $100 phone bill"). System stores entered amount as full deductible. No separate business-use percentage field; user does the math at entry time. Rationale: simpler UI; user knows actual business-use ratio better than system can infer.

**PayPal fees (period-level for V1):** V1 captures PayPal fees as period-level expense entries (transfer fees, currency conversion, withdrawal fees). V2 deferred: heterogeneous sale-attached PayPal fee handling (attach to PortfolioLedgerEntry like eBay fees per backend D.6). Most PayPal fees in practice are aggregate, not per-card.

**Grading flow — Option C (dual-tracking):**

- Aggregate level: `GradingSubmission` entity (separate first-class entity)
  - Schema: id, userId, submissionDate, gradingCompany (PSA/BGS/SGC/etc), serviceLevelTier (Bulk/Express/etc), totalCost, status (submitted/atGrader/returned), cards array, notes
  - UX: user logs submission as batch entity; specifies service tier per card
- Per-card level: `CardItem` gains `gradingStatus` + `pendingGradingCost` + `gradingSubmissionId` + `finalGrade`
  - `gradingStatus`: enum (none, submitted, atGrader, returned) — defaults to none
  - When card returns: user marks "as returned" with finalGrade + finalCost. Status updates to "returned." If part of submission, submission status updates when all cards returned.
  - When card sells: `finalCost` flows to `PortfolioLedgerEntry.gradingCost` (backend D.6 field already exists)
- Backend D.6 link confirmed: gradingCost flows to PortfolioLedgerEntry at sale time

**"Being graded" inventory section:** three sections in main inventory view — Active (in possession), **Being graded** (NEW; cards currently submitted/atGrader), Sold (existing ledger). Cards in submitted or atGrader status move to Being graded section. Return to Active when status updates to returned.

Visual indicators on card list rows:

- Active: no badge
- Being graded: "📤 [Company] pending" badge
- Returned (but not sold): "✓ [Grade]" badge

**Photography/listing prep: one-time expense (NOT amortized)** per locked decision.

**V1.0 effort estimate:**

- Phase E.1 backend schema: expenses + GradingSubmission entities + endpoints → ~6-8 hours
- Phase E.2 iOS model: Expense + GradingSubmission Codable types + CardItem grading fields → ~4-5 hours
- Phase E.3 iOS UI: expense flow + grading submission flow + per-card grading actions → ~7-10 hours
- Phase E.4 iOS UI: Being graded inventory section + summary/P&L view → ~4-5 hours
- Phase E.5 recurring automation: subscriptions only → ~2-3 hours

**Total V1.0: ~22-30 hours focused work.**

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

- ~~`docs/phase0/expense_tracking_design.md`~~ — **does not exist (corrective commit 2026-05-24)**. V1 expense tracking decisions are inline in Section V1.0 of this doc.
- `docs/phase0/ios_state_assessment.md` — iOS baseline (commit d9090e9)
- `docs/HOBBYIQ_ROADMAP_2026Q2_Q3.md` — overall roadmap (rebaseline addendum at end-of-doc; this V1/V2 split feeds the mid-September moat target buffer)
- Backend PR #100 — D.6 ITEM_SOLD ledger with granular fee fields
- PR E reconciliation UX (pending; per-card sale-time expense editing)

## Carry-forwards captured by this doc

- ~~**CF-EXPENSE-ADDENDUM-PENDING-SYNC**~~ — **DISSOLVED (corrective commit 2026-05-24).** The carry-forward was created based on a false premise (a Mac-side `expense_tracking_design.md` baseline awaiting sync). Verification confirmed no such file exists in any environment. The 7 locked decisions are now captured inline in Section V1.0 above. No work pending under this CF.
- **CF-FINANCIAL-SYSTEM-V2** — Post-launch scope per this design doc (V2.1 through V2.10). Prioritize by real usage patterns after V1 ships. Total estimated V2 effort: ~265-415 hours across 10 sub-items if all built; subset selection expected.

## Open questions

- Receipt storage: blob storage cost at scale (V1 mitigated by limited single-user volume)
- FIFO vs specific identification UX: how often does user actually override default?
- Year-end CSV format: what does CPA actually want? May need iteration after first tax season.
- Grading submission tier pricing: when user enters "PSA bulk service," should system auto-populate cost? (Today: user enters cost manually; V1.5 candidate when expense addendum syncs and grading flow is implemented.)
