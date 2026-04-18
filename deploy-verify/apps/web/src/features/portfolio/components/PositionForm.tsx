import React from 'react';
import { useForm } from 'react-hook-form';
import { PortfolioPositionDto } from '../types/portfolio.types';

export interface PositionFormProps {
  initial?: Partial<PortfolioPositionDto>;
  onSubmit: (data: Partial<PortfolioPositionDto>) => void;
  onCancel?: () => void;
}

export function PositionForm({ initial, onSubmit, onCancel }: PositionFormProps) {
  const { register, handleSubmit, formState: { errors } } = useForm<Partial<PortfolioPositionDto>>({ defaultValues: initial });
  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <label>
        Entity Type
        <select {...register('entityType', { required: true })}>
          <option value="card">Card</option>
          <option value="player">Player</option>
        </select>
      </label>
      <label>
        Entity Key
        <input {...register('entityKey', { required: true })} />
      </label>
      <label>
        Quantity
        <input type="number" step="1" min="1" {...register('quantity', { required: true, min: 1 })} />
      </label>
      <label>
        Average Cost
        <input type="number" step="0.01" min="0" {...register('averageCost', { min: 0 })} />
      </label>
      <label>
        Conviction Tag
        <select {...register('convictionTag')}>
          <option value="">None</option>
          <option value="core">Core</option>
          <option value="upside">Upside</option>
          <option value="flip">Flip</option>
          <option value="pc">PC</option>
          <option value="spec">Spec</option>
        </select>
      </label>
      <label>
        Notes
        <textarea {...register('notes')} />
      </label>
      <div style={{ marginTop: 16 }}>
        <button type="submit">Save</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
      {Object.keys(errors).length > 0 && <div style={{ color: 'red' }}>Please fix validation errors.</div>}
    </form>
  );
}
