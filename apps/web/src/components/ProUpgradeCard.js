"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = ProUpgradeCard;
const react_1 = __importDefault(require("react"));
require("./ProUpgradeCard.css");
function ProUpgradeCard() {
    return (<div className="pro-upgrade-card">
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
    </div>);
}
