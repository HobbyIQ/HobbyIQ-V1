"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./DailyIQPlayerCard.css");
const tagColors = {
    Buy: "#00ff7f",
    Hold: "#ffe066",
    Sell: "#ff6666",
    Watch: "#00bfff"
};
const DailyIQPlayerCard = ({ entry }) => {
    return (<div className="dailyiq-card">
      <div className="dailyiq-header">
        <span className="dailyiq-player">{entry.player}</span>
        <span className="dailyiq-org">{entry.organization}</span>
        <span className="dailyiq-level">{entry.level}</span>
        <span className="dailyiq-pos">{entry.position}</span>
        <span className="dailyiq-year">1st Bowman: {entry.firstBowmanYear}</span>
        <span className="dailyiq-tag" style={{ background: tagColors[entry.buySellTag] }}>{entry.buySellTag}</span>
      </div>
      <div className="dailyiq-statline">{entry.statLine}</div>
      <div className="dailyiq-note">{entry.performanceNote}</div>
      <div className="dailyiq-market">
        <strong>Market:</strong> {entry.marketSignal}
      </div>
    </div>);
};
exports.default = DailyIQPlayerCard;
