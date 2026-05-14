
import React, { useState, useRef, useEffect } from "react";
import { API_BASE_URL } from "../api";
import "./SearchChat.css";

const API_URL = `${API_BASE_URL}/api/compiq`;

const MAX_FREE_SEARCHES = 3;

const SearchChat = () => {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [searchCount, setSearchCount] = useState<number>(0);
  const [userTier, setUserTier] = useState<string>(() => {
    return localStorage.getItem("hobbyiq_user_tier") || "FREE";
  });
  const isMounted = useRef(true);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // On mount, load search count from localStorage
  useEffect(() => {
    isMounted.current = true;
    const stored = localStorage.getItem("hobbyiq_search_count");
    setSearchCount(stored ? parseInt(stored, 10) : 0);
    const tier = localStorage.getItem("hobbyiq_user_tier") || "FREE";
    setUserTier(tier);
    return () => { isMounted.current = false; };
  }, []);

  // Helper: is search allowed
  const isSearchAllowed = userTier === "FREE" ? searchCount < MAX_FREE_SEARCHES : true;

  // Handle search
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    if (!isSearchAllowed) return;
    if (!loading) setLoading(true);
    if (error !== null) setError(null);
    if (result !== null) setResult(null);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });
      if (!res.ok) {
        if (isMounted.current) {
          if (error !== "Error fetching data. Please try again later.") setError("Error fetching data. Please try again later.");
          if (result !== null) setResult(null);
        }
        return;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        if (isMounted.current) {
          if (error !== "Invalid response from server.") setError("Invalid response from server.");
          if (result !== null) setResult(null);
        }
        return;
      }
      // Validate response shape: must have at least comps or keyNumbers or directAnswer
      const hasComps = data && data.expandable && Array.isArray(data.expandable.comps) && data.expandable.comps.length > 0;
      const hasKeyNumbers = data && data.keyNumbers && typeof data.keyNumbers === "object" && Object.keys(data.keyNumbers).length > 0;
      const hasDirectAnswer = data && (data.directAnswer || data.title);
      if (!hasComps && !hasKeyNumbers && !hasDirectAnswer) {
        if (isMounted.current) {
          if (error !== "No comps found") setError("No comps found");
          if (result !== null) setResult(null);
        }
        return;
      }
      // Increment search count for FREE tier
      if (userTier === "FREE") {
        const newCount = searchCount + 1;
        setSearchCount(newCount);
        localStorage.setItem("hobbyiq_search_count", newCount.toString());
      }
      if (isMounted.current) setResult(data);
    } catch {
      if (isMounted.current) {
        if (error !== "Network error. Please check your connection and try again.") setError("Network error. Please check your connection and try again.");
        if (result !== null) setResult(null);
      }
    } finally {
      if (isMounted.current) setLoading(false);
    }
  };

  return (
    <div className="search-chat-analyzer">
      <h2>HobbyIQ Analyzer</h2>
      <form onSubmit={handleSearch} className="search-chat-analyzer-form">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search player or card"
          className="search-chat-analyzer-input"
        />
        <button
          type="submit"
          className={`search-chat-analyzer-button ${isSearchAllowed ? "" : "search-chat-analyzer-button-disabled"}`.trim()}
          disabled={loading || !isSearchAllowed}
        >
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </form>
      {userTier === "FREE" && !isSearchAllowed && (
        <div className="search-chat-analyzer-upgrade">
          Upgrade to Pro or All-Star for unlimited access
        </div>
      )}
      {error && <div className="search-chat-analyzer-error">{error}</div>}
      {loading && <div className="search-chat-analyzer-loading">Loading...</div>}
      {result && (
        <div ref={resultRef} className="search-chat-analyzer-result-card">
          <div className="search-chat-analyzer-result-title">{result.title || result.directAnswer || "Result"}</div>
          {result.keyNumbers && typeof result.keyNumbers === "object" && Object.keys(result.keyNumbers).length > 0 && (
            <div className="search-chat-analyzer-keynumbers">
              <div><b>Median:</b> {result.keyNumbers.FMV !== undefined && result.keyNumbers.FMV !== null && result.keyNumbers.FMV !== '' ? `$${result.keyNumbers.FMV}` : 'N/A'}</div>
              <div><b>Range:</b> {
                result.keyNumbers.Range && typeof result.keyNumbers.Range === 'object' && result.keyNumbers.Range.low !== undefined && result.keyNumbers.Range.high !== undefined
                  ? `$${result.keyNumbers.Range.low} - $${result.keyNumbers.Range.high}`
                  : (typeof result.keyNumbers.Range === 'string' && result.keyNumbers.Range !== ''
                      ? result.keyNumbers.Range
                      : 'N/A')
              }</div>
              <div><b>Decision:</b> {
                result.keyNumbers.Decision && typeof result.keyNumbers.Decision === 'object' && result.keyNumbers.Decision.signal
                  ? result.keyNumbers.Decision.signal
                  : (typeof result.keyNumbers.Decision === 'string' && result.keyNumbers.Decision !== ''
                      ? result.keyNumbers.Decision
                      : 'N/A')
              }</div>
              <div><b>Risk:</b> {
                result.keyNumbers.RiskLevel && typeof result.keyNumbers.RiskLevel === 'object' && result.keyNumbers.RiskLevel.level
                  ? result.keyNumbers.RiskLevel.level
                  : (typeof result.keyNumbers.RiskLevel === 'string' && result.keyNumbers.RiskLevel !== ''
                      ? result.keyNumbers.RiskLevel
                      : 'N/A')
              }</div>
              {result.keyNumbers.Confidence && <div><b>Confidence:</b> {result.keyNumbers.Confidence}</div>}
            </div>
          )}
          {result.why && Array.isArray(result.why) && result.why.length > 0 && (
            <ul className="search-chat-analyzer-why-list">
              {result.why.map((w: string, i: number) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {result.tags && Array.isArray(result.tags) && result.tags.length > 0 && (
            <div className="search-chat-analyzer-tags">
              {result.tags.map((tag: string, i: number) => (
                <span key={i} className="search-chat-analyzer-tag">{tag}</span>
              ))}
            </div>
          )}
          {result.expandable && result.expandable.comps && Array.isArray(result.expandable.comps) && result.expandable.comps.length > 0 && (
            <div className="search-chat-analyzer-comps">
              <b>Recent Comps:</b>
              <ul className="search-chat-analyzer-comps-list">
                {result.expandable.comps.map((comp: any, i: number) => (
                  <li key={i} className="search-chat-analyzer-comp-row">
                    ${comp.price} <span className="search-chat-analyzer-comp-date">{comp.date}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchChat;
