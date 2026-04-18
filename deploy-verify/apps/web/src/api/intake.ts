// Intake API module for HobbyIQ web
import axios from 'axios';

export async function importManual(rows: any[]) {
  const res = await axios.post('/api/intake/manual', { rows });
  return res.data;
}

export async function importCsv(rows: any[]) {
  const res = await axios.post('/api/intake/csv', { rows });
  return res.data;
}

export async function getBatch(batchId: string) {
  const res = await axios.get(`/api/intake/batch/${batchId}`);
  return res.data;
}

export async function reconcileBatch(batchId: string) {
  const res = await axios.post(`/api/intake/reconcile/${batchId}`);
  return res.data;
}

export async function getDiagnostics(batchId: string) {
  const res = await axios.get(`/api/intake/diagnostics/${batchId}`);
  return res.data;
}
