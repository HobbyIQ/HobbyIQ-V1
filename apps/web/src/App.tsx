import React, { useState } from "react";
import PortfolioPage from "./PortfolioPage";

type ConfidenceDetails = {
  score: number;
  compCount: number;
  avgMatch: number;
  avgRecency: number;
  gradeConsistency: number;
  parallelConsistency: number;
};
type FmvSummary = {
  fmv: number;
  low: number;
  high: number;
  compCount: number;
  confidence: string;
  confidenceDetails?: ConfidenceDetails;
  methodology: string;
};

type GradeBucket = {
  label: string;
  compCount: number;
  fmv: number;
  low: number;
  high: number;
};

type NormalizedComp = {
  title: string;
  grade: string | null;
  parallel: string | null;
  totalPrice: number;
  soldDate: string | null;
  sourceUrl: string | null;
  matchScore: number;
};

type ApiResponse = {
  query: string;
  summary: FmvSummary;
  buckets: GradeBucket[];
  comps: NormalizedComp[];
};

const API_URL = "http://localhost:4000/api/comps/search";


  const [page, setPage] = useState<'comps' | 'portfolio'>("comps");
  // ...existing state for comps search
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResponse | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_URL}?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 950, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <nav style={{ display: "flex", gap: 24, marginBottom: 32 }}>
        <button onClick={() => setPage("comps")} style={{ fontWeight: page === "comps" ? 700 : 400 }}>
          CompIQ Pricing
        </button>
        <button onClick={() => setPage("portfolio")} style={{ fontWeight: page === "portfolio" ? 700 : 400 }}>
          Portfolio
        </button>
      </nav>
      {page === "comps" ? (
        <>
          <h1 style={{ textAlign: "center" }}>CompIQ Pricing Engine</h1>
          <form onSubmit={handleSearch} style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search player or card"
              style={{ width: 320, padding: 10, fontSize: 16, borderRadius: 4, border: "1px solid #ccc" }}
            />
            <button
              type="submit"
              style={{
                marginLeft: 12,
                padding: "10px 22px",
                fontSize: 16,
                borderRadius: 4,
                border: "none",
                background: "#1976d2",
                color: "#fff",
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.7 : 1,
              }}
              disabled={loading}
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </form>
          {error && <div style={{ color: "red", marginBottom: 16, textAlign: "center" }}>Error: {error}</div>}
          {result && (
            <>
              {/* FMV Summary Card */}
              <div
                style={{
                  border: "1px solid #1976d2",
                  background: "#f5faff",
                  padding: 20,
                  borderRadius: 8,
                  marginBottom: 28,
                  maxWidth: 600,
                  marginLeft: "auto",
                  marginRight: "auto",
                  boxShadow: "0 2px 8px #eee",
                }}
              >
                <h2 style={{ margin: 0, color: "#1976d2" }}>
                  FMV: {" "}
                  <span style={{ fontWeight: 700 }}>
                    {result.summary.fmv > 0 ? `$${result.summary.fmv.toLocaleString()}` : "N/A"}
                  </span>
                </h2>
                <div style={{ marginTop: 8 }}>
                  <b>Range:</b>{" "}
                  {result.summary.low && result.summary.high
                    ? `$${result.summary.low} - $${result.summary.high}`
                    : "N/A"}
                </div>
                <div>
                  <b>Confidence:</b>{" "}
                  <span
                    style={{
                      color:
                        result.summary.confidence === "High"
                          ? "green"
                          : result.summary.confidence === "Medium"
                          ? "#e6b800"
                          : "red",
                      fontWeight: 600,
                    }}
                  >
                    {result.summary.confidence}
                  </span>
                  {result.summary.confidenceDetails && (
                    <span style={{ fontSize: 13, color: "#555", marginLeft: 8 }}>
                      (Score: {result.summary.confidenceDetails.score},
                      Avg Match: {result.summary.confidenceDetails.avgMatch.toFixed(1)},
                      Recency: {result.summary.confidenceDetails.avgRecency.toFixed(1)}d,
                      Grade: {result.summary.confidenceDetails.gradeConsistency},
                      Parallel: {result.summary.confidenceDetails.parallelConsistency})
                    </span>
                  )}
                </div>
                <div>
                  <b>Comps Used:</b> {result.summary.compCount}
                </div>
                <div style={{ fontSize: 13, color: "#555", marginTop: 8 }}>
                  <b>Methodology:</b> {result.summary.methodology}
                </div>
              </div>

              {/* Grade Buckets */}
              <div style={{ marginBottom: 32 }}>
                <h3>Grade Buckets</h3>
                <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                  {result.buckets.length === 0 && <span>No grade buckets found.</span>}
                  {result.buckets.map(bucket => (
                    <div
                      key={bucket.label}
                      style={{
                        border: "1px solid #ccc",
                        borderRadius: 6,
                        padding: 14,
                        minWidth: 120,
                        background: "#fafbfc",
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{bucket.label}</div>
                      <div>
                        <b>FMV:</b> {bucket.fmv > 0 ? `$${bucket.fmv}` : "N/A"}
                      </div>
                      <div>
                        <b>Range:</b> {bucket.low && bucket.high ? `$${bucket.low} - $${bucket.high}` : "N/A"}
                      </div>
                      <div>
                        <b>Comps:</b> {bucket.compCount}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Comps Table */}
              <div>
                <h3>Recent Comps</h3>
                {result.comps.length === 0 ? (
                  <div style={{ color: "#888", margin: "16px 0" }}>No comps found for this search.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff" }}>
                      <thead>
                        <tr style={{ background: "#f0f4f8" }}>
                          <th style={thStyle}>Title</th>
                          <th style={thStyle}>Grade</th>
                          <th style={thStyle}>Parallel</th>
                          <th style={thStyle}>Total Price</th>
                          <th style={thStyle}>Sold Date</th>
                          <th style={thStyle}>Source</th>
                          <th style={thStyle}>Match</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.comps.map((comp, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={tdStyle}>{comp.title}</td>
                            <td style={tdStyle}>{comp.grade || "RAW"}</td>
                            <td style={tdStyle}>{comp.parallel || ""}</td>
                            <td style={tdStyle}>${comp.totalPrice}</td>
                            <td style={tdStyle}>{comp.soldDate ? new Date(comp.soldDate).toLocaleDateString() : ""}</td>
                            <td style={tdStyle}>
                              {comp.sourceUrl ? (
                                <a href={comp.sourceUrl} target="_blank" rel="noopener noreferrer">
                                  Link
                                </a>
                              ) : (
                                ""
                              )}
                            </td>
                            <td style={tdStyle}>{comp.matchScore}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <PortfolioPage />
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "2px solid #ddd",
  textAlign: "left",
  fontWeight: 600,
  fontSize: 15,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 15,
};

export default App;
