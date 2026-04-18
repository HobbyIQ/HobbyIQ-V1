import React from 'react';
import { PortfolioAllocationSummaryDto } from '../types/portfolio.types';

export function PortfolioAllocationCard({ allocation }: { allocation: PortfolioAllocationSummaryDto }) {
  return (
    <div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>Portfolio Allocation</div>
      {allocation.items.map((item, i) => (
        <div key={i}>{item.displayLabel || item.entityKey}: {item.allocationPct.toFixed(1)}%</div>
      ))}
    </div>
  );
}
