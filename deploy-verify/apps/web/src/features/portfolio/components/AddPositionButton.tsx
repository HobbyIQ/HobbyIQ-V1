import React from 'react';

export function AddPositionButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ padding: 12, borderRadius: 16, background: '#1a3', color: '#fff', fontWeight: 600 }}>
      + Add Position
    </button>
  );
}
