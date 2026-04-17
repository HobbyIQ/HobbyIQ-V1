import React from "react";
import "./Input.css";

const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className = "", ...props }) => (
  <input className={`hiq-input ${className}`} {...props} />
);

export default Input;
