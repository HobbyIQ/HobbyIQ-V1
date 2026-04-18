import React from 'react';
import { PortfolioActionPlanDto } from '../types/portfolio.types';

export function PortfolioActionPlanCard({ actionPlan }: { actionPlan: PortfolioActionPlanDto }) {
  return (
    <div style={{ background: '#222', borderRadius: 24, padding: 20, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 18 }}>Action Plan</div>
      <div>Action: {actionPlan.recommendedAction}</div>
      <div>Urgency: {actionPlan.urgencyScore}</div>
      <div>Confidence: {actionPlan.confidenceScore}</div>
      <div>Summary: {actionPlan.summary}</div>
      <div>Why Now:</div>
      <ul>{actionPlan.whyNow.map((w, i) => <li key={i}>{w}</li>)}</ul>
      <div>Action Steps:</div>
      <ul>{actionPlan.actionSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
      {actionPlan.addRangeLow != null && <div>Add Range: {actionPlan.addRangeLow} - {actionPlan.addRangeHigh}</div>}
      {actionPlan.trimRangeLow != null && <div>Trim Range: {actionPlan.trimRangeLow} - {actionPlan.trimRangeHigh}</div>}
      {actionPlan.sellRangeLow != null && <div>Sell Range: {actionPlan.sellRangeLow} - {actionPlan.sellRangeHigh}</div>}
      {actionPlan.protectCapitalLevel != null && <div>Protect Capital Level: {actionPlan.protectCapitalLevel}</div>}
      {actionPlan.nextCatalyst && <div>Next Catalyst: {actionPlan.nextCatalyst}</div>}
    </div>
  );
}
