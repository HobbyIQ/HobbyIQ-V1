"use client";

// CF-ONE-BUSINESS-PAGE (Drew, 2026-08-16). Financials now lead /app/erp, with
// position and holdings underneath. This route stays so existing links and
// bookmarks keep resolving, rendering the same component on its own.

import { FinancialDashboard } from "@/components/FinancialDashboard";

export default function FinancePage() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <FinancialDashboard />
    </div>
  );
}
