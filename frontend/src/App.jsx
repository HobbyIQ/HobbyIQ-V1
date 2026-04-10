import React, { useState } from "react";

const defaultState = {
  player: "Roman Anthony",
  cardName: "Bowman Chrome Auto",
  grade: "PSA 10",
  gemRate: 30,
  popGrowth30d: 5,
  trendMultiplier: 1.1
};

export default function App() {
  const [form, setForm] = useState(defaultState);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const handleChange = e => {
    const { name, value } = e.target;
    setForm(f => ({
      ...f,
      [name]: name === "gemRate" || name === "popGrowth30d" || name === "trendMultiplier"
        ? value.replace(/[^0-9.]/g, "")
        : value
    }));
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const resp = await fetch("http://localhost:4000/scarcity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          gemRate: Number(form.gemRate),
          popGrowth30d: Number(form.popGrowth30d),
          trendMultiplier: Number(form.trendMultiplier)
        })
      });
      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setError("Invalid JSON response from backend.");
        setLoading(false);
        return;
      }
      if (!resp.ok || !data.success) {
        setError(data && data.error ? data.error : "Unknown backend error.");
        setLoading(false);
        return;
      }
      setResult(data);
    } catch (err) {
      setError("Network or server error.");
    }
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>HobbyIQ Scarcity & Pricing</h2>
      <form onSubmit={handleSubmit} style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 8 }}>
          <label>
            Player:{" "}
            <input
              name="player"
              value={form.player}
              onChange={handleChange}
              style={{ width: 200 }}
              required
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Card Name:{" "}
            <input
              name="cardName"
              value={form.cardName}
              onChange={handleChange}
              style={{ width: 200 }}
              required
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Grade:{" "}
            <input
              name="grade"
              value={form.grade}
              onChange={handleChange}
              style={{ width: 120 }}
              required
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Gem Rate:{" "}
            <input
              name="gemRate"
              value={form.gemRate}
              onChange={handleChange}
              style={{ width: 80 }}
              required
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Pop Growth 30d:{" "}
            <input
              name="popGrowth30d"
              value={form.popGrowth30d}
              onChange={handleChange}
              style={{ width: 80 }}
              required
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Trend Multiplier:{" "}
            <input
              name="trendMultiplier"
              value={form.trendMultiplier}
              onChange={handleChange}
              style={{ width: 80 }}
              required
            />
          </label>
        </div>
        <button
          type="submit"
          style={{
            padding: "8px 20px",
            background: "#1976d2",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer"
          }}
          disabled={loading}
        >
          {loading ? "Loading..." : "Run Pricing"}
        </button>
      </form>
      {error && (
        <div style={{ color: "red", marginBottom: 16 }}>{error}</div>
      )}
      {result && (
        <div style={{ background: "#f6f8fa", padding: 16, borderRadius: 6 }}>
          <div>
            <strong>Estimated FMV:</strong> ${result.estimatedFMV}
          </div>
          <div>
            <strong>Scarcity Score:</strong> {result.scarcityScore}
          </div>
          <div>
            <strong>Confidence:</strong> {result.confidence}
          </div>
          <div>
            <strong>Query:</strong> {result.query}
          </div>
          <div>
            <strong>Median Price:</strong> ${result.medianPrice}
          </div>
          <div>
            <strong>Comp Count:</strong> {result.compCount}
          </div>
          <details style={{ marginTop: 8 }}>
            <summary>Breakdown</summary>
            <pre style={{ fontSize: 13, margin: 0 }}>
              {JSON.stringify(result.breakdown, null, 2)}
            </pre>
          </details>
          <details style={{ marginTop: 8 }}>
            <summary>Comps</summary>
            <pre style={{ fontSize: 13, margin: 0 }}>
              {JSON.stringify(result.comps, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
