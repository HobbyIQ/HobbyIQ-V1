import { useCallback, useEffect, useState } from 'react';
import * as intakeApi from '../api/intake';

export function useManualImport() {
  const [isLoading, setIsLoading] = useState(false);

  const mutateAsync = useCallback(async (rows: any[]) => {
    setIsLoading(true);
    try {
      return await intakeApi.importManual(rows);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { mutateAsync, isLoading };
}

export function useCsvImport() {
  const [isLoading, setIsLoading] = useState(false);

  const mutateAsync = useCallback(async (rows: any[]) => {
    setIsLoading(true);
    try {
      return await intakeApi.importCsv(rows);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { mutateAsync, isLoading };
}

export function useBatch(batchId: string) {
  const [data, setData] = useState<any>(undefined);

  useEffect(() => {
    let alive = true;
    if (!batchId) {
      setData(undefined);
      return;
    }

    intakeApi.getBatch(batchId).then((result) => {
      if (alive) setData(result);
    }).catch(() => {
      if (alive) setData(undefined);
    });

    return () => { alive = false; };
  }, [batchId]);

  return { data };
}

export function useReconcileBatch() {
  const [isLoading, setIsLoading] = useState(false);

  const mutate = useCallback(async (batchId: string) => {
    setIsLoading(true);
    try {
      return await intakeApi.reconcileBatch(batchId);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { mutate, isLoading };
}

export function useDiagnostics(batchId: string) {
  const [data, setData] = useState<any>(undefined);

  useEffect(() => {
    let alive = true;
    if (!batchId) {
      setData(undefined);
      return;
    }

    intakeApi.getDiagnostics(batchId).then((result) => {
      if (alive) setData(result);
    }).catch(() => {
      if (alive) setData(undefined);
    });

    return () => { alive = false; };
  }, [batchId]);

  return { data };
}
