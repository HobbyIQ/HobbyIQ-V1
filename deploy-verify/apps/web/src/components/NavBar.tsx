import React from "react";
// import { Link } from "react-router-dom";
// To fix: install react-router-dom and its types if routing is needed.

const navStyle: React.CSSProperties = {
  display: "flex",
  gap: "1.5rem",
  padding: "1rem",
  background: "#f5f5f5",
  borderBottom: "1px solid #eee",
  justifyContent: "center",
  fontFamily: "sans-serif",
};

export default function NavBar() {
  return (
    <nav style={navStyle}>
      <a href="/analyze">Analyze</a>
      <a href="/portfolio">Portfolio</a>
      <a href="/alerts">Alerts</a>
    </nav>
  );
}
