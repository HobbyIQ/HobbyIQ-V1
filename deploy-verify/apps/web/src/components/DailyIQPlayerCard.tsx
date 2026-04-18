import React from "react";
import type { DailyIQPlayerEntry } from "../types/dailyiq";
import "./DailyIQPlayerCard.css";

interface Props {
  entry: DailyIQPlayerEntry;
}

const tagColors = {
  Buy: "#00ff7f",
  Hold: "#ffe066",
  Sell: "#ff6666",
  Watch: "#00bfff"
};

const DailyIQPlayerCard: React.FC<Props> = ({ entry }) => {
  return (
    <div className="dailyiq-card">
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
    </div>
  );
};

export default DailyIQPlayerCard;
