import React, { useEffect, useState } from "react";
import {
  fetchPortfolio,
  fetchDecision,
  fetchScarcity,
  fetchSupply,
  fetchGemRate,
} from "./api";
import type {
  PortfolioEntry,
  DecisionResponse,
  ScarcityResponse,
  SupplyResponse,
  GemRateResponse,
} from "./types";

export default function PortfolioPage() {
  const [portfolio, setPortfolio] = useState<PortfolioEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PortfolioEntry | null>(null);
  const [decision, setDecision] = useState<DecisionResponse | null>(null);
  const [scarcity, setScarcity] = useState<ScarcityResponse | null>(null);
  const [supply, setSupply] = useState<SupplyResponse | null>(null);
  const [gemRate, setGemRate] = useState<GemRateResponse | null>(null);

  useEffect(() => {
    fetchPortfolio()
      .then((data) => {
        setPortfolio(data.portfolio);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const handleSelect = async (entry: PortfolioEntry) => {
    setSelected(entry);
    setDecision(null);
    setScarcity(null);
    setSupply(null);
    setGemRate(null);
    try {
      const [decision, scarcity, supply, gemRate] = await Promise.all([
        fetchDecision(entry.id),
        fetchScarcity(entry.id),
        fetchSupply(entry.id),
        fetchGemRate(entry.id),
      ]);
      setDecision(decision);
      setScarcity(scarcity);
      setSupply(supply);
      setGemRate(gemRate);
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) return <div>Loading portfolio...</div>;
  if (error) return <div style={{ color: "red" }}>Error: {error}</div>;

  return (
    <div style={{ maxWidth: 900, margin: "2rem auto" }}>
      <h2>Portfolio</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 32 }}>
        <thead>
          <tr style={{ background: "#f0f4f8" }}>
            <th>ID</th>
            <th>Player</th>
            <th>Card</th>
            <th>Year</th>
            <th>Team</th>
            <th>Grade</th>
            <th>Value</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {portfolio.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.id}</td>
              <td>{entry.player}</td>
              <td>{entry.card}</td>
              <td>{entry.year}</td>
              <td>{entry.team}</td>
              <td>{entry.grade || "RAW"}</td>
              <td>${entry.value}</td>
              <td>
                <button onClick={() => handleSelect(entry)}>Details</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <div style={{ border: "1px solid #1976d2", borderRadius: 8, padding: 20, background: "#f5faff" }}>
          <h3>Card Details: {selected.player} - {selected.card}</h3>
          {decision && (
            <div><b>Decision:</b> {decision.action} <span style={{ color: "#888" }}>({decision.reason})</span></div>
          )}
          {scarcity && (
            <div><b>Scarcity Score:</b> {scarcity.scarcityScore} <span style={{ color: "#888" }}>({scarcity.notes})</span></div>
          )}
          {supply && (
            <div><b>Supply:</b> {supply.supply} <span style={{ color: "#888" }}>({supply.notes})</span></div>
          )}
          {gemRate && (
            <div><b>Gem Rate:</b> {gemRate.gemRate} <span style={{ color: "#888" }}>({gemRate.notes})</span></div>
          )}
        </div>
      )}
    </div>
  );
}
