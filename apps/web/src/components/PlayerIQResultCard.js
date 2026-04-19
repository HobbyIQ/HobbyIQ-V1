"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./PlayerIQResultCard.css");
const PlayerIQResultCard = ({ result }) => {
    // Helper for supply signal color
    function supplySignalClass(signal) {
        if (!signal)
            return "supply-unknown";
        if (signal === "Tightening")
            return "supply-tightening";
        if (signal === "Expanding" || signal === "Flooded")
            return "supply-expanding";
        if (signal === "Stable")
            return "supply-stable";
        return "supply-unknown";
    }
    return (<div className="playeriq-card">
            {/* eBay Supply Intelligence (player-level) */}
            {result.ebaySupplySnapshot && (<div className="playeriq-ebay-supply">
                <div className="ebay-supply-title">eBay Supply</div>
                <div className="ebay-supply-row">
                  <span>Active Listings:</span>
                  <span>{result.ebaySupplySnapshot.currentActiveListings ?? <em>Unavailable</em>}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>2-Week Change:</span>
                  <span>{typeof result.ebaySupplySnapshot.twoWeekSupplyChangePercent === "number"
                ? `${result.ebaySupplySnapshot.twoWeekSupplyChangePercent > 0 ? "+" : ""}${result.ebaySupplySnapshot.twoWeekSupplyChangePercent}%`
                : <em>Unavailable</em>}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>Trend:</span>
                  <span>{result.ebaySupplySnapshot.twoWeekSupplyTrend}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>Signal:</span>
                  <span className={supplySignalClass(result.ebaySupplySnapshot.supplySignal)}>{result.ebaySupplySnapshot.supplySignal}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>Note:</span>
                  <span>{result.ebaySupplySnapshot.supplyNote}</span>
                </div>
              </div>)}
            {/* Top Parallels To Buy with eBay Supply */}
            {result.topParallelsToBuy && result.topParallelsToBuy.length > 0 && (<div className="playeriq-top-parallels">
                <div className="top-parallels-title">Top Parallels To Buy</div>
                {result.topParallelsToBuy.map((tp, idx) => (<div className="top-parallel-card" key={idx}>
                    <div className="tp-row"><strong>{tp.cardName}</strong> <span className="tp-parallel">[{tp.parallel}]</span></div>
                    <div className="tp-row">Market: <span>${tp.estimatedMarketPrice.toFixed(2)}</span> &nbsp; Fair Value: <span>${tp.estimatedFairValue.toFixed(2)}</span></div>
                    <div className="tp-row">Buy Rating: <span className={`tp-buy-rating tp-buy-rating-${tp.buyRating.replace(/\s/g, "").toLowerCase()}`}>{tp.buyRating}</span></div>
                    <div className="tp-row">Why: <span>{tp.whyItsABuy}</span></div>
                    <div className="tp-row">eBay Supply: &nbsp;
                      <span>Listings: {tp.activeListings ?? <em>?</em>}</span> &nbsp;
                      <span>2Wk: {typeof tp.twoWeekSupplyChangePercent === "number" ? `${tp.twoWeekSupplyChangePercent > 0 ? "+" : ""}${tp.twoWeekSupplyChangePercent}%` : <em>?</em>}</span> &nbsp;
                      <span>Trend: {tp.supplyTrend ?? <em>?</em>}</span> &nbsp;
                      <span className={supplySignalClass(tp.supplyPressure)}>{tp.supplyPressure ?? <em>?</em>}</span>
                    </div>
                  </div>))}
              </div>)}
      <div className="playeriq-header">
        <span className="playeriq-player">{result.player}</span>
        {result.organization && <span className="playeriq-org">{result.organization}</span>}
        {result.level && <span className="playeriq-level">{result.level}</span>}
      </div>
      <div className="playeriq-scores">
        <div><strong>Overall:</strong> {result.overallScore}</div>
        <div><strong>Talent:</strong> {result.talentScore}</div>
        <div><strong>Market:</strong> {result.marketScore}</div>
        <div><strong>Risk:</strong> <span className={`risk-label risk-${result.riskLabel.toLowerCase()}`}>{result.riskLabel}</span> ({result.riskScore})</div>
      </div>
      <div className="playeriq-summary">{result.summary}</div>
      <div className="playeriq-strengths">
        <strong>Strengths:</strong> {result.strengths.length ? result.strengths.join(", ") : "-"}
      </div>
      <div className="playeriq-risks">
        <strong>Risks:</strong> {result.risks.length ? result.risks.join(", ") : "-"}
      </div>
      <div className="playeriq-recommend">
        <strong>Recommendation:</strong> <span className="playeriq-recommendation">{result.recommendation}</span>
        <span className="playeriq-confidence">Confidence: {result.confidence}%</span>
      </div>
      {result.warnings.length > 0 && (<div className="playeriq-warnings">
          <strong>Warnings:</strong> {result.warnings.join(", ")}
        </div>)}
      {result.nextActions.length > 0 && (<div className="playeriq-next-actions">
          <strong>Next:</strong> {result.nextActions.join(" · ")}
        </div>)}
    </div>);
};
exports.default = PlayerIQResultCard;
