import React, { useState } from 'react';
import { usePortfolioPositions, usePortfolioSummary, usePortfolioAllocation } from '../hooks/usePortfolioPositions';
import { AddPositionButton } from '../components/AddPositionButton';
import { PositionCard } from '../components/PositionCard';
import { PositionEmptyState } from '../components/PositionEmptyState';
import { PositionForm } from '../components/PositionForm';
import './PortfolioScreen.css';

export function PortfolioScreen() {
  const { data: positions, isLoading } = usePortfolioPositions();
  const { data: summary } = usePortfolioSummary();
  const { data: allocation } = usePortfolioAllocation();
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="portfolio-screen">
      <h1 className="portfolio-screen__title">Portfolio</h1>
      {summary && (
        <div className="portfolio-screen__panel">
          <div>Total Value: {summary.totalEstimatedValue}</div>
          <div>Cost Basis: {summary.totalCostBasis}</div>
          <div>Unrealized Gain/Loss: {summary.totalUnrealizedGainLoss}</div>
        </div>
      )}
      {allocation && (
        <div className="portfolio-screen__panel">
          <div className="portfolio-screen__subtitle">Top Allocations</div>
          {allocation.items.slice(0, 3).map((item, i) => (
            <div key={i}>{item.displayLabel || item.entityKey}: {item.allocationPct.toFixed(1)}%</div>
          ))}
        </div>
      )}
      <AddPositionButton onClick={() => setShowForm(true)} />
      {showForm && <PositionForm onSubmit={() => setShowForm(false)} onCancel={() => setShowForm(false)} />}
      {isLoading ? (
        <div className="portfolio-screen__loading">Loading...</div>
      ) : positions && positions.length > 0 ? (
        positions.map((view, i) => <PositionCard key={i} view={view} />)
      ) : (
        <PositionEmptyState />
      )}
    </div>
  );
}
