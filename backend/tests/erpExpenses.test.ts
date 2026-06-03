// CF-ERP-EXPANSION-#5 (2026-06-03): expenses aggregator coverage.

import { describe, expect, it } from "vitest";
import {
  aggregateExpenses,
  totalExpensesInWindow,
  type ExpenseEntry,
} from "../src/repositories/portfolioExpenses.repository.js";

function exp(over: Partial<ExpenseEntry> = {}): ExpenseEntry {
  return {
    id: "e", userId: "u",
    category: "supplies", amount: 50, date: "2026-05-10",
    createdAt: "2026-05-10T00:00:00Z",
    ...over,
  };
}

describe("aggregateExpenses", () => {
  it("groupBy=category sums by category descending", () => {
    const entries = [
      exp({ id: "e1", category: "supplies", amount: 100 }),
      exp({ id: "e2", category: "supplies", amount: 25 }),
      exp({ id: "e3", category: "travel", amount: 200 }),
      exp({ id: "e4", category: "meals", amount: 15 }),
    ];
    const r = aggregateExpenses(entries, { groupBy: "category" });
    expect(r.groups[0].key).toBe("travel");
    expect(r.groups[0].total).toBe(200);
    expect(r.groups.find((g) => g.key === "supplies")?.total).toBe(125);
    expect(r.totals.total).toBe(340);
    expect(r.totals.entryCount).toBe(4);
  });

  it("groupBy=month sums by YYYY-MM ascending", () => {
    const entries = [
      exp({ id: "e1", date: "2026-04-10", amount: 100 }),
      exp({ id: "e2", date: "2026-05-12", amount: 75 }),
      exp({ id: "e3", date: "2026-05-25", amount: 25 }),
    ];
    const r = aggregateExpenses(entries, { groupBy: "month" });
    expect(r.groups.map((g) => g.key)).toEqual(["2026-04", "2026-05"]);
    expect(r.groups[1].total).toBe(100);
  });

  it("date window from/to clamps", () => {
    const entries = [
      exp({ id: "e1", date: "2026-03-15", amount: 100 }),
      exp({ id: "e2", date: "2026-05-15", amount: 50 }),
    ];
    const r = aggregateExpenses(entries, {
      from: "2026-05-01", to: "2026-05-31", groupBy: "month",
    });
    expect(r.totals.total).toBe(50);
  });

  it("travel + meals are valid categories", () => {
    const entries = [
      exp({ id: "e1", category: "travel", amount: 200 }),
      exp({ id: "e2", category: "meals", amount: 30 }),
    ];
    const r = aggregateExpenses(entries, { groupBy: "category" });
    const keys = r.groups.map((g) => g.key).sort();
    expect(keys).toEqual(["meals", "travel"]);
  });
});

describe("totalExpensesInWindow", () => {
  it("sums + counts within window", () => {
    const entries = [
      exp({ id: "e1", date: "2026-04-10", amount: 100 }),
      exp({ id: "e2", date: "2026-05-10", amount: 50 }),
    ];
    const r = totalExpensesInWindow(entries, { from: "2026-05-01" });
    expect(r.total).toBe(50);
    expect(r.entryCount).toBe(1);
  });
});
