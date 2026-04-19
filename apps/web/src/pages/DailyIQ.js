"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const react_1 = __importStar(require("react"));
const dailyiq_1 = require("../api/dailyiq");
const DailyIQPlayerCard_1 = __importDefault(require("../components/DailyIQPlayerCard"));
const SectionHeader_1 = __importDefault(require("../components/SectionHeader"));
const Card_1 = __importDefault(require("../components/Card"));
const LoadingBlock_1 = __importDefault(require("../components/LoadingBlock"));
const ErrorBlock_1 = __importDefault(require("../components/ErrorBlock"));
const EmptyState_1 = __importDefault(require("../components/EmptyState"));
require("./DailyIQ.css");
const DailyIQ = () => {
    const [brief, setBrief] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    (0, react_1.useEffect)(() => {
        setLoading(true);
        (0, dailyiq_1.fetchDailyIQBrief)()
            .then(setBrief)
            .catch(e => setError(e.message || "Unknown error"))
            .finally(() => setLoading(false));
    }, []);
    return (<div className="dailyiq-page" style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "2.5rem 1rem 3rem 1rem" }}>
      <SectionHeader_1.default>DailyIQ</SectionHeader_1.default>
      {loading && <LoadingBlock_1.default>Loading daily brief...</LoadingBlock_1.default>}
      {error && <ErrorBlock_1.default>{error}</ErrorBlock_1.default>}
      {!loading && !error && !brief && <EmptyState_1.default>No brief available.</EmptyState_1.default>}
      {brief && (<Card_1.default className="dailyiq-brief" style={{ width: "100%", maxWidth: 600, margin: "0 auto" }}>
          <div className="dailyiq-date">{brief.briefDate}</div>
          <section>
            <SectionHeader_1.default sub>Verified Top Prospect Performances</SectionHeader_1.default>
            <h3 style={{ color: '#4fff4f', marginBottom: 8, marginTop: 18 }}>Hitters</h3>
            {brief.verifiedTopProspectPerformances.hitters.length === 0 && <EmptyState_1.default>No hitters today.</EmptyState_1.default>}
            {brief.verifiedTopProspectPerformances.hitters.map((entry, i) => (<DailyIQPlayerCard_1.default key={"hitter-" + i} entry={entry}/>))}
            <h3 style={{ color: '#4fff4f', marginBottom: 8, marginTop: 18 }}>Pitchers</h3>
            {brief.verifiedTopProspectPerformances.pitchers.length === 0 && <EmptyState_1.default>No pitchers today.</EmptyState_1.default>}
            {brief.verifiedTopProspectPerformances.pitchers.map((entry, i) => (<DailyIQPlayerCard_1.default key={"pitcher-" + i} entry={entry}/>))}
          </section>
          <section>
            <SectionHeader_1.default sub>Prospect Watch</SectionHeader_1.default>
            {brief.prospectWatch.length === 0 && <EmptyState_1.default>No prospect watch entries.</EmptyState_1.default>}
            {brief.prospectWatch.map((entry, i) => (<DailyIQPlayerCard_1.default key={"watch-" + i} entry={entry}/>))}
          </section>
          <section>
            <SectionHeader_1.default sub>PerformanceIQ — Hobby Movers</SectionHeader_1.default>
            {brief.hobbyMovers.length === 0 && <EmptyState_1.default>No hobby movers today.</EmptyState_1.default>}
            {brief.hobbyMovers.map((entry, i) => (<DailyIQPlayerCard_1.default key={"mover-" + i} entry={entry}/>))}
          </section>
          <section>
            <SectionHeader_1.default sub>Multi-Appearance Tracker</SectionHeader_1.default>
            {brief.multiAppearanceTracker.length === 0 && <EmptyState_1.default>No multi-appearance entries.</EmptyState_1.default>}
            {brief.multiAppearanceTracker.map((entry, i) => (<DailyIQPlayerCard_1.default key={"multi-" + i} entry={entry}/>))}
          </section>
          {brief.warnings.length > 0 && (<div className="dailyiq-warnings">{brief.warnings.join(" · ")}</div>)}
          {brief.nextActions.length > 0 && (<div className="dailyiq-next-actions">Next: {brief.nextActions.join(" · ")}</div>)}
        </Card_1.default>)}
    </div>);
};
exports.default = DailyIQ;
