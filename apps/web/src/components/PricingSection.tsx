
import React from "react";
import Card from "./Card";
import Button from "./Button";
import SectionHeader from "./SectionHeader";
import "./PricingSection.css";

const tiers = [
  {
    name: "FREE",
    price: "$0",
    features: [
      "3 searches/day",
      "Limited portfolio"
    ],
    highlight: null,
    button: { label: "Current Plan", disabled: true }
  },
  {
    name: "PRO",
    price: "$19.99/mo",
    features: [
      "Unlimited searches",
      "Full analyzer",
      "Portfolio tracking",
      "Basic alerts"
    ],
    highlight: "Most Popular",
    button: { label: "Upgrade to Pro", disabled: false }
  },
  {
    name: "ALL-STAR",
    price: "$39.99/mo",
    features: [
      "Everything in Pro",
      "Advanced alerts",
      "Deal Analyzer Pro",
      "Priority insights"
    ],
    highlight: "Best Value",
    button: { label: "Upgrade to All-Star", disabled: false }
  }
];

export default function PricingSection() {
  // For demo: update localStorage on upgrade
  const handleUpgrade = (tier: string) => {
    if (tier === "PRO") {
      localStorage.setItem("hobbyiq_user_tier", "PRO");
      window.location.reload();
    } else if (tier === "ALL-STAR") {
      localStorage.setItem("hobbyiq_user_tier", "ALL-STAR");
      window.location.reload();
    }
  };
  return (
    <div className="pricing-section">
      <SectionHeader>Choose Your HobbyIQ Plan</SectionHeader>
      <div className="pricing-cards">
        {tiers.map((tier, idx) => (
          <Card
            className={`pricing-card${tier.highlight ? " highlight" : ""} ${tier.name.toLowerCase()}`}
            key={tier.name}
            style={{ minWidth: 260, maxWidth: 320, padding: 0, position: "relative" }}
          >
            {tier.highlight && <div className={`pricing-badge ${tier.highlight.replace(/\s/g, "-").toLowerCase()}`}>{tier.highlight}</div>}
            <div className="pricing-name">{tier.name}</div>
            <div className="pricing-price">{tier.price}</div>
            <ul className="pricing-features">
              {tier.features.map(f => <li key={f}>{f}</li>)}
            </ul>
            {tier.name === "PRO" ? (
              <Button className="pricing-upgrade-btn" onClick={() => handleUpgrade("PRO")} disabled={tier.button.disabled}>{tier.button.label}</Button>
            ) : tier.name === "ALL-STAR" ? (
              <Button className="pricing-upgrade-btn" onClick={() => handleUpgrade("ALL-STAR")} disabled={tier.button.disabled}>{tier.button.label}</Button>
            ) : (
              <Button className="pricing-upgrade-btn" disabled={tier.button.disabled}>{tier.button.label}</Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
