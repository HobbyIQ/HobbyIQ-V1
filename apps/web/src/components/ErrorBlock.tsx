import React from "react";
import "./ErrorBlock.css";

const ErrorBlock: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="hiq-error-block">{children}</div>
);

export default ErrorBlock;
