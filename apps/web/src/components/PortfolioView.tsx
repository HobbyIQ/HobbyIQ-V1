import React, { useCallback, useState } from "react";
import { API_BASE_URL } from "../api";
import "./PortfolioView.css";

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
  const fetchSummary = useCallback(async () => {
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
  }, [portfolioId]);

  // Auto-fetch summary when portfolioId changes
  React.useEffect(() => {
    if (portfolioId) fetchSummary();
  }, [portfolioId, fetchSummary]);

  return (
    <div className="portfolio-view">
      <h2>Portfolio</h2>
      {!portfolioId ? (
        <form onSubmit={handleCreatePortfolio} className="portfolio-view__form portfolio-view__form--create">
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
          <form onSubmit={handleAddCard} className="portfolio-view__form portfolio-view__form--add">
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
          <button onClick={fetchSummary} className="portfolio-view__refresh" disabled={loading}>{loading ? "Evaluating..." : "Refresh"}</button>
          {loading ? (
            <div className="portfolio-view__empty-state">Evaluating...</div>
          ) : cards.length === 0 ? (
            <div className="portfolio-view__empty-state">No cards yet. Add your first card to get started!</div>
          ) : (
            <table className="portfolio-view__table">
              <thead>
                <tr className="portfolio-view__table-head-row">
                  <th className="portfolio-view__table-cell">Player</th>
                  <th className="portfolio-view__table-cell">Parallel</th>
                  <th className="portfolio-view__table-cell">Grade</th>
                  <th className="portfolio-view__table-cell">Purchase Price</th>
                  <th className="portfolio-view__table-cell">Current Value</th>
                  <th className="portfolio-view__table-cell">ROI</th>
                  <th className="portfolio-view__table-cell">Decision</th>
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
                    <tr key={card.id} className={isSell ? "portfolio-view__table-row portfolio-view__table-row--sell" : "portfolio-view__table-row"}>
                      <td className="portfolio-view__table-cell">{card.player}</td>
                      <td className="portfolio-view__table-cell">{card.parallel || '-'}</td>
                      <td className="portfolio-view__table-cell">{card.grade || '-'}</td>
                      <td className="portfolio-view__table-cell">${card.purchasePrice !== undefined ? card.purchasePrice.toLocaleString("en-US", { maximumFractionDigits: 0 }) : '-'}</td>
                      <td className="portfolio-view__table-cell">${card.currentEstimatedValue !== undefined ? card.currentEstimatedValue.toLocaleString("en-US", { maximumFractionDigits: 0 }) : '-'}</td>
                      <td className={roi !== undefined ? `portfolio-view__table-cell portfolio-view__table-cell--${isProfit ? "profit" : "loss"}` : "portfolio-view__table-cell portfolio-view__table-cell--muted"}>
                        {roi !== undefined ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` : '-'}
                      </td>
                      <td className={isSell ? "portfolio-view__table-cell portfolio-view__table-cell--sell" : "portfolio-view__table-cell portfolio-view__table-cell--buy"}>
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
      {error && <div className="portfolio-view__error">{error}</div>}
    </div>
  );
}
