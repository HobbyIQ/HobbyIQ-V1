import React, { useState } from "react";

const defaultForm = {
  player: "Roman Anthony",
  set: "Bowman Chrome",
  parallel: "base",
  grade: "RAW",
  isAuto: false
};

const gradeOptions = ["RAW", "PSA 10", "PSA 9"];

export default function App() {
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [portfolio, setPortfolio] = useState([]);
  const [portfolioResults, setPortfolioResults] = useState([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  const handleChange = e => {
    const { name, value, type, checked } = e.target;
    setForm(f => ({
      ...f,
      [name]: type === "checkbox" ? checked : value
    }));
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const resp = await fetch("/compiq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data && data.error ? data.error : "Unknown backend error.");
      setResult(data);
    } catch (err) {
      setError(err.message || "Network or server error.");
    }
    setLoading(false);
  };

  // Portfolio logic
  const [purchasePrice, setPurchasePrice] = useState("");
  const handleAddCard = () => {
    if (!form.player || !form.set || !form.parallel || !form.grade || !purchasePrice) return;
    setPortfolio(p => [
      ...p,
      {
        ...form,
        purchasePrice: Number(purchasePrice)
      }
    ]);
    setPurchasePrice("");
  };

  const handleEvaluatePortfolio = async () => {
    setPortfolioLoading(true);
    setError("");
    setPortfolioResults([]);
    try {
      const resp = await fetch("/portfolio/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(portfolio)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data && data.error ? data.error : "Unknown backend error.");
      setPortfolioResults(data);
    } catch (err) {
      setError(err.message || "Network or server error.");
    }
    setPortfolioLoading(false);
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#181c24",
      color: "#f3f6fa",
      fontFamily: "Inter, sans-serif",
      padding: 0,
      margin: 0
    }}>
      <div style={{ maxWidth: 520, margin: "40px auto", padding: 24, background: "#232837", borderRadius: 12, boxShadow: "0 2px 12px #0002" }}>
        <h2 style={{ marginTop: 0, color: "#90caf9" }}>CompIQ Card Analyzer</h2>
        <form onSubmit={handleSubmit} style={{ marginBottom: 24 }}>
          <div style={{ marginBottom: 12 }}>
            <label>Player:<br />
              <input name="player" value={form.player} onChange={handleChange} style={{ width: 220, background: "#222", color: "#fff", border: "1px solid #444", borderRadius: 4, padding: 6 }} required />
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>Set:<br />
              <input name="set" value={form.set} onChange={handleChange} style={{ width: 220, background: "#222", color: "#fff", border: "1px solid #444", borderRadius: 4, padding: 6 }} required />
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>Parallel:<br />
              <input name="parallel" value={form.parallel} onChange={handleChange} style={{ width: 180, background: "#222", color: "#fff", border: "1px solid #444", borderRadius: 4, padding: 6 }} required />
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>Grade:<br />
              <select name="grade" value={form.grade} onChange={handleChange} style={{ width: 120, background: "#222", color: "#fff", border: "1px solid #444", borderRadius: 4, padding: 6 }}>
                {gradeOptions.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>
              <input type="checkbox" name="isAuto" checked={form.isAuto} onChange={handleChange} style={{ marginRight: 8 }} />
              Auto
            </label>
          </div>
          <button type="submit" style={{ padding: "10px 28px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, fontSize: 16, cursor: "pointer" }} disabled={loading}>
            {loading ? "Analyzing..." : "Analyze Card"}
          </button>
        </form>
        {error && <div style={{ color: "#ff5252", marginBottom: 16 }}>{error}</div>}
        {result && (
          <div style={{ background: "#232b3a", padding: 18, borderRadius: 8, marginBottom: 24, boxShadow: "0 1px 4px #0003" }}>
            <div><strong>Median Price:</strong> {result.median ? `$${result.median}` : "-"}</div>
            <div><strong>Range:</strong> {result.range ? `$${result.range.low} - $${result.range.high}` : "-"}</div>
            <div><strong>Confidence:</strong> {result.confidence}</div>
            <div><strong>Decision:</strong> {result.decision?.signal}</div>
            <div><strong>Risk Level:</strong> {result.risk?.level}</div>
          </div>
        )}
        <h3 style={{ color: "#90caf9", marginTop: 32 }}>Portfolio</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input name="purchasePrice" value={purchasePrice} onChange={e => setPurchasePrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Purchase Price" style={{ width: 120, background: "#222", color: "#fff", border: "1px solid #444", borderRadius: 4, padding: 6 }} />
          <button type="button" onClick={handleAddCard} style={{ padding: "8px 18px", background: "#388e3c", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer" }}>Add Card</button>
          <button type="button" onClick={handleEvaluatePortfolio} style={{ padding: "8px 18px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer" }} disabled={portfolioLoading || portfolio.length === 0}>{portfolioLoading ? "Evaluating..." : "Evaluate Portfolio"}</button>
        </div>
        {portfolio.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <table style={{ width: "100%", background: "#181c24", color: "#f3f6fa", borderRadius: 6, overflow: "hidden", fontSize: 15 }}>
              <thead>
                <tr style={{ background: "#232b3a" }}>
                  <th style={{ padding: 8, textAlign: "left" }}>Player</th>
                  <th style={{ padding: 8 }}>Value</th>
                  <th style={{ padding: 8 }}>ROI</th>
                  <th style={{ padding: 8 }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {portfolioResults.length > 0 ? portfolioResults.map((c, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #222" }}>
                    <td style={{ padding: 8 }}>{c.player}</td>
                    <td style={{ padding: 8 }}>{c.currentValue !== null ? `$${c.currentValue}` : "-"}</td>
                    <td style={{ padding: 8 }}>{c.roi !== null ? `${c.roi}%` : "-"}</td>
                    <td style={{ padding: 8 }}>{c.decision}</td>
                  </tr>
                )) : portfolio.map((c, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #222" }}>
                    <td style={{ padding: 8 }}>{c.player}</td>
                    <td style={{ padding: 8 }}>-</td>
                    <td style={{ padding: 8 }}>-</td>
                    <td style={{ padding: 8 }}>-</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
