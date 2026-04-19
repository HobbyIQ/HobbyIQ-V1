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
exports.default = AnalyzeCard;
const react_1 = __importStar(require("react"));
require("./AnalyzeCard.css");
const api_1 = require("../api");
function getRecommendationColor(rec) {
    if (!rec)
        return "";
    const r = rec.toLowerCase();
    if (r.includes("buy"))
        return "rec-green";
    if (r.includes("hold"))
        return "rec-yellow";
    if (r.includes("sell"))
        return "rec-red";
    return "";
}
function AnalyzeCard() {
    const [form, setForm] = (0, react_1.useState)({
        fmv: "",
        trend: "",
        liquidity: "",
        playerScore: "",
        dailyScore: "",
        supplyScore: "",
        scarcityScore: "",
        negativePressureScore: "",
    });
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [result, setResult] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    const handleChange = (e) => {
        setForm({ ...form, [e.target.name]: e.target.value });
    };
    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setResult(null);
        setError(null);
        try {
            const res = await fetch(`${api_1.API_BASE_URL}/api/hobbyiq/analyze`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    compiq: {
                        weightedMedianFMV: Number(form.fmv),
                        trend: Number(form.trend),
                        liquidityScore: Number(form.liquidity),
                    },
                    playeriq: { finalPlayerIQScore: Number(form.playerScore) },
                    dailyiq: { dailySignalScore: Number(form.dailyScore) },
                    supply: { supplyScore: Number(form.supplyScore) },
                    scarcity: { scarcityScore: Number(form.scarcityScore) },
                }),
            });
            if (!res.ok)
                throw new Error("Failed to analyze card");
            const data = await res.json();
            setResult({
                decisionScore: data.decisionScore,
                recommendation: data.recommendation,
                confidenceScore: data.confidenceScore,
                targetEntryRange: data.targetEntryRange,
                targetExit: data.targetExit,
                explanation: data.explanation,
            });
        }
        catch (err) {
            setError(err.message || "Unknown error");
        }
        finally {
            setLoading(false);
        }
    };
    // Split explanation into bullet points
    const explanationPoints = result?.explanation
        ? result.explanation.split(/[\n•\-]+/).map(s => s.trim()).filter(Boolean)
        : [];
    return (<div className="analyze-container">
      <h2>Analyze Card</h2>
      <form onSubmit={handleSubmit} className="analyze-form">
        <input name="fmv" type="number" placeholder="FMV" value={form.fmv} onChange={handleChange} required/>
        <input name="trend" type="number" placeholder="Trend" value={form.trend} onChange={handleChange} required/>
        <input name="liquidity" type="number" placeholder="Liquidity" value={form.liquidity} onChange={handleChange} required/>
        <input name="playerScore" type="number" placeholder="Player Score" value={form.playerScore} onChange={handleChange} required/>
        <input name="dailyScore" type="number" placeholder="Daily Score" value={form.dailyScore} onChange={handleChange} required/>
        <input name="supplyScore" type="number" placeholder="Supply Score" value={form.supplyScore} onChange={handleChange} required/>
        <input name="scarcityScore" type="number" placeholder="Scarcity Score" value={form.scarcityScore} onChange={handleChange} required/>
        <input name="negativePressureScore" type="number" placeholder="Negative Pressure Score" value={form.negativePressureScore} onChange={handleChange} required/>
        <button type="submit" disabled={loading}>{loading ? "Analyzing..." : "Analyze"}</button>
      </form>
      {error && <div className="analyze-error">{error}</div>}
      {result && (<div className="analyze-result">
          <div className={`rec-main ${getRecommendationColor(result.recommendation)}`}>
            {result.recommendation || "—"}
          </div>
          <div className="rec-details">
            <span><strong>Confidence:</strong> {result.confidenceScore ?? "—"}</span>
            <span><strong>Decision Score:</strong> {result.decisionScore ?? "—"}</span>
          </div>
          <div className="rec-pricing">
            <span><strong>Entry Range:</strong> {result.targetEntryRange ?? "—"}</span>
            <span><strong>Exit Target:</strong> {result.targetExit ?? "—"}</span>
          </div>
          {explanationPoints.length > 0 && (<div className="rec-explanation">
              <strong>Explanation:</strong>
              <ul>
                {explanationPoints.map((pt, i) => <li key={i}>{pt}</li>)}
              </ul>
            </div>)}
        </div>)}
    </div>);
}
