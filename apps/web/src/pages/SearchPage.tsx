
import { useState } from "react";
import { API_BASE_URL } from "../api";
import MultimodalInput from "../components/MultimodalInput";
import "./SearchPage.css";

const EXAMPLES = [
  "Is Brady Ebel good?",
  "What is a Roman Anthony gold shimmer worth?",
  "Should I sell Bonemer now?",
  "Compare blue auto vs purple auto for Gavin Kilen",
];

export default function SearchPage() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<any>(null);
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [feedbackSent, setFeedbackSent] = useState<null | "helpful" | "not_helpful">(null);
  const [saveStatus, setSaveStatus] = useState<null | "saving" | "success" | "error">(null);

  const handleSearch = async () => {
    if (!input.trim()) {
      setError("Please enter a question about a player, card, or market.");
      setResponse(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResponse(null);
    setFeedbackSent(null);
    setSubmittedQuery(input);
    try {
      const res = await fetch(`${API_BASE_URL}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: input }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        setError("Malformed response from server. Please try again later.");
        setResponse(null);
        setLoading(false);
        return;
      }
      if (!res.ok || data?.error) {
        setError(data?.error || "Search failed. Try again.");
        setResponse(null);
      } else {
        setResponse({
          intent: data.intent || "unknown",
          title: data.title || data.directAnswer || "Result",
          result: data.result || data.keyNumbers || {},
          summary: data.summary || data.directAnswer || "",
          bullets: data.bullets || data.why || [],
          nextActions: data.nextActions || [],
        });
      }
    } catch {
      setError("Network error. Please try again.");
      setResponse(null);
    }
    setLoading(false);
  };

  const sendFeedback = async (feedback: "helpful" | "not_helpful") => {
    if (!submittedQuery || !response) return;
    setFeedbackSent(feedback);
    try {
      await fetch(`${API_BASE_URL}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: submittedQuery,
          intent: response.intent,
          result: response.result,
          feedback,
        }),
      });
    } catch {
      // ignore
    }
  };

  const handleSaveToPortfolio = async () => {
    if (!response || !response.result) return;
    setSaveStatus("saving");
    const player = response.result.player || response.result.Player || "";
    const parallel = response.result.parallel || response.result.Parallel || response.result.set || "";
    const estimatedValue = response.result.FMV || response.result.estimatedValue || response.result.value || "";
    const card = {
      player,
      year: 2024,
      brand: "Unknown",
      setName: parallel || "Unknown",
      parallel: parallel || "Base",
      isAuto: false,
      purchasePrice: estimatedValue || 0,
      purchaseDate: new Date().toISOString(),
      quantity: 1,
    };
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolio/user-uuid/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card),
      });
      const data = await res.json();
      if (data.success) {
        setSaveStatus("success");
        setTimeout(() => setSaveStatus(null), 2000);
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    }
  };

  const handleExample = (example: string) => {
    setInput(example);
    setError(null);
    setResponse(null);
    setFeedbackSent(null);
    setSubmittedQuery(null);
  };

  return (
    <div className="search-page">
      <MultimodalInput value={input} onChange={setInput} onSubmit={handleSearch} loading={loading} />

      <div className="search-page__examples">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="search-page__example-btn"
            onClick={() => handleExample(example)}
            disabled={loading}
          >
            {example}
          </button>
        ))}
      </div>

      {error && <div className="search-page__error">{error}</div>}

      {submittedQuery && (
        <div className="search-page__query">
          <strong>Query:</strong> {submittedQuery}
        </div>
      )}

      {loading && (
        <div className="search-page__loading">
          <span className="search-page__loading-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" fill="#b2e0ff" stroke="#1976d2" strokeWidth="2" /><circle cx="9" cy="9" r="3" fill="#1976d2" /></svg>
          </span>
          Searching...
        </div>
      )}

      {response && !loading && (
        <div className="search-page__result-wrap">
          <div className="search-page__result-card">
            {response.intent && (
              <div className="search-page__intent-badge">{response.intent.replace(/_/g, " ")}</div>
            )}

            <h3 className="search-page__title">{response.title}</h3>

            <div className="search-page__summary">
              {response.result && (
                <div className="search-page__chips">
                  {response.result.recommendation && (
                    <span className="search-page__chip search-page__chip--recommendation">
                      {response.result.recommendation.toUpperCase()}
                    </span>
                  )}
                  {response.result.FMV && <span className="search-page__chip search-page__chip--fmv">FMV: ${response.result.FMV}</span>}
                  {response.result.confidence && <span className="search-page__chip search-page__chip--confidence">Confidence: {response.result.confidence}</span>}
                  {response.result.compRange && <span className="search-page__chip search-page__chip--range">Comp Range: {response.result.compRange}</span>}
                  {response.result.urgency && <span className="search-page__chip search-page__chip--urgency">Urgency: {response.result.urgency}</span>}
                  {response.result.trend && <span className="search-page__chip search-page__chip--trend">Trend: {response.result.trend}</span>}
                </div>
              )}
              <span>{response.summary}</span>
            </div>

            {response.bullets && response.bullets.length > 0 && (
              <ul className="search-page__bullets">
                {response.bullets.map((b: string, i: number) => (
                  <li key={i} className="search-page__bullet-item">{b}</li>
                ))}
              </ul>
            )}

            <div className="search-page__portfolio-save">
              <button
                onClick={handleSaveToPortfolio}
                disabled={saveStatus === "saving"}
                className="search-page__save-btn"
              >
                {saveStatus === "saving"
                  ? "Saving..."
                  : saveStatus === "success"
                    ? "Saved!"
                    : saveStatus === "error"
                      ? "Error"
                      : "Save to Portfolio"}
              </button>

              {saveStatus === "error" && (
                <span className="search-page__save-error">Could not save. Try again.</span>
              )}
              {saveStatus === "success" && (
                <span className="search-page__save-success">Saved!</span>
              )}
            </div>

            {response.nextActions && response.nextActions.length > 0 && (
              <div className="search-page__next-actions">
                <div className="search-page__next-actions-title">Next actions:</div>
                <ul className="search-page__next-actions-list">
                  {response.nextActions.map((a: string, i: number) => (
                    <li key={i} className="search-page__next-actions-item">{a}</li>
                  ))}
                </ul>
              </div>
            )}

            {response.result && Object.keys(response.result).length > 0 && (
              <div className="search-page__feedback-wrap">
                <div className="search-page__feedback-row">
                  <span className="search-page__feedback-label">Was this helpful?</span>

                  <button
                    onClick={() => sendFeedback("helpful")}
                    disabled={feedbackSent === "helpful"}
                    className={`search-page__feedback-btn search-page__feedback-btn--helpful ${feedbackSent === "helpful" ? "is-selected" : ""}`}
                  >
                    👍 Helpful
                  </button>

                  <button
                    onClick={() => sendFeedback("not_helpful")}
                    disabled={feedbackSent === "not_helpful"}
                    className={`search-page__feedback-btn search-page__feedback-btn--not-helpful ${feedbackSent === "not_helpful" ? "is-selected" : ""}`}
                  >
                    👎 Not helpful
                  </button>

                  {feedbackSent && (
                    <span className="search-page__feedback-confirm">
                      {feedbackSent === "helpful" ? "Thank you!" : "Feedback noted."}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

