import React from 'react';
import { PositionForm } from '../components/PositionForm';
import { useCreatePortfolioPosition } from '../hooks/useCreatePortfolioPosition';

export function AddEditPositionScreen({ initial, onClose }: { initial?: any; onClose: () => void }) {
  const { mutate } = useCreatePortfolioPosition();
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ color: '#fff' }}>{initial ? 'Edit Position' : 'Add Position'}</h2>
      <PositionForm
        initial={initial}
        onSubmit={data => {
          mutate(data, { onSuccess: onClose });
        }}
        onCancel={onClose}
      />
    </div>
  );
}
