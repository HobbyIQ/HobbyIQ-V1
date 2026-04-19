"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importDefault(require("react"));
require("./CompIQResultCard.css");
const CompIQResultCard = ({ result }) => {
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
    return (<div className="compiq-card">
            {/* eBay Supply Intelligence */}
            {result.ebaySupply && (<div className="compiq-ebay-supply">
                <div className="ebay-supply-title">eBay Supply</div>
                <div className="ebay-supply-row">
                  <span>Active Listings:</span>
                  <span>{result.ebaySupply.currentActiveListings ?? <em>Unavailable</em>}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>2-Week Change:</span>
                  <span>{typeof result.ebaySupply.twoWeekSupplyChangePercent === "number"
                ? `${result.ebaySupply.twoWeekSupplyChangePercent > 0 ? "+" : ""}${result.ebaySupply.twoWeekSupplyChangePercent}%`
                : <em>Unavailable</em>}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>Trend:</span>
                  <span>{result.ebaySupply.twoWeekSupplyTrend}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>Signal:</span>
                  <span className={supplySignalClass(result.ebaySupply.supplySignal)}>{result.ebaySupply.supplySignal}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>Pressure:</span>
                  <span className={supplySignalClass(result.ebaySupply.supplyPressure)}>{result.ebaySupply.supplyPressure ?? result.ebaySupply.supplySignal}</span>
                </div>
                <div className="ebay-supply-row">
                  <span>Note:</span>
                  <span>{result.ebaySupply.supplyNote}</span>
                </div>
              </div>)}
      <div className="compiq-header">
        <span className="compiq-player">{result.player || <em>Unknown Player</em>}</span>
        <span className="compiq-set">{result.cardSet || result.productFamily || <em>Unknown Set</em>}</span>
        <span className={`compiq-parallel ${result.isAuto ? "auto" : ""}`}>{result.parallel || <em>Base/Unknown</em>}</span>
        {result.isAuto && <span className="compiq-auto">Auto</span>}
      </div>
      <div className="compiq-values">
        <div><strong>Raw:</strong> {result.rawPrice !== null ? `$${result.rawPrice}` : "-"}</div>
        <div><strong>PSA 9:</strong> {result.estimatedPsa9 !== null ? `$${result.estimatedPsa9}` : "-"}</div>
        <div><strong>PSA 10:</strong> {result.estimatedPsa10 !== null ? `$${result.estimatedPsa10}` : "-"}</div>
      </div>
      <div className="compiq-confidence">
        <span className={`confidence-label confidence-${result.confidenceLabel.toLowerCase()}`}>{result.confidenceLabel}</span>
        <span className="confidence-score">{result.confidenceScore}%</span>
      </div>
      <div className="compiq-explanation">
        <pre>{result.explanation}</pre>
      </div>
      {result.warnings.length > 0 && (<div className="compiq-warnings">
          <strong>Warnings:</strong> {result.warnings.join(", ")}
        </div>)}
      {result.nextActions.length > 0 && (<div className="compiq-next-actions">
          <strong>Next:</strong> {result.nextActions.join(" · ")}
        </div>)}
    </div>);
};
exports.default = CompIQResultCard;
