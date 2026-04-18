import React from "react";
import "./ProUpgradeCard.css";

export default function ProUpgradeCard() {
  return (
    <div className="pro-upgrade-card">
      <h2 className="pro-upgrade-title">Upgrade to HobbyIQ Pro</h2>
      <div className="pro-upgrade-tiers">
        <div className="pro-upgrade-tier free">
          <div className="tier-label">Free</div>
          <ul>
            <li>Limited searches</li>
            <li>Basic analyzer</li>
          </ul>
        </div>
        <div className="pro-upgrade-tier pro">
          <div className="tier-label">Pro</div>
          <ul>
            <li>Unlimited searches</li>
            <li>Portfolio tracking</li>
            <li>Real-time alerts</li>
          </ul>
        </div>
      </div>
      <button className="pro-upgrade-btn" disabled>Upgrade to Pro</button>
      <div className="pro-upgrade-note">Payments coming soon</div>
    </div>
  );
}
