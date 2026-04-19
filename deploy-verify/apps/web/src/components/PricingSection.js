"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = PricingSection;
const react_1 = __importDefault(require("react"));
const Card_1 = __importDefault(require("./Card"));
const Button_1 = __importDefault(require("./Button"));
const SectionHeader_1 = __importDefault(require("./SectionHeader"));
require("./PricingSection.css");
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
function PricingSection() {
    // For demo: update localStorage on upgrade
    const handleUpgrade = (tier) => {
        if (tier === "PRO") {
            localStorage.setItem("hobbyiq_user_tier", "PRO");
            window.location.reload();
        }
        else if (tier === "ALL-STAR") {
            localStorage.setItem("hobbyiq_user_tier", "ALL-STAR");
            window.location.reload();
        }
    };
    return (<div className="pricing-section">
      <SectionHeader_1.default>Choose Your HobbyIQ Plan</SectionHeader_1.default>
      <div className="pricing-cards">
        {tiers.map((tier, idx) => (<Card_1.default className={`pricing-card${tier.highlight ? " highlight" : ""} ${tier.name.toLowerCase()}`} key={tier.name} style={{ minWidth: 260, maxWidth: 320, padding: 0, position: "relative" }}>
            {tier.highlight && <div className={`pricing-badge ${tier.highlight.replace(/\s/g, "-").toLowerCase()}`}>{tier.highlight}</div>}
            <div className="pricing-name">{tier.name}</div>
            <div className="pricing-price">{tier.price}</div>
            <ul className="pricing-features">
              {tier.features.map(f => <li key={f}>{f}</li>)}
            </ul>
            {tier.name === "PRO" ? (<Button_1.default className="pricing-upgrade-btn" onClick={() => handleUpgrade("PRO")} disabled={tier.button.disabled}>{tier.button.label}</Button_1.default>) : tier.name === "ALL-STAR" ? (<Button_1.default className="pricing-upgrade-btn" onClick={() => handleUpgrade("ALL-STAR")} disabled={tier.button.disabled}>{tier.button.label}</Button_1.default>) : (<Button_1.default className="pricing-upgrade-btn" disabled={tier.button.disabled}>{tier.button.label}</Button_1.default>)}
          </Card_1.default>))}
      </div>
    </div>);
}
