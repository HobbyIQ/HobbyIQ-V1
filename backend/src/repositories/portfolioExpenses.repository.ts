// CF-ERP-EXPANSION-#5 (2026-06-03): operating-expense CRUD repository.
// Container `portfolio_expenses`, partition /userId. One doc per expense
// entry (append-on-create; user-editable via PATCH; user-deletable).

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "crypto";

export type ExpenseCategory =
  | "store_subscription"
  | "show_booth"
  | "show_admission"
  | "mileage"
  | "supplies"
  | "shipping_supplies"
  | "grading_fees"
  | "software"
  | "hobbyiq_subscription"
  | "travel"
  | "meals"
  | "other";

export const VALID_EXPENSE_CATEGORIES: ReadonlyArray<ExpenseCategory> = [
  "store_subscription",
  "show_booth",
  "show_admission",
  "mileage",
  "supplies",
  "shipping_supplies",
  "grading_fees",
  "software",
  "hobbyiq_subscription",
  "travel",
  "meals",
  "other",
];

export interface ExpenseEntry {
  id: string;
  userId: string;
  category: ExpenseCategory;
  categoryNote?: string;
  amount: number;
  date: string;             // YYYY-MM-DD
  note?: string;
  receiptRef?: string;
  createdAt: string;
  updatedAt?: string;
}

interface ExpenseDocument extends ExpenseEntry {
  docType: "expense_entry";
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName = process.env.COSMOS_EXPENSES_CONTAINER ?? "portfolio_expenses";
      if (!endpoint && !connStr) {
        console.warn("[portfolioExpenses.repository] COSMOS not configured — repository disabled");
        return null;
      }
      let client: CosmosClient;
      if (connStr) client = new CosmosClient(connStr);
      else if (key) client = new CosmosClient({ endpoint: endpoint!, key });
      else client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/userId"] },
      });
      _container = container;
      console.log(`[portfolioExpenses.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[portfolioExpenses.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

function toEntry(doc: ExpenseDocument): ExpenseEntry {
  return {
    id: doc.id,
    userId: doc.userId,
    category: doc.category,
    categoryNote: doc.categoryNote,
    amount: doc.amount,
    date: doc.date,
    note: doc.note,
    receiptRef: doc.receiptRef,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function listExpensesForUser(
  userId: string,
  options: { from?: string; to?: string; category?: ExpenseCategory } = {},
): Promise<ExpenseEntry[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const params: Array<{ name: string; value: string }> = [{ name: "@uid", value: userId }];
    const clauses: string[] = ["c.docType = 'expense_entry'", "c.userId = @uid"];
    if (options.from) { clauses.push("c.date >= @from"); params.push({ name: "@from", value: options.from }); }
    if (options.to) { clauses.push("c.date <= @to"); params.push({ name: "@to", value: options.to }); }
    if (options.category) { clauses.push("c.category = @cat"); params.push({ name: "@cat", value: options.category }); }
    const { resources } = await container.items
      .query<ExpenseDocument>(
        {
          query: `SELECT * FROM c WHERE ${clauses.join(" AND ")} ORDER BY c.date DESC`,
          parameters: params,
        },
        { partitionKey: userId },
      )
      .fetchAll();
    return resources.map(toEntry);
  } catch (err: any) {
    console.error("[portfolioExpenses.repository] list failed:", err?.message ?? err);
    return [];
  }
}

export interface CreateExpenseInput {
  userId: string;
  category: ExpenseCategory;
  categoryNote?: string;
  amount: number;
  date: string;
  note?: string;
  receiptRef?: string;
}

export async function createExpense(input: CreateExpenseInput): Promise<ExpenseEntry | null> {
  const container = await getContainer();
  if (!container) return null;
  const now = new Date().toISOString();
  const id = randomUUID();
  const doc: ExpenseDocument = {
    docType: "expense_entry",
    id,
    userId: input.userId,
    category: input.category,
    categoryNote: input.categoryNote,
    amount: input.amount,
    date: input.date,
    note: input.note,
    receiptRef: input.receiptRef,
    createdAt: now,
  };
  try {
    const { resource } = await container.items.create<ExpenseDocument>(doc);
    return resource ? toEntry(resource) : toEntry(doc);
  } catch (err: any) {
    console.error("[portfolioExpenses.repository] create failed:", err?.message ?? err);
    return null;
  }
}

export interface UpdateExpensePatch {
  category?: ExpenseCategory;
  categoryNote?: string | null;
  amount?: number;
  date?: string;
  note?: string | null;
  receiptRef?: string | null;
}

export async function updateExpense(
  userId: string,
  id: string,
  patch: UpdateExpensePatch,
): Promise<ExpenseEntry | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource: existing } = await container.item(id, userId).read<ExpenseDocument>();
    if (!existing) return null;
    const next: ExpenseDocument = {
      ...existing,
      category: patch.category ?? existing.category,
      categoryNote: patch.categoryNote === null ? undefined : (patch.categoryNote ?? existing.categoryNote),
      amount: patch.amount ?? existing.amount,
      date: patch.date ?? existing.date,
      note: patch.note === null ? undefined : (patch.note ?? existing.note),
      receiptRef: patch.receiptRef === null ? undefined : (patch.receiptRef ?? existing.receiptRef),
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await container.item(id, userId).replace<ExpenseDocument>(next);
    return resource ? toEntry(resource) : toEntry(next);
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.error("[portfolioExpenses.repository] update failed:", err?.message ?? err);
    return null;
  }
}

export async function deleteExpense(userId: string, id: string): Promise<boolean> {
  const container = await getContainer();
  if (!container) return false;
  try {
    await container.item(id, userId).delete();
    return true;
  } catch (err: any) {
    if (err?.code === 404) return false;
    console.error("[portfolioExpenses.repository] delete failed:", err?.message ?? err);
    return false;
  }
}

// ─── Pure aggregation (for /expenses/report) ───────────────────────────────

export type ExpenseGroupBy = "category" | "month";

export interface ExpenseGroup {
  key: string;
  label: string;
  total: number;
  entryCount: number;
}

export interface ExpenseReport {
  window: { from: string | null; to: string | null };
  groupBy: ExpenseGroupBy;
  totals: { total: number; entryCount: number };
  groups: ExpenseGroup[];
}

function r2(n: number): number { return Math.round(n * 100) / 100; }
function parseDateInput(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function inWindow(date: string, fromIso: string | null, toIso: string | null): boolean {
  if (fromIso && date < fromIso) return false;
  if (toIso && date > toIso) return false;
  return true;
}

export function aggregateExpenses(
  entries: ReadonlyArray<ExpenseEntry>,
  options: { from?: string; to?: string; groupBy: ExpenseGroupBy },
): ExpenseReport {
  const fromIso = parseDateInput(options.from);
  const toIso = parseDateInput(options.to);
  const windowed = entries.filter((e) => inWindow(e.date, fromIso, toIso));
  const buckets = new Map<string, { label: string; total: number; entryCount: number }>();
  let totalSum = 0;
  for (const e of windowed) {
    totalSum += e.amount;
    let key: string;
    let label: string;
    if (options.groupBy === "category") {
      key = e.category;
      label = e.category;
    } else {
      key = e.date.slice(0, 7);
      label = key;
    }
    let b = buckets.get(key);
    if (!b) { b = { label, total: 0, entryCount: 0 }; buckets.set(key, b); }
    b.total += e.amount;
    b.entryCount += 1;
  }
  const groups = Array.from(buckets.entries()).map(([key, b]) => ({
    key,
    label: b.label,
    total: r2(b.total),
    entryCount: b.entryCount,
  }));
  if (options.groupBy === "month") groups.sort((a, b) => a.key.localeCompare(b.key));
  else groups.sort((a, b) => b.total - a.total);
  return {
    window: { from: fromIso, to: toIso },
    groupBy: options.groupBy,
    totals: { total: r2(totalSum), entryCount: windowed.length },
    groups,
  };
}

/** Helper for `/erp/pnl?includeExpenses=true` — sum reconciled expenses in window. */
export function totalExpensesInWindow(
  entries: ReadonlyArray<ExpenseEntry>,
  options: { from?: string; to?: string } = {},
): { total: number; entryCount: number } {
  const fromIso = parseDateInput(options.from);
  const toIso = parseDateInput(options.to);
  let total = 0;
  let count = 0;
  for (const e of entries) {
    if (!inWindow(e.date, fromIso, toIso)) continue;
    total += e.amount;
    count += 1;
  }
  return { total: r2(total), entryCount: count };
}
