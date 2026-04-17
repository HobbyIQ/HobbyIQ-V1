import React from "react";
import "./EmptyState.css";

const EmptyState: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="hiq-empty-state">{children}</div>
);

export default EmptyState;
