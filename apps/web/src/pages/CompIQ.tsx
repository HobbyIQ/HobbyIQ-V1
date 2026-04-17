import React, { useState } from "react";
import { fetchCompIQ } from "../api/compiq";
import type { CompIQRequest, CompIQResponse } from "../types/compiq";
import CompIQResultCard from "../components/CompIQResultCard";
import SectionHeader from "../components/SectionHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import Input from "../components/Input";
import LoadingBlock from "../components/LoadingBlock";
import ErrorBlock from "../components/ErrorBlock";
import EmptyState from "../components/EmptyState";
import "./CompIQ.css";

const CompIQ: React.FC = () => {

  const [query, setQuery] = useState("");
  const [result, setResult] = useState<CompIQResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ input: string; result: CompIQResponse }>>([]);


  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const req: CompIQRequest = { query };
      const res = await fetchCompIQ(req);
      setResult(res);
      setHistory(h => [{ input: query, result: res }, ...h]);
      console.log("[CompIQ] Input:", req, "Response:", res);
    } catch (err: any) {
      setError(err.message || "Unknown error");
      console.error("[CompIQ] Error for input:", query, err);
    } finally {
      setLoading(false);
    }
  }

  // Test scenarios
  async function runCompIQTest(input: string) {
    setQuery(input);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const req: CompIQRequest = { query: input };
      const res = await fetchCompIQ(req);
      setResult(res);
      setHistory(h => [{ input, result: res }, ...h]);
      console.log("[CompIQ][Test] Input:", req, "Response:", res);
    } catch (err: any) {
      setError(err.message || "Unknown error");
      console.error("[CompIQ][Test] Error for input:", input, err);
    } finally {
      setLoading(false);
    }
  }

  // Edge case highlight: null/empty fields, warnings, nextActions, confidenceLabel, etc.



  return (
    <div className="compiq-page" style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "2.5rem 1rem 3rem 1rem" }}>
      <SectionHeader>CompIQ</SectionHeader>
      <Card style={{ width: "100%", maxWidth: 540, margin: "0 auto", marginBottom: 32 }}>
        <form className="compiq-form" onSubmit={handleSubmit} style={{ display: "flex", gap: 16 }}>
          <Input
            className="compiq-input"
            type="text"
            placeholder="Paste or type a card (e.g. 'LeBron James 2019 Prizm Silver PSA 10 Auto')"
            value={query}
            onChange={e => setQuery(e.target.value)}
            disabled={loading}
            autoFocus
            style={{ flex: 1 }}
          />
          <Button className="compiq-btn" type="submit" disabled={loading || !query.trim()} style={{ minWidth: 120 }}>
            {loading ? "Estimating..." : "Estimate"}
          </Button>
        </form>
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runCompIQTest("LeBron James 2019 Prizm Silver PSA 10 Auto")}>Test: Full Input</Button>
          <Button type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runCompIQTest("LeBron James Prizm")}>Test: Partial Input</Button>
          <Button type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runCompIQTest("Jordan")}>Test: Ambiguous Input</Button>
        </div>
      </Card>
      {loading && <LoadingBlock>Estimating...</LoadingBlock>}
      {error && <ErrorBlock>{error}</ErrorBlock>}
      {!loading && !error && !result && <EmptyState>Enter a card to get started.</EmptyState>}
      {result && <CompIQResultCard result={result} />}
      {history.length > 1 && (
        <div className="compiq-history" style={{ width: "100%", maxWidth: 540, margin: "2rem auto 0 auto" }}>
          <SectionHeader sub>Previous Results</SectionHeader>
          {history.slice(1).map((h, i) => (
            <CompIQResultCard key={i} result={h.result} />
          ))}
        </div>
      )}
    </div>
  );
};

export default CompIQ;
