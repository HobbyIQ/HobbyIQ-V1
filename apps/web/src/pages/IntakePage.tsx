import React, { useState } from 'react';
import { useManualImport, useCsvImport, useBatch, useDiagnostics, useReconcileBatch } from '../hooks/useIntake';

export default function IntakePage() {
  const [rows, setRows] = useState<any[]>([]);
  const [csv, setCsv] = useState('');
  const [batchId, setBatchId] = useState<string | null>(null);
  const manualImport = useManualImport();
  const csvImport = useCsvImport();
  const batch = useBatch(batchId || '');
  const diagnostics = useDiagnostics(batchId || '');
  const reconcile = useReconcileBatch();

  const handleManualImport = async () => {
    const result = await manualImport.mutateAsync(rows);
    setBatchId(result.batchId);
  };

  const handleCsvImport = async () => {
    // Simple CSV to JSON (assume header row)
    const [header, ...lines] = csv.trim().split('\n');
    const keys = header.split(',');
    const parsedRows = lines.map(line => {
      const values = line.split(',');
      const obj: any = {};
      keys.forEach((k, i) => obj[k.trim()] = values[i]?.trim());
      return obj;
    });
    const result = await csvImport.mutateAsync(parsedRows);
    setBatchId(result.batchId);
  };

  return (
    <div>
      <h1>Bulk Intake & Reconciliation</h1>
      <section>
        <h2>Manual Entry</h2>
        <textarea rows={6} cols={60} value={JSON.stringify(rows, null, 2)} onChange={e => {
          try { setRows(JSON.parse(e.target.value)); } catch {}
        }} />
        <button onClick={handleManualImport} disabled={manualImport.isLoading}>Import</button>
      </section>
      <section>
        <h2>CSV Import</h2>
        <textarea rows={6} cols={60} value={csv} onChange={e => setCsv(e.target.value)} placeholder="entityType,entityKey,quantity,averageCost" />
        <button onClick={handleCsvImport} disabled={csvImport.isLoading}>Import CSV</button>
      </section>
      {batchId && (
        <section>
          <h2>Batch Status</h2>
          <pre>{JSON.stringify(batch.data, null, 2)}</pre>
          <button onClick={() => reconcile.mutate(batchId)} disabled={reconcile.isLoading}>Reconcile Batch</button>
          <h3>Diagnostics</h3>
          <pre>{JSON.stringify(diagnostics.data, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
