import React from "react";
import "./Button.css";

const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ children, className = "", ...props }) => (
  <button className={`hiq-btn ${className}`} {...props}>{children}</button>
);

export default Button;
