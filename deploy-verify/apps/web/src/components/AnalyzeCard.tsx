import React, { useState } from "react";
import "./AnalyzeCard.css";
import { API_BASE_URL } from "../api";

type Result = {
  decisionScore?: number;
  recommendation?: string;
  confidenceScore?: number;
  targetEntryRange?: string;
  targetExit?: string;
  explanation?: string;
};

function getRecommendationColor(rec?: string) {
  if (!rec) return "";
  const r = rec.toLowerCase();
  if (r.includes("buy")) return "rec-green";
  if (r.includes("hold")) return "rec-yellow";
  if (r.includes("sell")) return "rec-red";
  return "";
}

export default function AnalyzeCard() {
  const [form, setForm] = useState({
    fmv: "",
    trend: "",
    liquidity: "",
    playerScore: "",
    dailyScore: "",
    supplyScore: "",
    scarcityScore: "",
    negativePressureScore: "",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/hobbyiq/analyze`, {
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
      if (!res.ok) throw new Error("Failed to analyze card");
      const data = await res.json();
      setResult({
        decisionScore: data.decisionScore,
        recommendation: data.recommendation,
        confidenceScore: data.confidenceScore,
        targetEntryRange: data.targetEntryRange,
        targetExit: data.targetExit,
        explanation: data.explanation,
      });
    } catch (err: any) {
      setError(err.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // Split explanation into bullet points
  const explanationPoints = result?.explanation
    ? result.explanation.split(/[\n•\-]+/).map(s => s.trim()).filter(Boolean)
    : [];

  return (
    <div className="analyze-container">
      <h2>Analyze Card</h2>
      <form onSubmit={handleSubmit} className="analyze-form">
        <input name="fmv" type="number" placeholder="FMV" value={form.fmv} onChange={handleChange} required />
        <input name="trend" type="number" placeholder="Trend" value={form.trend} onChange={handleChange} required />
        <input name="liquidity" type="number" placeholder="Liquidity" value={form.liquidity} onChange={handleChange} required />
        <input name="playerScore" type="number" placeholder="Player Score" value={form.playerScore} onChange={handleChange} required />
        <input name="dailyScore" type="number" placeholder="Daily Score" value={form.dailyScore} onChange={handleChange} required />
        <input name="supplyScore" type="number" placeholder="Supply Score" value={form.supplyScore} onChange={handleChange} required />
        <input name="scarcityScore" type="number" placeholder="Scarcity Score" value={form.scarcityScore} onChange={handleChange} required />
        <input name="negativePressureScore" type="number" placeholder="Negative Pressure Score" value={form.negativePressureScore} onChange={handleChange} required />
        <button type="submit" disabled={loading}>{loading ? "Analyzing..." : "Analyze"}</button>
      </form>
      {error && <div className="analyze-error">{error}</div>}
      {result && (
        <div className="analyze-result">
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
          {explanationPoints.length > 0 && (
            <div className="rec-explanation">
              <strong>Explanation:</strong>
              <ul>
                {explanationPoints.map((pt, i) => <li key={i}>{pt}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
