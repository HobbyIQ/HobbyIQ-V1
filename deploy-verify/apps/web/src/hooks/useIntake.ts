import { useMutation, useQuery } from 'react-query';
import * as intakeApi from '../api/intake';

export function useManualImport() {
  return useMutation((rows: any[]) => intakeApi.importManual(rows));
}

export function useCsvImport() {
  return useMutation((rows: any[]) => intakeApi.importCsv(rows));
}

export function useBatch(batchId: string) {
  return useQuery(['intake-batch', batchId], () => intakeApi.getBatch(batchId), { enabled: !!batchId });
}

export function useReconcileBatch() {
  return useMutation((batchId: string) => intakeApi.reconcileBatch(batchId));
}

export function useDiagnostics(batchId: string) {
  return useQuery(['intake-diagnostics', batchId], () => intakeApi.getDiagnostics(batchId), { enabled: !!batchId });
}
