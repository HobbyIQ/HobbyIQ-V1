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
const react_1 = __importStar(require("react"));
const api_1 = require("../api");
const API_URL = `${api_1.API_BASE_URL}/api/compiq`;
const MAX_FREE_SEARCHES = 3;
const TIERS = ["FREE", "PRO", "ALL-STAR"];
const SearchChat = () => {
    const [query, setQuery] = (0, react_1.useState)("");
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    const [result, setResult] = (0, react_1.useState)(null);
    const [searchCount, setSearchCount] = (0, react_1.useState)(0);
    const [userTier, setUserTier] = (0, react_1.useState)(() => {
        return localStorage.getItem("hobbyiq_user_tier") || "FREE";
    });
    const isMounted = (0, react_1.useRef)(true);
    const resultRef = (0, react_1.useRef)(null);
    // On mount, load search count from localStorage
    (0, react_1.useEffect)(() => {
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
    const handleSearch = async (e) => {
        e.preventDefault();
        if (!query.trim())
            return;
        if (!isSearchAllowed)
            return;
        if (!loading)
            setLoading(true);
        if (error !== null)
            setError(null);
        if (result !== null)
            setResult(null);
        try {
            const res = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query })
            });
            if (!res.ok) {
                if (isMounted.current) {
                    if (error !== "Error fetching data. Please try again later.")
                        setError("Error fetching data. Please try again later.");
                    if (result !== null)
                        setResult(null);
                }
                return;
            }
            let data;
            try {
                data = await res.json();
            }
            catch (jsonErr) {
                if (isMounted.current) {
                    if (error !== "Invalid response from server.")
                        setError("Invalid response from server.");
                    if (result !== null)
                        setResult(null);
                }
                return;
            }
            // Validate response shape: must have at least comps or keyNumbers or directAnswer
            const hasComps = data && data.expandable && Array.isArray(data.expandable.comps) && data.expandable.comps.length > 0;
            const hasKeyNumbers = data && data.keyNumbers && typeof data.keyNumbers === "object" && Object.keys(data.keyNumbers).length > 0;
            const hasDirectAnswer = data && (data.directAnswer || data.title);
            if (!hasComps && !hasKeyNumbers && !hasDirectAnswer) {
                if (isMounted.current) {
                    if (error !== "No comps found")
                        setError("No comps found");
                    if (result !== null)
                        setResult(null);
                }
                return;
            }
            // Increment search count for FREE tier
            if (userTier === "FREE") {
                const newCount = searchCount + 1;
                setSearchCount(newCount);
                localStorage.setItem("hobbyiq_search_count", newCount.toString());
            }
            if (isMounted.current)
                setResult(data);
        }
        catch (err) {
            if (isMounted.current) {
                if (error !== "Network error. Please check your connection and try again.")
                    setError("Network error. Please check your connection and try again.");
                if (result !== null)
                    setResult(null);
            }
        }
        finally {
            if (isMounted.current)
                setLoading(false);
        }
    };
    return (<div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>HobbyIQ Analyzer</h2>
      <form onSubmit={handleSearch} style={{ marginBottom: 24, display: "flex", gap: 8 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search player or card" style={{ flex: 1, padding: 10, fontSize: 16, borderRadius: 4, border: "1px solid #ccc" }}/>
        <button type="submit" style={{ padding: "10px 22px", fontSize: 16, borderRadius: 4, border: "none", background: isSearchAllowed ? "#1976d2" : "#888", color: "#fff", cursor: loading || !isSearchAllowed ? "not-allowed" : "pointer", opacity: loading || !isSearchAllowed ? 0.7 : 1 }} disabled={loading || !isSearchAllowed}>
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </form>
      {userTier === "FREE" && !isSearchAllowed && (<div style={{ color: "#ff4d4f", marginBottom: 16, textAlign: "center", fontWeight: 600, fontSize: 16 }}>
          Upgrade to Pro or All-Star for unlimited access
        </div>)}
      {error && <div style={{ color: "red", marginBottom: 16, textAlign: "center" }}>{error}</div>}
      {loading && <div style={{ color: "#1976d2", marginBottom: 16, textAlign: "center" }}>Loading...</div>}
      {result && (<div ref={resultRef} style={{ border: "1px solid #1976d2", background: "#f5faff", padding: 20, borderRadius: 8, marginBottom: 28 }}>
          <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>{result.title || result.directAnswer || "Result"}</div>
          {result.keyNumbers && typeof result.keyNumbers === "object" && Object.keys(result.keyNumbers).length > 0 && (<div style={{ marginBottom: 8 }}>
              <div><b>Median:</b> {result.keyNumbers.FMV !== undefined && result.keyNumbers.FMV !== null && result.keyNumbers.FMV !== '' ? `$${result.keyNumbers.FMV}` : 'N/A'}</div>
              <div><b>Range:</b> {result.keyNumbers.Range && typeof result.keyNumbers.Range === 'object' && result.keyNumbers.Range.low !== undefined && result.keyNumbers.Range.high !== undefined
                    ? `$${result.keyNumbers.Range.low} - $${result.keyNumbers.Range.high}`
                    : (typeof result.keyNumbers.Range === 'string' && result.keyNumbers.Range !== ''
                        ? result.keyNumbers.Range
                        : 'N/A')}</div>
              <div><b>Decision:</b> {result.keyNumbers.Decision && typeof result.keyNumbers.Decision === 'object' && result.keyNumbers.Decision.signal
                    ? result.keyNumbers.Decision.signal
                    : (typeof result.keyNumbers.Decision === 'string' && result.keyNumbers.Decision !== ''
                        ? result.keyNumbers.Decision
                        : 'N/A')}</div>
              <div><b>Risk:</b> {result.keyNumbers.RiskLevel && typeof result.keyNumbers.RiskLevel === 'object' && result.keyNumbers.RiskLevel.level
                    ? result.keyNumbers.RiskLevel.level
                    : (typeof result.keyNumbers.RiskLevel === 'string' && result.keyNumbers.RiskLevel !== ''
                        ? result.keyNumbers.RiskLevel
                        : 'N/A')}</div>
              {result.keyNumbers.Confidence && <div><b>Confidence:</b> {result.keyNumbers.Confidence}</div>}
            </div>)}
          {result.why && Array.isArray(result.why) && result.why.length > 0 && (<ul style={{ margin: "8px 0 0 0", padding: 0, listStyle: "disc inside", color: "#1976d2" }}>
              {result.why.map((w, i) => <li key={i}>{w}</li>)}
            </ul>)}
          {result.tags && Array.isArray(result.tags) && result.tags.length > 0 && (<div style={{ marginTop: 8 }}>
              {result.tags.map((tag, i) => (<span key={i} style={{ background: "#e3f2fd", color: "#1976d2", borderRadius: 12, padding: "2px 10px", marginRight: 6, fontSize: 13 }}>{tag}</span>))}
            </div>)}
          {result.expandable && result.expandable.comps && Array.isArray(result.expandable.comps) && result.expandable.comps.length > 0 && (<div style={{ marginTop: 16 }}>
              <b>Recent Comps:</b>
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {result.expandable.comps.map((comp, i) => (<li key={i} style={{ marginBottom: 4 }}>
                    ${comp.price} <span style={{ color: "#888" }}>{comp.date}</span>
                  </li>))}
              </ul>
            </div>)}
        </div>)}
    </div>);
};
exports.default = SearchChat;
