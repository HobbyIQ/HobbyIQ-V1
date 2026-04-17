import React from "react";
import "./Card.css";

const Card: React.FC<{ children: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({ children, className = "", style }) => (
  <div className={`hiq-card ${className}`} style={style}>{children}</div>
);

export default Card;
