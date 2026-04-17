import React, { useState } from 'react';
import { usePortfolioPositions, usePortfolioSummary, usePortfolioAllocation, usePortfolioRecommendations } from '../hooks/usePortfolioPositions';
import { AddPositionButton } from '../components/AddPositionButton';
import { PositionCard } from '../components/PositionCard';
import { PositionEmptyState } from '../components/PositionEmptyState';
import { PositionForm } from '../components/PositionForm';

export function PortfolioScreen() {
  const { data: positions, isLoading } = usePortfolioPositions();
  const { data: summary } = usePortfolioSummary();
  const { data: allocation } = usePortfolioAllocation();
  const { data: recommendations } = usePortfolioRecommendations();
  const [showForm, setShowForm] = useState(false);

  return (
    <div style={{ padding: 24, maxWidth: 600, margin: '0 auto' }}>
      <h1 style={{ color: '#fff', fontSize: 28, fontWeight: 700 }}>Portfolio</h1>
      {summary && (
        <div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
          <div>Total Value: {summary.totalEstimatedValue}</div>
          <div>Cost Basis: {summary.totalCostBasis}</div>
          <div>Unrealized Gain/Loss: {summary.totalUnrealizedGainLoss}</div>
        </div>
      )}
      {allocation && (
        <div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
          <div style={{ fontWeight: 600 }}>Top Allocations</div>
          {allocation.items.slice(0, 3).map((item, i) => (
            <div key={i}>{item.displayLabel || item.entityKey}: {item.allocationPct.toFixed(1)}%</div>
          ))}
        </div>
      )}
      <AddPositionButton onClick={() => setShowForm(true)} />
      {showForm && <PositionForm onSubmit={() => setShowForm(false)} onCancel={() => setShowForm(false)} />}
      {isLoading ? (
        <div style={{ color: '#aaa', marginTop: 32 }}>Loading...</div>
      ) : positions && positions.length > 0 ? (
        positions.map((view, i) => <PositionCard key={i} view={view} />)
      ) : (
        <PositionEmptyState />
      )}
    </div>
  );
}
