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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importStar(require("react"));
const compiq_1 = require("../api/compiq");
const CompIQResultCard_1 = __importDefault(require("../components/CompIQResultCard"));
const SectionHeader_1 = __importDefault(require("../components/SectionHeader"));
const Card_1 = __importDefault(require("../components/Card"));
const Button_1 = __importDefault(require("../components/Button"));
const Input_1 = __importDefault(require("../components/Input"));
const LoadingBlock_1 = __importDefault(require("../components/LoadingBlock"));
const ErrorBlock_1 = __importDefault(require("../components/ErrorBlock"));
const EmptyState_1 = __importDefault(require("../components/EmptyState"));
require("./CompIQ.css");
const CompIQ = () => {
    const [query, setQuery] = (0, react_1.useState)("");
    const [result, setResult] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [history, setHistory] = (0, react_1.useState)([]);
    async function handleSubmit(e) {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setResult(null);
        try {
            const req = { query };
            const res = await (0, compiq_1.fetchCompIQ)(req);
            setResult(res);
            setHistory(h => [{ input: query, result: res }, ...h]);
            console.log("[CompIQ] Input:", req, "Response:", res);
        }
        catch (err) {
            setError(err.message || "Unknown error");
            console.error("[CompIQ] Error for input:", query, err);
        }
        finally {
            setLoading(false);
        }
    }
    // Test scenarios
    async function runCompIQTest(input) {
        setQuery(input);
        setLoading(true);
        setError(null);
        setResult(null);
        try {
            const req = { query: input };
            const res = await (0, compiq_1.fetchCompIQ)(req);
            setResult(res);
            setHistory(h => [{ input, result: res }, ...h]);
            console.log("[CompIQ][Test] Input:", req, "Response:", res);
        }
        catch (err) {
            setError(err.message || "Unknown error");
            console.error("[CompIQ][Test] Error for input:", input, err);
        }
        finally {
            setLoading(false);
        }
    }
    // Edge case highlight: null/empty fields, warnings, nextActions, confidenceLabel, etc.
    return (<div className="compiq-page" style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "2.5rem 1rem 3rem 1rem" }}>
      <SectionHeader_1.default>CompIQ</SectionHeader_1.default>
      <Card_1.default style={{ width: "100%", maxWidth: 540, margin: "0 auto", marginBottom: 32 }}>
        <form className="compiq-form" onSubmit={handleSubmit} style={{ display: "flex", gap: 16 }}>
          <Input_1.default className="compiq-input" type="text" placeholder="Paste or type a card (e.g. 'LeBron James 2019 Prizm Silver PSA 10 Auto')" value={query} onChange={e => setQuery(e.target.value)} disabled={loading} autoFocus style={{ flex: 1 }}/>
          <Button_1.default className="compiq-btn" type="submit" disabled={loading || !query.trim()} style={{ minWidth: 120 }}>
            {loading ? "Estimating..." : "Estimate"}
          </Button_1.default>
        </form>
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button_1.default type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runCompIQTest("LeBron James 2019 Prizm Silver PSA 10 Auto")}>Test: Full Input</Button_1.default>
          <Button_1.default type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runCompIQTest("LeBron James Prizm")}>Test: Partial Input</Button_1.default>
          <Button_1.default type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runCompIQTest("Jordan")}>Test: Ambiguous Input</Button_1.default>
        </div>
      </Card_1.default>
      {loading && <LoadingBlock_1.default>Estimating...</LoadingBlock_1.default>}
      {error && <ErrorBlock_1.default>{error}</ErrorBlock_1.default>}
      {!loading && !error && !result && <EmptyState_1.default>Enter a card to get started.</EmptyState_1.default>}
      {result && <CompIQResultCard_1.default result={result}/>}
      {history.length > 1 && (<div className="compiq-history" style={{ width: "100%", maxWidth: 540, margin: "2rem auto 0 auto" }}>
          <SectionHeader_1.default sub>Previous Results</SectionHeader_1.default>
          {history.slice(1).map((h, i) => (<CompIQResultCard_1.default key={i} result={h.result}/>))}
        </div>)}
    </div>);
};
exports.default = CompIQ;
