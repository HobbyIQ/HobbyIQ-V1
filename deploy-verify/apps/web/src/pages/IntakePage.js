"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = IntakePage;
const react_1 = __importStar(require("react"));
const useIntake_1 = require("../hooks/useIntake");
function IntakePage() {
    const [rows, setRows] = (0, react_1.useState)([]);
    const [csv, setCsv] = (0, react_1.useState)('');
    const [batchId, setBatchId] = (0, react_1.useState)(null);
    const manualImport = (0, useIntake_1.useManualImport)();
    const csvImport = (0, useIntake_1.useCsvImport)();
    const batch = (0, useIntake_1.useBatch)(batchId || '');
    const diagnostics = (0, useIntake_1.useDiagnostics)(batchId || '');
    const reconcile = (0, useIntake_1.useReconcileBatch)();
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
            const obj = {};
            keys.forEach((k, i) => obj[k.trim()] = values[i]?.trim());
            return obj;
        });
        const result = await csvImport.mutateAsync(parsedRows);
        setBatchId(result.batchId);
    };
    return (<div>
      <h1>Bulk Intake & Reconciliation</h1>
      <section>
        <h2>Manual Entry</h2>
        <textarea rows={6} cols={60} value={JSON.stringify(rows, null, 2)} onChange={e => {
            try {
                setRows(JSON.parse(e.target.value));
            }
            catch { }
        }}/>
        <button onClick={handleManualImport} disabled={manualImport.isLoading}>Import</button>
      </section>
      <section>
        <h2>CSV Import</h2>
        <textarea rows={6} cols={60} value={csv} onChange={e => setCsv(e.target.value)} placeholder="entityType,entityKey,quantity,averageCost"/>
        <button onClick={handleCsvImport} disabled={csvImport.isLoading}>Import CSV</button>
      </section>
      {batchId && (<section>
          <h2>Batch Status</h2>
          <pre>{JSON.stringify(batch.data, null, 2)}</pre>
          <button onClick={() => reconcile.mutate(batchId)} disabled={reconcile.isLoading}>Reconcile Batch</button>
          <h3>Diagnostics</h3>
          <pre>{JSON.stringify(diagnostics.data, null, 2)}</pre>
        </section>)}
    </div>);
}
