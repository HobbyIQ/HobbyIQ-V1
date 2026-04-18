import React from "react";
import "./SectionHeader.css";

const SectionHeader: React.FC<{ children: React.ReactNode; sub?: boolean }> = ({ children, sub }) => (
  <h2 className={sub ? "hiq-section-header hiq-section-sub" : "hiq-section-header"}>{children}</h2>
);

export default SectionHeader;
