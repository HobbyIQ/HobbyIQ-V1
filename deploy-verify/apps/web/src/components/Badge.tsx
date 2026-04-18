import React from "react";
import "./Badge.css";

interface BadgeProps {
  color?: string;
  children: React.ReactNode;
  className?: string;
}

const Badge: React.FC<BadgeProps> = ({ color, children, className = "" }) => (
  <span className={`hiq-badge ${className}`} style={color ? { background: color } : {}}>{children}</span>
);

export default Badge;
