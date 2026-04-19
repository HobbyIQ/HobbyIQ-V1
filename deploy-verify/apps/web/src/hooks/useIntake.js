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
exports.useManualImport = useManualImport;
exports.useCsvImport = useCsvImport;
exports.useBatch = useBatch;
exports.useReconcileBatch = useReconcileBatch;
exports.useDiagnostics = useDiagnostics;
const react_query_1 = require("react-query");
const intakeApi = __importStar(require("../api/intake"));
function useManualImport() {
    return (0, react_query_1.useMutation)((rows) => intakeApi.importManual(rows));
}
function useCsvImport() {
    return (0, react_query_1.useMutation)((rows) => intakeApi.importCsv(rows));
}
function useBatch(batchId) {
    return (0, react_query_1.useQuery)(['intake-batch', batchId], () => intakeApi.getBatch(batchId), { enabled: !!batchId });
}
function useReconcileBatch() {
    return (0, react_query_1.useMutation)((batchId) => intakeApi.reconcileBatch(batchId));
}
function useDiagnostics(batchId) {
    return (0, react_query_1.useQuery)(['intake-diagnostics', batchId], () => intakeApi.getDiagnostics(batchId), { enabled: !!batchId });
}
