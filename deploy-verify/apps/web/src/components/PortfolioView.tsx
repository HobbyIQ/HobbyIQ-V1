import React, { useState } from "react";
import { API_BASE_URL } from "../api";

type Card = {
  id: string;
  player: string;
  year: number;
  brand: string;
  setName: string;
  parallel?: string;
  grade?: string;
  purchasePrice?: number;
  currentEstimatedValue: number;
  currentRecommendation: string;
  gainLossDollar: number;
  roi?: number; // percent
};

export default function PortfolioView() {
  const [portfolioId, setPortfolioId] = useState("");
  const [name, setName] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [cardInput, setCardInput] = useState({
    player: "",
    year: "",
    brand: "",
    setName: "",
    purchasePrice: "",
    purchaseDate: "",
    quantity: "",
    parallel: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create portfolio
  const handleCreatePortfolio = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, userId: "demo" }),
      });
      if (!res.ok) throw new Error("Failed to create portfolio");
      const data = await res.json();
      setPortfolioId(data.data.id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Add card
  const handleAddCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!portfolioId) return;
    // Vague/empty input handling
    if (!cardInput.player.trim() || !cardInput.year.trim() || !cardInput.brand.trim() || !cardInput.setName.trim()) {
      setError("Please fill in all required fields.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolio/${portfolioId}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...cardInput, year: Number(cardInput.year), purchasePrice: Number(cardInput.purchasePrice), quantity: Number(cardInput.quantity) }),
      });
      if (!res.ok) throw new Error("Failed to add card");
      await fetchSummary();
      setCardInput({ player: "", year: "", brand: "", setName: "", purchasePrice: "", purchaseDate: "", quantity: "", parallel: "" });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Fetch summary
  const fetchSummary = async () => {
    if (!portfolioId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/portfolio/${portfolioId}/summary`);
      if (!res.ok) throw new Error("Failed to fetch summary");
      const data = await res.json();
      setCards(data.data?.cards || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch summary when portfolioId changes
  React.useEffect(() => {
    if (portfolioId) fetchSummary();
  }, [portfolioId]);

  return (
    <div style={{ maxWidth: 700, margin: "2rem auto", padding: 16 }}>
      <h2>Portfolio</h2>
      {!portfolioId ? (
        <form onSubmit={handleCreatePortfolio} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Portfolio Name"
            value={name}
            onChange={e => setName(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>{loading ? "Evaluating..." : "Create Portfolio"}</button>
        </form>
      ) : (
        <>
          <form onSubmit={handleAddCard} style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <input name="player" placeholder="Player" value={cardInput.player} onChange={e => setCardInput({ ...cardInput, player: e.target.value })} required />
            <input name="year" type="number" placeholder="Year" value={cardInput.year} onChange={e => setCardInput({ ...cardInput, year: e.target.value })} required />
            <input name="brand" placeholder="Brand" value={cardInput.brand} onChange={e => setCardInput({ ...cardInput, brand: e.target.value })} required />
            <input name="setName" placeholder="Set Name" value={cardInput.setName} onChange={e => setCardInput({ ...cardInput, setName: e.target.value })} required />
            <input name="parallel" placeholder="Parallel" value={cardInput.parallel} onChange={e => setCardInput({ ...cardInput, parallel: e.target.value })} required />
            <input name="purchasePrice" type="number" placeholder="Purchase Price" value={cardInput.purchasePrice} onChange={e => setCardInput({ ...cardInput, purchasePrice: e.target.value })} required />
            <input name="purchaseDate" type="date" placeholder="Purchase Date" value={cardInput.purchaseDate} onChange={e => setCardInput({ ...cardInput, purchaseDate: e.target.value })} required />
            <input name="quantity" type="number" placeholder="Qty" value={cardInput.quantity} onChange={e => setCardInput({ ...cardInput, quantity: e.target.value })} required />
            <button type="submit" disabled={loading}>{loading ? "Evaluating..." : "Add Card"}</button>
          </form>
          <button onClick={fetchSummary} style={{ marginBottom: 12 }} disabled={loading}>{loading ? "Evaluating..." : "Refresh"}</button>
          {loading ? (
            <div style={{ textAlign: "center", color: "#888", margin: "1.2rem 0 0.5rem 0" }}>Evaluating...</div>
          ) : cards.length === 0 ? (
            <div style={{ textAlign: "center", color: "#888", margin: "1.2rem 0 0.5rem 0" }}>No cards yet. Add your first card to get started!</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff" }}>
              <thead>
                <tr style={{ background: "#f0f0f0" }}>
                  <th style={{ border: "1px solid #ddd", padding: 6 }}>Player</th>
                  <th style={{ border: "1px solid #ddd", padding: 6 }}>Parallel</th>
                  <th style={{ border: "1px solid #ddd", padding: 6 }}>Grade</th>
                  <th style={{ border: "1px solid #ddd", padding: 6 }}>Purchase Price</th>
                  <th style={{ border: "1px solid #ddd", padding: 6 }}>Current Value</th>
                  <th style={{ border: "1px solid #ddd", padding: 6 }}>ROI</th>
                  <th style={{ border: "1px solid #ddd", padding: 6 }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {cards.map(card => {
                  // Calculate ROI if not present
                  const roi = card.roi !== undefined ? card.roi : (card.purchasePrice && card.currentEstimatedValue)
                    ? ((card.currentEstimatedValue - card.purchasePrice) / card.purchasePrice) * 100
                    : undefined;
                  const isProfit = roi !== undefined && roi >= 0;
                  const isSell = card.currentRecommendation && card.currentRecommendation.toUpperCase().includes("SELL");
                  return (
                    <tr key={card.id} style={isSell ? { background: '#fff3f0' } : {}}>
                      <td style={{ border: "1px solid #ddd", padding: 6 }}>{card.player}</td>
                      <td style={{ border: "1px solid #ddd", padding: 6 }}>{card.parallel || '-'}</td>
                      <td style={{ border: "1px solid #ddd", padding: 6 }}>{card.grade || '-'}</td>
                      <td style={{ border: "1px solid #ddd", padding: 6 }}>${card.purchasePrice !== undefined ? card.purchasePrice.toLocaleString("en-US", { maximumFractionDigits: 0 }) : '-'}</td>
                      <td style={{ border: "1px solid #ddd", padding: 6 }}>${card.currentEstimatedValue !== undefined ? card.currentEstimatedValue.toLocaleString("en-US", { maximumFractionDigits: 0 }) : '-'}</td>
                      <td style={{ border: "1px solid #ddd", padding: 6, color: roi !== undefined ? (isProfit ? '#43a047' : '#d32f2f') : '#888', fontWeight: roi !== undefined ? 600 : 400 }}>
                        {roi !== undefined ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : '-'}
                      </td>
                      <td style={{ border: "1px solid #ddd", padding: 6, fontWeight: isSell ? 700 : 500, color: isSell ? '#d32f2f' : '#1976d2' }}>
                        {card.currentRecommendation || '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      {error && <div style={{ color: "red", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
