import React from 'react';

export function PositionEmptyState() {
  return (
    <div style={{ color: '#aaa', textAlign: 'center', marginTop: 48 }}>
      <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>No positions yet</div>
      <div>Add your first position to start tracking cost basis, ROI, and personalized recommendations.</div>
    </div>
  );
}
