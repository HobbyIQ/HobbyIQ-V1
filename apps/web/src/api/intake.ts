import { apiFetch } from "./client";

export async function importManual(rows: unknown[]) {
  return apiFetch("/api/intake/manual", {
    method: "POST",
    auth: true,
    body: JSON.stringify({ rows }),
  });
}

export async function importCsv(rows: unknown[]) {
  return apiFetch("/api/intake/csv", {
    method: "POST",
    auth: true,
    body: JSON.stringify({ rows }),
  });
}

export async function getBatch(batchId: string) {
  return apiFetch(`/api/intake/batch/${batchId}`, {
    method: "GET",
    auth: true,
  });
}

export async function reconcileBatch(batchId: string) {
  return apiFetch(`/api/intake/reconcile/${batchId}`, {
    method: "POST",
    auth: true,
  });
}

export async function getDiagnostics(batchId: string) {
  return apiFetch(`/api/intake/diagnostics/${batchId}`, {
    method: "GET",
    auth: true,
  });
}
