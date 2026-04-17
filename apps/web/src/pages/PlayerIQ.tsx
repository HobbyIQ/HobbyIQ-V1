import React, { useState } from "react";
import { fetchPlayerIQ } from "../api/playeriq";
import type { PlayerIQRequest, PlayerIQResponse } from "../types/playeriq";
import PlayerIQResultCard from "../components/PlayerIQResultCard";
import SectionHeader from "../components/SectionHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import Input from "../components/Input";
import LoadingBlock from "../components/LoadingBlock";
import ErrorBlock from "../components/ErrorBlock";
import EmptyState from "../components/EmptyState";
import "./PlayerIQ.css";

const PlayerIQ: React.FC = () => {

  const [player, setPlayer] = useState("");
  const [result, setResult] = useState<PlayerIQResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ input: string; result: PlayerIQResponse }>>([]);


  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const req: PlayerIQRequest = { player };
      const res = await fetchPlayerIQ(req);
      setResult(res);
      setHistory(h => [{ input: player, result: res }, ...h]);
      console.log("[PlayerIQ] Input:", req, "Response:", res);
    } catch (err: any) {
      setError(err.message || "Unknown error");
      console.error("[PlayerIQ] Error for input:", player, err);
    } finally {
      setLoading(false);
    }
  }

  // Test scenarios
  async function runPlayerIQTest(input: string) {
    setPlayer(input);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const req: PlayerIQRequest = { player: input };
      const res = await fetchPlayerIQ(req);
      setResult(res);
      setHistory(h => [{ input, result: res }, ...h]);
      console.log("[PlayerIQ][Test] Input:", req, "Response:", res);
    } catch (err: any) {
      setError(err.message || "Unknown error");
      console.error("[PlayerIQ][Test] Error for input:", input, err);
    } finally {
      setLoading(false);
    }
  }

  // Edge case highlight: null/empty fields, warnings, nextActions, confidence, etc.



  return (
    <div className="playeriq-page" style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "2.5rem 1rem 3rem 1rem" }}>
      <SectionHeader>PlayerIQ</SectionHeader>
      <Card style={{ width: "100%", maxWidth: 540, margin: "0 auto", marginBottom: 32 }}>
        <form className="playeriq-form" onSubmit={handleSubmit} style={{ display: "flex", gap: 16 }}>
          <Input
            className="playeriq-input"
            type="text"
            placeholder="Enter a player name (e.g. 'Brady Ebel')"
            value={player}
            onChange={e => setPlayer(e.target.value)}
            disabled={loading}
            autoFocus
            style={{ flex: 1 }}
          />
          <Button className="playeriq-btn" type="submit" disabled={loading || !player.trim()} style={{ minWidth: 120 }}>
            {loading ? "Scoring..." : "Evaluate"}
          </Button>
        </form>
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runPlayerIQTest("Brady Ebel")}>Test: Full Input</Button>
          <Button type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runPlayerIQTest("Ebel")}>Test: Partial Input</Button>
          <Button type="button" style={{ background: "#1e2e1e", color: "#6f6", border: "1px solid #2e4" }} onClick={() => runPlayerIQTest("Jordan")}>Test: Ambiguous Input</Button>
        </div>
      </Card>
      {loading && <LoadingBlock>Scoring...</LoadingBlock>}
      {error && <ErrorBlock>{error}</ErrorBlock>}
      {!loading && !error && !result && <EmptyState>Enter a player to get started.</EmptyState>}
      {result && <PlayerIQResultCard result={result} />}
      {history.length > 1 && (
        <div className="playeriq-history" style={{ width: "100%", maxWidth: 540, margin: "2rem auto 0 auto" }}>
          <SectionHeader sub>Previous Results</SectionHeader>
          {history.slice(1).map((h, i) => (
            <PlayerIQResultCard key={i} result={h.result} />
          ))}
        </div>
      )}
    </div>
  );
};

export default PlayerIQ;
