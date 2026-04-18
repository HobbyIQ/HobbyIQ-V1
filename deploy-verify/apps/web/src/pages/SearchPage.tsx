
import { useState } from "react";
import { API_BASE_URL } from "../api";
import MultimodalInput from "../components/MultimodalInput";

const EXAMPLES = [
  "Is Brady Ebel good?",
  "What is a Roman Anthony gold shimmer worth?",
  "Should I sell Bonemer now?",
  "Compare blue auto vs purple auto for Gavin Kilen"
];

export default function SearchPage() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<any>(null);
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [feedbackSent, setFeedbackSent] = useState<null | "helpful" | "not_helpful">(null);

  // Minimal search handler for beta readiness
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
        body: JSON.stringify({ query: input })
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch (jsonErr) {
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
    } catch (e: any) {
      setError("Network error. Please try again.");
      setResponse(null);
    }
    setLoading(false);
  };

  // Feedback handler
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
          feedback
        })
      });
    } catch (e) {
      // ignore
    }
  };
            // Save to Portfolio handler (must be inside component to access response)
            const [saveStatus, setSaveStatus] = useState<null | 'saving' | 'success' | 'error'>(null);
            const handleSaveToPortfolio = async () => {
              if (!response || !response.result) return;
              setSaveStatus('saving');
              // Pre-fill fields
              const player = response.result.player || response.result.Player || '';
              const parallel = response.result.parallel || response.result.Parallel || response.result.set || '';
              const estimatedValue = response.result.FMV || response.result.estimatedValue || response.result.value || '';
              // Minimal: hardcode required fields for demo
              const card = {
                player,
                year: 2024,
                brand: 'Unknown',
                setName: parallel || 'Unknown',
                parallel: parallel || 'Base',
                isAuto: false,
                purchasePrice: estimatedValue || 0,
                purchaseDate: new Date().toISOString(),
                quantity: 1
              };
              try {
                const res = await fetch(`${API_BASE_URL}/api/portfolio/user-uuid/cards`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(card)
                });
                const data = await res.json();
                if (data.success) {
                  setSaveStatus('success');
                  setTimeout(() => setSaveStatus(null), 2000);
                } else {
                  setSaveStatus('error');
                }
              } catch {
                setSaveStatus('error');
              }
            };

  // Example click handler
  const handleExample = (example: string) => {
    setInput(example);
    setError(null);
    setResponse(null);
    setFeedbackSent(null);
    setSubmittedQuery(null);
  };

  return (
    <div style={{ maxWidth: 700, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <MultimodalInput
        value={input}
        onChange={setInput}
        onSubmit={handleSearch}
        loading={loading}
      />
      <div style={{ display: 'flex', gap: 10, marginBottom: 32, flexWrap: 'wrap', justifyContent: 'center', width: '100%', maxWidth: 520 }}>
        {EXAMPLES.map(example => (
          <button
            key={example}
            type="button"
            style={{
              background: '#f0f4ff',
              border: '1.5px solid #b6c6e3',
              borderRadius: 20,
              padding: '7px 18px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 15,
              color: '#1976d2',
              fontWeight: 500,
              marginBottom: 4,
              marginRight: 0,
              transition: 'background 0.2s, border 0.2s',
              boxShadow: '0 1px 4px #0001',
              opacity: loading ? 0.7 : 1
            }}
            onClick={() => handleExample(example)}
            disabled={loading}
          >
            {example}
          </button>
        ))}
      </div>
      {error && (
        <div style={{ color: "#b71c1c", background: "#fff0f0", borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 15, border: "1.5px solid #ffd6d6" }}>
          {error}
        </div>
      )}
      {submittedQuery && (
        <div style={{ marginBottom: 8, color: "#888", fontSize: 15, width: '100%', maxWidth: 520, textAlign: 'left' }}>
          <strong>Query:</strong> {submittedQuery}
        </div>
      )}
      {loading && (
        <div style={{ color: '#1976d2', fontSize: 16, margin: '24px 0', textAlign: 'center', width: '100%' }}>
          <span style={{ display: 'inline-block', marginRight: 8, verticalAlign: 'middle' }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="7" fill="#b2e0ff" stroke="#1976d2" strokeWidth="2"/><circle cx="9" cy="9" r="3" fill="#1976d2"/></svg>
          </span>
          Searching...
        </div>
      )}
      {response && !loading && (
        <div style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', marginTop: 0 }}>
          <div style={{
            background: "#fff",
            borderRadius: 18,
            padding: '28px 24px 22px 24px',
            margin: '0 0 32px 0',
            boxShadow: '0 2px 16px #0002',
            width: '100%',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            border: '1.5px solid #e3eafc',
            minHeight: 120
          }}>
            {response.intent && (
              <div style={{
                position: 'absolute',
                top: -18,
                left: 24,
                background: '#1976d2',
                color: '#fff',
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 700,
                padding: '4px 16px',
                letterSpacing: 1,
                boxShadow: '0 2px 8px #0002',
                border: '2px solid #fff',
                zIndex: 2,
                textShadow: '0 1px 2px #0002',
                textTransform: 'uppercase',
                outline: '2px solid #1976d2'
              }}>
                {response.intent.replace(/_/g, ' ')}
              </div>
            )}
            <h3 style={{ marginTop: 0, marginBottom: 10, color: '#1976d2', fontSize: 22, fontWeight: 700 }}>{response.title}</h3>
            <div style={{ marginBottom: 14, fontSize: 17, color: '#222', lineHeight: 1.6 }}>
              {/* Highlight key values for all major intents */}
              {response.result && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  {response.result.recommendation && (
                    <span style={{ background: '#e3f2fd', color: '#1976d2', fontWeight: 700, borderRadius: 6, padding: '2px 10px' }}>
                      {response.result.recommendation.toUpperCase()}
                    </span>
                  )}
                  {response.result.FMV && (
                    <span style={{ background: '#fffde7', color: '#bfa100', fontWeight: 700, borderRadius: 6, padding: '2px 10px' }}>
                      FMV: ${response.result.FMV}
                    </span>
                  )}
                  {response.result.confidence && (
                    <span style={{ background: '#e8f5e9', color: '#388e3c', fontWeight: 700, borderRadius: 6, padding: '2px 10px' }}>
                      Confidence: {response.result.confidence}
                    </span>
                  )}
                  {response.result.compRange && (
                    <span style={{ background: '#f3e5f5', color: '#7b1fa2', fontWeight: 700, borderRadius: 6, padding: '2px 10px' }}>
                      Comp Range: {response.result.compRange}
                    </span>
                  )}
                  {response.result.urgency && (
                    <span style={{ background: '#ffebee', color: '#b71c1c', fontWeight: 700, borderRadius: 6, padding: '2px 10px' }}>
                      Urgency: {response.result.urgency}
                    </span>
                  )}
                  {response.result.trend && (
                    <span style={{ background: '#e1f5fe', color: '#0288d1', fontWeight: 700, borderRadius: 6, padding: '2px 10px' }}>
                      Trend: {response.result.trend}
                    </span>
                  )}
                </div>
              )}
              <span>{response.summary}</span>
            </div>
            {response.bullets && response.bullets.length > 0 && (
              <ul style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 15,
                color: '#444',
                lineHeight: 1.5,
                listStyle: 'disc',
                background: '#f8fafc',
                borderRadius: 6,
                padding: '8px 14px',
                marginBottom: 0
              }}>
                {response.bullets.map((b: string, i: number) => (
                  <li key={i} style={{ marginBottom: 2 }}>{b}</li>
                ))}
              </ul>
            )}
            {/* Save to Portfolio button */}
            <div style={{ marginTop: 18, width: '100%' }}>
              <button
                onClick={handleSaveToPortfolio}
                disabled={saveStatus === 'saving'}
                style={{
                  background: '#1976d2',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 18px',
                  fontWeight: 600,
                  fontSize: 15,
                  cursor: saveStatus === 'saving' ? 'not-allowed' : 'pointer',
                  opacity: saveStatus === 'saving' ? 0.7 : 1,
                  marginBottom: 8
                }}
              >
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'success' ? 'Saved!' : saveStatus === 'error' ? 'Error' : 'Save to Portfolio'}
              </button>
              {saveStatus === 'error' && (
                <span style={{ color: '#b71c1c', marginLeft: 10 }}>Could not save. Try again.</span>
              )}
              {saveStatus === 'success' && (
                <span style={{ color: '#388e3c', marginLeft: 10 }}>Saved!</span>
              )}
            </div>
            {response.nextActions && response.nextActions.length > 0 && (
              <div style={{ marginTop: 18, background: '#f0f4ff', borderRadius: 8, padding: '10px 16px', color: '#1976d2', fontSize: 15, fontWeight: 500, width: '100%' }}>
                <div style={{ marginBottom: 4, fontWeight: 700, color: '#1976d2', fontSize: 15 }}>Next actions:</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 15, color: '#1976d2', lineHeight: 1.5, listStyle: 'circle' }}>
                  {response.nextActions.map((a: string, i: number) => (
                    <li key={i} style={{ marginBottom: 2 }}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {/* Highlight key values for all intents */}
            {response.result && Object.keys(response.result).length > 0 && (
              <div style={{ marginTop: 16, width: '100%' }}>
                {/* ...existing intent-specific UI... */}
                {/* Feedback buttons */}
                <div style={{ marginTop: 18, display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 15, color: '#888', marginRight: 8 }}>Was this helpful?</span>
                  <button
                    onClick={() => sendFeedback("helpful")}
                    disabled={feedbackSent === "helpful"}
                    style={{
                      background: feedbackSent === "helpful" ? '#e3f2fd' : '#f0f4ff',
                      color: '#1976d2',
                      border: '1.5px solid #b6c6e3',
                      borderRadius: 8,
                      padding: '4px 14px',
                      fontWeight: 600,
                      fontSize: 15,
                      cursor: feedbackSent ? 'not-allowed' : 'pointer',
                      opacity: feedbackSent && feedbackSent !== "helpful" ? 0.6 : 1
                    }}
                  >
                    👍 Helpful
                  </button>
                  <button
                    onClick={() => sendFeedback("not_helpful")}
                    disabled={feedbackSent === "not_helpful"}
                    style={{
                      background: feedbackSent === "not_helpful" ? '#ffebee' : '#f0f4ff',
                      color: '#b71c1c',
                      border: '1.5px solid #e57373',
                      borderRadius: 8,
                      padding: '4px 14px',
                      fontWeight: 600,
                      fontSize: 15,
                      cursor: feedbackSent ? 'not-allowed' : 'pointer',
                      opacity: feedbackSent && feedbackSent !== "not_helpful" ? 0.6 : 1
                    }}
                  >
                    👎 Not helpful
                  </button>
                  {feedbackSent && (
                    <span style={{ marginLeft: 10, color: '#388e3c', fontSize: 15, fontWeight: 500 }}>
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

