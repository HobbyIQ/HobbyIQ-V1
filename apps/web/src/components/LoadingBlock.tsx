import React from "react";
import "./LoadingBlock.css";

const LoadingBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <div className="hiq-loading-block">{children || "Loading..."}</div>
);

export default LoadingBlock;
